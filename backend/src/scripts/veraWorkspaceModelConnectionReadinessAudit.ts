import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  runWorkspaceMigrations,
  WorkspaceDatabase,
} from "../lib/workspace/database";
import {
  ASSISTANT_DURABLE_EVENTS_V10_MIGRATION,
  MODEL_CONNECTION_READINESS_V9_MIGRATION,
  WORKSPACE_MIGRATIONS,
  type WorkspaceDatabaseAdapter,
  type WorkspaceStatement,
} from "../lib/workspace/migrations";
import { MODEL_CONNECTION_TEST_ERROR_CODES } from "../lib/workspace/modelConnectionReadiness";

const root = mkdtempSync(
  path.join(os.tmpdir(), "vera-model-readiness-v9-audit-"),
);
const V8_MIGRATIONS = WORKSPACE_MIGRATIONS.slice(0, 8);
const enabledProfileId = "00000000-0000-4000-8000-000000000901";
const disabledProfileId = "00000000-0000-4000-8000-000000000902";
const projectId = "00000000-0000-4000-8000-000000000903";
const now = "2026-07-15T08:00:00.000Z";

function object(row: Record<string, unknown> | undefined) {
  assert.ok(row);
  return { ...row };
}

function columnNames(database: WorkspaceDatabase, table: string) {
  return database
    .prepare(`PRAGMA table_info("${table.replaceAll('"', '""')}")`)
    .all()
    .map((column) => String(column.name));
}

