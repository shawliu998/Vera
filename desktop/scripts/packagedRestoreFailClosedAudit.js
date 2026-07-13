#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  _electron: electron,
} = require("../../frontend/node_modules/playwright");

const desktopDir = path.resolve(__dirname, "..");
const appPath =
  process.env.ALETHEIA_PACKAGED_APP_PATH ??
  path.join(desktopDir, "dist", `mac-${process.arch}`, "Vera.app");
const executablePath = path.join(appPath, "Contents", "MacOS", "Vera");
const schema = "aletheia-pending-restore-v1";

async function endpointIsOffline(url) {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(1_000),
    });
    return !response.ok;
  } catch {
    return true;
  }
}

async function runCase(args) {
  const userDataDir = path.join(args.root, args.name);
  const target = path.join(userDataDir, "aletheia-data");
  const recordPath = path.join(userDataDir, "pending-restore.json");
  fs.mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
  if (args.createTarget) {
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  }
  const rollback = args.rollback(target, userDataDir);
  fs.writeFileSync(
    recordPath,
    `${JSON.stringify({
      schema,
      target,
      rollback,
      createdAt: new Date().toISOString(),
    })}\n`,
    { mode: 0o600 },
  );
  fs.chmodSync(recordPath, args.mode);

  let electronApp = null;
  try {
    electronApp = await electron.launch({
      executablePath,
      args: [`--user-data-dir=${userDataDir}`],
      env: {
        ...process.env,
        ALETHEIA_DESKTOP_FRONTEND_PORT: String(args.frontendPort),
        ALETHEIA_DESKTOP_BACKEND_PORT: String(args.backendPort),
        ALETHEIA_DEMO_SEED_ENABLED: "false",
        ALETHEIA_REQUIRE_ENCRYPTED_VOLUME: "false",
        ALETHEIA_APPLICATION_ENCRYPTION: "required",
        ALETHEIA_MASTER_KEY_SOURCE: "env",
        ALETHEIA_MASTER_KEY_BASE64: crypto.randomBytes(32).toString("base64"),
        ALETHEIA_DATABASE_ENCRYPTION: "sqlcipher_required",
        ALETHEIA_DATABASE_KEY_SOURCE: "env",
        ALETHEIA_DATABASE_KEY_BASE64: crypto.randomBytes(32).toString("base64"),
      },
      timeout: 60_000,
    });
    await electronApp.firstWindow({ timeout: 30_000 });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    assert.equal(
      await endpointIsOffline(`http://127.0.0.1:${args.backendPort}/health`),
      true,
      `${args.name}: backend must stay offline`,
    );
    assert.equal(
      await endpointIsOffline(`http://127.0.0.1:${args.frontendPort}/aletheia/matters`),
      true,
      `${args.name}: frontend must stay offline`,
    );
    assert.equal(
      fs.existsSync(recordPath),
      true,
      `${args.name}: pending record must be retained`,
    );
  } finally {
    if (electronApp) await electronApp.close().catch(() => undefined);
  }
}

async function main() {
  if (process.platform !== "darwin") {
    throw new Error("This audit requires macOS.");
  }
  fs.accessSync(executablePath, fs.constants.X_OK);
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "vera-restore-fail-closed-"),
  );
  fs.chmodSync(root, 0o700);
  try {
    await runCase({
      root,
      name: "outside-parent",
      frontendPort: 44810,
      backendPort: 44811,
      createTarget: true,
      mode: 0o600,
      rollback: () => path.join(root, "outside-rollback"),
    });
    await runCase({
      root,
      name: "permissive-record",
      frontendPort: 44820,
      backendPort: 44821,
      createTarget: true,
      mode: 0o644,
      rollback: (target) =>
        path.join(path.dirname(target), ".aletheia-restore-rollback-permissions"),
    });
    await runCase({
      root,
      name: "missing-both",
      frontendPort: 44830,
      backendPort: 44831,
      createTarget: false,
      mode: 0o600,
      rollback: (target) =>
        path.join(path.dirname(target), ".aletheia-restore-rollback-missing"),
    });
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          suite: "vera-packaged-restore-fail-closed-v1",
          checks: [
            "out-of-bound rollback path blocks startup",
            "permissive pending-record mode blocks startup",
            "missing target and rollback blocks startup",
            "failed recovery retains pending record",
            "backend and frontend remain offline",
          ],
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
});
