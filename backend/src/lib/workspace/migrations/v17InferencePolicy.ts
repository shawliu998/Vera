import type {
  WorkspaceDatabaseAdapter,
  WorkspaceDatabaseCapabilities,
  WorkspaceMigration,
} from "./types";

const CREATED_AT = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";

const strictUtcTimestamp = (column: string) => `
    typeof(${column}) = 'text'
    AND length(${column}) = 24
    AND ${column} GLOB
      '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-5][0-9].[0-9][0-9][0-9]Z'
    AND strftime('%Y-%m-%dT%H:%M:%fZ', ${column}) = ${column}
`;

/*
 * These are administrator/user declarations, not facts inferred from a URL or
 * provider name. Existing profiles intentionally receive no row: absence is
 * the durable fail-closed state until a declaration is saved explicitly.
 */
const INFERENCE_POLICY_V17_SQL = `
CREATE TABLE model_profile_privacy (
  model_profile_id TEXT PRIMARY KEY
    REFERENCES model_profiles(id) ON DELETE CASCADE,
  execution_location TEXT NOT NULL
    CHECK (
      typeof(execution_location) = 'text'
      AND execution_location IN (
        'local',
        'firm_private',
        'confidential_remote',
        'standard_remote'
      )
    ),
  retention TEXT NOT NULL
    CHECK (
      typeof(retention) = 'text'
      AND retention IN ('zero', 'provider_declared', 'unknown')
    ),
  training_use TEXT NOT NULL
    CHECK (
      typeof(training_use) = 'text'
      AND training_use IN ('prohibited', 'provider_declared', 'unknown')
    ),
  sensitive_data_allowed INTEGER NOT NULL
    CHECK (
      typeof(sensitive_data_allowed) = 'integer'
      AND sensitive_data_allowed IN (0, 1)
    ),
  created_at TEXT NOT NULL DEFAULT ${CREATED_AT}
    CHECK (${strictUtcTimestamp("created_at")}),
  updated_at TEXT NOT NULL DEFAULT ${CREATED_AT}
    CHECK (${strictUtcTimestamp("updated_at")}),
  CHECK (updated_at >= created_at)
) WITHOUT ROWID;

CREATE INDEX idx_model_profile_privacy_location
  ON model_profile_privacy(execution_location, model_profile_id);

CREATE TRIGGER model_profile_privacy_v17_update_guard
BEFORE UPDATE ON model_profile_privacy BEGIN
  SELECT CASE WHEN new.model_profile_id IS NOT old.model_profile_id
    THEN RAISE(ABORT, 'Model privacy profile ownership is immutable')
  END;
  SELECT CASE WHEN new.created_at IS NOT old.created_at
    THEN RAISE(ABORT, 'Model privacy declaration creation time is immutable')
  END;
  SELECT CASE WHEN new.updated_at <= old.updated_at
    THEN RAISE(ABORT, 'Model privacy declaration time must move forwards')
  END;
END;

/*
 * The ledger deliberately excludes prompts, source identifiers, model names,
 * endpoints, and credentials. It records only the policy inputs needed to
 * demonstrate that every inference boundary was evaluated.
 */
CREATE TABLE inference_policy_decisions (
  id TEXT PRIMARY KEY
    CHECK (
      typeof(id) = 'text'
      AND length(id) = 36
      AND id GLOB
        '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[1-8][0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
    ),
  scope TEXT NOT NULL
    CHECK (typeof(scope) = 'text' AND scope IN ('global', 'project', 'matter')),
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  model_profile_id TEXT REFERENCES model_profiles(id) ON DELETE SET NULL,
  operation TEXT NOT NULL
    CHECK (
      typeof(operation) = 'text'
      AND operation IN (
        'assistant',
        'workflow_prompt',
        'tabular_generation',
        'studio_suggestion'
      )
    ),
  decision TEXT NOT NULL
    CHECK (typeof(decision) = 'text' AND decision IN ('allow', 'require_approval', 'deny')),
  reason_code TEXT NOT NULL
    CHECK (
      typeof(reason_code) = 'text'
      AND length(reason_code) BETWEEN 1 AND 120
      AND reason_code GLOB '[a-z0-9_]*'
      AND reason_code NOT GLOB '*[^a-z0-9_]*'
    ),
  execution_location TEXT
    CHECK (
      execution_location IS NULL OR (
        typeof(execution_location) = 'text'
        AND execution_location IN (
          'local',
          'firm_private',
          'confidential_remote',
          'standard_remote'
        )
      )
    ),
  source_snapshot_count INTEGER NOT NULL DEFAULT 0
    CHECK (
      typeof(source_snapshot_count) = 'integer'
      AND source_snapshot_count BETWEEN 0 AND 100000
    ),
  created_at TEXT NOT NULL DEFAULT ${CREATED_AT}
    CHECK (${strictUtcTimestamp("created_at")})
);

CREATE INDEX idx_inference_policy_decisions_created
  ON inference_policy_decisions(created_at DESC, id DESC);
CREATE INDEX idx_inference_policy_decisions_project_created
  ON inference_policy_decisions(project_id, created_at DESC, id DESC)
  WHERE project_id IS NOT NULL;
CREATE INDEX idx_inference_policy_decisions_model_created
  ON inference_policy_decisions(model_profile_id, created_at DESC, id DESC)
  WHERE model_profile_id IS NOT NULL;

CREATE TRIGGER inference_policy_decisions_v17_immutable
BEFORE UPDATE ON inference_policy_decisions
WHEN
  new.id IS NOT old.id
  OR new.scope IS NOT old.scope
  OR new.operation IS NOT old.operation
  OR new.decision IS NOT old.decision
  OR new.reason_code IS NOT old.reason_code
  OR new.execution_location IS NOT old.execution_location
  OR new.source_snapshot_count IS NOT old.source_snapshot_count
  OR new.created_at IS NOT old.created_at
  OR (
    new.project_id IS NOT old.project_id
    AND NOT (old.project_id IS NOT NULL AND new.project_id IS NULL)
  )
  OR (
    new.model_profile_id IS NOT old.model_profile_id
    AND NOT (old.model_profile_id IS NOT NULL AND new.model_profile_id IS NULL)
  )
BEGIN
  SELECT RAISE(ABORT, 'Inference policy decisions are immutable');
END;

CREATE TRIGGER inference_policy_decisions_v17_delete_guard
BEFORE DELETE ON inference_policy_decisions BEGIN
  SELECT RAISE(ABORT, 'Inference policy decisions cannot be deleted');
END;
`;

function applyInferencePolicyV17(
  database: WorkspaceDatabaseAdapter,
  _capabilities: WorkspaceDatabaseCapabilities,
) {
  database.exec(INFERENCE_POLICY_V17_SQL);
}

export const INFERENCE_POLICY_V17_MIGRATION: WorkspaceMigration = {
  version: 17,
  name: "minimal_unified_inference_policy",
  checksumMaterial: [
    "workspace-migration-v17",
    "additive-explicit-user-or-administrator-model-privacy-declarations",
    "no-profile-backfill-and-no-endpoint-or-provider-location-inference",
    "strict-execution-retention-training-and-sensitive-data-contract",
    "secret-free-immutable-inference-policy-decision-ledger",
    INFERENCE_POLICY_V17_SQL,
  ].join("\n-- checksum boundary --\n"),
  apply: applyInferencePolicyV17,
};
