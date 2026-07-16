#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const HOST = "127.0.0.1";
const FRONTEND_PORT = Number(
  process.env.ALETHEIA_DESKTOP_FRONTEND_PORT ?? 43760,
);
const BACKEND_PORT = Number(
  process.env.ALETHEIA_DESKTOP_BACKEND_PORT ?? 43761,
);
const FRONTEND_URL = `http://${HOST}:${FRONTEND_PORT}/assistant`;
const BACKEND_URL = `http://${HOST}:${BACKEND_PORT}/health`;
const LEGACY_ROUTE_URL = `http://${HOST}:${BACKEND_PORT}/aletheia/local-voice/status`;
const STARTUP_TIMEOUT_MS = 180_000;
const SHUTDOWN_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 500;
const MAX_LOG_BYTES = 64 * 1024;

const desktopDir = path.resolve(__dirname, "..");
const appPath =
  process.env.ALETHEIA_PACKAGED_APP_PATH ??
  path.join(desktopDir, "dist", `mac-${process.arch}`, "Vera.app");
const executablePath = path.join(appPath, "Contents", "MacOS", "Vera");

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function appendLog(current, chunk) {
  const combined = `${current}${chunk.toString()}`;
  return combined.length > MAX_LOG_BYTES
    ? combined.slice(combined.length - MAX_LOG_BYTES)
    : combined;
}

function portIsFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, HOST, () => {
      server.close((error) => resolve(!error));
    });
  });
}

async function assertPortsFree() {
  const results = await Promise.all(
    [FRONTEND_PORT, BACKEND_PORT].map(async (port) => ({
      port,
      free: await portIsFree(port),
    })),
  );
  const occupied = results.filter((result) => !result.free);
  if (occupied.length > 0) {
    throw new Error(
      `Packaged app smoke requires free ports: ${occupied
        .map((result) => result.port)
        .join(", ")}`,
    );
  }
}

function requestStatus(url) {
  return new Promise((resolve) => {
    const request = http.get(url, (response) => {
      const status = response.statusCode ?? 0;
      response.resume();
      response.once("end", () => resolve({ status, error: null }));
    });
    request.setTimeout(3_000, () => {
      request.destroy(new Error("request timed out"));
    });
    request.once("error", (error) => {
      resolve({ status: 0, error: error.message });
    });
  });
}

async function assertFormalLegacyDefaults() {
  const healthResponse = await fetch(BACKEND_URL, {
    signal: AbortSignal.timeout(3_000),
  });
  assert.equal(healthResponse.status, 200);
  const health = await healthResponse.json();
  assert.equal(health?.vera?.legacy?.status, "disabled");
  assert.equal(health?.vera?.legacy?.routesEnabled, false);
  assert.equal(health?.vera?.legacy?.runtimeEnabled, false);

  const legacyRoute = await requestStatus(LEGACY_ROUTE_URL);
  assert.equal(
    legacyRoute.status,
    404,
    `formal desktop Legacy route must be absent (error=${legacyRoute.error ?? "none"})`,
  );
  return health.vera.legacy;
}

function requireRegularFile(filePath, label, { privateAccess = false } = {}) {
  const info = fs.statSync(filePath, { throwIfNoEntry: false });
  if (!info?.isFile() || info.size <= 0) {
    throw new Error(`${label} was not created inside the isolated profile.`);
  }
  if (privateAccess && (info.mode & 0o077) !== 0) {
    throw new Error(`${label} must not grant group or world access.`);
  }
  return info.size;
}

function verifyIsolatedProfile(userDataDir) {
  const databasePath = path.join(userDataDir, "aletheia-data", "aletheia.db");
  const logPath = path.join(userDataDir, "logs", "vera", "vera.log");
  const runtimeRoot = path.join(
    userDataDir,
    "runtime",
    "frontend-node-modules",
  );
  const runtimeEntries = fs
    .readdirSync(runtimeRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink());
  if (runtimeEntries.length !== 1) {
    throw new Error(
      "The isolated profile must contain exactly one traced frontend dependency set.",
    );
  }
  const runtimeDirectory = path.join(runtimeRoot, runtimeEntries[0].name);
  const readyBytes = requireRegularFile(
    path.join(runtimeDirectory, ".ready"),
    "Frontend runtime readiness marker",
  );
  const nextPackageBytes = requireRegularFile(
    path.join(runtimeDirectory, "node_modules", "next", "package.json"),
    "Traced Next runtime",
  );
  return {
    encryptedDatabaseBytes: requireRegularFile(
      databasePath,
      "Encrypted workspace database",
      { privateAccess: true },
    ),
    desktopLogBytes: requireRegularFile(logPath, "Desktop log", {
      privateAccess: true,
    }),
    frontendRuntimeReadyBytes: readyBytes,
    nextRuntimePackageBytes: nextPackageBytes,
  };
}

