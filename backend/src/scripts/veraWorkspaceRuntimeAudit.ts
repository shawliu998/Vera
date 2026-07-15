import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { WorkspaceApiError } from "../lib/workspace/errors";
import { WORKSPACE_LOCAL_PRINCIPAL_ID } from "../lib/workspace/principal";
import { WorkspaceRuntime } from "../lib/workspace/runtime";
import { ProjectsService } from "../lib/workspace/services/projects";
import {
  parseMikeWorkflowCreate,
  parseMikeWorkflowUpdate,
} from "../lib/workspace/workflowCompatibility";

const id = "11111111-1111-4111-8111-111111111111";
const versionId = "22222222-2222-4222-8222-222222222222";
const oldVersionId = "99999999-9999-4999-8999-999999999999";
const otherProjectId = "33333333-3333-4333-8333-333333333333";
const foreignDocumentId = "44444444-4444-4444-8444-444444444444";
const now = "2026-07-14T00:00:00.000Z";

function dependencies(
  events: string[],
  fail?: "migrate" | "seed" | "cleanup" | "reconcile" | "pump",
) {
  const database = {
    close: () => events.push("close"),
    exec() {},
    prepare() {
      return {
        get() {
          return {};
        },
        all() {
          return [];
        },
        run() {
          return {};
        },
      };
    },
  };
  const document = {
    id,
    projectId: id,
    folderId: null,
    filename: "source.pdf",
    mimeType: "application/pdf",
    sizeBytes: 2,
    status: "processing",
    currentVersionId: versionId,
    createdAt: now,
    updatedAt: now,
  };
  const foreignDocument = {
    ...document,
    id: foreignDocumentId,
    projectId: otherProjectId,
  };
  const version = {
    id: versionId,
    versionNumber: 1,
    source: "upload",
    filename: "source.pdf",
    mimeType: "application/pdf",
    sizeBytes: 2,
    pageCount: 1,
    createdAt: now,
  };
  const oldVersion = {
    ...version,
    id: oldVersionId,
    versionNumber: 1,
  };
  const parseJob = {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    type: "document_parse" as const,
    status: "queued" as const,
    resourceType: "document" as const,
    resourceId: id,
    attempt: 1,
    maxAttempts: 3,
    retryable: true,
    createdAt: now,
    scheduledAt: now,
    startedAt: null,
    completedAt: null,
  };
  let lastProjectInput: Record<string, unknown> | null = null;
  let lastProjectPage: { cursor?: string | null; limit?: number } | null = null;
  let lastDocumentList: { limit?: number } | null = null;
  const projects = {
    list: (page: { cursor?: string | null; limit?: number }) => {
      lastProjectPage = page;
      if (page.cursor === "next-project-page") {
        return { items: [], nextCursor: null };
      }
      return {
        items: [
          {
            id,
            name: "Workspace",
            cmNumber: null,
            practice: null,
            createdAt: now,
            updatedAt: now,
            documentCount: 1,
            chatCount: 0,
            reviewCount: 0,
          },
        ],
        nextCursor: "next-project-page",
      };
    },
    create: (input: Record<string, unknown>) => {
      lastProjectInput = input;
      return {
        id,
        name: "Workspace",
        description: input.description ?? null,
        cmNumber: null,
        practice: null,
        createdAt: now,
        updatedAt: now,
      };
    },
    get: (projectId: string) => {
      if (projectId !== id) throw new Error("not found");
      return {
        id,
        name: "Workspace",
        cmNumber: null,
        practice: null,
        createdAt: now,
        updatedAt: now,
      };
    },
    overview: () => ({
      id,
      name: "Workspace",
      description: lastProjectInput?.description ?? "Local workspace",
      cmNumber: null,
      practice: null,
      createdAt: now,
      updatedAt: now,
      folders: [
        {
          id: "55555555-5555-4555-8555-555555555555",
          projectId: id,
          name: "Evidence",
          parentFolderId: null,
          createdAt: now,
          updatedAt: now,
        },
      ],
      documentCount: 1,
      chatCount: 0,
      reviewCount: 0,
    }),
    update: (projectId: string, input: Record<string, unknown>) => {
      lastProjectInput = input;
      return {
        id: projectId,
        name: "Workspace",
        description: input.description ?? null,
        cmNumber: null,
        practice: null,
        createdAt: now,
        updatedAt: now,
      };
    },
    archive: () => ({
      id,
      name: "Workspace",
      cmNumber: null,
      practice: null,
      createdAt: now,
      updatedAt: now,
    }),
    unarchive: () => ({
      id,
      name: "Workspace",
      cmNumber: null,
      practice: null,
      createdAt: now,
      updatedAt: now,
    }),
    permanentlyDelete() {},
    listFolders: () => [],
    getFolder() {
      throw new Error("not found");
    },
    createFolder() {},
    updateFolder() {},
    deleteFolder() {},
  };
  const documents = {
    list: (input: { limit?: number }) => {
      lastDocumentList = input;
      return [document];
    },
    get: (documentId: string) => ({
      document: documentId === foreignDocumentId ? foreignDocument : document,
      versions: [oldVersion, version],
    }),
    listVersions: () => [oldVersion, version],
    getVersion: (_documentId: string, requestedVersionId: string) =>
      requestedVersionId === oldVersionId ? oldVersion : version,
    attach: () => document,
    rename: () => document,
    move: () => document,
    uploadVersion: async () => ({ document, version, job: parseJob }),
    retryParse: () => parseJob,
    readOriginal: () => ({
      documentId: id,
      versionId,
      filename: "source.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("original PDF bytes"),
      contentLength: 2,
    }),
    issueCapability: () => ({
      url: "/api/v1/downloads/vdl_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    }),
    readCapability: () => ({
      filename: "source.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("ok"),
      contentLength: 2,
    }),
  };
  let pumpStarted = false;
  let pumpStopping = false;
  const pump = {
    async start() {
      events.push("pump");
      if (fail === "pump") throw new Error("pump");
      pumpStarted = true;
      return {};
    },
    async stop() {
      events.push("stop-pump");
      pumpStopping = true;
      pumpStarted = false;
      return {};
    },
    snapshot() {
      return { started: pumpStarted, stopping: pumpStopping };
    },
  };
  const extracted = Buffer.from("authoritative extracted text");
  const extractedHash = createHash("sha256").update(extracted).digest("hex");
  const documentService = {
    upload: async () => ({ document, version, job: parseJob }),
  };
  return {
    database: database as any,
    blobs: {
      listStagedDeletesSync: () => [],
      readSync: () => extracted,
    } as any,
    blobRecords: {
      getByLocator: (locator: unknown) => ({
        id: "66666666-6666-4666-8666-666666666666",
        locator,
        contentSha256: extractedHash,
        sizeBytes: extracted.byteLength,
        storedSizeBytes: extracted.byteLength,
        state: "stored",
        quarantineId: null,
        createdAt: now,
        updatedAt: now,
      }),
    } as any,
    projects: projects as any,
    documents: documents as any,
    documentService: documentService as any,
    documentRepository: {
      getVersion: (_documentId: string, requestedVersionId: string) =>
        requestedVersionId === oldVersionId ? oldVersion : version,
    } as any,
    pump: pump as any,
    abortRegistry: {
      abortAll() {
        events.push("abort");
      },
    } as any,
    runMigrations: () => {
      events.push("migrate");
      if (fail === "migrate") throw new Error("migrate");
    },
    seedWorkflows: () => {
      events.push("seed");
      if (fail === "seed") throw new Error("seed");
      return Array.from({ length: 21 }, () => ({}));
    },
    cleanupReplay: {
      replayPending() {
        events.push("cleanup");
        if (fail === "cleanup") throw new Error("cleanup");
        return { resolved: 0, restored: 0, finalized: 0, retained: 0 };
      },
    },
    blobReconciliation: {
      reconcile() {
        events.push("reconcile");
        if (fail === "reconcile") throw new Error("reconcile");
        return { restored: 0, finalized: 0, conflicts: 0 };
      },
    },
    audit: {
      projectPage: () => lastProjectPage,
      documentList: () => lastDocumentList,
    },
  };
}

async function auditProductionWorkflowCrud() {
  const dataDir = mkdtempSync(
    path.join(os.tmpdir(), "vera-workspace-runtime-workflows-"),
  );
  const originalEncryption = process.env.ALETHEIA_DATABASE_ENCRYPTION;
  process.env.ALETHEIA_DATABASE_ENCRYPTION = "metadata_plaintext";
  const runtime = new WorkspaceRuntime({
    dataDir,
    // This audit exercises workflow composition only; no document/blob data is
    // introduced, so a strict empty staged-delete authority is sufficient.
    blobs: { listStagedDeletesSync: () => [] } as any,
  });
  const context = { principalId: WORKSPACE_LOCAL_PRINCIPAL_ID };
  try {
    await runtime.start();
    const system = await runtime.workflowCrud.list(context, {});
    assert.equal(system.length, 21, "startup seeds all fixed Mike templates");
    assert.ok(system.every((workflow) => workflow.is_system));

    const custom = await runtime.workflowCrud.create(
      context,
      parseMikeWorkflowCreate({
        metadata: { title: "Runtime CRUD custom", type: "assistant" },
        skill_md: "Summarize selected documents.",
      }),
    );
    const updated = await runtime.workflowCrud.update(
      context,
      custom.id,
      parseMikeWorkflowUpdate({ skill_md: "Revise the summary." }),
    );
    assert.equal(updated.skill_md, "Revise the summary.");
    await runtime.workflowCrud.delete(context, custom.id);
    await assert.rejects(
      runtime.workflowCrud.get(context, custom.id),
      (error: unknown) =>
        error instanceof WorkspaceApiError && error.status === 404,
    );

    const systemId = system[0]?.id;
    assert.ok(systemId);
    await runtime.workflowCrud.hide(context, systemId);
    assert.ok(
      (await runtime.workflowCrud.list(context, {})).some(
        (workflow) => workflow.id === systemId,
      ),
      "hidden system templates remain in the Mike list response",
    );
    assert.ok(
      (await runtime.workflowCrud.listHidden(context)).includes(systemId),
    );
    await runtime.workflowCrud.unhide(context, systemId);
    await assert.rejects(
      runtime.workflowCrud.update(
        context,
        systemId,
        parseMikeWorkflowUpdate({ skill_md: "not allowed" }),
      ),
      (error: unknown) =>
        error instanceof WorkspaceApiError && error.status === 403,
    );
  } finally {
    await runtime.stop();
    rmSync(dataDir, { recursive: true, force: true });
    if (originalEncryption === undefined) {
      delete process.env.ALETHEIA_DATABASE_ENCRYPTION;
    } else {
      process.env.ALETHEIA_DATABASE_ENCRYPTION = originalEncryption;
    }
  }
}

async function run() {
  const runtimeSource = readFileSync(
    path.resolve(__dirname, "../lib/workspace/runtime.ts"),
    "utf8",
  );
  assert.match(
    runtimeSource,
    /new WorkspaceDocumentsService\([\s\S]*?cleanupRecorder,\s*lifecycle,\s*\)/,
    "the production document service must receive the shared job lifecycle coordinator",
  );
  assert.match(
    runtimeSource,
    /new WorkflowsService\([\s\S]*?new WorkspaceJobEnqueuerAdapter\(this\.jobs\)/,
    "workflow CRUD reuses the shared Jobs enqueue adapter",
  );
  assert.match(
    runtimeSource,
    /new WorkspaceBlobStartupRecovery\(cleanupReplay, blobReconciliation\)/,
    "composition reuses the established cleanup-then-reconciliation coordinator",
  );
  assert.match(
    runtimeSource,
    /else this\.database\.runMigrations\(\);/,
    "the default startup path reruns migrations through the trusted WorkspaceDatabase entrypoint",
  );
  assert.doesNotMatch(
    runtimeSource,
    /runWorkspaceMigrations\(this\.database,\s*WORKSPACE_MIGRATIONS\)/,
    "runtime must not pass the outer WorkspaceDatabase wrapper directly to the raw migration runner",
  );
  assert.match(
    runtimeSource,
    /this\.startupRecovery\.recover\(\);[\s\S]*?await this\.pump\.start\(\);/,
    "recovery completes before workers start",
  );
  assert.match(
    runtimeSource,
    /document_parse: \(context\) => parser\.handleJob\(context\)[\s\S]*?assistant_generate: \(context\)/,
    "the production pump registers both fenced document and Assistant handlers",
  );
  await auditProductionWorkflowCrud();
  let cascaded = false;
  let restored = false;
  const deletionProbe = new ProjectsService(
    {
      assertPermanentDelete() {},
      projectDeletionPlan() {
        return {
          activeJobs: [],
          blobs: [
            {
              recordId: "77777777-7777-4777-8777-777777777777",
              locator: { kind: "original", documentId: id, versionId },
            },
          ],
        };
      },
      deleteProjectCascade() {
        cascaded = true;
      },
    } as any,
    {
      stageDeleteSync(locator: unknown) {
        return {
          status: "staged" as const,
          locator,
          quarantineId: "88888888-8888-4888-8888-888888888888",
        } as any;
      },
      restoreDeleteSync() {
        restored = true;
      },
    } as any,
    {
      resources: {
        cancelQueued() {},
        requestAbortRunning() {},
      },
      cleanupRecorder: {
        record() {
          throw new Error("ledger unavailable");
        },
      },
    },
  );
  assert.throws(
    () => deletionProbe.permanentlyDelete(id, "Workspace"),
    /cleanup is pending/,
    "a cleanup intent must be durable before the project cascade",
  );
  assert.equal(
    cascaded,
    false,
    "a failed pre-commit cleanup record leaves DB rows intact",
  );
  assert.equal(
    restored,
    true,
    "a failed pre-commit cleanup record restores staged blobs",
  );

  const events: string[] = [];
  const runtimeDependencies = dependencies(events);
  const runtime = new WorkspaceRuntime(runtimeDependencies);
  const context = { principalId: "00000000-0000-4000-8000-000000000001" };
  await assert.rejects(
    () => runtime.getProject(context, id),
    /not accepting requests/,
    "the facade cannot query repositories before migrations and recovery complete",
  );
  await runtime.start();
  assert.deepEqual(
    events.slice(0, 5),
    ["migrate", "seed", "cleanup", "reconcile", "pump"],
    "startup is fail-closed and ordered",
  );
  assert.equal(
    events.filter((event) => event === "migrate").length,
    1,
    "an injected migration is never followed by the production migration",
  );
  const project = await runtime.getProject(context, id);
  assert.equal(
    (project as any).user_id,
    context.principalId,
    "Mike project wire is local and path-free",
  );
  assert.equal(
    (project as any).documents.length,
    1,
    "project detail has real documents",
  );
  assert.equal(
    (project as any).folders.length,
    1,
    "project detail has real folders",
  );
  assert.equal(
    (project as any).document_count,
    1,
    "project detail preserves durable counts",
  );
  assert.equal(
    (project as any).description,
    "Local workspace",
    "project detail retains its domain description",
  );
  const createdProject = await runtime.createProject(context, {
    name: "Workspace",
    description: "Retained local description",
  });
  assert.equal(
    (createdProject as any).description,
    "Retained local description",
    "project create forwards description without silently dropping it",
  );
  const updatedProject = await runtime.updateProject(context, id, {
    description: "Updated local description",
  });
  assert.equal(
    (updatedProject as any).description,
    "Updated local description",
    "project update forwards description without silently dropping it",
  );
  const projectsPage = await runtime.listProjects(context, { limit: 1 });
  assert.equal(
    (projectsPage as any).next_cursor,
    "next-project-page",
    "project pagination preserves the repository cursor",
  );
  assert.equal(
    runtimeDependencies.audit.projectPage()?.limit,
    1,
    "project list forwards page bounds",
  );
  const mikeProjects = await runtime.listProjects(context, {});
  assert.equal(
    Array.isArray(mikeProjects),
    true,
    "an unpaged Mike project request preserves the upstream Project[] shape",
  );
  assert.equal((mikeProjects as any[]).length, 1);
  await runtime.listDocuments(context, { standalone: false, limit: 1 });
  assert.equal(
    runtimeDependencies.audit.documentList()?.limit,
    1,
    "document list forwards its bounded limit",
  );
  await assert.rejects(
    () =>
      runtime.listDocuments(context, { standalone: false, cursor: "cursor" }),
    /cursor pagination is not available/,
    "document lists reject unsupported cursors instead of pretending to paginate",
  );
  await assert.rejects(
    () => runtime.listProjectDocuments(context, id, { cursor: "cursor" }),
    /cursor pagination is not available/,
    "project document lists reject unsupported cursors too",
  );
  const uploaded = await runtime.uploadDocument(context, {
    filename: "source.pdf",
    mimetype: "application/pdf",
    buffer: Buffer.from("PDF"),
    projectId: id,
    folderId: null,
  });
  assert.equal(
    (uploaded as any).job.id,
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "upload returns the durable parse job id",
  );
  assert.equal((uploaded as any).job.status, "queued");
  assert.equal((uploaded as any).version.id, versionId);
  const uploadedVersion = await runtime.uploadDocumentVersion(
    context,
    id,
    {
      filename: "source.pdf",
      mimetype: "application/pdf",
      buffer: Buffer.from("PDF"),
    },
    { projectId: id },
  );
  assert.equal(
    (uploadedVersion as any).job.id,
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "version upload returns its durable parse job",
  );
  const retry = await runtime.retryDocumentParse(context, id, {
    projectId: id,
  });
  assert.equal(
    (retry as any)?.job.id,
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "retry returns the newly queued parse job rather than only a document",
  );
  const extracted = await runtime.readDocument(context, id);
  assert.equal(
    (extracted as any).content,
    "authoritative extracted text",
    "read serves verified derived text, never the original binary",
  );
  const oldExtracted = await runtime.readDocument(context, id, oldVersionId);
  assert.equal(
    (oldExtracted as any).version_id,
    oldVersionId,
    "a ready old version remains readable while the current version is processing",
  );
  await assert.rejects(
    () => runtime.attachProjectDocument(context, id, foreignDocumentId),
    /another project/,
    "attaching a document cannot silently move it across projects",
  );
  const noExtractedEvents: string[] = [];
  const noExtracted = dependencies(noExtractedEvents);
  noExtracted.blobRecords = { getByLocator: () => null } as any;
  const noExtractedRuntime = new WorkspaceRuntime(noExtracted);
  await noExtractedRuntime.start();
  await assert.rejects(
    () => noExtractedRuntime.readDocument(context, id),
    /Extracted text is not available/,
    "read rejects instead of treating original bytes as extracted text",
  );
  await noExtractedRuntime.stop();
  assert.equal(
    runtime.health().worker.documentParse,
    true,
    "health reflects the live pump",
  );
  await assert.rejects(
    () => runtime.getProject({ principalId: versionId }, id),
    /local-only/,
  );
  const capability = await runtime.getDocumentDownload(context, id);
  assert.equal(capability.url.startsWith("/api/v1/downloads/"), true);
  const resolved = await runtime.resolveDownload(
    context,
    capability.url.split("/").at(-1) as string,
  );
  assert.equal(
    resolved.disposition,
    "attachment",
    "capability is resolved again before bytes are returned",
  );
  const issued = runtime.capabilities.issue({
    documentId: id,
    versionId,
    purpose: "download",
  });
  await runtime.stop();
  await runtime.stop();
  assert.equal(
    runtime.capabilities.resolve(issued.token),
    null,
    "stop clears in-memory download capabilities",
  );
  assert.equal(
    events.filter((event) => event === "close").length,
    1,
    "stop closes the single DB exactly once",
  );

  const timedOutEvents: string[] = [];
  const timedOutDependencies = dependencies(timedOutEvents);
  timedOutDependencies.pump.stop = async () => {
    timedOutEvents.push("stop-pump");
    return { drained: false } as any;
  };
  const timedOutRuntime = new WorkspaceRuntime(timedOutDependencies);
  await timedOutRuntime.start();
  await assert.rejects(
    () => timedOutRuntime.stop(),
    /did not drain/,
    "a bounded pump timeout is surfaced instead of being reported as a clean shutdown",
  );
  assert.equal(
    timedOutEvents.filter((event) => event === "close").length,
    1,
    "a timed-out pump still closes the workspace database exactly once",
  );

  const migrationFailureEvents: string[] = [];
  const migrationFailure = new WorkspaceRuntime(
    dependencies(migrationFailureEvents, "migrate"),
  );
  await assert.rejects(() => migrationFailure.start(), /migrate/);
  assert.deepEqual(
    migrationFailureEvents,
    ["migrate", "stop-pump", "abort", "close"],
    "a migration failure closes fail-closed before seed, recovery, or workers",
  );
  assert.deepEqual(
    migrationFailure.health(),
    {
      started: false,
      draining: false,
      worker: {
        documentParse: false,
        assistantGenerate: false,
        tabularCell: false,
      },
    },
    "a migration failure never reports a usable runtime health state",
  );

  const pumpFailureEvents: string[] = [];
  const pumpFailure = new WorkspaceRuntime(
    dependencies(pumpFailureEvents, "pump"),
  );
  await assert.rejects(() => pumpFailure.start(), /pump/);
  assert.deepEqual(
    pumpFailureEvents,
    [
      "migrate",
      "seed",
      "cleanup",
      "reconcile",
      "pump",
      "stop-pump",
      "abort",
      "close",
    ],
    "a pump-start failure runs recovery first, then aborts and closes in catch",
  );
  assert.deepEqual(
    pumpFailure.health(),
    {
      started: false,
      draining: false,
      worker: {
        documentParse: false,
        assistantGenerate: false,
        tabularCell: false,
      },
    },
    "a failed pump start is never observable as a started runtime",
  );

  for (const failure of ["seed", "cleanup", "reconcile"] as const) {
    const failedEvents: string[] = [];
    const failed = new WorkspaceRuntime(dependencies(failedEvents, failure));
    await assert.rejects(() => failed.start());
    assert.equal(
      failedEvents.includes("pump"),
      false,
      `${failure} failure never starts the pump`,
    );
    assert.equal(
      failedEvents.filter((event) => event === "close").length,
      1,
      `${failure} failure closes the one database handle`,
    );
  }
  console.log("vera workspace runtime audit passed");
}

void run();
