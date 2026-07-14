import { isIP } from "node:net";

import type {
  WorkspaceDatabaseAdapter,
  WorkspaceDatabaseCapabilities,
  WorkspaceMigration,
} from "./types";
import {
  isWorkspaceConnectionSqlcipherEncrypted,
  WORKSPACE_SQLCIPHER_CONNECTION_POLICY_MATERIAL,
} from "./encryptionPolicy";
import { WorkspaceMigrationError } from "./runner";

const MIGRATION_ISSUE_CODE =
  "workspace_migration_credential_reconfiguration_required";
const MIGRATION_ORPHAN_REASON = "migration_reconfiguration";
const MIGRATION_ERROR_JSON = JSON.stringify({
  code: MIGRATION_ISSUE_CODE,
  message:
    "Model credentials must be reconfigured after workspace schema v8 migration.",
  retryable: false,
  details: null,
});
const MODEL_PROVIDER_CHECK = `provider IN ('openai', 'deepseek', 'anthropic', 'gemini', 'openai_compatible')`;
const CREDENTIAL_STATE_CHECK =
  "credential_state IN ('configured', 'missing', 'invalid')";
const MIGRATION_ISSUE_CHECK = `migration_issue_code IS NULL OR migration_issue_code = '${MIGRATION_ISSUE_CODE}'`;
const ORPHAN_REASON_CHECK = `reason IN (
  '${MIGRATION_ORPHAN_REASON}',
  'binding_change',
  'credential_clear',
  'credential_replace',
  'credential_cas_rollback',
  'profile_delete'
)`;
const SQLITE_HAS_TABLE_SQL = `SELECT 1 AS present
           FROM sqlite_schema
          WHERE type = 'table' AND name = ?`;
const LEGACY_REFERENCE_PATTERN_SOURCE =
  "^keychain:\\/\\/vera\\/model-profile\\/([0-9a-f-]{36})(?:\\/([a-z0-9]{16,128}))?$";
const LEGACY_REFERENCE_PATTERN_FLAGS = "i";
const LEGACY_REFERENCE_PATTERN = new RegExp(
  LEGACY_REFERENCE_PATTERN_SOURCE,
  LEGACY_REFERENCE_PATTERN_FLAGS,
);
const SAFE_BASE_URL_MAX_LENGTH = 500;
const DOCUMENTATION_IPV6_PREFIX_PATTERN_SOURCE = "^2001:0*db8(?::|$)";
const HOSTNAME_TRAILING_DOTS_PATTERN_SOURCE = "\\.+$";
const LOCALHOST_EXACT_HOST = "localhost";
const LOCALHOST_SUFFIX = ".localhost";
const HOSTNAME_TRAILING_DOTS_PATTERN = new RegExp(
  HOSTNAME_TRAILING_DOTS_PATTERN_SOURCE,
);
const RESERVED_IPV4_POLICY = JSON.stringify({
  blockedExactFirstOctet: [0, 10, 127],
  blockedRanges: [
    { first: 100, secondStart: 64, secondEnd: 127, label: "cgnat" },
    { first: 169, secondStart: 254, secondEnd: 254, label: "link_local" },
    { first: 172, secondStart: 16, secondEnd: 31, label: "private_172" },
    {
      first: 192,
      secondStart: 0,
      secondEnd: 0,
      label: "ietf_protocol_assignments",
    },
    { first: 192, secondStart: 168, secondEnd: 168, label: "private_192" },
    { first: 198, secondStart: 18, secondEnd: 19, label: "benchmarking" },
    { first: 198, secondStart: 51, secondEnd: 51, label: "test_net_2" },
    { first: 203, secondStart: 0, secondEnd: 0, label: "test_net_3" },
  ],
  blockedFirstOctetGte: 224,
});
const RESERVED_IPV6_POLICY = JSON.stringify({
  blockedExact: ["::", "::1"],
  blockedPrefixes: ["fc", "fd", "fe8", "fe9", "fea", "feb", "ff"],
  mappedIpv4Prefix: "::ffff:",
  documentationPrefixPattern: DOCUMENTATION_IPV6_PREFIX_PATTERN_SOURCE,
});
const V8_LOCALHOST_POLICY = JSON.stringify({
  normalizeTrailingDotsPattern: HOSTNAME_TRAILING_DOTS_PATTERN_SOURCE,
  exactHost: LOCALHOST_EXACT_HOST,
  suffix: LOCALHOST_SUFFIX,
});
const V8_HOST_CLASSIFICATION_POLICY = JSON.stringify({
  localhost: JSON.parse(V8_LOCALHOST_POLICY),
  ipv4: JSON.parse(RESERVED_IPV4_POLICY),
  ipv6: JSON.parse(RESERVED_IPV6_POLICY),
});
const V8_BASE_URL_SANITIZER_POLICY = JSON.stringify({
  protocols: ["https:"],
  maxLength: SAFE_BASE_URL_MAX_LENGTH,
  forbidUserInfo: true,
  forbidQuery: true,
  forbidHash: true,
  rejectLocalOrReservedHosts: true,
  normalizeRootPathToEmpty: true,
});
const V8_REFERENCE_POLICY = JSON.stringify({
  maxLength: 256,
  scheme: "keychain://vera/model-profile",
  locatorPattern: LEGACY_REFERENCE_PATTERN_SOURCE,
  locatorFlags: LEGACY_REFERENCE_PATTERN_FLAGS,
  lowercaseCanonicalization: true,
});
const V8_LEGACY_CREDENTIAL_EVIDENCE_SQL = `credential_ref IS NOT NULL
         OR coalesce(credential_status, 'not_configured') <> 'not_configured'`;
const V8_LEGACY_CREDENTIAL_EVIDENCE_POLICY = JSON.stringify({
  predicateSql: V8_LEGACY_CREDENTIAL_EVIDENCE_SQL,
  queueOrphanCleanupOnlyForSafeReference: true,
  negativeStatus: "not_configured",
});
const V8_PLAINTEXT_DESTRUCTIVE_REWRITE_ERROR =
  'Workspace migration v8 cannot safely rewrite legacy model/runtime data in plaintext SQLite. Stop Vera, run "npm run migrate:aletheia:sqlcipher --prefix backend" from the repository root (or use the packaged desktop offline migration), then restart with ALETHEIA_DATABASE_ENCRYPTION=sqlcipher_required.';
const V8_SQLCIPHER_CAPABILITY_MISMATCH_ERROR =
  "Workspace migration v8 rejected inconsistent SQLCipher connection capability and trusted same-connection attestation.";
const V8_PROFILE_DESTRUCTIVE_EVIDENCE_SQL = `credential_ref IS NOT NULL
             OR coalesce(credential_status, 'not_configured') <> 'not_configured'`;
const V8_PROFILE_ENDPOINT_EVIDENCE_SELECT_SQL = `SELECT base_url
       FROM model_profiles`;
const V8_PROFILE_ENDPOINT_WITH_ORIGIN_EVIDENCE_SELECT_SQL = `SELECT base_url, credential_origin
       FROM model_profiles`;
const V8_JOB_SENSITIVE_REWRITE_EVIDENCE_SQL = `(
               job.result_json IS NOT NULL
               OR (
                 job.error_code IS NOT NULL
                 AND job.error_code <> '${MIGRATION_ISSUE_CODE}'
               )
               OR (
                 job.error_json IS NOT NULL
                 AND job.error_json <> '${MIGRATION_ERROR_JSON}'
               )
               OR job.lease_owner IS NOT NULL
               OR job.cancellation_reason IS NOT NULL
             )`;
const V8_ASSISTANT_JOB_DESTRUCTIVE_EVIDENCE_SQL = `job.status IN ('queued', 'running')
             AND job.type = 'assistant_generate'
             AND ${V8_JOB_SENSITIVE_REWRITE_EVIDENCE_SQL}`;
const V8_ASSISTANT_OUTPUT_DESTRUCTIVE_EVIDENCE_SQL = `message.status IN ('pending', 'streaming')
             AND message.error_code IS NOT NULL
             AND message.error_code <> '${MIGRATION_ISSUE_CODE}'`;
