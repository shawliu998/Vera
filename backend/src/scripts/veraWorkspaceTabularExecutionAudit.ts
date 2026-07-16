import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { BlobStore, WorkspaceBlobCodec } from "../lib/workspace/blobStore";
import { WorkspaceDatabase } from "../lib/workspace/database";
import { WorkspaceApiError } from "../lib/workspace/errors";
import { defaultOriginForProvider } from "../lib/workspace/modelCompatibility";
import { WorkspaceModelProviderRegistry } from "../lib/workspace/modelProviderRegistry";
import { LocalWorkspaceBlobStore } from "../lib/workspace/localWorkspaceBlobStore";
import { createWorkspaceJobPump } from "../lib/workspace/jobs/pump";
import { WorkspaceBlobRecordsRepository } from "../lib/workspace/repositories/blobRecords";
import { ModelConnectionTestsRepository } from "../lib/workspace/repositories/modelConnectionTests";
import { ModelProfilesRepository } from "../lib/workspace/repositories/modelProfiles";
import { ProjectsRepository } from "../lib/workspace/repositories/projects";
import { TabularRepository } from "../lib/workspace/repositories/tabular";
import { WorkspaceJobsRepository } from "../lib/workspace/repositories/jobs";
import { AuthoritativeExtractedTextReader } from "../lib/workspace/services/authoritativeExtractedText";
import {
  CREDENTIAL_STORE_OPERATION_MODE,
  buildStoredCredentialReference,
  type CredentialDeletionInput,
  type CredentialResolutionInput,
  type CredentialStorageInput,
  type SynchronousCredentialStorePort,
} from "../lib/workspace/services/credentialStore";
import { WorkspaceJobEnqueuerAdapter } from "../lib/workspace/services/jobEnqueuer";
import {
  WorkspaceJobAbortRegistry,
  WorkspaceJobsService,
} from "../lib/workspace/services/jobs";
import {
  MAX_TABULAR_DOCUMENT_TEXT_BYTES,
  TabularService,
} from "../lib/workspace/services/tabular";
import { WorkspaceTabularModelAdapter } from "../lib/workspace/services/tabularModelAdapter";
import { createTabularCellJobHandler } from "../lib/workspace/services/tabularRuntime";
import { WorkspaceTabularV1RuntimeAdapter } from "../lib/workspace/services/tabularV1RuntimeAdapter";
import { workspaceBlobStorageKey } from "../lib/workspace/repositories/blobRecords";
import { WORKSPACE_LOCAL_PRINCIPAL_ID } from "../lib/workspace/principal";
import { WorkspaceRuntime } from "../lib/workspace/runtime";
import {
  ModelProfilePrivacyRepository,
  WorkspaceInferencePolicy,
} from "../lib/workspace/inferencePolicy";

const NOW = "2026-07-15T08:00:00.000Z";
const PROFILE_ID = "10000000-0000-4000-8000-000000000001";
const PROJECT_A = "20000000-0000-4000-8000-000000000001";
const PROJECT_B = "20000000-0000-4000-8000-000000000002";
// privacy-preflight-public-token-sha256:406eb031736243fc31c15a8daa472ededeee2b2fe8b9640bfb667a122524eef1
const SECRET = "sk-audit-provider-secret-1234567890";
const SECRET_PATH = "/Users/private/legal-provider-key";

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
  failNext: boolean;
  holdNext: boolean;
  requests: Array<{ authorization: string | null; body: unknown }>;
};

