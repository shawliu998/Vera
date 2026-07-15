import type {
  WorkspaceDatabaseAdapter,
  WorkspaceDatabaseCapabilities,
  WorkspaceMigration,
} from "./types";

const NOW_EPOCH_MS =
  "CAST(ROUND((julianday('now') - 2440587.5) * 86400000.0) AS INTEGER)";
const EFFECTIVE_NOW_EPOCH_MS = `(SELECT max(
  high_water_epoch_ms,
  ${NOW_EPOCH_MS}
) FROM source_retention_clock WHERE singleton = 1)`;
const EXPIRY_EPOCH_MS = (column: string) =>
  `CAST(ROUND((julianday(${column}) - 2440587.5) * 86400000.0) AS INTEGER)`;

/*
 * v13 adds a one-way access lifecycle around immutable v11 provenance. It
 * deliberately does not pretend that v11 `exact_quote` has become physically
 * deletable: expired legal snapshots with an existing anchor are marked
 * `blocked_legacy_anchor`, and the production provider activation gate remains
 * closed until a later migration moves quote payload behind deletable storage.
 */
const SOURCE_RETENTION_V13_SCHEMA_SQL = `
CREATE TABLE project_source_snapshot_lifecycle (
  project_id TEXT NOT NULL,
  snapshot_id TEXT PRIMARY KEY,
  access_state TEXT NOT NULL
    CHECK (access_state IN ('available', 'tombstoned')),
  expires_at_epoch_ms INTEGER CHECK (
    expires_at_epoch_ms IS NULL OR expires_at_epoch_ms >= 0
  ),
  tombstone_reason TEXT CHECK (
    tombstone_reason IS NULL OR tombstone_reason IN (
      'retention_disallowed',
      'ttl_expired',
      'invalid_policy',
      'policy_revoked',
      'manual_tombstone'
    )
  ),
  tombstoned_at_epoch_ms INTEGER CHECK (
    tombstoned_at_epoch_ms IS NULL OR tombstoned_at_epoch_ms >= 0
  ),
  cleanup_state TEXT NOT NULL CHECK (
    cleanup_state IN (
      'not_required',
      'pending',
      'blocked_legacy_anchor',
      'complete',
      'failed'
    )
  ),
  updated_at_epoch_ms INTEGER NOT NULL CHECK (updated_at_epoch_ms >= 0),
  FOREIGN KEY (project_id, snapshot_id)
    REFERENCES project_source_snapshots(project_id, id) ON DELETE CASCADE,
  CHECK (
    (access_state = 'available' AND tombstone_reason IS NULL AND
      tombstoned_at_epoch_ms IS NULL AND cleanup_state = 'not_required') OR
    (access_state = 'tombstoned' AND tombstone_reason IS NOT NULL AND
      tombstoned_at_epoch_ms IS NOT NULL AND cleanup_state <> 'not_required')
  )
);

CREATE INDEX idx_project_source_lifecycle_due
  ON project_source_snapshot_lifecycle(
    access_state,
    expires_at_epoch_ms,
    project_id,
    snapshot_id
  )
  WHERE expires_at_epoch_ms IS NOT NULL;

CREATE INDEX idx_project_source_lifecycle_cleanup
  ON project_source_snapshot_lifecycle(
    cleanup_state,
    project_id,
    snapshot_id
  )
  WHERE cleanup_state <> 'not_required';

CREATE TABLE source_retention_clock (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  high_water_epoch_ms INTEGER NOT NULL CHECK (high_water_epoch_ms >= 0),
  updated_at_epoch_ms INTEGER NOT NULL CHECK (updated_at_epoch_ms >= 0)
);

INSERT INTO source_retention_clock (
  singleton, high_water_epoch_ms, updated_at_epoch_ms
) VALUES (1, ${NOW_EPOCH_MS}, ${NOW_EPOCH_MS});
`;