const V8_WORKFLOW_RUN_DESTRUCTIVE_EVIDENCE_SQL = `snapshot.model_profile_id IS NOT NULL
             AND run.status IN ('queued', 'waiting', 'running')
             AND (
               (
                 run.error_code IS NOT NULL
                 AND run.error_code <> '${MIGRATION_ISSUE_CODE}'
               )
               OR (
                 run.error_json IS NOT NULL
                 AND run.error_json <> '${MIGRATION_ERROR_JSON}'
               )
             )`;
const V8_WORKFLOW_STEP_DESTRUCTIVE_EVIDENCE_SQL = `snapshot.model_profile_id IS NOT NULL
             AND run.status IN ('queued', 'waiting', 'running')
             AND step.status IN ('queued', 'waiting', 'running')
             AND (
               (
                 step.error_code IS NOT NULL
                 AND step.error_code <> '${MIGRATION_ISSUE_CODE}'
               )
               OR (
                 step.error_json IS NOT NULL
                 AND step.error_json <> '${MIGRATION_ERROR_JSON}'
               )
             )`;
const V8_WORKFLOW_JOB_DESTRUCTIVE_EVIDENCE_SQL = `snapshot.model_profile_id IS NOT NULL
             AND run.status IN ('queued', 'waiting', 'running')
             AND job.status IN ('queued', 'running')
             AND job.type = 'workflow_run'
             AND ${V8_JOB_SENSITIVE_REWRITE_EVIDENCE_SQL}`;
const V8_TABULAR_CELL_DESTRUCTIVE_EVIDENCE_SQL = `cell.status IN ('queued', 'running')
             AND (
               (
                 cell.error_code IS NOT NULL
                 AND cell.error_code <> '${MIGRATION_ISSUE_CODE}'
               )
               OR (
                 cell.error_json IS NOT NULL
                 AND cell.error_json <> '${MIGRATION_ERROR_JSON}'
               )
             )`;
const V8_TABULAR_JOB_DESTRUCTIVE_EVIDENCE_SQL = `job.status IN ('queued', 'running')
             AND job.type = 'tabular_cell'
             AND job.resource_type = 'tabular_cell'
             AND ${V8_JOB_SENSITIVE_REWRITE_EVIDENCE_SQL}`;
const V8_DESTRUCTIVE_REWRITE_EVIDENCE_SQL = `SELECT CASE WHEN
       EXISTS (
         SELECT 1 FROM model_profiles
          WHERE ${V8_PROFILE_DESTRUCTIVE_EVIDENCE_SQL}
       )
       OR EXISTS (
         SELECT 1 FROM jobs job
          WHERE ${V8_ASSISTANT_JOB_DESTRUCTIVE_EVIDENCE_SQL}
       )
       OR EXISTS (
         SELECT 1
           FROM assistant_generation_snapshots snapshot
           JOIN chat_messages message ON message.id = snapshot.output_message_id
          WHERE ${V8_ASSISTANT_OUTPUT_DESTRUCTIVE_EVIDENCE_SQL}
       )
       OR EXISTS (
         SELECT 1
          FROM workflow_execution_snapshots snapshot
           JOIN workflow_runs run ON run.id = snapshot.workflow_run_id
          WHERE ${V8_WORKFLOW_RUN_DESTRUCTIVE_EVIDENCE_SQL}
       )
       OR EXISTS (
         SELECT 1
           FROM workflow_execution_snapshots snapshot
           JOIN workflow_runs run ON run.id = snapshot.workflow_run_id
           JOIN workflow_step_runs step ON step.workflow_run_id = run.id
          WHERE ${V8_WORKFLOW_STEP_DESTRUCTIVE_EVIDENCE_SQL}
       )
       OR EXISTS (
         SELECT 1
           FROM workflow_execution_snapshots snapshot
           JOIN workflow_runs run ON run.id = snapshot.workflow_run_id
           JOIN jobs job ON job.id = run.job_id
          WHERE ${V8_WORKFLOW_JOB_DESTRUCTIVE_EVIDENCE_SQL}
       )
       OR EXISTS (
         SELECT 1 FROM tabular_cells cell
          WHERE ${V8_TABULAR_CELL_DESTRUCTIVE_EVIDENCE_SQL}
       )
       OR EXISTS (
         SELECT 1 FROM jobs job
          WHERE ${V8_TABULAR_JOB_DESTRUCTIVE_EVIDENCE_SQL}
       )
       THEN 1 ELSE 0 END AS destructive_evidence`;
const V8_DESTRUCTIVE_REWRITE_POLICY = JSON.stringify({
  connectionCapability: JSON.parse(
    WORKSPACE_SQLCIPHER_CONNECTION_POLICY_MATERIAL,
  ),
  gateDecision:
    "capability must exactly match immediate trusted same-connection re-attestation",
  capabilityMismatch: "fail_before_first_v8_ddl_or_dml",
  plaintextBehavior: "fail_before_first_v8_ddl_or_dml",
  encryptedBehavior: "allow_transactional_rewrite",
  evidenceSql: V8_DESTRUCTIVE_REWRITE_EVIDENCE_SQL,
  branches: {
    profile: V8_PROFILE_DESTRUCTIVE_EVIDENCE_SQL,
    profileBaseUrl: {
      selectSql: V8_PROFILE_ENDPOINT_EVIDENCE_SELECT_SQL,
      comparison: "old !== sanitizeLegacyBaseUrlForMigration(old)",
      sanitizerPolicy: JSON.parse(V8_BASE_URL_SANITIZER_POLICY),
    },
    partialV8CredentialOrigin: {
      columnDetection: 'PRAGMA table_info("model_profiles")',
      selectSql: V8_PROFILE_ENDPOINT_WITH_ORIGIN_EVIDENCE_SELECT_SQL,
      evidence: "credential_origin IS NOT NULL",
    },
    jobSensitiveRewrite: V8_JOB_SENSITIVE_REWRITE_EVIDENCE_SQL,
    assistantJob: V8_ASSISTANT_JOB_DESTRUCTIVE_EVIDENCE_SQL,
    assistantOutput: V8_ASSISTANT_OUTPUT_DESTRUCTIVE_EVIDENCE_SQL,
    workflowRun: V8_WORKFLOW_RUN_DESTRUCTIVE_EVIDENCE_SQL,
    workflowStep: V8_WORKFLOW_STEP_DESTRUCTIVE_EVIDENCE_SQL,
    workflowJob: V8_WORKFLOW_JOB_DESTRUCTIVE_EVIDENCE_SQL,
    tabularCell: V8_TABULAR_CELL_DESTRUCTIVE_EVIDENCE_SQL,
    tabularJob: V8_TABULAR_JOB_DESTRUCTIVE_EVIDENCE_SQL,
  },
  error: V8_PLAINTEXT_DESTRUCTIVE_REWRITE_ERROR,
});
const ADD_CREDENTIAL_ORIGIN_COLUMN_SQL = `ALTER TABLE model_profiles
         ADD COLUMN credential_origin TEXT
         CHECK (
           credential_origin IS NULL OR (
             length(credential_origin) BETWEEN 8 AND ${SAFE_BASE_URL_MAX_LENGTH}
             AND (
               credential_origin LIKE 'https://%' OR
               credential_origin LIKE 'http://%'
             )
             AND instr(credential_origin, '@') = 0
             AND instr(credential_origin, '?') = 0
             AND instr(credential_origin, '#') = 0
             AND instr(substr(credential_origin, 9), '/') = 0
           )
         )`;
const ADD_CREDENTIAL_STATE_COLUMN_SQL = `ALTER TABLE model_profiles
         ADD COLUMN credential_state TEXT NOT NULL DEFAULT 'missing'
         CHECK (${CREDENTIAL_STATE_CHECK})`;
const ADD_MIGRATION_ISSUE_COLUMN_SQL = `ALTER TABLE model_profiles
         ADD COLUMN migration_issue_code TEXT
         CHECK (${MIGRATION_ISSUE_CHECK})`;