function readIsolatedLogTail(userDataDir) {
  const logPath = path.join(userDataDir, "logs", "vera", "vera.log");
  const info = fs.statSync(logPath, { throwIfNoEntry: false });
  if (!info?.isFile() || info.size <= 0) return "";
  const length = Math.min(info.size, MAX_LOG_BYTES);
  const buffer = Buffer.alloc(length);
  const descriptor = fs.openSync(logPath, "r");
  try {
    fs.readSync(descriptor, buffer, 0, length, info.size - length);
  } finally {
    fs.closeSync(descriptor);
  }
  return buffer.toString("utf8");
}

async function waitForServices(child, processState) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let frontend = { status: 0, error: "not requested" };
  let backend = { status: 0, error: "not requested" };

  while (Date.now() < deadline) {
    if (processState.exited) {
      throw new Error(
        `Packaged app exited before startup completed (code=${processState.code}, signal=${processState.signal}).`,
      );
    }
    [frontend, backend] = await Promise.all([
      requestStatus(FRONTEND_URL),
      requestStatus(BACKEND_URL),
    ]);
    if (frontend.status === 200 && backend.status === 200) {
      return;
    }
    await wait(POLL_INTERVAL_MS);
  }

  child.kill("SIGTERM");
  throw new Error(
    `Packaged app did not become ready within ${STARTUP_TIMEOUT_MS}ms ` +
      `(frontend=${frontend.status || frontend.error}, backend=${backend.status || backend.error}).`,
  );
}

