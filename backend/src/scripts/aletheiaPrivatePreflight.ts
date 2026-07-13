import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

type PreflightCommand = {
  id: string;
  cwd: string;
  args: string[];
  env?: Record<string, string>;
  optional?: boolean;
};

type PreflightResult = {
  id: string;
  ok: boolean;
  durationMs: number;
  command: string;
  cwd: string;
  optional: boolean;
  error?: string;
};

function repoRoot() {
  return path.resolve(process.cwd(), "..");
}

function npmBin() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function commandLine(command: PreflightCommand) {
  return `npm ${command.args.join(" ")}`;
}

function run(command: PreflightCommand): PreflightResult {
  const startedAt = Date.now();
  try {
    execFileSync(npmBin(), command.args, {
      cwd: command.cwd,
      env: {
        ...process.env,
        ...command.env,
      },
      stdio: "inherit",
    });
    return {
      id: command.id,
      ok: true,
      durationMs: Date.now() - startedAt,
      command: commandLine(command),
      cwd: command.cwd,
      optional: command.optional === true,
    };
  } catch (error) {
    return {
      id: command.id,
      ok: false,
      durationMs: Date.now() - startedAt,
      command: commandLine(command),
      cwd: command.cwd,
      optional: command.optional === true,
      error: error instanceof Error ? error.message : "Command failed.",
    };
  }
}

