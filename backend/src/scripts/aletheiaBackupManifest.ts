import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

type BackupCheck = {
  id: string;
  ok: boolean;
  severity: "critical" | "warning";
  detail: string;
};

type DirectorySummary = {
  path: string;
  exists: boolean;
  files: number;
  bytes: number;
};

function env(name: string) {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function dataDir() {
  const configured =
    env("ALETHEIA_DATA_DIR") ?? env("ALET_HEIA_DATA_DIR") ?? ".data/aletheia";
  return path.resolve(process.cwd(), configured);
}

function check(
  id: string,
  ok: boolean,
  detail: string,
  severity: "critical" | "warning" = "critical",
): BackupCheck {
  return { id, ok, severity, detail };
}

function ensureDir(target: string) {
  mkdirSync(target, { recursive: true });
  return target;
}

function summarizeDirectory(target: string): DirectorySummary {
  if (!existsSync(target)) {
    return { path: target, exists: false, files: 0, bytes: 0 };
  }

  let files = 0;
  let bytes = 0;
  const stack = [target];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    for (const entry of readdirSync(current)) {
      const fullPath = path.join(current, entry);
      const stats = statSync(fullPath);
      if (stats.isDirectory()) {
        stack.push(fullPath);
      } else if (stats.isFile()) {
        files += 1;
        bytes += stats.size;
      }
    }
  }

  return { path: target, exists: true, files, bytes };
}

function fileHash(target: string) {
  if (!existsSync(target)) return null;
  const stats = statSync(target);
  if (!stats.isFile()) return null;
  const hash = createHash("sha256");
  hash.update(readFileSync(target));
  return {
    path: target,
    bytes: stats.size,
    sha256: hash.digest("hex"),
  };
}

function isSubpath(parent: string, child: string) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function main() {
  const root = dataDir();
  const documentsDir = ensureDir(path.join(root, "documents"));
  const exportsDir = ensureDir(path.join(root, "exports"));
  const indexDir = ensureDir(path.join(root, "index"));
  ensureDir(root);

  const sqlitePath = path.join(root, "aletheia.db");
  const directories = [root, documentsDir, exportsDir, indexDir].map(
    summarizeDirectory,
  );
  const sqliteHash = fileHash(sqlitePath);
  const manifestOut = env("ALETHEIA_BACKUP_MANIFEST_OUT");

  const checks: BackupCheck[] = [
    check(
      "data-dir-boundary",
      [documentsDir, exportsDir, indexDir].every((target) =>
        isSubpath(root, target),
      ),
      "documents, exports, and index directories must remain inside ALETHEIA_DATA_DIR.",
    ),
    check(
      "required-directories",
      directories.every((entry) => entry.exists),
      "backup scope directories exist or were created.",
    ),
    check(
      "sqlite-database-present",
      Boolean(sqliteHash),
      sqliteHash
        ? `SQLite database is present with sha256 ${sqliteHash.sha256}.`
        : "SQLite database is not present yet; run a local matter workflow before producing a final backup manifest.",
      "warning",
    ),
    check(
      "backup-scope-complete",
      directories.some((entry) => entry.path === documentsDir) &&
        directories.some((entry) => entry.path === exportsDir) &&
        directories.some((entry) => entry.path === indexDir),
      "backup scope includes documents/, exports/, and index/ alongside aletheia.db.",
    ),
  ];

  const failedCritical = checks.filter(
    (entry) => !entry.ok && entry.severity === "critical",
  );
  const warnings = checks.filter(
    (entry) => !entry.ok && entry.severity === "warning",
  );

  const manifest = {
    ok: failedCritical.length === 0,
    suite: "aletheia-backup-manifest-v0",
    generatedAt: new Date().toISOString(),
    dataDir: root,
    backupTogether: [
      "aletheia.db",
      "documents/",
      "exports/",
      "index/",
    ],
    sqlite: sqliteHash,
    directories,
    warnings: warnings.length,
    checks,
  };

  if (manifestOut) {
    const outPath = path.resolve(process.cwd(), manifestOut);
    ensureDir(path.dirname(outPath));
    writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);

  if (failedCritical.length > 0) {
    process.exitCode = 1;
  }
}

main();
