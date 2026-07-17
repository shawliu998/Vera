import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { WorkspaceBlobCodec } from "../lib/workspace/blobStore";
import { WorkspaceDatabase } from "../lib/workspace/database";
import { WorkspaceInferencePolicy, ModelProfilePrivacyRepository } from "../lib/workspace/inferencePolicy";
import { LocalWorkspaceBlobStore } from "../lib/workspace/localWorkspaceBlobStore";
import { defaultOriginForProvider } from "../lib/workspace/modelCompatibility";
import { WorkspaceModelProviderRegistry } from "../lib/workspace/modelProviderRegistry";
import { WORKSPACE_LOCAL_PRINCIPAL_ID } from "../lib/workspace/principal";
import { WorkspaceBlobRecordsRepository, workspaceBlobStorageKey } from "../lib/workspace/repositories/blobRecords";
import { ModelConnectionTestsRepository } from "../lib/workspace/repositories/modelConnectionTests";
import { ModelProfilesRepository } from "../lib/workspace/repositories/modelProfiles";
import { WorkspaceRuntime } from "../lib/workspace/runtime";
import {
  CREDENTIAL_STORE_OPERATION_MODE,
  buildStoredCredentialReference,
  type CredentialDeletionInput,
  type CredentialResolutionInput,
  type CredentialStorageInput,
  type SynchronousCredentialStorePort,
} from "../lib/workspace/services/credentialStore";

const NOW = "2026-07-17T12:00:00.000Z";
const PROFILE_ID = "81000000-0000-4000-8000-000000000001";
const SECRET = "sk-contract-review-e2e-test-secret";
const QUOTE = "This Agreement";

class IdentityCodec implements WorkspaceBlobCodec {
  readonly encrypted = false;
  encode(input: Parameters<WorkspaceBlobCodec["encode"]>[0]) {
    return Buffer.from(input.plaintext);
  }
  decode(input: Parameters<WorkspaceBlobCodec["decode"]>[0]) {
    return Buffer.from(input.envelope);
  }
}

class AuditCredentialStore implements SynchronousCredentialStorePort {
  readonly [CREDENTIAL_STORE_OPERATION_MODE] = "synchronous" as const;
  private readonly values = new Map<string, string>();
  isAvailable() {
    return true;
  }
  store(input: CredentialStorageInput) {
    this.values.set(input.reference, input.secret);
  }
  resolve(input: CredentialResolutionInput) {
    const value = this.values.get(input.reference);
    if (!value) throw new Error("Credential unavailable.");
    return value;
  }
  delete(input: CredentialDeletionInput) {
    this.values.delete(input.reference);
  }
}

type ProviderControl = {
  assistantCalls: number;
  tabularCalls: number;
  holdTabular: boolean;
  requests: Array<{ feature: string | null; authorization: string | null }>;
};