function insertProfile(
  database: WorkspaceDatabase,
  input: {
    id: string;
    name: string;
    enabled: boolean;
    isDefault: boolean;
    configured: boolean;
    executionRevision: number;
  },
) {
  const credentialRef = input.configured
    ? `keychain://vera/model-profile/${input.id}/abcdefghijklmnop`
    : null;
  database
    .prepare(
      `INSERT INTO model_profiles
        (id, name, provider, model, base_url, credential_ref,
         credential_origin, credential_state, credential_status,
         migration_issue_code, execution_revision, context_window_tokens,
         max_output_tokens, enabled, is_default, capabilities_json,
         created_at, updated_at)
       VALUES (?, ?, 'openai', 'gpt-5.4', NULL, ?,
               'https://api.openai.com', ?, ?,
               NULL, ?, 128000, 8192, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.name,
      credentialRef,
      input.configured ? "configured" : "missing",
      input.configured ? "configured" : "not_configured",
      input.executionRevision,
      input.enabled ? 1 : 0,
      input.isDefault ? 1 : 0,
      JSON.stringify({
        streaming: true,
        toolCalling: true,
        structuredOutput: true,
        vision: true,
      }),
      now,
      now,
    );
}

function insertProjectDefault(database: WorkspaceDatabase, profileId: string) {
  database
    .prepare(
      `INSERT INTO projects
        (id, name, default_model_profile_id, status, created_at, updated_at)
       VALUES (?, 'Vera readiness project', ?, 'active', ?, ?)`,
    )
    .run(projectId, profileId, now, now);
  database
    .prepare(
      `UPDATE workspace_settings
          SET default_model_profile_id = ?, updated_at = ?
        WHERE id = 'workspace'`,
    )
    .run(profileId, now);
}

function preservedProfile(database: WorkspaceDatabase, profileId: string) {
  return object(
    database
      .prepare(
        `SELECT id, name, provider, model, base_url, credential_ref,
                credential_origin, credential_state, credential_status,
                migration_issue_code, execution_revision,
                context_window_tokens, max_output_tokens, capabilities_json,
                created_at, updated_at
           FROM model_profiles
          WHERE id = ?`,
      )
      .get(profileId),
  );
}

function currentPassed(database: WorkspaceDatabase, profileId: string) {
  return Boolean(
    database
      .prepare(
        `SELECT 1 AS present
           FROM model_profiles profile
           JOIN model_profile_connection_tests test
             ON test.profile_id = profile.id
          WHERE profile.id = ?
            AND test.status = 'passed'
            AND test.connection_revision = profile.connection_revision
          LIMIT 1`,
      )
      .get(profileId),
  );
}

function auditUpgradeAndConnectionRevisionSemantics() {
  const databasePath = path.join(root, "upgrade.db");
  const v8 = new WorkspaceDatabase(databasePath, {
    migrations: V8_MIGRATIONS,
  });
  let enabledBefore: Record<string, unknown>;
  let disabledBefore: Record<string, unknown>;
  let orphanBefore: Record<string, unknown>;
  try {
    assert.equal(v8.migration?.currentVersion, 8);
    insertProfile(v8, {
      id: enabledProfileId,
      name: "Configured enabled profile",
      enabled: true,
      isDefault: true,
      configured: true,
      executionRevision: 17,
    });
    insertProfile(v8, {
      id: disabledProfileId,
      name: "Existing disabled profile",
      enabled: false,
      isDefault: false,
      configured: false,
      executionRevision: 4,
    });
    insertProjectDefault(v8, enabledProfileId);
    v8.prepare(
      `INSERT INTO model_profile_credential_orphan_cleanups
        (reference, profile_id, provider, canonical_origin, reason,
         attempt_count, last_error, created_at, updated_at)
       VALUES (?, ?, 'openai', 'https://api.openai.com', 'binding_change',
               3, 'fixed audit sentinel', ?, ?)`,
    ).run(
      `keychain://vera/model-profile/${enabledProfileId}/qrstuvwxyzabcdef`,
      enabledProfileId,
      now,
      now,
    );
    enabledBefore = preservedProfile(v8, enabledProfileId);
    disabledBefore = preservedProfile(v8, disabledProfileId);
    orphanBefore = object(
      v8
        .prepare(
          `SELECT *
             FROM model_profile_credential_orphan_cleanups
            WHERE profile_id = ?`,
        )
        .get(enabledProfileId),
    );
  } finally {
    v8.close();
  }

  const upgraded = new WorkspaceDatabase(databasePath);
  try {
    assert.equal(upgraded.migration?.currentVersion, 16);
    assert.deepEqual(
      upgraded.migration?.applied.map((entry) => entry.version),
      [9, 10, 11, 12, 13, 14, 15, 16],
    );
    assert.equal(
      columnNames(upgraded, "model_profiles").includes("connection_revision"),
      true,
    );
    assert.deepEqual(
      preservedProfile(upgraded, enabledProfileId),
      enabledBefore,
    );
    assert.deepEqual(
      preservedProfile(upgraded, disabledProfileId),
      disabledBefore,
    );
    assert.deepEqual(
      object(
        upgraded
          .prepare(
            `SELECT *
               FROM model_profile_credential_orphan_cleanups
              WHERE profile_id = ?`,
          )
          .get(enabledProfileId),
      ),
      orphanBefore,
    );
    assert.deepEqual(
      upgraded
        .prepare(
          `SELECT id, enabled, is_default, connection_revision
             FROM model_profiles
            ORDER BY id`,
        )
        .all()
        .map((row) => ({ ...row })),
      [
        {
          id: enabledProfileId,
          enabled: 0,
          is_default: 0,
          connection_revision: 0,
        },
        {
          id: disabledProfileId,
          enabled: 0,
          is_default: 0,
          connection_revision: 0,
        },
      ],
    );
    assert.equal(
      upgraded
        .prepare(
          "SELECT default_model_profile_id FROM workspace_settings WHERE id = 'workspace'",
        )
        .get()?.default_model_profile_id,
      null,
    );
    assert.equal(
      upgraded
        .prepare("SELECT default_model_profile_id FROM projects WHERE id = ?")
        .get(projectId)?.default_model_profile_id,
      null,
    );
    assert.equal(
      upgraded
        .prepare("SELECT count(*) AS count FROM model_profile_connection_tests")
        .get()?.count,
      0,
    );

    upgraded
      .prepare(
        `INSERT INTO model_profile_connection_tests
          (profile_id, connection_revision, status, error_code, retryable,
           latency_ms, tested_at)
         VALUES (?, 0, 'passed', NULL, 0, 137, ?)`,
      )
      .run(disabledProfileId, now);
    assert.equal(currentPassed(upgraded, disabledProfileId), true);

    upgraded
      .prepare(
        `UPDATE model_profiles
            SET enabled = 1,
                execution_revision = execution_revision + 1
          WHERE id = ?`,
      )
      .run(disabledProfileId);
    assert.equal(
      upgraded
        .prepare(
          `SELECT connection_revision
             FROM model_profiles
            WHERE id = ?`,
        )
        .get(disabledProfileId)?.connection_revision,
      0,
      "enabling and execution-only changes must not stale connection readiness",
    );
    assert.equal(currentPassed(upgraded, disabledProfileId), true);

    upgraded
      .prepare(
        `UPDATE model_profiles
            SET connection_revision = connection_revision + 1
          WHERE id = ?`,
      )
      .run(disabledProfileId);
    assert.equal(currentPassed(upgraded, disabledProfileId), false);
    assert.deepEqual(
      object(
        upgraded
          .prepare(
            `SELECT connection_revision, status, error_code, retryable,
                    latency_ms, tested_at
               FROM model_profile_connection_tests
              WHERE profile_id = ?`,
          )
          .get(disabledProfileId),
      ),
      {
        connection_revision: 0,
        status: "passed",
        error_code: null,
        retryable: 0,
        latency_ms: 137,
        tested_at: now,
      },
      "an older result must remain available as stale history",
    );

    upgraded
      .prepare("DELETE FROM model_profiles WHERE id = ?")
      .run(disabledProfileId);
    assert.equal(
      upgraded
        .prepare(
          "SELECT count(*) AS count FROM model_profile_connection_tests WHERE profile_id = ?",
        )
        .get(disabledProfileId)?.count,
      0,
      "profile ownership must cascade to its readiness result",
    );
    assert.deepEqual(upgraded.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    upgraded.close();
  }
}

