import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { WorkspaceDatabase } from "../lib/workspace/database";
import {
  DOCUMENT_STUDIO_V12_MIGRATION,
  WORKSPACE_MIGRATIONS,
  type WorkspaceMigration,
} from "../lib/workspace/migrations";
import {
  WorkspaceDocumentStudioRepository,
  WorkspaceDocumentStudioRepositoryError,
  type WorkspaceDocumentStudioRepositoryErrorCode,
} from "../lib/workspace/repositories/documentStudio";

const originalEnvironment = { ...process.env };
const root = mkdtempSync(
  path.join(os.tmpdir(), "vera-workspace-document-studio-audit-"),
);
const NOW = "2026-07-15T10:00:00.000Z";
const LATER = "2026-07-15T10:01:00.000Z";
const LATEST = "2026-07-15T10:02:00.000Z";

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hasColumn(database: WorkspaceDatabase, table: string, column: string) {
  return database
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((row) => row.name === column);
}

function hasSchemaObject(database: WorkspaceDatabase, name: string) {
  return Boolean(
    database
      .prepare("SELECT 1 AS present FROM sqlite_schema WHERE name = ?")
      .get(name),
  );
}

function expectStudioError(
  operation: () => unknown,
  code: WorkspaceDocumentStudioRepositoryErrorCode,
) {
  assert.throws(
    operation,
    (error) =>
      error instanceof WorkspaceDocumentStudioRepositoryError &&
      error.code === code,
  );
}

function insertProject(database: WorkspaceDatabase, name: string) {
  const id = randomUUID();
  database
    .prepare(
      "INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
    )
    .run(id, name, NOW, NOW);
  return id;
}

