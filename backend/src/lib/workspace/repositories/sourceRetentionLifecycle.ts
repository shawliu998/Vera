import { z } from "zod";

import type { WorkspaceDatabaseAdapter } from "../migrations/types";
import {
  ProjectSourceKindV11Schema,
  SourceDataUsePolicyV11Schema,
  SourceRetentionPolicyV11Schema,
} from "../sourceFoundationContractsV11";
import {
  LEGAL_SOURCE_RETENTION_ACTIVATION_V13,
  type SourceRetentionCleanupStateV13,
  type SourceRetentionLifecycleStateV13,
  type SourceRetentionLifecycleV13,
  type SourceRetentionPolicySubjectV13,
  type SourceRetentionReasonV13,
} from "../sourceRetentionPolicyV13";

type Row = Record<string, unknown>;

const LifecycleStateSchema = z.enum(["available", "tombstoned"]);
const CleanupStateSchema = z.enum([
  "not_required",
  "pending",
  "blocked_legacy_anchor",
  "complete",
  "failed",
]);
const TombstoneReasonSchema = z.enum([
  "retention_disallowed",
  "ttl_expired",
  "invalid_policy",
  "policy_revoked",
  "manual_tombstone",
]);

const SOURCE_WITH_LIFECYCLE_COLUMNS = `
  snapshot.id AS subject_id,
  snapshot.project_id AS subject_project_id,
  snapshot.source_kind AS subject_source_kind,
  snapshot.license_json AS subject_license_json,
  snapshot.retention_policy AS subject_retention_policy,
  snapshot.retention_expires_at AS subject_retention_expires_at,
  lifecycle.snapshot_id AS lifecycle_snapshot_id,
  lifecycle.project_id AS lifecycle_project_id,
  lifecycle.access_state AS lifecycle_access_state,
  lifecycle.expires_at_epoch_ms AS lifecycle_expires_at_epoch_ms,
  lifecycle.tombstone_reason AS lifecycle_tombstone_reason,
  lifecycle.tombstoned_at_epoch_ms AS lifecycle_tombstoned_at_epoch_ms,
  lifecycle.cleanup_state AS lifecycle_cleanup_state,
  lifecycle.updated_at_epoch_ms AS lifecycle_updated_at_epoch_ms
`;

export type SourceRetentionUseRecordV13 = {
  subject: SourceRetentionPolicySubjectV13;
  lifecycle: SourceRetentionLifecycleV13 | null;
};

export type SourceRetentionAnchorUseRecordV13 = SourceRetentionUseRecordV13 & {
  anchor: {
    id: string;
    projectId: string;
    snapshotId: string;
    ordinal: number;
    exactQuote: string;
    quoteSha256: string;
    locator: Record<string, unknown>;
    createdAt: string;
  };
};

export type SourceRetentionReadinessV13 = {
  highWaterEpochMs: number;
  missingLifecycleCount: number;
  dueButAvailableCount: number;
  tombstonedCount: number;
  blockedLegacyAnchorCount: number;
  legacyLegalAnchorCount: number;
  providerActivation: typeof LEGAL_SOURCE_RETENTION_ACTIVATION_V13;
};

export class WorkspaceSourceRetentionRepositoryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkspaceSourceRetentionRepositoryError";
  }
}

function repositoryError(message: string, cause?: unknown): never {
  throw new WorkspaceSourceRetentionRepositoryError(
    message,
    cause instanceof Error ? { cause } : undefined,
  );
}

function parseId(value: string, label: string) {
  const parsed = z.string().uuid().safeParse(value);
  if (!parsed.success) repositoryError(`${label} is invalid.`);
  return parsed.data;
}

function parseEpoch(value: unknown, label: string) {
  const parsed = z.number().int().safe().nonnegative().safeParse(Number(value));
  if (!parsed.success) repositoryError(`Persisted ${label} is invalid.`);
  return parsed.data;
}

