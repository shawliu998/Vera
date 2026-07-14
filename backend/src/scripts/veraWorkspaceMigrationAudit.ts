import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  INITIAL_WORKSPACE_MIGRATION,
  WORKSPACE_MIGRATIONS,
  type WorkspaceMigration,
} from "../lib/workspace/migrations";
import {
  runWorkspaceMigrations,
  WorkspaceDatabase,
  workspaceMigrationChecksum,
} from "../lib/workspace/database";

const originalEnvironment = { ...process.env };
const root = mkdtempSync(
  path.join(os.tmpdir(), "vera-workspace-migration-audit-"),
);

const REQUIRED_TABLES = [
  "workspace_schema_migrations",
  "projects",
  "project_subfolders",
  "documents",
  "document_versions",
  "document_edits",
  "document_chunks",
  "chats",
  "chat_messages",
  "message_sources",
  "model_profiles",
  "workflows",
  "hidden_workflows",
  "workflow_runs",
  "workflow_step_runs",
  "tabular_reviews",
  "tabular_review_columns",
  "tabular_cells",
  "tabular_review_chats",
  "tabular_review_chat_messages",
  "jobs",
  "workspace_settings",
  "legacy_import_records",
] as const;

const REQUIRED_INDEXES = [
  "idx_projects_status_updated",
  "uq_project_subfolders_sibling_name",
  "uq_model_profiles_default",
  "uq_jobs_idempotency_key",
  "idx_jobs_dispatch",
  "idx_documents_project_folder",
  "idx_documents_parse_status",
  "uq_document_versions_storage_key",
  "idx_chat_messages_chat_sequence",
  "idx_document_chunks_document_version",
  "idx_message_sources_message_rank",
  "idx_workflow_runs_status",
  "idx_workflow_step_runs_run_ordinal",
  "idx_tabular_reviews_status",
  "idx_tabular_cells_review_document",
  "idx_legacy_import_records_status",
] as const;