function signalProcessGroup(child, signal) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
  try {
    child.kill(signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

async function waitForShutdown(child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [frontendFree, backendFree] = await Promise.all([
      portIsFree(FRONTEND_PORT),
      portIsFree(BACKEND_PORT),
    ]);
    const applicationExited =
      child.exitCode !== null || child.signalCode !== null;
    if (applicationExited && frontendFree && backendFree) return true;
    await wait(POLL_INTERVAL_MS);
  }
  return false;
}

async function terminateApp(child) {
  if (!child) return;
  signalProcessGroup(child, "SIGTERM");
  if (await waitForShutdown(child, SHUTDOWN_TIMEOUT_MS)) return;

  signalProcessGroup(child, "SIGKILL");
  if (!(await waitForShutdown(child, SHUTDOWN_TIMEOUT_MS))) {
    throw new Error(
      `Packaged app did not exit cleanly or ports ${FRONTEND_PORT} and ${BACKEND_PORT} were not released.`,
    );
  }
}

async function assertPackagedEncryptionDowngradeRejected({
  name,
  applicationEncryption,
  databaseEncryption,
  expectedFailure,
}) {
  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `vera-packaged-encryption-${name}-`),
  );
  fs.chmodSync(userDataDir, 0o700);
  let child = null;
  let output = "";
  try {
    child = spawn(executablePath, [], {
      cwd: desktopDir,
      detached: true,
      env: {
        ...process.env,
        VERA_DESKTOP_PROFILE_DIR: userDataDir,
        VERA_ENABLE_LEGACY_ROUTES: "false",
        VERA_ENABLE_LEGACY_RUNTIME: "false",
        ALETHEIA_DEMO_SEED_ENABLED: "false",
        ALETHEIA_REQUIRE_ENCRYPTED_VOLUME: "false",
        ALETHEIA_APPLICATION_ENCRYPTION: applicationEncryption,
        ALETHEIA_MASTER_KEY_SOURCE: "env",
        ALETHEIA_MASTER_KEY_BASE64: crypto.randomBytes(32).toString("base64"),
        ALETHEIA_DATABASE_ENCRYPTION: databaseEncryption,
        ALETHEIA_DATABASE_KEY_SOURCE: "env",
        ALETHEIA_DATABASE_KEY_BASE64: crypto.randomBytes(32).toString("base64"),
        ALETHEIA_DESKTOP_FRONTEND_PORT: String(FRONTEND_PORT),
        ALETHEIA_DESKTOP_BACKEND_PORT: String(BACKEND_PORT),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const append = (chunk) => {
      output = appendLog(output, chunk);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    const exited = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        signalProcessGroup(child, "SIGTERM");
        reject(new Error(`${name} encryption downgrade did not fail closed.`));
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
    assert.deepEqual(exited, { code: 1, signal: null });
    assert.match(output, /\[vera-profile-bootstrap\] startup_failed:/);
    assert.match(output, expectedFailure);
    await assertPortsFree();
  } finally {
    if (child) await terminateApp(child).catch(() => undefined);
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

async function main() {
  if (process.platform !== "darwin") {
    throw new Error("This smoke test requires macOS.");
  }
  if (!fs.statSync(appPath, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Packaged app not found: ${appPath}`);
  }
  fs.accessSync(executablePath, fs.constants.X_OK);
  await assertPortsFree();
  await assertPackagedEncryptionDowngradeRejected({
    name: "application",
    applicationEncryption: "disabled",
    databaseEncryption: "sqlcipher_required",
    expectedFailure: /Packaged Vera requires application file encryption\./,
  });
  await assertPackagedEncryptionDowngradeRejected({
    name: "database",
    applicationEncryption: "required",
    databaseEncryption: "metadata_plaintext",
    expectedFailure: /Packaged Vera requires SQLCipher database encryption\./,
  });

  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "aletheia-packaged-app-smoke-"),
  );
  fs.chmodSync(userDataDir, 0o700);
  const processState = { exited: false, code: null, signal: null };
  let stdout = "";
  let stderr = "";
  let child = null;
  let failure = null;
  let isolatedProfile = null;
  let legacyHealth = null;
  let isolatedLogTail = "";

  try {
    child = spawn(executablePath, [], {
      cwd: desktopDir,
      detached: true,
      env: {
        ...process.env,
        VERA_DESKTOP_PROFILE_DIR: userDataDir,
        VERA_ENABLE_LEGACY_ROUTES: "false",
        VERA_ENABLE_LEGACY_RUNTIME: "false",
        ALETHEIA_DEMO_SEED_ENABLED: "false",
        ALETHEIA_REQUIRE_ENCRYPTED_VOLUME: "false",
        ALETHEIA_APPLICATION_ENCRYPTION: "required",
        ALETHEIA_MASTER_KEY_SOURCE: "env",
        ALETHEIA_MASTER_KEY_BASE64: crypto.randomBytes(32).toString("base64"),
        ALETHEIA_DATABASE_ENCRYPTION: "sqlcipher_required",
        ALETHEIA_DATABASE_KEY_SOURCE: "env",
        ALETHEIA_DATABASE_KEY_BASE64: crypto.randomBytes(32).toString("base64"),
        ALETHEIA_DESKTOP_FRONTEND_PORT: String(FRONTEND_PORT),
        ALETHEIA_DESKTOP_BACKEND_PORT: String(BACKEND_PORT),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => {
      stdout = appendLog(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendLog(stderr, chunk);
    });
    child.once("exit", (code, signal) => {
      processState.exited = true;
      processState.code = code;
      processState.signal = signal;
    });

    await waitForServices(child, processState);
    legacyHealth = await assertFormalLegacyDefaults();
    isolatedProfile = verifyIsolatedProfile(userDataDir);
  } catch (error) {
    failure = error;
  } finally {
    try {
      await terminateApp(child);
    } catch (error) {
      failure ||= error;
    }
    if (failure) isolatedLogTail = readIsolatedLogTail(userDataDir);
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }

  if (failure) {
    if (stdout.trim()) process.stderr.write(`\n[packaged-app stdout]\n${stdout}`);
    if (stderr.trim()) process.stderr.write(`\n[packaged-app stderr]\n${stderr}`);
    if (isolatedLogTail.trim()) {
      process.stderr.write(
        `\n[packaged-app isolated redacted log]\n${isolatedLogTail}`,
      );
    }
    throw failure;
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        suite: "aletheia-packaged-app-smoke-v1",
        appPath,
        checks: {
          isolatedUserData: true,
          applicationEncryptionDowngradeRejected: true,
          databaseEncryptionDowngradeRejected: true,
          demoSeedDisabled: true,
          legacyHealth,
          legacyRouteStatus: 404,
          frontendStatus: 200,
          backendHealthStatus: 200,
          isolatedProfile,
          applicationExited: true,
          frontendPortReleased: true,
          backendPortReleased: true,
        },
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
