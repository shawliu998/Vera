import { readdirSync, statSync } from "node:fs";
import { lstatSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { LocalDatabase } from "../lib/aletheia/localDatabase";

type RestoreCheck = {
  id: string;
  ok: boolean;
  severity: "critical" | "warning";
  detail: string;
};

type TreeSummary = {
  path: string;
  exists: boolean;
  files: number;
  bytes: number;
  symlinks: number;
};

const REQUIRED_DIRS = ["documents", "exports", "index"] as const;
const CORE_TABLES = [
  "aletheia_matters",
  "aletheia_matter_documents",
  "aletheia_document_chunks",
  "aletheia_work_products",
  "aletheia_evidence_items",
  "aletheia_review_items",
  "aletheia_audit_events",
  "aletheia_agent_runs",
  "aletheia_agent_steps",
  "aletheia_tool_calls",
  "aletheia_human_checkpoints",
  "aletheia_matter_memory_items",
  "aletheia_playbooks",
];

function env(name: string) {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function sourceDir() {
  const configured =
    env("ALETHEIA_RESTORE_SOURCE_DIR") ??
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
): RestoreCheck {
  return { id, ok, severity, detail };
}

function isSubpath(parent: string, child: string) {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function summarizeTree(target: string): TreeSummary {
  if (!existsSync(target)) {
    return { path: target, exists: false, files: 0, bytes: 0, symlinks: 0 };
  }

  let files = 0;
  let bytes = 0;
  let symlinks = 0;
  const stack = [target];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    const currentStats = lstatSync(current);
    if (currentStats.isSymbolicLink()) {
      symlinks += 1;
      continue;
    }
    if (!currentStats.isDirectory()) continue;

    for (const entry of readdirSync(current)) {
      const fullPath = path.join(current, entry);
      const stats = lstatSync(fullPath);
      if (!isSubpath(target, fullPath)) {
        symlinks += 1;
        continue;
      }
      if (stats.isSymbolicLink()) {
        symlinks += 1;
      } else if (stats.isDirectory()) {
        stack.push(fullPath);
      } else if (stats.isFile()) {
        files += 1;
        bytes += stats.size;
      }
    }
  }

  return { path: target, exists: true, files, bytes, symlinks };
}

function sqliteChecks(dbPath: string) {
  if (!existsSync(dbPath)) {
    return {
      present: false,
      quickCheck: null as string | null,
      tables: [] as string[],
      error: null as string | null,
    };
  }

  try {
    const db = new LocalDatabase(dbPath, { readOnly: true });
    try {
      const quickCheckRow = db.prepare("pragma quick_check").get() as
        | { quick_check?: string }
        | undefined;
      const rows = db
        .prepare(
          "select name from sqlite_master where type in ('table', 'view') order by name",
        )
        .all() as Array<{ name?: string }>;
      return {
        present: true,
        quickCheck: quickCheckRow?.quick_check ?? null,
        tables: rows.map((row) => String(row.name ?? "")).filter(Boolean),
        error: null,
      };
    } finally {
      db.close();
    }
  } catch (error) {
    return {
      present: true,
      quickCheck: null,
      tables: [] as string[],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function manifestCheck(root: string) {
  const candidates = [
    path.join(root, "backup-manifest.json"),
    path.join(root, "aletheia-backup-manifest.json"),
    path.join(root, "manifest.json"),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found)
    return { path: null as string | null, suite: null as string | null };
  try {
    const parsed = JSON.parse(readFileSync(found, "utf8")) as {
      suite?: unknown;
    };
    return {
      path: found,
      suite: typeof parsed.suite === "string" ? parsed.suite : null,
    };
  } catch {
    return { path: found, suite: null };
  }
}

function main() {
  const root = sourceDir();
  const dbPath = path.join(root, "aletheia.db");
  const auditKeyPath = path.join(root, ".audit-hmac-key");
  const requiredTrees = REQUIRED_DIRS.map((name) =>
    summarizeTree(path.join(root, name)),
  );
  const sqlite = sqliteChecks(dbPath);
  const missingTables = CORE_TABLES.filter(
    (table) => !sqlite.tables.includes(table),
  );
  const manifest = manifestCheck(root);

  const checks: RestoreCheck[] = [
    check(
      "restore-source-exists",
      existsSync(root) && statSync(root).isDirectory(),
      `Restore source directory must exist before migration: ${root}`,
    ),
    check(
      "restore-source-boundary",
      [dbPath, ...requiredTrees.map((tree) => tree.path)].every((target) =>
        isSubpath(root, target),
      ),
      "SQLite, documents, exports, and index paths must stay inside the restore source directory.",
    ),
    check(
      "required-backup-directories",
      requiredTrees.every((tree) => tree.exists),
      "Restore source must contain documents/, exports/, and index/ directories.",
    ),
    check(
      "no-symlinked-backup-content",
      requiredTrees.every((tree) => tree.symlinks === 0),
      "Restore source should not contain symlinked content because it can escape the local data boundary.",
    ),
    check(
      "sqlite-database-present",
      sqlite.present,
      "Restore source should include aletheia.db for a complete matter workspace restore.",
      "warning",
    ),
    check(
      "sqlite-quick-check",
      !sqlite.present || sqlite.quickCheck === "ok",
      sqlite.error
        ? `SQLite quick_check failed: ${sqlite.error}`
        : `SQLite quick_check result: ${sqlite.quickCheck ?? "not run"}`,
    ),
    check(
      "core-schema-present",
      !sqlite.present || missingTables.length === 0,
      !sqlite.present
        ? "SQLite schema check skipped because aletheia.db is not present."
        : missingTables.length
          ? `Missing Aletheia tables: ${missingTables.join(", ")}`
          : "Core Aletheia tables are present.",
    ),
    check(
      "backup-manifest-present",
      manifest.suite === "aletheia-backup-manifest-v0",
      manifest.path
        ? `Backup manifest found at ${manifest.path} with suite ${manifest.suite ?? "unknown"}.`
        : "No backup manifest found. Generate one with ALETHEIA_BACKUP_MANIFEST_OUT before handoff when possible.",
      "warning",
    ),
    check(
      "audit-verification-key-present",
      !sqlite.present ||
        Boolean(env("ALETHEIA_AUDIT_HMAC_SECRET")) ||
        existsSync(auditKeyPath),
      "Restore .audit-hmac-key with the vault, or configure the original ALETHEIA_AUDIT_HMAC_SECRET.",
    ),
  ];

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
        suite: "aletheia-restore-preflight-v0",
        checkedAt: new Date().toISOString(),
        sourceDir: root,
        requiredBackupScope: [
          "aletheia.db",
          ".audit-hmac-key (or operator-managed ALETHEIA_AUDIT_HMAC_SECRET)",
          "documents/",
          "exports/",
          "index/",
        ],
        sqlite,
        directories: requiredTrees,
        backupManifest: manifest,
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