function sha(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

function sse(events: unknown[]) {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

function completedResponse(events: unknown[]) {
  return new Response(sse(events), {
    status: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  });
}

function toolResponse(id: string, name: string, input: unknown) {
  const itemId = `item-${id}`;
  return completedResponse([
    {
      type: "response.output_item.added",
      item: { type: "function_call", id: itemId, call_id: id, name },
    },
    {
      type: "response.function_call_arguments.delta",
      item_id: itemId,
      delta: JSON.stringify(input),
    },
    {
      type: "response.output_item.done",
      item: { type: "function_call", id: itemId, call_id: id, name },
    },
    {
      type: "response.completed",
      response: { usage: { input_tokens: 40, output_tokens: 12 } },
    },
  ]);
}

function fakeOpenAiFetch(control: ProviderControl): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const authorization = new Headers(init?.headers).get("authorization");
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      metadata?: { feature?: unknown };
      input?: Array<{ role?: unknown; content?: unknown }>;
      text?: { format?: { schema?: { properties?: { value?: unknown } } } };
    };
    const feature =
      typeof body.metadata?.feature === "string" ? body.metadata.feature : null;
    control.requests.push({ feature, authorization });
    if (feature === "vera_assistant") {
      control.assistantCalls += 1;
      const assistantHistory = (body.input ?? [])
        .filter((message) => message.role === "assistant")
        .map((message) => String(message.content));
      if (assistantHistory.some((content) => content.includes('"run_contract_review"'))) {
        return completedResponse([
          {
            type: "response.output_text.delta",
            delta: "The contract review and risk memo are ready in Review and Studio.",
          },
          {
            type: "response.completed",
            response: { usage: { input_tokens: 80, output_tokens: 18 } },
          },
        ]);
      }
      if (assistantHistory.some((content) => content.includes('"fetch_documents"'))) {
        return toolResponse("review-contracts", "run_contract_review", {
          preset: "commercial_agreement",
        });
      }
      return toolResponse("fetch-contracts", "fetch_documents", {
        doc_ids: ["doc-0", "doc-1"],
      });
    }
    assert.equal(feature, "vera_tabular", "unexpected provider request feature");
    control.tabularCalls += 1;
    if (control.holdTabular) {
      return await new Promise<Response>((_resolve, reject) => {
        const abort = () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        };
        if (init?.signal?.aborted) abort();
        else init?.signal?.addEventListener("abort", abort, { once: true });
      });
    }
    const valueSchema = body.text?.format?.schema?.properties?.value as
      | { type?: unknown; enum?: unknown }
      | undefined;
    const value =
      valueSchema?.type === "boolean"
        ? false
        : valueSchema?.type === "number"
          ? 0
          : Array.isArray(valueSchema?.enum)
            ? valueSchema!.enum![0]
            : "Captured from the agreement.";
    return completedResponse([
      {
        type: "response.output_text.delta",
        delta: JSON.stringify({
          value,
          reasoning: "The value is limited to the exact reviewed agreement text.",
          flag: "grey",
          quotes: [QUOTE],
        }),
      },
      {
        type: "response.completed",
        response: { usage: { input_tokens: 90, output_tokens: 22 } },
      },
    ]);
  }) as typeof fetch;
}

function seedProfile(database: WorkspaceDatabase, credentials: AuditCredentialStore) {
  const profiles = new ModelProfilesRepository(database);
  profiles.create({
    id: PROFILE_ID,
    name: "Flagship contract-review audit model",
    provider: "openai",
    model: "gpt-5-mini",
    baseUrl: null,
    credentialOrigin: null,
    credentialState: "missing",
    contextWindowTokens: 128_000,
    maxOutputTokens: 2_000,
    enabled: false,
    isDefault: false,
    capabilities: {
      streaming: true,
      toolCalling: true,
      structuredOutput: true,
      vision: false,
    },
    now: NOW,
  });
  const origin = defaultOriginForProvider("openai");
  assert.ok(origin);
  const reference = buildStoredCredentialReference(
    PROFILE_ID,
    "contractreviewe2e01",
  );
  credentials.store({
    reference,
    binding: { profileId: PROFILE_ID, provider: "openai", canonicalOrigin: origin },
    secret: SECRET,
  });
  profiles.setCredentialBindingInternal(PROFILE_ID, {
    reference,
    state: "configured",
    origin,
    now: NOW,
  });
  const stored = profiles.requireStored(PROFILE_ID);
  assert.equal(
    new ModelConnectionTestsRepository(database).storeIfCurrent({
      profileId: PROFILE_ID,
      expectedConnectionRevision: stored.connectionRevision,
      status: "passed",
      errorCode: null,
      retryable: false,
      latencyMs: 1,
      testedAt: NOW,
    }).stored,
    true,
  );
  profiles.update(PROFILE_ID, { enabled: true, now: NOW });
  new ModelProfilePrivacyRepository(database).declare(
    PROFILE_ID,
    {
      executionLocation: "local",
      retention: "zero",
      trainingUse: "prohibited",
      sensitiveDataAllowed: true,
    },
    NOW,
  );
}

