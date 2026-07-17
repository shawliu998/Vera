import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { WorkspaceBlobCodec } from "../lib/workspace/blobStore";
import { WorkspaceDatabase } from "../lib/workspace/database";
import {
  ModelProfilePrivacyRepository,
  WorkspaceInferencePolicy,
} from "../lib/workspace/inferencePolicy";
import { LocalWorkspaceBlobStore } from "../lib/workspace/localWorkspaceBlobStore";
import { defaultOriginForProvider } from "../lib/workspace/modelCompatibility";
import { WorkspaceModelProviderRegistry } from "../lib/workspace/modelProviderRegistry";
import { WORKSPACE_LOCAL_PRINCIPAL_ID } from "../lib/workspace/principal";
import {
  WorkspaceBlobRecordsRepository,
  workspaceBlobStorageKey,
} from "../lib/workspace/repositories/blobRecords";
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
const PROFILE_ID = "82000000-0000-4000-8000-000000000001";
const SECRET = "sk-general-legal-e2e-test-secret";
const QUOTE = "Acme received the notice on 3 July 2026.";

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

function requestScenario(
  messages: Array<{ role?: unknown; content?: unknown }>,
) {
  const user = messages.find((message) => message.role === "user");
  const prompt = typeof user?.content === "string" ? user.content : "";
  if (prompt.includes("[timeline-memo]")) return "timeline-memo" as const;
  if (prompt.includes("[custom-memo]")) return "custom-memo" as const;
  return "custom" as const;
}

function toolReviewId(messages: Array<{ role?: unknown; content?: unknown }>) {
  for (const message of messages) {
    if (typeof message.content !== "string") continue;
    const content = message.content.startsWith("[Tool result]\n")
      ? message.content.slice("[Tool result]\n".length)
      : message.content;
    try {
      const parsed = JSON.parse(content) as {
        review?: { review_id?: unknown };
      };
      if (typeof parsed.review?.review_id === "string")
        return parsed.review.review_id;
    } catch {
      // A document-tool response is not the general legal review response.
    }
  }
  throw new Error("The Assistant did not receive the durable Review id.");
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
      const messages = body.input ?? [];
      const scenario = requestScenario(messages);
      const assistantHistory = messages
        .filter((message) => message.role === "assistant")
        .map((message) => String(message.content));
      if (
        assistantHistory.some((content) =>
          content.includes('"create_memo_from_tabular_review"'),
        )
      ) {
        return completedResponse([
          {
            type: "response.output_text.delta",
            delta:
              "The completed Review and evidence-based Studio memo are ready.",
          },
          {
            type: "response.completed",
            response: { usage: { input_tokens: 80, output_tokens: 18 } },
          },
        ]);
      }
      if (
        assistantHistory.some((content) =>
          content.includes('"run_custom_extraction"'),
        )
      ) {
        if (scenario === "timeline-memo" || scenario === "custom-memo") {
          return toolResponse(
            `${scenario}-draft`,
            "create_memo_from_tabular_review",
            {
              review_id: toolReviewId(messages),
              title:
                scenario === "timeline-memo"
                  ? "Matter Timeline Facts Memo"
                  : "Notice Facts Extraction Summary",
            },
          );
        }
        return completedResponse([
          {
            type: "response.output_text.delta",
            delta:
              "The completed extraction Review is ready to inspect and export.",
          },
          {
            type: "response.completed",
            response: { usage: { input_tokens: 80, output_tokens: 18 } },
          },
        ]);
      }
      if (
        assistantHistory.some((content) =>
          content.includes('"fetch_documents"'),
        )
      ) {
        if (scenario === "timeline-memo") {
          return toolResponse("timeline", "run_custom_extraction", {
            mode: "timeline",
            title: "Matter Timeline",
          });
        }
        return toolResponse("custom-extraction", "run_custom_extraction", {
          mode: "custom",
          title: "Notice facts",
          columns: [
            {
              name: "Notice date",
              instruction: "Extract the exact date when notice was received.",
              format: "date",
            },
            {
              name: "Notice fact",
              instruction: "Summarize the notice event from the source text.",
            },
          ],
        });
      }
      return toolResponse("fetch-attached", "fetch_documents", {
        doc_ids: ["doc-0", "doc-1"],
      });
    }
    assert.equal(
      feature,
      "vera_tabular",
      "unexpected provider request feature",
    );
    control.tabularCalls += 1;
    const valueSchema = body.text?.format?.schema?.properties?.value as
      | { type?: unknown; enum?: unknown }
      | undefined;
    const documentPrompt = body.input?.find(
      (message) => message.role === "user",
    )?.content;
    const evidenceQuote =
      typeof documentPrompt === "string" && documentPrompt.includes(QUOTE)
        ? QUOTE
        : "On 5 July 2026 Acme discussed the notice with Beta.";
    const value =
      valueSchema?.type === "boolean"
        ? false
        : valueSchema?.type === "number"
          ? 0
          : Array.isArray(valueSchema?.enum)
            ? valueSchema.enum[0]
            : evidenceQuote;
    return completedResponse([
      {
        type: "response.output_text.delta",
        delta: JSON.stringify({
          value,
          reasoning:
            "The value is limited to the exact reviewed document text.",
          flag: "grey",
          quotes: [evidenceQuote],
        }),
      },
      {
        type: "response.completed",
        response: { usage: { input_tokens: 90, output_tokens: 22 } },
      },
    ]);
  }) as typeof fetch;
}