function main() {
  const root = repoRoot();
  const backendDir = process.cwd();
  const frontendDir = path.join(root, "frontend");
  const desktopDir = path.join(root, "desktop");
  const packageDir =
    process.env.ALETHEIA_LOCAL_PACKAGE_DIR ??
    mkdtempSync(path.join(tmpdir(), "aletheia-private-preflight-package-"));
  const preflightDataDir = mkdtempSync(
    path.join(tmpdir(), "aletheia-private-preflight-data-"),
  );
  const isolatedBackendEnvironment = {
    ALETHEIA_AUTH_MODE: "single_user",
    ALETHEIA_DATA_DIR: preflightDataDir,
    ALETHEIA_APPLICATION_ENCRYPTION: "disabled",
    ALETHEIA_DATABASE_ENCRYPTION: "metadata_plaintext",
    ALETHEIA_SEMANTIC_INDEX_ENABLED: "false",
    ALETHEIA_SEMANTIC_INDEX_DRIVER: "disabled",
    ALETHEIA_AUDIT_HMAC_SECRET:
      "aletheia-private-preflight-only-hmac-secret-2026",
  };
  const releaseEvidenceOut =
    process.env.ALETHEIA_RELEASE_EVIDENCE_OUT ??
    path.join(tmpdir(), `aletheia-release-evidence-${process.pid}.json`);
  const includeUiSmoke = process.env.ALETHEIA_PREFLIGHT_INCLUDE_UI === "true";
  const skipFrontend = process.env.ALETHEIA_PREFLIGHT_SKIP_FRONTEND === "true";

  const backendCommands: PreflightCommand[] = [
    { id: "backend-build", cwd: backendDir, args: ["run", "build"] },
    {
      id: "application-encryption",
      cwd: backendDir,
      args: ["run", "test:aletheia:encryption"],
    },
    {
      id: "sqlcipher-integration",
      cwd: backendDir,
      args: ["run", "test:aletheia:sqlcipher"],
    },
    {
      id: "independent-audit-anchors",
      cwd: backendDir,
      args: ["run", "test:aletheia:audit-anchors"],
    },
    {
      id: "local-control",
      cwd: backendDir,
      args: ["run", "check:aletheia:local-control"],
    },
    {
      id: "local-doctor",
      cwd: backendDir,
      args: ["run", "check:aletheia:doctor"],
    },
    {
      id: "backup-manifest",
      cwd: backendDir,
      args: ["run", "check:aletheia:backup"],
      env: {
        ALETHEIA_BACKUP_MANIFEST_OUT: path.join(
          preflightDataDir,
          "backup-manifest.json",
        ),
      },
    },
    {
      id: "restore-preflight",
      cwd: backendDir,
      args: ["run", "check:aletheia:restore"],
      env: {
        ALETHEIA_DATA_DIR: preflightDataDir,
        ALETHEIA_RESTORE_SOURCE_DIR: preflightDataDir,
      },
    },
    {
      id: "privacy-preflight",
      cwd: backendDir,
      args: ["run", "check:aletheia:privacy"],
    },
    {
      id: "ops-readiness",
      cwd: backendDir,
      args: ["run", "check:aletheia:ops-readiness"],
    },
    {
      id: "source-provenance",
      cwd: backendDir,
      args: ["run", "check:aletheia:source-provenance"],
    },
    {
      id: "knowledge-governance",
      cwd: backendDir,
      args: ["run", "check:aletheia:knowledge-governance"],
    },
    {
      id: "audit-workbench",
      cwd: backendDir,
      args: ["run", "check:aletheia:audit-workbench"],
    },
    {
      id: "tool-policy",
      cwd: backendDir,
      args: ["run", "check:aletheia:tool-policy"],
    },
    {
      id: "approval-policy",
      cwd: backendDir,
      args: ["run", "check:aletheia:approval-policy"],
    },
    {
      id: "matter-isolation",
      cwd: backendDir,
      args: ["run", "check:aletheia:matter-isolation"],
    },
    {
      id: "run-trace",
      cwd: backendDir,
      args: ["run", "check:aletheia:run-trace"],
    },
    {
      id: "release-evidence",
      cwd: backendDir,
      args: ["run", "check:aletheia:evidence"],
      env: { ALETHEIA_RELEASE_EVIDENCE_OUT: releaseEvidenceOut },
    },
    {
      id: "audit-integrity",
      cwd: backendDir,
      args: ["run", "check:aletheia:audit-integrity"],
    },
    {
      id: "operator-health",
      cwd: backendDir,
      args: ["run", "check:aletheia:operator"],
    },
    {
      id: "local-regression",
      cwd: backendDir,
      args: ["run", "test:aletheia:local"],
    },
    {
      id: "restore-drill",
      cwd: backendDir,
      args: ["run", "test:aletheia:restore-drill"],
    },
    {
      id: "retrieval-eval",
      cwd: backendDir,
      args: ["run", "test:aletheia:retrieval-eval"],
    },
  ];

  for (const command of backendCommands) {
    command.env = {
      ...isolatedBackendEnvironment,
      ...command.env,
    };
  }

  const frontendCommands: PreflightCommand[] = skipFrontend
    ? []
    : [
        { id: "frontend-lint", cwd: frontendDir, args: ["run", "lint"] },
        { id: "frontend-build", cwd: frontendDir, args: ["run", "build"] },
      ];

  const packagingCommands: PreflightCommand[] = [
    {
      id: "desktop-sqlcipher-runtime",
      cwd: desktopDir,
      args: ["run", "test:sqlcipher-runtime"],
    },
    {
      id: "package-preflight",
      cwd: backendDir,
      args: ["run", "test:aletheia:package"],
      env: { ALETHEIA_LOCAL_PACKAGE_DIR: packageDir },
    },
    {
      id: "completion-audit",
      cwd: backendDir,
      args: ["run", "test:aletheia:completion"],
    },
  ];

  const uiSmokeCommands: PreflightCommand[] =
    includeUiSmoke && !skipFrontend
      ? [
          {
            id: "ui-smoke",
            cwd: frontendDir,
            args: ["run", "test:aletheia:ui"],
          },
        ]
      : [];

  const commands = [
    ...backendCommands,
    ...frontendCommands,
    ...packagingCommands,
    ...uiSmokeCommands,
  ];
  const results: PreflightResult[] = [];

  for (const command of commands) {
    const result = run(command);
    results.push(result);
    if (!result.ok && !result.optional) break;
  }

  const failed = results.filter((result) => !result.ok && !result.optional);
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: failed.length === 0,
        suite: "aletheia-private-preflight-v0",
        checkedAt: new Date().toISOString(),
        packageDir,
        preflightDataDir,
        releaseEvidenceOut,
        includeUiSmoke,
        skipFrontend,
        total: commands.length,
        completed: results.length,
        failed: failed.length,
        results,
      },
      null,
      2,
    )}\n`,
  );

  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

main();
