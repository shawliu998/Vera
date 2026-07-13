import { createHash, createHmac } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { LocalDatabase } from "../lib/aletheia/localDatabase";
import { readProtectedLocalFileSync } from "../lib/aletheia/localEnvelopeCrypto";
import {
  closeLocalAletheiaRepositoryForAudit,
  LocalAletheiaRepository,
} from "../lib/aletheia/localRepository";

type IntegrityCheck = {
  id: string;
  ok: boolean;
  severity: "critical" | "warning";
  detail: string;
};

type WorkProductRow = {
  id: string;
  matter_id: string;
  kind: string;
  title: string;
  created_at: string;
};

type AuditEventRow = {
  id: string;
  matter_id: string;
  action: string;
  details: string;
  created_at: string;
  sequence: number | null;
  event_hash: string | null;
};

type ChainedAuditEventRow = AuditEventRow & {
  user_id: string | null;
  actor: string;
  workflow_version: string | null;
  model: string | null;
  sequence: number;
  previous_hash: string | null;
  event_hash: string;
};

type CheckpointRow = {
  id: string;
  matter_id: string;
  checkpoint_type: string;
  status: string;
  decision: string | null;
  decided_at: string | null;
};

type ExportRow = {
  id: string;
  matter_id: string;
  user_id: string;
  export_type: string;
  schema_version: string;
  export_hash: string;
  export_path: string;
  approval_checkpoint_id: string | null;
  gate_authorization_status: string;
  source_index_manifest: string;
  audit_event_id: string | null;
  metadata: string;
  created_at: string;
};

type ExportFileRecord = {
  workProductId: string;
  matterId: string;
  kind: string;
  path: string;
  bytes: number;
  sha256: string;
};

const HIGH_RISK_EXPORTS: Record<string, string> = {
  audit_pack: "audit_pack_export",
  feedback_export: "feedback_dataset_export",
  final_memo: "final_memo_export",
};

const EXPORT_ACTIONS: Record<string, string> = {
  audit_pack: "audit_pack_exported",
  feedback_export: "feedback_dataset_exported",
  final_memo: "final_memo_exported",
  registry_snapshot: "registry_snapshot_saved",
  external_source_workpaper: "external_source_workpaper_saved",
  shareholder_penetration_graph: "shareholder_penetration_graph_saved",
  legal_qa_answer: "legal_qa_answer_saved",
  word_addin_handoff: "word_addin_handoff_saved",
};
const REQUIRED_TABLES = [
  "aletheia_matters",
  "aletheia_work_products",
  "aletheia_audit_events",
  "aletheia_human_checkpoints",
  "aletheia_deletion_tombstones",
  "aletheia_exports",
  "aletheia_litigation_audit_export_signoffs",
];

