import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { migratePlaintextDatabaseToSqlcipher } from "../lib/aletheia/sqlcipherMigration";
import {
  INITIAL_WORKSPACE_MIGRATION,
  ASSISTANT_DURABLE_EVENTS_V10_MIGRATION,
  DOCUMENT_STUDIO_V12_MIGRATION,
  MODEL_CREDENTIAL_ORIGIN_V8_MIGRATION,
  PROJECT_OWNERSHIP_MIGRATION,
  PROJECT_SOURCE_FOUNDATION_V11_MIGRATION,
  SOURCE_RETENTION_LIFECYCLE_V13_MIGRATION,
  TABULAR_MIKE_SEMANTICS_V7_MIGRATION,
  WORKSPACE_INTEGRITY_MIGRATION,
  WORKSPACE_MIGRATIONS,
  WORKSPACE_RUNTIME_MIGRATION,
  DOCUMENT_STUDIO_SUGGESTIONS_V14_MIGRATION,
  MATTER_PROFILES_V15_MIGRATION,
  MATTER_CLASSIFICATION_V16_MIGRATION,
  type WorkspaceDatabaseAdapter,
  type WorkspaceMigration,
} from "../lib/workspace/migrations";
import { MODEL_CONNECTION_READINESS_V9_MIGRATION } from "../lib/workspace/migrations/v9ModelConnectionReadiness";
import { ASSISTANT_RUNTIME_MIGRATION } from "../lib/workspace/migrations/v5AssistantRuntime";
import { WORKFLOW_RUNTIME_V6_MIGRATION } from "../lib/workspace/migrations/v6WorkflowRuntime";
import {
  runWorkspaceMigrations,
  WorkspaceDatabase,
  workspaceMigrationChecksum,
} from "../lib/workspace/database";

const originalEnvironment = { ...process.env };
const root = mkdtempSync(
  path.join(os.tmpdir(), "vera-workspace-migration-audit-"),
);
const sqlcipherBackupRoot = mkdtempSync(
  path.join(os.tmpdir(), "vera-workspace-migration-audit-backup-"),
);
const auditDatabaseKey = randomBytes(32);

const CORE_V4 = [
  INITIAL_WORKSPACE_MIGRATION,
  WORKSPACE_INTEGRITY_MIGRATION,
  WORKSPACE_RUNTIME_MIGRATION,
  PROJECT_OWNERSHIP_MIGRATION,
] as const;
const LEGACY_V1_TO_V6 = [
  ...CORE_V4,
  ASSISTANT_RUNTIME_MIGRATION,
  WORKFLOW_RUNTIME_V6_MIGRATION,
] as const;
const DEFAULT_V1_TO_V10 = [
  ...LEGACY_V1_TO_V6,
  TABULAR_MIKE_SEMANTICS_V7_MIGRATION,
  MODEL_CREDENTIAL_ORIGIN_V8_MIGRATION,
  MODEL_CONNECTION_READINESS_V9_MIGRATION,
  ASSISTANT_DURABLE_EVENTS_V10_MIGRATION,
] as const;
const DEFAULT_V1_TO_V16 = [
  ...DEFAULT_V1_TO_V10,
  PROJECT_SOURCE_FOUNDATION_V11_MIGRATION,
  DOCUMENT_STUDIO_V12_MIGRATION,
  SOURCE_RETENTION_LIFECYCLE_V13_MIGRATION,
  DOCUMENT_STUDIO_SUGGESTIONS_V14_MIGRATION,
  MATTER_PROFILES_V15_MIGRATION,
  MATTER_CLASSIFICATION_V16_MIGRATION,
] as const;
const V9_PREFIX = DEFAULT_V1_TO_V10.slice(0, -1);

function schemaNames(
  database: WorkspaceDatabase,
  type: "table" | "index" | "trigger",
) {
  return new Set(
    database
      .prepare(
        `SELECT name FROM sqlite_schema
          WHERE type = ? AND name NOT LIKE 'sqlite_%'
          ORDER BY name`,
      )
      .all(type)
      .map((row) => String(row.name)),
  );
}

function tableSql(database: WorkspaceDatabase, table: string) {
  const row = database
    .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?")
    .get(table);
  assert.ok(row?.sql, `missing schema SQL for ${table}`);
  return String(row.sql);
}

function columnNames(database: WorkspaceDatabase, table: string) {
  return database
    .prepare(`PRAGMA table_info("${table}")`)
    .all()
    .map((row) => String(row.name));
}

function databaseArtifactPaths(databasePath: string) {
  const directory = path.dirname(databasePath);
  const baseName = path.basename(databasePath);
  return readdirSync(directory)
    .filter(
      (name) =>
        name === baseName ||
        name === `${baseName}-wal` ||
        name === `${baseName}-shm` ||
        name === `${baseName}-journal`,
    )
    .map((name) => path.join(directory, name));
}

function readDatabaseArtifacts(databasePath: string) {
  return new Map(
    databaseArtifactPaths(databasePath).map((artifactPath) => [
      artifactPath,
      readFileSync(artifactPath),
    ]),
  );
}

function assertDatabaseArtifactsEqual(
  databasePath: string,
  expected: ReadonlyMap<string, Buffer>,
) {
  const actual = readDatabaseArtifacts(databasePath);
  assert.deepEqual([...actual.keys()].sort(), [...expected.keys()].sort());
  for (const [artifactPath, expectedBytes] of expected) {
    assert.equal(actual.get(artifactPath)?.equals(expectedBytes), true);
  }
}

function assertNoPhysicalMarker(databasePath: string, marker: string) {
  for (const artifactPath of databaseArtifactPaths(databasePath)) {
    assert.equal(
      readFileSync(artifactPath).includes(Buffer.from(marker)),
      false,
      `database artifact leaked marker: ${artifactPath}`,
    );
  }
}

function migrateAuditDatabaseToSqlcipher(
  databasePath: string,
  fixtureName: string,
  expectedPlaintextMarker: string,
) {
  const backupDir = path.join(sqlcipherBackupRoot, fixtureName);
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const migrated = migratePlaintextDatabaseToSqlcipher({
    dataDir: path.dirname(databasePath),
    databasePath,
    backupDir,
    apply: true,
  });
  assert.equal(migrated.status, "migrated");
  assert.ok(migrated.backup_path);
  const backupPath = String(migrated.backup_path);
  assert.equal(
    readFileSync(backupPath).includes(Buffer.from(expectedPlaintextMarker)),
    true,
  );
  unlinkSync(backupPath);
  assert.equal(existsSync(backupPath), false);
}

function assertMigrationRecords(
  database: WorkspaceDatabase,
  migrations: readonly WorkspaceMigration[],
) {
  assert.deepEqual(
    database
      .prepare(
        `SELECT version, name, checksum
           FROM workspace_schema_migrations ORDER BY version`,
      )
      .all()
      .map((row) => ({
        version: Number(row.version),
        name: String(row.name),
        checksum: String(row.checksum),
      })),
    migrations.map((migration) => ({
      version: migration.version,
      name: migration.name,
      checksum: workspaceMigrationChecksum(migration),
    })),
  );
}