const ADD_EXECUTION_REVISION_COLUMN_SQL = `ALTER TABLE model_profiles
         ADD COLUMN execution_revision INTEGER NOT NULL DEFAULT 0
         CHECK (execution_revision >= 0)`;
const V8_MODEL_PROFILE_COLUMN_PLAN = JSON.stringify({
  addColumns: [
    { name: "credential_origin", sql: ADD_CREDENTIAL_ORIGIN_COLUMN_SQL },
    { name: "credential_state", sql: ADD_CREDENTIAL_STATE_COLUMN_SQL },
    { name: "migration_issue_code", sql: ADD_MIGRATION_ISSUE_COLUMN_SQL },
    { name: "execution_revision", sql: ADD_EXECUTION_REVISION_COLUMN_SQL },
  ],
});
const V8_ORPHAN_LEDGER_SQL = `
CREATE TABLE IF NOT EXISTS model_profile_credential_orphan_cleanups (
  reference TEXT PRIMARY KEY,
  profile_id TEXT,
  provider TEXT
    CHECK (${MODEL_PROVIDER_CHECK}),
  canonical_origin TEXT,
  reason TEXT NOT NULL
    CHECK (${ORPHAN_REASON_CHECK}),
  attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK (attempt_count >= 0),
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_model_profile_credential_orphan_cleanups_updated
  ON model_profile_credential_orphan_cleanups(updated_at, reference);
`;
const V8_ORPHAN_LEDGER_UPSERT_SQL = `INSERT INTO model_profile_credential_orphan_cleanups
         (reference, profile_id, provider, canonical_origin, reason, attempt_count,
          last_error, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, 0, NULL,
               strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
               strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       ON CONFLICT(reference) DO UPDATE SET
         profile_id = excluded.profile_id,
         provider = excluded.provider,
         canonical_origin = excluded.canonical_origin,
         reason = excluded.reason,
         updated_at = excluded.updated_at`;
const V8_CLEAR_WORKSPACE_DEFAULT_SQL = `UPDATE workspace_settings
            SET default_model_profile_id = NULL,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE default_model_profile_id IS NOT NULL`;
const V8_CLEAR_PROJECT_DEFAULT_SQL = `UPDATE projects
            SET default_model_profile_id = NULL,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE default_model_profile_id IS NOT NULL`;
const V8_INTERRUPTIBLE_JOB_OPTIONAL_COLUMNS = JSON.stringify([
  "lease_owner",
  "lease_expires_at",
  "cancel_requested_at",
  "cancellation_reason",
]);
const V8_CREATE_IMPACTED_ASSISTANT_JOB_IDS_SQL = `CREATE TEMP TABLE temp_v8_impacted_assistant_job_ids (
       id TEXT PRIMARY KEY
     )`;
const V8_POPULATE_IMPACTED_ASSISTANT_JOB_IDS_SQL = `INSERT INTO temp_v8_impacted_assistant_job_ids (id)
       SELECT job.id
         FROM jobs job
        WHERE job.status IN ('queued', 'running')
          AND job.type = 'assistant_generate'`;
const V8_CREATE_IMPACTED_ASSISTANT_OUTPUT_IDS_SQL = `CREATE TEMP TABLE temp_v8_impacted_assistant_output_ids (
       id TEXT PRIMARY KEY
     )`;
const V8_POPULATE_IMPACTED_ASSISTANT_OUTPUT_IDS_SQL = `INSERT INTO temp_v8_impacted_assistant_output_ids (id)
       SELECT snapshot.output_message_id
         FROM assistant_generation_snapshots snapshot
         JOIN chat_messages message ON message.id = snapshot.output_message_id
        WHERE message.status IN ('pending', 'streaming')`;
const V8_ASSISTANT_MESSAGE_INTERRUPT_SQL = `UPDATE chat_messages
          SET status = 'interrupted',
              error_code = ?,
              completed_at = coalesce(completed_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id IN (
          SELECT id FROM temp_v8_impacted_assistant_output_ids
        )`;
const V8_ASSISTANT_JOB_SELECTION_SQL = `SELECT id
       FROM temp_v8_impacted_assistant_job_ids`;

const V8_CREATE_IMPACTED_WORKFLOW_RUN_IDS_SQL = `CREATE TEMP TABLE temp_v8_impacted_workflow_run_ids (
       id TEXT PRIMARY KEY
     )`;
const V8_POPULATE_IMPACTED_WORKFLOW_RUN_IDS_SQL = `INSERT INTO temp_v8_impacted_workflow_run_ids (id)
       SELECT snapshot.workflow_run_id
         FROM workflow_execution_snapshots snapshot
         JOIN workflow_runs run ON run.id = snapshot.workflow_run_id
        WHERE snapshot.model_profile_id IS NOT NULL
          AND run.status IN ('queued', 'waiting', 'running')`;
const V8_CREATE_IMPACTED_WORKFLOW_JOB_IDS_SQL = `CREATE TEMP TABLE temp_v8_impacted_workflow_job_ids (
       id TEXT PRIMARY KEY
     )`;
const V8_POPULATE_IMPACTED_WORKFLOW_JOB_IDS_SQL = `INSERT INTO temp_v8_impacted_workflow_job_ids (id)
       SELECT job.id
         FROM workflow_runs run
         JOIN jobs job ON job.id = run.job_id
         JOIN temp_v8_impacted_workflow_run_ids impacted
           ON impacted.id = run.id
        WHERE run.job_id IS NOT NULL
          AND job.status IN ('queued', 'running')
          AND job.type = 'workflow_run'`;
const V8_WORKFLOW_STEP_INTERRUPT_SQL = `UPDATE workflow_step_runs
          SET status = 'interrupted',
              error_code = ?,
              error_json = ?,
              completed_at = coalesce(completed_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE status IN ('queued', 'waiting', 'running')
          AND workflow_run_id IN (
            SELECT id FROM temp_v8_impacted_workflow_run_ids
          )`;
const V8_WORKFLOW_RUN_INTERRUPT_SQL = `UPDATE workflow_runs
          SET status = 'interrupted',
              error_code = ?,
              error_json = ?,
              completed_at = coalesce(completed_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id IN (
          SELECT id FROM temp_v8_impacted_workflow_run_ids
        )`;
const V8_WORKFLOW_JOB_SELECTION_SQL = `SELECT id
       FROM temp_v8_impacted_workflow_job_ids`;

const V8_CREATE_IMPACTED_TABULAR_MESSAGE_IDS_SQL = `CREATE TEMP TABLE temp_v8_impacted_tabular_message_ids (
       id TEXT PRIMARY KEY
     )`;
const V8_CREATE_IMPACTED_TABULAR_CELL_IDS_SQL = `CREATE TEMP TABLE temp_v8_impacted_tabular_cell_ids (
       id TEXT PRIMARY KEY
     )`;
const V8_CREATE_IMPACTED_TABULAR_REVIEW_IDS_SQL = `CREATE TEMP TABLE temp_v8_impacted_tabular_review_ids (
       id TEXT PRIMARY KEY
     )`;
const V8_CREATE_IMPACTED_TABULAR_JOB_IDS_SQL = `CREATE TEMP TABLE temp_v8_impacted_tabular_job_ids (
       id TEXT PRIMARY KEY
     )`;
const V8_POPULATE_IMPACTED_TABULAR_CELL_IDS_SQL = `INSERT INTO temp_v8_impacted_tabular_cell_ids (id)
       SELECT cell.id
         FROM tabular_cells cell
        WHERE cell.status IN ('queued', 'running')`;
const V8_POPULATE_IMPACTED_TABULAR_MESSAGE_IDS_SQL = `INSERT INTO temp_v8_impacted_tabular_message_ids (id)
       SELECT DISTINCT message.id
         FROM tabular_review_chat_messages message
         LEFT JOIN tabular_review_chats chat ON chat.id = message.review_chat_id
        WHERE message.status IN ('pending', 'streaming')
          AND (
            message.job_id IN (
              SELECT id FROM temp_v8_impacted_assistant_job_ids
            )
            OR chat.job_id IN (
              SELECT id FROM temp_v8_impacted_assistant_job_ids
            )
          )`;