function nullableEpoch(value: unknown, label: string) {
  return value === null || value === undefined
    ? null
    : parseEpoch(value, label);
}

function parseJsonObject(value: unknown, label: string) {
  if (typeof value !== "string") {
    repositoryError(`Persisted ${label} must be JSON text.`);
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      repositoryError(`Persisted ${label} must be a JSON object.`);
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof WorkspaceSourceRetentionRepositoryError) throw error;
    repositoryError(`Persisted ${label} is invalid JSON.`, error);
  }
}

function parseLifecycle(row: Row): SourceRetentionLifecycleV13 | null {
  if (
    row.lifecycle_snapshot_id === null ||
    row.lifecycle_snapshot_id === undefined
  ) {
    return null;
  }
  try {
    return {
      projectId: z.string().uuid().parse(row.lifecycle_project_id),
      snapshotId: z.string().uuid().parse(row.lifecycle_snapshot_id),
      accessState: LifecycleStateSchema.parse(
        row.lifecycle_access_state,
      ) as SourceRetentionLifecycleStateV13,
      expiresAtEpochMs: nullableEpoch(
        row.lifecycle_expires_at_epoch_ms,
        "source retention expiry",
      ),
      tombstoneReason:
        row.lifecycle_tombstone_reason === null
          ? null
          : (TombstoneReasonSchema.parse(
              row.lifecycle_tombstone_reason,
            ) as SourceRetentionReasonV13),
      tombstonedAtEpochMs: nullableEpoch(
        row.lifecycle_tombstoned_at_epoch_ms,
        "source retention tombstone time",
      ),
      cleanupState: CleanupStateSchema.parse(
        row.lifecycle_cleanup_state,
      ) as SourceRetentionCleanupStateV13,
      updatedAtEpochMs: parseEpoch(
        row.lifecycle_updated_at_epoch_ms,
        "source retention update time",
      ),
    };
  } catch (error) {
    if (error instanceof WorkspaceSourceRetentionRepositoryError) throw error;
    repositoryError("Persisted source retention lifecycle is invalid.", error);
  }
}

function parseUseRecord(row: Row): SourceRetentionUseRecordV13 {
  try {
    return {
      subject: {
        id: z.string().uuid().parse(row.subject_id),
        projectId: z.string().uuid().parse(row.subject_project_id),
        sourceKind: ProjectSourceKindV11Schema.parse(row.subject_source_kind),
        license: SourceDataUsePolicyV11Schema.parse(
          parseJsonObject(row.subject_license_json, "source license policy"),
        ),
        retentionPolicy: SourceRetentionPolicyV11Schema.parse(
          row.subject_retention_policy,
        ),
        retentionExpiresAt:
          row.subject_retention_expires_at === null
            ? null
            : z.string().min(1).parse(row.subject_retention_expires_at),
      },
      lifecycle: parseLifecycle(row),
    };
  } catch (error) {
    if (error instanceof WorkspaceSourceRetentionRepositoryError) throw error;
    repositoryError("Persisted source retention policy is invalid.", error);
  }
}

function changes(result: unknown) {
  if (
    result !== null &&
    typeof result === "object" &&
    "changes" in result &&
    Number.isSafeInteger(Number((result as { changes: unknown }).changes))
  ) {
    return Number((result as { changes: unknown }).changes);
  }
  return 0;
}

export class WorkspaceSourceRetentionLifecycleRepository {
  constructor(private readonly database: WorkspaceDatabaseAdapter) {}

  getSourceUseRecord(
    projectId: string,
    snapshotId: string,
  ): SourceRetentionUseRecordV13 | null {
    parseId(projectId, "projectId");
    parseId(snapshotId, "snapshotId");
    const row = this.database
      .prepare(
        `SELECT ${SOURCE_WITH_LIFECYCLE_COLUMNS}
           FROM project_source_snapshots snapshot
           LEFT JOIN project_source_snapshot_lifecycle lifecycle
             ON lifecycle.project_id = snapshot.project_id
            AND lifecycle.snapshot_id = snapshot.id
          WHERE snapshot.project_id = ? AND snapshot.id = ?`,
      )
      .get(projectId, snapshotId);
    return row ? parseUseRecord(row) : null;
  }

