import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { WorkspaceDatabase } from "../lib/workspace/database";
import { WorkspaceApiError } from "../lib/workspace/errors";
import { WORKSPACE_MIGRATIONS } from "../lib/workspace/migrations";
import {
  MAX_MODEL_CONNECTION_REVISION,
  MAX_MODEL_CONNECTION_TEST_LATENCY_MS,
  modelConnectionTestView,
  normalizeModelConnectionTestErrorCode,
} from "../lib/workspace/modelConnectionReadiness";
import {
  ModelConnectionTestsRepository,
  type StoreModelConnectionTestInput,
} from "../lib/workspace/repositories/modelConnectionTests";
import { ModelProfilesRepository } from "../lib/workspace/repositories/modelProfiles";
import { SettingsRepository } from "../lib/workspace/repositories/settings";
import { buildStoredCredentialReference } from "../lib/workspace/services/credentialStore";

const root = mkdtempSync(
  path.join(os.tmpdir(), "vera-model-connection-repositories-audit-"),
);
const profileId = "00000000-0000-4000-8000-000000000921";
const corruptProfileId = "00000000-0000-4000-8000-000000000922";
const preV9ProfileId = "00000000-0000-4000-8000-000000000923";
const projectId = "00000000-0000-4000-8000-000000000924";
const origin = "https://api.openai.com";
const capabilities = {
  streaming: true,
  toolCalling: true,
  structuredOutput: true,
  vision: true,
};

function timestamp(second: number) {
  return `2026-07-15T08:00:${String(second).padStart(2, "0")}.000Z`;
}

function profileInput(
  id: string,
  input: { enabled?: boolean; isDefault?: boolean } = {},
) {
  return {
    id,
    name: `Connection profile ${id.slice(-4)}`,
    provider: "openai" as const,
    model: "gpt-5.4",
    baseUrl: null,
    credentialOrigin: origin,
    credentialState: "missing" as const,
    contextWindowTokens: 128_000,
    maxOutputTokens: 8_192,
    enabled: input.enabled ?? false,
    isDefault: input.isDefault ?? false,
    capabilities,
    now: timestamp(0),
  };
}

function assertConflict(operation: () => unknown) {
  let failure: unknown = null;
  try {
    operation();
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof WorkspaceApiError);
  assert.equal(failure.status, 409);
  assert.equal(failure.code, "CONFLICT");
}

function createConfiguredProfile(
  profiles: ModelProfilesRepository,
  id: string,
) {
  profiles.create(profileInput(id));
  const reference = buildStoredCredentialReference(
    id,
    `locator${id.slice(-9)}`,
  );
  const configured = profiles.setCredentialBindingInternal(id, {
    reference,
    state: "configured",
    origin,
    migrationIssueCode: null,
    now: timestamp(1),
  });
  return { configured, reference };
}

function storePassed(
  tests: ModelConnectionTestsRepository,
  id: string,
  connectionRevision: number,
  testedAt: string,
) {
  const result = tests.storeIfCurrent({
    profileId: id,
    expectedConnectionRevision: connectionRevision,
    status: "passed",
    errorCode: null,
    retryable: false,
    latencyMs: 42,
    testedAt,
  });
  assert.equal(result.stored, true);
  return result;
}

function insertProject(database: WorkspaceDatabase) {
  database
    .prepare(
      `INSERT INTO projects
        (id, name, default_model_profile_id, status, created_at, updated_at)
       VALUES (?, 'Connection repository project', NULL, 'active', ?, ?)`,
    )
    .run(projectId, timestamp(0), timestamp(0));
}

function setProjectDefault(
  database: WorkspaceDatabase,
  id: string | null,
  now: string,
) {
  database
    .prepare(
      `UPDATE projects
          SET default_model_profile_id = ?, updated_at = ?
        WHERE id = ?`,
    )
    .run(id, now, projectId);
}

function defaults(database: WorkspaceDatabase) {
  return {
    workspace: database
      .prepare(
        "SELECT default_model_profile_id AS value FROM workspace_settings WHERE id = 'workspace'",
      )
      .get()?.value,
    project: database
      .prepare(
        "SELECT default_model_profile_id AS value FROM projects WHERE id = ?",
      )
      .get(projectId)?.value,
  };
}