const V8_POPULATE_IMPACTED_TABULAR_REVIEW_IDS_SQL = `INSERT INTO temp_v8_impacted_tabular_review_ids (id)
       SELECT review.id
         FROM tabular_reviews review
        WHERE review.status = 'running'
       UNION
       SELECT DISTINCT cell.review_id
         FROM tabular_cells cell
         JOIN temp_v8_impacted_tabular_cell_ids impacted
           ON impacted.id = cell.id
       UNION
       SELECT DISTINCT chat.review_id
         FROM tabular_review_chats chat
        WHERE chat.status = 'active'
          AND chat.job_id IN (
            SELECT id FROM temp_v8_impacted_assistant_job_ids
          )
       UNION
       SELECT DISTINCT chat.review_id
         FROM tabular_review_chat_messages message
         JOIN temp_v8_impacted_tabular_message_ids impacted
           ON impacted.id = message.id
         JOIN tabular_review_chats chat ON chat.id = message.review_chat_id`;
const V8_POPULATE_IMPACTED_TABULAR_JOB_IDS_SQL = `INSERT INTO temp_v8_impacted_tabular_job_ids (id)
       SELECT job.id
         FROM jobs job
        WHERE job.status IN ('queued', 'running')
          AND job.type = 'tabular_cell'
          AND job.resource_type = 'tabular_cell'`;
const V8_TABULAR_CHAT_MESSAGE_INTERRUPT_SQL = `UPDATE tabular_review_chat_messages
            SET status = 'interrupted',
                completed_at = coalesce(completed_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE id IN (
            SELECT id FROM temp_v8_impacted_tabular_message_ids
          )`;
const V8_TABULAR_CELL_INTERRUPT_SQL = `UPDATE tabular_cells
            SET status = 'failed',
                error_code = ?,
                error_json = ?,
                completed_at = coalesce(completed_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE id IN (
            SELECT id FROM temp_v8_impacted_tabular_cell_ids
          )`;
const V8_TABULAR_REVIEW_INTERRUPT_SQL = `UPDATE tabular_reviews
          SET status = 'failed',
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE status IN ('draft', 'ready', 'running')
          AND id IN (
            SELECT id FROM temp_v8_impacted_tabular_review_ids
          )`;
const V8_TABULAR_JOB_SELECTION_SQL = `SELECT id
       FROM temp_v8_impacted_tabular_job_ids`;
const V8_PROFILE_SELECT_SQL = `SELECT id, provider, base_url, credential_ref, credential_status,
              CASE WHEN ${V8_LEGACY_CREDENTIAL_EVIDENCE_SQL}
                THEN 1
                ELSE 0
              END AS legacy_credential_evidence
         FROM model_profiles
        ORDER BY id`;
const V8_CREATE_FORCED_DORMANT_PROFILES_SQL = `CREATE TEMP TABLE temp_v8_forced_dormant_profiles (
       id TEXT PRIMARY KEY
     )`;
const V8_CREATE_CREDENTIAL_IMPACTED_PROFILES_SQL = `CREATE TEMP TABLE temp_v8_credential_impacted_profiles (
       id TEXT PRIMARY KEY
     )`;
const V8_PROFILE_RESET_SQL = `UPDATE model_profiles
            SET base_url = ?,
                credential_ref = NULL,
                credential_origin = NULL,
                credential_state = 'missing',
                credential_status = 'not_configured',
                migration_issue_code = ?,
                execution_revision = 0,
                enabled = 0,
                is_default = 0
          WHERE id = ?`;
const V8_FORCED_DORMANT_PROFILE_INSERT_SQL = `INSERT INTO temp_v8_forced_dormant_profiles (id)
           VALUES (?)
           ON CONFLICT(id) DO NOTHING`;
const V8_CREDENTIAL_IMPACTED_PROFILE_INSERT_SQL = `INSERT INTO temp_v8_credential_impacted_profiles (id)
           VALUES (?)
           ON CONFLICT(id) DO NOTHING`;
const V8_PROFILE_POSTCONDITION_SQL = `SELECT id
         FROM model_profiles
        WHERE credential_ref IS NOT NULL
           OR credential_origin IS NOT NULL
           OR credential_state <> 'missing'
           OR enabled <> 0
           OR is_default <> 0
        LIMIT 1`;
const V8_WORKSPACE_DEFAULT_POSTCONDITION_SQL = `SELECT id
         FROM workspace_settings
        WHERE default_model_profile_id IS NOT NULL
        LIMIT 1`;
const V8_PROJECT_DEFAULT_POSTCONDITION_SQL = `SELECT id
         FROM projects
        WHERE default_model_profile_id IS NOT NULL
        LIMIT 1`;
const V8_DROP_IMPACTED_ASSISTANT_JOB_IDS_SQL =
  "DROP TABLE temp_v8_impacted_assistant_job_ids";
const V8_DROP_IMPACTED_ASSISTANT_OUTPUT_IDS_SQL =
  "DROP TABLE temp_v8_impacted_assistant_output_ids";
const V8_DROP_IMPACTED_WORKFLOW_RUN_IDS_SQL =
  "DROP TABLE temp_v8_impacted_workflow_run_ids";
const V8_DROP_IMPACTED_WORKFLOW_JOB_IDS_SQL =
  "DROP TABLE temp_v8_impacted_workflow_job_ids";
const V8_DROP_IMPACTED_TABULAR_MESSAGE_IDS_SQL =
  "DROP TABLE temp_v8_impacted_tabular_message_ids";
const V8_DROP_IMPACTED_TABULAR_CELL_IDS_SQL =
  "DROP TABLE temp_v8_impacted_tabular_cell_ids";
const V8_DROP_IMPACTED_TABULAR_REVIEW_IDS_SQL =
  "DROP TABLE temp_v8_impacted_tabular_review_ids";
const V8_DROP_IMPACTED_TABULAR_JOB_IDS_SQL =
  "DROP TABLE temp_v8_impacted_tabular_job_ids";
const V8_DROP_FORCED_DORMANT_PROFILES_SQL =
  "DROP TABLE temp_v8_forced_dormant_profiles";
const V8_DROP_CREDENTIAL_IMPACTED_PROFILES_SQL =
  "DROP TABLE temp_v8_credential_impacted_profiles";
