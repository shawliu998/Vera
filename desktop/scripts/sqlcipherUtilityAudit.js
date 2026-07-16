const { app, utilityProcess } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const AUTH_TOKEN =
  "vera-sqlcipher-runtime-audit-token-00000000000000000000000000000000";

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Unable to allocate a loopback test port."));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

async function waitForJson(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${AUTH_TOKEN}`,
        },
      });
      if (response.ok) return response.json();
      lastError = new Error(`${url} returned HTTP ${response.status}.`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError || new Error(`${url} did not become ready.`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const root = path.resolve(__dirname, "..", "..");
  const backendDir = path.join(root, "backend");
  const backendEntry = path.join(backendDir, "dist", "index.js");
  assert(fs.existsSync(backendEntry), "Build backend/dist before this audit.");
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "aletheia-electron-sqlcipher-"),
  );
  const port = await freePort();
  const applicationKey = crypto.randomBytes(32).toString("base64");
  const key = crypto.randomBytes(32).toString("base64");
  const child = utilityProcess.fork(backendEntry, [], {
    cwd: backendDir,
    env: {
      HOME: process.env.HOME || "",
      PATH: process.env.PATH || "",
      TMPDIR: process.env.TMPDIR || os.tmpdir(),
      NODE_ENV: "production",
      // This audit intentionally exercises the retained Legacy security-policy
      // route. It does not need the durable Legacy runtime.
      VERA_ENABLE_LEGACY_ROUTES: "true",
      VERA_ENABLE_LEGACY_RUNTIME: "false",
      PORT: String(port),
      ALETHEIA_BACKEND_HOST: "127.0.0.1",
      FRONTEND_URL: `http://127.0.0.1:${port + 1}`,
      DOWNLOAD_SIGNING_SECRET:
        "electron-sqlcipher-audit-download-secret-0123456789abcdef",
      ALETHEIA_AUTH_MODE: "private_token",
      ALETHEIA_PRIVATE_AUTH_TOKEN: AUTH_TOKEN,
      ALETHEIA_LOCAL_USER_ID: "electron-sqlcipher-auditor",
      ALETHEIA_LOCAL_USER_EMAIL: "electron-auditor@vera.local",
      ALETHEIA_DATA_DIR: dataDir,
      ALETHEIA_DEMO_SEED_ENABLED: "false",
      ALETHEIA_APPLICATION_ENCRYPTION: "required",
      ALETHEIA_MASTER_KEY_SOURCE: "env",
      ALETHEIA_MASTER_KEY_BASE64: applicationKey,
      ALETHEIA_DATABASE_ENCRYPTION: "sqlcipher_required",
      ALETHEIA_DATABASE_KEY_SOURCE: "env",
      ALETHEIA_DATABASE_KEY_BASE64: key,
      ALETHEIA_SEMANTIC_INDEX_ENABLED: "false",
      ALETHEIA_SEMANTIC_INDEX_DRIVER: "disabled",
    },
    serviceName: "Vera SQLCipher runtime audit",
    stdio: "pipe",
  });
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  try {
    await waitForJson(`http://127.0.0.1:${port}/health`, 30_000);
    const policy = await waitForJson(
      `http://127.0.0.1:${port}/aletheia/security-policy`,
      30_000,
    );
    const status = policy?.encryptionAtRest?.application?.database_driver;
    assert(
      status?.driver === "signal-sqlcipher",
      "Unexpected database driver.",
    );
    assert(status?.encrypted === true, "Database was not reported encrypted.");
    assert(
      typeof status?.cipher_version === "string" && status.cipher_version,
      "SQLCipher did not report a cipher version.",
    );
    const databasePath = path.join(dataDir, "aletheia.db");
    const header = fs.readFileSync(databasePath).subarray(0, 16);
    assert(
      header.toString("utf8") !== "SQLite format 3\0",
      "Electron utility runtime created a plaintext SQLite header.",
    );
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          suite: "vera-electron-sqlcipher-runtime-v1",
          electron: process.versions.electron,
          node: process.versions.node,
          modules: process.versions.modules,
          napi: process.versions.napi,
          platform: process.platform,
          arch: process.arch,
          driver: status.driver,
          cipher_version: status.cipher_version,
          cipher_provider: status.cipher_provider,
          plaintext_header: false,
        },
        null,
        2,
      )}\n`,
    );
  } catch (error) {
    if (stderr.trim()) process.stderr.write(stderr);
    throw error;
  } finally {
    child.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

app
  .whenReady()
  .then(main)
  .then(() => app.exit(0))
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
