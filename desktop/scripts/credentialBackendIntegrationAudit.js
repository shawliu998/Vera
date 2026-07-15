"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { app, MessageChannelMain, utilityProcess } = require("electron");

const LOOPBACK_HOST = "127.0.0.1";
const CREDENTIAL_PORT_BOOTSTRAP = "vera-credential-port-v1";
const CREDENTIAL_PORT_READY = "vera-credential-port-ready-v1";
const SUPPORTED_PROVIDERS = Object.freeze([
  "openai",
  "deepseek",
  "anthropic",
  "gemini",
  "openai_compatible",
]);
const MAX_CAPTURE_BYTES = 32 * 1024;
const utilityExitStates = new WeakMap();
const activeSensitiveValues = [];

function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, LOOPBACK_HOST, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Unable to reserve a loopback audit port."));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

function selectedEnvironment() {
  const environment = {};
  for (const key of ["HOME", "PATH", "TMPDIR", "LANG", "LC_ALL", "TZ"]) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  return environment;
}

function appendBounded(previous, chunk) {
  return `${previous}${chunk.toString()}`.slice(-MAX_CAPTURE_BYTES);
}

function captureOutput(child) {
  const output = { stdout: "", stderr: "", waitForDrain: null };
  child.stdout?.on("data", (chunk) => {
    output.stdout = appendBounded(output.stdout, chunk);
  });
  child.stderr?.on("data", (chunk) => {
    output.stderr = appendBounded(output.stderr, chunk);
  });
  const waitForDrain = (stream) =>
    new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        stream?.off("end", finish);
        stream?.off("close", finish);
        stream?.off("error", finish);
        resolve();
      };
      const timeout = setTimeout(finish, 250);
      if (!stream || stream.readableEnded || stream.destroyed) {
        setImmediate(finish);
        return;
      }
      stream.once("end", finish);
      stream.once("close", finish);
      stream.once("error", finish);
    });
  output.waitForDrain = () =>
    Promise.all([waitForDrain(child.stdout), waitForDrain(child.stderr)]);
  return output;
}

function redact(value, sensitiveValues) {
  let result = String(value);
  for (const sensitive of sensitiveValues) {
    if (sensitive) result = result.split(sensitive).join("[REDACTED]");
  }
  return result
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]")
    .replace(
      /((?:api[-_ ]?key|token|secret|password|key)["' ]*[:=]["' ]*)[^\s,"'}]+/gi,
      "$1[REDACTED]",
    );
}

function waitForSpawn(child, label, timeoutMs = 15_000) {
  const state = utilityExitStates.get(child);
  if (state?.exited) {
    return Promise.reject(
      new Error(`${label} exited before startup (code=${state.code}).`),
    );
  }
  if (child.pid) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.off("spawn", onSpawn);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolve();
    };
    const onSpawn = () => finish();
    const onExit = (code) =>
      finish(new Error(`${label} exited before startup (code=${code}).`));
    const timeout = setTimeout(() => {
      child.kill();
      finish(new Error(`${label} spawn timed out.`));
    }, timeoutMs);
    child.once("spawn", onSpawn);
    child.once("exit", onExit);
    // `pid` can become available between the initial check and listener setup.
    if (state?.exited) onExit(state.code);
    else if (child.pid) finish();
  });
}

function waitForCredentialPortReady(child, label, timeoutMs = 30_000) {
  const state = utilityExitStates.get(child);
  if (state?.exited) {
    return Promise.reject(
      new Error(`${label} exited before readiness (code=${state.code}).`),
    );
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.off("message", onMessage);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolve();
    };
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
        finish();
      }
    };
    const onExit = (code) =>
      finish(new Error(`${label} exited before readiness (code=${code}).`));
    const timeout = setTimeout(
      () => finish(new Error(`${label} readiness timed out.`)),
      timeoutMs,
    );
    child.on("message", onMessage);
    child.once("exit", onExit);
    // The process can exit between the initial state check and listener setup.
    if (state?.exited) onExit(state.code);
  });
}