function auditLifecycleGatesAndAtomicInvalidation() {
  const database = new WorkspaceDatabase(path.join(root, "lifecycle.db"));
  try {
    const profiles = new ModelProfilesRepository(database);
    const tests = new ModelConnectionTestsRepository(database);
    const settings = new SettingsRepository(database);
    insertProject(database);

    assertConflict(() =>
      profiles.create(
        profileInput("00000000-0000-4000-8000-000000000925", {
          enabled: true,
        }),
      ),
    );
    assertConflict(() =>
      profiles.create(
        profileInput("00000000-0000-4000-8000-000000000926", {
          enabled: true,
          isDefault: true,
        }),
      ),
    );

    const { configured, reference } = createConfiguredProfile(
      profiles,
      profileId,
    );
    assert.equal(configured.connectionRevision, 1);
    assert.equal(configured.executionRevision, 1);
    storePassed(tests, profileId, configured.connectionRevision, timestamp(2));
    assert.deepEqual(
      modelConnectionTestView(
        configured.connectionRevision,
        tests.get(profileId),
      ),
      {
        status: "passed",
        errorCode: null,
        retryable: false,
        latencyMs: 42,
        testedAt: timestamp(2),
      },
    );

    profiles.enable(profileId, true, timestamp(3));
    const enabled = profiles.requireStored(profileId);
    assert.equal(enabled.enabled, true);
    assert.equal(enabled.executionRevision, configured.executionRevision + 1);
    assert.equal(enabled.connectionRevision, configured.connectionRevision);
    assert.equal(tests.hasCurrentPassed(profileId), true);

    profiles.setDefault(profileId, timestamp(4));
    setProjectDefault(database, profileId, timestamp(4));
    assert.deepEqual(defaults(database), {
      workspace: profileId,
      project: profileId,
    });

    const beforeAlias = profiles.requireStored(profileId);
    profiles.update(profileId, {
      credentialRef: reference.toUpperCase(),
      now: timestamp(5),
    });
    const afterAlias = profiles.requireStored(profileId);
    assert.equal(afterAlias.credentialRef, reference);
    assert.equal(afterAlias.connectionRevision, beforeAlias.connectionRevision);
    assert.equal(afterAlias.executionRevision, beforeAlias.executionRevision);
    assert.equal(afterAlias.enabled, true);
    assert.equal(afterAlias.isDefault, true);
    assert.equal(tests.hasCurrentPassed(profileId), true);

    profiles.update(profileId, {
      model: "gpt-5.4-mini",
      now: timestamp(6),
    });
    const changed = profiles.requireStored(profileId);
    assert.equal(
      changed.connectionRevision,
      beforeAlias.connectionRevision + 1,
    );
    assert.equal(changed.executionRevision, beforeAlias.executionRevision + 1);
    assert.equal(changed.enabled, false);
    assert.equal(changed.isDefault, false);
    assert.deepEqual(defaults(database), { workspace: null, project: null });
    assert.equal(tests.hasCurrentPassed(profileId), false);
    assert.equal(
      modelConnectionTestView(changed.connectionRevision, tests.get(profileId))
        .status,
      "stale",
    );

    assert.deepEqual(
      tests.storeIfCurrent({
        profileId,
        expectedConnectionRevision: beforeAlias.connectionRevision,
        status: "failed",
        errorCode: "network_error",
        retryable: true,
        latencyMs: 50,
        testedAt: timestamp(7),
      }),
      {
        stored: false,
        currentConnectionRevision: changed.connectionRevision,
      },
    );
    assert.equal(tests.get(profileId)?.status, "passed");

    assertConflict(() =>
      profiles.update(profileId, { enabled: true, now: timestamp(8) }),
    );
    assertConflict(() => profiles.enable(profileId, true, timestamp(8)));
    assertConflict(() =>
      profiles.enableWithActiveJobBarrier(profileId, true, timestamp(8), ""),
    );

    database
      .prepare("UPDATE model_profiles SET enabled = 1 WHERE id = ?")
      .run(profileId);
    assertConflict(() => profiles.requireEnabled(profileId));
    assertConflict(() => profiles.setDefault(profileId, timestamp(8)));
    assertConflict(() =>
      profiles.update(profileId, { isDefault: true, now: timestamp(8) }),
    );
    assertConflict(() =>
      settings.update({
        defaultModelProfileId: profileId,
        now: timestamp(8),
      }),
    );
    assertConflict(() =>
      settings.update({
        defaultModelProfileId: "",
        now: timestamp(8),
      }),
    );
    assert.equal(profiles.requireStored(profileId).isDefault, false);
    database
      .prepare("UPDATE model_profiles SET enabled = 0 WHERE id = ?")
      .run(profileId);

    storePassed(tests, profileId, changed.connectionRevision, timestamp(9));
    profiles.enable(profileId, true, timestamp(10));
    profiles.setDefault(profileId, timestamp(11));
    setProjectDefault(database, profileId, timestamp(11));
    const beforeFailure = profiles.requireStored(profileId);
    const failed = tests.storeIfCurrent({
      profileId,
      expectedConnectionRevision: beforeFailure.connectionRevision,
      status: "failed",
      errorCode: "authentication_failed",
      retryable: false,
      latencyMs: 61,
      testedAt: timestamp(12),
    });
    assert.equal(failed.stored, true);
    if (failed.stored) {
      assert.equal(failed.result.status, "failed");
      assert.equal(failed.result.errorCode, "authentication_failed");
    }
    const afterFailure = profiles.requireStored(profileId);
    assert.equal(afterFailure.enabled, false);
    assert.equal(afterFailure.isDefault, false);
    assert.equal(
      afterFailure.executionRevision,
      beforeFailure.executionRevision + 1,
    );
    assert.equal(
      afterFailure.connectionRevision,
      beforeFailure.connectionRevision,
    );
    assert.deepEqual(defaults(database), { workspace: null, project: null });
    assert.equal(tests.hasCurrentPassed(profileId), false);

    tests.storeIfCurrent({
      profileId,
      expectedConnectionRevision: afterFailure.connectionRevision,
      status: "failed",
      errorCode: "rate_limited",
      retryable: true,
      latencyMs: 62,
      testedAt: timestamp(13),
    });
    assert.equal(
      profiles.requireStored(profileId).executionRevision,
      afterFailure.executionRevision,
      "a failed test must only increment execution revision when disabling an enabled profile",
    );

    storePassed(
      tests,
      profileId,
      afterFailure.connectionRevision,
      timestamp(14),
    );
    profiles.enableWithActiveJobBarrier(profileId, true, timestamp(15), "");
    const reenabled = profiles.requireStored(profileId);
    assert.equal(reenabled.connectionRevision, afterFailure.connectionRevision);
    assert.equal(tests.hasCurrentPassed(profileId), true);
    settings.update({
      defaultModelProfileId: profileId,
      now: timestamp(16),
    });
    assert.equal(defaults(database).workspace, profileId);
  } finally {
    database.close();
  }
}

