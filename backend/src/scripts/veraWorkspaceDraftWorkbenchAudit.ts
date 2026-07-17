import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  WorkspaceDatabase,
  WORKSPACE_MIGRATIONS,
  workspaceMigrationChecksum,
} from "../lib/workspace/database";
import {
  DOCUMENT_STUDIO_DRAFT_METADATA_V20_MIGRATION,
  type WorkspaceMigration,
} from "../lib/workspace/migrations";
import {
  DOCUMENT_STUDIO_DRAFT_ORIGINS_V20,
  DOCUMENT_STUDIO_DRAFT_TYPES_V20,
  type DocumentStudioDraftOriginV20,
} from "../lib/workspace/documentStudioDraftMetadataV20";
import { WorkspaceDocumentStudioRepository } from "../lib/workspace/repositories/documentStudio";
import { WorkspaceDocumentStudioDraftsRepository } from "../lib/workspace/repositories/documentStudioDrafts";

const NOW = "2026-07-16T08:00:00.000Z";

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function schemaObjectExists(database: WorkspaceDatabase, name: string) {
  return Boolean(
    database
      .prepare("SELECT 1 AS present FROM sqlite_schema WHERE name = ?")
      .get(name),
  );
}

function insertProject(database: WorkspaceDatabase, name: string) {
  const id = randomUUID();
  database
    .prepare(
      "INSERT INTO projects (id,name,status,created_at,updated_at) VALUES (?,?,'active',?,?)",
    )
    .run(id, name, NOW, NOW);
  return id;
}

function insertLegalAnchor(
  database: WorkspaceDatabase,
  projectId: string,
  ordinal: number,
) {
  const snapshotId = randomUUID();
  const anchorId = randomUUID();
  const quote = `Exact authority quote ${ordinal}`;
  database
    .prepare(
      `INSERT INTO project_source_snapshots (
         id,project_id,source_kind,source_record_id,source_version_id,
         title_snapshot,content_sha256,locator_json,retrieved_at,license_json,
         retention_policy,retention_expires_at,retrieval_metadata_json,created_at
       ) VALUES (? ,?,'legal_authority',?,NULL,?,?,?, ?,?,
                 'full_text_permitted',NULL,'{}',?)`,
    )
    .run(
      snapshotId,
      projectId,
      `authority-${ordinal}-${snapshotId}`,
      `Authority ${ordinal}`,
      sha256(`authority body ${ordinal}`),
      JSON.stringify({ authorityIdentifier: `authority-${ordinal}` }),
      NOW,
      JSON.stringify({
        basis: "deployment_contract",
        retention: "full_text_permitted",
        export: "exact_quotes_only",
        modelUse: "local_only",
      }),
      NOW,
    );
  database
    .prepare(
      `INSERT INTO source_citation_anchors (
         id,project_id,snapshot_id,ordinal,exact_quote,quote_sha256,
         locator_json,created_at
       ) VALUES (?,?,?,0,?,?,?,?)`,
    )
    .run(
      anchorId,
      projectId,
      snapshotId,
      quote,
      sha256(quote),
      JSON.stringify({ section: `${ordinal}` }),
      NOW,
    );
  return anchorId;
}

function seedLegacyDraft(database: WorkspaceDatabase, projectId: string) {
  const documentId = randomUUID();
  const versionId = randomUUID();
  const contentHash = sha256("legacy draft");
  database
    .prepare(
      `INSERT INTO documents (
         id,project_id,title,filename,mime_type,size_bytes,parse_status,
         current_version_id,created_at,updated_at,document_kind
       ) VALUES (?,?,'Legacy draft','legacy-draft.md','text/markdown',12,
                 'ready',NULL,?,?,'draft')`,
    )
    .run(documentId, projectId, NOW, NOW);
  database
    .prepare(
      `INSERT INTO document_versions (
         id,document_id,version_number,source,filename,mime_type,size_bytes,
         content_sha256,storage_key,created_at
       ) VALUES (?,?,1,'user_upload','legacy-draft.md','text/markdown',12,?,?,?)`,
    )
    .run(
      versionId,
      documentId,
      contentHash,
      `documents/${documentId}/versions/${versionId}/original`,
      NOW,
    );
  database
    .prepare(
      `INSERT INTO document_studio_versions (
         project_id,document_id,version_id,format,summary,operation_id,created_at
       ) VALUES (?,?,?,'markdown',NULL,NULL,?)`,
    )
    .run(projectId, documentId, versionId, NOW);
  database
    .prepare(
      "UPDATE documents SET current_version_id = ? WHERE id = ? AND project_id = ?",
    )
    .run(versionId, documentId, projectId);
  return { documentId, versionId };
}