function schemaNames(database: WorkspaceDatabase, type: "table" | "index") {
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

try {
  process.env.ALETHEIA_DATABASE_ENCRYPTION = "metadata_plaintext";
  const databasePath = path.join(root, "workspace.db");
  const bootstrap = createUnmigratedDatabase("workspace.db");
  bootstrap.close();

  const database = new WorkspaceDatabase(databasePath);
  try {
    assert.equal(database.migration?.currentVersion, 1);
    assert.deepEqual(
      database.migration?.applied.map((migration) => migration.version),
      [1],
    );
    assert.deepEqual(database.migration?.preflight, {
      foreignKeysEnabled: true,
      integrityCheck: "ok",
      foreignKeyViolations: 0,
    });

    const migrationRows = database
      .prepare(
        "SELECT version, name, checksum, applied_at FROM workspace_schema_migrations ORDER BY version",
      )
      .all();
    assert.equal(migrationRows.length, 1);
    assert.deepEqual(
      {
        version: Number(migrationRows[0].version),
        name: String(migrationRows[0].name),
        checksum: String(migrationRows[0].checksum),
      },
      {
        version: 1,
        name: "initial_workspace_schema",
        checksum: workspaceMigrationChecksum(INITIAL_WORKSPACE_MIGRATION),
      },
    );
    assert.match(
      String(migrationRows[0].applied_at),
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );

    const tables = schemaNames(database, "table");
    for (const table of REQUIRED_TABLES) assert.ok(tables.has(table), table);
    const indexes = schemaNames(database, "index");
    for (const index of REQUIRED_INDEXES) assert.ok(indexes.has(index), index);

    const legacyTables = [...tables].filter((name) =>
      name.startsWith("aletheia_"),
    );
    assert.deepEqual(legacyTables, ["aletheia_phase1_sentinel"]);
    assert.equal(
      database
        .prepare("SELECT payload FROM aletheia_phase1_sentinel WHERE id = 1")
        .get()?.payload,
      "legacy-data-must-survive",
    );

    const projectsSql = tableSql(database, "projects");
    assert.match(projectsSql, /\bname TEXT NOT NULL/);
    assert.doesNotMatch(projectsSql, /\btitle TEXT/);
    assert.match(projectsSql, /default_model_profile_id/);

    const jobsSql = tableSql(database, "jobs");
    assert.match(
      jobsSql,
      /'document_parse', 'assistant_generate', 'workflow_run', 'tabular_cell'/,
    );
    assert.match(
      jobsSql,
      /'queued', 'running', 'complete', 'failed', 'cancelled', 'interrupted'/,
    );
    for (const column of [
      "attempt",
      "max_attempts",
      "retryable",
      "payload_json",
      "result_json",
      "error_json",
      "cancel_requested_at",
      "idempotency_key",
    ]) {
      assert.ok(columnNames(database, "jobs").includes(column), column);
    }

    const documentsSql = tableSql(database, "documents");
    assert.match(
      documentsSql,
      /parse_status IN \('pending', 'processing', 'ready', 'failed', 'unsupported', 'ocr_required'\)/,
    );
    assert.ok(
      columnNames(database, "document_versions").includes("page_count"),
    );
    assert.ok(columnNames(database, "document_chunks").includes("page_start"));
    assert.ok(columnNames(database, "document_chunks").includes("page_end"));
    assert.match(tableSql(database, "workflow_runs"), /'waiting'/);
    assert.match(tableSql(database, "workflow_step_runs"), /'waiting'/);
    assert.match(tableSql(database, "tabular_reviews"), /'cancelled'/);

    const workspaceSchemaSql = REQUIRED_TABLES.map((table) =>
      tableSql(database, table),
    ).join("\n");
    assert.doesNotMatch(workspaceSchemaSql, /'completed'/);
    assert.ok(columnNames(database, "workflow_runs").includes("input_json"));
    assert.ok(columnNames(database, "workflow_runs").includes("output_json"));
    assert.ok(columnNames(database, "workflow_runs").includes("error_json"));
    assert.ok(
      columnNames(database, "workflow_step_runs").includes("input_json"),
    );
    assert.ok(
      columnNames(database, "workflow_step_runs").includes("output_json"),
    );
    assert.ok(
      columnNames(database, "workflow_step_runs").includes("error_json"),
    );

    const modelColumns = columnNames(database, "model_profiles");
    assert.match(
      tableSql(database, "model_profiles"),
      /'openai', 'deepseek', 'anthropic', 'gemini', 'openai_compatible'/,
    );
    assert.doesNotMatch(tableSql(database, "model_profiles"), /'local'/);
    assert.ok(modelColumns.includes("capabilities_json"));
    assert.ok(modelColumns.includes("credential_ref"));
    assert.equal(
      modelColumns.some((column) =>
        /secret|api_key|credential_value/i.test(column),
      ),
      false,
    );
    assert.equal(
      columnNames(database, "workspace_settings").some((column) =>
        /secret|api_key|credential_value/i.test(column),
      ),
      false,
    );
    assert.equal(
      columnNames(database, "document_versions").some((column) =>
        /path/i.test(column),
      ),
      false,
    );

    const foreignKeyCount = REQUIRED_TABLES.reduce(
      (count, table) =>
        count +
        database.prepare(`PRAGMA foreign_key_list("${table}")`).all().length,
      0,
    );
    assert.ok(foreignKeyCount >= 30, `foreign key count: ${foreignKeyCount}`);
    assert.throws(() =>
      database
        .prepare(
          "INSERT INTO project_subfolders (id, project_id, name) VALUES ('orphan', 'missing', 'orphan')",
        )
        .run(),
    );

    database
      .prepare("INSERT INTO projects (id, name, description) VALUES (?, ?, ?)")
      .run("project-1", "Workspace Project", "Migration audit project");
    const project = database
      .prepare("SELECT name, created_at, updated_at FROM projects WHERE id = ?")
      .get("project-1");
    assert.equal(project?.name, "Workspace Project");
    assert.match(String(project?.created_at), /^\d{4}-\d{2}-\d{2}T/);
    assert.match(String(project?.updated_at), /^\d{4}-\d{2}-\d{2}T/);

    database
      .prepare(
        `INSERT INTO documents
           (id, project_id, title, filename, mime_type, size_bytes)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "document-1",
        "project-1",
        "Audit document",
        "audit.txt",
        "text/plain",
        34,
      );
    database
      .prepare(
        `INSERT INTO document_versions
           (id, document_id, version_number, source, filename, mime_type,
            size_bytes, content_sha256, storage_key, page_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "version-1",
        "document-1",
        1,
        "upload",
        "audit.txt",
        "text/plain",
        34,
        "a".repeat(64),
        "documents/document-1/versions/version-1/original",
        1,
      );
    assert.throws(() =>
      database
        .prepare(
          `INSERT INTO document_versions
             (id, document_id, version_number, source, filename, mime_type,
              size_bytes, content_sha256, storage_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "version-duplicate",
          "document-1",
          1,
          "upload",
          "duplicate.txt",
          "text/plain",
          1,
          "b".repeat(64),
          "documents/document-1/versions/version-duplicate/original",
        ),
    );

    database
      .prepare(
        `INSERT INTO document_chunks
           (id, document_id, version_id, ordinal, text, start_offset,
            end_offset, page_start, page_end, content_sha256)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "chunk-1",
        "document-1",
        "version-1",
        0,
        "privileged workspace search payload",
        0,
        35,
        1,
        1,
        "c".repeat(64),
      );

    if (database.migration?.capabilities.jsonTextChecks) {
      assert.match(
        tableSql(database, "model_profiles"),
        /json_valid\(capabilities_json\)/,
      );
      assert.throws(() =>
        database
          .prepare(
            `INSERT INTO model_profiles
               (id, name, provider, model, capabilities_json)
             VALUES ('invalid-json', 'Invalid JSON', 'openai', 'gpt-test', '{')`,
          )
          .run(),
      );
    }
    if (database.migration?.capabilities.fts5) {
      assert.ok(tables.has("document_chunks_fts"));
      const search = database
        .prepare(
          "SELECT text FROM document_chunks_fts WHERE document_chunks_fts MATCH ?",
        )
        .get("privileged");
      assert.equal(search?.text, "privileged workspace search payload");
    } else {
      assert.equal(tables.has("document_chunks_fts"), false);
    }

    assert.equal(database.prepare("PRAGMA foreign_key_check").all().length, 0);
    assert.equal(
      Object.values(database.prepare("PRAGMA integrity_check").get() ?? {})[0],
      "ok",
    );

    const rerun = runWorkspaceMigrations(database, WORKSPACE_MIGRATIONS);
    assert.equal(rerun.currentVersion, 1);
    assert.deepEqual(rerun.applied, []);

    const driftedV1: WorkspaceMigration = {
      ...INITIAL_WORKSPACE_MIGRATION,
      checksumMaterial: `${INITIAL_WORKSPACE_MIGRATION.checksumMaterial}\n-- unauthorized drift`,
    };
    assert.throws(
      () => runWorkspaceMigrations(database, [driftedV1]),
      /checksum drift/i,
    );
    assert.equal(
      database
        .prepare("SELECT count(*) AS count FROM workspace_schema_migrations")
        .get()?.count,
      1,
    );
  } finally {
    database.close();
  }

  const rollbackDatabase = createUnmigratedDatabase("rollback.db");
  try {
    runWorkspaceMigrations(rollbackDatabase, WORKSPACE_MIGRATIONS);
    const failingMigration: WorkspaceMigration = {
      version: 2,
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
          ...WORKSPACE_MIGRATIONS,
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
      1,
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

  process.env.ALETHEIA_DATABASE_ENCRYPTION = "sqlcipher_required";
  process.env.ALETHEIA_DATABASE_KEY_SOURCE = "env";
  process.env.ALETHEIA_DATABASE_KEY_BASE64 = randomBytes(32).toString("base64");
  const encryptedPath = path.join(root, "workspace-encrypted.db");
  const encryptedDatabase = new WorkspaceDatabase(encryptedPath);
  let encryptedStatus: ReturnType<WorkspaceDatabase["status"]>;
  try {
    encryptedStatus = encryptedDatabase.status();
    assert.equal(encryptedStatus.encrypted, true);
    assert.equal(encryptedDatabase.migration?.currentVersion, 1);
    assert.equal(
      encryptedDatabase
        .prepare("SELECT count(*) AS count FROM workspace_schema_migrations")
        .get()?.count,
      1,
    );
  } finally {
    encryptedDatabase.close();
  }
  assert.notEqual(
    readFileSync(encryptedPath).subarray(0, 16).toString("utf8"),
    "SQLite format 3\0",
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        suite: "vera-workspace-migration-audit-v1",
        current_version: 1,
        encrypted_driver: encryptedStatus!.encrypted,
        checks: [
          "temporary SQLite and SQLCipher adapters only",
          "foreign_keys, foreign_key_check, and integrity_check preflight",
          "ordered v1 migration with SHA-256 checksum and server timestamp",
          "idempotent rerun",
          "checksum drift fails closed",
          "failed migration DDL and record roll back atomically",
          "all Mike/Vera Workspace tables and required indexes exist",
          "legacy aletheia sentinel table and row are preserved",
          "foreign keys, uniqueness, and JSON CHECK constraints enforce",
          "optional FTS5 is real and searchable when the adapter supports it",
          "projects.name and default_model_profile_id",
          "documents.parse_status: pending|processing|ready|failed|unsupported|ocr_required",
          "jobs.type: document_parse|assistant_generate|workflow_run|tabular_cell",
          "complete is the only completed status vocabulary",
          "workflow waiting and tabular cancellation states",
          "run, step, and job structured lifecycle persistence",
          "model capabilities are non-secret and model_profiles has no secret column",
          "storage columns use opaque keys rather than filesystem paths",
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
