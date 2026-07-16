import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  LEGAL_PROVIDER_CAPABILITIES_V18,
  LegalProviderCredentialOrphanCleanupV18Schema,
  LegalProviderCredentialReferenceV18Schema,
} from "../lib/workspace/legalProviderPersistenceContractsV18";
import {
  LEGAL_PROVIDER_HUB_V18_MIGRATION,
  WORKSPACE_MIGRATIONS,
  type WorkspaceMigration,
} from "../lib/workspace/migrations";
import {
  WorkspaceDatabase,
  workspaceMigrationChecksum,
} from "../lib/workspace/database";
import {
  WorkspaceLegalProviderRepositoryError,
  WorkspaceLegalProvidersRepository,
} from "../lib/workspace/repositories/legalProviders";

const originalEnvironment = { ...process.env };
const root = mkdtempSync(
  path.join(os.tmpdir(), "vera-legal-provider-persistence-audit-"),
);
const PROFILE_ID = "0195a5a0-7b1d-7000-8000-000000000018";
const OTHER_PROFILE_ID = "0195a5a0-7b1d-7000-8000-000000000019";
const ENDPOINT_SET_ID = "yuandian-official-mcp-v1";
const CREDENTIAL_REFERENCE =
  `keychain://vera/legal-provider/${PROFILE_ID}/` + "a".repeat(32);
const ORPHAN_REFERENCE =
  `keychain://vera/legal-provider/${PROFILE_ID}/` + "b".repeat(32);

function schemaNames(
  database: WorkspaceDatabase,
  type: "table" | "index" | "trigger",
) {
  return new Set(
    database
      .prepare("SELECT name FROM sqlite_schema WHERE type = ? ORDER BY name")
      .all(type)
      .map((row) => String(row.name)),
  );
}

function columnNames(database: WorkspaceDatabase, table: string) {
  return database
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => String(row.name));
}

function incrementingClock() {
  let millisecond = 0;
  return () =>
    new Date(Date.UTC(2026, 0, 2, 3, 4, 5, millisecond++)).toISOString();
}