function auditStrictInputsRowsAndNormalization() {
  const database = new WorkspaceDatabase(path.join(root, "defense.db"));
  try {
    const profiles = new ModelProfilesRepository(database);
    const tests = new ModelConnectionTestsRepository(database);
    const { configured } = createConfiguredProfile(profiles, corruptProfileId);
    const valid = {
      profileId: corruptProfileId,
      expectedConnectionRevision: configured.connectionRevision,
      status: "failed",
      errorCode: "network_error",
      retryable: true,
      latencyMs: 20,
      testedAt: timestamp(20),
    } as const;
    const invalidInputs: Record<string, unknown>[] = [
      { ...valid, profileId: " " },
      { ...valid, expectedConnectionRevision: -1 },
      {
        ...valid,
        expectedConnectionRevision: MAX_MODEL_CONNECTION_REVISION + 1,
      },
      { ...valid, expectedConnectionRevision: 1.5 },
      { ...valid, expectedConnectionRevision: "1" },
      { ...valid, status: "unknown" },
      { ...valid, errorCode: "raw provider body" },
      { ...valid, retryable: 1 },
      { ...valid, latencyMs: -1 },
      { ...valid, latencyMs: MAX_MODEL_CONNECTION_TEST_LATENCY_MS + 1 },
      { ...valid, latencyMs: 1.5 },
      { ...valid, latencyMs: "20" },
      { ...valid, testedAt: "2026-07-15T08:00:20Z" },
      { ...valid, testedAt: "2026-07-15T08:00:20.000+00:00" },
      { ...valid, testedAt: "2026-02-30T08:00:20.000Z" },
      { ...valid, status: "passed", errorCode: null, retryable: true },
      {
        ...valid,
        status: "passed",
        errorCode: "network_error",
        retryable: false,
      },
      { ...valid, status: "failed", errorCode: null },
      { ...valid, providerBody: "must never be accepted or persisted" },
      Object.fromEntries(
        Object.entries(valid).filter(([key]) => key !== "testedAt"),
      ),
    ];
    for (const input of invalidInputs) {
      assert.throws(
        () => tests.storeIfCurrent(input as StoreModelConnectionTestInput),
        /readiness result is invalid/,
      );
    }

    assert.equal(
      normalizeModelConnectionTestErrorCode("provider_timeout"),
      "timeout",
    );
    assert.equal(
      normalizeModelConnectionTestErrorCode("redirect"),
      "invalid_response",
    );
    assert.equal(
      normalizeModelConnectionTestErrorCode("response_too_large"),
      "invalid_response",
    );
    assert.equal(
      normalizeModelConnectionTestErrorCode("hardened_transport_required"),
      "configuration_error",
    );
    assert.equal(
      normalizeModelConnectionTestErrorCode("provider_request_failed"),
      "configuration_error",
    );
    assert.equal(
      normalizeModelConnectionTestErrorCode("unknown provider detail"),
      "invalid_response",
    );
    assert.equal(
      normalizeModelConnectionTestErrorCode("RATE_LIMITED"),
      "rate_limited",
    );

    storePassed(
      tests,
      corruptProfileId,
      configured.connectionRevision,
      timestamp(21),
    );
    database.exec("PRAGMA ignore_check_constraints = ON");
    const restore = () =>
      database
        .prepare(
          `UPDATE model_profile_connection_tests
              SET connection_revision = ?, status = 'passed', error_code = NULL,
                  retryable = 0, latency_ms = 20, tested_at = ?
            WHERE profile_id = ?`,
        )
        .run(configured.connectionRevision, timestamp(21), corruptProfileId);
    const corruptions = [
      "UPDATE model_profile_connection_tests SET connection_revision = -1 WHERE profile_id = ?",
      "UPDATE model_profile_connection_tests SET connection_revision = 2147483648 WHERE profile_id = ?",
      "UPDATE model_profile_connection_tests SET status = 'unknown' WHERE profile_id = ?",
      "UPDATE model_profile_connection_tests SET error_code = 'raw_provider_message' WHERE profile_id = ?",
      "UPDATE model_profile_connection_tests SET retryable = 2 WHERE profile_id = ?",
      "UPDATE model_profile_connection_tests SET latency_ms = 600001 WHERE profile_id = ?",
      "UPDATE model_profile_connection_tests SET tested_at = '2026-07-15T08:00:21Z' WHERE profile_id = ?",
      "UPDATE model_profile_connection_tests SET status = 'passed', error_code = 'network_error' WHERE profile_id = ?",
      "UPDATE model_profile_connection_tests SET status = 'passed', retryable = 1 WHERE profile_id = ?",
      "UPDATE model_profile_connection_tests SET status = 'failed', error_code = NULL WHERE profile_id = ?",
    ];
    for (const sql of corruptions) {
      database.prepare(sql).run(corruptProfileId);
      assert.throws(() => tests.get(corruptProfileId), /state is corrupt/);
      restore();
    }

    database.exec("PRAGMA foreign_keys = OFF");
    database
      .prepare(
        "UPDATE model_profile_connection_tests SET profile_id = ' ' WHERE profile_id = ?",
      )
      .run(corruptProfileId);
    assert.throws(() => tests.list(), /state is corrupt/);
    database
      .prepare(
        "UPDATE model_profile_connection_tests SET profile_id = ? WHERE profile_id = ' '",
      )
      .run(corruptProfileId);
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA ignore_check_constraints = OFF");
  } finally {
    database.close();
  }
}