const V8_APPLY_POLICY = {
  errors: {
    stageOrder: "Workspace model credential migration stage order is invalid.",
    postcondition: "Workspace model credential migration postcondition failed.",
    plaintextDestructiveRewrite: V8_PLAINTEXT_DESTRUCTIVE_REWRITE_ERROR,
    sqlcipherCapabilityMismatch: V8_SQLCIPHER_CAPABILITY_MISMATCH_ERROR,
  },
  stageOrder: [
    "assert_encrypted_destructive_rewrite_preflight",
    "ensure_structural_schema",
    "select_profiles_in_id_order",
    "materialize_impacted_assistant_work",
    "materialize_impacted_workflow_work",
    "materialize_impacted_tabular_work",
    "prepare_profile_tracking_temp_tables",
    "reset_profiles_to_forced_dormant_and_capture_legacy_credential_evidence",
    "clear_default_model_profile_selections",
    "queue_legacy_credential_orphan_cleanup",
    "reconcile_impacted_assistant_work",
    "reconcile_impacted_workflow_work",
    "reconcile_impacted_tabular_work",
    "cleanup_impacted_tabular_work_temp_tables",
    "cleanup_impacted_workflow_work_temp_tables",
    "cleanup_impacted_assistant_work_temp_tables",
    "drop_credential_impacted_profile_temp_table",
    "drop_forced_dormant_profile_temp_table",
    "assert_postconditions",
  ],
  destructiveRewrite: JSON.parse(V8_DESTRUCTIVE_REWRITE_POLICY),
  legacyCredentialEvidence: JSON.parse(V8_LEGACY_CREDENTIAL_EVIDENCE_POLICY),
  postconditions: {
    profilesSql: V8_PROFILE_POSTCONDITION_SQL,
    workspaceDefaultSql: V8_WORKSPACE_DEFAULT_POSTCONDITION_SQL,
    projectDefaultSql: V8_PROJECT_DEFAULT_POSTCONDITION_SQL,
  },
} as const;
const V8_APPLY_PLAN = JSON.stringify({
  selectProfilesSql: V8_PROFILE_SELECT_SQL,
  createForcedDormantProfilesSql: V8_CREATE_FORCED_DORMANT_PROFILES_SQL,
  createCredentialImpactedProfilesSql:
    V8_CREATE_CREDENTIAL_IMPACTED_PROFILES_SQL,
  resetProfileSql: V8_PROFILE_RESET_SQL,
  forcedDormantInsertSql: V8_FORCED_DORMANT_PROFILE_INSERT_SQL,
  credentialImpactedInsertSql: V8_CREDENTIAL_IMPACTED_PROFILE_INSERT_SQL,
  dropForcedDormantProfilesSql: V8_DROP_FORCED_DORMANT_PROFILES_SQL,
  dropCredentialImpactedProfilesSql: V8_DROP_CREDENTIAL_IMPACTED_PROFILES_SQL,
  stageOrder: V8_APPLY_POLICY.stageOrder,
  legacyCredentialEvidence: V8_APPLY_POLICY.legacyCredentialEvidence,
  postconditions: V8_APPLY_POLICY.postconditions,
  allProfilesForcedDormant: true,
  allDefaultsCleared: true,
  forcedDormantProfiles: "all profiles",
  credentialImpactedProfiles: "legacy credential evidence only",
  reconciliations: {
    assistant: {
      tempTables: {
        createJobIdsSql: V8_CREATE_IMPACTED_ASSISTANT_JOB_IDS_SQL,
        populateJobIdsSql: V8_POPULATE_IMPACTED_ASSISTANT_JOB_IDS_SQL,
        createOutputIdsSql: V8_CREATE_IMPACTED_ASSISTANT_OUTPUT_IDS_SQL,
        populateOutputIdsSql: V8_POPULATE_IMPACTED_ASSISTANT_OUTPUT_IDS_SQL,
        dropJobIdsSql: V8_DROP_IMPACTED_ASSISTANT_JOB_IDS_SQL,
        dropOutputIdsSql: V8_DROP_IMPACTED_ASSISTANT_OUTPUT_IDS_SQL,
      },
      messageSql: V8_ASSISTANT_MESSAGE_INTERRUPT_SQL,
      jobSelectionSql: V8_ASSISTANT_JOB_SELECTION_SQL,
    },
    workflow: {
      tempTables: {
        createRunIdsSql: V8_CREATE_IMPACTED_WORKFLOW_RUN_IDS_SQL,
        populateRunIdsSql: V8_POPULATE_IMPACTED_WORKFLOW_RUN_IDS_SQL,
        createJobIdsSql: V8_CREATE_IMPACTED_WORKFLOW_JOB_IDS_SQL,
        populateJobIdsSql: V8_POPULATE_IMPACTED_WORKFLOW_JOB_IDS_SQL,
        dropRunIdsSql: V8_DROP_IMPACTED_WORKFLOW_RUN_IDS_SQL,
        dropJobIdsSql: V8_DROP_IMPACTED_WORKFLOW_JOB_IDS_SQL,
      },
      stepSql: V8_WORKFLOW_STEP_INTERRUPT_SQL,
      runSql: V8_WORKFLOW_RUN_INTERRUPT_SQL,
      jobSelectionSql: V8_WORKFLOW_JOB_SELECTION_SQL,
    },
    tabular: {
      tempTables: {
        createMessageIdsSql: V8_CREATE_IMPACTED_TABULAR_MESSAGE_IDS_SQL,
        populateMessageIdsSql: V8_POPULATE_IMPACTED_TABULAR_MESSAGE_IDS_SQL,
        createCellIdsSql: V8_CREATE_IMPACTED_TABULAR_CELL_IDS_SQL,
        populateCellIdsSql: V8_POPULATE_IMPACTED_TABULAR_CELL_IDS_SQL,
        createReviewIdsSql: V8_CREATE_IMPACTED_TABULAR_REVIEW_IDS_SQL,
        populateReviewIdsSql: V8_POPULATE_IMPACTED_TABULAR_REVIEW_IDS_SQL,
        createJobIdsSql: V8_CREATE_IMPACTED_TABULAR_JOB_IDS_SQL,
        populateJobIdsSql: V8_POPULATE_IMPACTED_TABULAR_JOB_IDS_SQL,
        dropMessageIdsSql: V8_DROP_IMPACTED_TABULAR_MESSAGE_IDS_SQL,
        dropCellIdsSql: V8_DROP_IMPACTED_TABULAR_CELL_IDS_SQL,
        dropReviewIdsSql: V8_DROP_IMPACTED_TABULAR_REVIEW_IDS_SQL,
        dropJobIdsSql: V8_DROP_IMPACTED_TABULAR_JOB_IDS_SQL,
      },
      chatMessageSql: V8_TABULAR_CHAT_MESSAGE_INTERRUPT_SQL,
      cellSql: V8_TABULAR_CELL_INTERRUPT_SQL,
      reviewSql: V8_TABULAR_REVIEW_INTERRUPT_SQL,
      jobSelectionSql: V8_TABULAR_JOB_SELECTION_SQL,
    },
  },
});

function hasTable(database: WorkspaceDatabaseAdapter, name: string) {
  return Boolean(database.prepare(SQLITE_HAS_TABLE_SQL).get(name));
}

function hasDestructiveRewriteEvidence(database: WorkspaceDatabaseAdapter) {
  const row = database.prepare(V8_DESTRUCTIVE_REWRITE_EVIDENCE_SQL).get();
  if (Number(row?.destructive_evidence ?? 0) === 1) return true;
  const includesCredentialOrigin = hasColumn(
    database,
    "model_profiles",
    "credential_origin",
  );
  const profiles = database
    .prepare(
      includesCredentialOrigin
        ? V8_PROFILE_ENDPOINT_WITH_ORIGIN_EVIDENCE_SELECT_SQL
        : V8_PROFILE_ENDPOINT_EVIDENCE_SELECT_SQL,
    )
    .all();
  return profiles.some((profile) => {
    const baseUrl = profile.base_url;
    if (
      baseUrl !== null &&
      baseUrl !== undefined &&
      baseUrl !== sanitizeLegacyBaseUrlForMigration(baseUrl)
    ) {
      return true;
    }
    return includesCredentialOrigin && profile.credential_origin != null;
  });
}

function hasColumn(
  database: WorkspaceDatabaseAdapter,
  table: string,
  column: string,
) {
  if (!hasTable(database, table)) return false;
  return database
    .prepare(`PRAGMA table_info("${table}")`)
    .all()
    .some((row) => String(row.name) === column);
}

function normalizedHost(hostname: string) {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(HOSTNAME_TRAILING_DOTS_PATTERN, "");
}

function parseIpv4(hostname: string) {
  const value = normalizedHost(hostname);
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return null;
  const parts = value.split(".").map((part) => Number(part));
  if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }
  return parts as [number, number, number, number];
}

function isReservedIpv4(hostname: string) {
  const parts = parseIpv4(hostname);
  if (!parts) return false;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51) ||
    (a === 203 && b === 0) ||
    a >= 224
  );
}

function mappedIpv4Hostname(hostname: string) {
  const value = normalizedHost(hostname);
  if (!value.startsWith("::ffff:")) return null;
  const mapped = value.slice("::ffff:".length);
  const dotted = parseIpv4(mapped);
  if (dotted) {
    return `${dotted[0]}.${dotted[1]}.${dotted[2]}.${dotted[3]}`;
  }
  const groups = mapped.split(":").filter((part) => part.length > 0);
  if (groups.length === 0 || groups.length > 2) return null;
  if (groups.some((part) => !/^[0-9a-f]{1,4}$/i.test(part))) return null;
  const [high, low] =
    groups.length === 1
      ? [0, Number.parseInt(groups[0], 16)]
      : groups.map((part) => Number.parseInt(part, 16));
  if (
    !Number.isInteger(high) ||
    !Number.isInteger(low) ||
    high < 0 ||
    high > 0xffff ||
    low < 0 ||
    low > 0xffff
  ) {
    return null;
  }
  return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
}

