"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { app, MessageChannelMain, utilityProcess } = require("electron");

const CREDENTIAL_RPC_SCHEMA = "vera-credential-rpc-v1";
const CREDENTIAL_PORT_BOOTSTRAP = "vera-credential-port-v1";
const CREDENTIAL_PORT_READY = "vera-credential-port-ready-v1";
const REQUEST_ID = "utility_audit_000000000001";

function selectedEnvironment() {
  const environment = {};
  for (const key of ["HOME", "PATH", "TMPDIR", "LANG", "LC_ALL", "TZ"]) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  return environment;
}

function waitForSpawn(child) {
  if (child.pid) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("credential worker spawn timed out"));
    }, 10_000);
    const finish = (error) => {
      clearTimeout(timeout);
      child.off("spawn", onSpawn);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolve();
    };
    const onSpawn = () => finish();
    const onExit = (code) =>
      finish(new Error(`credential worker exited before spawn: ${code}`));
    child.once("spawn", onSpawn);
    child.once("exit", onExit);
    if (child.pid) finish();
  });
}

function waitForCredentialPortReady(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.off("message", onMessage);
      reject(new Error("credential worker readiness timed out"));
    }, 10_000);
    const onMessage = (event) => {
      const value =
        event && typeof event === "object" && "data" in event
          ? event.data
          : event;
      if (
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.keys(value).length === 1 &&
        value.type === CREDENTIAL_PORT_READY
      ) {
        clearTimeout(timeout);
        child.off("message", onMessage);
        resolve();
      }
    };
    child.on("message", onMessage);
  });
}

function ping(port) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      port.close();
      reject(new Error("credential worker ping timed out"));
    }, 10_000);
    port.once("message", (event) => {
      clearTimeout(timeout);
      resolve(event.data);
    });
    port.start();
    port.postMessage({
      schema: CREDENTIAL_RPC_SCHEMA,
      id: REQUEST_ID,
      operation: "ping",
      payload: {},
    });
  });
}

async function main() {
  await app.whenReady();
  const workerEntry =
    process.env.VERA_CREDENTIAL_WORKER_AUDIT_ENTRY ??
    path.join(__dirname, "..", "credentialWorker.js");
  if (!path.isAbsolute(workerEntry) || !fs.existsSync(workerEntry)) {
    throw new Error("credential worker audit entry is unavailable");
  }
  const worker = utilityProcess.fork(
    workerEntry,
    [],
    {
      cwd: path.join(__dirname, ".."),
      env: selectedEnvironment(),
      serviceName: "Vera credential worker audit",
      stdio: "pipe",
    },
  );
  let exitedBeforeBootstrap = false;
  worker.once("exit", () => {
    exitedBeforeBootstrap = true;
  });
  try {
    await Promise.all([waitForSpawn(worker), waitForCredentialPortReady(worker)]);
    await new Promise((resolve) => setTimeout(resolve, 750));
    assert.equal(
      exitedBeforeBootstrap,
      false,
      "credential worker exited before delayed bootstrap",
    );
    const { port1, port2 } = new MessageChannelMain();
    worker.postMessage({ type: CREDENTIAL_PORT_BOOTSTRAP }, [port1]);
    const response = await ping(port2);
    assert.deepEqual(response, {
      schema: CREDENTIAL_RPC_SCHEMA,
      id: REQUEST_ID,
      ok: true,
      result: {
        available: process.platform === "darwin",
        secretReadbackToRenderer: false,
      },
    });
    port2.close();
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          suite: "vera-credential-worker-electron-utility-v1",
          platform: process.platform,
          available: response.result.available,
          checks: [
            "real Electron utility process spawn",
            "explicit readiness handshake before MessagePort transfer",
            "worker remains alive while bootstrap is deliberately delayed",
            "real transferred MessagePortMain bootstrap",
            "strict real-Keychain ping response and renderer readback denial",
          ],
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    worker.kill();
    app.quit();
  }
}

void main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "credential utility audit failed"}\n`,
  );
  app.exit(1);
});