  getAnchorUseRecord(
    projectId: string,
    anchorId: string,
  ): SourceRetentionAnchorUseRecordV13 | null {
    parseId(projectId, "projectId");
    parseId(anchorId, "anchorId");
    const row = this.database
      .prepare(
        `SELECT
           ${SOURCE_WITH_LIFECYCLE_COLUMNS},
           anchor.id AS anchor_id,
           anchor.project_id AS anchor_project_id,
           anchor.snapshot_id AS anchor_snapshot_id,
           anchor.ordinal AS anchor_ordinal,
           anchor.exact_quote AS anchor_exact_quote,
           anchor.quote_sha256 AS anchor_quote_sha256,
           anchor.locator_json AS anchor_locator_json,
           anchor.created_at AS anchor_created_at
         FROM source_citation_anchors anchor
         JOIN project_source_snapshots snapshot
           ON snapshot.project_id = anchor.project_id
          AND snapshot.id = anchor.snapshot_id
         LEFT JOIN project_source_snapshot_lifecycle lifecycle
           ON lifecycle.project_id = snapshot.project_id
          AND lifecycle.snapshot_id = snapshot.id
        WHERE anchor.project_id = ? AND anchor.id = ?`,
      )
      .get(projectId, anchorId);
    if (!row) return null;
    const record = parseUseRecord(row);
    try {
      return {
        ...record,
        anchor: {
          id: z.string().uuid().parse(row.anchor_id),
          projectId: z.string().uuid().parse(row.anchor_project_id),
          snapshotId: z.string().uuid().parse(row.anchor_snapshot_id),
          ordinal: z
            .number()
            .int()
            .nonnegative()
            .parse(Number(row.anchor_ordinal)),
          exactQuote: z
            .string()
            .min(1)
            .max(8_000)
            .parse(row.anchor_exact_quote),
          quoteSha256: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .parse(row.anchor_quote_sha256),
          locator: parseJsonObject(row.anchor_locator_json, "citation locator"),
          createdAt: z.string().min(1).parse(row.anchor_created_at),
        },
      };
    } catch (error) {
      if (error instanceof WorkspaceSourceRetentionRepositoryError) throw error;
      repositoryError("Persisted source citation anchor is invalid.", error);
    }
  }

  listStudioVersionSourceUseRecords(input: {
    projectId: string;
    documentId: string;
    versionId: string;
  }): SourceRetentionUseRecordV13[] {
    parseId(input.projectId, "projectId");
    parseId(input.documentId, "documentId");
    parseId(input.versionId, "versionId");
    const rows = this.database
      .prepare(
        `SELECT DISTINCT ${SOURCE_WITH_LIFECYCLE_COLUMNS}
           FROM document_version_citation_anchors binding
           JOIN source_citation_anchors anchor
             ON anchor.id = binding.anchor_id
            AND anchor.project_id = binding.project_id
           JOIN project_source_snapshots snapshot
             ON snapshot.project_id = anchor.project_id
            AND snapshot.id = anchor.snapshot_id
           LEFT JOIN project_source_snapshot_lifecycle lifecycle
             ON lifecycle.project_id = snapshot.project_id
            AND lifecycle.snapshot_id = snapshot.id
          WHERE binding.project_id = ?
            AND binding.document_id = ?
            AND binding.version_id = ?
          ORDER BY snapshot.id`,
      )
      .all(input.projectId, input.documentId, input.versionId);
    return rows.map(parseUseRecord);
  }