function env(name: string) {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function dataDir() {
  const configured =
    env("ALETHEIA_AUDIT_SOURCE_DIR") ??
    env("ALETHEIA_DATA_DIR") ??
    env("ALET_HEIA_DATA_DIR") ??
    ".data/aletheia";
  return path.resolve(process.cwd(), configured);
}

function check(
  id: string,
  ok: boolean,
  detail: string,
  severity: "critical" | "warning" = "critical",
): IntegrityCheck {
  return { id, ok, severity, detail };
}

function isSubpath(parent: string, child: string) {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function parseObject(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function recordFromUnknown(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function count(db: LocalDatabase, sql: string) {
  const row = db.prepare(sql).get() as { count?: number } | undefined;
  return Number(row?.count ?? 0);
}

function fileDigest(target: string) {
  const bytes = readFileSync(target);
  return {
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

function canonicalHash(value: unknown) {
  return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function auditKey(root: string) {
  const configured = env("ALETHEIA_AUDIT_HMAC_SECRET");
  if (configured) return Buffer.from(configured, "utf8");
  const keyPath = path.join(root, ".audit-hmac-key");
  return existsSync(keyPath) ? readFileSync(keyPath) : null;
}

function expectedAuditHash(row: ChainedAuditEventRow, key: Buffer) {
  const payload = {
    id: row.id,
    matterId: row.matter_id,
    userId: row.user_id,
    actor: row.actor,
    action: row.action,
    workflowVersion: row.workflow_version ?? "aletheia-v0",
    model: row.model,
    details: parseObject(row.details),
    createdAt: row.created_at,
    sequence: row.sequence,
    previousHash: row.previous_hash,
  };
  return `hmac-sha256:${createHmac("sha256", key)
    .update(stableJson(payload))
    .digest("hex")}`;
}

function main() {
  const root = dataDir();
  const dbPath = path.join(root, "aletheia.db");
  const checks: IntegrityCheck[] = [
    check(
      "data-dir-exists",
      existsSync(root) && statSync(root).isDirectory(),
      `Aletheia local data directory must exist: ${root}`,
    ),
    check(
      "sqlite-database-present",
      existsSync(dbPath),
      "Audit integrity requires aletheia.db; run a local matter workflow before final handoff.",
      "warning",
    ),
  ];

  const summary = {
    matters: 0,
    workProducts: 0,
    auditEvents: 0,
    exportEvents: 0,
    highRiskExports: 0,
    litigationArtifactExports: 0,
    litigationMatterAuditExports: 0,
    litigationMatterAuditSignoffs: 0,
    gateSnapshots: 0,
    finalExportGateAuthorizations: 0,
    blockedFinalExportAttempts: 0,
  };
  const exportFiles: ExportFileRecord[] = [];

  if (existsSync(dbPath)) {
    // Open the production repository once so an upgraded installation receives
    // the same idempotent schema migrations as the running application before
    // this command switches to a read-only integrity pass.
    new LocalAletheiaRepository();
    closeLocalAletheiaRepositoryForAudit();
    const db = new LocalDatabase(dbPath, { readOnly: true });
    try {
      const quickCheck = db.prepare("pragma quick_check").get() as
        | { quick_check?: string }
        | undefined;
      checks.push(
        check(
          "sqlite-quick-check",
          quickCheck?.quick_check === "ok",
          `SQLite quick_check result: ${quickCheck?.quick_check ?? "not run"}`,
        ),
      );

      const tables = (
        db
          .prepare(
            "select name from sqlite_master where type in ('table', 'view')",
          )
          .all() as Array<{ name?: string }>
      )
        .map((row) => String(row.name ?? ""))
        .filter(Boolean);
      const missingTables = REQUIRED_TABLES.filter(
        (table) => !tables.includes(table),
      );
      checks.push(
        check(
          "required-tables-present",
          missingTables.length === 0,
          missingTables.length
            ? `Missing required audit tables: ${missingTables.join(", ")}`
            : "Required audit integrity tables are present.",
        ),
      );
      if (missingTables.length > 0) {
        throw new Error("skip-audit-integrity-deep-checks");
      }

      summary.matters = count(
        db,
        "select count(*) as count from aletheia_matters",
      );
      summary.workProducts = count(
        db,
        "select count(*) as count from aletheia_work_products",
      );
      summary.auditEvents = count(
        db,
        "select count(*) as count from aletheia_audit_events",
      );

      const chainedAuditRows = db
        .prepare(
          `select id, matter_id, user_id, actor, action, workflow_version,
                  model, details, created_at, sequence, previous_hash, event_hash
             from aletheia_audit_events
            where sequence is not null
            order by matter_id asc, sequence asc`,
        )
        .all() as ChainedAuditEventRow[];
      const unchainedAuditEvents = count(
        db,
        "select count(*) as count from aletheia_audit_events where sequence is null or event_hash is null",
      );
      const key = auditKey(root);
      const chainFailures: string[] = [];
      const lastByMatter = new Map<
        string,
        { sequence: number; hash: string }
      >();
      for (const row of chainedAuditRows) {
        const prior = lastByMatter.get(row.matter_id);
        const expectedSequence = (prior?.sequence ?? 0) + 1;
        const expectedPrevious = prior?.hash ?? null;
        if (row.sequence !== expectedSequence) {
          chainFailures.push(`${row.matter_id}:${row.id}:sequence`);
        }
        if (row.previous_hash !== expectedPrevious) {
          chainFailures.push(`${row.matter_id}:${row.id}:previous_hash`);
        }
        if (!key || expectedAuditHash(row, key) !== row.event_hash) {
          chainFailures.push(`${row.matter_id}:${row.id}:event_hash`);
        }
        lastByMatter.set(row.matter_id, {
          sequence: row.sequence,
          hash: row.event_hash,
        });
      }
      checks.push(
        check(
          "audit-hmac-key-present",
          chainedAuditRows.length === 0 || Boolean(key),
          key
            ? "The local audit HMAC key is available for chain verification."
            : "The local audit HMAC key is missing.",
        ),
        check(
          "audit-event-hash-chains-valid",
          chainFailures.length === 0,
          chainFailures.length
            ? `Invalid audit chain entries: ${chainFailures.join(", ")}`
            : `${chainedAuditRows.length} chained audit events verified.`,
        ),
        check(
          "no-unchained-audit-events",
          unchainedAuditEvents === 0,
          `${unchainedAuditEvents} audit events are outside the HMAC chain.`,
        ),
      );

      const tombstones = db
        .prepare(
          "select * from aletheia_deletion_tombstones order by deleted_at asc",
        )
        .all() as Array<Record<string, any>>;
      const invalidTombstones: string[] = [];
      const pendingTombstones: string[] = [];
      const stalePendingTombstones: string[] = [];
      for (const row of tombstones) {
        const details = parseObject(String(row.details ?? "{}"));
        const payload = {
          id: row.id,
          matterId: row.matter_id,
          userId: row.user_id,
          matterTitleHash: row.matter_title_hash,
          lastAuditHash: row.last_audit_hash ?? null,
          approvalCheckpointId: row.approval_checkpoint_id,
          counts: recordFromUnknown(details.counts),
          deletedAt: row.deleted_at,
          pendingPaths: Array.isArray(details.pendingPaths)
            ? details.pendingPaths
            : [],
          cleanup: recordFromUnknown(details.cleanup),
        };
        const expected = key
          ? `hmac-sha256:${createHmac("sha256", key)
              .update(stableJson(payload))
              .digest("hex")}`
          : null;
        if (!expected || expected !== row.tombstone_hash) {
          invalidTombstones.push(String(row.id));
        }
        const cleanup = recordFromUnknown(details.cleanup);
        if (cleanup.status !== "completed") {
          pendingTombstones.push(String(row.id));
          const ageMs = Date.now() - Date.parse(String(row.deleted_at));
          if (!Number.isFinite(ageMs) || ageMs > 24 * 60 * 60 * 1000) {
            stalePendingTombstones.push(String(row.id));
          }
        }
      }
      checks.push(
        check(
          "deletion-tombstones-valid",
          invalidTombstones.length === 0,
          invalidTombstones.length
            ? `Invalid deletion tombstones: ${invalidTombstones.join(", ")}`
            : `${tombstones.length} deletion tombstones verified.`,
        ),
        check(
          "deletion-cleanup-complete",
          pendingTombstones.length === 0,
          pendingTombstones.length
            ? `Deletion cleanup is pending: ${pendingTombstones.join(", ")}`
            : "All deletion tombstones report completed filesystem cleanup.",
          "warning",
        ),
        check(
          "no-stale-deletion-cleanup",
          stalePendingTombstones.length === 0,
          stalePendingTombstones.length
            ? `Deletion cleanup has been pending for more than 24 hours: ${stalePendingTombstones.join(", ")}`
            : "No stale deletion cleanup tasks were found.",
        ),
      );

      const orphanAuditEvents = count(
        db,
        `
          select count(*) as count
          from aletheia_audit_events a
          left join aletheia_matters m on m.id = a.matter_id
          where m.id is null
        `,
      );
      checks.push(
        check(
          "audit-events-have-matters",
          orphanAuditEvents === 0,
          `${orphanAuditEvents} audit events do not resolve to a matter.`,
        ),
      );

      const exportProducts = db
        .prepare(
          `
            select id, matter_id, kind, title, created_at
            from aletheia_work_products
            where kind in ('audit_pack', 'feedback_export', 'final_memo', 'registry_snapshot', 'external_source_workpaper', 'shareholder_penetration_graph', 'legal_qa_answer', 'word_addin_handoff')
            order by created_at asc
          `,
        )
        .all() as WorkProductRow[];
      const litigationExports = db
        .prepare(
          `
            select id, matter_id, user_id, export_type, schema_version,
                   export_hash, export_path, approval_checkpoint_id,
                   gate_authorization_status, source_index_manifest,
                   audit_event_id, metadata, created_at
              from aletheia_exports
             where export_type = 'litigation_artifact'
             order by created_at asc
          `,
        )
        .all() as ExportRow[];
      const litigationMatterAuditExports = db
        .prepare(
          `select id, matter_id, user_id, export_type, schema_version,
                  export_hash, export_path, approval_checkpoint_id,
                  gate_authorization_status, source_index_manifest,
                  audit_event_id, metadata, created_at
             from aletheia_exports
            where export_type = 'litigation_matter_audit_package'
            order by created_at asc`,
        )
        .all() as ExportRow[];
      summary.litigationArtifactExports = litigationExports.length;
      summary.litigationMatterAuditExports =
        litigationMatterAuditExports.length;
      summary.exportEvents =
        exportProducts.length +
        litigationExports.length +
        litigationMatterAuditExports.length;
      summary.highRiskExports =
        exportProducts.filter((item) => HIGH_RISK_EXPORTS[item.kind]).length +
        litigationExports.length +
        litigationMatterAuditExports.length;

      const auditRows = db
        .prepare(
          `
            select id, matter_id, action, details, created_at, sequence, event_hash
            from aletheia_audit_events
            where action in (
              'audit_pack_exported',
              'feedback_dataset_exported',
              'final_memo_exported',
              'registry_snapshot_saved',
              'external_source_workpaper_saved',
              'shareholder_penetration_graph_saved',
              'legal_qa_answer_saved',
              'word_addin_handoff_saved',
              'litigation_artifact_exported',
              'litigation_matter_audit_package_exported',
              'litigation_matter_audit_package_signed_off'
            )
          `,
        )
        .all() as AuditEventRow[];
      const gateAuditRows = db
        .prepare(
          `
            select id, matter_id, action, details, created_at
            from aletheia_audit_events
            where action in (
              'gate_results_persisted',
              'final_export_gate_authorized',
              'final_export_gate_blocked'
            )
          `,
        )
        .all() as AuditEventRow[];
      summary.gateSnapshots = gateAuditRows.filter(
        (row) => row.action === "gate_results_persisted",
      ).length;
      summary.finalExportGateAuthorizations = gateAuditRows.filter(
        (row) => row.action === "final_export_gate_authorized",
      ).length;
      summary.blockedFinalExportAttempts = gateAuditRows.filter(
        (row) => row.action === "final_export_gate_blocked",
      ).length;
      const checkpoints = db
        .prepare(
          `
            select id, matter_id, checkpoint_type, status, decision, decided_at
            from aletheia_human_checkpoints
            where status = 'approved' and decision = 'approved'
          `,
        )
        .all() as CheckpointRow[];

      const missingAuditEvents: string[] = [];
      const missingExportPaths: string[] = [];
      const escapedExportPaths: string[] = [];
      const missingApprovalLinks: string[] = [];
      const missingGateSnapshots: string[] = [];
      const invalidGateSnapshots: string[] = [];
      const missingGateAuthorizations: string[] = [];
      const invalidLitigationExportLinks: string[] = [];
      const invalidLitigationMatterAuditLinks: string[] = [];

      for (const product of exportProducts) {
        const action = EXPORT_ACTIONS[product.kind];
        const event = auditRows.find((row) => {
          if (row.matter_id !== product.matter_id || row.action !== action) {
            return false;
          }
          const details = parseObject(row.details);
          return details.workProductId === product.id;
        });
        if (!event) {
          missingAuditEvents.push(`${product.kind}:${product.id}`);
          continue;
        }

        const details = parseObject(event.details);
        const exportPath =
          typeof details.exportPath === "string" ? details.exportPath : null;
        if (!exportPath || !existsSync(exportPath)) {
          missingExportPaths.push(`${product.kind}:${product.id}`);
        } else if (!isSubpath(root, path.resolve(exportPath))) {
          escapedExportPaths.push(`${product.kind}:${product.id}`);
        } else {
          const digest = fileDigest(exportPath);
          exportFiles.push({
            workProductId: product.id,
            matterId: product.matter_id,
            kind: product.kind,
            path: exportPath,
            bytes: digest.bytes,
            sha256: digest.sha256,
          });
        }

        const checkpointType = HIGH_RISK_EXPORTS[product.kind];
        if (checkpointType) {
          const approvalCheckpointId =
            typeof details.approvalCheckpointId === "string"
              ? details.approvalCheckpointId
              : null;
          const linked = checkpoints.some((checkpoint) => {
            if (
              checkpoint.matter_id !== product.matter_id ||
              checkpoint.checkpoint_type !== checkpointType
            ) {
              return false;
            }
            if (approvalCheckpointId)
              return checkpoint.id === approvalCheckpointId;
            return true;
          });
          if (!linked) {
            missingApprovalLinks.push(`${product.kind}:${product.id}`);
          }

          if (product.kind === "final_memo") {
            const gateSnapshotAuditEventId =
              typeof details.gateSnapshotAuditEventId === "string"
                ? details.gateSnapshotAuditEventId
                : null;
            const gateAuthorizationAuditEventId =
              typeof details.gateAuthorizationAuditEventId === "string"
                ? details.gateAuthorizationAuditEventId
                : null;
            const snapshotEvent = gateAuditRows.find(
              (row) =>
                row.id === gateSnapshotAuditEventId &&
                row.matter_id === product.matter_id &&
                row.action === "gate_results_persisted",
            );
            if (!snapshotEvent) {
              missingGateSnapshots.push(`${product.kind}:${product.id}`);
            } else {
              const snapshotDetails = parseObject(snapshotEvent.details);
              const authorization = recordFromUnknown(
                snapshotDetails.authorization,
              );
              const gateSummary = recordFromUnknown(
                snapshotDetails.gateSummary,
              );
              const gateResults = Array.isArray(snapshotDetails.gateResults)
                ? snapshotDetails.gateResults
                : [];
              const exportGatePassed = gateResults.some((gate) => {
                const row = recordFromUnknown(gate);
                return row.gate_type === "export" && row.status === "passed";
              });
              if (
                snapshotDetails.schemaVersion !== "aletheia-gate-snapshot-v0" ||
                snapshotDetails.action !== "final_memo_export" ||
                authorization.status !== "passed" ||
                Number(gateSummary.failed ?? 0) !== 0 ||
                !exportGatePassed
              ) {
                invalidGateSnapshots.push(`${product.kind}:${product.id}`);
              }
            }

            const authorizationEvent = gateAuditRows.find((row) => {
              if (
                row.id !== gateAuthorizationAuditEventId ||
                row.matter_id !== product.matter_id ||
                row.action !== "final_export_gate_authorized"
              ) {
                return false;
              }
              const authorizationDetails = parseObject(row.details);
              return (
                authorizationDetails.gateSnapshotAuditEventId ===
                  gateSnapshotAuditEventId &&
                authorizationDetails.approvalCheckpointId ===
                  approvalCheckpointId
              );
            });
            if (!authorizationEvent) {
              missingGateAuthorizations.push(`${product.kind}:${product.id}`);
            }
          }
        }
      }

      for (const exported of litigationExports) {
        const label = `litigation_artifact:${exported.id}`;
        const metadata = parseObject(exported.metadata);
        const event = auditRows.find(
          (row) =>
            row.id === exported.audit_event_id &&
            row.matter_id === exported.matter_id &&
            row.action === "litigation_artifact_exported",
        );
        if (!event) {
          missingAuditEvents.push(label);
        } else {
          const details = parseObject(event.details);
          const fieldsMatch =
            details.exportId === exported.id &&
            details.exportPath === exported.export_path &&
            details.approvalCheckpointId === exported.approval_checkpoint_id &&
            details.workProductId === metadata.workProductId &&
            Number(details.version) === Number(metadata.version) &&
            details.contentHash === metadata.contentHash &&
            details.format === metadata.format &&
            details.mimeType === metadata.mimeType &&
            details.fileSha256 === metadata.fileSha256;
          if (!fieldsMatch) invalidLitigationExportLinks.push(label);
        }

        if (!exported.export_path || !existsSync(exported.export_path)) {
          missingExportPaths.push(label);
        } else if (!isSubpath(root, path.resolve(exported.export_path))) {
          escapedExportPaths.push(label);
        } else {
          const digest = fileDigest(exported.export_path);
          const storedFileSha256 = `sha256:${digest.sha256}`;
          if (
            exported.export_hash !== storedFileSha256 ||
            metadata.fileSha256 !== storedFileSha256
          ) {
            invalidLitigationExportLinks.push(label);
          }
          exportFiles.push({
            workProductId:
              typeof metadata.workProductId === "string"
                ? metadata.workProductId
                : exported.id,
            matterId: exported.matter_id,
            kind:
              typeof metadata.kind === "string"
                ? metadata.kind
                : "litigation_artifact",
            path: exported.export_path,
            bytes: digest.bytes,
            sha256: digest.sha256,
          });
        }

        const linkedCheckpoint = checkpoints.some(
          (checkpoint) =>
            checkpoint.id === exported.approval_checkpoint_id &&
            checkpoint.matter_id === exported.matter_id &&
            checkpoint.checkpoint_type === "litigation_artifact_export",
        );
        if (
          !linkedCheckpoint ||
          exported.gate_authorization_status !== "approved"
        ) {
          missingApprovalLinks.push(label);
        }

        if (
          exported.schema_version !==
            "aletheia-litigation-artifact-export-v2" ||
          typeof metadata.workProductId !== "string" ||
          !Number.isInteger(Number(metadata.version)) ||
          typeof metadata.contentHash !== "string" ||
          !["docx", "json"].includes(String(metadata.format)) ||
          typeof metadata.mimeType !== "string" ||
          typeof metadata.fileSha256 !== "string"
        ) {
          invalidLitigationExportLinks.push(label);
        }
      }

      for (const exported of litigationMatterAuditExports) {
        const label = `litigation_matter_audit_package:${exported.id}`;
        const metadata = parseObject(exported.metadata);
        const manifest = parseObject(exported.source_index_manifest);
        const event = auditRows.find(
          (row) =>
            row.id === exported.audit_event_id &&
            row.matter_id === exported.matter_id &&
            row.action === "litigation_matter_audit_package_exported",
        );
        const details = event ? parseObject(event.details) : {};
        if (
          !event ||
          details.exportId !== exported.id ||
          details.exportHash !== exported.export_hash ||
          details.approvalCheckpointId !== exported.approval_checkpoint_id ||
          details.matterStateHash !== metadata.matterStateHash ||
          details.checklistHash !== metadata.checklistHash ||
          manifest.matter_state_hash !== metadata.matterStateHash ||
          manifest.checklist_hash !== metadata.checklistHash ||
          exported.schema_version !==
            "vera-litigation-matter-audit-package-v1"
        ) {
          invalidLitigationMatterAuditLinks.push(label);
        }
        if (!exported.export_path || !existsSync(exported.export_path)) {
          missingExportPaths.push(label);
        } else if (!isSubpath(root, path.resolve(exported.export_path))) {
          escapedExportPaths.push(label);
        } else {
          try {
            const payload = JSON.parse(
              readProtectedLocalFileSync({
                filePath: exported.export_path,
                purpose: "local_export",
              }).toString("utf8"),
            ) as Record<string, unknown>;
            const {
              export_id: storedExportId,
              export_hash: storedExportHash,
              ...packageWithoutHash
            } = payload;
            if (
              storedExportId !== exported.id ||
              storedExportHash !== exported.export_hash ||
              canonicalHash(packageWithoutHash) !== exported.export_hash
            ) {
              invalidLitigationMatterAuditLinks.push(label);
            }
          } catch {
            invalidLitigationMatterAuditLinks.push(label);
          }
        }
        const linkedCheckpoint = checkpoints.some(
          (checkpoint) =>
            checkpoint.id === exported.approval_checkpoint_id &&
            checkpoint.matter_id === exported.matter_id &&
            checkpoint.checkpoint_type ===
              "litigation_matter_audit_export",
        );
        if (
          !linkedCheckpoint ||
          exported.gate_authorization_status !== "approved"
        ) {
          missingApprovalLinks.push(label);
        }
      }

      const litigationMatterAuditSignoffs = db
        .prepare(
          `select * from aletheia_litigation_audit_export_signoffs
            order by signed_at asc`,
        )
        .all() as Array<Record<string, unknown>>;
      summary.litigationMatterAuditSignoffs =
        litigationMatterAuditSignoffs.length;
      for (const signoff of litigationMatterAuditSignoffs) {
        const label = `litigation_matter_audit_signoff:${String(signoff.id)}`;
        const exported = litigationMatterAuditExports.find(
          (item) =>
            item.id === signoff.export_id &&
            item.matter_id === signoff.matter_id &&
            item.user_id === signoff.user_id,
        );
        const event = auditRows.find((row) => {
          if (
            row.matter_id !== signoff.matter_id ||
            row.action !== "litigation_matter_audit_package_signed_off"
          ) {
            return false;
          }
          const details = parseObject(row.details);
          return (
            details.signoffId === signoff.id &&
            details.signoffHash === signoff.signoff_hash &&
            details.exportId === signoff.export_id &&
            details.exportHash === signoff.export_hash &&
            details.checklistHash === signoff.checklist_hash &&
            details.matterStateHash === signoff.matter_state_hash
          );
        });
        const signoffPayload = {
          id: signoff.id,
          matterId: signoff.matter_id,
          ownerId: signoff.user_id,
          exportId: signoff.export_id,
          exportHash: signoff.export_hash,
          checklistSchemaVersion: signoff.checklist_schema_version,
          checklistHash: signoff.checklist_hash,
          matterStateHash: signoff.matter_state_hash,
          actorId: signoff.actor_id,
          signerName: signoff.signer_name,
          professionalIdentifier: signoff.professional_identifier ?? null,
          attestationVersion: signoff.attestation_version,
          attestation: signoff.attestation,
          comment: signoff.comment,
          independentReview: Number(signoff.independent_review) === 1,
          signedAt: signoff.signed_at,
        };
        if (
          !exported ||
          !event ||
          event.id !== signoff.audit_event_id ||
          event.sequence !== signoff.audit_event_sequence ||
          event.event_hash !== signoff.audit_event_hash ||
          exported.export_hash !== signoff.export_hash ||
          parseObject(exported.metadata).checklistHash !==
            signoff.checklist_hash ||
          canonicalHash(signoffPayload) !== signoff.signoff_hash
        ) {
          invalidLitigationMatterAuditLinks.push(label);
        }
      }

      checks.push(
        check(
          "export-work-products-have-audit-events",
          missingAuditEvents.length === 0,
          missingAuditEvents.length
            ? `Missing export audit events: ${missingAuditEvents.join(", ")}`
            : "Every persisted local export work product has a matching audit event.",
        ),
        check(
          "export-paths-exist",
          missingExportPaths.length === 0,
          missingExportPaths.length
            ? `Missing export files: ${missingExportPaths.join(", ")}`
            : "Every persisted local export audit event points to an existing file.",
        ),
        check(
          "export-paths-stay-in-data-dir",
          escapedExportPaths.length === 0,
          escapedExportPaths.length
            ? `Export paths outside data directory: ${escapedExportPaths.join(", ")}`
            : "All persisted local export paths stay inside ALETHEIA_DATA_DIR.",
        ),
        check(
          "high-risk-exports-have-approved-checkpoints",
          missingApprovalLinks.length === 0,
          missingApprovalLinks.length
            ? `High-risk exports missing approved checkpoint links: ${missingApprovalLinks.join(", ")}`
            : "High-risk exports resolve to approved human checkpoints.",
        ),
        check(
          "litigation-exports-match-audit-events",
          invalidLitigationExportLinks.length === 0,
          invalidLitigationExportLinks.length
            ? `Litigation exports have invalid audit or artifact bindings: ${invalidLitigationExportLinks.join(", ")}`
            : "Litigation exports match their exact audit event, artifact version, and content hash.",
        ),
        check(
          "litigation-matter-audit-exports-and-signoffs-match",
          invalidLitigationMatterAuditLinks.length === 0,
          invalidLitigationMatterAuditLinks.length
            ? `Litigation matter audit packages or signoffs have invalid bindings: ${invalidLitigationMatterAuditLinks.join(", ")}`
            : "Litigation matter audit packages and signoffs match their checkpoints, hashes, and audit events.",
        ),
        check(
          "final-memo-exports-have-persisted-gate-snapshots",
          missingGateSnapshots.length === 0,
          missingGateSnapshots.length
            ? `Final memo exports missing gate snapshot audit events: ${missingGateSnapshots.join(", ")}`
            : "Final memo exports resolve to persisted gate snapshot audit events.",
        ),
        check(
          "final-memo-gate-snapshots-pass",
          invalidGateSnapshots.length === 0,
          invalidGateSnapshots.length
            ? `Final memo exports have non-passing or malformed gate snapshots: ${invalidGateSnapshots.join(", ")}`
            : "Final memo gate snapshots are passing and schema-versioned.",
        ),
        check(
          "final-memo-exports-have-gate-authorization-events",
          missingGateAuthorizations.length === 0,
          missingGateAuthorizations.length
            ? `Final memo exports missing gate authorization audit events: ${missingGateAuthorizations.join(", ")}`
            : "Final memo exports resolve to gate authorization audit events linked to checkpoint and snapshot.",
        ),
      );
    } catch (error) {
      if (
        !(
          error instanceof Error &&
          error.message === "skip-audit-integrity-deep-checks"
        )
      ) {
        checks.push(
          check(
            "audit-integrity-query",
            false,
            error instanceof Error ? error.message : String(error),
          ),
        );
      }
    } finally {
      db.close();
    }
  }

  const failedCritical = checks.filter(
    (entry) => !entry.ok && entry.severity === "critical",
  );
  const warnings = checks.filter(
    (entry) => !entry.ok && entry.severity === "warning",
  );

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: failedCritical.length === 0,
        suite: "aletheia-audit-integrity-v0",
        checkedAt: new Date().toISOString(),
        dataDir: root,
        sqlite: dbPath,
        summary,
        exportFiles,
        warnings: warnings.length,
        checks,
      },
      null,
      2,
    )}\n`,
  );

  if (failedCritical.length > 0) {
    process.exitCode = 1;
  }
}

main();
