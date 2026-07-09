import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

type OpsCheck = {
  id: string;
  ok: boolean;
  severity: "critical" | "warning";
  detail: string;
};

function repoRoot() {
  return path.resolve(process.cwd(), "..");
}

function readText(root: string, relativePath: string) {
  return readFileSync(path.join(root, relativePath), "utf8");
}

function fileExists(root: string, relativePath: string) {
  return existsSync(path.join(root, relativePath));
}

function hasAll(source: string, values: string[]) {
  return values.every((value) => source.includes(value));
}

function packageScript(root: string, packagePath: string, script: string) {
  if (!fileExists(root, packagePath)) return false;
  const parsed = JSON.parse(readText(root, packagePath)) as {
    scripts?: Record<string, string>;
  };
  return typeof parsed.scripts?.[script] === "string";
}

function check(
  id: string,
  ok: boolean,
  detail: string,
  severity: "critical" | "warning" = "critical",
): OpsCheck {
  return { id, ok, severity, detail };
}

function main() {
  const root = repoRoot();
  const packageJson = "backend/package.json";
  const localDoctor = readText(
    root,
    "backend/src/scripts/aletheiaLocalDoctor.ts",
  );
  const localLauncher = readText(
    root,
    "backend/src/scripts/aletheiaLocalLauncher.ts",
  );
  const packageLocal = readText(
    root,
    "backend/src/scripts/aletheiaPackageLocal.ts",
  );
  const backupManifest = readText(
    root,
    "backend/src/scripts/aletheiaBackupManifest.ts",
  );
  const restorePreflight = readText(
    root,
    "backend/src/scripts/aletheiaRestorePreflight.ts",
  );
  const auditIntegrity = readText(
    root,
    "backend/src/scripts/aletheiaAuditIntegrity.ts",
  );
  const restoreDrill = readText(
    root,
    "backend/src/scripts/aletheiaRestoreDrill.ts",
  );
  const index = readText(root, "backend/src/index.ts");
  const auth = readText(root, "backend/src/middleware/auth.ts");
  const ci = readText(root, ".github/workflows/aletheia-local-ci.yml");
  const docs = [
    "README.md",
    "docs/status.md",
    "docs/local_deployment.md",
    "docs/private_deployment.md",
    "docs/desktop_packaging_checklist.md",
    "docs/release_notes_local_first_mvp.md",
  ]
    .filter((file) => fileExists(root, file))
    .map((file) => readText(root, file))
    .join("\n");

  const checks: OpsCheck[] = [
    check(
      "local-doctor-runtime",
      hasAll(localDoctor, [
        "nodeMajor >= 22",
        'await import("node:sqlite")',
        'actualStorageDriver === "local"',
        'actualAuthMode === "single_user" || actualAuthMode === "private_token"',
        "privateToken.length >= 24",
        "assertWritableDataDirs",
        "semantic-index-boundary",
        "model-provider-keys",
      ]),
      "Local doctor must verify Node 22, node:sqlite, local storage/auth, private token length, writable data dirs, semantic index boundary, and model-key warnings.",
    ),
    check(
      "local-launcher-workstation",
      hasAll(localLauncher, [
        'ALETHEIA_STORAGE_DRIVER: process.env.ALETHEIA_STORAGE_DRIVER ?? "local"',
        'ALETHEIA_AUTH_MODE: process.env.ALETHEIA_AUTH_MODE ?? "single_user"',
        "NEXT_PUBLIC_API_BASE_URL",
        "portOpen",
        "leaving it untouched",
        "/aletheia",
        "/health",
        "npm run mcp:aletheia",
      ]),
      "Local launcher must default to local/single-user mode, respect existing dev servers, print frontend/backend health URLs, and show the MCP command.",
    ),
    check(
      "http-health-and-private-auth",
      hasAll(index, [
        'app.get("/health"',
        "helmet",
        "rateLimit",
        "Aletheia backend running on port",
      ]) &&
        hasAll(auth, [
          'localAuthMode === "single_user"',
          'localAuthMode === "private_token"',
          "constantTimeTokenEqual",
          "ALETHEIA_PRIVATE_AUTH_TOKEN",
          'req.originalUrl.startsWith("/aletheia")',
        ]),
      "Backend must expose a health endpoint and keep Aletheia local/private auth scoped to /aletheia with constant-time token comparison.",
    ),
    check(
      "package-private-runtime",
      hasAll(packageLocal, [
        'packageType: "aletheia-local-private-prototype"',
        "includesClientData: false",
        "privacyDefaults",
        "externalWebSearch: false",
        "browserAutomation: false",
        "terminalExecution: false",
        "destructiveFileOperations: false",
        "backupTogether",
        "restoreChecks",
        "sourceAvailabilityDocs",
        "start-backend.sh",
        "start-frontend.sh",
        "start-mcp.sh",
      ]),
      "Local package prototype must exclude client data, record privacy defaults, backup/restore scope, source availability docs, and startup scripts.",
    ),
    check(
      "backup-restore-audit-chain",
      hasAll(backupManifest, [
        "aletheia-backup-manifest-v0",
        "backupTogether",
        "sqlite",
        "sha256",
        "documents",
        "exports",
        "index",
      ]) &&
        hasAll(restorePreflight, [
          "aletheia-restore-preflight-v0",
          "SQLite, documents, exports, and index paths must stay inside",
          "no-symlinked-backup-content",
          "quick_check",
          "backup-manifest-present",
        ]) &&
        hasAll(auditIntegrity, [
          "aletheia-audit-integrity-v0",
          "approved checkpoint",
          "sha256",
          "export",
          "dataDir",
        ]) &&
        hasAll(restoreDrill, [
          "aletheia-restore-drill-v0",
          "backup-manifest-real-sqlite",
          "restore-preflight-real-data",
          "audit-integrity-real-exports",
        ]),
      "Backup, restore, audit integrity, and restore drill must remain connected around the same local SQLite/filesystem state.",
    ),
    check(
      "ops-validation-entrypoints",
      packageScript(root, packageJson, "check:aletheia:doctor") &&
        packageScript(root, packageJson, "check:aletheia:backup") &&
        packageScript(root, packageJson, "check:aletheia:restore") &&
        packageScript(root, packageJson, "check:aletheia:audit-integrity") &&
        packageScript(root, packageJson, "test:aletheia:restore-drill") &&
        packageScript(root, packageJson, "package:aletheia:local") &&
        packageScript(root, packageJson, "test:aletheia:package") &&
        packageScript(root, packageJson, "dev:aletheia:local"),
      "Operator-facing package scripts must exist for doctor, backup, restore, audit integrity, restore drill, package, package preflight, and local launcher.",
    ),
    check(
      "ci-and-docs-ops-readiness",
      hasAll(ci, [
        "npm run check:aletheia:doctor",
        "npm run check:aletheia:backup",
        "npm run check:aletheia:restore",
        "npm run check:aletheia:ops-readiness",
        "npm run check:aletheia:audit-integrity",
        "npm run test:aletheia:restore-drill",
        "npm run test:aletheia:package",
      ]) &&
        hasAll(docs, [
          "npm run check:aletheia:ops-readiness",
          "private deployment",
          "backup",
          "restore",
          "audit integrity",
          "/health",
          "npm run dev:aletheia:local",
        ]),
      "CI and docs must list the private deployment operational readiness audit and the required operator runbook commands.",
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
        suite: "aletheia-ops-readiness-audit-v0",
        checkedAt: new Date().toISOString(),
        readinessScope: [
          "local doctor",
          "local launcher",
          "health endpoint",
          "private token auth",
          "local private package",
          "backup/restore/audit integrity",
          "operator runbook docs",
        ],
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