function seedDocument(input: {
  database: WorkspaceDatabase;
  blobs: LocalWorkspaceBlobStore;
  projectId: string;
  filename: string;
  text: string;
}) {
  const documentId = randomUUID();
  const versionId = randomUUID();
  const chunkId = randomUUID();
  const bytes = Buffer.byteLength(input.text, "utf8");
  input.database
    .prepare(
      `INSERT INTO documents
        (id,project_id,title,filename,mime_type,size_bytes,parse_status,current_version_id,created_at,updated_at)
       VALUES (?,?,?,?,? ,?,'pending',NULL,?,?)`,
    )
    .run(documentId, input.projectId, input.filename, input.filename, "text/plain", bytes, NOW, NOW);
  input.database
    .prepare(
      `INSERT INTO document_versions
        (id,document_id,version_number,source,filename,mime_type,size_bytes,content_sha256,storage_key,page_count,created_at)
       VALUES (?,?,1,'upload',?,?,?,?,?,1,?)`,
    )
    .run(
      versionId,
      documentId,
      input.filename,
      "text/plain",
      bytes,
      sha(input.text),
      workspaceBlobStorageKey({ kind: "original", documentId, versionId }),
      NOW,
    );
  const stored = input.blobs.putSync(
    { kind: "extracted_text", documentId, versionId },
    input.text,
  );
  new WorkspaceBlobRecordsRepository(input.database).registerStored({
    locator: stored.locator,
    contentSha256: stored.sha256,
    sizeBytes: stored.size,
    storedSizeBytes: stored.storedSize,
  });
  input.database
    .prepare(
      `INSERT INTO document_chunks
        (id,document_id,version_id,ordinal,text,start_offset,end_offset,page_start,page_end,content_sha256,created_at)
       VALUES (?,?,?,0,?,0,?,1,1,?,?)`,
    )
    .run(chunkId, documentId, versionId, input.text, input.text.length, sha(input.text), NOW);
  input.database
    .prepare(
      "UPDATE documents SET current_version_id=?,parse_status='ready',updated_at=? WHERE id=?",
    )
    .run(versionId, NOW, documentId);
  return { documentId, versionId };
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 20_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`Timed out waiting for ${label}.`);
}

async function createMatterAndDocuments(
  runtime: WorkspaceRuntime,
  database: WorkspaceDatabase,
  blobs: LocalWorkspaceBlobStore,
) {
  const context = { principalId: WORKSPACE_LOCAL_PRINCIPAL_ID };
  const matter = (await runtime.matterProfiles.api.createMatter(context, {
    name: "Flagship contract review Matter",
    workspaceType: "transaction",
    clientName: "Acme",
    jurisdiction: "England",
    representedRole: "Customer",
    objective: "Review two commercial agreements.",
  })) as { project: { id: string } };
  await runtime.matterProfiles.api.replaceMatterPolicy(context, matter.project.id, {
    externalEgressMode: "disabled",
    executionLocations: ["local"],
    allowExternalLegalSources: false,
    allowWordBridge: false,
  });
  const documents = [
    seedDocument({
      database,
      blobs,
      projectId: matter.project.id,
      filename: "alpha-agreement.txt",
      text: "This Agreement is between Acme and Alpha. Liability is capped at fees paid. Renewal is automatic unless notice is given.",
    }),
    seedDocument({
      database,
      blobs,
      projectId: matter.project.id,
      filename: "beta-agreement.txt",
      text: "This Agreement is between Acme and Beta. Liability is uncapped for confidentiality. Renewal requires written agreement.",
    }),
  ];
  return { context, projectId: matter.project.id, documents };
}

/** The public chats port intentionally permits partial composition; this
 * flagship audit requires the durable generation surface to be installed. */
function requireChats(runtime: WorkspaceRuntime) {
  const {
    createChat,
    requestGeneration,
    generationStatus,
    generationEvents,
    cancelGeneration,
  } = runtime.chats;
  assert.ok(createChat);
  assert.ok(requestGeneration);
  assert.ok(generationStatus);
  assert.ok(generationEvents);
  assert.ok(cancelGeneration);
  return {
    createChat: createChat.bind(runtime.chats),
    requestGeneration: requestGeneration.bind(runtime.chats),
    generationStatus: generationStatus.bind(runtime.chats),
    generationEvents: generationEvents.bind(runtime.chats),
    cancelGeneration: cancelGeneration.bind(runtime.chats),
  };
}