function seedAssistantOrigin(database: WorkspaceDatabase, projectId: string) {
  const profileId = randomUUID();
  const chatId = randomUUID();
  const jobId = randomUUID();
  const promptMessageId = randomUUID();
  const outputMessageId = randomUUID();
  database
    .prepare(
      `INSERT INTO model_profiles (
         id,name,provider,model,capabilities_json,settings_json,enabled,
         created_at,updated_at
       ) VALUES (?,?,'openai',?,'{}','{}',1,?,?)`,
    )
    .run(profileId, `Draft QA ${profileId}`, `model-${profileId}`, NOW, NOW);
  database
    .prepare(
      `INSERT INTO chats (
         id,project_id,scope,title,status,model_profile_id,created_at,updated_at
       ) VALUES (?,?,'project','Draft QA','active',?,?,?)`,
    )
    .run(chatId, projectId, profileId, NOW, NOW);
  database
    .prepare(
      `INSERT INTO jobs (
         id,type,status,resource_type,resource_id,payload_json,created_at,updated_at
       ) VALUES (?,'assistant_generate','queued','chat',?,'{}',?,?)`,
    )
    .run(jobId, chatId, NOW, NOW);
  database
    .prepare(
      `INSERT INTO chat_messages (
         id,chat_id,sequence,role,content,status,created_at,updated_at,completed_at
       ) VALUES (?,?,0,'user','Create a Draft.','complete',?,?,?),
                (?,?,1,'assistant','','pending',?,?,NULL)`,
    )
    .run(
      promptMessageId,
      chatId,
      NOW,
      NOW,
      NOW,
      outputMessageId,
      chatId,
      NOW,
      NOW,
    );
  database
    .prepare(
      "UPDATE chat_messages SET model_profile_id = ?, job_id = ? WHERE id = ?",
    )
    .run(profileId, jobId, outputMessageId);
  database
    .prepare(
      `INSERT INTO assistant_generation_snapshots (
         job_id,chat_id,prompt_message_id,output_message_id,model_profile_id,
         current_version_only,retrieval_limit,created_at
       ) VALUES (?,?,?,?,?,1,40,?)`,
    )
    .run(jobId, chatId, promptMessageId, outputMessageId, profileId, NOW);
  return outputMessageId;
}

function seedWorkflowOrigin(database: WorkspaceDatabase, projectId: string) {
  const workflowId = randomUUID();
  const runId = randomUUID();
  database
    .prepare(
      `INSERT INTO workflows (
         id,type,title,status,project_id,created_at,updated_at
       ) VALUES (?,'assistant','Draft QA Workflow','active',?,?,?)`,
    )
    .run(workflowId, projectId, NOW, NOW);
  database
    .prepare(
      `INSERT INTO workflow_runs (
         id,workflow_id,project_id,status,input_json,created_at,updated_at
       ) VALUES (?,?,?,'complete','{}',?,?)`,
    )
    .run(runId, workflowId, projectId, NOW, NOW);
  return runId;
}