function hash(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

function sse(events: unknown[]) {
  return `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}`;
}

function responseForPrompt(prompt: string) {
  const party = prompt.match(/Party:\s*([^.]*)\./)?.[1]?.trim() ?? "Unknown";
  const renewal = prompt.match(/Auto-renewal:\s*(Yes|No)\./)?.[1] ?? "No";
  const isRenewalColumn = prompt.includes("Determine whether auto-renewal");
  return isRenewalColumn
    ? {
        value: renewal === "Yes",
        reasoning: "The exact renewal clause supplies the answer.",
        flag: renewal === "Yes" ? "yellow" : "green",
        quotes: [`Auto-renewal: ${renewal}`],
      }
    : {
        value: party,
        reasoning: "The exact party clause supplies the answer.",
        flag: "grey",
        quotes: [`Party: ${party}`],
      };
}

function fakeOpenAiFetch(control: ProviderControl): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const authorization = new Headers(init?.headers).get("authorization");
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      input?: Array<{ content?: unknown }>;
    };
    control.requests.push({ authorization, body });
    if (control.holdNext) {
      control.holdNext = false;
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
    if (control.failNext) {
      control.failNext = false;
      return new Response(
        JSON.stringify({
          error: {
            message: `provider leaked ${SECRET} at ${SECRET_PATH}`,
          },
        }),
        {
          status: 429,
          headers: { "content-type": "application/json" },
        },
      );
    }
    const prompt =
      body.input?.map((message) => String(message.content)).join("\n") ?? "";
    const output = JSON.stringify(responseForPrompt(prompt));
    return new Response(
      sse([
        { type: "response.output_text.delta", delta: output },
        {
          type: "response.completed",
          response: {
            usage: { input_tokens: 120, output_tokens: 40 },
          },
        },
      ]),
      {
        status: 200,
        headers: { "content-type": "text/event-stream; charset=utf-8" },
      },
    );
  }) as typeof fetch;
}

function seedProject(database: WorkspaceDatabase, id: string, name: string) {
  new ProjectsRepository(database).create({
    id,
    name,
    description: null,
    cmNumber: null,
    practice: "General Transactions",
    now: NOW,
  });
}