function waitForExit(child, label, timeoutMs = 30_000) {
  const state = utilityExitStates.get(child);
  if (state?.exited) return Promise.resolve(state.code);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolve(code);
    };
    const onExit = (code) => finish(null, code);
    const timeout = setTimeout(() => {
      child.kill();
      finish(new Error(`${label} did not stop in time.`));
    }, timeoutMs);
    child.once("exit", onExit);
    // The process can exit between the initial state check and listener setup.
    if (state?.exited) onExit(state.code);
  });
}

async function stopUtility(child, label) {
  if (!child) return null;
  const state = utilityExitStates.get(child);
  if (state?.exited) return state.code;
  const exit = waitForExit(child, label);
  child.kill();
  return exit;
}

async function waitForHealth(baseUrl, child, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = 0;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      lastStatus = response.status;
      if (response.status === 200) {
        return { response, body: await response.json() };
      }
    } catch {
      lastStatus = 0;
    }
    if (utilityExitStates.get(child)?.exited) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Backend health check timed out (status=${lastStatus}).`);
}

async function assertLoopbackPortReleased(port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen({ host: LOOPBACK_HOST, port, exclusive: true }, () => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(5_000),
  });
  const text = await response.text();
  let value = null;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`Expected JSON from ${new URL(url).pathname}.`);
  }
  return { response, text, value };
}

function assertNoCredentialMaterial(value, sensitiveValues) {
  const serialized = JSON.stringify(value);
  for (const sensitive of sensitiveValues) {
    assert.equal(
      serialized.includes(sensitive),
      false,
      "A backend response disclosed process-private material.",
    );
  }
  const seen = new Set();
  const visit = (candidate) => {
    if (!candidate || typeof candidate !== "object" || seen.has(candidate)) {
      return;
    }
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    for (const [key, nested] of Object.entries(candidate)) {
      const normalized = key
        .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
        .replace(/[-\s]+/g, "_")
        .toLowerCase();
      assert.equal(
        normalized === "secret",
        false,
        "Response exposed a secret field.",
      );
      assert.equal(
        normalized.endsWith("_secret"),
        false,
        "Response exposed a secret field.",
      );
      assert.equal(
        normalized === "api_key",
        false,
        "Response exposed an API key field.",
      );
      assert.equal(
        normalized.endsWith("_api_key"),
        false,
        "Response exposed an API key field.",
      );
      assert.equal(
        normalized === "credential_ref" ||
          normalized.endsWith("_credential_ref") ||
          normalized === "credential_reference" ||
          normalized.endsWith("_credential_reference"),
        false,
        "Response exposed a credential reference field.",
      );
      visit(nested);
    }
  };
  visit(value);
}

function backendEnvironment({
  dataDir,
  port,
  token,
  applicationKey,
  databaseKey,
  downloadSigningSecret,
}) {
  return {
    ...selectedEnvironment(),
    NODE_ENV: "production",
    PORT: String(port),
    ALETHEIA_BACKEND_HOST: LOOPBACK_HOST,
    FRONTEND_URL: `http://${LOOPBACK_HOST}:${port}`,
    DOWNLOAD_SIGNING_SECRET: downloadSigningSecret,
    ALETHEIA_AUTH_MODE: "private_token",
    ALETHEIA_PRIVATE_AUTH_TOKEN: token,
    ALETHEIA_DATA_DIR: dataDir,
    ALETHEIA_LOCAL_USER_ID: "desktop-local-user",
    ALETHEIA_LOCAL_USER_EMAIL: "desktop@vera.local",
    ALETHEIA_MULTI_PRINCIPAL_ENABLED: "false",
    ALETHEIA_DEPLOYMENT_PRESET: "standard",
    ALETHEIA_REQUIRE_ENCRYPTED_VOLUME: "false",
    ALETHEIA_APPLICATION_ENCRYPTION: "required",
    ALETHEIA_MASTER_KEY_SOURCE: "env",
    ALETHEIA_MASTER_KEY_BASE64: applicationKey,
    ALETHEIA_DATABASE_ENCRYPTION: "sqlcipher_required",
    ALETHEIA_DATABASE_KEY_SOURCE: "env",
    ALETHEIA_DATABASE_KEY_BASE64: databaseKey,
    ALETHEIA_RETRIEVAL_MODE: "keyword",
    ALETHEIA_SEMANTIC_INDEX_ENABLED: "false",
    ALETHEIA_SEMANTIC_INDEX_DRIVER: "disabled",
    ALETHEIA_SEMANTIC_INDEX_DIR: path.join(dataDir, "index", "semantic-local"),
    ALETHEIA_DEMO_SEED_ENABLED: "false",
    ALETHEIA_ENABLE_DEMO_SEED: "false",
    ALETHEIA_AUDIT_ANCHOR_ENABLED: "false",
    TRUST_PROXY_HOPS: "0",
    VERA_DESKTOP_CREDENTIAL_PORT_REQUIRED: "true",
  };
}