function auditPreV9Fallback() {
  const readinessMigrationIndex = WORKSPACE_MIGRATIONS.findIndex(
    (migration) => migration.version === 9,
  );
  assert.ok(readinessMigrationIndex > 0);
  const database = new WorkspaceDatabase(path.join(root, "pre-v9.db"), {
    migrations: WORKSPACE_MIGRATIONS.slice(0, readinessMigrationIndex),
  });
  try {
    const profiles = new ModelProfilesRepository(database);
    const settings = new SettingsRepository(database);
    const created = profiles.create(
      profileInput(preV9ProfileId, { enabled: true, isDefault: true }),
    );
    const stored = profiles.requireStored(created.id);
    assert.equal(stored.connectionRevision, stored.executionRevision);
    assert.equal(stored.enabled, true);
    assert.equal(stored.isDefault, true);
    settings.update({
      defaultModelProfileId: stored.id,
      now: timestamp(30),
    });
    assert.equal(settings.get().defaultModelProfileId, stored.id);
  } finally {
    database.close();
  }
}

const originalEnvironment = { ...process.env };
try {
  process.env.ALETHEIA_DATABASE_ENCRYPTION = "metadata_plaintext";
  auditLifecycleGatesAndAtomicInvalidation();
  auditStrictInputsRowsAndNormalization();
  auditPreV9Fallback();
  console.log("veraWorkspaceModelConnectionRepositoriesAudit: ok");
} finally {
  process.env = originalEnvironment;
  rmSync(root, { recursive: true, force: true });
}