function insertLegalAnchor(
  database: WorkspaceDatabase,
  projectId: string,
  label: string,
) {
  const snapshotId = randomUUID();
  const anchorId = randomUUID();
  const exactQuote = `${label} exact authority quotation`;
  const contentHash = sha256(`${label} authority body`);
  database
    .prepare(
      `INSERT INTO project_source_snapshots (
         id, project_id, source_kind, source_record_id, source_version_id,
         title_snapshot, content_sha256, locator_json, retrieved_at,
         license_json, retention_policy, retention_expires_at,
         retrieval_metadata_json, created_at
       ) VALUES (?, ?, 'legal_authority', ?, NULL, ?, ?, ?, ?, ?,
                 'full_text_permitted', NULL, '{}', ?)`,
    )
    .run(
      snapshotId,
      projectId,
      `${label}-authority`,
      `${label} authority`,
      contentHash,
      JSON.stringify({ authorityIdentifier: `${label}-authority` }),
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
         id, project_id, snapshot_id, ordinal, exact_quote, quote_sha256,
         locator_json, created_at
       ) VALUES (?, ?, ?, 0, ?, ?, ?, ?)`,
    )
    .run(
      anchorId,
      projectId,
      snapshotId,
      exactQuote,
      sha256(exactQuote),
      JSON.stringify({ section: "1" }),
      NOW,
    );
  return { snapshotId, anchorId };
}

function seedLegacyV11Document(database: WorkspaceDatabase) {
  const projectId = insertProject(database, "Legacy Project");
  const documentId = randomUUID();
  const versionId = randomUUID();
  const editId = randomUUID();
  const contentHash = sha256("legacy document");
  database
    .prepare(
      `INSERT INTO documents (
         id, project_id, title, filename, mime_type, size_bytes, parse_status,
         current_version_id, created_at, updated_at
       ) VALUES (?, ?, 'Legacy', 'legacy.txt', 'text/plain', 15, 'ready',
                 NULL, ?, ?)`,
    )
    .run(documentId, projectId, NOW, NOW);
  database
    .prepare(
      `INSERT INTO document_versions (
         id, document_id, version_number, source, filename, mime_type,
         size_bytes, content_sha256, storage_key, created_at
       ) VALUES (?, ?, 1, 'upload', 'legacy.txt', 'text/plain', 15, ?, ?, ?)`,
    )
    .run(
      versionId,
      documentId,
      contentHash,
      `documents/${documentId}/versions/${versionId}/original`,
      NOW,
    );
  database
    .prepare("UPDATE documents SET current_version_id = ? WHERE id = ?")
    .run(versionId, documentId);
  database
    .prepare(
      `INSERT INTO document_edits (
         id, document_id, version_id, change_id, deleted_text, inserted_text,
         summary, status, created_at
       ) VALUES (?, ?, ?, 'legacy-change', 'old', 'new', 'legacy edit',
                 'pending', ?)`,
    )
    .run(editId, documentId, versionId, NOW);
  return { projectId, documentId, versionId, editId };
}

function draftInput(input: {
  projectId: string;
  anchorIds?: string[];
  folderId?: string | null;
  content?: string;
}) {
  const content = input.content ?? "First line\r\n<div>kept verbatim</div>\n";
  return {
    projectId: input.projectId,
    documentId: randomUUID(),
    versionId: randomUUID(),
    jobId: randomUUID(),
    blobRecordId: randomUUID(),
    folderId: input.folderId ?? null,
    documentKind: "draft" as const,
    title: "Advice draft",
    filename: "advice-draft.md",
    summary: null,
    operationId: null,
    citationAnchorIds: input.anchorIds ?? [],
    createdAt: NOW,
    contentSha256: sha256(content),
    sizeBytes: Buffer.byteLength(content, "utf8"),
    storedSizeBytes: Buffer.byteLength(content, "utf8") + 32,
  };
}

try {
  process.env.ALETHEIA_DATABASE_ENCRYPTION = "metadata_plaintext";

  const upgradePath = path.join(root, "v11-upgrade.db");
  const v11 = new WorkspaceDatabase(upgradePath, {
    migrations: WORKSPACE_MIGRATIONS.slice(0, 11),
  });
  const legacy = seedLegacyV11Document(v11);
  const legacyDocumentBefore = v11
    .prepare(
      `SELECT id, project_id, folder_id, title, filename, mime_type,
              size_bytes, parse_status, current_version_id, deleted_at,
              created_at, updated_at
         FROM documents WHERE id = ?`,
    )
    .get(legacy.documentId);
  const legacyVersionBefore = v11
    .prepare("SELECT * FROM document_versions WHERE id = ?")
    .get(legacy.versionId);
  const legacyEditBefore = v11
    .prepare("SELECT * FROM document_edits WHERE id = ?")
    .get(legacy.editId);
  const upgrade = v11.runMigrations(WORKSPACE_MIGRATIONS.slice(0, 12));
  assert.equal(upgrade.currentVersion, 12);
  assert.deepEqual(
    upgrade.applied.map((record) => record.version),
    [12],
  );
  assert.deepEqual(
    v11
      .prepare(
        `SELECT id, project_id, folder_id, title, filename, mime_type,
                size_bytes, parse_status, current_version_id, deleted_at,
                created_at, updated_at
           FROM documents WHERE id = ?`,
      )
      .get(legacy.documentId),
    legacyDocumentBefore,
  );
  assert.deepEqual(
    v11
      .prepare("SELECT * FROM document_versions WHERE id = ?")
      .get(legacy.versionId),
    legacyVersionBefore,
  );
  assert.deepEqual(
    v11.prepare("SELECT * FROM document_edits WHERE id = ?").get(legacy.editId),
    legacyEditBefore,
  );
  assert.equal(
    v11
      .prepare("SELECT document_kind FROM documents WHERE id = ?")
      .get(legacy.documentId)?.document_kind,
    "source",
  );
  v11.close();

  const rollbackPath = path.join(root, "rollback.db");
  const rollbackV11 = new WorkspaceDatabase(rollbackPath, {
    migrations: WORKSPACE_MIGRATIONS.slice(0, 11),
  });
  rollbackV11.close();
  const failingV12: WorkspaceMigration = {
    ...DOCUMENT_STUDIO_V12_MIGRATION,
    name: "document_studio_forced_rollback_probe",
    checksumMaterial: `${DOCUMENT_STUDIO_V12_MIGRATION.checksumMaterial}\nforced rollback probe`,
    apply(database, capabilities) {
      DOCUMENT_STUDIO_V12_MIGRATION.apply(database, capabilities);
      throw new Error("forced v12 rollback");
    },
  };
  assert.throws(
    () =>
      new WorkspaceDatabase(rollbackPath, {
        migrations: [...WORKSPACE_MIGRATIONS.slice(0, 11), failingV12],
      }),
    /rolled back/i,
  );
  const rollbackInspection = new WorkspaceDatabase(rollbackPath, {
    migrations: WORKSPACE_MIGRATIONS.slice(0, 11),
  });
  assert.equal(
    hasColumn(rollbackInspection, "documents", "document_kind"),
    false,
  );
  assert.equal(
    hasSchemaObject(rollbackInspection, "document_studio_versions"),
    false,
  );
  assert.equal(
    hasSchemaObject(rollbackInspection, "document_version_citation_anchors"),
    false,
  );
  assert.equal(
    rollbackInspection
      .prepare("SELECT count(*) AS count FROM workspace_schema_migrations")
      .get()?.count,
    11,
  );
  rollbackInspection.close();

  // Exercise the v12 repository contract against the current schema. The
  // repository now persists additive v20 Draft provenance in the same
  // transaction, while the isolated v11 -> v12 checks above remain pinned.
  const database = new WorkspaceDatabase(path.join(root, "fresh.db"));
  assert.equal(database.migration?.currentVersion, 22);
  assert.ok(hasColumn(database, "documents", "document_kind"));
  assert.ok(hasSchemaObject(database, "document_studio_versions"));
  assert.ok(hasSchemaObject(database, "document_version_citation_anchors"));

  const projectA = insertProject(database, "Project A");
  const projectB = insertProject(database, "Project B");
  const anchorA1 = insertLegalAnchor(database, projectA, "A1").anchorId;
  const anchorA2 = insertLegalAnchor(database, projectA, "A2").anchorId;
  const anchorB = insertLegalAnchor(database, projectB, "B").anchorId;
  const folderB = randomUUID();
  database
    .prepare(
      `INSERT INTO project_subfolders (
         id, project_id, name, created_at, updated_at
       ) VALUES (?, ?, 'Private B folder', ?, ?)`,
    )
    .run(folderB, projectB, NOW, NOW);

  const repository = new WorkspaceDocumentStudioRepository(database, {
    now: () => NOW,
  });
  const initial = draftInput({ projectId: projectA, anchorIds: [anchorA1] });
  const created = repository.createMarkdownDraft(initial);
  assert.equal(created.document.documentKind, "draft");
  assert.equal(created.document.parseStatus, "pending");
  assert.equal(created.version.source, "user_upload");
  assert.equal(created.version.pageCount, null);
  assert.deepEqual(created.citationAnchorIds, [anchorA1]);
  assert.equal(created.jobId, initial.jobId);
  assert.equal(
    database.prepare("SELECT status FROM jobs WHERE id = ?").get(initial.jobId)
      ?.status,
    "queued",
  );
  assert.deepEqual(
    JSON.parse(
      String(
        database
          .prepare("SELECT payload_json FROM jobs WHERE id = ?")
          .get(initial.jobId)?.payload_json,
      ),
    ),
    { documentId: initial.documentId, versionId: initial.versionId },
  );
  assert.equal(
    database
      .prepare(
        `SELECT content_sha256 FROM workspace_blob_records
          WHERE id = ? AND kind = 'original' AND state = 'stored'`,
      )
      .get(initial.blobRecordId)?.content_sha256,
    initial.contentSha256,
  );
  assert.equal(
    repository.getProjectDocument(projectB, initial.documentId),
    null,
  );
  assert.equal(
    repository.getVersion(projectB, initial.documentId, initial.versionId),
    null,
  );

  const folderLeak = draftInput({ projectId: projectA, folderId: folderB });
  expectStudioError(
    () => repository.createMarkdownDraft(folderLeak),
    "DOCUMENT_STUDIO_NOT_FOUND",
  );
  assert.equal(
    database
      .prepare("SELECT count(*) AS count FROM documents WHERE id = ?")
      .get(folderLeak.documentId)?.count,
    0,
  );

  const secondContent = "Second version\r\n<p>raw HTML stays in the blob</p>";
  const second = {
    projectId: projectA,
    documentId: initial.documentId,
    expectedCurrentVersionId: initial.versionId,
    versionId: randomUUID(),
    jobId: randomUUID(),
    blobRecordId: randomUUID(),
    source: "assistant_edit" as const,
    filename: initial.filename,
    summary: "Checkpoint two",
    operationId: null,
    citationAnchorIds: [anchorA2],
    createdAt: LATER,
    contentSha256: sha256(secondContent),
    sizeBytes: Buffer.byteLength(secondContent, "utf8"),
    storedSizeBytes: Buffer.byteLength(secondContent, "utf8") + 32,
  };
  const committed = repository.commitMarkdownVersionCas(second);
  assert.equal(committed.document.currentVersionId, second.versionId);
  assert.equal(committed.version.versionNumber, 2);
  assert.equal(committed.version.source, "assistant_edit");
  assert.deepEqual(committed.version.citationAnchorIds, [anchorA2]);

  database
    .prepare("UPDATE document_versions SET page_count = 3 WHERE id = ?")
    .run(second.versionId);
  assert.equal(
    repository.getVersion(projectA, initial.documentId, second.versionId)
      ?.pageCount,
    3,
  );

  const stale = {
    ...second,
    versionId: randomUUID(),
    jobId: randomUUID(),
    blobRecordId: randomUUID(),
    createdAt: LATEST,
  };
  expectStudioError(
    () => repository.commitMarkdownVersionCas(stale),
    "DOCUMENT_STUDIO_VERSION_CONFLICT",
  );
  assert.equal(
    database
      .prepare("SELECT count(*) AS count FROM document_versions WHERE id = ?")
      .get(stale.versionId)?.count,
    0,
  );
  assert.equal(
    database
      .prepare("SELECT count(*) AS count FROM jobs WHERE id = ?")
      .get(stale.jobId)?.count,
    0,
  );
  assert.equal(
    database
      .prepare(
        "SELECT count(*) AS count FROM workspace_blob_records WHERE id = ?",
      )
      .get(stale.blobRecordId)?.count,
    0,
  );

  const wrongProjectCommit = {
    ...second,
    projectId: projectB,
    expectedCurrentVersionId: second.versionId,
    versionId: randomUUID(),
    jobId: randomUUID(),
    blobRecordId: randomUUID(),
    createdAt: LATEST,
  };
  expectStudioError(
    () => repository.commitMarkdownVersionCas(wrongProjectCommit),
    "DOCUMENT_STUDIO_NOT_FOUND",
  );

  const wrongProjectRestore = {
    projectId: projectB,
    documentId: initial.documentId,
    expectedCurrentVersionId: second.versionId,
    restoreFromVersionId: initial.versionId,
    versionId: randomUUID(),
    jobId: randomUUID(),
    blobRecordId: randomUUID(),
    contentSha256: initial.contentSha256,
    sizeBytes: initial.sizeBytes,
    storedSizeBytes: initial.storedSizeBytes,
    summary: null,
    operationId: null,
    createdAt: LATEST,
  };
  expectStudioError(
    () => repository.restoreVersionCas(wrongProjectRestore),
    "DOCUMENT_STUDIO_NOT_FOUND",
  );
  assert.equal(
    database
      .prepare("SELECT count(*) AS count FROM document_versions WHERE id = ?")
      .get(wrongProjectRestore.versionId)?.count,
    0,
  );

  const crossProjectCitation = {
    ...second,
    expectedCurrentVersionId: second.versionId,
    versionId: randomUUID(),
    jobId: randomUUID(),
    blobRecordId: randomUUID(),
    citationAnchorIds: [anchorB],
    createdAt: LATEST,
  };
  expectStudioError(
    () => repository.commitMarkdownVersionCas(crossProjectCitation),
    "DOCUMENT_STUDIO_NOT_FOUND",
  );
  assert.equal(
    database
      .prepare("SELECT count(*) AS count FROM document_versions WHERE id = ?")
      .get(crossProjectCitation.versionId)?.count,
    0,
  );

  database
    .prepare(
      "UPDATE projects SET status = 'archived', archived_at = ? WHERE id = ?",
    )
    .run(LATEST, projectA);
  const archivedCommit = {
    ...second,
    expectedCurrentVersionId: second.versionId,
    versionId: randomUUID(),
    jobId: randomUUID(),
    blobRecordId: randomUUID(),
    createdAt: LATEST,
  };
  expectStudioError(
    () => repository.commitMarkdownVersionCas(archivedCommit),
    "DOCUMENT_STUDIO_NOT_FOUND",
  );
  assert.ok(repository.getProjectDocument(projectA, initial.documentId));
  database
    .prepare(
      "UPDATE projects SET status = 'active', archived_at = NULL WHERE id = ?",
    )
    .run(projectA);

  const badRestore = {
    projectId: projectA,
    documentId: initial.documentId,
    expectedCurrentVersionId: second.versionId,
    restoreFromVersionId: initial.versionId,
    versionId: randomUUID(),
    jobId: randomUUID(),
    blobRecordId: randomUUID(),
    contentSha256: sha256("not the historical bytes"),
    sizeBytes: 24,
    storedSizeBytes: 56,
    summary: null,
    operationId: null,
    createdAt: LATEST,
  };
  expectStudioError(
    () => repository.restoreVersionCas(badRestore),
    "DOCUMENT_STUDIO_PERSISTENCE_FAILED",
  );
  assert.equal(
    database
      .prepare("SELECT count(*) AS count FROM document_versions WHERE id = ?")
      .get(badRestore.versionId)?.count,
    0,
  );

  const restoredInput = {
    ...badRestore,
    versionId: randomUUID(),
    jobId: randomUUID(),
    blobRecordId: randomUUID(),
    contentSha256: initial.contentSha256,
    sizeBytes: initial.sizeBytes,
    storedSizeBytes: initial.storedSizeBytes,
  };
  const restored = repository.restoreVersionCas(restoredInput);
  assert.equal(restored.document.currentVersionId, restoredInput.versionId);
  assert.equal(restored.version.versionNumber, 3);
  assert.equal(restored.version.source, "user_upload");
  assert.equal(restored.version.contentSha256, initial.contentSha256);
  assert.deepEqual(restored.version.citationAnchorIds, [anchorA1]);
  assert.equal(repository.listVersions(projectA, initial.documentId).length, 3);

  assert.throws(
    () =>
      database
        .prepare(
          "UPDATE document_studio_versions SET summary = 'mutated' WHERE version_id = ?",
        )
        .run(initial.versionId),
    /immutable/i,
  );
  assert.throws(
    () =>
      database
        .prepare(
          `UPDATE document_version_citation_anchors SET ordinal = 10
            WHERE version_id = ? AND anchor_id = ?`,
        )
        .run(second.versionId, anchorA2),
    /immutable/i,
  );

  database
    .prepare("DELETE FROM source_citation_anchors WHERE id = ?")
    .run(anchorA1);
  assert.equal(
    database
      .prepare(
        `SELECT count(*) AS count FROM document_version_citation_anchors
          WHERE anchor_id = ?`,
      )
      .get(anchorA1)?.count,
    0,
  );
  assert.equal(
    database
      .prepare(
        "SELECT count(*) AS count FROM document_studio_versions WHERE document_id = ?",
      )
      .get(initial.documentId)?.count,
    3,
  );

  database
    .prepare("DELETE FROM documents WHERE id = ?")
    .run(initial.documentId);
  for (const table of [
    "document_versions",
    "document_studio_versions",
    "document_version_citation_anchors",
    "workspace_blob_records",
  ]) {
    assert.equal(
      database
        .prepare(`SELECT count(*) AS count FROM ${table} WHERE document_id = ?`)
        .get(initial.documentId)?.count,
      0,
      `${table} must cascade with the Studio document`,
    );
  }
  assert.ok(
    database
      .prepare("SELECT id FROM source_citation_anchors WHERE id = ?")
      .get(anchorA2),
  );
  assert.equal(database.prepare("PRAGMA foreign_key_check").all().length, 0);
  database.close();

  console.log(
    JSON.stringify(
      {
        ok: true,
        suite: "vera-workspace-document-studio-v12",
        current_version: 22,
        checks: [
          "real v11 upgrade preserves legacy documents, versions, and edits",
          "v12 DDL and migration record roll back atomically",
          "fresh v12 schema and source-default backfill",
          "Project-scoped Markdown draft, parse job, and blob metadata create atomically",
          "current_version_id strong CAS conflicts roll back every new row",
          "cross-Project document, folder, anchor, commit, and restore access is hidden",
          "archived Projects remain readable and reject Studio writes",
          "restore verifies copied bytes and creates a new immutable version",
          "Studio metadata and citation bindings reject UPDATE",
          "anchor and document deletion cascades preserve the correct owner",
        ],
      },
      null,
      2,
    ),
  );
} finally {
  process.env = originalEnvironment;
  rmSync(root, { recursive: true, force: true });
}