function forkUtility(modulePath, cwd, env, serviceName) {
  const child = utilityProcess.fork(modulePath, [], {
    cwd,
    env,
    serviceName,
    stdio: "pipe",
  });
  const state = { exited: false, code: null };
  utilityExitStates.set(child, state);
  child.once("exit", (code) => {
    state.exited = true;
    state.code = code;
  });
  return child;
}

async function assertRequiredPortFailsClosed(
  backendEntry,
  backendDir,
  env,
  sensitiveValues,
) {
  const child = forkUtility(
    backendEntry,
    backendDir,
    env,
    "Vera credential port fail-closed audit",
  );
  const output = captureOutput(child);
  const credentialPortReady = waitForCredentialPortReady(
    child,
    "fail-closed backend",
    60_000,
  );
  let exited = false;
  try {
    await Promise.all([
      waitForSpawn(child, "fail-closed backend"),
      credentialPortReady,
    ]);
    // The readiness signal is emitted only after the product's bounded
    // credential-port timer is armed. Start the audit timeout here so cold
    // Electron/module loading cannot consume the product's shutdown budget.
    // Deliberately do not transfer a MessagePort: the backend must fail closed.
    const failClosedWaitStartedAt = Date.now();
    const code = await waitForExit(child, "fail-closed backend", 30_000);
    const failClosedWaitMs = Date.now() - failClosedWaitStartedAt;
    exited = true;
    await output.waitForDrain();
    assert.equal(
      code,
      1,
      "Backend accepted startup without the required credential port.",
    );
    assert.ok(
      failClosedWaitMs >= 10_000,
      "Backend exited before exercising the bounded credential-port timeout.",
    );
    let unexpectedlyListening = false;
    try {
      const response = await fetch(
        `http://${LOOPBACK_HOST}:${env.PORT}/health`,
        {
          signal: AbortSignal.timeout(500),
        },
      );
      unexpectedlyListening = response.status > 0;
    } catch {
      // Connection refusal is the required fail-closed result.
    }
    assert.equal(
      unexpectedlyListening,
      false,
      "Backend served HTTP without the required credential port.",
    );
    assert.equal(
      sensitiveValues.some(
        (sensitive) =>
          output.stdout.includes(sensitive) ||
          output.stderr.includes(sensitive),
      ),
      false,
      "Fail-closed output disclosed process-private material.",
    );
    return code;
  } finally {
    if (!exited) {
      await stopUtility(child, "fail-closed backend cleanup").catch(() => null);
    }
  }
}