const AVAILABLE_POLICY_SQL = (snapshot: string) => `(
  (
    ${snapshot}.source_kind = 'project_document' AND
    ${snapshot}.retention_policy = 'full_text_permitted' AND
    ${snapshot}.retention_expires_at IS NULL AND
    json_extract(${snapshot}.license_json, '$.basis') = 'user_provided' AND
    json_extract(${snapshot}.license_json, '$.retention') =
      ${snapshot}.retention_policy
  ) OR (
    ${snapshot}.source_kind = 'legal_authority' AND
    json_extract(${snapshot}.license_json, '$.basis') IN (
      'deployment_contract', 'user_provided'
    ) AND
    json_extract(${snapshot}.license_json, '$.retention') =
      ${snapshot}.retention_policy AND (
      (
        ${snapshot}.retention_policy = 'full_text_permitted' AND
        ${snapshot}.retention_expires_at IS NULL
      ) OR (
        ${snapshot}.retention_policy = 'full_text_ttl' AND
        ${snapshot}.retention_expires_at IS NOT NULL AND
        julianday(${snapshot}.retention_expires_at) IS NOT NULL AND
        ${EXPIRY_EPOCH_MS(`${snapshot}.retention_expires_at`)} >
          ${EFFECTIVE_NOW_EPOCH_MS}
      )
    )
  )
)`;

const TOMBSTONE_REASON_SQL = (snapshot: string) => `CASE
  WHEN ${snapshot}.retention_policy IN (
    'not_declared', 'no_retention', 'metadata_only'
  ) THEN 'retention_disallowed'
  WHEN ${snapshot}.retention_policy = 'full_text_ttl' AND
       julianday(${snapshot}.retention_expires_at) IS NOT NULL AND
       ${EXPIRY_EPOCH_MS(`${snapshot}.retention_expires_at`)} <=
         ${EFFECTIVE_NOW_EPOCH_MS}
    THEN 'ttl_expired'
  ELSE 'invalid_policy'
END`;

const CLEANUP_STATE_SQL = (snapshot: string) => `CASE
  WHEN ${snapshot}.source_kind = 'legal_authority' AND EXISTS (
    SELECT 1 FROM source_citation_anchors anchor
     WHERE anchor.project_id = ${snapshot}.project_id
       AND anchor.snapshot_id = ${snapshot}.id
  ) THEN 'blocked_legacy_anchor'
  ELSE 'complete'
END`;

const SOURCE_RETENTION_V13_BACKFILL_SQL = `
INSERT INTO project_source_snapshot_lifecycle (
  project_id,
  snapshot_id,
  access_state,
  expires_at_epoch_ms,
  tombstone_reason,
  tombstoned_at_epoch_ms,
  cleanup_state,
  updated_at_epoch_ms
)
SELECT
  snapshot.project_id,
  snapshot.id,
  CASE WHEN ${AVAILABLE_POLICY_SQL("snapshot")}
    THEN 'available' ELSE 'tombstoned' END,
  CASE
    WHEN snapshot.retention_policy = 'full_text_ttl' AND
         julianday(snapshot.retention_expires_at) IS NOT NULL
      THEN ${EXPIRY_EPOCH_MS("snapshot.retention_expires_at")}
    ELSE NULL
  END,
  CASE WHEN ${AVAILABLE_POLICY_SQL("snapshot")}
    THEN NULL ELSE ${TOMBSTONE_REASON_SQL("snapshot")} END,
  CASE WHEN ${AVAILABLE_POLICY_SQL("snapshot")}
    THEN NULL ELSE ${EFFECTIVE_NOW_EPOCH_MS} END,
  CASE WHEN ${AVAILABLE_POLICY_SQL("snapshot")}
    THEN 'not_required' ELSE ${CLEANUP_STATE_SQL("snapshot")} END,
  ${EFFECTIVE_NOW_EPOCH_MS}
FROM project_source_snapshots snapshot;
`;

