import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  BlobIntegrity,
  BlobStore,
  StoredWorkspaceBlob,
  WorkspaceBlobDeleteReceipt,
  WorkspaceBlobLocator,
} from "../lib/workspace/blobStore";
import { WorkspaceDatabase } from "../lib/workspace/database";
import { WorkspaceApiError } from "../lib/workspace/errors";
import { INITIAL_WORKSPACE_MIGRATION } from "../lib/workspace/migrations/v1InitialWorkspace";
import { WORKSPACE_INTEGRITY_MIGRATION } from "../lib/workspace/migrations/v2WorkspaceIntegrity";
import { WORKSPACE_RUNTIME_MIGRATION } from "../lib/workspace/migrations/v3WorkspaceRuntime";
import { PROJECT_OWNERSHIP_MIGRATION } from "../lib/workspace/migrations/v4ProjectOwnership";
import { ASSISTANT_RUNTIME_MIGRATION } from "../lib/workspace/migrations/v5AssistantRuntime";
import { WORKFLOW_RUNTIME_V6_MIGRATION } from "../lib/workspace/migrations/v6WorkflowRuntime";
import { TABULAR_MIKE_SEMANTICS_V7_MIGRATION } from "../lib/workspace/migrations/v7TabularMikeSemantics";
import { MODEL_CREDENTIAL_ORIGIN_V8_MIGRATION } from "../lib/workspace/migrations/v8ModelCredentialOrigin";
import { WorkspaceBlobRecordsRepository } from "../lib/workspace/repositories/blobRecords";
import { WorkspaceDocumentsRepository } from "../lib/workspace/repositories/documents";
import { ProjectsRepository } from "../lib/workspace/repositories/projects";
import { WorkspaceDocumentsService } from "../lib/workspace/services/documents";
import { ProjectsService } from "../lib/workspace/services/projects";

const NOW = "2026-07-14T12:00:00.000Z";
const ALL_MIGRATIONS = [
  INITIAL_WORKSPACE_MIGRATION,
  WORKSPACE_INTEGRITY_MIGRATION,
  WORKSPACE_RUNTIME_MIGRATION,
  PROJECT_OWNERSHIP_MIGRATION,
  ASSISTANT_RUNTIME_MIGRATION,
  WORKFLOW_RUNTIME_V6_MIGRATION,
  TABULAR_MIKE_SEMANTICS_V7_MIGRATION,
  MODEL_CREDENTIAL_ORIGIN_V8_MIGRATION,
] as const;

function locatorKey(locator: WorkspaceBlobLocator) {
  return JSON.stringify(locator);
}

class AuditBlobStore implements BlobStore {
  readonly stored = new Map<string, Buffer>();
  readonly staged = new Map<
    string,
    { key: string; value: Buffer; receipt: WorkspaceBlobDeleteReceipt }
  >();
  stageCount = 0;
  onStage: ((locator: WorkspaceBlobLocator) => void) | null = null;

  putSync(
    locator: WorkspaceBlobLocator,
    plaintext: Buffer | string,
  ): StoredWorkspaceBlob {
    const value = Buffer.isBuffer(plaintext)
      ? Buffer.from(plaintext)
      : Buffer.from(plaintext, "utf8");
    this.stored.set(locatorKey(locator), value);
    return {
      locator,
      sha256: createHash("sha256").update(value).digest("hex"),
      size: value.length,
      storedSize: value.length,
    };
  }

  readSync(locator: WorkspaceBlobLocator, expected: BlobIntegrity) {
    const value = this.stored.get(locatorKey(locator));
    if (!value) throw new Error("Audit blob is missing.");
    assert.equal(value.length, expected.size);
    assert.equal(
      createHash("sha256").update(value).digest("hex"),
      expected.sha256,
    );
    return Buffer.from(value);
  }

  stageDeleteSync(locator: WorkspaceBlobLocator): WorkspaceBlobDeleteReceipt {
    this.stageCount += 1;
    this.onStage?.(locator);
    const key = locatorKey(locator);
    const value = this.stored.get(key);
    if (!value) throw new Error("Audit blob is missing before staging.");
    const receipt: WorkspaceBlobDeleteReceipt = {
      status: "staged",
      locator,
      quarantineId: randomUUID(),
    };
    this.stored.delete(key);
    this.staged.set(receipt.quarantineId, { key, value, receipt });
    return receipt;
  }

