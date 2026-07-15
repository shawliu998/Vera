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

const boundedNullableText = (column: string, maximum: number) => `
    ${column} IS NULL OR (
      typeof(${column}) = 'text'
      AND length(trim(${column})) BETWEEN 1 AND ${maximum}
      AND instr(${column}, char(0)) = 0
    )
`;

/*
 * A Matter Profile is the optional legal-semantic extension of the existing
 * Project ownership boundary. It intentionally contains intake metadata only:
 * sourced facts, AI findings, review decisions, and other durable legal state
 * belong in the later Artifact Graph rather than this table.
 */
const MATTER_PROFILES_V15_SQL = `
CREATE TABLE matter_profiles (
  project_id TEXT PRIMARY KEY
    CHECK (
      typeof(project_id) = 'text'
      AND length(trim(project_id)) BETWEEN 1 AND 120
      AND instr(project_id, char(0)) = 0
    )
    REFERENCES projects(id) ON DELETE CASCADE,
  matter_type TEXT NOT NULL
    CHECK (
      typeof(matter_type) = 'text'
      AND matter_type IN (
        'civil_litigation',
        'commercial_dispute',
        'contract_review',
        'legal_research',
        'general'
      )
    ),
  client_name TEXT CHECK (${boundedNullableText("client_name", 500)}),
  represented_role TEXT CHECK (
    ${boundedNullableText("represented_role", 240)}
  ),
  counterparty TEXT CHECK (${boundedNullableText("counterparty", 1000)}),
  court TEXT CHECK (${boundedNullableText("court", 500)}),
  case_number TEXT CHECK (${boundedNullableText("case_number", 240)}),
  stage TEXT CHECK (${boundedNullableText("stage", 240)}),
  objective TEXT CHECK (${boundedNullableText("objective", 16384)}),
  risk_level TEXT CHECK (
    risk_level IS NULL OR (
      typeof(risk_level) = 'text'
      AND risk_level IN ('low', 'medium', 'high')
    )
  ),
  opened_at TEXT CHECK (
    opened_at IS NULL OR (${strictUtcTimestamp("opened_at")})
  ),
  closed_at TEXT CHECK (
    closed_at IS NULL OR (${strictUtcTimestamp("closed_at")})
  ),
  created_at TEXT NOT NULL DEFAULT ${CREATED_AT}
    CHECK (${strictUtcTimestamp("created_at")}),
  updated_at TEXT NOT NULL DEFAULT ${CREATED_AT}
    CHECK (${strictUtcTimestamp("updated_at")}),
  CHECK (closed_at IS NULL OR opened_at IS NULL OR closed_at >= opened_at),
  CHECK (updated_at >= created_at)
) WITHOUT ROWID;

CREATE INDEX idx_matter_profiles_type_updated
  ON matter_profiles(matter_type, updated_at DESC, project_id);

CREATE INDEX idx_matter_profiles_risk_updated
  ON matter_profiles(risk_level, updated_at DESC, project_id)
  WHERE risk_level IS NOT NULL;

CREATE INDEX idx_matter_profiles_case_number
  ON matter_profiles(case_number, project_id)
  WHERE case_number IS NOT NULL;

CREATE TRIGGER matter_profiles_v15_update_guard
BEFORE UPDATE ON matter_profiles BEGIN
  SELECT CASE WHEN new.project_id IS NOT old.project_id
    THEN RAISE(ABORT, 'Matter Profile Project ownership is immutable')
  END;
  SELECT CASE WHEN new.created_at IS NOT old.created_at
    THEN RAISE(ABORT, 'Matter Profile creation time is immutable')
  END;
  SELECT CASE WHEN new.updated_at < old.updated_at
    THEN RAISE(ABORT, 'Matter Profile update time cannot move backwards')
  END;
END;

CREATE TABLE matter_policies (
  project_id TEXT PRIMARY KEY
    CHECK (
      typeof(project_id) = 'text'
      AND length(trim(project_id)) BETWEEN 1 AND 120
      AND instr(project_id, char(0)) = 0
    )
    REFERENCES matter_profiles(project_id) ON DELETE CASCADE,
  external_egress_mode TEXT NOT NULL DEFAULT 'disabled'
    CHECK (
      typeof(external_egress_mode) = 'text'
      AND external_egress_mode IN (
        'disabled',
        'approval',
        'allowed_by_policy'
      )
    ),
  audio_retention_days INTEGER
    CHECK (
      audio_retention_days IS NULL OR (
        typeof(audio_retention_days) = 'integer'
        AND audio_retention_days BETWEEN 0 AND 36500
      )
    ),
  allow_external_legal_sources INTEGER NOT NULL DEFAULT 0
    CHECK (
      typeof(allow_external_legal_sources) = 'integer'
      AND allow_external_legal_sources IN (0, 1)
    ),
  allow_word_bridge INTEGER NOT NULL DEFAULT 0
    CHECK (
      typeof(allow_word_bridge) = 'integer'
      AND allow_word_bridge IN (0, 1)
    ),
  created_at TEXT NOT NULL DEFAULT ${CREATED_AT}
    CHECK (${strictUtcTimestamp("created_at")}),
  updated_at TEXT NOT NULL DEFAULT ${CREATED_AT}
    CHECK (${strictUtcTimestamp("updated_at")}),
  CHECK (updated_at >= created_at)
) WITHOUT ROWID;

CREATE INDEX idx_matter_policies_egress_updated
  ON matter_policies(external_egress_mode, updated_at DESC, project_id);

CREATE TRIGGER matter_policies_v15_update_guard
BEFORE UPDATE ON matter_policies BEGIN
  SELECT CASE WHEN new.project_id IS NOT old.project_id
    THEN RAISE(ABORT, 'Matter Policy Project ownership is immutable')
  END;
  SELECT CASE WHEN new.created_at IS NOT old.created_at
    THEN RAISE(ABORT, 'Matter Policy creation time is immutable')
  END;
  SELECT CASE WHEN new.updated_at < old.updated_at
    THEN RAISE(ABORT, 'Matter Policy update time cannot move backwards')
  END;
END;

/*
 * Zero rows is the canonical deny-all execution-location set. A missing
 * matter_policies row is also interpreted fail-closed by policy evaluation;
 * neither state silently enables local or remote inference.
 */
CREATE TABLE matter_policy_execution_locations (
  project_id TEXT NOT NULL
    REFERENCES matter_policies(project_id) ON DELETE CASCADE,
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
  created_at TEXT NOT NULL DEFAULT ${CREATED_AT}
    CHECK (${strictUtcTimestamp("created_at")}),
  PRIMARY KEY (project_id, execution_location)
) WITHOUT ROWID;

CREATE INDEX idx_matter_policy_execution_locations_location
  ON matter_policy_execution_locations(execution_location, project_id);

CREATE TRIGGER matter_policy_execution_locations_v15_immutable
BEFORE UPDATE ON matter_policy_execution_locations BEGIN
  SELECT RAISE(
    ABORT,
    'Matter Policy execution-location membership is immutable; replace it'
  );
END;
`;

function applyMatterProfilesV15(
  database: WorkspaceDatabaseAdapter,
  _capabilities: WorkspaceDatabaseCapabilities,
) {
  database.exec(MATTER_PROFILES_V15_SQL);
}

export const MATTER_PROFILES_V15_MIGRATION: WorkspaceMigration = {
  version: 15,
  name: "project_matter_foundation",
  checksumMaterial: [
    "workspace-migration-v15",
    "additive-optional-project-one-to-one-legal-semantic-profile",
    "intake-metadata-only-no-sources-ai-findings-or-formal-matter-state",
    "optional-profile-owned-policy-with-normalized-execution-locations",
    "missing-policy-and-empty-execution-set-are-deny-all",
    "default-egress-disabled-audio-retention-unconfigured-external-and-word-off",
    "strict-bounded-text-enums-canonical-utc-times-and-cascade-ownership",
    MATTER_PROFILES_V15_SQL,
  ].join("\n-- checksum boundary --\n"),
  apply: applyMatterProfilesV15,
};