try {
  process.env.ALETHEIA_DATABASE_ENCRYPTION = "metadata_plaintext";

  assert.equal(LEGAL_PROVIDER_HUB_V18_MIGRATION.version, 18);
  assert.match(
    workspaceMigrationChecksum(LEGAL_PROVIDER_HUB_V18_MIGRATION),
    /^sha256:[0-9a-f]{64}$/,
  );
  assert.deepEqual(
    WORKSPACE_MIGRATIONS.map((migration) => migration.version),
    Array.from({ length: 21 }, (_, index) => index + 1),
  );

  const databasePath = path.join(root, "provider-hub.db");
  const database = new WorkspaceDatabase(databasePath);
  try {
    assert.equal(database.migration?.currentVersion, 21);
    for (const table of [
      "legal_provider_profiles",
      "legal_provider_capabilities",
      "legal_provider_connection_tests",
      "legal_provider_credential_orphan_cleanups",
    ]) {
      assert.ok(schemaNames(database, "table").has(table));
    }
    for (const trigger of [
      "legal_provider_profiles_v18_update_guard",
      "legal_provider_capabilities_v18_update_guard",
      "legal_provider_connection_tests_v18_revision_guard",
      "legal_provider_connection_tests_v18_update_guard",
      "legal_provider_credential_orphans_v18_update_guard",
    ]) {
      assert.ok(schemaNames(database, "trigger").has(trigger));
    }
    assert.ok(
      schemaNames(database, "index").has(
        "idx_legal_provider_credential_orphans_updated",
      ),
    );
    assert.equal(
      database
        .prepare("SELECT count(*) AS count FROM legal_provider_profiles")
        .get()?.count,
      0,
      "migration must not seed a machine-local provider profile",
    );
    assert.deepEqual(
      columnNames(database, "legal_provider_profiles").filter((column) =>
        ["endpoint_url", "api_key", "secret", "ready", "licensed"].includes(
          column,
        ),
      ),
      [],
    );

    const repository = new WorkspaceLegalProvidersRepository(
      database,
      incrementingClock(),
    );
    assert.throws(
      () =>
        repository.createProfile({
          id: PROFILE_ID,
          provider: "yuandian",
          endpointSetId: ENDPOINT_SET_ID,
          credentialReference: `keychain://vera/legal-provider/${OTHER_PROFILE_ID}/${"c".repeat(32)}`,
          enabledCapabilities: ["law"],
        }),
      WorkspaceLegalProviderRepositoryError,
    );
    assert.equal(
      LegalProviderCredentialReferenceV18Schema.safeParse(
        `https://example.invalid/${PROFILE_ID}`,
      ).success,
      false,
    );

    const created = repository.createProfile({
      id: PROFILE_ID,
      provider: "yuandian",
      endpointSetId: ENDPOINT_SET_ID,
      enabled: false,
      credentialReference: null,
      enabledCapabilities: ["law", "case"],
    });
    assert.deepEqual(
      created.capabilities.map(({ capability, enabled }) => ({
        capability,
        enabled,
      })),
      [
        { capability: "case", enabled: true },
        { capability: "company", enabled: false },
        { capability: "law", enabled: true },
      ],
    );
    assert.deepEqual(
      new Set(created.capabilities.map((item) => item.capability)),
      new Set(LEGAL_PROVIDER_CAPABILITIES_V18),
    );

    const unchanged = repository.updateProfile({
      id: PROFILE_ID,
      expectedRevision: 0,
      enabled: false,
    });
    assert.equal(unchanged.revision, 0);
    const enabledOnly = repository.updateProfile({
      id: PROFILE_ID,
      expectedRevision: 0,
      enabled: true,
    });
    assert.deepEqual(
      [
        enabledOnly.revision,
        enabledOnly.connectionRevision,
        enabledOnly.credentialRevision,
      ],
      [1, 0, 0],
    );
    assert.throws(
      () =>
        repository.updateProfile({
          id: PROFILE_ID,
          expectedRevision: 0,
          enabled: false,
        }),
      /revision is stale/i,
    );

    const passed = repository.recordConnectionTest({
      profileId: PROFILE_ID,
      connectionRevision: 0,
      status: "passed",
      errorCode: null,
      retryable: false,
      latencyMs: 42,
      testedAt: "2026-01-02T03:04:06.000Z",
    });
    assert.equal(passed.status, "passed");
    assert.equal(
      columnNames(database, "legal_provider_profiles").includes("ready"),
      false,
      "a passed transport test is not persisted as provider readiness",
    );
    assert.throws(() =>
      repository.recordConnectionTest({
        profileId: PROFILE_ID,
        connectionRevision: 0,
        status: "passed",
        errorCode: "authentication_failed",
        retryable: false,
        latencyMs: null,
        testedAt: "2026-01-02T03:04:06.001Z",
      }),
    );

    const capabilityChange = repository.updateProfile({
      id: PROFILE_ID,
      expectedRevision: 1,
      enabledCapabilities: ["law", "case", "company"],
    });
    assert.deepEqual(
      [capabilityChange.revision, capabilityChange.connectionRevision],
      [2, 1],
    );
    assert.equal(
      repository.getConnectionTest(PROFILE_ID),
      null,
      "a connection-changing profile update must invalidate the old result",
    );
    assert.throws(
      () =>
        repository.recordConnectionTest({
          profileId: PROFILE_ID,
          connectionRevision: 0,
          status: "failed",
          errorCode: "timeout",
          retryable: true,
          latencyMs: 600_000,
          testedAt: "2026-01-02T03:04:06.002Z",
        }),
      /revision is stale/i,
    );

    const credentialChange = repository.updateProfile({
      id: PROFILE_ID,
      expectedRevision: 2,
      credentialReference: CREDENTIAL_REFERENCE,
    });
    assert.deepEqual(
      [
        credentialChange.revision,
        credentialChange.connectionRevision,
        credentialChange.credentialRevision,
      ],
      [3, 2, 1],
    );
    assert.throws(
      () =>
        database
          .prepare(
            `UPDATE legal_provider_profiles
                SET enabled = enabled, updated_at = ?
              WHERE id = ?`,
          )
          .run("2026-01-02T03:04:07.000Z", PROFILE_ID),
      /CAS revision is invalid/i,
    );
    assert.throws(
      () =>
        database
          .prepare(
            `UPDATE legal_provider_profiles
                SET created_at = ?, revision = revision + 1, updated_at = ?
              WHERE id = ?`,
          )
          .run(
            "2026-01-02T03:04:04.000Z",
            "2026-01-02T03:04:07.001Z",
            PROFILE_ID,
          ),
      /ownership is immutable/i,
    );
    database
      .prepare(
        `UPDATE legal_provider_profiles
            SET revision = revision + 1, updated_at = ?
          WHERE id = ?`,
      )
      .run("2026-01-02T03:04:07.001Z", PROFILE_ID);
    assert.throws(
      () =>
        database
          .prepare(
            `UPDATE legal_provider_capabilities
                SET enabled = 0,
                    connection_revision = connection_revision + 1,
                    updated_at = ?
              WHERE profile_id = ? AND capability = 'case'`,
          )
          .run("2026-01-02T03:04:07.001Z", PROFILE_ID),
      /requires a profile connection revision/i,
    );
    assert.throws(() =>
      database
        .prepare(
          `UPDATE legal_provider_profiles
              SET credential_reference = ?, revision = revision + 1,
                  connection_revision = connection_revision + 1,
                  credential_revision = credential_revision + 1,
                  updated_at = ?
            WHERE id = ?`,
        )
        .run(
          "https://example.invalid/secret",
          "2026-01-02T03:04:07.002Z",
          PROFILE_ID,
        ),
    );

    const currentTest = repository.recordConnectionTest({
      profileId: PROFILE_ID,
      connectionRevision: 2,
      status: "failed",
      errorCode: "license_restricted",
      retryable: false,
      latencyMs: 85,
      testedAt: "2026-01-02T03:04:08.000Z",
    });
    assert.equal(currentTest.errorCode, "license_restricted");

    assert.equal(
      LegalProviderCredentialOrphanCleanupV18Schema.safeParse({
        reference: `keychain://vera/legal-provider/${OTHER_PROFILE_ID}/${"d".repeat(32)}`,
        profileId: PROFILE_ID,
        provider: "yuandian",
        endpointSetId: ENDPOINT_SET_ID,
        reason: "credential_rotated",
        attemptCount: 0,
        lastErrorCode: null,
        createdAt: "2026-01-02T03:04:09.000Z",
        updatedAt: "2026-01-02T03:04:09.000Z",
      }).success,
      false,
    );
    const orphan = repository.recordCredentialOrphan({
      reference: ORPHAN_REFERENCE,
      profileId: PROFILE_ID,
      provider: "yuandian",
      endpointSetId: ENDPOINT_SET_ID,
      reason: "credential_rotated",
    });
    assert.equal(orphan.attemptCount, 0);
    const attempted = repository.recordCredentialOrphanAttempt({
      reference: ORPHAN_REFERENCE,
      lastErrorCode: "keychain_delete_failed",
    });
    assert.equal(attempted.attemptCount, 1);
    assert.equal(attempted.lastErrorCode, "keychain_delete_failed");

    const persistedProfile = database
      .prepare(
        `SELECT endpoint_set_id, credential_reference
           FROM legal_provider_profiles WHERE id = ?`,
      )
      .get(PROFILE_ID);
    assert.deepEqual(
      { ...persistedProfile },
      {
        endpoint_set_id: ENDPOINT_SET_ID,
        credential_reference: CREDENTIAL_REFERENCE,
      },
    );
    assert.equal(JSON.stringify(persistedProfile).includes("https://"), false);

    database
      .prepare("DELETE FROM legal_provider_profiles WHERE id = ?")
      .run(PROFILE_ID);
    assert.equal(
      database
        .prepare(
          "SELECT count(*) AS count FROM legal_provider_capabilities WHERE profile_id = ?",
        )
        .get(PROFILE_ID)?.count,
      0,
    );
    assert.equal(
      database
        .prepare(
          "SELECT count(*) AS count FROM legal_provider_connection_tests WHERE profile_id = ?",
        )
        .get(PROFILE_ID)?.count,
      0,
    );
    assert.equal(repository.listCredentialOrphans().length, 1);
    repository.resolveCredentialOrphan(ORPHAN_REFERENCE);
    assert.deepEqual(repository.listCredentialOrphans(), []);
    assert.equal(database.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally {
    database.close();
  }

  const upgradePath = path.join(root, "v17-upgrade.db");
  const v17 = new WorkspaceDatabase(upgradePath, {
    migrations: WORKSPACE_MIGRATIONS.slice(0, 17),
  });
  try {
    assert.equal(v17.migration?.currentVersion, 17);
    v17.exec(
      "CREATE TABLE v18_upgrade_probe (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)",
    );
    v17
      .prepare("INSERT INTO v18_upgrade_probe (id, payload) VALUES (1, ?)")
      .run("v17-data-must-survive-v18");
  } finally {
    v17.close();
  }
  const upgraded = new WorkspaceDatabase(upgradePath);
  try {
    assert.equal(upgraded.migration?.currentVersion, 21);
    assert.equal(
      upgraded
        .prepare("SELECT payload FROM v18_upgrade_probe WHERE id = 1")
        .get()?.payload,
      "v17-data-must-survive-v18",
    );
    assert.equal(
      upgraded
        .prepare("SELECT count(*) AS count FROM legal_provider_profiles")
        .get()?.count,
      0,
    );
  } finally {
    upgraded.close();
  }

  const rollbackPath = path.join(root, "v18-rollback.db");
  const rollback = new WorkspaceDatabase(rollbackPath, {
    migrations: WORKSPACE_MIGRATIONS.slice(0, 17),
  });
  try {
    const failingV18: WorkspaceMigration = {
      ...LEGAL_PROVIDER_HUB_V18_MIGRATION,
      checksumMaterial: `${LEGAL_PROVIDER_HUB_V18_MIGRATION.checksumMaterial}\nforced rollback probe`,
      apply(databaseAdapter, capabilities) {
        LEGAL_PROVIDER_HUB_V18_MIGRATION.apply(databaseAdapter, capabilities);
        throw new Error("forced v18 rollback");
      },
    };
    assert.throws(
      () =>
        rollback.runMigrations([
          ...WORKSPACE_MIGRATIONS.slice(0, 17),
          failingV18,
        ]),
      /failed and was rolled back/i,
    );
    assert.equal(
      schemaNames(rollback, "table").has("legal_provider_profiles"),
      false,
    );
    assert.equal(
      rollback
        .prepare("SELECT count(*) AS count FROM workspace_schema_migrations")
        .get()?.count,
      17,
    );
  } finally {
    rollback.close();
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        suite: "vera-workspace-legal-provider-persistence-v18",
        checks: [
          "additive v18 upgrade and atomic rollback",
          "no provider seeds, endpoint URLs, readiness flags, or secret columns",
          "strict Keychain reference binding",
          "three explicit capability records",
          "CAS profile, connection, and credential revisions",
          "revision-bound connection results without readiness inference",
          "durable immutable credential orphan cleanup ledger",
          "foreign-key cascade and integrity",
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
