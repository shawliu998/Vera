#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

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
  const recordPath = path.join(userDataDir, "pending-restore.json");
  fs.mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
  const target = path.join(fs.realpathSync(userDataDir), "aletheia-data");
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

  let child = null;
  try {
    let output = "";
    child = spawn(executablePath, [], {
      env: {
        ...process.env,
        VERA_DESKTOP_PROFILE_DIR: userDataDir,
        VERA_ENABLE_LEGACY_ROUTES: "false",
        VERA_ENABLE_LEGACY_RUNTIME: "false",
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
      stdio: ["ignore", "pipe", "pipe"],
    });
    const append = (chunk) => {
      output = `${output}${chunk.toString()}`.slice(-16_384);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    const exited = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        child?.kill("SIGTERM");
        reject(new Error(`${args.name}: fail-closed launch did not exit`));
      }, 60_000);
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("close", (code, signal) => {
        clearTimeout(timeout);
        resolve({ code, signal });
      });
    });
    child = null;
    assert.deepEqual(
      exited,
      { code: 1, signal: null },
      `${args.name}: invalid pending restore must terminate before local services start`,
    );
    assert.match(output, /\[vera-profile-bootstrap\] startup_failed:/);
    assert.match(output, args.expectedFailure);
    const desktopLogPath = path.join(
      userDataDir,
      "logs",
      "vera",
      "vera.log",
    );
    const desktopLogInfo = fs.lstatSync(desktopLogPath);
    assert.equal(
      desktopLogInfo.isFile() && !desktopLogInfo.isSymbolicLink(),
      true,
      `${args.name}: isolated desktop log must be a regular file`,
    );
    const desktopLog = fs.readFileSync(desktopLogPath, "utf8");
    assert.match(
      desktopLog,
      /"event":"startup_failed"/,
      `${args.name}: the working desktop logger must record the fail-closed exit`,
    );
    assert.doesNotMatch(
      desktopLog,
      /"event":"renderer_window_creating"/,
      `${args.name}: no renderer window may be created before pending restore validation`,
    );
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
    if (child && child.exitCode === null) child.kill("SIGTERM");
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
      expectedFailure: /pending restore paths are invalid/i,
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
      expectedFailure: /pending restore record is unsafe/i,
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
      expectedFailure: /Both restored and rollback workspaces are missing/i,
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
            "invalid restore state exits before local services start",
            "working desktop log proves no renderer window was created",
            "renderer-before-recovery ordering is also source-gated",
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