function seedProfile(
  database: WorkspaceDatabase,
  credentials: AuditCredentialStore,
) {
  const profiles = new ModelProfilesRepository(database);
  profiles.create({
    id: PROFILE_ID,
    name: "Audit OpenAI",
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
    "auditcredential0001",
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
  const result = new ModelConnectionTestsRepository(database).storeIfCurrent({
    profileId: PROFILE_ID,
    expectedConnectionRevision: stored.connectionRevision,
    status: "passed",
    errorCode: null,
    retryable: false,
    latencyMs: 4,
    testedAt: NOW,
  });
  assert.equal(result.stored, true);
  profiles.update(PROFILE_ID, { enabled: true, now: NOW });
  return profiles;
}

function seedDocument(input: {
  database: WorkspaceDatabase;
  blobs: LocalWorkspaceBlobStore;
  projectId: string;
  text: string;
  filename: string;
}) {
  const documentId = randomUUID();
  const versionId = randomUUID();
  const chunkId = randomUUID();
  const textBytes = Buffer.byteLength(input.text, "utf8");
  input.database
    .prepare(
      `INSERT INTO documents
        (id, project_id, title, filename, mime_type, size_bytes, parse_status,
         current_version_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'text/plain', ?, 'pending', NULL, ?, ?)`,
    )
    .run(
      documentId,
      input.projectId,
      input.filename,
      input.filename,
      textBytes,
      NOW,
      NOW,
    );
  input.database
    .prepare(
      `INSERT INTO document_versions
        (id, document_id, version_number, source, filename, mime_type,
         size_bytes, content_sha256, storage_key, page_count, created_at)
       VALUES (?, ?, 1, 'upload', ?, 'text/plain', ?, ?, ?, 1, ?)`,
    )
    .run(
      versionId,
      documentId,
      input.filename,
      textBytes,
      hash(input.text),
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
        (id, document_id, version_id, ordinal, text, start_offset, end_offset,
         page_start, page_end, content_sha256, created_at)
       VALUES (?, ?, ?, 0, ?, 0, ?, 1, 1, ?, ?)`,
    )
    .run(
      chunkId,
      documentId,
      versionId,
      input.text,
      input.text.length,
      hash(input.text),
      NOW,
    );
  input.database
    .prepare(
      `UPDATE documents
          SET current_version_id = ?, parse_status = 'ready', updated_at = ?
        WHERE id = ?`,
    )
    .run(versionId, NOW, documentId);
  return { documentId, versionId, chunkId, text: input.text };
}

function runtime(input: {
  database: WorkspaceDatabase;
  blobs: LocalWorkspaceBlobStore;
  profiles: ModelProfilesRepository;
  registry: WorkspaceModelProviderRegistry;
}) {
  const reader = new AuthoritativeExtractedTextReader(
    input.database,
    input.blobs,
  );
  const tabular = new TabularRepository(input.database);
  const jobsRepository = new WorkspaceJobsRepository(input.database);
  const abortRegistry = new WorkspaceJobAbortRegistry();
  const jobs = new WorkspaceJobsService(jobsRepository, { abortRegistry });
  const inferencePolicy = new WorkspaceInferencePolicy(input.database);
  const privacy = new ModelProfilePrivacyRepository(input.database);
  for (const profile of input.profiles.list()) {
    if (!privacy.get(profile.id)) {
      privacy.declare(
        profile.id,
        {
          executionLocation: "local",
          retention: "zero",
          trainingUse: "prohibited",
          sensitiveDataAllowed: true,
        },
        NOW,
      );
    }
  }
  const service = new TabularService(
    tabular,
    new WorkspaceJobEnqueuerAdapter(jobs),
    undefined,
    randomUUID,
    { snapshots: reader, profiles: input.profiles, inferencePolicy },
  );
  const model = new WorkspaceTabularModelAdapter(
    input.profiles,
    input.registry,
    reader,
    { inferencePolicy },
  );
  const pump = createWorkspaceJobPump({
    jobs,
    abortRegistry,
    concurrency: 2,
    idleBackoffMs: 5,
    maxIdleBackoffMs: 20,
    drainTimeoutMs: 2_000,
    leaseDurationMs: 1_000,
    handlers: {
      tabular_cell: createTabularCellJobHandler({
        database: input.database,
        tabular,
        jobs: jobsRepository,
        model,
        snapshots: reader,
      }),
    },
  });
  return {
    reader,
    tabular,
    jobs,
    jobsRepository,
    service,
    model,
    inferencePolicy,
    pump,
    wire: new WorkspaceTabularV1RuntimeAdapter(
      input.database,
      tabular,
      service,
    ),
  };
}

async function waitFor(check: () => boolean, label: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for ${label}.`);
}

async function main() {
  const root = mkdtempSync(path.join(os.tmpdir(), "vera-tabular-execution-"));
  const databasePath = path.join(root, "workspace.sqlite");
  const blobRoot = path.join(root, "blobs");
  const credentials = new AuditCredentialStore();
  const control: ProviderControl = {
    failNext: false,
    holdNext: false,
    requests: [],
  };
  const blobs = new LocalWorkspaceBlobStore({
    root: blobRoot,
    codec: new IdentityCodec(),
    allowUnencryptedCodec: true,
  });
  let database: WorkspaceDatabase | null = null;
  let current: ReturnType<typeof runtime> | null = null;
  try {
    database = new WorkspaceDatabase(databasePath);
    seedProject(database, PROJECT_A, "Project A");
    seedProject(database, PROJECT_B, "Project B");
    let profiles = seedProfile(database, credentials);
    const registry = new WorkspaceModelProviderRegistry(credentials, {
      fetchImpl: fakeOpenAiFetch(control),
    });
    const docA = seedDocument({
      database,
      blobs,
      projectId: PROJECT_A,
      filename: "alpha.txt",
      text: "Party: Acme Corp. Auto-renewal: Yes.",
    });
    const docB = seedDocument({
      database,
      blobs,
      projectId: PROJECT_A,
      filename: "beta.txt",
      text: "Party: Beta LLC. Auto-renewal: No.",
    });
    const other = seedDocument({
      database,
      blobs,
      projectId: PROJECT_B,
      filename: "other.txt",
      text: "Party: Other Co. Auto-renewal: No.",
    });

    current = runtime({ database, blobs, profiles, registry });
    assert.throws(
      () =>
        current!.service.create({
          title: "Cross-project",
          projectId: PROJECT_A,
          modelProfileId: PROFILE_ID,
          documentIds: [other.documentId],
          columns: [{ index: 0, name: "Party", format: "text" }],
        }),
      /selected project/,
    );
    assert.throws(
      () =>
        current!.reader.currentSnapshot({
          projectId: PROJECT_A,
          documentId: other.documentId,
          maxTextBytes: MAX_TABULAR_DOCUMENT_TEXT_BYTES,
        }),
      /unavailable/,
    );
    const review = current.service.create({
      title: "Contract matrix",
      projectId: PROJECT_A,
      modelProfileId: PROFILE_ID,
      documentIds: [docA.documentId, docB.documentId],
      columns: [
        {
          index: 0,
          name: "Party",
          format: "text",
          prompt: "Extract the named party.",
        },
        {
          index: 1,
          name: "Auto Renewal",
          format: "yes_no",
          prompt: "Determine whether auto-renewal is enabled.",
        },
      ],
    });
    assert.equal(review.cells.length, 4);
    for (let index = 0; index < 100; index += 1) {
      current.service.create({
        title: `Pagination review ${index + 1}`,
        projectId: PROJECT_A,
        modelProfileId: PROFILE_ID,
        documentIds: [],
        columns: [],
      });
    }
    current.service.create({
      title: "Other project pagination review",
      projectId: PROJECT_B,
      modelProfileId: PROFILE_ID,
      documentIds: [],
      columns: [],
    });
    const projectReviewWires = (await current.wire.listTabularReviews(
      { principalId: WORKSPACE_LOCAL_PRINCIPAL_ID },
      { projectId: PROJECT_A },
    )) as Array<{ id: string; project_id: string }>;
    assert.equal(projectReviewWires.length, 101);
    assert.ok(
      projectReviewWires.every((item) => item.project_id === PROJECT_A),
    );
    await assert.rejects(
      current.wire.getTabularReview(
        { principalId: randomUUID() },
        review.review.id,
      ),
      /not found/i,
    );

    const validSnapshot = current.reader.currentSnapshot({
      projectId: PROJECT_A,
      documentId: docA.documentId,
      maxTextBytes: MAX_TABULAR_DOCUMENT_TEXT_BYTES,
    });
    const tamperingStore: BlobStore = {
      putSync: blobs.putSync.bind(blobs),
      stageDeleteSync: blobs.stageDeleteSync.bind(blobs),
      finalizeDeleteSync: blobs.finalizeDeleteSync.bind(blobs),
      restoreDeleteSync: blobs.restoreDeleteSync.bind(blobs),
      readSync: () => Buffer.from("tampered", "utf8"),
    };
    assert.throws(
      () =>
        new AuthoritativeExtractedTextReader(database!, tamperingStore).read(
          validSnapshot,
          MAX_TABULAR_DOCUMENT_TEXT_BYTES,
        ),
      /integrity/,
    );
    let sourceTombstoned = false;
    let retentionChecks = 0;
    const retentionReader = new AuthoritativeExtractedTextReader(
      database,
      blobs,
      {
        assertModelUse() {
          retentionChecks += 1;
          if (sourceTombstoned) {
            throw new WorkspaceApiError(
              409,
              "PRECONDITION_FAILED",
              "Source payload access is unavailable because the source is tombstoned.",
            );
          }
        },
      },
    );
    const readBeforeTombstone = retentionReader.read(
      validSnapshot,
      MAX_TABULAR_DOCUMENT_TEXT_BYTES,
    );
    const retentionChecksAfterRead = retentionChecks;
    sourceTombstoned = true;
    const providerCallsBeforeTombstonePreflight = control.requests.length;
    const retentionModel = new WorkspaceTabularModelAdapter(
      profiles,
      registry,
      retentionReader,
      { inferencePolicy: current.inferencePolicy },
    );
    await assert.rejects(
      retentionModel.generateCell({
        snapshot: readBeforeTombstone,
        column: review.columns[0]!,
        modelProfileId: PROFILE_ID,
        modelExecutionRevision:
          profiles.requireStored(PROFILE_ID).executionRevision,
        signal: new AbortController().signal,
      }),
      (error: unknown) =>
        error instanceof WorkspaceApiError &&
        error.status === 409 &&
        error.code === "PRECONDITION_FAILED" &&
        /tombstoned/i.test(error.message),
    );
    assert.equal(retentionChecks, retentionChecksAfterRead + 1);
    assert.equal(
      control.requests.length - providerCallsBeforeTombstonePreflight,
      0,
      "a tombstone after text read must block the provider call",
    );
    await assert.rejects(
      current.model.generateCell({
        snapshot: current.reader.read(
          validSnapshot,
          MAX_TABULAR_DOCUMENT_TEXT_BYTES,
        ),
        column: review.columns[0]!,
        modelProfileId: PROFILE_ID,
        modelExecutionRevision:
          profiles.requireStored(PROFILE_ID).executionRevision + 1,
        signal: new AbortController().signal,
      }),
      /changed before execution/,
    );

    await current.pump.start();
    const queued = current.service.runReview(review.review.id);
    assert.equal(queued.queued, 4);
    const queuedJobs = current.jobsRepository.listJobs({
      type: "tabular_cell",
      limit: 20,
    });
    assert.equal(queuedJobs.length, 4);
    for (const job of queuedJobs) {
      const payload = JSON.stringify(job.payload);
      assert.doesNotMatch(payload, /Acme|Beta|Extract the named|Auto-renewal/);
      assert.doesNotMatch(payload, /secret|credential|\/Users\//i);
      assert.match(payload, /blobRecordId/);
      assert.match(payload, /executionRevision/);
    }
    await waitFor(
      () =>
        current!.service
          .get(review.review.id)
          .cells.every((cell) => cell.status === "complete"),
      "the 2x2 matrix to complete",
    );
    const complete = current.service.get(review.review.id);
    assert.deepEqual(
      complete.cells.map((cell) => cell.content?.summary),
      ["Acme Corp", "Yes", "Beta LLC", "No"],
    );
    assert.ok(
      complete.cells.every(
        (cell) =>
          cell.sourceRefs.length === 1 &&
          cell.sourceRefs[0]!.chunkId &&
          cell.sourceRefs[0]!.versionId,
      ),
    );
    assert.ok(control.requests.length >= 4);
    assert.ok(
      control.requests.every(
        (request) => request.authorization === `Bearer ${SECRET}`,
      ),
    );
    const csv = await current.wire.exportTabularReview(
      { principalId: WORKSPACE_LOCAL_PRINCIPAL_ID },
      review.review.id,
      "csv",
    );
    assert.match(String(csv.body), /Acme Corp/);
    assert.doesNotMatch(String(csv.body), /sk-|\/Users\//);
    const detailWire = (await current.wire.getTabularReview(
      { principalId: WORKSPACE_LOCAL_PRINCIPAL_ID },
      review.review.id,
    )) as {
      review: { model_profile_id: string; status: string };
      cells: Array<{
        id: string;
        status: string;
        error: unknown;
        sources: Array<{
          document_id: string;
          version_id: string | null;
          chunk_id: string | null;
          quote: string | null;
          start_offset: number | null;
          end_offset: number | null;
          page_start: number | null;
          page_end: number | null;
        }>;
        created_at: string;
        updated_at: string;
        completed_at: string | null;
      }>;
      documents: unknown[];
    };
    assert.equal(detailWire.review.model_profile_id, PROFILE_ID);
    assert.equal(detailWire.review.status, "complete");
    assert.equal(detailWire.documents.length, 2);
    assert.equal(detailWire.cells.length, 4);
    assert.ok(
      detailWire.cells.every(
        (cell) =>
          cell.status === "done" &&
          cell.error === null &&
          cell.sources[0]?.page_start === 1 &&
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(
            cell.created_at,
          ) &&
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(
            cell.updated_at,
          ) &&
          cell.completed_at !== null &&
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(
            cell.completed_at,
          ),
      ),
    );
    assert.deepEqual(Object.keys(detailWire.cells[0]!.sources[0]!).sort(), [
      "chunk_id",
      "document_id",
      "end_offset",
      "page_end",
      "page_start",
      "quote",
      "start_offset",
      "version_id",
    ]);

    // First restart proves completed cells and exact references are durable.
    assert.equal((await current.pump.stop()).drained, true);
    database.close();
    database = new WorkspaceDatabase(databasePath);
    profiles = new ModelProfilesRepository(database);
    current = runtime({ database, blobs, profiles, registry });
    await current.pump.start();
    const afterRestart = current.service.get(review.review.id);
    assert.equal(afterRestart.review.status, "complete");
    assert.ok(afterRestart.cells.every((cell) => cell.status === "complete"));

    // Explicit regeneration is allowed for a completed cell and creates a new
    // immutable generation/job rather than mutating the old job.
    const regeneratedTarget = afterRestart.cells[0]!;
    current.service.regenerateCell(regeneratedTarget.id);
    await waitFor(
      () =>
        current!.service.get(review.review.id).cells[0]!.status === "complete",
      "completed-cell regeneration",
    );
    assert.equal(current.service.get(review.review.id).cells[0]!.attempt, 2);
    assert.equal(
      current.jobsRepository.listJobs({ type: "tabular_cell", limit: 30 })
        .length,
      5,
    );

    // Clear removes current cell projections, but leaves old terminal job
    // history durable. A retryable provider failure is sanitized and retried
    // through a fresh cell generation.
    current.service.clearCells(review.review.id, [docB.documentId]);
    let cleared = current.service.get(review.review.id);
    assert.ok(
      cleared.cells
        .filter((cell) => cell.documentId === docB.documentId)
        .every(
          (cell) =>
            cell.status === "empty" &&
            cell.jobId === null &&
            cell.attempt === 0,
        ),
    );
    const retryTarget = cleared.cells.find(
      (cell) => cell.documentId === docB.documentId,
    )!;
    control.failNext = true;
    current.service.regenerateCell(retryTarget.id);
    await waitFor(
      () =>
        current!.service
          .get(review.review.id)
          .cells.find((cell) => cell.id === retryTarget.id)?.status ===
        "failed",
      "retryable provider failure",
    );
    const failed = current.service
      .get(review.review.id)
      .cells.find((cell) => cell.id === retryTarget.id)!;
    assert.equal(failed.error?.code, "tabular_model_rate_limited");
    assert.equal(failed.error?.retryable, true);
    assert.doesNotMatch(JSON.stringify(failed.error), /sk-|\/Users\//);
    current.service.retryCell(failed.id);
    await waitFor(
      () =>
        current!.service
          .get(review.review.id)
          .cells.find((cell) => cell.id === failed.id)?.status === "complete",
      "cell retry completion",
    );

    // Cancellation commits cell+job terminal state before aborting provider IO.
    cleared = current.service.get(review.review.id);
    const cancelTarget = cleared.cells.find(
      (cell) => cell.documentId === docB.documentId && cell.status === "empty",
    )!;
    control.holdNext = true;
    current.service.regenerateCell(cancelTarget.id);
    await waitFor(
      () =>
        current!.service
          .get(review.review.id)
          .cells.find((cell) => cell.id === cancelTarget.id)?.status ===
        "running",
      "held provider request",
    );
    current.service.cancelCell(
      review.review.id,
      cancelTarget.id,
      `cancel ${SECRET} ${SECRET_PATH}`,
    );
    await waitFor(
      () =>
        current!.service
          .get(review.review.id)
          .cells.find((cell) => cell.id === cancelTarget.id)?.status ===
        "cancelled",
      "cell cancellation",
    );
    const cancelledJob = current.jobsRepository.getJob(
      current.service
        .get(review.review.id)
        .cells.find((cell) => cell.id === cancelTarget.id)!.jobId!,
    );
    assert.equal(cancelledJob?.status, "cancelled");
    const cancelledWire = (await current.wire.getTabularReview(
      { principalId: WORKSPACE_LOCAL_PRINCIPAL_ID },
      review.review.id,
    )) as {
      cells: Array<{ id: string; status: string; error: unknown }>;
    };
    const cancelledCellWire = cancelledWire.cells.find(
      (cell) => cell.id === cancelTarget.id,
    );
    assert.equal(cancelledCellWire?.status, "error");
    assert.ok(cancelledCellWire?.error);
    assert.doesNotMatch(
      JSON.stringify(cancelledJob),
      new RegExp(`${SECRET}|${SECRET_PATH.replaceAll("/", "\\/")}`),
    );

    // Simulate an expired claim from a crashed process. The shared pump
    // recovers the job and the tabular reconciliation projects a retryable
    // failure instead of leaving a forever-running cell.
    assert.equal((await current.pump.stop()).drained, true);
    current.service.clearCells(review.review.id, [docB.documentId]);
    const staleTarget = current.service
      .get(review.review.id)
      .cells.find((cell) => cell.documentId === docB.documentId)!;
    const staleQueued = current.service.regenerateCell(staleTarget.id);
    const staleJobId = staleQueued.jobId!;
    database
      .prepare(
        `UPDATE jobs
            SET status = 'running', attempt = 1, lease_owner = 'dead-worker',
                lease_expires_at = ?, locked_at = ?, started_at = ?,
                updated_at = ?
          WHERE id = ?`,
      )
      .run(
        "2000-01-01T00:00:00.000Z",
        "2000-01-01T00:00:00.000Z",
        NOW,
        NOW,
        staleJobId,
      );
    database
      .prepare("UPDATE tabular_cells SET status = 'running' WHERE id = ?")
      .run(staleTarget.id);
    database.close();
    database = new WorkspaceDatabase(databasePath);
    profiles = new ModelProfilesRepository(database);
    current = runtime({ database, blobs, profiles, registry });
    const recovered = await current.pump.start();
    assert.ok(recovered.recoveredJobs.some((job) => job.id === staleJobId));
    current.service.reconcileGenerationJobs();
    const staleRecovered = current.service
      .get(review.review.id)
      .cells.find((cell) => cell.id === staleTarget.id)!;
    assert.equal(staleRecovered.status, "failed");
    assert.equal(staleRecovered.error?.retryable, true);

    const persistedJobs = database
      .prepare(
        `SELECT payload_json, result_json, error_json, cancellation_reason
           FROM jobs WHERE type = 'tabular_cell'`,
      )
      .all();
    const persisted = JSON.stringify(persistedJobs);
    assert.doesNotMatch(persisted, /Acme|Beta|Extract the named|Auto-renewal/);
    assert.doesNotMatch(persisted, /sk-|\/Users\//);
    assert.equal((await current.pump.stop()).drained, true);

    // The production composition root must expose the same adapter and install
    // the tabular_cell handler on its one shared pump. This is deliberately
    // verified after a restart against the already durable review matrix.
    const composed = new WorkspaceRuntime({
      dataDir: path.join(root, "composed-runtime"),
      database,
      blobs,
      credentialStore: credentials,
      modelProviderRegistry: registry,
    });
    await composed.start();
    assert.equal(composed.tabularGenerationAvailable(), true);
    assert.equal(composed.health().worker.tabularCell, true);
    const composedDetail = (await composed.tabular.getTabularReview(
      { principalId: WORKSPACE_LOCAL_PRINCIPAL_ID },
      review.review.id,
    )) as { cells: unknown[]; documents: unknown[] };
    assert.equal(composedDetail.cells.length, 4);
    assert.equal(composedDetail.documents.length, 2);
    await composed.stop();
    database = null;

    console.log(
      JSON.stringify(
        {
          audit: "vera-workspace-tabular-execution",
          status: "pass",
          checks: [
            "authoritative-extracted-text-snapshot-and-blob-tamper-gate",
            "post-read-retention-tombstone-zero-provider-call-preflight",
            "two-documents-by-two-columns-durable-cell-jobs",
            "official-provider-registry-keychain-readiness-and-revision-fence",
            "exact-quote-local-chunk-page-sources",
            "complete-regenerate-clear-failure-retry-cancel",
            "lease-expiry-restart-reconciliation",
            "project-auth-secret-path-export-and-restart-isolation",
            "multi-page-wire-list-and-project-filter",
            "single-runtime-single-pump-production-composition",
          ],
        },
        null,
        2,
      ),
    );
  } finally {
    if (current?.pump.snapshot().started) {
      await current.pump.stop().catch(() => undefined);
    }
    database?.close();
    rmSync(root, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