const SOURCE_RETENTION_V13_TRIGGER_SQL = `
CREATE TRIGGER source_retention_clock_monotonic
BEFORE UPDATE ON source_retention_clock BEGIN
  SELECT CASE WHEN
    new.singleton IS NOT old.singleton OR
    new.high_water_epoch_ms < old.high_water_epoch_ms OR
    new.updated_at_epoch_ms < old.updated_at_epoch_ms
  THEN RAISE(ABORT, 'source retention clock cannot move backwards') END;
END;

CREATE TRIGGER project_source_lifecycle_one_way
BEFORE UPDATE ON project_source_snapshot_lifecycle BEGIN
  SELECT CASE WHEN
    new.project_id IS NOT old.project_id OR
    new.snapshot_id IS NOT old.snapshot_id OR
    new.expires_at_epoch_ms IS NOT old.expires_at_epoch_ms
  THEN RAISE(ABORT, 'source retention lifecycle authority is immutable') END;

  SELECT CASE WHEN
    old.access_state = 'tombstoned' AND (
      new.access_state <> 'tombstoned' OR
      new.tombstone_reason IS NOT old.tombstone_reason OR
      new.tombstoned_at_epoch_ms IS NOT old.tombstoned_at_epoch_ms
    )
  THEN RAISE(ABORT, 'source retention tombstone is one-way') END;

  SELECT CASE WHEN new.updated_at_epoch_ms < old.updated_at_epoch_ms
    THEN RAISE(ABORT, 'source retention lifecycle time cannot move backwards')
  END;

  SELECT CASE WHEN
    old.cleanup_state = 'complete' AND new.cleanup_state <> 'complete'
  THEN RAISE(ABORT, 'source retention cleanup completion is one-way') END;
END;

CREATE TRIGGER project_source_snapshot_lifecycle_after_insert
AFTER INSERT ON project_source_snapshots BEGIN
  INSERT INTO project_source_snapshot_lifecycle (
    project_id,
    snapshot_id,
    access_state,
    expires_at_epoch_ms,
    tombstone_reason,
    tombstoned_at_epoch_ms,
    cleanup_state,
    updated_at_epoch_ms
  ) VALUES (
    new.project_id,
    new.id,
    CASE WHEN ${AVAILABLE_POLICY_SQL("new")}
      THEN 'available' ELSE 'tombstoned' END,
    CASE
      WHEN new.retention_policy = 'full_text_ttl' AND
           julianday(new.retention_expires_at) IS NOT NULL
        THEN ${EXPIRY_EPOCH_MS("new.retention_expires_at")}
      ELSE NULL
    END,
    CASE WHEN ${AVAILABLE_POLICY_SQL("new")}
      THEN NULL ELSE ${TOMBSTONE_REASON_SQL("new")} END,
    CASE WHEN ${AVAILABLE_POLICY_SQL("new")}
      THEN NULL ELSE ${EFFECTIVE_NOW_EPOCH_MS} END,
    CASE WHEN ${AVAILABLE_POLICY_SQL("new")}
      THEN 'not_required' ELSE 'complete' END,
    ${EFFECTIVE_NOW_EPOCH_MS}
  );
END;

CREATE TRIGGER source_retention_v13_anchor_insert_guard
BEFORE INSERT ON source_citation_anchors
WHEN EXISTS (
  SELECT 1 FROM project_source_snapshots snapshot
   WHERE snapshot.project_id = new.project_id
     AND snapshot.id = new.snapshot_id
     AND snapshot.source_kind = 'legal_authority'
) BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
      FROM project_source_snapshots snapshot
      JOIN project_source_snapshot_lifecycle lifecycle
        ON lifecycle.project_id = snapshot.project_id
       AND lifecycle.snapshot_id = snapshot.id
      JOIN source_retention_clock clock ON clock.singleton = 1
     WHERE snapshot.project_id = new.project_id
       AND snapshot.id = new.snapshot_id
       AND lifecycle.access_state = 'available'
       AND snapshot.retention_policy IN ('full_text_ttl', 'full_text_permitted')
       AND json_extract(snapshot.license_json, '$.basis') IN (
         'deployment_contract', 'user_provided'
       )
       AND json_extract(snapshot.license_json, '$.retention') =
         snapshot.retention_policy
       AND (
         snapshot.retention_policy = 'full_text_permitted' OR (
           lifecycle.expires_at_epoch_ms IS NOT NULL AND
           lifecycle.expires_at_epoch_ms > max(
             clock.high_water_epoch_ms,
             ${NOW_EPOCH_MS}
           )
         )
       )
  ) THEN RAISE(
    ABORT,
    'legal source citation anchor is unavailable under retention policy'
  ) END;
END;

CREATE TRIGGER source_retention_v13_studio_binding_guard
BEFORE INSERT ON document_version_citation_anchors
WHEN EXISTS (
  SELECT 1
    FROM source_citation_anchors anchor
    JOIN project_source_snapshots snapshot
      ON snapshot.project_id = anchor.project_id
     AND snapshot.id = anchor.snapshot_id
   WHERE anchor.id = new.anchor_id
     AND snapshot.source_kind = 'legal_authority'
) BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
      FROM source_citation_anchors anchor
      JOIN project_source_snapshots snapshot
        ON snapshot.project_id = anchor.project_id
       AND snapshot.id = anchor.snapshot_id
      JOIN project_source_snapshot_lifecycle lifecycle
        ON lifecycle.project_id = snapshot.project_id
       AND lifecycle.snapshot_id = snapshot.id
      JOIN source_retention_clock clock ON clock.singleton = 1
     WHERE anchor.id = new.anchor_id
       AND anchor.project_id = new.project_id
       AND lifecycle.access_state = 'available'
       AND snapshot.retention_policy IN ('full_text_ttl', 'full_text_permitted')
       AND json_extract(snapshot.license_json, '$.basis') IN (
         'deployment_contract', 'user_provided'
       )
       AND json_extract(snapshot.license_json, '$.retention') =
         snapshot.retention_policy
       AND (
         snapshot.retention_policy = 'full_text_permitted' OR (
           lifecycle.expires_at_epoch_ms IS NOT NULL AND
           lifecycle.expires_at_epoch_ms > max(
             clock.high_water_epoch_ms,
             ${NOW_EPOCH_MS}
           )
         )
       )
  ) THEN RAISE(
    ABORT,
    'legal source citation cannot be bound under retention policy'
  ) END;
END;
`;

