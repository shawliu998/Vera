import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

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
  };
}

export default async function globalSetup() {
  const frontendDir = process.cwd();
  const repoRoot = path.resolve(frontendDir, "..");
  const backendDir = path.join(repoRoot, "backend");
  const frontendPort = Number(process.env.ALETHEIA_UI_SMOKE_FRONTEND_PORT ?? 3410);
  const backendPort = Number(process.env.ALETHEIA_UI_SMOKE_BACKEND_PORT ?? 3411);
  const frontendUrl = `http://127.0.0.1:${frontendPort}`;
  const dataDir =
    process.env.ALETHEIA_UI_SMOKE_DATA_DIR ??
    path.join(backendDir, ".data", "aletheia-ui-smoke-e2e");
  const stateDir = path.join(frontendDir, "test-results");
  const statePath = path.join(stateDir, "aletheia-ui-smoke-state.json");

  mkdirSync(stateDir, { recursive: true });

  const env = {
    ...process.env,
    PORT: String(backendPort),
    FRONTEND_URL: frontendUrl,
    ALETHEIA_STORAGE_DRIVER: "local",
    ALETHEIA_AUTH_MODE: "single_user",
    ALETHEIA_DATA_DIR: dataDir,
    ALETHEIA_LOCAL_USER_ID: "local-user",
    ALETHEIA_LOCAL_USER_EMAIL: "local@aletheia.internal",
    ALETHEIA_UI_SMOKE_FRONTEND_URL: frontendUrl,
    ALETHEIA_UI_SMOKE_TIMESTAMP: "2026-07-08T16:00:00.000Z",
  };

  const projects = ["desktop-chromium", "mobile-chromium"].reduce<
    Record<string, ReturnType<typeof parseSeedOutput>>
  >((acc, projectName) => {
    const output = execFileSync(npmCommand(), ["run", "seed:aletheia:ui-smoke"], {
      cwd: backendDir,
      env,
      encoding: "utf8",
    });
    const state = parseSeedOutput(output);
    if (!state.ok || !state.matterId) {
      throw new Error(`UI smoke seed failed for ${projectName}: ${output}`);
    }
    acc[projectName] = state;
    return acc;
  }, {});

  if (!projects["desktop-chromium"] || !projects["mobile-chromium"]) {
    throw new Error("UI smoke seed did not create all project matters.");
  }
  writeFileSync(
    statePath,
    `${JSON.stringify({ projects, dataDir, backendPort, frontendPort }, null, 2)}\n`,
  );
}