function createUnmigratedDatabase(fileName: string) {
  const database = new WorkspaceDatabase(path.join(root, fileName), {
    migrate: false,
  });
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE aletheia_phase1_sentinel (
      id INTEGER PRIMARY KEY,
      payload TEXT NOT NULL
    );
    INSERT INTO aletheia_phase1_sentinel (id, payload)
    VALUES (1, 'legacy-data-must-survive');
  `);
  return database;
}

function seedV1UpgradeFixture(database: WorkspaceDatabase) {
  const migration = runWorkspaceMigrations(database, [
    INITIAL_WORKSPACE_MIGRATION,
  ]);
  assert.equal(migration.currentVersion, 1);
  database.exec(`
    INSERT INTO projects (id, name) VALUES
      ('project-1', 'Legacy project'),
      ('project-2', 'Other project');

    INSERT INTO project_subfolders (id, project_id, name) VALUES
      ('folder-1', 'project-1', 'Root'),
      ('folder-2', 'project-2', 'Other root');
    INSERT INTO project_subfolders
      (id, project_id, parent_folder_id, name)
    VALUES ('folder-child', 'project-1', 'folder-1', 'Child');

    INSERT INTO documents
      (id, project_id, folder_id, title, filename, mime_type, size_bytes)
    VALUES
      ('document-1', 'project-1', 'folder-1', 'Legacy one', 'one.txt',
       'text/plain', 34),
      ('document-2', 'project-2', 'folder-2', 'Legacy two', 'two.txt',
       'text/plain', 20),
      ('document-3', 'project-1', NULL, 'Not selected', 'three.txt',
       'text/plain', 10);

    INSERT INTO document_versions
      (id, document_id, version_number, filename, mime_type, size_bytes,
       content_sha256, storage_key)
    VALUES
      ('version-1', 'document-1', 1, 'one.txt', 'text/plain', 34,
       '${"a".repeat(64)}', 'opaque-original-one'),
      ('version-2', 'document-2', 1, 'two.txt', 'text/plain', 20,
       '${"b".repeat(64)}', 'opaque-original-two');

    UPDATE documents SET current_version_id = 'version-1'
     WHERE id = 'document-1';
    UPDATE documents SET current_version_id = 'version-2'
     WHERE id = 'document-2';

    INSERT INTO document_chunks
      (id, document_id, version_id, ordinal, text, start_offset, end_offset,
       content_sha256)
    VALUES
      ('chunk-1', 'document-1', 'version-1', 0,
       'privileged workspace search payload', 0, 35, '${"c".repeat(64)}'),
      ('chunk-2', 'document-2', 'version-2', 0,
       'separate project payload', 0, 24, '${"d".repeat(64)}');

    INSERT INTO workflows
      (id, type, title, steps_json, columns_config_json)
    VALUES
      ('workflow-assistant', 'assistant', 'Assistant', '[]', '[]'),
      ('workflow-tabular', 'tabular', 'Tabular', '[]', '[]');

    INSERT INTO tabular_reviews
      (id, project_id, workflow_id, title, document_ids_json)
    VALUES
      ('review-1', 'project-1', 'workflow-tabular', 'Legacy review',
       '["document-1"]'),
      ('review-2', 'project-1', 'workflow-tabular', 'Second review', '[]');

    INSERT INTO tabular_review_columns
      (id, review_id, key, title, output_type, ordinal)
    VALUES
      ('column-1', 'review-1', 'summary', 'Summary', 'text', 0),
      ('column-2', 'review-2', 'flag', 'Flag', 'boolean', 0);

    INSERT INTO chats (id, project_id, scope, title)
    VALUES ('chat-1', 'project-1', 'project', 'Audit chat');
    INSERT INTO chat_messages
      (id, chat_id, sequence, role, content, status)
    VALUES ('message-1', 'chat-1', 0, 'assistant', 'answer', 'complete');

    INSERT INTO jobs
      (id, type, resource_type, resource_id, scheduled_at)
    VALUES
      ('job-legacy', 'document_parse', 'document', 'document-1',
       '2026-01-01T00:00:00.000Z');
  `);
}

const RUNTIME_VALID_IDS = {
  project: "10000000-0000-4000-8000-000000000001",
  document: "10000000-0000-4000-8000-000000000002",
  version: "10000000-0000-4000-8000-000000000003",
  chunk: "10000000-0000-4000-8000-000000000004",
  review: "10000000-0000-4000-8000-000000000005",
  column: "10000000-0000-4000-8000-000000000006",
  cell: "10000000-0000-4000-8000-000000000007",
  completeJob: "10000000-0000-4000-8000-000000000008",
  failedJob: "10000000-0000-4000-8000-000000000009",
} as const;
type RuntimeValidIds = {
  [Key in keyof typeof RUNTIME_VALID_IDS]: string;
};
const OPAQUE_TABULAR_IDS: RuntimeValidIds = {
  ...RUNTIME_VALID_IDS,
  review: "opaque-runtime-review",
  column: "opaque-runtime-column",
  cell: "opaque-runtime-cell",
};
const RUNTIME_VALID_NOW = "2026-07-14T12:00:00.000Z";
const TABULAR_REGENERATION_REQUIRED_ERROR = JSON.stringify({
  code: "workspace_migration_tabular_regeneration_required",
  message:
    "Tabular cell generation must be explicitly regenerated after workspace schema v7 migration.",
  retryable: false,
  details: null,
});

function seedRuntimeValidPrefixFixture(
  database: WorkspaceDatabase,
  ids: RuntimeValidIds = RUNTIME_VALID_IDS,
) {
  const documentText = "runtime valid matrix evidence";
  const documentIdsJson = JSON.stringify([ids.document]);
  const columnsConfigJson = JSON.stringify([
    {
      index: 0,
      name: "Summary",
      prompt: "Summarize",
      format: "text",
      tags: [],
    },
  ]);
  database
    .prepare("INSERT INTO projects (id, name) VALUES (?, ?)")
    .run(ids.project, "Runtime-valid project");
  database
    .prepare(
      `INSERT INTO documents
        (id, project_id, title, filename, mime_type, size_bytes,
         parse_status)
       VALUES (?, ?, ?, ?, 'text/plain', ?, 'ready')`,
    )
    .run(
      ids.document,
      ids.project,
      "Runtime-valid document",
      "runtime-valid.txt",
      documentText.length,
    );
  database
    .prepare(
      `INSERT INTO document_versions
        (id, document_id, version_number, filename, mime_type, size_bytes,
         content_sha256, storage_key)
       VALUES (?, ?, 1, 'runtime-valid.txt', 'text/plain', ?, ?, ?)`,
    )
    .run(
      ids.version,
      ids.document,
      documentText.length,
      "a".repeat(64),
      "runtime-valid-original-object",
    );
  database
    .prepare("UPDATE documents SET current_version_id = ? WHERE id = ?")
    .run(ids.version, ids.document);
  database
    .prepare(
      `INSERT INTO document_chunks
        (id, document_id, version_id, ordinal, text, start_offset, end_offset,
         content_sha256)
       VALUES (?, ?, ?, 0, ?, 0, ?, ?)`,
    )
    .run(
      ids.chunk,
      ids.document,
      ids.version,
      documentText,
      documentText.length,
      "b".repeat(64),
    );
  database
    .prepare(
      `INSERT INTO tabular_reviews
        (id, project_id, title, status, document_ids_json,
         columns_config_json)
       VALUES (?, ?, 'Runtime-valid review', 'complete', ?, ?)`,
    )
    .run(ids.review, ids.project, documentIdsJson, columnsConfigJson);
  if (
    database
      .prepare(
        `SELECT 1 FROM sqlite_schema
          WHERE type = 'table' AND name = 'tabular_review_documents'`,
      )
      .get()
  ) {
    database
      .prepare(
        `INSERT INTO tabular_review_documents
          (review_id, document_id, ordinal)
         VALUES (?, ?, 0)`,
      )
      .run(ids.review, ids.document);
  }
  database
    .prepare(
      `INSERT INTO tabular_review_columns
        (id, review_id, key, title, output_type, prompt, ordinal)
       VALUES (?, ?, 'summary', 'Summary', 'text', 'Summarize', 0)`,
    )
    .run(ids.column, ids.review);
  database
    .prepare(
      `INSERT INTO jobs
        (id, type, status, resource_type, resource_id, retryable,
         payload_json, result_json, error_json, error_code, scheduled_at,
         started_at, completed_at)
       VALUES (?, 'tabular_cell', 'complete', 'tabular_cell', ?, 1,
               '{}', '{}', NULL, NULL, ?, ?, ?)`,
    )
    .run(
      ids.completeJob,
      ids.cell,
      RUNTIME_VALID_NOW,
      RUNTIME_VALID_NOW,
      RUNTIME_VALID_NOW,
    );
  database
    .prepare(
      `INSERT INTO jobs
        (id, type, status, resource_type, resource_id, retryable,
         payload_json, result_json, error_json, error_code, scheduled_at,
         started_at, completed_at)
       VALUES (?, 'tabular_cell', 'failed', 'tabular_cell', ?, 0,
               '{}', NULL, ?,
               'workspace_migration_tabular_regeneration_required', ?, ?, ?)`,
    )
    .run(
      ids.failedJob,
      ids.cell,
      TABULAR_REGENERATION_REQUIRED_ERROR,
      RUNTIME_VALID_NOW,
      RUNTIME_VALID_NOW,
      RUNTIME_VALID_NOW,
    );
  database
    .prepare(
      `INSERT INTO tabular_cells
        (id, review_id, document_id, column_id, output_type, content,
         citations_json, status, job_id, completed_at)
       VALUES (?, ?, ?, ?, 'text', ?, '[]', 'complete', ?, ?)`,
    )
    .run(
      ids.cell,
      ids.review,
      ids.document,
      ids.column,
      JSON.stringify({ summary: "Runtime-valid answer" }),
      ids.completeJob,
      RUNTIME_VALID_NOW,
    );
}

function assertThrowsSql(
  database: WorkspaceDatabase,
  sql: string,
  parameters: unknown[] = [],
) {
  assert.throws(() => database.prepare(sql).run(...parameters));
}

function errorChainMatches(error: unknown, pattern: RegExp) {
  const messages: string[] = [];
  let current: unknown = error;
  while (current) {
    messages.push(current instanceof Error ? current.message : String(current));
    current =
      typeof current === "object" && current !== null && "cause" in current
        ? current.cause
        : null;
  }
  return pattern.test(messages.join(" | "));
}

function assertNoV7SchemaMarkers(database: WorkspaceDatabase) {
  assert.equal(
    database
      .prepare(
        "SELECT max(version) AS version FROM workspace_schema_migrations",
      )
      .get()?.version,
    6,
  );
  assert.equal(
    columnNames(database, "tabular_review_columns").includes("format"),
    false,
  );
  assert.equal(
    schemaNames(database, "table").has("tabular_v7_nul_recovery_snapshots"),
    false,
  );
  assert.equal(
    schemaNames(database, "trigger").has("tabular_cells_content_mike_insert"),
    false,
  );
}

function assertEncryptedV7SchemaOnlyFailure(
  databasePath: string,
  expectedCause: RegExp,
) {
  const beforeArtifacts = readDatabaseArtifacts(databasePath);
  assert.throws(
    () => new WorkspaceDatabase(databasePath),
    (error) => errorChainMatches(error, expectedCause),
  );
  assertDatabaseArtifactsEqual(databasePath, beforeArtifacts);
  const inspection = new WorkspaceDatabase(databasePath, {
    migrations: LEGACY_V1_TO_V6,
  });
  try {
    assertNoV7SchemaMarkers(inspection);
  } finally {
    inspection.close();
  }
}

try {
  process.env.ALETHEIA_DATABASE_ENCRYPTION = "metadata_plaintext";
  assert.deepEqual(
    WORKSPACE_MIGRATIONS.map((migration) => migration.version),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
    "the default registry is a contiguous v1-v16 chain",
  );
  assert.deepEqual(WORKSPACE_MIGRATIONS, DEFAULT_V1_TO_V16);

  const upgradePath = path.join(root, "upgrade.db");
  const v1Database = createUnmigratedDatabase("upgrade.db");
  seedV1UpgradeFixture(v1Database);
  v1Database.close();

  const database = new WorkspaceDatabase(upgradePath, {
    migrations: LEGACY_V1_TO_V6,
  });
  try {
    assert.equal(database.migration?.currentVersion, 6);
    assert.deepEqual(
      database.migration?.applied.map((migration) => migration.version),
      [2, 3, 4, 5, 6],
    );
    assert.deepEqual(database.migration?.preflight, {
      foreignKeysEnabled: true,
      integrityCheck: "ok",
      foreignKeyViolations: 0,
    });
    assert.deepEqual(database.migration?.capabilities, {
      jsonTextChecks: true,
      fts5: true,
      sqlcipherEncrypted: false,
    });

    const migrationRows = database
      .prepare(
        `SELECT version, name, checksum
           FROM workspace_schema_migrations ORDER BY version`,
      )
      .all();
    assert.deepEqual(
      migrationRows.map((row) => ({
        version: Number(row.version),
        name: String(row.name),
        checksum: String(row.checksum),
      })),
      [
        {
          version: 1,
          name: INITIAL_WORKSPACE_MIGRATION.name,
          checksum: workspaceMigrationChecksum(INITIAL_WORKSPACE_MIGRATION),
        },
        {
          version: 2,
          name: WORKSPACE_INTEGRITY_MIGRATION.name,
          checksum: workspaceMigrationChecksum(WORKSPACE_INTEGRITY_MIGRATION),
        },
        {
          version: 3,
          name: WORKSPACE_RUNTIME_MIGRATION.name,
          checksum: workspaceMigrationChecksum(WORKSPACE_RUNTIME_MIGRATION),
        },
        {
          version: 4,
          name: PROJECT_OWNERSHIP_MIGRATION.name,
          checksum: workspaceMigrationChecksum(PROJECT_OWNERSHIP_MIGRATION),
        },
        {
          version: 5,
          name: ASSISTANT_RUNTIME_MIGRATION.name,
          checksum: workspaceMigrationChecksum(ASSISTANT_RUNTIME_MIGRATION),
        },
        {
          version: 6,
          name: WORKFLOW_RUNTIME_V6_MIGRATION.name,
          checksum: workspaceMigrationChecksum(WORKFLOW_RUNTIME_V6_MIGRATION),
        },
      ],
    );

    assert.equal(
      Number(database.prepare("PRAGMA foreign_keys").get()?.foreign_keys),
      1,
    );
    assert.equal(
      Number(database.prepare("PRAGMA busy_timeout").get()?.timeout),
      5000,
    );
    assert.equal(
      String(database.prepare("PRAGMA journal_mode").get()?.journal_mode),
      "wal",
    );

    const tables = schemaNames(database, "table");
    for (const table of [
      "projects",
      "documents",
      "document_versions",
      "document_chunks_fts",
      "jobs",
      "workflows",
      "workflow_runs",
      "tabular_reviews",
      "tabular_review_documents",
      "workspace_blob_records",
      "workspace_blob_cleanup_intents",
      "workspace_schema_capabilities",
      "aletheia_phase1_sentinel",
    ]) {
      assert.ok(tables.has(table), table);
    }

    const indexes = schemaNames(database, "index");
    for (const index of [
      "uq_workspace_blob_records_storage_key",
      "uq_workspace_blob_records_document_locator",
      "uq_workspace_blob_records_preview_locator",
      "uq_workspace_blob_records_export_locator",
      "uq_workspace_blob_records_quarantine",
      "idx_workspace_blob_records_state",
      "idx_workspace_blob_cleanup_pending",
      "idx_workspace_blob_cleanup_document",
      "idx_jobs_lease_expiry",
      "idx_workflows_project_updated",
      "idx_workflow_runs_retry_of",
      "idx_tabular_review_documents_document",
    ]) {
      assert.ok(indexes.has(index), index);
    }

    const triggers = schemaNames(database, "trigger");
    for (const trigger of [
      "project_subfolders_integrity_insert",
      "project_subfolders_integrity_update",
      "documents_integrity_insert",
      "documents_integrity_update",
      "message_sources_integrity_insert",
      "message_sources_integrity_update",
      "tabular_reviews_integrity_insert",
      "tabular_reviews_integrity_update",
      "tabular_review_documents_integrity_insert",
      "tabular_review_documents_integrity_update",
      "tabular_cells_integrity_insert",
      "tabular_cells_integrity_update",
      "document_chunks_fts_insert",
      "document_chunks_fts_delete",
      "document_chunks_fts_update",
      "workspace_blob_cleanup_intents_validate_insert",
      "workspace_blob_cleanup_intents_validate_update",
      "projects_workflow_ownership_delete_guard",
    ]) {
      assert.ok(triggers.has(trigger), trigger);
    }

    assert.deepEqual(
      database
        .prepare(
          `SELECT capability, available
             FROM workspace_schema_capabilities ORDER BY capability`,
        )
        .all()
        .map((row) => [String(row.capability), Number(row.available)]),
      [
        ["fts5", 1],
        ["json1", 1],
      ],
    );

    for (const column of [
      "queued_at",
      "cancellation_reason",
      "lease_owner",
      "lease_expires_at",
    ]) {
      assert.ok(columnNames(database, "jobs").includes(column), column);
    }
    assert.ok(columnNames(database, "workflows").includes("project_id"));
    assert.ok(
      columnNames(database, "workflow_runs").includes("retry_of_run_id"),
    );
    assert.ok(columnNames(database, "documents").includes("parse_error_code"));
    assert.ok(columnNames(database, "documents").includes("parse_error_json"));
    assert.match(tableSql(database, "workspace_blob_records"), /kind IN/);
    assert.match(
      tableSql(database, "workspace_blob_records"),
      /FOREIGN KEY \(document_id, version_id\)/,
    );
    assert.equal(
      columnNames(database, "workspace_blob_records").some((column) =>
        /path/i.test(column),
      ),
      false,
    );
    assert.equal(
      columnNames(database, "workspace_blob_cleanup_intents").some((column) =>
        /path|message|filename/i.test(column),
      ),
      false,
    );

    const cleanupDocumentId = "10000000-0000-4000-8000-000000000001";
    const cleanupVersionId = "20000000-0000-4000-8000-000000000001";
    const cleanupIntentId = "30000000-0000-4000-8000-000000000001";
    const cleanupLocator = JSON.stringify({
      kind: "original",
      documentId: cleanupDocumentId,
      versionId: cleanupVersionId,
    });
    database
      .prepare(
        `INSERT INTO workspace_blob_cleanup_intents (
           id, operation, code, document_id, version_id, locator_json
         ) VALUES (?, 'compensation', 'DOCUMENT_BLOB_COMPENSATION_FAILED',
                   ?, ?, ?)`,
      )
      .run(
        cleanupIntentId,
        cleanupDocumentId,
        cleanupVersionId,
        cleanupLocator,
      );
    assertThrowsSql(
      database,
      `INSERT INTO workspace_blob_cleanup_intents (
         id, operation, code, document_id, version_id, locator_json
       ) VALUES ('30000000-0000-4000-8000-000000000002', 'compensation',
                 'DOCUMENT_BLOB_COMPENSATION_FAILED', ?, ?, ?)`,
      [
        cleanupDocumentId,
        cleanupVersionId,
        JSON.stringify({
          kind: "original",
          documentId: cleanupDocumentId,
          versionId: cleanupVersionId,
          path: "/private/original.pdf",
        }),
      ],
    );
    assertThrowsSql(
      database,
      `INSERT INTO workspace_blob_cleanup_intents (
         id, operation, code, document_id, version_id, locator_json,
         receipt_json
       ) VALUES ('30000000-0000-4000-8000-000000000003', 'finalize',
                 'DOCUMENT_BLOB_FINALIZE_FAILED', ?, ?, ?, ?)`,
      [
        cleanupDocumentId,
        cleanupVersionId,
        cleanupLocator,
        JSON.stringify({
          status: "staged",
          locator: JSON.parse(cleanupLocator),
          quarantineId: "not-a-uuid/private/path",
        }),
      ],
    );
    assertThrowsSql(
      database,
      `INSERT INTO workspace_blob_cleanup_intents (
         id, operation, code, document_id, version_id, locator_json
       ) VALUES ('-0000000-0000-4000-8000-000000000001', 'compensation',
                 'DOCUMENT_BLOB_COMPENSATION_FAILED', ?, ?, ?)`,
      [cleanupDocumentId, cleanupVersionId, cleanupLocator],
    );

    assert.equal(
      database
        .prepare("SELECT payload FROM aletheia_phase1_sentinel WHERE id = 1")
        .get()?.payload,
      "legacy-data-must-survive",
    );
    assert.deepEqual(
      database
        .prepare(
          `SELECT review_id, document_id, ordinal
             FROM tabular_review_documents ORDER BY review_id, ordinal`,
        )
        .all()
        .map((row) => [
          String(row.review_id),
          String(row.document_id),
          Number(row.ordinal),
        ]),
      [["review-1", "document-1", 0]],
    );
    assert.equal(
      database
        .prepare("SELECT queued_at FROM jobs WHERE id = 'job-legacy'")
        .get()?.queued_at,
      "2026-01-01T00:00:00.000Z",
    );
    assert.equal(
      database
        .prepare(
          `SELECT text FROM document_chunks_fts
            WHERE document_chunks_fts MATCH 'privileged'`,
        )
        .get()?.text,
      "privileged workspace search payload",
    );

    database
      .prepare(
        `INSERT INTO workspace_blob_records
          (id, kind, document_id, version_id, storage_key, content_sha256,
           size_bytes, stored_size_bytes)
         VALUES (?, 'original', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "blob-original-1",
        "document-1",
        "version-1",
        "opaque:blob:original:1",
        "e".repeat(64),
        34,
        98,
      );
    assertThrowsSql(
      database,
      `INSERT INTO workspace_blob_records
        (id, kind, document_id, version_id, export_id, storage_key,
         content_sha256, size_bytes, stored_size_bytes)
       VALUES ('blob-invalid-locator', 'original', 'document-1', 'version-1',
               'export-1', 'opaque:invalid', ?, 1, 1)`,
      ["f".repeat(64)],
    );
    assertThrowsSql(
      database,
      `INSERT INTO workspace_blob_records
        (id, kind, document_id, version_id, storage_key, content_sha256,
         size_bytes, stored_size_bytes)
       VALUES ('blob-wrong-owner', 'preview', 'document-1', 'version-2',
               'opaque:wrong-owner', ?, 1, 1)`,
      ["f".repeat(64)],
    );
    database
      .prepare(
        `INSERT INTO workspace_blob_records
          (id, kind, document_id, version_id, storage_key, content_sha256,
           size_bytes, stored_size_bytes)
         VALUES ('blob-preview-1', 'preview', 'document-1', 'version-1',
                 'opaque:preview:1', ?, 1, 2)`,
      )
      .run("f".repeat(64));
    assertThrowsSql(
      database,
      `INSERT INTO workspace_blob_records
        (id, kind, document_id, version_id, storage_key, content_sha256,
         size_bytes, stored_size_bytes)
       VALUES ('blob-preview-duplicate', 'preview', 'document-1', 'version-1',
               'opaque:preview:duplicate', ?, 1, 2)`,
      ["1".repeat(64)],
    );
    assertThrowsSql(
      database,
      `INSERT INTO workspace_blob_records
        (id, kind, export_id, storage_key, content_sha256, size_bytes,
         stored_size_bytes)
       VALUES ('blob-absolute-path', 'export', 'export-absolute',
               '/Users/example/private.pdf', ?, 1, 2)`,
      ["1".repeat(64)],
    );
    assertThrowsSql(
      database,
      `INSERT INTO workspace_blob_records
        (id, kind, export_id, storage_key, content_sha256, size_bytes,
         stored_size_bytes, state)
       VALUES ('blob-bad-state', 'export', 'export-1', 'opaque:export:1',
               ?, 1, 2, 'quarantined')`,
      ["1".repeat(64)],
    );

    assertThrowsSql(
      database,
      `INSERT INTO project_subfolders
        (id, project_id, parent_folder_id, name)
       VALUES ('folder-cross-project', 'project-2', 'folder-1', 'Invalid')`,
    );
    assertThrowsSql(
      database,
      "UPDATE project_subfolders SET parent_folder_id = 'folder-child' WHERE id = 'folder-1'",
    );
    assertThrowsSql(
      database,
      "UPDATE documents SET folder_id = 'folder-2' WHERE id = 'document-1'",
    );
    assertThrowsSql(
      database,
      "UPDATE documents SET current_version_id = 'version-2' WHERE id = 'document-1'",
    );

    database
      .prepare(
        `INSERT INTO message_sources
          (id, message_id, document_id, version_id, filename_snapshot,
           chunk_id, quote, start_offset, end_offset)
         VALUES ('source-valid', 'message-1', 'document-1', 'version-1',
                 'one.txt', 'chunk-1', 'privileged workspace search payload',
                 0, 35)`,
      )
      .run();
    database.exec(`
      INSERT INTO documents
        (id, project_id, title, filename, mime_type, size_bytes)
      VALUES
        ('document-standalone', NULL, 'Standalone', 'standalone.txt',
         'text/plain', 4);
      INSERT INTO document_versions
        (id, document_id, version_number, filename, mime_type, size_bytes,
         content_sha256, storage_key)
      VALUES
        ('version-standalone', 'document-standalone', 1, 'standalone.txt',
         'text/plain', 4, '${"9".repeat(64)}', 'opaque-standalone');
      UPDATE documents SET current_version_id = 'version-standalone'
       WHERE id = 'document-standalone';
      INSERT INTO chats (id, project_id, scope, title)
      VALUES ('chat-global', NULL, 'global', 'Global audit chat');
      INSERT INTO chat_messages
        (id, chat_id, sequence, role, content, status)
      VALUES
        ('message-global', 'chat-global', 0, 'assistant', 'answer', 'complete');
      INSERT INTO message_sources
        (id, message_id, document_id, version_id, filename_snapshot, quote,
         start_offset, end_offset)
      VALUES
        ('source-global-valid', 'message-global', 'document-standalone',
         'version-standalone', 'standalone.txt', 'global source', 0, 13);
    `);
    assertThrowsSql(
      database,
      `INSERT INTO message_sources
        (id, message_id, document_id, version_id)
       VALUES ('source-global-project-document', 'message-global',
               'document-1', 'version-1')`,
    );
    assertThrowsSql(
      database,
      `INSERT INTO message_sources
        (id, message_id, document_id, version_id)
       VALUES ('source-wrong-version', 'message-1', 'document-2', 'version-1')`,
    );
    assertThrowsSql(
      database,
      `INSERT INTO message_sources
        (id, message_id, document_id, version_id, chunk_id)
       VALUES ('source-cross-project', 'message-1', 'document-2',
               'version-2', 'chunk-2')`,
    );
    assertThrowsSql(
      database,
      `UPDATE message_sources SET chunk_id = 'chunk-2'
        WHERE id = 'source-valid'`,
    );
    assertThrowsSql(
      database,
      "UPDATE chats SET project_id = 'project-2' WHERE id = 'chat-1'",
    );

    assertThrowsSql(
      database,
      `INSERT INTO tabular_reviews
        (id, project_id, workflow_id, title)
       VALUES ('review-invalid-workflow', 'project-1',
               'workflow-assistant', 'Invalid')`,
    );
    assertThrowsSql(
      database,
      `UPDATE tabular_reviews SET workflow_id = 'workflow-assistant'
        WHERE id = 'review-1'`,
    );
    assertThrowsSql(
      database,
      `INSERT INTO tabular_review_documents (review_id, document_id, ordinal)
       VALUES ('review-1', 'document-2', 1)`,
    );
    database
      .prepare(
        `INSERT INTO tabular_review_documents (review_id, document_id, ordinal)
         VALUES ('review-2', 'document-1', 0)`,
      )
      .run();
    database
      .prepare(
        `INSERT INTO tabular_cells
          (id, review_id, document_id, column_id, output_type)
         VALUES ('cell-valid', 'review-1', 'document-1', 'column-1', 'text')`,
      )
      .run();
    assertThrowsSql(
      database,
      `INSERT INTO tabular_cells
        (id, review_id, document_id, column_id, output_type)
       VALUES ('cell-wrong-column', 'review-1', 'document-1',
               'column-2', 'boolean')`,
    );
    assertThrowsSql(
      database,
      `INSERT INTO tabular_cells
        (id, review_id, document_id, column_id, output_type)
       VALUES ('cell-wrong-output', 'review-1', 'document-1',
               'column-1', 'boolean')`,
    );
    assertThrowsSql(
      database,
      `INSERT INTO tabular_cells
        (id, review_id, document_id, column_id, output_type)
       VALUES ('cell-not-member', 'review-1', 'document-3',
               'column-1', 'text')`,
    );
    assertThrowsSql(
      database,
      `UPDATE tabular_cells SET output_type = 'boolean'
        WHERE id = 'cell-valid'`,
    );
    assertThrowsSql(
      database,
      `DELETE FROM tabular_review_documents
        WHERE review_id = 'review-1' AND document_id = 'document-1'`,
    );
    assertThrowsSql(
      database,
      "UPDATE workflows SET type = 'assistant' WHERE id = 'workflow-tabular'",
    );

    database.exec(`
      INSERT INTO tabular_reviews
        (id, project_id, workflow_id, title, document_ids_json)
      VALUES
        ('review-delete', 'project-1', 'workflow-tabular', 'Delete cascade',
         '["document-3"]');
      INSERT INTO tabular_review_documents (review_id, document_id, ordinal)
      VALUES ('review-delete', 'document-3', 0);
      INSERT INTO tabular_review_columns
        (id, review_id, key, title, output_type, ordinal)
      VALUES ('column-delete', 'review-delete', 'value', 'Value', 'text', 0);
      INSERT INTO tabular_cells
        (id, review_id, document_id, column_id, output_type)
      VALUES
        ('cell-delete', 'review-delete', 'document-3', 'column-delete', 'text');
      DELETE FROM tabular_reviews WHERE id = 'review-delete';
    `);
    assert.equal(
      database
        .prepare(
          `SELECT count(*) AS count FROM tabular_review_documents
            WHERE review_id = 'review-delete'`,
        )
        .get()?.count,
      0,
    );
    assert.equal(
      database
        .prepare(
          "SELECT count(*) AS count FROM tabular_cells WHERE id = 'cell-delete'",
        )
        .get()?.count,
      0,
    );

    database
      .prepare(
        `INSERT INTO jobs
          (id, type, resource_type, resource_id)
         VALUES ('job-new', 'assistant_generate', 'chat', 'chat-1')`,
      )
      .run();
    assertThrowsSql(
      database,
      `INSERT INTO jobs
        (id, type, resource_type, resource_id, queued_at)
       VALUES ('job-empty-queue-time', 'document_parse', 'document',
               'document-1', '')`,
    );
    assert.match(
      String(
        database
          .prepare("SELECT queued_at FROM jobs WHERE id = 'job-new'")
          .get()?.queued_at,
      ),
      /^\d{4}-\d{2}-\d{2}T/,
    );
    assertThrowsSql(
      database,
      `INSERT INTO jobs
        (id, type, resource_type, resource_id, lease_owner)
       VALUES ('job-bad-lease', 'document_parse', 'document', 'document-1',
               'worker-1')`,
    );
    database
      .prepare(
        `UPDATE jobs SET lease_owner = 'worker-1',
                         lease_expires_at = '2026-01-01T00:01:00.000Z'
          WHERE id = 'job-new'`,
      )
      .run();
    assertThrowsSql(
      database,
      "UPDATE jobs SET cancellation_reason = '' WHERE id = 'job-new'",
    );

    database
      .prepare(
        `INSERT INTO workflow_runs
          (id, workflow_id, project_id, status)
         VALUES ('run-1', 'workflow-assistant', 'project-1', 'failed')`,
      )
      .run();
    database
      .prepare(
        `INSERT INTO workflow_runs
          (id, workflow_id, project_id, retry_of_run_id)
         VALUES ('run-2', 'workflow-assistant', 'project-1', 'run-1')`,
      )
      .run();
    assertThrowsSql(
      database,
      `INSERT INTO workflow_runs
        (id, workflow_id, retry_of_run_id)
       VALUES ('run-invalid-retry', 'workflow-assistant', 'missing')`,
    );

    database.exec(`
      INSERT INTO projects (id, name)
      VALUES ('project-delete-guard', 'Guarded project');
      INSERT INTO workflows (id, type, project_id, title)
      VALUES ('workflow-delete-guard', 'assistant', 'project-delete-guard',
              'Guarded workflow');
      INSERT INTO workflow_runs
        (id, workflow_id, project_id, status, input_json)
      VALUES
        ('run-delete-guard-direct', 'workflow-assistant',
         'project-delete-guard', 'complete', '{"owned":"direct"}'),
        ('run-delete-guard-bound', 'workflow-delete-guard',
         NULL, 'complete', '{"owned":"workflow"}');
      INSERT INTO workflow_step_runs
        (id, workflow_run_id, ordinal, step_json, status, output_json)
      VALUES
        ('step-delete-guard-direct', 'run-delete-guard-direct', 0,
         '{"kind":"prompt"}', 'complete', '{"private":true}'),
        ('step-delete-guard-bound', 'run-delete-guard-bound', 0,
         '{"kind":"prompt"}', 'complete', '{"private":true}');
    `);
    assert.throws(
      () =>
        database
          .prepare("DELETE FROM projects WHERE id = 'project-delete-guard'")
          .run(),
      /project workflow runs must be purged/i,
    );
    database
      .prepare(
        `DELETE FROM workflow_runs
          WHERE id IN ('run-delete-guard-direct', 'run-delete-guard-bound')`,
      )
      .run();
    assert.equal(
      database
        .prepare(
          `SELECT count(*) AS count FROM workflow_step_runs
            WHERE id IN ('step-delete-guard-direct', 'step-delete-guard-bound')`,
        )
        .get()?.count,
      0,
    );
    assert.throws(
      () =>
        database
          .prepare("DELETE FROM projects WHERE id = 'project-delete-guard'")
          .run(),
      /project workflows must be purged/i,
    );
    database
      .prepare("DELETE FROM workflows WHERE id = 'workflow-delete-guard'")
      .run();
    database
      .prepare("DELETE FROM projects WHERE id = 'project-delete-guard'")
      .run();
    assert.ok(
      database
        .prepare("SELECT id FROM workflows WHERE id = 'workflow-assistant'")
        .get(),
    );

    database
      .prepare(
        `UPDATE documents
            SET parse_status = 'failed',
                parse_error_code = 'PARSER_FAILED',
                parse_error_json = '{"retryable":true}'
          WHERE id = 'document-3'`,
      )
      .run();
    assertThrowsSql(
      database,
      "UPDATE documents SET parse_error_json = '{' WHERE id = 'document-3'",
    );

    assert.equal(database.prepare("PRAGMA foreign_key_check").all().length, 0);
    assert.equal(
      Object.values(database.prepare("PRAGMA integrity_check").get() ?? {})[0],
      "ok",
    );

    const rerun = runWorkspaceMigrations(database, LEGACY_V1_TO_V6);
    assert.equal(rerun.currentVersion, 6);
    assert.deepEqual(rerun.applied, []);

    const driftedV2: WorkspaceMigration = {
      ...WORKSPACE_INTEGRITY_MIGRATION,
      checksumMaterial: `${WORKSPACE_INTEGRITY_MIGRATION.checksumMaterial}\n-- unauthorized drift`,
    };
    assert.throws(
      () =>
        runWorkspaceMigrations(database, [
          INITIAL_WORKSPACE_MIGRATION,
          driftedV2,
        ]),
      /checksum drift/i,
    );
    assert.equal(
      database
        .prepare("SELECT count(*) AS count FROM workspace_schema_migrations")
        .get()?.count,
      6,
    );
  } finally {
    database.close();
  }
  const legacyV6Artifacts = readDatabaseArtifacts(upgradePath);
  assert.throws(
    () => new WorkspaceDatabase(upgradePath),
    (error) =>
      errorChainMatches(
        error,
        /workspace schema v7|migrate:aletheia:sqlcipher --prefix backend/i,
      ),
  );
  assertDatabaseArtifactsEqual(upgradePath, legacyV6Artifacts);
  const legacyV6Inspection = new WorkspaceDatabase(upgradePath, {
    migrate: false,
  });
  try {
    assertNoV7SchemaMarkers(legacyV6Inspection);
  } finally {
    legacyV6Inspection.close();
  }

  const v2UpgradePath = path.join(root, "v2-upgrade.db");
  const v2UpgradeBootstrap = createUnmigratedDatabase("v2-upgrade.db");
  runWorkspaceMigrations(v2UpgradeBootstrap, [
    INITIAL_WORKSPACE_MIGRATION,
    WORKSPACE_INTEGRITY_MIGRATION,
  ]);
  v2UpgradeBootstrap.close();
  const v2Upgrade = new WorkspaceDatabase(v2UpgradePath, {
    migrations: LEGACY_V1_TO_V6,
  });
  try {
    assert.equal(v2Upgrade.migration?.currentVersion, 6);
    assert.deepEqual(
      v2Upgrade.migration?.applied.map((record) => record.version),
      [3, 4, 5, 6],
    );
    assert.ok(
      schemaNames(v2Upgrade, "table").has("workspace_blob_cleanup_intents"),
    );
    assert.equal(
      v2Upgrade
        .prepare("SELECT payload FROM aletheia_phase1_sentinel WHERE id = 1")
        .get()?.payload,
      "legacy-data-must-survive",
    );
  } finally {
    v2Upgrade.close();
  }

  const v3HistoricalPath = path.join(root, "v3-historical-null.db");
  const v3HistoricalBootstrap = createUnmigratedDatabase(
    "v3-historical-null.db",
  );
  runWorkspaceMigrations(v3HistoricalBootstrap, [
    INITIAL_WORKSPACE_MIGRATION,
    WORKSPACE_INTEGRITY_MIGRATION,
    WORKSPACE_RUNTIME_MIGRATION,
  ]);
  v3HistoricalBootstrap.exec(`
    INSERT INTO projects (id, name)
    VALUES ('project-historical-null', 'Historical detached project');
    INSERT INTO workflows (id, type, project_id, title)
    VALUES ('workflow-historical-null', 'assistant',
            'project-historical-null', 'Historical detached workflow');
    INSERT INTO workflow_runs
      (id, workflow_id, project_id, status, input_json)
    VALUES ('run-historical-null', 'workflow-historical-null',
            'project-historical-null', 'complete', '{"historical":true}');
    INSERT INTO workflow_step_runs
      (id, workflow_run_id, ordinal, step_json, status, output_json)
    VALUES ('step-historical-null', 'run-historical-null', 0,
            '{"kind":"prompt"}', 'complete', '{"private":true}');
    DELETE FROM projects WHERE id = 'project-historical-null';
  `);
  assert.equal(
    v3HistoricalBootstrap
      .prepare(
        "SELECT project_id FROM workflows WHERE id = 'workflow-historical-null'",
      )
      .get()?.project_id,
    null,
  );
  assert.equal(
    v3HistoricalBootstrap
      .prepare(
        "SELECT project_id FROM workflow_runs WHERE id = 'run-historical-null'",
      )
      .get()?.project_id,
    null,
  );
  v3HistoricalBootstrap.close();

  const v3HistoricalUpgrade = new WorkspaceDatabase(v3HistoricalPath, {
    migrations: LEGACY_V1_TO_V6,
  });
  try {
    assert.equal(v3HistoricalUpgrade.migration?.currentVersion, 6);
    assert.deepEqual(
      v3HistoricalUpgrade.migration?.applied.map((record) => record.version),
      [4, 5, 6],
    );
    assert.ok(
      schemaNames(v3HistoricalUpgrade, "trigger").has(
        "projects_workflow_ownership_delete_guard",
      ),
    );
    assert.equal(
      v3HistoricalUpgrade
        .prepare(
          `SELECT count(*) AS count
             FROM workflows
            WHERE id = 'workflow-historical-null' AND project_id IS NULL`,
        )
        .get()?.count,
      1,
    );
    assert.equal(
      v3HistoricalUpgrade
        .prepare(
          `SELECT count(*) AS count
             FROM workflow_runs
            WHERE id = 'run-historical-null' AND project_id IS NULL`,
        )
        .get()?.count,
      1,
    );
    assert.equal(
      v3HistoricalUpgrade
        .prepare(
          `SELECT count(*) AS count
             FROM workflow_step_runs
            WHERE id = 'step-historical-null'`,
        )
        .get()?.count,
      1,
    );
  } finally {
    v3HistoricalUpgrade.close();
  }

  for (const prefixVersion of [1, 2, 3, 6] as const) {
    const fileName = `runtime-valid-v${prefixVersion}.db`;
    const databasePath = path.join(root, fileName);
    const bootstrap = createUnmigratedDatabase(fileName);
    runWorkspaceMigrations(
      bootstrap,
      DEFAULT_V1_TO_V10.slice(0, prefixVersion),
    );
    seedRuntimeValidPrefixFixture(bootstrap);
    bootstrap.close();

    const upgraded = new WorkspaceDatabase(databasePath);
    try {
      assert.equal(upgraded.migration?.currentVersion, 16);
      assert.deepEqual(
        upgraded.migration?.applied.map((record) => record.version),
        Array.from(
          { length: 16 - prefixVersion },
          (_, index) => prefixVersion + index + 1,
        ),
      );
      assert.equal(
        upgraded
          .prepare("SELECT payload FROM aletheia_phase1_sentinel WHERE id = 1")
          .get()?.payload,
        "legacy-data-must-survive",
      );
      assert.equal(
        upgraded
          .prepare(
            `SELECT count(*) AS count
               FROM tabular_reviews review
               JOIN tabular_review_documents membership
                 ON membership.review_id = review.id
               JOIN tabular_review_columns column_row
                 ON column_row.review_id = review.id
               JOIN tabular_cells cell
                 ON cell.review_id = review.id
                AND cell.document_id = membership.document_id
                AND cell.column_id = column_row.id
              WHERE review.id = ?`,
          )
          .get(RUNTIME_VALID_IDS.review)?.count,
        1,
      );
      assert.deepEqual(
        upgraded
          .prepare(
            `SELECT id, status, payload_json, result_json, error_code,
                    error_json
               FROM jobs
              WHERE id IN (?, ?)
              ORDER BY id`,
          )
          .all(RUNTIME_VALID_IDS.completeJob, RUNTIME_VALID_IDS.failedJob)
          .map((row) => ({ ...row })),
        [
          {
            id: RUNTIME_VALID_IDS.completeJob,
            status: "complete",
            payload_json: "{}",
            result_json: "{}",
            error_code: null,
            error_json: null,
          },
          {
            id: RUNTIME_VALID_IDS.failedJob,
            status: "failed",
            payload_json: "{}",
            result_json: null,
            error_code: "workspace_migration_tabular_regeneration_required",
            error_json: TABULAR_REGENERATION_REQUIRED_ERROR,
          },
        ],
      );
      assert.deepEqual(upgraded.migration?.capabilities, {
        jsonTextChecks: true,
        fts5: true,
        sqlcipherEncrypted: false,
      });
      assertMigrationRecords(upgraded, DEFAULT_V1_TO_V16);
      const rerun = upgraded.runMigrations();
      assert.equal(rerun.currentVersion, 16);
      assert.deepEqual(rerun.applied, []);
      if (prefixVersion === 6) {
        const driftedV8: WorkspaceMigration = {
          ...MODEL_CREDENTIAL_ORIGIN_V8_MIGRATION,
          checksumMaterial: `${MODEL_CREDENTIAL_ORIGIN_V8_MIGRATION.checksumMaterial}\n-- unauthorized drift`,
        };
        assert.throws(
          () =>
            upgraded.runMigrations([
              ...V9_PREFIX.slice(0, 7),
              driftedV8,
              MODEL_CONNECTION_READINESS_V9_MIGRATION,
              ASSISTANT_DURABLE_EVENTS_V10_MIGRATION,
              PROJECT_SOURCE_FOUNDATION_V11_MIGRATION,
              DOCUMENT_STUDIO_V12_MIGRATION,
              SOURCE_RETENTION_LIFECYCLE_V13_MIGRATION,
              DOCUMENT_STUDIO_SUGGESTIONS_V14_MIGRATION,
              MATTER_PROFILES_V15_MIGRATION,
              MATTER_CLASSIFICATION_V16_MIGRATION,
            ]),
          /checksum drift/i,
        );
        assertMigrationRecords(upgraded, DEFAULT_V1_TO_V16);
      }
    } finally {
      upgraded.close();
    }
    const reopened = new WorkspaceDatabase(databasePath);
    try {
      assert.equal(reopened.migration?.currentVersion, 16);
      assert.deepEqual(reopened.migration?.applied, []);
      assertMigrationRecords(reopened, DEFAULT_V1_TO_V16);
      assert.equal(
        reopened
          .prepare("SELECT payload FROM aletheia_phase1_sentinel WHERE id = 1")
          .get()?.payload,
        "legacy-data-must-survive",
      );
    } finally {
      reopened.close();
    }
  }

  const newInstall = createUnmigratedDatabase("new-install.db");
  try {
    const migration = runWorkspaceMigrations(newInstall, WORKSPACE_MIGRATIONS);
    assert.equal(migration.currentVersion, 16);
    assert.deepEqual(
      migration.applied.map((record) => record.version),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
    );
    assert.ok(schemaNames(newInstall, "table").has("workspace_blob_records"));
    assert.ok(
      schemaNames(newInstall, "table").has("workspace_blob_cleanup_intents"),
    );
    assert.ok(
      schemaNames(newInstall, "table").has("tabular_v7_nul_recovery_snapshots"),
    );
    assert.ok(
      schemaNames(newInstall, "table").has(
        "model_profile_credential_orphan_cleanups",
      ),
    );
    assert.ok(
      schemaNames(newInstall, "table").has("assistant_generation_events"),
    );
    assert.ok(
      schemaNames(newInstall, "trigger").has(
        "assistant_generation_events_immutable",
      ),
    );
    assert.ok(schemaNames(newInstall, "table").has("project_source_snapshots"));
    assert.ok(schemaNames(newInstall, "table").has("source_citation_anchors"));
    assert.ok(schemaNames(newInstall, "table").has("document_studio_versions"));
    assert.ok(
      schemaNames(newInstall, "table").has("document_version_citation_anchors"),
    );
    assert.ok(columnNames(newInstall, "documents").includes("document_kind"));
    assert.deepEqual(
      columnNames(newInstall, "model_profiles").filter((column) =>
        [
          "credential_origin",
          "credential_state",
          "migration_issue_code",
          "execution_revision",
          "connection_revision",
        ].includes(column),
      ),
      [
        "credential_origin",
        "credential_state",
        "migration_issue_code",
        "execution_revision",
        "connection_revision",
      ],
    );
    assert.ok(schemaNames(newInstall, "table").has("matter_profiles"));
    assert.ok(schemaNames(newInstall, "table").has("matter_policies"));
    assert.ok(
      schemaNames(newInstall, "table").has("matter_policy_execution_locations"),
    );
    assert.ok(
      columnNames(newInstall, "matter_profiles").includes("workspace_type"),
    );
    assert.ok(
      columnNames(newInstall, "matter_profiles").includes("jurisdiction"),
    );
    assert.ok(
      schemaNames(newInstall, "index").has(
        "idx_matter_profiles_workspace_type_updated",
      ),
    );
    assert.ok(
      schemaNames(newInstall, "index").has(
        "idx_matter_profiles_jurisdiction_updated",
      ),
    );
    assert.ok(
      schemaNames(newInstall, "trigger").has(
        "matter_profiles_v16_insert_requires_workspace_type",
      ),
    );
    assert.ok(
      schemaNames(newInstall, "trigger").has(
        "matter_profiles_v16_workspace_type_one_way",
      ),
    );
    assertMigrationRecords(newInstall, DEFAULT_V1_TO_V16);
  } finally {
    newInstall.close();
  }

  const registryGapProbe = createUnmigratedDatabase("registry-gap.db");
  try {
    const skippedVersion: WorkspaceMigration = {
      version: 3,
      name: "skipped_version_probe",
      checksumMaterial: "must never run",
      apply() {
        throw new Error("a gapped registry must be rejected before apply");
      },
    };
    assert.throws(
      () =>
        runWorkspaceMigrations(registryGapProbe, [
          INITIAL_WORKSPACE_MIGRATION,
          skippedVersion,
        ]),
      /contiguous version order starting at 1/i,
    );
    assert.equal(
      registryGapProbe
        .prepare(
          "SELECT count(*) AS count FROM sqlite_schema WHERE name = 'workspace_schema_migrations'",
        )
        .get()?.count,
      0,
      "an invalid registry is rejected before touching the database",
    );
  } finally {
    registryGapProbe.close();
  }

  const rollbackDatabase = createUnmigratedDatabase("rollback.db");
  try {
    runWorkspaceMigrations(rollbackDatabase, CORE_V4);
    const failingMigration: WorkspaceMigration = {
      version: 5,
      name: "forced_rollback_probe",
      checksumMaterial: "create workspace_failure_probe then throw",
      apply(databaseAdapter) {
        databaseAdapter.exec(
          "CREATE TABLE workspace_failure_probe (id INTEGER PRIMARY KEY)",
        );
        throw new Error("forced migration failure");
      },
    };
    assert.throws(
      () =>
        runWorkspaceMigrations(rollbackDatabase, [
          ...CORE_V4,
          failingMigration,
        ]),
      /failed and was rolled back/i,
    );
    assert.equal(
      rollbackDatabase
        .prepare(
          "SELECT count(*) AS count FROM sqlite_schema WHERE name = 'workspace_failure_probe'",
        )
        .get()?.count,
      0,
    );
    assert.equal(
      rollbackDatabase
        .prepare("SELECT count(*) AS count FROM workspace_schema_migrations")
        .get()?.count,
      4,
    );
    assert.equal(
      rollbackDatabase
        .prepare("SELECT payload FROM aletheia_phase1_sentinel WHERE id = 1")
        .get()?.payload,
      "legacy-data-must-survive",
    );
  } finally {
    rollbackDatabase.close();
  }

  const malformedUpgrade = createUnmigratedDatabase("malformed-upgrade.db");
  try {
    runWorkspaceMigrations(malformedUpgrade, [INITIAL_WORKSPACE_MIGRATION]);
    malformedUpgrade
      .prepare(
        `INSERT INTO tabular_reviews (id, title, document_ids_json)
         VALUES ('malformed-review', 'Malformed', '{}')`,
      )
      .run();
    assert.throws(
      () => runWorkspaceMigrations(malformedUpgrade, LEGACY_V1_TO_V6),
      /failed and was rolled back/i,
    );
    assert.equal(
      malformedUpgrade
        .prepare("SELECT count(*) AS count FROM workspace_schema_migrations")
        .get()?.count,
      1,
    );
    assert.equal(
      schemaNames(malformedUpgrade, "table").has("workspace_blob_records"),
      false,
    );
    assert.equal(
      malformedUpgrade
        .prepare("SELECT payload FROM aletheia_phase1_sentinel WHERE id = 1")
        .get()?.payload,
      "legacy-data-must-survive",
    );
  } finally {
    malformedUpgrade.close();
  }

  const capabilityProbe: WorkspaceDatabaseAdapter = {
    exec() {
      throw new Error("capability check must happen before schema writes");
    },
    prepare() {
      throw new Error("capability check must happen before schema reads");
    },
  };
  assert.throws(
    () =>
      WORKSPACE_INTEGRITY_MIGRATION.apply(capabilityProbe, {
        jsonTextChecks: false,
        fts5: true,
        sqlcipherEncrypted: false,
      }),
    /requires SQLite JSON1 and FTS5/i,
  );
  assert.throws(
    () =>
      WORKSPACE_RUNTIME_MIGRATION.apply(capabilityProbe, {
        jsonTextChecks: false,
        fts5: true,
        sqlcipherEncrypted: false,
      }),
    /requires SQLite JSON1/i,
  );
  assert.throws(
    () =>
      WORKSPACE_INTEGRITY_MIGRATION.apply(capabilityProbe, {
        jsonTextChecks: true,
        fts5: false,
        sqlcipherEncrypted: false,
      }),
    /requires SQLite JSON1 and FTS5/i,
  );

  const plaintextGatePath = path.join(root, "plaintext-destructive-gate.db");
  const plaintextGateBootstrap = createUnmigratedDatabase(
    "plaintext-destructive-gate.db",
  );
  runWorkspaceMigrations(plaintextGateBootstrap, LEGACY_V1_TO_V6);
  seedRuntimeValidPrefixFixture(plaintextGateBootstrap);
  plaintextGateBootstrap.exec("PRAGMA secure_delete = OFF");
  const plaintextMarker = `V7_DEFAULT_REGISTRY_RAW_SECRET_${"q".repeat(1400)}`;
  plaintextGateBootstrap
    .prepare(
      `UPDATE jobs
          SET payload_json = ?,
              error_code = 'raw_legacy_error',
              error_json = ?
        WHERE id = ?`,
    )
    .run(
      JSON.stringify({ api_key: plaintextMarker }),
      JSON.stringify({
        code: "raw_legacy_error",
        message: plaintextMarker,
        retryable: false,
        details: { api_key: plaintextMarker },
      }),
      RUNTIME_VALID_IDS.failedJob,
    );
  plaintextGateBootstrap.close();
  assert.equal(
    readFileSync(plaintextGatePath).includes(Buffer.from(plaintextMarker)),
    true,
  );
  const plaintextGateArtifacts = readDatabaseArtifacts(plaintextGatePath);
  assert.throws(
    () => new WorkspaceDatabase(plaintextGatePath),
    (error) =>
      errorChainMatches(error, /migrate:aletheia:sqlcipher --prefix backend/),
  );
  assertDatabaseArtifactsEqual(plaintextGatePath, plaintextGateArtifacts);
  const plaintextGateUnchanged = new WorkspaceDatabase(plaintextGatePath, {
    migrations: LEGACY_V1_TO_V6,
  });
  try {
    assert.equal(plaintextGateUnchanged.migration?.currentVersion, 6);
    assert.equal(
      plaintextGateUnchanged
        .prepare("SELECT payload_json FROM jobs WHERE id = ?")
        .get(RUNTIME_VALID_IDS.failedJob)?.payload_json,
      JSON.stringify({ api_key: plaintextMarker }),
    );
    assert.equal(
      plaintextGateUnchanged
        .prepare("SELECT payload FROM aletheia_phase1_sentinel WHERE id = 1")
        .get()?.payload,
      "legacy-data-must-survive",
    );
  } finally {
    plaintextGateUnchanged.close();
  }

  process.env.ALETHEIA_DATABASE_ENCRYPTION = "sqlcipher_required";
  process.env.ALETHEIA_DATABASE_KEY_SOURCE = "env";
  process.env.ALETHEIA_DATABASE_KEY_BASE64 =
    auditDatabaseKey.toString("base64");
  migrateAuditDatabaseToSqlcipher(
    plaintextGatePath,
    "plaintext-destructive-gate",
    plaintextMarker,
  );
  const encryptedGateUpgrade = new WorkspaceDatabase(plaintextGatePath);
  try {
    assert.equal(encryptedGateUpgrade.migration?.currentVersion, 16);
    assert.equal(
      encryptedGateUpgrade.migration?.capabilities.sqlcipherEncrypted,
      true,
    );
    assert.equal(
      encryptedGateUpgrade
        .prepare(
          `SELECT payload_json, error_code, error_json
             FROM jobs WHERE id = ?`,
        )
        .get(RUNTIME_VALID_IDS.failedJob)?.payload_json,
      "{}",
    );
    assert.equal(
      encryptedGateUpgrade
        .prepare("SELECT error_code FROM jobs WHERE id = ?")
        .get(RUNTIME_VALID_IDS.failedJob)?.error_code,
      "workspace_migration_tabular_regeneration_required",
    );
    assert.equal(
      encryptedGateUpgrade
        .prepare("SELECT error_json FROM jobs WHERE id = ?")
        .get(RUNTIME_VALID_IDS.failedJob)?.error_json,
      TABULAR_REGENERATION_REQUIRED_ERROR,
    );
    assert.equal(
      encryptedGateUpgrade
        .prepare("SELECT payload FROM aletheia_phase1_sentinel WHERE id = 1")
        .get()?.payload,
      "legacy-data-must-survive",
    );
    assertMigrationRecords(encryptedGateUpgrade, DEFAULT_V1_TO_V16);
  } finally {
    encryptedGateUpgrade.close();
  }
  assertNoPhysicalMarker(plaintextGatePath, plaintextMarker);

  const encryptedMissingMatrixPath = path.join(
    root,
    "encrypted-v6-missing-matrix.db",
  );
  const encryptedMissingMatrix = new WorkspaceDatabase(
    encryptedMissingMatrixPath,
    { migrations: LEGACY_V1_TO_V6 },
  );
  seedRuntimeValidPrefixFixture(encryptedMissingMatrix);
  encryptedMissingMatrix
    .prepare("DELETE FROM tabular_cells WHERE id = ?")
    .run(RUNTIME_VALID_IDS.cell);
  encryptedMissingMatrix.close();
  assertEncryptedV7SchemaOnlyFailure(
    encryptedMissingMatrixPath,
    /incomplete tabular matrix/i,
  );

  const encryptedOpaqueIdsPath = path.join(
    root,
    "encrypted-v6-opaque-tabular-ids.db",
  );
  const encryptedOpaqueIds = new WorkspaceDatabase(encryptedOpaqueIdsPath, {
    migrations: LEGACY_V1_TO_V6,
  });
  seedRuntimeValidPrefixFixture(encryptedOpaqueIds, OPAQUE_TABULAR_IDS);
  encryptedOpaqueIds.close();
  assertEncryptedV7SchemaOnlyFailure(
    encryptedOpaqueIdsPath,
    /Invalid persisted tabular (review|column|cell)/,
  );

  const encryptedPath = path.join(root, "workspace-encrypted.db");
  const encryptedDatabase = new WorkspaceDatabase(encryptedPath);
  let encryptedStatus: ReturnType<WorkspaceDatabase["status"]>;
  try {
    encryptedStatus = encryptedDatabase.status();
    assert.equal(encryptedStatus.encrypted, true);
    assert.equal(
      encryptedDatabase.migration?.capabilities.sqlcipherEncrypted,
      true,
    );
    assert.equal(encryptedDatabase.migration?.currentVersion, 16);
    assert.equal(
      encryptedDatabase
        .prepare("SELECT count(*) AS count FROM workspace_schema_migrations")
        .get()?.count,
      16,
    );
  } finally {
    encryptedDatabase.close();
  }
  assert.notEqual(
    readFileSync(encryptedPath).subarray(0, 16).toString("utf8"),
    "SQLite format 3\0",
  );

  const encryptedManualPath = path.join(root, "workspace-encrypted-manual.db");
  const encryptedManualDatabase = new WorkspaceDatabase(encryptedManualPath, {
    migrate: false,
  });
  let encryptedManualRun: ReturnType<WorkspaceDatabase["runMigrations"]>;
  try {
    assert.equal(
      encryptedManualDatabase.migration,
      null,
      "migrate:false defers schema work until the trusted database entrypoint is called",
    );
    encryptedManualRun = encryptedManualDatabase.runMigrations();
    assert.equal(
      encryptedManualRun.capabilities.sqlcipherEncrypted,
      true,
      "the wrapper-owned migration entrypoint preserves exact SQLCipher attestation",
    );
    assert.equal(encryptedManualRun.currentVersion, 16);
    assert.equal(
      encryptedManualDatabase
        .prepare("SELECT count(*) AS count FROM workspace_schema_migrations")
        .get()?.count,
      16,
    );
  } finally {
    encryptedManualDatabase.close();
  }
  assert.notEqual(
    readFileSync(encryptedManualPath).subarray(0, 16).toString("utf8"),
    "SQLite format 3\0",
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        suite: "vera-workspace-migration-audit-v16",
        current_version: 16,
        encrypted_driver: encryptedStatus!.encrypted,
        checks: [
          "legacy opaque and incomplete-matrix fixtures remain explicit v1-v6",
          "runtime-valid v1, v2, v3, and v6 prefixes upgrade through default v16",
          "clean default v16 install",
          "v9 connection readiness schema applies on SQLite and SQLCipher",
          "v10 immutable Assistant durable event outbox applies on SQLite and SQLCipher",
          "v11 immutable Project source snapshots and citation anchors",
          "v12 Project Document Studio metadata and citation bindings",
          "v13 source retention lifecycle and fail-closed access metadata",
          "v14 immutable Document Studio AI suggestions",
          "v15 optional Matter Profiles and fail-closed Matter Policies",
          "v16 explicit Matter workspace classification and jurisdiction without legacy backfill",
          "ordered SHA-256 checksums and idempotent rerun",
          "failed migration DDL and record roll back atomically",
          "legacy Aletheia sentinel table and row preserved",
          "JSON1 and FTS5 are mandatory and recorded",
          "FTS5 index rebuilt from legacy document chunks",
          "authoritative opaque blob metadata and strict locators",
          "durable path-free cleanup intents and strict receipt JSON",
          "production foreign-key, busy-timeout, and WAL pragmas",
          "job queue, cancellation, and lease persistence",
          "workflow project scope and retry lineage",
          "raw project deletes require run-first then workflow purge",
          "v3 historical SET NULL provenance is preserved without guessing",
          "document parse error persistence",
          "tabular document JSON normalized and backfilled",
          "cross-project, ownership, cycle, type, and cell triggers",
          "SQLite and SQLCipher integrity checks",
          "plaintext destructive migration fails byte-exact before SQLCipher",
          "offline SQLCipher migration enables trusted default v7-v16 upgrade",
          "encrypted v6 missing matrix fails transactionally before v7 markers",
          "encrypted v6 opaque tabular IDs fail the frozen validator transactionally",
        ],
      },
      null,
      2,
    ),
  );
} finally {
  process.env = originalEnvironment;
  rmSync(root, { recursive: true, force: true });
  rmSync(sqlcipherBackupRoot, { recursive: true, force: true });
}