function applySourceRetentionLifecycleV13(
  database: WorkspaceDatabaseAdapter,
  capabilities: WorkspaceDatabaseCapabilities,
) {
  if (!capabilities.jsonTextChecks) {
    throw new Error(
      "Workspace schema v13 requires SQLite JSON1 for source policy enforcement.",
    );
  }
  database.exec(SOURCE_RETENTION_V13_SCHEMA_SQL);
  database.exec(SOURCE_RETENTION_V13_BACKFILL_SQL);
  database.exec(SOURCE_RETENTION_V13_TRIGGER_SQL);
}

export const SOURCE_RETENTION_LIFECYCLE_V13_MIGRATION: WorkspaceMigration = {
  version: 13,
  name: "project_source_retention_lifecycle",
  checksumMaterial: [
    "workspace-migration-v13",
    "one-way-source-access-tombstones",
    "monotonic-clock-and-realtime-anchor-studio-guards",
    "legacy-exact-quotes-remain-an-explicit-activation-blocker",
    SOURCE_RETENTION_V13_SCHEMA_SQL,
    SOURCE_RETENTION_V13_BACKFILL_SQL,
    SOURCE_RETENTION_V13_TRIGGER_SQL,
  ].join("\n-- checksum boundary --\n"),
  apply: applySourceRetentionLifecycleV13,
};