  advanceClock(nowEpochMs: number) {
    const now = parseEpoch(nowEpochMs, "source retention clock input");
    this.database
      .prepare(
        `UPDATE source_retention_clock
            SET high_water_epoch_ms = max(high_water_epoch_ms, ?),
                updated_at_epoch_ms = max(updated_at_epoch_ms, ?)
          WHERE singleton = 1`,
      )
      .run(now, now);
    const row = this.database
      .prepare(
        `SELECT high_water_epoch_ms
           FROM source_retention_clock WHERE singleton = 1`,
      )
      .get();
    if (!row) repositoryError("Source retention clock is missing.");
    return parseEpoch(
      row.high_water_epoch_ms,
      "source retention high-water time",
    );
  }

  tombstoneDueLegalSources(nowEpochMs: number) {
    const effectiveNowEpochMs = this.advanceClock(nowEpochMs);
    const result = this.database
      .prepare(
        `UPDATE project_source_snapshot_lifecycle AS lifecycle
            SET access_state = 'tombstoned',
                tombstone_reason = CASE
                  WHEN snapshot.retention_policy IN (
                    'not_declared', 'no_retention', 'metadata_only'
                  ) THEN 'retention_disallowed'
                  WHEN snapshot.retention_policy = 'full_text_ttl' AND
                       lifecycle.expires_at_epoch_ms IS NOT NULL AND
                       lifecycle.expires_at_epoch_ms <= ?
                    THEN 'ttl_expired'
                  ELSE 'invalid_policy'
                END,
                tombstoned_at_epoch_ms = ?,
                cleanup_state = CASE WHEN EXISTS (
                  SELECT 1 FROM source_citation_anchors anchor
                   WHERE anchor.project_id = lifecycle.project_id
                     AND anchor.snapshot_id = lifecycle.snapshot_id
                ) THEN 'blocked_legacy_anchor' ELSE 'complete' END,
                updated_at_epoch_ms = ?
           FROM project_source_snapshots AS snapshot
          WHERE lifecycle.project_id = snapshot.project_id
            AND lifecycle.snapshot_id = snapshot.id
            AND lifecycle.access_state = 'available'
            AND snapshot.source_kind = 'legal_authority'
            AND (
              snapshot.retention_policy NOT IN (
                'full_text_ttl', 'full_text_permitted'
              ) OR
              json_extract(snapshot.license_json, '$.basis') NOT IN (
                'deployment_contract', 'user_provided'
              ) OR
              json_extract(snapshot.license_json, '$.retention') IS NOT
                snapshot.retention_policy OR
              (
                snapshot.retention_policy = 'full_text_permitted' AND
                lifecycle.expires_at_epoch_ms IS NOT NULL
              ) OR
              (
                snapshot.retention_policy = 'full_text_ttl' AND (
                  lifecycle.expires_at_epoch_ms IS NULL OR
                  lifecycle.expires_at_epoch_ms <= ?
                )
              )
            )`,
      )
      .run(
        effectiveNowEpochMs,
        effectiveNowEpochMs,
        effectiveNowEpochMs,
        effectiveNowEpochMs,
      );
    return {
      effectiveNowEpochMs,
      tombstoned: changes(result),
      readiness: this.readiness(effectiveNowEpochMs),
    };
  }

