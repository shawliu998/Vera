#!/usr/bin/env node
"use strict";

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
const FRONTEND_URL = `http://${HOST}:${FRONTEND_PORT}/projects`;
const BACKEND_URL = `http://${HOST}:${BACKEND_PORT}/health`;
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

async function main() {
  if (process.platform !== "darwin") {
    throw new Error("This smoke test requires macOS.");
  }
  if (!fs.statSync(appPath, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Packaged app not found: ${appPath}`);
  }
  fs.accessSync(executablePath, fs.constants.X_OK);
  await assertPortsFree();

  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "aletheia-packaged-app-smoke-"),
  );
  fs.chmodSync(userDataDir, 0o700);
  const processState = { exited: false, code: null, signal: null };
  let stdout = "";
  let stderr = "";
  let child = null;
  let failure = null;

  try {
    child = spawn(executablePath, [`--user-data-dir=${userDataDir}`], {
      cwd: desktopDir,
      detached: true,
      env: {
        ...process.env,
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
  } catch (error) {
    failure = error;
  } finally {
    try {
      await terminateApp(child);
    } catch (error) {
      failure ||= error;
    }
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }

  if (failure) {
    if (stdout.trim()) process.stderr.write(`\n[packaged-app stdout]\n${stdout}`);
    if (stderr.trim()) process.stderr.write(`\n[packaged-app stderr]\n${stderr}`);
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
          demoSeedDisabled: true,
          frontendStatus: 200,
          backendHealthStatus: 200,
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