  restoreDeleteSync(receipt: WorkspaceBlobDeleteReceipt) {
    const pending = this.staged.get(receipt.quarantineId);
    if (!pending) throw new Error("Audit staged blob is missing.");
    this.staged.delete(receipt.quarantineId);
    this.stored.set(pending.key, pending.value);
  }

  finalizeDeleteSync(receipt: WorkspaceBlobDeleteReceipt) {
    if (!this.staged.delete(receipt.quarantineId)) {
      throw new Error("Audit staged blob is missing.");
    }
  }

  snapshot() {
    return {
      stored: [...this.stored.entries()]
        .map(([key, value]) => [key, value.toString("hex")])
        .sort(),
      staged: [...this.staged.keys()].sort(),
      stageCount: this.stageCount,
    };
  }
}

type Scenario = Readonly<{
  projectId: string;
  projectName: string;
  folderId: string;
  documentId: string;
  versionId: string;
}>;

function createProject(
  repository: ProjectsRepository,
  name: string,
) {
  return repository.create({
    id: randomUUID(),
    name,
    description: null,
    cmNumber: null,
    practice: null,
    now: NOW,
  });
}

function createScenario(
  database: WorkspaceDatabase,
  projects: ProjectsRepository,
  records: WorkspaceBlobRecordsRepository,
  blobs: AuditBlobStore,
  name: string,
): Scenario {
  const project = createProject(projects, name);
  const folder = projects.createFolder({
    id: randomUUID(),
    projectId: project.id,
    parentFolderId: null,
    name: `${name} folder`,
    now: NOW,
  });
  const documentId = randomUUID();
  const versionId = randomUUID();
  const value = Buffer.from(`history:${name}:${documentId}`, "utf8");
  const sha256 = createHash("sha256").update(value).digest("hex");
  database
    .prepare(
      `INSERT INTO documents
        (id, project_id, folder_id, title, filename, mime_type, size_bytes,
         parse_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'history.txt', 'text/plain', ?, 'ready', ?, ?)`,
    )
    .run(documentId, project.id, folder.id, name, value.length, NOW, NOW);
  const locator: WorkspaceBlobLocator = {
    kind: "original",
    documentId,
    versionId,
  };
  database
    .prepare(
      `INSERT INTO document_versions
        (id, document_id, version_number, source, filename, mime_type,
         size_bytes, content_sha256, storage_key, created_at)
       VALUES (?, ?, 1, 'upload', 'history.txt', 'text/plain', ?, ?, ?, ?)`,
    )
    .run(
      versionId,
      documentId,
      value.length,
      sha256,
      `documents/${documentId}/versions/${versionId}/original`,
      NOW,
    );
  database
    .prepare("UPDATE documents SET current_version_id = ? WHERE id = ?")
    .run(versionId, documentId);
  const stored = blobs.putSync(locator, value);
  records.registerStored({
    locator,
    contentSha256: stored.sha256,
    sizeBytes: stored.size,
    storedSizeBytes: stored.storedSize,
  });
  return {
    projectId: project.id,
    projectName: project.name,
    folderId: folder.id,
    documentId,
    versionId,
  };
}

function insertChatMessage(
  database: WorkspaceDatabase,
  scenario: Scenario,
  input: {
    role: "user" | "assistant";
    status: "pending" | "complete";
    jobId?: string | null;
  },
) {
  const chatId = randomUUID();
  const messageId = randomUUID();
  database
    .prepare(
      `INSERT INTO chats
        (id, project_id, scope, title, created_at, updated_at)
       VALUES (?, ?, 'project', 'History chat', ?, ?)`,
    )
    .run(chatId, scenario.projectId, NOW, NOW);
  database
    .prepare(
      `INSERT INTO chat_messages
        (id, chat_id, sequence, role, content, status, job_id,
         created_at, updated_at, completed_at)
       VALUES (?, ?, 0, ?, 'history', ?, ?, ?, ?, ?)`,
    )
    .run(
      messageId,
      chatId,
      input.role,
      input.status,
      input.jobId ?? null,
      NOW,
      NOW,
      input.status === "complete" ? NOW : null,
    );
  return { chatId, messageId };
}