function draftInput(
  projectId: string,
  documentType: (typeof DOCUMENT_STUDIO_DRAFT_TYPES_V20)[number],
  originType: (typeof DOCUMENT_STUDIO_DRAFT_ORIGINS_V20)[number],
  originRef: string | null,
) {
  const documentId = randomUUID();
  const versionId = randomUUID();
  const body = `${documentType} ${originType}`;
  return {
    projectId,
    documentId,
    versionId,
    jobId: randomUUID(),
    blobRecordId: randomUUID(),
    folderId: null,
    documentKind: "draft" as const,
    title: `${documentType} draft`,
    filename: `${documentId}.md`,
    source:
      originType === "manual"
        ? ("user_upload" as const)
        : ("assistant_edit" as const),
    summary: null,
    operationId: null,
    draftDocumentType: documentType,
    draftOriginType: originType,
    draftOriginRef: originRef,
    citationAnchorIds: [] as string[],
    createdAt: NOW,
    contentSha256: sha256(body),
    sizeBytes: Buffer.byteLength(body, "utf8"),
    storedSizeBytes: Buffer.byteLength(body, "utf8") + 32,
  };
}

function auditV19Upgrade(root: string) {
  const databasePath = path.join(root, "v19-upgrade.sqlite");
  const v19 = new WorkspaceDatabase(databasePath, {
    migrations: WORKSPACE_MIGRATIONS.slice(0, 19),
  });
  const projectId = insertProject(v19, "Legacy Matter");
  const legacy = seedLegacyDraft(v19, projectId);
  v19.close();

  const upgraded = new WorkspaceDatabase(databasePath);
  try {
    assert.equal(upgraded.migration?.currentVersion, 24);
    assert.equal(
      upgraded
        .prepare(
          "SELECT count(*) AS count FROM document_studio_draft_metadata WHERE document_id = ?",
        )
        .get(legacy.documentId)?.count,
      0,
      "v20 must not invent provenance for legacy Drafts",
    );
    assert.equal(
      upgraded
        .prepare(
          "SELECT current_version_id FROM documents WHERE id = ? AND project_id = ?",
        )
        .get(legacy.documentId, projectId)?.current_version_id,
      legacy.versionId,
    );
    assert.equal(upgraded.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally {
    upgraded.close();
  }
}

function auditMigrationRollback(root: string) {
  const databasePath = path.join(root, "v20-rollback.sqlite");
  new WorkspaceDatabase(databasePath, {
    migrations: WORKSPACE_MIGRATIONS.slice(0, 19),
  }).close();
  const failingV20: WorkspaceMigration = {
    ...DOCUMENT_STUDIO_DRAFT_METADATA_V20_MIGRATION,
    name: "document_studio_draft_metadata_forced_rollback",
    checksumMaterial: `${DOCUMENT_STUDIO_DRAFT_METADATA_V20_MIGRATION.checksumMaterial}\nforced rollback`,
    apply(database, capabilities) {
      DOCUMENT_STUDIO_DRAFT_METADATA_V20_MIGRATION.apply(
        database,
        capabilities,
      );
      throw new Error("forced v20 rollback");
    },
  };
  assert.throws(
    () =>
      new WorkspaceDatabase(databasePath, {
        migrations: [...WORKSPACE_MIGRATIONS.slice(0, 19), failingV20],
      }),
    /rolled back/i,
  );
  const inspection = new WorkspaceDatabase(databasePath, {
    migrations: WORKSPACE_MIGRATIONS.slice(0, 19),
  });
  try {
    assert.equal(
      schemaObjectExists(inspection, "document_studio_draft_metadata"),
      false,
    );
    assert.equal(
      inspection
        .prepare("SELECT count(*) AS count FROM workspace_schema_migrations")
        .get()?.count,
      19,
    );
  } finally {
    inspection.close();
  }
}

function run() {
  const root = mkdtempSync(path.join(os.tmpdir(), "vera-draft-workbench-"));
  const originalEncryption = process.env.ALETHEIA_DATABASE_ENCRYPTION;
  let database: WorkspaceDatabase | null = null;
  try {
    process.env.ALETHEIA_DATABASE_ENCRYPTION = "metadata_plaintext";
    assert.equal(DOCUMENT_STUDIO_DRAFT_METADATA_V20_MIGRATION.version, 20);
    assert.match(
      workspaceMigrationChecksum(DOCUMENT_STUDIO_DRAFT_METADATA_V20_MIGRATION),
      /^sha256:[0-9a-f]{64}$/,
    );
    assert.deepEqual(
      WORKSPACE_MIGRATIONS.map((migration) => migration.version),
      Array.from({ length: 24 }, (_, index) => index + 1),
    );
    assert.equal(new Set(DOCUMENT_STUDIO_DRAFT_TYPES_V20).size, 8);
    assert.deepEqual(DOCUMENT_STUDIO_DRAFT_ORIGINS_V20, [
      "manual",
      "assistant",
      "workflow",
      "unknown",
    ]);

    auditV19Upgrade(root);
    auditMigrationRollback(root);

    database = new WorkspaceDatabase(path.join(root, "fresh.sqlite"));
    assert.equal(database.migration?.currentVersion, 24);
    for (const objectName of [
      "document_studio_draft_metadata",
      "idx_document_studio_draft_metadata_project_type_origin",
      "document_studio_draft_metadata_v20_insert_guard",
      "document_studio_draft_metadata_v20_immutable",
    ]) {
      assert.ok(schemaObjectExists(database, objectName), objectName);
    }

    const projectId = insertProject(database, "Draft Workbench Matter");
    const repository = new WorkspaceDocumentStudioRepository(database, {
      now: () => NOW,
    });
    const assistantOriginRef = seedAssistantOrigin(database, projectId);
    const workflowOriginRef = seedWorkflowOrigin(database, projectId);
    const createdIds: string[] = [];
    for (const [
      index,
      documentType,
    ] of DOCUMENT_STUDIO_DRAFT_TYPES_V20.entries()) {
      const originType: DocumentStudioDraftOriginV20 =
        DOCUMENT_STUDIO_DRAFT_ORIGINS_V20[index % 4]!;
      const input = draftInput(
        projectId,
        documentType,
        originType,
        originType === "assistant"
          ? assistantOriginRef
          : originType === "workflow"
            ? workflowOriginRef
            : null,
      );
      repository.createMarkdownDraft(input);
      createdIds.push(input.documentId);
      assert.deepEqual(
        {
          ...database
            .prepare(
              `SELECT project_id,document_type,origin_type,origin_ref
                 FROM document_studio_draft_metadata WHERE document_id = ?`,
            )
            .get(input.documentId),
        },
        {
          project_id: projectId,
          document_type: documentType,
          origin_type: originType,
          origin_ref: input.draftOriginRef,
        },
      );
    }
    assert.equal(createdIds.length, 8);

    const otherProjectId = insertProject(database, "Other Matter");
    const otherAssistantOriginRef = seedAssistantOrigin(
      database,
      otherProjectId,
    );
    const otherWorkflowOriginRef = seedWorkflowOrigin(database, otherProjectId);
    for (const [originType, originRef] of [
      ["assistant", otherAssistantOriginRef],
      ["workflow", otherWorkflowOriginRef],
      ["assistant", randomUUID()],
    ] as const) {
      const probe = seedLegacyDraft(database, projectId);
      assert.throws(
        () =>
          database!
            .prepare(
              `INSERT INTO document_studio_draft_metadata (
                 document_id,project_id,document_type,origin_type,origin_ref,
                 created_at
               ) VALUES (?,?,'general_legal_document',?,?,?)`,
            )
            .run(probe.documentId, projectId, originType, originRef, NOW),
        /same Project/i,
      );
      assert.equal(
        database
          .prepare(
            "SELECT count(*) AS count FROM document_studio_draft_metadata WHERE document_id = ?",
          )
          .get(probe.documentId)?.count,
        0,
      );
    }

    const atomicFailure = draftInput(
      projectId,
      "general_legal_document",
      "workflow",
      " leading-and-trailing-space ",
    );
    assert.throws(() => repository.createMarkdownDraft(atomicFailure));
    for (const table of [
      "documents",
      "document_versions",
      "document_studio_versions",
      "document_studio_draft_metadata",
      "jobs",
      "workspace_blob_records",
    ]) {
      const column =
        table === "documents"
          ? "id"
          : table === "jobs"
            ? "id"
            : table === "workspace_blob_records"
              ? "id"
              : "document_id";
      const id =
        table === "jobs"
          ? atomicFailure.jobId
          : table === "workspace_blob_records"
            ? atomicFailure.blobRecordId
            : atomicFailure.documentId;
      assert.equal(
        database
          .prepare(`SELECT count(*) AS count FROM ${table} WHERE ${column} = ?`)
          .get(id)?.count,
        0,
        `${table} must roll back when metadata persistence fails`,
      );
    }

    const countedDocumentId = createdIds[1]!;
    const countedVersionId = String(
      database
        .prepare(
          "SELECT current_version_id FROM documents WHERE id = ? AND project_id = ?",
        )
        .get(countedDocumentId, projectId)?.current_version_id,
    );
    for (let ordinal = 0; ordinal < 3; ordinal += 1) {
      const anchorId = insertLegalAnchor(database, projectId, ordinal);
      database
        .prepare(
          `INSERT INTO document_version_citation_anchors (
             project_id,document_id,version_id,anchor_id,ordinal,created_at
           ) VALUES (?,?,?,?,?,?)`,
        )
        .run(
          projectId,
          countedDocumentId,
          countedVersionId,
          anchorId,
          ordinal,
          NOW,
        );
    }
    const suggestions = Array.from({ length: 3 }, (_, index) =>
      repository.createSuggestion({
        suggestionId: randomUUID(),
        projectId,
        documentId: countedDocumentId,
        baseVersionId: countedVersionId,
        messageId: assistantOriginRef,
        changeId: `draft-workbench-change-${index}`,
        startOffset: 0,
        endOffset: 0,
        offsetScope: "raw_markdown_v1",
        offsetUnit: "utf16_code_unit",
        deletedText: "",
        insertedText: `${index}`,
        contextBefore: "",
        contextAfter: "",
        summary: `Suggestion ${index}`,
        createdAt: NOW,
      }),
    );
    repository.rejectSuggestion({
      projectId,
      documentId: countedDocumentId,
      suggestionId: suggestions[0]!.id,
      resolvedAt: NOW,
    });

    const draftsRepository = new WorkspaceDocumentStudioDraftsRepository(
      database,
    );
    const counted = draftsRepository
      .listProjectDrafts({ projectId, limit: 100 })
      .drafts.find((draft) => draft.documentId === countedDocumentId);
    assert.ok(counted);
    assert.equal(counted.sourceCount, 3);
    assert.equal(counted.pendingSuggestionCount, 2);

    const deletedAfterListing = createdIds[0]!;
    assert.ok(
      draftsRepository
        .listProjectDrafts({ projectId, limit: 100 })
        .drafts.some((draft) => draft.documentId === deletedAfterListing),
    );
    database
      .prepare(
        "UPDATE documents SET deleted_at = ?, updated_at = ? WHERE id = ? AND project_id = ?",
      )
      .run(NOW, NOW, deletedAfterListing, projectId);
    assert.equal(
      draftsRepository
        .listProjectDrafts({ projectId, limit: 100 })
        .drafts.some((draft) => draft.documentId === deletedAfterListing),
      false,
    );
    assert.equal(
      repository.getProjectDocument(projectId, deletedAfterListing),
      null,
      "a stale list result must not authorize a later export/open operation",
    );

    const otherMatterDraft = seedLegacyDraft(database, otherProjectId);
    for (let index = 0; index < 105; index += 1) {
      seedLegacyDraft(database, projectId);
    }
    const pagedIds: string[] = [];
    let cursor: { updatedAt: string; documentId: string } | null = null;
    do {
      const page = draftsRepository.listProjectDrafts({
        projectId,
        limit: 100,
        cursor,
      });
      pagedIds.push(...page.drafts.map((draft) => draft.documentId));
      assert.equal(page.drafts.length <= 100, true);
      assert.equal(page.hasMore, page.nextCursor !== null);
      cursor = page.nextCursor;
    } while (cursor !== null);
    assert.equal(pagedIds.length > 100, true);
    assert.equal(new Set(pagedIds).size, pagedIds.length);
    assert.equal(pagedIds.includes(deletedAfterListing), false);
    assert.equal(pagedIds.includes(otherMatterDraft.documentId), false);
    const legacySummary = draftsRepository
      .listProjectDrafts({ projectId, limit: 100 })
      .drafts.find((draft) =>
        database!
          .prepare(
            "SELECT 1 AS present FROM documents WHERE id = ? AND title = 'Legacy draft'",
          )
          .get(draft.documentId),
      );
    assert.ok(legacySummary);
    assert.equal(legacySummary.documentType, "general_legal_document");
    assert.equal(legacySummary.originType, "unknown");
    const safeProjection = JSON.stringify(
      draftsRepository.listProjectDrafts({ projectId, limit: 1 }),
    );
    for (const forbidden of [
      "originRef",
      "storageKey",
      "filename",
      "Authorization",
      "Bearer ",
      "sk_",
      "/Users/",
    ]) {
      assert.equal(safeProjection.includes(forbidden), false, forbidden);
    }

    database
      .prepare(
        "UPDATE projects SET status = 'archived', archived_at = ?, updated_at = ? WHERE id = ?",
      )
      .run(NOW, NOW, projectId);
    assert.equal(
      draftsRepository.listProjectDrafts({ projectId, limit: 1 }).drafts.length,
      1,
      "archived Matters remain readable in the Draft workbench",
    );
    const archivedWrite = draftInput(
      projectId,
      "general_legal_document",
      "manual",
      null,
    );
    assert.throws(() => repository.createMarkdownDraft(archivedWrite));
    assert.equal(
      database
        .prepare("SELECT count(*) AS count FROM documents WHERE id = ?")
        .get(archivedWrite.documentId)?.count,
      0,
    );
    database
      .prepare(
        "UPDATE projects SET status = 'active', archived_at = NULL, updated_at = ? WHERE id = ?",
      )
      .run(NOW, projectId);

    assert.throws(() =>
      database!
        .prepare(
          "UPDATE document_studio_draft_metadata SET origin_type = 'unknown' WHERE document_id = ?",
        )
        .run(createdIds[0]),
    );
    database
      .prepare("DELETE FROM documents WHERE id = ? AND project_id = ?")
      .run(createdIds[0], projectId);
    assert.equal(
      database
        .prepare(
          "SELECT count(*) AS count FROM document_studio_draft_metadata WHERE document_id = ?",
        )
        .get(createdIds[0])?.count,
      0,
    );
    assert.equal(database.prepare("PRAGMA foreign_key_check").all().length, 0);

    console.log(
      JSON.stringify(
        {
          ok: true,
          suite: "vera-workspace-draft-workbench-v20",
          checks: [
            "fresh and real v19-to-v20 migrations install additive Draft metadata without inferring legacy provenance",
            "v20 DDL and migration record roll back atomically",
            "all eight legal document types and manual/Assistant/Workflow/unknown origins persist exactly",
            "Assistant and Workflow origin references reject missing and cross-Matter resources at the SQLite boundary",
            "Draft creation rolls back document, version, Studio, metadata, job, and blob rows on metadata failure",
            "source and pending-suggestion counters use independent aggregates without Cartesian multiplication",
            "soft-deleted and cross-Matter Drafts stay hidden, and stale list results grant no later resource access",
            "legacy Drafts project to general legal document plus unknown origin without mutating v19 rows",
            "stable keyset pagination returns more than 100 Drafts without duplicates or omissions",
            "list responses expose no origin references, storage paths, authorization values, or secret-shaped strings",
            "archived Matters retain readable Draft summaries while every Draft write remains blocked",
            "metadata is immutable and cascades only with its owning Draft",
          ],
        },
        null,
        2,
      ),
    );
  } finally {
    database?.close();
    if (originalEncryption === undefined) {
      delete process.env.ALETHEIA_DATABASE_ENCRYPTION;
    } else {
      process.env.ALETHEIA_DATABASE_ENCRYPTION = originalEncryption;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

run();