async function runAudit() {
  if (process.platform !== "darwin") {
    throw new Error(
      "The credential-to-backend integration audit requires macOS Keychain.",
    );
  }

  const repositoryRoot = path.resolve(__dirname, "..", "..");
  const desktopRoot = path.join(repositoryRoot, "desktop");
  const backendRoot = path.join(repositoryRoot, "backend");
  const workerEntry = path.join(desktopRoot, "credentialWorker.js");
  const backendEntry = path.join(backendRoot, "dist", "index.js");
  assert.equal(
    fs.existsSync(workerEntry),
    true,
    "Credential worker is missing.",
  );
  assert.equal(
    fs.existsSync(backendEntry),
    true,
    "Build backend/dist before running this audit.",
  );

  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "vera-credential-backend-integration-"),
  );
  fs.chmodSync(temporaryRoot, 0o700);
  const failClosedDataDir = path.join(temporaryRoot, "fail-closed-workspace");
  const workspaceDataDir = path.join(temporaryRoot, "workspace");
  fs.mkdirSync(failClosedDataDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(workspaceDataDir, { recursive: true, mode: 0o700 });

  const failClosedPort = await reserveLoopbackPort();
  const backendPort = await reserveLoopbackPort();
  const bearerToken = crypto.randomBytes(48).toString("base64url");
  const applicationKey = crypto.randomBytes(32).toString("base64");
  const databaseKey = crypto.randomBytes(32).toString("base64");
  const downloadSigningSecret = crypto.randomBytes(32).toString("base64url");
  const sensitiveValues = [
    bearerToken,
    applicationKey,
    databaseKey,
    downloadSigningSecret,
  ];
  activeSensitiveValues.push(...sensitiveValues);
  const failClosedEnv = backendEnvironment({
    dataDir: failClosedDataDir,
    port: failClosedPort,
    token: bearerToken,
    applicationKey,
    databaseKey,
    downloadSigningSecret,
  });
  const backendEnv = backendEnvironment({
    dataDir: workspaceDataDir,
    port: backendPort,
    token: bearerToken,
    applicationKey,
    databaseKey,
    downloadSigningSecret,
  });

  let worker = null;
  let backend = null;
  let workerOutput = null;
  let backendOutput = null;
  let positiveFailure = null;
  let backendStopped = false;
  let workerStopped = false;
  let portReleased = false;
  let failClosedExitCode = null;
  let backendExitCode = null;
  let workerExitCode = null;

  try {
    failClosedExitCode = await assertRequiredPortFailsClosed(
      backendEntry,
      backendRoot,
      failClosedEnv,
      sensitiveValues,
    );
    await assertLoopbackPortReleased(failClosedPort);

    worker = forkUtility(
      workerEntry,
      desktopRoot,
      selectedEnvironment(),
      "Vera credential worker integration audit",
    );
    const workerReady = waitForCredentialPortReady(worker, "credential worker");
    backend = forkUtility(
      backendEntry,
      backendRoot,
      backendEnv,
      "Vera credential backend integration audit",
    );
    const backendReady = waitForCredentialPortReady(backend, "backend");
    workerOutput = captureOutput(worker);
    backendOutput = captureOutput(backend);
    await Promise.all([
      waitForSpawn(worker, "credential worker"),
      waitForSpawn(backend, "backend"),
      workerReady,
      backendReady,
    ]);

    const { port1, port2 } = new MessageChannelMain();
    try {
      worker.postMessage({ type: CREDENTIAL_PORT_BOOTSTRAP }, [port1]);
      backend.postMessage({ type: CREDENTIAL_PORT_BOOTSTRAP }, [port2]);
    } catch (error) {
      port1.close();
      port2.close();
      throw error;
    }

    const baseUrl = `http://${LOOPBACK_HOST}:${backendPort}`;
    const health = await waitForHealth(baseUrl, backend);
    assert.equal(health.response.status, 200);
    assert.equal(health.body?.ok, true);
    assert.equal(health.body?.vera?.workspace?.started, true);
    assertNoCredentialMaterial(health.body, sensitiveValues);

    const unauthenticated = await fetchJson(
      `${baseUrl}/api/v1/settings/status`,
    );
    assert.equal(unauthenticated.response.status, 401);
    assert.equal(unauthenticated.value?.code, "UNAUTHORIZED");
    assertNoCredentialMaterial(unauthenticated.value, sensitiveValues);

    const authenticated = await fetchJson(`${baseUrl}/api/v1/settings/status`, {
      headers: { Authorization: `Bearer ${bearerToken}` },
    });
    assert.equal(authenticated.response.status, 200);
    const capabilities = authenticated.value?.capabilities;
    assert.equal(capabilities?.settings_available, true);
    assert.equal(capabilities?.runtime_wired, true);
    assert.equal(capabilities?.credential_write_enabled, true);
    assert.equal(capabilities?.secret_readback_supported, false);
    assert.deepEqual(capabilities?.supported_providers, SUPPORTED_PROVIDERS);
    assert.deepEqual(authenticated.value?.models, []);
    assertNoCredentialMaterial(authenticated.value, sensitiveValues);

    backendExitCode = await stopUtility(backend, "backend");
    assert.equal(
      backendExitCode,
      0,
      "Backend did not complete graceful shutdown with exit code 0.",
    );
    backendStopped = true;
    await assertLoopbackPortReleased(backendPort);
    portReleased = true;
    workerExitCode = await stopUtility(worker, "credential worker");
    workerStopped = true;
    await Promise.all([
      backendOutput.waitForDrain(),
      workerOutput.waitForDrain(),
    ]);
    assert.equal(
      sensitiveValues.some(
        (sensitive) =>
          backendOutput.stdout.includes(sensitive) ||
          backendOutput.stderr.includes(sensitive) ||
          workerOutput.stdout.includes(sensitive) ||
          workerOutput.stderr.includes(sensitive),
      ),
      false,
      "A utility process logged process-private material.",
    );
  } catch (error) {
    positiveFailure = error;
    throw error;
  } finally {
    if (backend && !backendStopped) {
      await stopUtility(backend, "backend cleanup").catch(() => null);
    }
    if (worker && !workerStopped) {
      await stopUtility(worker, "credential worker cleanup").catch(() => null);
    }
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    assert.equal(
      fs.existsSync(temporaryRoot),
      false,
      "Temporary credential integration workspace was not removed.",
    );
    if (positiveFailure) {
      const diagnostics = redact(
        [backendOutput?.stderr, workerOutput?.stderr]
          .filter(Boolean)
          .join("\n"),
        sensitiveValues,
      ).trim();
      if (diagnostics) process.stderr.write(`${diagnostics}\n`);
    }
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        suite: "vera-electron-credential-backend-integration-v1",
        platform: process.platform,
        electron: process.versions.electron,
        encryption: {
          application_files: "aes-256-gcm-required",
          database: "sqlcipher-required",
        },
        providers: SUPPORTED_PROVIDERS,
        checks: [
          "required credential port fails closed when absent",
          "explicit retrying readiness handshake before private MessagePort transfer",
          "real Electron utility worker and backend private MessagePort bridge",
          "real macOS Keychain availability probe without credential writes",
          "loopback health and private bearer authentication",
          "Settings runtime and credential writes are genuinely available",
          "no secret or credential-reference response material",
          "ordered backend-before-worker shutdown and loopback port release",
          "temporary encrypted workspace cleanup",
        ],
        shutdown: {
          required_port_failure_exit_code: failClosedExitCode,
          backend_exit_code: backendExitCode,
          worker_exit_code: workerExitCode,
          backend_first: backendStopped,
          worker_second: workerStopped,
          port_released: portReleased,
          temporary_workspace_removed: true,
        },
      },
      null,
      2,
    )}\n`,
  );
}

void app
  .whenReady()
  .then(runAudit)
  .then(() => app.exit(0))
  .catch((error) => {
    const message = redact(
      error instanceof Error
        ? error.message
        : "Credential backend integration audit failed.",
      activeSensitiveValues,
    );
    process.stderr.write(`${message}\n`);
    app.exit(1);
  });