function insertJob(
  database: WorkspaceDatabase,
  input: {
    id?: string;
    type: "assistant_generate" | "workflow_run";
    status: "queued" | "running";
    resourceType: "chat" | "workflow_run";
    resourceId: string;
  },
) {
  const id = input.id ?? randomUUID();
  database
    .prepare(
      `INSERT INTO jobs
        (id, type, status, resource_type, resource_id, attempt, max_attempts,
         retryable, payload_json, scheduled_at, queued_at, started_at,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 3, 1, '{}', ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.type,
      input.status,
      input.resourceType,
      input.resourceId,
      input.status === "running" ? 1 : 0,
      NOW,
      NOW,
      input.status === "running" ? NOW : null,
      NOW,
      NOW,
    );
  return id;
}

function databaseSnapshot(database: WorkspaceDatabase) {
  const count = (table: string) =>
    Number(
      database.prepare(`SELECT count(*) AS count FROM ${table}`).get()?.count ??
        0,
    );
  return {
    documents: database
      .prepare(
        `SELECT id, project_id, folder_id, current_version_id, deleted_at
           FROM documents ORDER BY id`,
      )
      .all(),
    versions: database
      .prepare(
        `SELECT id, document_id, deleted_at FROM document_versions ORDER BY id`,
      )
      .all(),
    folders: database
      .prepare(
        `SELECT id, project_id, parent_folder_id FROM project_subfolders ORDER BY id`,
      )
      .all(),
    blobs: database
      .prepare(
        `SELECT id, document_id, version_id, state, quarantine_id
           FROM workspace_blob_records ORDER BY id`,
      )
      .all(),
    jobs: database
      .prepare(
        `SELECT id, status, cancel_requested_at FROM jobs ORDER BY id`,
      )
      .all(),
    counts: {
      messageSources: count("message_sources"),
      attachments: count("chat_message_attachments"),
      assistantDocuments: count("assistant_generation_documents"),
      reviewDocuments: count("tabular_review_documents"),
      cells: count("tabular_cells"),
      tabularChatMessages: count("tabular_review_chat_messages"),
      edits: count("document_edits"),
    },
  };
}

function expectConflict(operation: () => unknown, reason: string) {
  assert.throws(
    operation,
    (error: unknown) =>
      error instanceof WorkspaceApiError &&
      error.status === 409 &&
      error.code === "CONFLICT" &&
      error.details?.some(
        (detail) => detail.path === "reason" && detail.message === reason,
      ) === true,
  );
}

function assertHistoryBlocksBoth(
  database: WorkspaceDatabase,
  blobs: AuditBlobStore,
  documents: WorkspaceDocumentsService,
  projects: ProjectsService,
  scenario: Scenario,
) {
  const beforeDatabase = databaseSnapshot(database);
  const beforeBlobs = blobs.snapshot();
  expectConflict(
    () => documents.deleteDocument(scenario.documentId),
    "document_has_durable_history",
  );
  expectConflict(
    () => projects.deleteFolder(scenario.folderId),
    "folder_has_durable_history",
  );
  assert.deepEqual(databaseSnapshot(database), beforeDatabase);
  assert.deepEqual(blobs.snapshot(), beforeBlobs);
}

function run() {
  const previousEncryption = process.env.ALETHEIA_DATABASE_ENCRYPTION;
  process.env.ALETHEIA_DATABASE_ENCRYPTION = "metadata_plaintext";
  const root = mkdtempSync(path.join(os.tmpdir(), "vera-deletion-history-"));
  let database: WorkspaceDatabase | null = null;
  try {
    database = new WorkspaceDatabase(path.join(root, "workspace.sqlite"), {
      migrations: ALL_MIGRATIONS,
    });
    assert.equal(database.migration?.currentVersion, 8);
    const blobs = new AuditBlobStore();
    const projectsRepository = new ProjectsRepository(database);
    const records = new WorkspaceBlobRecordsRepository(database);
    const documentsRepository = new WorkspaceDocumentsRepository(database, {
      blobRecords: records,
    });
    const lifecycle = {
      cancelQueued() {
        throw new Error("History fences must run before job cancellation.");
      },
      requestAbortRunning() {
        throw new Error("History fences must run before job abort.");
      },
    };
    const projects = new ProjectsService(projectsRepository, blobs, {
      resources: lifecycle,
      cleanupRecorder: { record() {} },
      clock: () => new Date(NOW),
    });
    const documents = new WorkspaceDocumentsService(
      documentsRepository,
      blobs,
      randomUUID,
      { record() {} },
      lifecycle,
    );

    const citation = createScenario(
      database,
      projectsRepository,
      records,
      blobs,
      "Completed citation",
    );
    const citationMessage = insertChatMessage(database, citation, {
      role: "assistant",
      status: "complete",
    });
    database
      .prepare(
        `INSERT INTO message_sources
          (id, message_id, document_id, version_id, locator_json, rank,
           citation_ordinal, citation_metadata_json, created_at)
         VALUES (?, ?, ?, ?, '{}', 0, 0, '{}', ?)`,
      )
      .run(
        randomUUID(),
        citationMessage.messageId,
        citation.documentId,
        citation.versionId,
        NOW,
      );
    assertHistoryBlocksBoth(database, blobs, documents, projects, citation);

    const attachment = createScenario(
      database,
      projectsRepository,
      records,
      blobs,
      "Completed attachment",
    );
    const attachmentMessage = insertChatMessage(database, attachment, {
      role: "user",
      status: "complete",
    });
    database
      .prepare(
        `INSERT INTO chat_message_attachments
          (id, message_id, ordinal, document_id, version_id,
           filename_snapshot, mime_type_snapshot, created_at)
         VALUES (?, ?, 0, ?, ?, 'history.txt', 'text/plain', ?)`,
      )
      .run(
        randomUUID(),
        attachmentMessage.messageId,
        attachment.documentId,
        attachment.versionId,
        NOW,
      );
    assertHistoryBlocksBoth(database, blobs, documents, projects, attachment);

    const review = createScenario(
      database,
      projectsRepository,
      records,
      blobs,
      "Completed tabular review",
    );
    const reviewId = randomUUID();
    const columnId = randomUUID();
    database
      .prepare(
        `INSERT INTO tabular_reviews
          (id, project_id, title, status, document_ids_json,
           columns_config_json, created_at, updated_at)
         VALUES (?, ?, 'Completed review', 'complete', ?, '[]', ?, ?)`,
      )
      .run(reviewId, review.projectId, JSON.stringify([review.documentId]), NOW, NOW);
    database
      .prepare(
        `INSERT INTO tabular_review_documents
          (review_id, document_id, ordinal, created_at)
         VALUES (?, ?, 0, ?)`,
      )
      .run(reviewId, review.documentId, NOW);
    database
      .prepare(
        `INSERT INTO tabular_review_columns
          (id, review_id, key, title, output_type, prompt, ordinal,
           created_at, updated_at)
         VALUES (?, ?, 'answer', 'Answer', 'text', '', 0, ?, ?)`,
      )
      .run(columnId, reviewId, NOW, NOW);
    database
      .prepare(
        `INSERT INTO tabular_cells
          (id, review_id, document_id, column_id, output_type, value_json,
           content, citations_json, status, attempt, created_at, updated_at,
           completed_at)
         VALUES (?, ?, ?, ?, 'text', '"Answer"', ?, ?, 'complete', 1, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        reviewId,
        review.documentId,
        columnId,
        JSON.stringify({ summary: "Answer", flag: "green" }),
        JSON.stringify([
          { documentId: review.documentId, versionId: review.versionId },
        ]),
        NOW,
        NOW,
        NOW,
      );
    assertHistoryBlocksBoth(database, blobs, documents, projects, review);

    const tabularSource = createScenario(
      database,
      projectsRepository,
      records,
      blobs,
      "Tabular chat source",
    );
    const sourceReviewId = randomUUID();
    const sourceChatId = randomUUID();
    database
      .prepare(
        `INSERT INTO tabular_reviews
          (id, project_id, title, status, document_ids_json,
           columns_config_json, created_at, updated_at)
         VALUES (?, ?, 'Source-only review', 'complete', '[]', '[]', ?, ?)`,
      )
      .run(sourceReviewId, tabularSource.projectId, NOW, NOW);
    database
      .prepare(
        `INSERT INTO tabular_review_chats
          (id, review_id, title, status, created_at, updated_at)
         VALUES (?, ?, 'Source chat', 'archived', ?, ?)`,
      )
      .run(sourceChatId, sourceReviewId, NOW, NOW);
    database
      .prepare(
        `INSERT INTO tabular_review_chat_messages
          (id, review_chat_id, sequence, role, content, annotations_json,
           sources_json, status, created_at, updated_at, completed_at)
         VALUES (?, ?, 0, 'assistant', 'history', '[]', ?, 'complete', ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        sourceChatId,
        JSON.stringify([
          {
            documentId: tabularSource.documentId,
            versionId: tabularSource.versionId,
          },
        ]),
        NOW,
        NOW,
        NOW,
      );
    assertHistoryBlocksBoth(
      database,
      blobs,
      documents,
      projects,
      tabularSource,
    );

    const assistant = createScenario(
      database,
      projectsRepository,
      records,
      blobs,
      "Active assistant",
    );
    const profileId = randomUUID();
    database
      .prepare(
        `INSERT INTO model_profiles
          (id, name, provider, model, credential_status, enabled,
           created_at, updated_at)
         VALUES (?, 'Audit model', 'openai', 'audit-model',
                 'not_configured', 1, ?, ?)`,
      )
      .run(profileId, NOW, NOW);
    const assistantChatId = randomUUID();
    const promptId = randomUUID();
    const outputId = randomUUID();
    const assistantJobId = randomUUID();
    database
      .prepare(
        `INSERT INTO chats
          (id, project_id, scope, title, created_at, updated_at)
         VALUES (?, ?, 'project', 'Active assistant', ?, ?)`,
      )
      .run(assistantChatId, assistant.projectId, NOW, NOW);
    insertJob(database, {
      id: assistantJobId,
      type: "assistant_generate",
      status: "queued",
      resourceType: "chat",
      resourceId: assistantChatId,
    });
    database
      .prepare(
        `INSERT INTO chat_messages
          (id, chat_id, sequence, role, content, status, created_at,
           updated_at, completed_at)
         VALUES (?, ?, 0, 'user', 'question', 'complete', ?, ?, ?)`,
      )
      .run(promptId, assistantChatId, NOW, NOW, NOW);
    database
      .prepare(
        `INSERT INTO chat_messages
          (id, chat_id, sequence, role, content, status, model_profile_id,
           job_id, created_at, updated_at)
         VALUES (?, ?, 1, 'assistant', '', 'pending', ?, ?, ?, ?)`,
      )
      .run(outputId, assistantChatId, profileId, assistantJobId, NOW, NOW);
    database
      .prepare(
        `INSERT INTO assistant_generation_snapshots
          (job_id, chat_id, prompt_message_id, output_message_id,
           model_profile_id, current_version_only, retrieval_limit, created_at)
         VALUES (?, ?, ?, ?, ?, 1, 10, ?)`,
      )
      .run(
        assistantJobId,
        assistantChatId,
        promptId,
        outputId,
        profileId,
        NOW,
      );
    database
      .prepare(
        `INSERT INTO assistant_generation_documents
          (job_id, ordinal, document_id, version_id, attached)
         VALUES (?, 0, ?, ?, 0)`,
      )
      .run(assistantJobId, assistant.documentId, assistant.versionId);
    assertHistoryBlocksBoth(database, blobs, documents, projects, assistant);

    const assistantUnrelated = createScenario(
      database,
      projectsRepository,
      records,
      blobs,
      "Assistant-unrelated document",
    );
    documentsRepository.moveDocument(
      assistantUnrelated.documentId,
      assistant.projectId,
      null,
    );
    documents.deleteDocument(assistantUnrelated.documentId);
    assert.equal(
      documentsRepository.getDocument(assistantUnrelated.documentId),
      null,
    );

    const workflow = createScenario(
      database,
      projectsRepository,
      records,
      blobs,
      "Active workflow",
    );
    const workflowId = randomUUID();
    const workflowRunId = randomUUID();
    database
      .prepare(
        `INSERT INTO workflows
          (id, type, project_id, title, created_at, updated_at)
         VALUES (?, 'assistant', ?, 'Active workflow', ?, ?)`,
      )
      .run(workflowId, workflow.projectId, NOW, NOW);
    database
      .prepare(
        `INSERT INTO workflow_runs
          (id, workflow_id, project_id, status, input_json, started_at,
           created_at, updated_at)
         VALUES (?, ?, ?, 'running', '{}', ?, ?, ?)`,
      )
      .run(workflowRunId, workflowId, workflow.projectId, NOW, NOW, NOW);
    const workflowBefore = databaseSnapshot(database);
    const workflowBlobsBefore = blobs.snapshot();
    expectConflict(
      () => documents.deleteDocument(workflow.documentId),
      "document_has_active_workflow",
    );
    expectConflict(
      () => projects.deleteFolder(workflow.folderId),
      "folder_has_active_workflow",
    );
    assert.deepEqual(databaseSnapshot(database), workflowBefore);
    assert.deepEqual(blobs.snapshot(), workflowBlobsBefore);

    const plainDocument = createScenario(
      database,
      projectsRepository,
      records,
      blobs,
      "Plain document",
    );
    const plainDeleted = documents.deleteDocument(plainDocument.documentId);
    assert.equal(plainDeleted.documentId, plainDocument.documentId);
    assert.equal(documentsRepository.getDocument(plainDocument.documentId), null);

    const plainFolder = createScenario(
      database,
      projectsRepository,
      records,
      blobs,
      "Plain folder",
    );
    projects.deleteFolder(plainFolder.folderId);
    assert.equal(projectsRepository.getFolder(plainFolder.folderId), null);

    const projectOwnedHistory = createScenario(
      database,
      projectsRepository,
      records,
      blobs,
      "Project ownership boundary",
    );
    const projectMessage = insertChatMessage(database, projectOwnedHistory, {
      role: "assistant",
      status: "complete",
    });
    database
      .prepare(
        `INSERT INTO message_sources
          (id, message_id, document_id, version_id, locator_json, rank,
           citation_ordinal, citation_metadata_json, created_at)
         VALUES (?, ?, ?, ?, '{}', 0, 0, '{}', ?)`,
      )
      .run(
        randomUUID(),
        projectMessage.messageId,
        projectOwnedHistory.documentId,
        projectOwnedHistory.versionId,
        NOW,
      );
    projects.permanentlyDelete(
      projectOwnedHistory.projectId,
      projectOwnedHistory.projectName,
    );
    assert.equal(projectsRepository.get(projectOwnedHistory.projectId), null);

    const raced = createScenario(
      database,
      projectsRepository,
      records,
      blobs,
      "Final transaction race",
    );
    let injected = false;
    blobs.onStage = (locator) => {
      if (
        injected ||
        locator.kind === "export" ||
        locator.documentId !== raced.documentId
      ) {
        return;
      }
      injected = true;
      database!
        .prepare(
          `INSERT INTO document_edits
            (id, document_id, version_id, change_id, deleted_text,
             inserted_text, status, created_at, resolved_at)
           VALUES (?, ?, ?, 'race', '', 'history', 'accepted', ?, ?)`,
        )
        .run(randomUUID(), raced.documentId, raced.versionId, NOW, NOW);
    };
    expectConflict(
      () => documents.deleteDocument(raced.documentId),
      "document_has_durable_history",
    );
    blobs.onStage = null;
    assert.equal(injected, true);
    assert.ok(documentsRepository.getDocument(raced.documentId));
    assert.equal(blobs.staged.size, 0);
    assert.equal(
      records.listForDocument(raced.documentId).every((record) => record.state === "stored"),
      true,
    );

    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(database.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
    console.log(
      "Vera deletion-history audit passed: exact durable citations, attachments, assistant snapshots, tabular memberships/cells/chat sources, active workflow fencing, pre-stage zero-change rejection, transaction race rollback, plain deletion, and project ownership-boundary purge verified.",
    );
  } finally {
    try {
      database?.close();
    } catch {
      // Best-effort audit cleanup.
    }
    rmSync(root, { recursive: true, force: true });
    if (previousEncryption === undefined) {
      delete process.env.ALETHEIA_DATABASE_ENCRYPTION;
    } else {
      process.env.ALETHEIA_DATABASE_ENCRYPTION = previousEncryption;
    }
  }
}

run();