async function requestReview(input: {
  runtime: WorkspaceRuntime;
  context: { principalId: string };
  projectId: string;
  documents: Array<{ documentId: string }>;
  title: string;
}) {
  const chats = requireChats(input.runtime);
  const chat = await chats.createChat(input.context, {
    projectId: input.projectId,
    title: input.title,
    modelProfileId: PROFILE_ID,
  });
  return chats.requestGeneration(input.context, {
    chatId: chat.id,
    prompt: "Review the attached contracts and create the comparison review with a risk memo.",
    modelProfileId: PROFILE_ID,
    allowedDocumentIds: input.documents.map((document) => document.documentId),
    attachmentDocumentIds: input.documents.map((document) => document.documentId),
  });
}

async function main() {
  const root = mkdtempSync(path.join(os.tmpdir(), "vera-contract-review-e2e-"));
  const databasePath = path.join(root, "workspace.sqlite");
  const blobRoot = path.join(root, "blobs");
  const dataDir = path.join(root, "runtime");
  const credentials = new AuditCredentialStore();
  const control: ProviderControl = {
    assistantCalls: 0,
    tabularCalls: 0,
    holdTabular: false,
    requests: [],
  };
  const registry = new WorkspaceModelProviderRegistry(credentials, {
    fetchImpl: fakeOpenAiFetch(control),
  });
  let database: WorkspaceDatabase | null = null;
  let runtime: WorkspaceRuntime | null = null;
  try {
    database = new WorkspaceDatabase(databasePath);
    const blobs = new LocalWorkspaceBlobStore({
      root: blobRoot,
      codec: new IdentityCodec(),
      allowUnencryptedCodec: true,
    });
    seedProfile(database, credentials);
    runtime = new WorkspaceRuntime({
      database,
      blobs,
      dataDir,
      credentialStore: credentials,
      modelProviderRegistry: registry,
    });
    await runtime.start();
    assert.equal(runtime.assistantGenerationAvailable(), true);
    assert.equal(runtime.tabularGenerationAvailable(), true);
    const fixture = await createMatterAndDocuments(runtime, database, blobs);
    assert.equal(
      new WorkspaceInferencePolicy(database).evaluate({
        scope: { scope: "matter", projectId: fixture.projectId, matterProfilePresent: true },
        modelProfileId: PROFILE_ID,
        operation: "assistant",
      }).decision,
      "allow",
    );

    const chats = requireChats(runtime);
    const first = await requestReview({ ...fixture, runtime, title: "Complete review" });
    let firstStatus = "queued";
    await waitFor(async () => {
      firstStatus = (await chats.generationStatus(fixture.context, first.jobId)).status;
      return ["complete", "failed", "cancelled"].includes(firstStatus);
    }, "the complete Assistant contract review");
    assert.equal(firstStatus, "complete");
    const replay = await chats.generationEvents(fixture.context, first.jobId, {
      cursor: 0,
      limit: 100,
    });
    const reviewEvent = replay.events.find(
      (entry) => entry.event.type === "tabular_review_created",
    );
    const draftEvent = replay.events.find((entry) => entry.event.type === "draft_created");
    assert.ok(reviewEvent && reviewEvent.event.type === "tabular_review_created");
    assert.ok(draftEvent && draftEvent.event.type === "draft_created");
    const reviewId = reviewEvent.event.review_id;
    const review = (await runtime.tabular.getTabularReview(fixture.context, reviewId)) as {
      review: { status: string; document_ids: string[] };
      cells: Array<{ status: string }>;
    };
    assert.equal(review.review.status, "complete");
    assert.equal(review.review.document_ids.length, 2);
    assert.ok(review.cells.length > 2, "the real built-in preset creates durable matrix cells");
    assert.deepEqual(
      [...new Set(review.cells.map((cell) => cell.status))],
      ["done"],
    );
    assert.equal(
      Number(database.prepare("SELECT count(*) AS count FROM tabular_review_studio_handoffs").get()?.count),
      1,
    );
    assert.equal(
      Number(database.prepare("SELECT count(*) AS count FROM jobs WHERE type='tabular_cell' AND status='complete'").get()?.count) >= review.cells.length,
      true,
    );
    assert.equal(
      Number(
        database
          .prepare(
            `SELECT count(*) AS count
               FROM tabular_cells cell
               JOIN jobs job ON job.id = cell.job_id
              WHERE cell.review_id = ?
                AND (cell.completed_at IS NULL OR job.completed_at IS NULL OR cell.completed_at <> job.completed_at)`,
          )
          .get(reviewId)?.count,
      ),
      0,
      "every completed cell and its fenced durable job share one completion timestamp",
    );
    assert.equal(control.assistantCalls, 3, "the provider performs fetch, review, and final Assistant rounds");
    assert.ok(control.tabularCalls >= review.cells.length);
    assert.equal(
      control.requests.every((request) => request.authorization === `Bearer ${SECRET}`),
      true,
    );

    await runtime.stop();
    runtime = null;
    database = new WorkspaceDatabase(databasePath);
    const restartedBlobs = new LocalWorkspaceBlobStore({
      root: blobRoot,
      codec: new IdentityCodec(),
      allowUnencryptedCodec: true,
    });
    runtime = new WorkspaceRuntime({
      database,
      blobs: restartedBlobs,
      dataDir,
      credentialStore: credentials,
      modelProviderRegistry: registry,
    });
    await runtime.start();
    const restartedChats = requireChats(runtime);
    const restartedReplay = await restartedChats.generationEvents(
      fixture.context,
      first.jobId,
      { cursor: 0, limit: 100 },
    );
    assert.equal(restartedReplay.status, "complete");
    assert.equal(
      restartedReplay.events.filter((entry) => entry.event.type === "tabular_review_created").length,
      1,
    );
    assert.equal(
      restartedReplay.events.filter((entry) => entry.event.type === "draft_created").length,
      1,
    );
    assert.equal(
      Number(database.prepare("SELECT count(*) AS count FROM tabular_review_studio_handoffs").get()?.count),
      1,
      "restart preserves the one v23 memo handoff",
    );

    control.holdTabular = true;
    const cancelled = await requestReview({ ...fixture, runtime, title: "Cancelled review" });
    await waitFor(
      () =>
        Number(database!.prepare("SELECT count(*) AS count FROM tabular_reviews").get()?.count) === 2 &&
        control.tabularCalls > review.cells.length,
      "the second review to enter real tabular generation",
    );
    await restartedChats.cancelGeneration(
      fixture.context,
      cancelled.jobId,
      "User cancelled the contract review.",
    );
    await waitFor(async () =>
      (await restartedChats.generationStatus(fixture.context, cancelled.jobId)).status === "cancelled",
    "Assistant cancellation to cascade into the review cells");
    const cancelledReview = database
      .prepare("SELECT id,status FROM tabular_reviews WHERE id <> ?")
      .get(reviewId) as { id: string; status: string } | undefined;
    assert.equal(cancelledReview?.status, "cancelled");
    assert.equal(
      Number(database.prepare("SELECT count(*) AS count FROM tabular_review_studio_handoffs").get()?.count),
      1,
      "a cancelled review never creates a Studio memo",
    );
    assert.equal(
      Number(database.prepare("SELECT count(*) AS count FROM tabular_cells WHERE review_id=? AND status='cancelled'").get(cancelledReview?.id)?.count) > 0,
      true,
    );
    console.log(
      JSON.stringify(
        {
          audit: "vera-workspace-assistant-contract-review-e2e",
          status: "pass",
          checks: [
            "real Assistant provider tool calls fetch snapshots then invoke run_contract_review",
            "shared durable pump executes real Tabular cell jobs through the provider adapter",
            "completed matrix emits Review and Draft events and creates exactly one v23 Studio memo",
            "durable Assistant events and v23 handoff survive a runtime/database restart",
            "Assistant cancellation cascades to the in-flight Review and prevents a memo",
          ],
        },
        null,
        2,
      ),
    );
  } finally {
    if (runtime) await runtime.stop().catch(() => undefined);
    else database?.close();
    rmSync(root, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
