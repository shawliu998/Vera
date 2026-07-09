import { execFileSync } from "node:child_process";
import path from "node:path";

type DrillCheck = {
  id: string;
  ok: boolean;
  severity: "critical" | "warning";
  detail: string;
};

function check(
  id: string,
  ok: boolean,
  detail: string,
  severity: "critical" | "warning" = "critical",
): DrillCheck {
  return { id, ok, severity, detail };
}

function runNpm(args: string[], env: NodeJS.ProcessEnv = {}) {
  return execFileSync("npm", args, {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function parseJsonOutput<T>(output: string): T {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`Command did not emit a JSON object: ${output.slice(0, 200)}`);
  }
  return JSON.parse(output.slice(start, end + 1)) as T;
}

function main() {
  const regression = parseJsonOutput<{
    ok?: boolean;
    dataDir?: string;
    matterId?: string;
    exportPath?: string;
  }>(runNpm(["run", "test:aletheia:local"]));
  const dataDir = regression.dataDir ? path.resolve(regression.dataDir) : null;
  const manifestPath = dataDir
    ? path.join(dataDir, "backup-manifest.json")
    : null;

  const drillChecks: DrillCheck[] = [
    check(
      "local-regression-produced-real-data",
      regression.ok === true && Boolean(dataDir),
      dataDir
        ? `Local regression produced matter ${regression.matterId ?? "unknown"} in ${dataDir}.`
        : "Local regression did not report a data directory.",
    ),
    check(
      "local-regression-produced-export",
      typeof regression.exportPath === "string",
      regression.exportPath
        ? "Local regression produced an audited export file."
        : "Local regression did not report an export path.",
    ),
  ];

  let backup: any = null;
  let restore: any = null;
  let audit: any = null;

  if (dataDir && manifestPath) {
    backup = parseJsonOutput<any>(
      runNpm(["run", "check:aletheia:backup"], {
        ALETHEIA_STORAGE_DRIVER: "local",
        ALETHEIA_AUTH_MODE: "single_user",
        ALETHEIA_DATA_DIR: dataDir,
        ALETHEIA_BACKUP_MANIFEST_OUT: manifestPath,
      }),
    );
    restore = parseJsonOutput<any>(
      runNpm(["run", "check:aletheia:restore"], {
        ALETHEIA_STORAGE_DRIVER: "local",
        ALETHEIA_AUTH_MODE: "single_user",
        ALETHEIA_DATA_DIR: dataDir,
        ALETHEIA_RESTORE_SOURCE_DIR: dataDir,
      }),
    );
    audit = parseJsonOutput<any>(
      runNpm(["run", "check:aletheia:audit-integrity"], {
        ALETHEIA_STORAGE_DRIVER: "local",
        ALETHEIA_AUTH_MODE: "single_user",
        ALETHEIA_DATA_DIR: dataDir,
        ALETHEIA_AUDIT_SOURCE_DIR: dataDir,
      }),
    );

    drillChecks.push(
      check(
        "backup-manifest-real-sqlite",
        backup.ok === true && typeof backup.sqlite?.sha256 === "string",
        backup.sqlite?.sha256
          ? `Backup manifest recorded SQLite sha256 ${backup.sqlite.sha256}.`
          : "Backup manifest did not record a real SQLite database hash.",
      ),
      check(
        "restore-preflight-real-data",
        restore.ok === true && restore.sqlite?.present === true,
        restore.sqlite?.present
          ? "Restore preflight validated a real SQLite matter workspace."
          : "Restore preflight did not validate a real SQLite database.",
      ),
      check(
        "restore-preflight-no-warnings",
        Number(restore.warnings ?? 0) === 0,
        `${Number(restore.warnings ?? 0)} restore warning(s) reported for the real regression data directory.`,
      ),
      check(
        "audit-integrity-real-exports",
        audit.ok === true &&
          Number(audit.summary?.matters ?? 0) > 0 &&
          Number(audit.summary?.highRiskExports ?? 0) > 0 &&
          Array.isArray(audit.exportFiles) &&
          audit.exportFiles.length > 0,
        `Audit integrity summary: ${JSON.stringify(audit.summary ?? {})}.`,
      ),
      check(
        "audit-integrity-no-warnings",
        Number(audit.warnings ?? 0) === 0,
        `${Number(audit.warnings ?? 0)} audit integrity warning(s) reported for the real regression data directory.`,
      ),
    );
  }

  const failedCritical = drillChecks.filter(
    (entry) => !entry.ok && entry.severity === "critical",
  );
  const warnings = drillChecks.filter(
    (entry) => !entry.ok && entry.severity === "warning",
  );
  const result = {
    ok: failedCritical.length === 0,
    suite: "aletheia-restore-drill-v0",
    checkedAt: new Date().toISOString(),
    dataDir,
    matterId: regression.matterId ?? null,
    backupManifestPath: manifestPath,
    backup: backup
      ? {
          ok: backup.ok,
          sqliteSha256: backup.sqlite?.sha256 ?? null,
          warnings: backup.warnings ?? 0,
        }
      : null,
    restore: restore
      ? {
          ok: restore.ok,
          sqlitePresent: restore.sqlite?.present ?? false,
          quickCheck: restore.sqlite?.quickCheck ?? null,
          warnings: restore.warnings ?? 0,
        }
      : null,
    audit: audit
      ? {
          ok: audit.ok,
          summary: audit.summary,
          exportFiles: Array.isArray(audit.exportFiles)
            ? audit.exportFiles.length
            : 0,
          warnings: audit.warnings ?? 0,
        }
      : null,
    warnings: warnings.length,
    checks: drillChecks,
  };

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

  if (failedCritical.length > 0) {
    process.exitCode = 1;
  }
}

main();