function isReservedIpv6(hostname: string) {
  const value = normalizedHost(hostname);
  if (value === "::" || value === "::1") return true;
  const mappedIpv4 = mappedIpv4Hostname(value);
  if (mappedIpv4) {
    return isReservedIpv4(mappedIpv4) || mappedIpv4.startsWith("127.");
  }
  return (
    new RegExp(DOCUMENTATION_IPV6_PREFIX_PATTERN_SOURCE, "i").test(value) ||
    /^fc/i.test(value) ||
    /^fd/i.test(value) ||
    /^fe[89ab]/i.test(value) ||
    /^ff/i.test(value)
  );
}

function isLocalOrReservedHost(hostname: string) {
  const value = normalizedHost(hostname);
  if (value === LOCALHOST_EXACT_HOST || value.endsWith(LOCALHOST_SUFFIX)) {
    return true;
  }
  const family = isIP(value);
  if (family === 4) return isReservedIpv4(value);
  if (family === 6) return isReservedIpv6(value);
  return false;
}

function normalizedPathname(pathname: string) {
  if (pathname === "/") return "";
  const trimmed = pathname.replace(/\/+$/g, "");
  return trimmed || "";
}

function sanitizeLegacyBaseUrlForMigration(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > SAFE_BASE_URL_MAX_LENGTH) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (parsed.username || parsed.password) return null;
  if (parsed.search || parsed.hash) return null;
  if (isLocalOrReservedHost(parsed.hostname)) return null;
  const baseUrl = `${parsed.protocol}//${parsed.host}${normalizedPathname(parsed.pathname)}`;
  return baseUrl.length <= SAFE_BASE_URL_MAX_LENGTH ? baseUrl : null;
}

function safeLegacyCredentialReference(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 256) return null;
  const match = trimmed.match(LEGACY_REFERENCE_PATTERN);
  if (!match) return null;
  return match[2]
    ? `keychain://vera/model-profile/${match[1].toLowerCase()}/${match[2].toLowerCase()}`
    : `keychain://vera/model-profile/${match[1].toLowerCase()}`;
}

function ensureModelProfileColumns(database: WorkspaceDatabaseAdapter) {
  if (!hasColumn(database, "model_profiles", "credential_origin")) {
    database.exec(ADD_CREDENTIAL_ORIGIN_COLUMN_SQL);
  }
  if (!hasColumn(database, "model_profiles", "credential_state")) {
    database.exec(ADD_CREDENTIAL_STATE_COLUMN_SQL);
  }
  if (!hasColumn(database, "model_profiles", "migration_issue_code")) {
    database.exec(ADD_MIGRATION_ISSUE_COLUMN_SQL);
  }
  if (!hasColumn(database, "model_profiles", "execution_revision")) {
    database.exec(ADD_EXECUTION_REVISION_COLUMN_SQL);
  }
}

function ensureOrphanCleanupLedger(database: WorkspaceDatabaseAdapter) {
  database.exec(V8_ORPHAN_LEDGER_SQL);
}

function queueLegacyOrphanCleanup(
  database: WorkspaceDatabaseAdapter,
  input: {
    reference: string;
    profileId: string;
    provider: string;
  },
) {
  database
    .prepare(V8_ORPHAN_LEDGER_UPSERT_SQL)
    .run(
      input.reference,
      input.profileId,
      input.provider,
      MIGRATION_ORPHAN_REASON,
    );
}

function clearAllDefaultModelProfileSelections(
  database: WorkspaceDatabaseAdapter,
) {
  if (hasTable(database, "workspace_settings")) {
    database.prepare(V8_CLEAR_WORKSPACE_DEFAULT_SQL).run();
  }
  if (
    hasTable(database, "projects") &&
    hasColumn(database, "projects", "default_model_profile_id")
  ) {
    database.prepare(V8_CLEAR_PROJECT_DEFAULT_SQL).run();
  }
}

function assertV8Postconditions(database: WorkspaceDatabaseAdapter) {
  if (database.prepare(V8_PROFILE_POSTCONDITION_SQL).get()) {
    throw new Error(V8_APPLY_POLICY.errors.postcondition);
  }
  if (
    hasTable(database, "workspace_settings") &&
    database.prepare(V8_WORKSPACE_DEFAULT_POSTCONDITION_SQL).get()
  ) {
    throw new Error(V8_APPLY_POLICY.errors.postcondition);
  }
  if (
    hasTable(database, "projects") &&
    hasColumn(database, "projects", "default_model_profile_id") &&
    database.prepare(V8_PROJECT_DEFAULT_POSTCONDITION_SQL).get()
  ) {
    throw new Error(V8_APPLY_POLICY.errors.postcondition);
  }
}

function interruptJobsSetClause(database: WorkspaceDatabaseAdapter) {
  const assignments = [
    `status = 'interrupted'`,
    "retryable = 0",
    "result_json = NULL",
    "error_code = ?",
    "error_json = ?",
    "locked_at = NULL",
  ];
  if (hasColumn(database, "jobs", "lease_owner")) {
    assignments.push("lease_owner = NULL");
  }
  if (hasColumn(database, "jobs", "lease_expires_at")) {
    assignments.push("lease_expires_at = NULL");
  }
  if (hasColumn(database, "jobs", "cancel_requested_at")) {
    assignments.push("cancel_requested_at = NULL");
  }
  if (hasColumn(database, "jobs", "cancellation_reason")) {
    assignments.push("cancellation_reason = NULL");
  }
  assignments.push(
    "completed_at = coalesce(completed_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
    "updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
  );
  return assignments.join(",\n              ");
}

function interruptJobsBySelection(
  database: WorkspaceDatabaseAdapter,
  selectionSql: string,
) {
  database
    .prepare(
      `UPDATE jobs
          SET ${interruptJobsSetClause(database)}
        WHERE id IN (${selectionSql})`,
    )
    .run(MIGRATION_ISSUE_CODE, MIGRATION_ERROR_JSON);
}

function materializeImpactedAssistantWork(database: WorkspaceDatabaseAdapter) {
  database.exec(V8_CREATE_IMPACTED_ASSISTANT_JOB_IDS_SQL);
  database.exec(V8_CREATE_IMPACTED_ASSISTANT_OUTPUT_IDS_SQL);
  if (hasTable(database, "jobs")) {
    database.exec(V8_POPULATE_IMPACTED_ASSISTANT_JOB_IDS_SQL);
  }
  if (
    hasTable(database, "assistant_generation_snapshots") &&
    hasTable(database, "chat_messages")
  ) {
    database.exec(V8_POPULATE_IMPACTED_ASSISTANT_OUTPUT_IDS_SQL);
  }
}

function cleanupImpactedAssistantWork(database: WorkspaceDatabaseAdapter) {
  database.exec(V8_DROP_IMPACTED_ASSISTANT_OUTPUT_IDS_SQL);
  database.exec(V8_DROP_IMPACTED_ASSISTANT_JOB_IDS_SQL);
}

function reconcileImpactedAssistantWork(database: WorkspaceDatabaseAdapter) {
  if (hasTable(database, "chat_messages")) {
    database
      .prepare(V8_ASSISTANT_MESSAGE_INTERRUPT_SQL)
      .run(MIGRATION_ISSUE_CODE);
  }
  if (hasTable(database, "jobs")) {
    interruptJobsBySelection(database, V8_ASSISTANT_JOB_SELECTION_SQL);
  }
}

