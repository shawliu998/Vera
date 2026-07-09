import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

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
};

type CheckpointRow = {
  id: string;
  matter_id: string;
  checkpoint_type: string;
  status: string;
  decision: string | null;
  decided_at: string | null;
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
};
const REQUIRED_TABLES = [
  "aletheia_matters",
  "aletheia_work_products",
  "aletheia_audit_events",
  "aletheia_human_checkpoints",
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
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
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

function count(db: DatabaseSync, sql: string) {
  const row = db.prepare(sql).get() as { count?: number } | undefined;
  return Number(row?.count ?? 0);
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
  };

  if (existsSync(dbPath)) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
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

      summary.matters = count(db, "select count(*) as count from aletheia_matters");
      summary.workProducts = count(
        db,
        "select count(*) as count from aletheia_work_products",
      );
      summary.auditEvents = count(
        db,
        "select count(*) as count from aletheia_audit_events",
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
            where kind in ('audit_pack', 'feedback_export', 'final_memo', 'registry_snapshot')
            order by created_at asc
          `,
        )
        .all() as WorkProductRow[];
      summary.exportEvents = exportProducts.length;
      summary.highRiskExports = exportProducts.filter(
        (item) => HIGH_RISK_EXPORTS[item.kind],
      ).length;

      const auditRows = db
        .prepare(
          `
            select id, matter_id, action, details, created_at
            from aletheia_audit_events
            where action in (
              'audit_pack_exported',
              'feedback_dataset_exported',
              'final_memo_exported',
              'registry_snapshot_saved'
            )
          `,
        )
        .all() as AuditEventRow[];
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
            if (approvalCheckpointId) return checkpoint.id === approvalCheckpointId;
            return true;
          });
          if (!linked) {
            missingApprovalLinks.push(`${product.kind}:${product.id}`);
          }
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
      );
    } catch (error) {
      if (!(error instanceof Error && error.message === "skip-audit-integrity-deep-checks")) {
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
