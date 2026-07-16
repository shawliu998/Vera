import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const SMOKE_APPLICATION_KEY = Buffer.alloc(32, 0x56).toString("base64");

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function parseSeedOutput(output: string) {
  const jsonStart = output.indexOf("{");
  const jsonEnd = output.lastIndexOf("}");
  if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) {
    throw new Error(`Could not parse seed output: ${output}`);
  }
  return JSON.parse(output.slice(jsonStart, jsonEnd + 1)) as {
    ok: boolean;
    matterId: string;
    matterUrl: string;
    matterTitle: string;
  };
}

function seedCommandOutput(
  backendDir: string,
  seedScript: string,
  env: NodeJS.ProcessEnv,
) {
  const sleepState = new Int32Array(new SharedArrayBuffer(4));
  const maximumAttempts = 8;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    try {
      return execFileSync(npmCommand(), ["run", seedScript], {
        cwd: backendDir,
        env,
        encoding: "utf8",
      });
    } catch (error) {
      const failure = error as {
        message?: unknown;
        stdout?: unknown;
        stderr?: unknown;
      };
      const detail = [failure.message, failure.stdout, failure.stderr]
        .filter((value): value is string => typeof value === "string")
        .join("\n");
      const databaseBusy =
        detail.includes("database is locked") || detail.includes("SQLITE_BUSY");
      if (!databaseBusy || attempt === maximumAttempts) throw error;

      // Playwright starts the backend before globalSetup. Its initial local
      // database work can briefly overlap this separate seed process, so only
      // the explicit SQLite busy condition receives a bounded retry.
      Atomics.wait(
        sleepState,
        0,
        0,
        Math.min(250 * 2 ** (attempt - 1), 2_000),
      );
    }
  }
  throw new Error("UI smoke seed exhausted its bounded retry loop.");
}

export default async function globalSetup() {
  const frontendDir = process.cwd();
  const repoRoot = path.resolve(frontendDir, "..");
  const backendDir = path.join(repoRoot, "backend");
  const frontendPort = Number(
    process.env.ALETHEIA_UI_SMOKE_FRONTEND_PORT ?? 3410,
  );
  const backendPort = Number(
    process.env.ALETHEIA_UI_SMOKE_BACKEND_PORT ?? 3411,
  );
  const frontendUrl = `http://127.0.0.1:${frontendPort}`;
  const dataDir =
    process.env.ALETHEIA_UI_SMOKE_DATA_DIR ??
    path.join(backendDir, ".data", "aletheia-ui-smoke-e2e");
  // Playwright owns and may clean `test-results` between projects/workers.
  // Keep the shared fixture manifest beside the smoke build instead so a
  // failed test or project switch cannot erase the matter IDs used downstream.
  const stateDir = frontendDir;
  const statePath = path.join(stateDir, ".next-ui-smoke-state.json");

  mkdirSync(stateDir, { recursive: true });

  const env = {
    ...process.env,
    PORT: String(backendPort),
    FRONTEND_URL: frontendUrl,
    ALETHEIA_AUTH_MODE: "single_user",
    VERA_WORKSPACE_ALLOW_SINGLE_USER_DEV: "true",
    ALETHEIA_APPLICATION_ENCRYPTION: "required",
    ALETHEIA_MASTER_KEY_SOURCE: "env",
    ALETHEIA_MASTER_KEY_BASE64: SMOKE_APPLICATION_KEY,
    ALETHEIA_DATA_DIR: dataDir,
    ALETHEIA_LOCAL_USER_ID: "local-user",
    ALETHEIA_LOCAL_USER_EMAIL: "local@aletheia.internal",
    RATE_LIMIT_GENERAL_MAX: "10000",
    RATE_LIMIT_UPLOAD_MAX: "1000",
    RATE_LIMIT_EXTERNAL_SOURCE_MAX: "1000",
    ALETHEIA_UI_SMOKE_FRONTEND_URL: frontendUrl,
    ALETHEIA_UI_SMOKE_TIMESTAMP: "2026-07-08T16:00:00.000Z",
  };

  // Tests intentionally create approvals and work products. Give every
  // browser project and feature spec its own matter instead of leaking state
  // from an earlier spec into a later one.
  const fixtures = [
    "agentops",
    "external-source",
    "import",
    "workspace",
    "review",
    "litigation",
  ] as const;
  const projects = Object.fromEntries(
    ["desktop-chromium", "mobile-chromium"].map((projectName) => [
      projectName,
      Object.fromEntries(
        fixtures.map((fixture) => {
          const fixtureKey = `${projectName}-${fixture}`;
          const seedScript =
            fixture === "litigation"
              ? "seed:aletheia:litigation-demo"
              : "seed:aletheia:ui-smoke";
          const output = seedCommandOutput(backendDir, seedScript, {
            ...env,
            ALETHEIA_DEMO_SEED_ID: `aletheia-ui-smoke-${fixtureKey}`,
            ALETHEIA_DEMO_SEED_TITLE_SUFFIX: fixtureKey,
            ALETHEIA_DEMO_LOW_OCR:
              fixture === "litigation" ? "true" : "false",
          });
          const state = parseSeedOutput(output);
          if (!state.ok || !state.matterId) {
            throw new Error(
              `UI smoke seed failed for ${projectName}/${fixture}: ${output}`,
            );
          }
          return [fixture, state];
        }),
      ),
    ]),
  );

  if (!projects["desktop-chromium"] || !projects["mobile-chromium"]) {
    throw new Error("UI smoke seed did not create all project matters.");
  }
  writeFileSync(
    statePath,
    `${JSON.stringify({ projects, dataDir, backendPort, frontendPort }, null, 2)}\n`,
  );
}