function materializeImpactedWorkflowWork(database: WorkspaceDatabaseAdapter) {
  database.exec(V8_CREATE_IMPACTED_WORKFLOW_RUN_IDS_SQL);
  database.exec(V8_CREATE_IMPACTED_WORKFLOW_JOB_IDS_SQL);
  if (
    hasTable(database, "workflow_execution_snapshots") &&
    hasTable(database, "workflow_runs")
  ) {
    database.exec(V8_POPULATE_IMPACTED_WORKFLOW_RUN_IDS_SQL);
  }
  if (hasTable(database, "workflow_runs") && hasTable(database, "jobs")) {
    database.exec(V8_POPULATE_IMPACTED_WORKFLOW_JOB_IDS_SQL);
  }
}

function cleanupImpactedWorkflowWork(database: WorkspaceDatabaseAdapter) {
  database.exec(V8_DROP_IMPACTED_WORKFLOW_JOB_IDS_SQL);
  database.exec(V8_DROP_IMPACTED_WORKFLOW_RUN_IDS_SQL);
}

function reconcileImpactedWorkflowWork(database: WorkspaceDatabaseAdapter) {
  if (hasTable(database, "workflow_step_runs")) {
    database
      .prepare(V8_WORKFLOW_STEP_INTERRUPT_SQL)
      .run(MIGRATION_ISSUE_CODE, MIGRATION_ERROR_JSON);
  }
  if (hasTable(database, "workflow_runs")) {
    database
      .prepare(V8_WORKFLOW_RUN_INTERRUPT_SQL)
      .run(MIGRATION_ISSUE_CODE, MIGRATION_ERROR_JSON);
  }
  if (hasTable(database, "jobs")) {
    interruptJobsBySelection(database, V8_WORKFLOW_JOB_SELECTION_SQL);
  }
}

function materializeImpactedTabularWork(database: WorkspaceDatabaseAdapter) {
  database.exec(V8_CREATE_IMPACTED_TABULAR_MESSAGE_IDS_SQL);
  database.exec(V8_CREATE_IMPACTED_TABULAR_CELL_IDS_SQL);
  database.exec(V8_CREATE_IMPACTED_TABULAR_REVIEW_IDS_SQL);
  database.exec(V8_CREATE_IMPACTED_TABULAR_JOB_IDS_SQL);
  if (hasTable(database, "tabular_cells")) {
    database.exec(V8_POPULATE_IMPACTED_TABULAR_CELL_IDS_SQL);
  }
  if (
    hasTable(database, "tabular_review_chat_messages") &&
    hasTable(database, "tabular_review_chats")
  ) {
    database.exec(V8_POPULATE_IMPACTED_TABULAR_MESSAGE_IDS_SQL);
  }
  if (hasTable(database, "tabular_reviews")) {
    database.exec(V8_POPULATE_IMPACTED_TABULAR_REVIEW_IDS_SQL);
  }
  if (hasTable(database, "jobs")) {
    database.exec(V8_POPULATE_IMPACTED_TABULAR_JOB_IDS_SQL);
  }
}

function cleanupImpactedTabularWork(database: WorkspaceDatabaseAdapter) {
  database.exec(V8_DROP_IMPACTED_TABULAR_JOB_IDS_SQL);
  database.exec(V8_DROP_IMPACTED_TABULAR_REVIEW_IDS_SQL);
  database.exec(V8_DROP_IMPACTED_TABULAR_CELL_IDS_SQL);
  database.exec(V8_DROP_IMPACTED_TABULAR_MESSAGE_IDS_SQL);
}

function reconcileImpactedTabularWork(database: WorkspaceDatabaseAdapter) {
  if (hasTable(database, "tabular_review_chat_messages")) {
    database.prepare(V8_TABULAR_CHAT_MESSAGE_INTERRUPT_SQL).run();
  }
  if (hasTable(database, "tabular_cells")) {
    database
      .prepare(V8_TABULAR_CELL_INTERRUPT_SQL)
      .run(MIGRATION_ISSUE_CODE, MIGRATION_ERROR_JSON);
  }
  if (hasTable(database, "tabular_reviews")) {
    database.prepare(V8_TABULAR_REVIEW_INTERRUPT_SQL).run();
  }
  if (hasTable(database, "jobs")) {
    interruptJobsBySelection(database, V8_TABULAR_JOB_SELECTION_SQL);
  }
}

function applyModelCredentialOriginV8(
  database: WorkspaceDatabaseAdapter,
  capabilities: WorkspaceDatabaseCapabilities,
) {
  let stageIndex = 0;
  const enterStage = (stage: (typeof V8_APPLY_POLICY.stageOrder)[number]) => {
    if (V8_APPLY_POLICY.stageOrder[stageIndex] !== stage) {
      throw new Error(V8_APPLY_POLICY.errors.stageOrder);
    }
    stageIndex += 1;
  };

  enterStage("assert_encrypted_destructive_rewrite_preflight");
  const reattestedSqlcipherEncrypted =
    isWorkspaceConnectionSqlcipherEncrypted(database);
  if (capabilities.sqlcipherEncrypted !== reattestedSqlcipherEncrypted) {
    throw new WorkspaceMigrationError(
      V8_APPLY_POLICY.errors.sqlcipherCapabilityMismatch,
    );
  }
  if (
    !reattestedSqlcipherEncrypted &&
    hasDestructiveRewriteEvidence(database)
  ) {
    throw new WorkspaceMigrationError(
      V8_APPLY_POLICY.errors.plaintextDestructiveRewrite,
    );
  }

  enterStage("ensure_structural_schema");
  ensureModelProfileColumns(database);
  ensureOrphanCleanupLedger(database);

  enterStage("select_profiles_in_id_order");
  const profiles = database.prepare(V8_PROFILE_SELECT_SQL).all();

  enterStage("materialize_impacted_assistant_work");
  materializeImpactedAssistantWork(database);
  enterStage("materialize_impacted_workflow_work");
  materializeImpactedWorkflowWork(database);
  enterStage("materialize_impacted_tabular_work");
  materializeImpactedTabularWork(database);

  enterStage("prepare_profile_tracking_temp_tables");
  database.exec(V8_CREATE_FORCED_DORMANT_PROFILES_SQL);
  database.exec(V8_CREATE_CREDENTIAL_IMPACTED_PROFILES_SQL);

  const pendingLegacyOrphanCleanups: Array<{
    reference: string;
    profileId: string;
    provider: string;
  }> = [];

  enterStage(
    "reset_profiles_to_forced_dormant_and_capture_legacy_credential_evidence",
  );
  for (const row of profiles) {
    const profileId = String(row.id);
    const provider = String(row.provider);
    const hasLegacyCredentialEvidence =
      Number(row.legacy_credential_evidence ?? 0) === 1;
    database.prepare(V8_FORCED_DORMANT_PROFILE_INSERT_SQL).run(profileId);
    if (hasLegacyCredentialEvidence) {
      database
        .prepare(V8_CREDENTIAL_IMPACTED_PROFILE_INSERT_SQL)
        .run(profileId);
      const safeReference = safeLegacyCredentialReference(row.credential_ref);
      if (safeReference) {
        pendingLegacyOrphanCleanups.push({
          reference: safeReference,
          profileId,
          provider,
        });
      }
    }
    database
      .prepare(V8_PROFILE_RESET_SQL)
      .run(
        sanitizeLegacyBaseUrlForMigration(row.base_url),
        hasLegacyCredentialEvidence ? MIGRATION_ISSUE_CODE : null,
        profileId,
      );
  }

  enterStage("clear_default_model_profile_selections");
  clearAllDefaultModelProfileSelections(database);

  enterStage("queue_legacy_credential_orphan_cleanup");
  for (const cleanup of pendingLegacyOrphanCleanups) {
    queueLegacyOrphanCleanup(database, cleanup);
  }

  enterStage("reconcile_impacted_assistant_work");
  reconcileImpactedAssistantWork(database);
  enterStage("reconcile_impacted_workflow_work");
  reconcileImpactedWorkflowWork(database);
  enterStage("reconcile_impacted_tabular_work");
  reconcileImpactedTabularWork(database);

  enterStage("cleanup_impacted_tabular_work_temp_tables");
  cleanupImpactedTabularWork(database);
  enterStage("cleanup_impacted_workflow_work_temp_tables");
  cleanupImpactedWorkflowWork(database);
  enterStage("cleanup_impacted_assistant_work_temp_tables");
  cleanupImpactedAssistantWork(database);

  enterStage("drop_credential_impacted_profile_temp_table");
  database.exec(V8_DROP_CREDENTIAL_IMPACTED_PROFILES_SQL);
  enterStage("drop_forced_dormant_profile_temp_table");
  database.exec(V8_DROP_FORCED_DORMANT_PROFILES_SQL);

  enterStage("assert_postconditions");
  assertV8Postconditions(database);
  if (stageIndex !== V8_APPLY_POLICY.stageOrder.length) {
    throw new Error(V8_APPLY_POLICY.errors.stageOrder);
  }
}