type ConnectionRowInput = {
  profileId?: unknown;
  connectionRevision?: unknown;
  status?: unknown;
  errorCode?: unknown;
  retryable?: unknown;
  latencyMs?: unknown;
  testedAt?: unknown;
};

function insertConnectionResult(
  database: WorkspaceDatabase,
  overrides: ConnectionRowInput = {},
) {
  database
    .prepare(
      `INSERT INTO model_profile_connection_tests
        (profile_id, connection_revision, status, error_code, retryable,
         latency_ms, tested_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      overrides.profileId ?? disabledProfileId,
      overrides.connectionRevision ?? 0,
      overrides.status ?? "failed",
      overrides.errorCode === undefined ? "network_error" : overrides.errorCode,
      overrides.retryable ?? 1,
      overrides.latencyMs === undefined ? 20 : overrides.latencyMs,
      overrides.testedAt ?? now,
    );
}

function auditNewInstallAndStrictConstraints() {
  const database = new WorkspaceDatabase(path.join(root, "new-install.db"));
  try {
    assert.equal(database.migration?.currentVersion, 16);
    assert.deepEqual(
      database.migration?.applied.map((entry) => entry.version),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
    );
    assert.equal(
      WORKSPACE_MIGRATIONS.at(8),
      MODEL_CONNECTION_READINESS_V9_MIGRATION,
    );
    assert.equal(
      WORKSPACE_MIGRATIONS.at(9),
      ASSISTANT_DURABLE_EVENTS_V10_MIGRATION,
    );
    insertProfile(database, {
      id: disabledProfileId,
      name: "Constraint profile",
      enabled: false,
      isDefault: false,
      configured: false,
      executionRevision: 0,
    });

    const invalidRows: ConnectionRowInput[] = [
      { profileId: " " },
      { profileId: "00000000-0000-4000-8000-000000009999" },
      { connectionRevision: -1 },
      { connectionRevision: 2_147_483_648 },
      { connectionRevision: 1.5 },
      { connectionRevision: "not-an-integer" },
      { status: "unknown" },
      { errorCode: "raw_provider_message" },
      { retryable: 2 },
      { retryable: 1.5 },
      { retryable: "yes" },
      { latencyMs: -1 },
      { latencyMs: 600_001 },
      { latencyMs: 1.5 },
      { latencyMs: "slow" },
      { status: "passed", errorCode: "network_error", retryable: 0 },
      { status: "passed", errorCode: null, retryable: 1 },
      { status: "failed", errorCode: null, retryable: 0 },
      { testedAt: "" },
      { testedAt: "0" },
      { testedAt: "2026-02-30T08:00:00.000Z" },
      { testedAt: "2026-07-15T08:00:00Z" },
      { testedAt: "2026-07-15T08:00:00.000+00:00" },
    ];
    for (const row of invalidRows) {
      assert.throws(() => insertConnectionResult(database, row), /constraint/i);
    }
    assert.equal(
      database
        .prepare("SELECT count(*) AS count FROM model_profile_connection_tests")
        .get()?.count,
      0,
    );

    insertConnectionResult(database, { latencyMs: 600_000 });
    assert.deepEqual(
      object(
        database
          .prepare(
            `SELECT connection_revision, status, error_code, retryable,
                    latency_ms, tested_at
               FROM model_profile_connection_tests
              WHERE profile_id = ?`,
          )
          .get(disabledProfileId),
      ),
      {
        connection_revision: 0,
        status: "failed",
        error_code: "network_error",
        retryable: 1,
        latency_ms: 600_000,
        tested_at: now,
      },
    );

    const tableSql = String(
      database
        .prepare(
          `SELECT sql
             FROM main.sqlite_schema
            WHERE type = 'table'
              AND name = 'model_profile_connection_tests'`,
        )
        .get()?.sql,
    );
    assert.match(tableSql, /WITHOUT ROWID/i);
    assert.match(tableSql, /typeof\(connection_revision\)\s*=\s*'integer'/i);
    assert.match(tableSql, /latency_ms BETWEEN 0 AND 600000/i);
    assert.match(tableSql, /strftime\('%Y-%m-%dT%H:%M:%fZ'/);
    for (const code of MODEL_CONNECTION_TEST_ERROR_CODES) {
      assert.equal(tableSql.includes(`'${code}'`), true);
    }
    assert.equal(
      /api[_-]?key|bearer|secret|provider.body/i.test(tableSql),
      false,
    );
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    database.close();
  }
}

function assertUnrecordedMarkerFailsClosed(
  databasePath: string,
  expectedMarker: RegExp,
) {
  assert.throws(
    () => new WorkspaceDatabase(databasePath),
    (error) =>
      error instanceof Error &&
      /v9 markers exist without a recorded v9 migration/i.test(error.message) &&
      expectedMarker.test(error.message),
  );
  const inspection = new WorkspaceDatabase(databasePath, { migrate: false });
  try {
    assert.equal(
      inspection
        .prepare(
          "SELECT max(version) AS version FROM workspace_schema_migrations",
        )
        .get()?.version,
      8,
    );
  } finally {
    inspection.close();
  }
}

function auditUnrecordedMarkersFailClosed() {
  const columnPath = path.join(root, "unrecorded-column.db");
  const columnDatabase = new WorkspaceDatabase(columnPath, {
    migrations: V8_MIGRATIONS,
  });
  columnDatabase.exec(
    "ALTER TABLE model_profiles ADD COLUMN CONNECTION_REVISION INTEGER",
  );
  columnDatabase.close();
  assertUnrecordedMarkerFailsClosed(columnPath, /connection_revision/i);
  const columnInspection = new WorkspaceDatabase(columnPath, {
    migrate: false,
  });
  try {
    assert.equal(
      columnNames(columnInspection, "model_profiles").some(
        (name) => name.toLowerCase() === "connection_revision",
      ),
      true,
      "the preexisting marker must remain untouched after rollback",
    );
  } finally {
    columnInspection.close();
  }

  for (const [kind, sql] of [
    [
      "table",
      "CREATE TABLE MODEL_PROFILE_CONNECTION_TESTS (profile_id TEXT PRIMARY KEY)",
    ],
    [
      "view",
      "CREATE VIEW Model_Profile_Connection_Tests AS SELECT id AS profile_id FROM model_profiles",
    ],
    [
      "index",
      "CREATE INDEX model_profile_connection_tests ON model_profiles(updated_at)",
    ],
  ] as const) {
    const databasePath = path.join(root, `unrecorded-${kind}.db`);
    const database = new WorkspaceDatabase(databasePath, {
      migrations: V8_MIGRATIONS,
    });
    database.exec(sql);
    database.close();
    assertUnrecordedMarkerFailsClosed(
      databasePath,
      new RegExp(`${kind}:model_profile_connection_tests`, "i"),
    );
    const inspection = new WorkspaceDatabase(databasePath, { migrate: false });
    try {
      assert.equal(
        inspection
          .prepare(
            `SELECT count(*) AS count
               FROM main.sqlite_schema
              WHERE type = ?
                AND name = 'model_profile_connection_tests' COLLATE NOCASE`,
          )
          .get(kind)?.count,
        1,
      );
    } finally {
      inspection.close();
    }
  }
}

function faultAfterV9Apply(
  database: WorkspaceDatabase,
  onCompletedApply: () => void,
): WorkspaceDatabaseAdapter {
  return {
    exec(sql) {
      database.exec(sql);
    },
    prepare(sql) {
      const statement = database.prepare(sql);
      if (!/INSERT INTO workspace_schema_migrations/i.test(sql)) {
        return statement;
      }
      const wrapped: WorkspaceStatement = {
        run(...parameters: unknown[]) {
          if (Number(parameters[0]) === 9) {
            onCompletedApply();
            throw new Error("injected fault after complete v9 apply");
          }
          return statement.run(...parameters);
        },
        get(...parameters: unknown[]) {
          return statement.get(...parameters);
        },
        all(...parameters: unknown[]) {
          return statement.all(...parameters);
        },
      };
      return wrapped;
    },
  };
}

function auditPostApplyFailureRollsBack() {
  const databasePath = path.join(root, "post-apply-rollback.db");
  const database = new WorkspaceDatabase(databasePath, {
    migrations: V8_MIGRATIONS,
  });
  try {
    insertProfile(database, {
      id: enabledProfileId,
      name: "Rollback enabled profile",
      enabled: true,
      isDefault: true,
      configured: true,
      executionRevision: 9,
    });
    insertProjectDefault(database, enabledProfileId);
    let observedCompleteApply = false;
    const adapter = faultAfterV9Apply(database, () => {
      observedCompleteApply =
        columnNames(database, "model_profiles").includes(
          "connection_revision",
        ) &&
        Boolean(
          database
            .prepare(
              `SELECT 1 AS present
                 FROM main.sqlite_schema
                WHERE type = 'table'
                  AND name = 'model_profile_connection_tests'`,
            )
            .get(),
        ) &&
        Number(
          database
            .prepare(
              "SELECT enabled + is_default AS active FROM model_profiles WHERE id = ?",
            )
            .get(enabledProfileId)?.active,
        ) === 0 &&
        database
          .prepare(
            "SELECT default_model_profile_id FROM workspace_settings WHERE id = 'workspace'",
          )
          .get()?.default_model_profile_id === null &&
        database
          .prepare("SELECT default_model_profile_id FROM projects WHERE id = ?")
          .get(projectId)?.default_model_profile_id === null;
    });
    assert.throws(
      () => runWorkspaceMigrations(adapter, WORKSPACE_MIGRATIONS),
      /failed and was rolled back/i,
    );
    assert.equal(observedCompleteApply, true);
    assert.equal(
      columnNames(database, "model_profiles").includes("connection_revision"),
      false,
    );
    assert.equal(
      database
        .prepare(
          `SELECT count(*) AS count
             FROM main.sqlite_schema
            WHERE name = 'model_profile_connection_tests' COLLATE NOCASE`,
        )
        .get()?.count,
      0,
    );
    assert.deepEqual(
      object(
        database
          .prepare(
            "SELECT enabled, is_default FROM model_profiles WHERE id = ?",
          )
          .get(enabledProfileId),
      ),
      { enabled: 1, is_default: 1 },
    );
    assert.equal(
      database
        .prepare(
          "SELECT default_model_profile_id FROM workspace_settings WHERE id = 'workspace'",
        )
        .get()?.default_model_profile_id,
      enabledProfileId,
    );
    assert.equal(
      database
        .prepare("SELECT default_model_profile_id FROM projects WHERE id = ?")
        .get(projectId)?.default_model_profile_id,
      enabledProfileId,
    );
    assert.equal(
      database
        .prepare(
          "SELECT max(version) AS version FROM workspace_schema_migrations",
        )
        .get()?.version,
      8,
    );
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    database.close();
  }
}

const previousEncryption = process.env.ALETHEIA_DATABASE_ENCRYPTION;
try {
  process.env.ALETHEIA_DATABASE_ENCRYPTION = "metadata_plaintext";
  assert.deepEqual(
    WORKSPACE_MIGRATIONS.map((migration) => migration.version),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
  );
  assert.deepEqual(
    V8_MIGRATIONS.map((migration) => migration.version),
    [1, 2, 3, 4, 5, 6, 7, 8],
  );
  auditUpgradeAndConnectionRevisionSemantics();
  auditNewInstallAndStrictConstraints();
  auditUnrecordedMarkersFailClosed();
  auditPostApplyFailureRollsBack();
  console.log("vera workspace model connection readiness audit passed");
} finally {
  rmSync(root, { recursive: true, force: true });
  if (previousEncryption === undefined) {
    delete process.env.ALETHEIA_DATABASE_ENCRYPTION;
  } else {
    process.env.ALETHEIA_DATABASE_ENCRYPTION = previousEncryption;
  }
}