function seedProfile(
  database: WorkspaceDatabase,
  credentials: AuditCredentialStore,
) {
  const profiles = new ModelProfilesRepository(database);
  profiles.create({
    id: PROFILE_ID,
    name: "Flagship general-legal e2e audit model",
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
    "generalegale2e001",
  );
  credentials.store({
    reference,
    binding: {
      profileId: PROFILE_ID,
      provider: "openai",
      canonicalOrigin: origin,
    },
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
    .run(
      documentId,
      input.projectId,
      input.filename,
      input.filename,
      "text/plain",
      bytes,
      NOW,
      NOW,
    );
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
    .run(
      chunkId,
      documentId,
      versionId,
      input.text,
      input.text.length,
      sha(input.text),
      NOW,
    );
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
    name: "Flagship general legal Matter",
    workspaceType: "transaction",
    clientName: "Acme",
    jurisdiction: "England",
    representedRole: "Client",
    objective: "Extract notice facts and create a timeline memo.",
  })) as { project: { id: string } };
  await runtime.matterProfiles.api.replaceMatterPolicy(
    context,
    matter.project.id,
    {
      externalEgressMode: "disabled",
      executionLocations: ["local"],
      allowExternalLegalSources: false,
      allowWordBridge: false,
    },
  );
  const documents = [
    seedDocument({
      database,
      blobs,
      projectId: matter.project.id,
      filename: "notice-letter.txt",
      text: `${QUOTE} The letter requested a response by 10 July 2026.`,
    }),
    seedDocument({
      database,
      blobs,
      projectId: matter.project.id,
      filename: "meeting-note.txt",
      text: "On 5 July 2026 Acme discussed the notice with Beta. The response remained under review.",
    }),
  ];
  return { context, projectId: matter.project.id, documents };
}

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

async function requestAssistant(input: {
  runtime: WorkspaceRuntime;
  context: { principalId: string };
  projectId: string;
  documents: Array<{ documentId: string }>;
  title: string;
  prompt: string;
}) {
  const chats = requireChats(input.runtime);
  const chat = await chats.createChat(input.context, {
    projectId: input.projectId,
    title: input.title,
    modelProfileId: PROFILE_ID,
  });
  return chats.requestGeneration(input.context, {
    chatId: chat.id,
    prompt: input.prompt,
    modelProfileId: PROFILE_ID,
    allowedDocumentIds: input.documents.map((document) => document.documentId),
    attachmentDocumentIds: input.documents.map(
      (document) => document.documentId,
    ),
  });
}

async function waitForTerminalGeneration(input: {
  runtime: WorkspaceRuntime;
  context: { principalId: string };
  jobId: string;
  label: string;
}) {
  const chats = requireChats(input.runtime);
  let status = "queued";
  await waitFor(async () => {
    status = (await chats.generationStatus(input.context, input.jobId)).status;
    return ["complete", "failed", "cancelled"].includes(status);
  }, input.label);
  return status;
}

function eventIds(
  events: readonly { event: { type: string; [key: string]: unknown } }[],
) {
  const review = events.find(
    (entry) => entry.event.type === "tabular_review_created",
  )?.event.review_id;
  const draft = events.find((entry) => entry.event.type === "draft_created")
    ?.event.draft_id;
  return {
    reviewId: typeof review === "string" ? review : null,
    draftId: typeof draft === "string" ? draft : null,
  };
}