  tombstoneLegalSnapshot(input: {
    projectId: string;
    snapshotId: string;
    reason: "policy_revoked" | "manual_tombstone";
    nowEpochMs: number;
  }) {
    parseId(input.projectId, "projectId");
    parseId(input.snapshotId, "snapshotId");
    const effectiveNowEpochMs = this.advanceClock(input.nowEpochMs);
    const result = this.database
      .prepare(
        `UPDATE project_source_snapshot_lifecycle AS lifecycle
            SET access_state = 'tombstoned',
                tombstone_reason = ?,
                tombstoned_at_epoch_ms = ?,
                cleanup_state = CASE WHEN EXISTS (
                  SELECT 1 FROM source_citation_anchors anchor
                   WHERE anchor.project_id = lifecycle.project_id
                     AND anchor.snapshot_id = lifecycle.snapshot_id
                ) THEN 'blocked_legacy_anchor' ELSE 'complete' END,
                updated_at_epoch_ms = ?
           WHERE lifecycle.project_id = ?
             AND lifecycle.snapshot_id = ?
             AND lifecycle.access_state = 'available'
             AND EXISTS (
               SELECT 1 FROM project_source_snapshots snapshot
                WHERE snapshot.project_id = lifecycle.project_id
                  AND snapshot.id = lifecycle.snapshot_id
                  AND snapshot.source_kind = 'legal_authority'
             )`,
      )
      .run(
        input.reason,
        effectiveNowEpochMs,
        effectiveNowEpochMs,
        input.projectId,
        input.snapshotId,
      );
    return {
      effectiveNowEpochMs,
      tombstoned: changes(result) === 1,
      record: this.getSourceUseRecord(input.projectId, input.snapshotId),
    };
  }

  readiness(nowEpochMs?: number): SourceRetentionReadinessV13 {
    const clock = this.database
      .prepare(
        "SELECT high_water_epoch_ms FROM source_retention_clock WHERE singleton = 1",
      )
      .get();
    if (!clock) repositoryError("Source retention clock is missing.");
    const highWaterEpochMs = parseEpoch(
      clock.high_water_epoch_ms,
      "source retention high-water time",
    );
    const effectiveNowEpochMs =
      nowEpochMs === undefined
        ? highWaterEpochMs
        : Math.max(
            highWaterEpochMs,
            parseEpoch(nowEpochMs, "source retention readiness time"),
          );
    const row = this.database
      .prepare(
        `SELECT
           (SELECT count(*)
              FROM project_source_snapshots snapshot
              LEFT JOIN project_source_snapshot_lifecycle lifecycle
                ON lifecycle.project_id = snapshot.project_id
               AND lifecycle.snapshot_id = snapshot.id
             WHERE lifecycle.snapshot_id IS NULL) AS missing_lifecycle_count,
           (SELECT count(*)
              FROM project_source_snapshots snapshot
              JOIN project_source_snapshot_lifecycle lifecycle
                ON lifecycle.project_id = snapshot.project_id
               AND lifecycle.snapshot_id = snapshot.id
             WHERE snapshot.source_kind = 'legal_authority'
               AND lifecycle.access_state = 'available'
               AND snapshot.retention_policy = 'full_text_ttl'
               AND (
                 lifecycle.expires_at_epoch_ms IS NULL OR
                 lifecycle.expires_at_epoch_ms <= ?
               )) AS due_but_available_count,
           (SELECT count(*) FROM project_source_snapshot_lifecycle
             WHERE access_state = 'tombstoned') AS tombstoned_count,
           (SELECT count(*) FROM project_source_snapshot_lifecycle
             WHERE cleanup_state = 'blocked_legacy_anchor')
             AS blocked_legacy_anchor_count,
           (SELECT count(*)
              FROM source_citation_anchors anchor
              JOIN project_source_snapshots snapshot
                ON snapshot.project_id = anchor.project_id
               AND snapshot.id = anchor.snapshot_id
             WHERE snapshot.source_kind = 'legal_authority')
             AS legacy_legal_anchor_count`,
      )
      .get(effectiveNowEpochMs);
    if (!row) repositoryError("Source retention readiness could not be read.");
    return {
      highWaterEpochMs,
      missingLifecycleCount: Number(row.missing_lifecycle_count),
      dueButAvailableCount: Number(row.due_but_available_count),
      tombstonedCount: Number(row.tombstoned_count),
      blockedLegacyAnchorCount: Number(row.blocked_legacy_anchor_count),
      legacyLegalAnchorCount: Number(row.legacy_legal_anchor_count),
      providerActivation: LEGAL_SOURCE_RETENTION_ACTIVATION_V13,
    };
  }
}