export const MODEL_CREDENTIAL_ORIGIN_V8_MIGRATION: WorkspaceMigration = {
  version: 8,
  name: "workspace_model_credential_origin",
  checksumMaterial: [
    MIGRATION_ISSUE_CODE,
    MIGRATION_ORPHAN_REASON,
    MIGRATION_ERROR_JSON,
    MODEL_PROVIDER_CHECK,
    CREDENTIAL_STATE_CHECK,
    MIGRATION_ISSUE_CHECK,
    ORPHAN_REASON_CHECK,
    SQLITE_HAS_TABLE_SQL,
    LEGACY_REFERENCE_PATTERN_SOURCE,
    LEGACY_REFERENCE_PATTERN_FLAGS,
    String(SAFE_BASE_URL_MAX_LENGTH),
    DOCUMENTATION_IPV6_PREFIX_PATTERN_SOURCE,
    HOSTNAME_TRAILING_DOTS_PATTERN_SOURCE,
    LOCALHOST_EXACT_HOST,
    LOCALHOST_SUFFIX,
    RESERVED_IPV4_POLICY,
    RESERVED_IPV6_POLICY,
    V8_LOCALHOST_POLICY,
    V8_HOST_CLASSIFICATION_POLICY,
    V8_BASE_URL_SANITIZER_POLICY,
    V8_REFERENCE_POLICY,
    V8_LEGACY_CREDENTIAL_EVIDENCE_SQL,
    V8_LEGACY_CREDENTIAL_EVIDENCE_POLICY,
    WORKSPACE_SQLCIPHER_CONNECTION_POLICY_MATERIAL,
    V8_PLAINTEXT_DESTRUCTIVE_REWRITE_ERROR,
    V8_SQLCIPHER_CAPABILITY_MISMATCH_ERROR,
    V8_PROFILE_DESTRUCTIVE_EVIDENCE_SQL,
    V8_PROFILE_ENDPOINT_EVIDENCE_SELECT_SQL,
    V8_PROFILE_ENDPOINT_WITH_ORIGIN_EVIDENCE_SELECT_SQL,
    V8_JOB_SENSITIVE_REWRITE_EVIDENCE_SQL,
    V8_ASSISTANT_JOB_DESTRUCTIVE_EVIDENCE_SQL,
    V8_ASSISTANT_OUTPUT_DESTRUCTIVE_EVIDENCE_SQL,
    V8_WORKFLOW_RUN_DESTRUCTIVE_EVIDENCE_SQL,
    V8_WORKFLOW_STEP_DESTRUCTIVE_EVIDENCE_SQL,
    V8_WORKFLOW_JOB_DESTRUCTIVE_EVIDENCE_SQL,
    V8_TABULAR_CELL_DESTRUCTIVE_EVIDENCE_SQL,
    V8_TABULAR_JOB_DESTRUCTIVE_EVIDENCE_SQL,
    V8_DESTRUCTIVE_REWRITE_EVIDENCE_SQL,
    V8_DESTRUCTIVE_REWRITE_POLICY,
    V8_MODEL_PROFILE_COLUMN_PLAN,
    V8_ORPHAN_LEDGER_SQL,
    V8_ORPHAN_LEDGER_UPSERT_SQL,
    V8_CLEAR_WORKSPACE_DEFAULT_SQL,
    V8_CLEAR_PROJECT_DEFAULT_SQL,
    V8_INTERRUPTIBLE_JOB_OPTIONAL_COLUMNS,
    V8_CREATE_IMPACTED_ASSISTANT_JOB_IDS_SQL,
    V8_POPULATE_IMPACTED_ASSISTANT_JOB_IDS_SQL,
    V8_CREATE_IMPACTED_ASSISTANT_OUTPUT_IDS_SQL,
    V8_POPULATE_IMPACTED_ASSISTANT_OUTPUT_IDS_SQL,
    V8_ASSISTANT_MESSAGE_INTERRUPT_SQL,
    V8_ASSISTANT_JOB_SELECTION_SQL,
    V8_CREATE_IMPACTED_WORKFLOW_RUN_IDS_SQL,
    V8_POPULATE_IMPACTED_WORKFLOW_RUN_IDS_SQL,
    V8_CREATE_IMPACTED_WORKFLOW_JOB_IDS_SQL,
    V8_POPULATE_IMPACTED_WORKFLOW_JOB_IDS_SQL,
    V8_WORKFLOW_STEP_INTERRUPT_SQL,
    V8_WORKFLOW_RUN_INTERRUPT_SQL,
    V8_WORKFLOW_JOB_SELECTION_SQL,
    V8_CREATE_IMPACTED_TABULAR_MESSAGE_IDS_SQL,
    V8_POPULATE_IMPACTED_TABULAR_MESSAGE_IDS_SQL,
    V8_CREATE_IMPACTED_TABULAR_CELL_IDS_SQL,
    V8_POPULATE_IMPACTED_TABULAR_CELL_IDS_SQL,
    V8_CREATE_IMPACTED_TABULAR_REVIEW_IDS_SQL,
    V8_POPULATE_IMPACTED_TABULAR_REVIEW_IDS_SQL,
    V8_CREATE_IMPACTED_TABULAR_JOB_IDS_SQL,
    V8_POPULATE_IMPACTED_TABULAR_JOB_IDS_SQL,
    V8_TABULAR_CHAT_MESSAGE_INTERRUPT_SQL,
    V8_TABULAR_CELL_INTERRUPT_SQL,
    V8_TABULAR_REVIEW_INTERRUPT_SQL,
    V8_TABULAR_JOB_SELECTION_SQL,
    V8_CREATE_FORCED_DORMANT_PROFILES_SQL,
    V8_CREATE_CREDENTIAL_IMPACTED_PROFILES_SQL,
    V8_FORCED_DORMANT_PROFILE_INSERT_SQL,
    V8_CREDENTIAL_IMPACTED_PROFILE_INSERT_SQL,
    V8_PROFILE_POSTCONDITION_SQL,
    V8_WORKSPACE_DEFAULT_POSTCONDITION_SQL,
    V8_PROJECT_DEFAULT_POSTCONDITION_SQL,
    V8_DROP_IMPACTED_ASSISTANT_JOB_IDS_SQL,
    V8_DROP_IMPACTED_ASSISTANT_OUTPUT_IDS_SQL,
    V8_DROP_IMPACTED_WORKFLOW_RUN_IDS_SQL,
    V8_DROP_IMPACTED_WORKFLOW_JOB_IDS_SQL,
    V8_DROP_IMPACTED_TABULAR_MESSAGE_IDS_SQL,
    V8_DROP_IMPACTED_TABULAR_CELL_IDS_SQL,
    V8_DROP_IMPACTED_TABULAR_REVIEW_IDS_SQL,
    V8_DROP_IMPACTED_TABULAR_JOB_IDS_SQL,
    V8_DROP_FORCED_DORMANT_PROFILES_SQL,
    V8_DROP_CREDENTIAL_IMPACTED_PROFILES_SQL,
    JSON.stringify(V8_APPLY_POLICY),
    V8_APPLY_PLAN,
  ].join("\n-- checksum boundary --\n"),
  apply: applyModelCredentialOriginV8,
};