async function main() {
  const root = mkdtempSync(path.join(os.tmpdir(), "vera-general-legal-e2e-"));
  const databasePath = path.join(root, "workspace.sqlite");
  const blobRoot = path.join(root, "blobs");
  const dataDir = path.join(root, "runtime");
  const credentials = new AuditCredentialStore();
  const control: ProviderControl = {
    assistantCalls: 0,
    tabularCalls: 0,
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
        scope: {
          scope: "matter",
          projectId: fixture.projectId,
          matterProfilePresent: true,
        },
        modelProfileId: PROFILE_ID,
        operation: "assistant",
      }).decision,
      "allow",
    );

    const custom = await requestAssistant({
      ...fixture,
      runtime,
      title: "Custom extraction",
      prompt:
        "[custom] Extract the notice date and fact from the attached documents into a Review I can export to XLSX.",
    });
    const chats = requireChats(runtime);
    const customStatus = await waitForTerminalGeneration({
      runtime,
      context: fixture.context,
      jobId: custom.jobId,
      label: "the complete custom extraction",
    });
    if (customStatus !== "complete") {
      const failed = await chats.generationEvents(
        fixture.context,
        custom.jobId,
        {
          cursor: 0,
          limit: 100,
        },
      );
      assert.fail(`Custom extraction failed: ${JSON.stringify(failed.events)}`);
    }
    const customReplay = await chats.generationEvents(
      fixture.context,
      custom.jobId,
      {
        cursor: 0,
        limit: 100,
      },
    );
    const customArtifacts = eventIds(customReplay.events);
    assert.ok(customArtifacts.reviewId);
    assert.equal(
      customArtifacts.draftId,
      null,
      "custom extraction alone does not create a Draft",
    );
    const customReview = (await runtime.tabular.getTabularReview(
      fixture.context,
      customArtifacts.reviewId,
    )) as {
      review: { status: string; document_ids: string[] };
      cells: Array<{ status: string }>;
    };
    assert.equal(customReview.review.status, "complete");
    assert.deepEqual(
      customReview.review.document_ids,
      fixture.documents.map((document) => document.documentId).sort(),
    );
    assert.equal(customReview.cells.length, 4);
    assert.deepEqual(
      [...new Set(customReview.cells.map((cell) => cell.status))],
      ["done"],
    );
    assert.equal(
      Number(
        database
          .prepare(
            "SELECT count(*) AS count FROM jobs WHERE type='tabular_cell' AND status='complete'",
          )
          .get()?.count,
      ),
      customReview.cells.length,
    );
    const xlsx = await runtime.tabular.exportTabularReview(
      fixture.context,
      customArtifacts.reviewId,
      "xlsx",
    );
    assert.match(xlsx.filename, /^Vera-[0-9a-f-]+\.xlsx$/);
    assert.equal(
      xlsx.contentType,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    assert.ok(Buffer.isBuffer(xlsx.body));
    assert.ok(
      xlsx.body.length > 128,
      "the persisted Review has a real XLSX resource",
    );

    const customMemo = await requestAssistant({
      ...fixture,
      runtime,
      title: "Custom extraction with memo",
      prompt:
        "[custom-memo] Extract the notice facts from the attached documents and create a memo from the completed Review.",
    });
    const customMemoStatus = await waitForTerminalGeneration({
      runtime,
      context: fixture.context,
      jobId: customMemo.jobId,
      label: "the complete custom extraction and memo",
    });
    const customMemoReplay = await chats.generationEvents(
      fixture.context,
      customMemo.jobId,
      { cursor: 0, limit: 100 },
    );
    if (customMemoStatus !== "complete") {
      const job = database
        .prepare("SELECT error_code,error_json FROM jobs WHERE id=?")
        .get(customMemo.jobId);
      assert.fail(
        `Custom extraction memo failed: ${JSON.stringify({ events: customMemoReplay.events, job })}`,
      );
    }
    const customMemoArtifacts = eventIds(customMemoReplay.events);
    assert.ok(customMemoArtifacts.reviewId);
    assert.ok(customMemoArtifacts.draftId);
    const customMemoDraft = await runtime.getStudioDocument(
      fixture.context,
      fixture.projectId,
      customMemoArtifacts.draftId,
    );
    assert.match(
      customMemoDraft.content,
      /\| Source document \| Notice date \| Notice fact \|/,
    );
    assert.match(customMemoDraft.content, new RegExp(QUOTE));
    assert.equal(
      database
        .prepare(
          "SELECT document_type FROM document_studio_draft_metadata WHERE document_id=?",
        )
        .get(customMemoArtifacts.draftId)?.document_type,
      "general_legal_document",
    );
    assert.equal(
      Number(
        database
          .prepare(
            "SELECT count(*) AS count FROM tabular_review_studio_handoffs",
          )
          .get()?.count,
      ),
      0,
      "custom extraction summaries reuse the handoff foundation without writing the contract-only v23 table",
    );

    const timeline = await requestAssistant({
      ...fixture,
      runtime,
      title: "Timeline with memo",
      prompt:
        "[timeline-memo] Build the attached-document timeline and create a factual memo from the completed Review.",
    });
    const timelineStatus = await waitForTerminalGeneration({
      runtime,
      context: fixture.context,
      jobId: timeline.jobId,
      label: "the complete timeline and memo",
    });
    const timelineReplay = await chats.generationEvents(
      fixture.context,
      timeline.jobId,
      {
        cursor: 0,
        limit: 100,
      },
    );
    if (timelineStatus !== "complete") {
      const job = database
        .prepare("SELECT error_code,error_json FROM jobs WHERE id=?")
        .get(timeline.jobId);
      assert.fail(
        `Timeline and memo failed: ${JSON.stringify({ events: timelineReplay.events, job })}`,
      );
    }
    const timelineArtifacts = eventIds(timelineReplay.events);
    assert.ok(timelineArtifacts.reviewId);
    assert.ok(timelineArtifacts.draftId);
    const timelineReview = (await runtime.tabular.getTabularReview(
      fixture.context,
      timelineArtifacts.reviewId,
    )) as {
      review: { status: string; document_ids: string[] };
      cells: Array<{ status: string }>;
    };
    assert.equal(timelineReview.review.status, "complete");
    assert.equal(
      Number(
        database
          .prepare(
            "SELECT count(*) AS count FROM tabular_review_columns WHERE review_id=?",
          )
          .get(timelineArtifacts.reviewId)?.count,
      ),
      7,
      "the timeline preset creates its durable schema",
    );
    assert.deepEqual(
      [...new Set(timelineReview.cells.map((cell) => cell.status))],
      ["done"],
    );
    const memo = await runtime.getStudioDocument(
      fixture.context,
      fixture.projectId,
      timelineArtifacts.draftId,
    );
    assert.match(memo.content, /# Matter Timeline Facts Memo/);
    assert.match(memo.content, /Review/);
    assert.match(memo.content, new RegExp(timelineArtifacts.reviewId));
    assert.match(memo.content, new RegExp(QUOTE));
    const memoDocx = await runtime.exportStudioDocumentDocx(
      fixture.context,
      fixture.projectId,
      timelineArtifacts.draftId,
    );
    assert.match(memoDocx.filename, /\.docx$/);
    assert.equal(
      memoDocx.contentType,
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    assert.ok(
      memoDocx.bytes.length > 128,
      "the Studio Draft meets the real DOCX export precondition",
    );
    assert.equal(
      Number(
        database
          .prepare(
            "SELECT count(*) AS count FROM tabular_review_studio_handoffs",
          )
          .get()?.count,
      ),
      0,
      "timeline fact summaries do not write the contract-only v23 handoff table",
    );

    assert.equal(
      control.requests.every(
        (request) => request.authorization === `Bearer ${SECRET}`,
      ),
      true,
    );

    console.log(
      JSON.stringify(
        {
          audit: "vera-workspace-assistant-general-legal-e2e",
          status: "pass",
          checks: [
            "one Assistant instruction fetches attached evidence then invokes run_custom_extraction through the real model tool-call loop",
            "the durable pump runs actual Tabular cell jobs and the persisted Review produces a real XLSX resource",
            "custom extraction summaries use the shared prepared Review-to-Studio path without writing the v23 contract-only table",
            "the timeline preset waits to completion before create_memo_from_tabular_review creates an evidence-based Studio Draft with a real DOCX export precondition",
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
