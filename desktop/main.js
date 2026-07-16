const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  MessageChannelMain,
  Menu,
  Notification,
  session,
  shell,
  utilityProcess,
} = require("electron");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

function resourceRoot() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "aletheia")
    : path.resolve(__dirname, "..");
}

function desktopUtilityModulePath(filename) {
  if (!app.isPackaged) return path.join(__dirname, filename);
  return path.join(resourceRoot(), "desktop", filename);
}

const { ensureMacOsKeychainKey } = require(
  desktopUtilityModulePath("macOsKeychain.js"),
);
const {
  AUDIT_ANCHOR_ENV_KEYS,
  disabledAuditAnchorConfiguration,
  hasExternallyManagedAnchorEnvironment,
  localAuditAnchorEnvironment,
  provisionAuditAnchorConfiguration,
  publicAuditAnchorConfiguration,
  readAuditAnchorConfig,
  restoreAuditAnchorConfigAtomically,
  snapshotAuditAnchorConfig,
  writeAuditAnchorConfigAtomically,
} = require("./auditAnchorConfig");
const {
  MAX_ORIGINAL_BYTES,
  MIME_EXTENSIONS,
  safeOriginalFilename,
  validateOriginalDocumentBytes,
  writeOwnerOnlyFileAtomically,
} = require("./originalDocumentSave");
const { buildRedactedDiagnosticBundle } = require("./diagnosticBundle");
const {
  createRotatingDesktopLogger,
  redactText,
} = require("./desktopLogger");
const { resolveDesktopEncryptionPolicy } = require("./encryptionPolicy");

const PRODUCT_NAME = "Vera";
const LEGACY_USER_DATA_DIRECTORY_NAME = "aletheia-desktop";

app.setName(PRODUCT_NAME);
// Keep existing local cases, encryption keys, and runtime state reachable after
// the packaged display name changes. Explicit test/dev overrides stay isolated.
const explicitUserDataDirectory = (
  process.env.VERA_DESKTOP_PROFILE_DIR ?? ""
).trim();
if (
  explicitUserDataDirectory &&
  !path.isAbsolute(explicitUserDataDirectory)
) {
  throw new Error("VERA_DESKTOP_PROFILE_DIR requires an absolute directory path.");
}
const desktopUserDataDirectory = explicitUserDataDirectory
  ? path.resolve(explicitUserDataDirectory)
  : path.join(app.getPath("appData"), LEGACY_USER_DATA_DIRECTORY_NAME);
fs.mkdirSync(desktopUserDataDirectory, { recursive: true, mode: 0o700 });
const desktopUserDataInfo = fs.lstatSync(desktopUserDataDirectory);
if (
  desktopUserDataInfo.isSymbolicLink() ||
  !desktopUserDataInfo.isDirectory()
) {
  throw new Error("Vera user data must be a real directory.");
}
// Bind every local-state path explicitly before requestSingleInstanceLock() so
// packaged audits, alternate profiles, and their singleton locks are isolated.
app.setPath("userData", desktopUserDataDirectory);
app.setPath("sessionData", desktopUserDataDirectory);
if (explicitUserDataDirectory) {
  const isolatedLogDirectory = path.join(desktopUserDataDirectory, "logs");
  fs.mkdirSync(isolatedLogDirectory, { recursive: true, mode: 0o700 });
  app.setAppLogsPath(isolatedLogDirectory);
}

const BACKEND_PORT = Number(process.env.ALETHEIA_DESKTOP_BACKEND_PORT ?? 43761);
const FRONTEND_PORT = Number(
  process.env.ALETHEIA_DESKTOP_FRONTEND_PORT ?? 43760,
);
const HOST = "127.0.0.1";
const BACKEND_URL = `http://${HOST}:${BACKEND_PORT}`;
const FRONTEND_URL = `http://${HOST}:${FRONTEND_PORT}`;
const WORKSPACE_PATH = "/assistant";
const DESKTOP_SESSION_TOKEN = crypto.randomBytes(32).toString("base64url");
const DESKTOP_DOWNLOAD_SIGNING_SECRET = crypto.randomBytes(32).toString("hex");
const PENDING_RESTORE_SCHEMA = "aletheia-pending-restore-v1";
const CREDENTIAL_PORT_BOOTSTRAP = "vera-credential-port-v1";
const CREDENTIAL_PORT_READY = "vera-credential-port-ready-v1";
const APPLICATION_KEYCHAIN_SERVICE =
  "com.aletheia.desktop.application-encryption";
const APPLICATION_KEYCHAIN_ACCOUNT = "aletheia-local-master-key";
const DATABASE_KEYCHAIN_SERVICE = "com.aletheia.desktop.database-encryption";
const DATABASE_KEYCHAIN_ACCOUNT = "aletheia-local-database-key";
let verifiedBackupSelection = null;
const singleInstanceLockAcquired = app.requestSingleInstanceLock();
if (!singleInstanceLockAcquired) {
  if (explicitUserDataDirectory) {
    process.stderr.write(
      "[vera-profile-bootstrap] isolated profile singleton lock unavailable\n",
    );
  }
  app.exit(0);
}

// Child processes receive an explicit local-runtime environment. In
// particular, they must not inherit credentials, proxy configuration,
// NODE_OPTIONS, or other ambient variables from the shell that launched the
// desktop app.
const CHILD_RUNTIME_ENV_KEYS = [
  "HOME",
  "PATH",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
];

const BACKEND_LOCAL_CONFIG_ENV_KEYS = [
  "ALETHEIA_AUDIT_HMAC_SECRET",
  "ALETHEIA_AUDIT_ANCHOR_ENABLED",
  "ALETHEIA_AUDIT_ANCHOR_HIGH_ASSURANCE",
  "ALETHEIA_AUDIT_ANCHOR_DIR",
  "ALETHEIA_AUDIT_ANCHOR_PRIVATE_KEY_FILE",
  "ALETHEIA_AUDIT_ANCHOR_PUBLIC_KEY_FILE",
  "ALETHEIA_AUDIT_ANCHOR_INTERVAL_MS",
  "ALETHEIA_AUDIT_ANCHOR_EXPECTED_HEAD_HASH",
  "ALETHEIA_RETENTION_DAYS",
  "ALETHEIA_EXTERNAL_SOURCE_ALLOWED_DOMAINS",
  // Authorized legal-source connection metadata only. Credentials remain in
  // the backend's locally encrypted credential store and are never inherited
  // from the desktop host environment.
  "VERA_PKULAW_API_ENDPOINT",
  "VERA_PKULAW_API_ALLOWED_HOSTS",
  "VERA_PKULAW_API_CREDENTIAL_REF",
  "VERA_YUANDIAN_API_ENDPOINT",
  "VERA_YUANDIAN_API_ALLOWED_HOSTS",
  "VERA_YUANDIAN_API_CREDENTIAL_REF",
  "VERA_WOLTERS_API_ENDPOINT",
  "VERA_WOLTERS_API_ALLOWED_HOSTS",
  "VERA_WOLTERS_API_CREDENTIAL_REF",
  "VERA_OFFICIAL_LEGAL_API_ENDPOINT",
  "VERA_OFFICIAL_LEGAL_API_ALLOWED_HOSTS",
  "ALETHEIA_JSON_BODY_LIMIT",
  "ALETHEIA_UPLOAD_TEMP_TTL_MS",
  "ALETHEIA_MALWARE_SCAN_MODE",
  "ALETHEIA_MALWARE_SCAN_TIMEOUT_MS",
  "ALETHEIA_CLAMAV_PATH",
  "ALETHEIA_CDR_MODE",
  "ALETHEIA_CDR_EXECUTABLE_ALLOWLIST",
  "ALETHEIA_CDR_LIBREOFFICE_PATH",
  "ALETHEIA_CDR_TIMEOUT_MS",
  "ALETHEIA_CDR_MAX_OUTPUT_BYTES",
  "ALETHEIA_LOCAL_MODELS_JSON",
  "ALETHEIA_LOCAL_MODEL_ID",
  "ALETHEIA_LOCAL_MODEL_NAME",
  "ALETHEIA_LOCAL_MODEL_ADAPTER",
  "ALETHEIA_LOCAL_MODEL_ENDPOINT",
  "ALETHEIA_LOCAL_MODEL_CONTEXT_TOKENS",
  "ALETHEIA_LOCAL_MODEL_MAX_OUTPUT_TOKENS",
  "ALETHEIA_LOCAL_MODEL_CONCURRENCY",
  "ALETHEIA_LOCAL_MODEL_QUEUE_LIMIT",
  "ALETHEIA_LOCAL_MODEL_REQUEST_TIMEOUT_MS",
  "ALETHEIA_LOCAL_MODEL_AUTOSTART",
  "ALETHEIA_LOCAL_MODEL_EXECUTABLE_ALLOWLIST",
  "ALETHEIA_LOCAL_MODEL_ENV_ALLOWLIST",
  // Test/development only. The backend still restricts this to exact
  // loopback hosts and keeps public HTTPS as the default Generic policy.
  "ALETHEIA_MODEL_PROVIDER_ALLOW_LOOPBACK_HTTP",
  "ALETHEIA_VOICE_PYTHON_PATH",
  "ALETHEIA_VOICE_STT_MODEL_PATH",
  "ALETHEIA_VOICE_TTS_MODEL_PATH",
  "ALETHEIA_VOICE_MAX_AUDIO_BYTES",
  "ALETHEIA_VOICE_TIMEOUT_MS",
  "ALETHEIA_VOICE_TEMP_DIR",
  "ALETHEIA_OLLAMA_ENDPOINT",
  "ALETHEIA_OLLAMA_MODEL",
  "ALETHEIA_DURABLE_WORKER_POLL_MS",
  "ALETHEIA_DURABLE_WORKER_HEARTBEAT_MS",
  "RATE_LIMIT_GENERAL_WINDOW_MINUTES",
  "RATE_LIMIT_GENERAL_MAX",
  "RATE_LIMIT_UPLOAD_WINDOW_HOURS",
  "RATE_LIMIT_UPLOAD_MAX",
  "RATE_LIMIT_EXTERNAL_SOURCE_WINDOW_MINUTES",
  "RATE_LIMIT_EXTERNAL_SOURCE_MAX",
];

let mainWindow = null;
const children = new Set();
const serviceChildren = new Map();
const credentialPortReadyChildren = new WeakSet();
const SERVICE_STOP_ORDER = ["frontend", "backend", "credential worker"];
let restartingServices = null;
let changingAuditAnchor = null;
let servicesReady = false;
let serviceShutdownExpected = false;
let serviceStopPromise = null;
let handlingUnexpectedServiceFailure = null;
let quitAfterServiceStop = false;
let quitShutdownStarted = false;
const activeNotifications = new Map();
let desktopLogger = null;
let activeEncryptionPolicy = null;

function desktopLog(level, component, event, detail = null) {
  try {
    desktopLogger ??= createRotatingDesktopLogger({
      directory: path.join(app.getPath("logs"), "vera"),
    });
    const record = desktopLogger.write(level, component, event, detail);
    if (!app.isPackaged) {
      const output = JSON.stringify(record);
      if (level === "error") console.error(output);
      else if (level === "warn") console.warn(output);
      else console.log(output);
    }
  } catch {
    if (!app.isPackaged) console.error("[vera-logger] unavailable");
  }
}

function exitAfterIsolatedProfileFailure(error, event) {
  const detail =
    redactText(error instanceof Error ? error.message : String(error)) ||
    "isolated profile bootstrap failed";
  desktopLog("error", "desktop", event, { error });
  process.stderr.write(`[vera-profile-bootstrap] ${event}: ${detail}\n`);
  app.exit(1);
}

function selectedProcessEnvironment(keys) {
  return keys.reduce((environment, key) => {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
    return environment;
  }, {});
}

function legacyFeatureEnvironment() {
  return {
    // Legacy surfaces are retained for explicit migration and compatibility
    // work, but the formal desktop runtime must never activate them through an
    // ambient or loosely parsed parent value.
    VERA_ENABLE_LEGACY_ROUTES:
      process.env.VERA_ENABLE_LEGACY_ROUTES === "true" ? "true" : "false",
    VERA_ENABLE_LEGACY_RUNTIME:
      process.env.VERA_ENABLE_LEGACY_RUNTIME === "true" ? "true" : "false",
  };
}

function localDataDir() {
  return path.join(app.getPath("userData"), "aletheia-data");
}

function pendingRestorePath() {
  return path.join(app.getPath("userData"), "pending-restore.json");
}

function canonicalLocalDataTarget() {
  const target = path.resolve(localDataDir());
  // The target can legitimately be absent after an interrupted rename. Resolve
  // only its existing parent so macOS /var -> /private/var aliases compare
  // exactly without following a malicious terminal target symlink.
  return path.join(fs.realpathSync(path.dirname(target)), path.basename(target));
}

function syncDirectory(directory) {
  const descriptor = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function clearPendingRestoreRecord() {
  const recordPath = pendingRestorePath();
  fs.rmSync(recordPath, { force: true });
  syncDirectory(path.dirname(recordPath));
}

function reconcilePendingRestore() {
  const recordPath = pendingRestorePath();
  if (!fs.existsSync(recordPath)) return false;
  const info = fs.lstatSync(recordPath);
  if (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o077) !== 0) {
    throw new Error(
      "The pending restore record is unsafe; startup is blocked.",
    );
  }
  let record;
  try {
    record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  } catch {
    throw new Error(
      "The pending restore record is invalid; startup is blocked.",
    );
  }
  const target = path.resolve(String(record?.target || ""));
  const rollback = path.resolve(String(record?.rollback || ""));
  const expectedTarget = canonicalLocalDataTarget();
  const parent = path.dirname(expectedTarget);
  if (
    record?.schema !== PENDING_RESTORE_SCHEMA ||
    target !== expectedTarget ||
    path.dirname(rollback) !== parent ||
    !path.basename(rollback).startsWith(".aletheia-restore-rollback-")
  ) {
    throw new Error(
      "The pending restore paths are invalid; startup is blocked.",
    );
  }
  const targetInfo = fs.existsSync(target) ? fs.lstatSync(target) : null;
  const rollbackInfo = fs.existsSync(rollback) ? fs.lstatSync(rollback) : null;
  if (
    targetInfo &&
    (targetInfo.isSymbolicLink() || !targetInfo.isDirectory())
  ) {
    throw new Error(
      "The restored workspace path is unsafe; startup is blocked.",
    );
  }
  if (
    rollbackInfo &&
    (rollbackInfo.isSymbolicLink() || !rollbackInfo.isDirectory())
  ) {
    throw new Error(
      "The rollback workspace path is unsafe; startup is blocked.",
    );
  }
  if (!rollbackInfo) {
    if (!targetInfo) {
      throw new Error(
        "Both restored and rollback workspaces are missing; startup is blocked.",
      );
    }
    clearPendingRestoreRecord();
    return false;
  }
  if (targetInfo) fs.rmSync(target, { recursive: true, force: true });
  fs.renameSync(rollback, target);
  fs.chmodSync(target, 0o700);
  syncDirectory(parent);
  clearPendingRestoreRecord();
  desktopLog("warn", "desktop", "restore_rollback_recovered");
  return true;
}

function auditAnchorEnvironment() {
  if (hasExternallyManagedAnchorEnvironment()) {
    return selectedProcessEnvironment(AUDIT_ANCHOR_ENV_KEYS);
  }
  return localAuditAnchorEnvironment(app.getPath("userData"));
}

function getAuditAnchorConfiguration() {
  const managedExternally = hasExternallyManagedAnchorEnvironment();
  return publicAuditAnchorConfiguration({
    config: managedExternally
      ? null
      : readAuditAnchorConfig(app.getPath("userData")),
    managedExternally,
  });
}

function encryptedVolumeAttested() {
  if (process.env.ALETHEIA_ENCRYPTED_VOLUME_ATTESTED === "true") return true;
  if (process.platform !== "darwin") return false;
  try {
    return execFileSync("/usr/bin/fdesetup", ["status"], {
      encoding: "utf8",
      timeout: 5000,
    }).includes("FileVault is On");
  } catch {
    return false;
  }
}

function desktopEncryptionPolicy() {
  return resolveDesktopEncryptionPolicy({
    packaged: app.isPackaged,
    environment: process.env,
  });
}

function applicationEncryptionEnvironment(mode) {
  if (mode === "disabled") {
    return { ALETHEIA_APPLICATION_ENCRYPTION: "disabled" };
  }
  if (process.env.ALETHEIA_MASTER_KEY_BASE64) {
    return {
      ALETHEIA_APPLICATION_ENCRYPTION: "required",
      ALETHEIA_MASTER_KEY_SOURCE: "env",
      ALETHEIA_MASTER_KEY_BASE64: process.env.ALETHEIA_MASTER_KEY_BASE64,
    };
  }
  if (process.env.ALETHEIA_MASTER_KEY_FILE) {
    return {
      ALETHEIA_APPLICATION_ENCRYPTION: "required",
      ALETHEIA_MASTER_KEY_SOURCE: "file",
      ALETHEIA_MASTER_KEY_FILE: process.env.ALETHEIA_MASTER_KEY_FILE,
    };
  }
  ensureMacOsKeychainKey({
    service: APPLICATION_KEYCHAIN_SERVICE,
    account: APPLICATION_KEYCHAIN_ACCOUNT,
    label: "application encryption",
    productName: PRODUCT_NAME,
  });
  return {
    ALETHEIA_APPLICATION_ENCRYPTION: "required",
    ALETHEIA_MASTER_KEY_SOURCE: "macos_keychain",
  };
}

function readApplicationMasterKey() {
  let encoded = null;
  if (process.env.ALETHEIA_MASTER_KEY_BASE64) {
    encoded = process.env.ALETHEIA_MASTER_KEY_BASE64.trim();
  } else if (process.env.ALETHEIA_MASTER_KEY_FILE) {
    encoded = fs
      .readFileSync(path.resolve(process.env.ALETHEIA_MASTER_KEY_FILE), "utf8")
      .trim();
  } else {
    ensureMacOsKeychainKey({
      service: APPLICATION_KEYCHAIN_SERVICE,
      account: APPLICATION_KEYCHAIN_ACCOUNT,
      label: "application encryption",
      productName: PRODUCT_NAME,
    });
    encoded = execFileSync(
      "/usr/bin/security",
      [
        "find-generic-password",
        "-s",
        APPLICATION_KEYCHAIN_SERVICE,
        "-a",
        APPLICATION_KEYCHAIN_ACCOUNT,
        "-w",
      ],
      {
        encoding: "utf8",
        timeout: 10_000,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      },
    ).trim();
  }
  const masterKey = Buffer.from(encoded, "base64");
  if (masterKey.length !== 32) {
    throw new Error(`${PRODUCT_NAME} application master key is invalid`);
  }
  return masterKey;
}

function derivedBackupKeyBase64() {
  const masterKey = readApplicationMasterKey();
  const derived = Buffer.from(
    crypto.hkdfSync(
      "sha256",
      masterKey,
      Buffer.from("aletheia-desktop-backup-salt-v1", "utf8"),
      Buffer.from("aletheia-desktop-backup-key-v1", "utf8"),
      32,
    ),
  );
  masterKey.fill(0);
  const encoded = derived.toString("base64");
  derived.fill(0);
  return encoded;
}

function databaseEncryptionEnvironment(mode) {
  if (mode === "metadata_plaintext") {
    return { ALETHEIA_DATABASE_ENCRYPTION: "metadata_plaintext" };
  }
  const configuredSource =
    process.env.ALETHEIA_DATABASE_KEY_SOURCE?.trim().toLowerCase();
  if (configuredSource === "env") {
    if (!process.env.ALETHEIA_DATABASE_KEY_BASE64) {
      throw new Error(
        "ALETHEIA_DATABASE_KEY_SOURCE=env requires ALETHEIA_DATABASE_KEY_BASE64.",
      );
    }
    return {
      ALETHEIA_DATABASE_ENCRYPTION: "sqlcipher_required",
      ALETHEIA_DATABASE_KEY_SOURCE: "env",
      ALETHEIA_DATABASE_KEY_BASE64: process.env.ALETHEIA_DATABASE_KEY_BASE64,
    };
  }
  if (configuredSource === "file") {
    if (!process.env.ALETHEIA_DATABASE_KEY_FILE) {
      throw new Error(
        "ALETHEIA_DATABASE_KEY_SOURCE=file requires ALETHEIA_DATABASE_KEY_FILE.",
      );
    }
    return {
      ALETHEIA_DATABASE_ENCRYPTION: "sqlcipher_required",
      ALETHEIA_DATABASE_KEY_SOURCE: "file",
      ALETHEIA_DATABASE_KEY_FILE: process.env.ALETHEIA_DATABASE_KEY_FILE,
    };
  }
  if (configuredSource && configuredSource !== "macos_keychain") {
    throw new Error(
      "ALETHEIA_DATABASE_KEY_SOURCE must be env, file, or macos_keychain.",
    );
  }
  if (!configuredSource && process.env.ALETHEIA_DATABASE_KEY_BASE64) {
    return {
      ALETHEIA_DATABASE_ENCRYPTION: "sqlcipher_required",
      ALETHEIA_DATABASE_KEY_SOURCE: "env",
      ALETHEIA_DATABASE_KEY_BASE64: process.env.ALETHEIA_DATABASE_KEY_BASE64,
    };
  }
  if (!configuredSource && process.env.ALETHEIA_DATABASE_KEY_FILE) {
    return {
      ALETHEIA_DATABASE_ENCRYPTION: "sqlcipher_required",
      ALETHEIA_DATABASE_KEY_SOURCE: "file",
      ALETHEIA_DATABASE_KEY_FILE: process.env.ALETHEIA_DATABASE_KEY_FILE,
    };
  }
  ensureMacOsKeychainKey({
    service: DATABASE_KEYCHAIN_SERVICE,
    account: DATABASE_KEYCHAIN_ACCOUNT,
    label: "SQLCipher database encryption",
    productName: PRODUCT_NAME,
  });
  return {
    ALETHEIA_DATABASE_ENCRYPTION: "sqlcipher_required",
    ALETHEIA_DATABASE_KEY_SOURCE: "macos_keychain",
  };
}

function loadingHtml(message) {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>${PRODUCT_NAME}</title>
    <style>
      html, body {
        margin: 0;
        height: 100%;
        background: #f7f7f8;
        color: #111827;
        font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
      }
      body {
        display: grid;
        place-items: center;
      }
      main {
        width: min(360px, calc(100vw - 48px));
      }
      h1 {
        margin: 0;
        font-family: Georgia, "Times New Roman", serif;
        font-size: 30px;
        font-weight: 300;
      }
      p {
        margin: 12px 0 0;
        color: #4b5563;
        font-size: 14px;
        line-height: 1.6;
      }
      .bar {
        margin-top: 22px;
        height: 2px;
        overflow: hidden;
        background: #d9dce1;
      }
      .bar::before {
        display: block;
        width: 42%;
        height: 100%;
        background: #111827;
        animation: load 1.4s ease-in-out infinite;
        content: "";
      }
      @keyframes load {
        0% { transform: translateX(-110%); }
        100% { transform: translateX(260%); }
      }
    </style>
  </head>
  <body>
    <main>
      <h1>${PRODUCT_NAME}</h1>
      <p>${message}</p>
      <div class="bar"></div>
    </main>
  </body>
</html>`;
}

function createWindow() {
  desktopLog("info", "desktop", "renderer_window_creating");
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 900,
    minWidth: 900,
    minHeight: 640,
    title: PRODUCT_NAME,
    backgroundColor: "#eef1f5",
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hiddenInset",
          trafficLightPosition: { x: 14, y: 14 },
        }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("mailto:")) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (
      !url.startsWith(`${FRONTEND_URL}/`) &&
      !url.startsWith("data:text/html")
    ) {
      event.preventDefault();
    }
  });
  mainWindow.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(
      loadingHtml("正在打开本地工作区…"),
    )}`,
  );
  mainWindow.once("closed", () => {
    mainWindow = null;
  });
}

function configureDesktopSessionSecurity() {
  const desktopSession = session.defaultSession;
  desktopSession.setPermissionCheckHandler(() => false);
  desktopSession.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false),
  );
  desktopSession.webRequest.onHeadersReceived(
    { urls: [`${FRONTEND_URL}/*`] },
    (details, callback) => {
      const responseHeaders = { ...(details.responseHeaders ?? {}) };
      if (details.resourceType === "mainFrame") {
        const contentSecurityPolicy = Object.entries(responseHeaders)
          .filter(([name]) => name.toLowerCase() === "content-security-policy")
          .flatMap(([, values]) => values)
          .join("; ");
        const requiredPolicy = [
          "default-src 'self'",
          "base-uri 'none'",
          "object-src 'none'",
          "frame-ancestors 'none'",
          "script-src 'self'",
          "'strict-dynamic'",
          `connect-src 'self' ${BACKEND_URL}`,
        ];
        const hasNonce = /'nonce-[A-Za-z0-9+/_=-]+'/u.test(
          contentSecurityPolicy,
        );
        if (
          !hasNonce ||
          requiredPolicy.some(
            (directive) => !contentSecurityPolicy.includes(directive),
          ) ||
          contentSecurityPolicy.includes("'unsafe-eval'")
        ) {
          callback({ cancel: true });
          return;
        }
      }
      responseHeaders["Permissions-Policy"] = [
        "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()",
      ];
      responseHeaders["Referrer-Policy"] = ["no-referrer"];
      responseHeaders["X-Content-Type-Options"] = ["nosniff"];
      callback({ responseHeaders });
    },
  );
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHttp(url, timeoutMs) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
      lastError = new Error(`${url} returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await wait(500);
  }
  throw lastError ?? new Error(`${url} did not become ready`);
}

function assertPortFree(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", () => {
      reject(
        new Error(
          `Port ${port} is already in use. Quit the other local service or choose different local desktop ports before launching ${PRODUCT_NAME}.`,
        ),
      );
    });
    server.once("listening", () => {
      server.close(resolve);
    });
    server.listen(port, HOST);
  });
}

function forkUtility(label, modulePath, args, options) {
  if (serviceChildren.has(label)) {
    throw new Error(`${label} is already running.`);
  }
  const child = utilityProcess.fork(modulePath, args, {
    cwd: options.cwd,
    env: {
      ...selectedProcessEnvironment(CHILD_RUNTIME_ENV_KEYS),
      ...options.env,
    },
    serviceName: `${PRODUCT_NAME} ${label}`,
    stdio: "pipe",
  });
  desktopLog("info", label, "service_fork_requested", {
    pid_available: Boolean(child.pid),
  });
  child.once("spawn", () => {
    desktopLog("info", label, "service_spawned");
  });
  child.on("message", (event) => {
    const data =
      event && typeof event === "object" && "data" in event
        ? event.data
        : event;
    if (
      data &&
      typeof data === "object" &&
      !Array.isArray(data) &&
      Object.keys(data).length === 1 &&
      data.type === CREDENTIAL_PORT_READY
    ) {
      if (!credentialPortReadyChildren.has(child)) {
        credentialPortReadyChildren.add(child);
        desktopLog("info", label, "credential_port_ready");
      }
    }
  });
  children.add(child);
  serviceChildren.set(label, child);
  child.stdout?.on("data", (chunk) =>
    desktopLog("info", label, "service_output", { bytes: chunk.length }),
  );
  child.stderr?.on("data", (chunk) =>
    desktopLog("warn", label, "service_error_output", {
      bytes: chunk.length,
    }),
  );
  child.once("exit", (code) => {
    children.delete(child);
    const wasCurrentService = serviceChildren.get(label) === child;
    if (wasCurrentService) serviceChildren.delete(label);
    if (code !== 0) {
      desktopLog("error", label, "service_exit", { code });
    }
    if (
      wasCurrentService &&
      servicesReady &&
      !serviceShutdownExpected &&
      !quitAfterServiceStop
    ) {
      servicesReady = false;
      void handleUnexpectedServiceExit(label, code);
    }
  });
  return child;
}

async function waitForCredentialPortReady(child, label, timeoutMs = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (credentialPortReadyChildren.has(child)) return;
    if (!children.has(child)) {
      throw new Error(`${label} exited before credential-port readiness.`);
    }
    await wait(25);
  }
  child.kill();
  const error = new Error(
    `${label} did not become ready for its credential port.`,
  );
  error.code =
    label === "credential worker"
      ? "CREDENTIAL_WORKER_PORT_READY_TIMEOUT"
      : "BACKEND_CREDENTIAL_PORT_READY_TIMEOUT";
  throw error;
}

function waitForUtilitySpawn(child, label, timeoutMs = 15_000) {
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
      finish(new Error(`${label} exited before startup with code=${code}.`));
    const timeout = setTimeout(() => {
      child.kill();
      const error = new Error(`${label} did not start in time.`);
      error.code =
        label === "credential worker"
          ? "CREDENTIAL_WORKER_SPAWN_TIMEOUT"
          : "LOCAL_SERVICE_SPAWN_TIMEOUT";
      finish(error);
    }, timeoutMs);
    child.once("spawn", onSpawn);
    child.once("exit", onExit);
    // pid can become available between the initial check and listener setup.
    // Recheck after both listeners are installed so a fast spawn cannot be
    // mistaken for a startup timeout.
    if (child.pid) finish();
  });
}

async function connectCredentialWorkerToBackend(credentialWorker, backend) {
  await Promise.all([
    waitForUtilitySpawn(credentialWorker, "credential worker"),
    waitForUtilitySpawn(backend, "backend"),
    waitForCredentialPortReady(credentialWorker, "credential worker"),
    waitForCredentialPortReady(backend, "backend"),
  ]);
  const { port1, port2 } = new MessageChannelMain();
  try {
    credentialWorker.postMessage({ type: CREDENTIAL_PORT_BOOTSTRAP }, [port1]);
    backend.postMessage({ type: CREDENTIAL_PORT_BOOTSTRAP }, [port2]);
    desktopLog("info", "desktop", "credential_port_transferred");
  } catch (error) {
    port1.close();
    port2.close();
    throw error;
  }
}

function runUtilityOnce(label, modulePath, options) {
  return new Promise((resolve, reject) => {
    const child = utilityProcess.fork(modulePath, options.args ?? [], {
      cwd: options.cwd,
      env: {
        ...selectedProcessEnvironment(CHILD_RUNTIME_ENV_KEYS),
        ...options.env,
      },
      serviceName: `${PRODUCT_NAME} ${label}`,
      stdio: "pipe",
    });
    children.add(child);
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`${label} timed out.`));
    }, options.timeoutMs ?? 120_000);
    child.stdout?.on("data", (chunk) => {
      stdout = `${stdout}${chunk.toString()}`.slice(-32_768);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-32_768);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      children.delete(child);
      if (code === 0) {
        desktopLog("info", label, "utility_complete", {
          output_bytes: Buffer.byteLength(stdout),
        });
        resolve(stdout.trim());
        return;
      }
      desktopLog("error", label, "utility_failed", {
        code,
        error_output_bytes: Buffer.byteLength(stderr),
      });
      reject(
        new Error(
          `${label} failed with code ${code}.${stderr.trim() ? " See the local Vera logs for details." : ""}`,
        ),
      );
    });
  });
}

function assertPackagedResources(root) {
  const required = [
    path.join(root, "backend", "dist", "index.js"),
    path.join(root, "backend", "dist", "desktopBackup.js"),
    path.join(root, "backend", "dist", "desktopMigrate.js"),
    path.join(root, "backend", "node_modules"),
    path.join(root, "backend", "voice_sidecar", "aletheia_voice_sidecar.py"),
    path.join(
      root,
      "backend",
      "node_modules",
      "@signalapp",
      "sqlcipher",
      "prebuilds",
      `${process.platform}-${process.arch}`,
      "@signalapp+sqlcipher.node",
    ),
    path.join(root, "frontend", "server.js"),
    path.join(root, "frontend", ".next-build", "BUILD_ID"),
    path.join(root, "frontend-node-modules.tgz"),
  ];
  for (const item of required) {
    if (!fs.existsSync(item)) {
      throw new Error(`Missing desktop runtime resource: ${item}`);
    }
  }
}

function directoryContainsFiles(root) {
  if (!fs.existsSync(root)) return false;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Refusing symbolic link in local data: ${candidate}`);
      }
      if (entry.isDirectory()) pending.push(candidate);
      if (entry.isFile()) return true;
    }
  }
  return false;
}

async function migrateLegacyDesktopWorkspace(
  root,
  dataDir,
  applicationEncryption,
  databaseEncryption,
) {
  if (!app.isPackaged) return;
  const databasePath = path.join(dataDir, "aletheia.db");
  const hasExistingData =
    fs.existsSync(databasePath) ||
    directoryContainsFiles(path.join(dataDir, "documents")) ||
    directoryContainsFiles(path.join(dataDir, "exports"));
  if (!hasExistingData) return;
  const backupDir = path.join(
    app.getPath("userData"),
    "migration-backups",
    `startup-${Date.now()}`,
  );
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(backupDir, 0o700);
  const backendDir = path.join(root, "backend");
  await runUtilityOnce(
    "workspace migration",
    path.join(backendDir, "dist", "desktopMigrate.js"),
    {
      cwd: backendDir,
      timeoutMs: 180_000,
      env: {
        ALETHEIA_DATA_DIR: dataDir,
        ALETHEIA_MODEL_CALL_LOG_DIR: path.join(app.getPath("logs"), "vera"),
        ALETHEIA_DESKTOP_MIGRATION_BACKUP_DIR: backupDir,
        ...applicationEncryption,
        ...databaseEncryption,
      },
    },
  );
}

function prepareFrontendModules(root) {
  if (process.platform !== "darwin") {
    throw new Error(
      "Packaged frontend module extraction currently requires macOS.",
    );
  }
  const archivePath = path.join(root, "frontend-node-modules.tgz");
  const archiveHash = crypto
    .createHash("sha256")
    .update(fs.readFileSync(archivePath))
    .digest("hex");
  const runtimeRoot = path.join(
    app.getPath("userData"),
    "runtime",
    "frontend-node-modules",
  );
  const targetRoot = path.join(runtimeRoot, archiveHash.slice(0, 20));
  const target = path.join(targetRoot, "node_modules");
  if (
    fs.existsSync(path.join(targetRoot, ".ready")) &&
    fs.existsSync(path.join(target, "next", "package.json"))
  ) {
    return target;
  }
  fs.mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(runtimeRoot, 0o700);
  const temporaryRoot = `${targetRoot}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  const temporary = path.join(temporaryRoot, "node_modules");
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
  fs.mkdirSync(temporary, { recursive: true, mode: 0o700 });
  try {
    execFileSync("/usr/bin/tar", ["-xzf", archivePath, "-C", temporary], {
      timeout: 60_000,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    if (!fs.existsSync(path.join(temporary, "next", "package.json"))) {
      throw new Error(
        "Extracted frontend runtime is missing next/package.json.",
      );
    }
    fs.writeFileSync(path.join(temporaryRoot, ".ready"), `${archiveHash}\n`, {
      mode: 0o600,
    });
    fs.rmSync(targetRoot, { recursive: true, force: true });
    fs.renameSync(temporaryRoot, targetRoot);
  } catch (error) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
  for (const entry of fs.readdirSync(runtimeRoot, { withFileTypes: true })) {
    const candidate = path.join(runtimeRoot, entry.name);
    if (entry.isDirectory() && candidate !== targetRoot) {
      fs.rmSync(candidate, { recursive: true, force: true });
    }
  }
  return target;
}

function assertDesktopIsNotQuitting() {
  if (quitShutdownStarted || quitAfterServiceStop) {
    throw new Error(`${PRODUCT_NAME} is shutting down.`);
  }
}

async function startServices() {
  assertDesktopIsNotQuitting();
  desktopLog("info", "desktop", "services_starting");
  const requireEncryptedVolume =
    process.env.ALETHEIA_REQUIRE_ENCRYPTED_VOLUME ?? "false";
  const volumeAttested = encryptedVolumeAttested();
  if (requireEncryptedVolume === "true" && !volumeAttested) {
    throw new Error(
      `Encrypted storage is required. Enable FileVault or provide an approved encrypted-volume attestation before opening ${PRODUCT_NAME}.`,
    );
  }
  const encryptionPolicy = desktopEncryptionPolicy();
  const applicationEncryption = applicationEncryptionEnvironment(
    encryptionPolicy.applicationEncryption,
  );
  const databaseEncryption = databaseEncryptionEnvironment(
    encryptionPolicy.databaseEncryption,
  );
  activeEncryptionPolicy = encryptionPolicy;
  await assertPortFree(BACKEND_PORT);
  await assertPortFree(FRONTEND_PORT);

  const root = resourceRoot();
  assertPackagedResources(root);

  const dataDir = localDataDir();
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dataDir, 0o700);
  await migrateLegacyDesktopWorkspace(
    root,
    dataDir,
    applicationEncryption,
    databaseEncryption,
  );

  const backendDir = path.join(root, "backend");
  const credentialWorkerPath = desktopUtilityModulePath("credentialWorker.js");
  desktopLog("info", "credential worker", "entry_resolved", {
    exists: fs.existsSync(credentialWorkerPath),
    external_resource: credentialWorkerPath.includes(
      `${path.sep}aletheia${path.sep}desktop${path.sep}`,
    ),
  });
  if (!fs.existsSync(credentialWorkerPath)) {
    throw new Error("The packaged credential worker is unavailable.");
  }
  const credentialWorker = forkUtility(
    "credential worker",
    credentialWorkerPath,
    [],
    {
      // A packaged __dirname points inside app.asar and is not a real OS
      // working directory. The utility entry is an ordinary extraResource;
      // use its real parent directory for the process cwd as well.
      cwd: path.dirname(credentialWorkerPath),
      env: {},
    },
  );
  await Promise.all([
    waitForUtilitySpawn(credentialWorker, "credential worker"),
    waitForCredentialPortReady(credentialWorker, "credential worker"),
  ]);
  assertDesktopIsNotQuitting();
  const backend = forkUtility(
    "backend",
    path.join(backendDir, "dist", "index.js"),
    [],
    {
      cwd: backendDir,
      env: {
        ...selectedProcessEnvironment(BACKEND_LOCAL_CONFIG_ENV_KEYS),
        ...legacyFeatureEnvironment(),
        ...auditAnchorEnvironment(),
        NODE_ENV: "production",
        PORT: String(BACKEND_PORT),
        ALETHEIA_BACKEND_HOST: HOST,
        FRONTEND_URL,
        DOWNLOAD_SIGNING_SECRET: DESKTOP_DOWNLOAD_SIGNING_SECRET,
        ALETHEIA_AUTH_MODE: "private_token",
        ALETHEIA_PRIVATE_AUTH_TOKEN: DESKTOP_SESSION_TOKEN,
        ALETHEIA_DATA_DIR: dataDir,
        ALETHEIA_MODEL_CALL_LOG_DIR: path.join(app.getPath("logs"), "vera"),
        ...applicationEncryption,
        ...databaseEncryption,
        ALETHEIA_REQUIRE_ENCRYPTED_VOLUME: requireEncryptedVolume,
        ALETHEIA_ENCRYPTED_VOLUME_ATTESTED: String(volumeAttested),
        ALETHEIA_LOCAL_USER_ID:
          process.env.ALETHEIA_LOCAL_USER_ID ?? "desktop-local-user",
        ALETHEIA_LOCAL_USER_EMAIL:
          process.env.ALETHEIA_LOCAL_USER_EMAIL ?? "desktop@aletheia.local",
        ALETHEIA_MULTI_PRINCIPAL_ENABLED: "false",
        ALETHEIA_RETRIEVAL_MODE: "keyword",
        ALETHEIA_SEMANTIC_INDEX_ENABLED: "false",
        ALETHEIA_SEMANTIC_INDEX_DRIVER: "disabled",
        ALETHEIA_SEMANTIC_INDEX_DIR: path.join(
          dataDir,
          "index",
          "semantic-local",
        ),
        ALETHEIA_OCR_BINARY: path.join(root, "native", "aletheia-ocr"),
        ALETHEIA_OCR_ENABLED: "true",
        TRUST_PROXY_HOPS: "0",
        ALETHEIA_DEMO_SEED_ENABLED:
          process.env.ALETHEIA_DEMO_SEED_ENABLED ?? "false",
        ALETHEIA_DEMO_SEED_MODE: process.env.ALETHEIA_DEMO_SEED_MODE ?? "empty",
        VERA_DESKTOP_CREDENTIAL_PORT_REQUIRED: "true",
      },
    },
  );
  await connectCredentialWorkerToBackend(credentialWorker, backend);
  await waitForHttp(`${BACKEND_URL}/health`, 45_000);
  assertDesktopIsNotQuitting();

  const frontendDir = path.join(root, "frontend");
  const frontendModulesDir = prepareFrontendModules(root);
  const frontend = forkUtility(
    "frontend",
    path.join(frontendDir, "server.js"),
    [],
    {
      cwd: frontendDir,
      env: {
        NODE_ENV: "production",
        NODE_PATH: frontendModulesDir,
        ALETHEIA_FRONTEND_MODULES_DIR: frontendModulesDir,
        NEXT_TELEMETRY_DISABLED: "1",
        PORT: String(FRONTEND_PORT),
        HOSTNAME: HOST,
        NEXT_PUBLIC_API_BASE_URL: BACKEND_URL,
        NEXT_PUBLIC_ALETHEIA_LOCAL_CLIENT: "true",
        VERA_DESKTOP_CSP: "true",
        VERA_DESKTOP_BACKEND_ORIGIN: BACKEND_URL,
        NEXT_PUBLIC_ALETHEIA_LOCAL_USER_ID:
          process.env.NEXT_PUBLIC_ALETHEIA_LOCAL_USER_ID ??
          process.env.ALETHEIA_LOCAL_USER_ID ??
          "desktop-local-user",
        NEXT_PUBLIC_ALETHEIA_LOCAL_USER_EMAIL:
          process.env.NEXT_PUBLIC_ALETHEIA_LOCAL_USER_EMAIL ??
          process.env.ALETHEIA_LOCAL_USER_EMAIL ??
          "desktop@aletheia.local",
      },
    },
  );
  await waitForHttp(`${FRONTEND_URL}${WORKSPACE_PATH}`, 45_000);
  assertDesktopIsNotQuitting();
  for (const [label, child] of [
    ["credential worker", credentialWorker],
    ["backend", backend],
    ["frontend", frontend],
  ]) {
    if (serviceChildren.get(label) !== child || !children.has(child)) {
      throw new Error(`${label} exited before local services became ready.`);
    }
  }
  servicesReady = true;
  desktopLog("info", "desktop", "services_ready");
}

async function stopTrackedChild(child, deadline) {
  if (!children.has(child)) return;
  child.kill();
  const gracefulDeadline = Math.min(deadline, Date.now() + 7_000);
  while (children.has(child) && Date.now() < gracefulDeadline) {
    await wait(100);
  }
  if (!children.has(child) || !child.pid) return;
  try {
    process.kill(child.pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
  const forcedDeadline = Math.min(deadline, Date.now() + 5_000);
  while (children.has(child) && Date.now() < forcedDeadline) {
    await wait(100);
  }
}

async function stopServicesAndWait(timeoutMs = 20_000) {
  if (serviceStopPromise) return serviceStopPromise;
  serviceStopPromise = (async () => {
    desktopLog("info", "desktop", "services_stopping");
    servicesReady = false;
    serviceShutdownExpected = true;
    const deadline = Date.now() + timeoutMs;
    const stopped = new Set();
    for (const label of SERVICE_STOP_ORDER) {
      const child = serviceChildren.get(label);
      if (!child) continue;
      stopped.add(child);
      await stopTrackedChild(child, deadline);
    }
    for (const child of [...children]) {
      if (stopped.has(child)) continue;
      await stopTrackedChild(child, deadline);
    }
    if (children.size > 0) {
      throw new Error("Local services did not stop cleanly.");
    }
    desktopLog("info", "desktop", "services_stopped");
  })().finally(() => {
    serviceShutdownExpected = false;
    serviceStopPromise = null;
  });
  return serviceStopPromise;
}

function safeBackupFilename() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${PRODUCT_NAME} Backup ${timestamp}.aletheia-backup`;
}

function safeDiagnosticFilename() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${PRODUCT_NAME} Diagnostics ${timestamp}.vera-diagnostics.json`;
}

async function exportRedactedDiagnosticBundle() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw new Error(`The ${PRODUCT_NAME} window is unavailable`);
  }
  const selection = await dialog.showSaveDialog(mainWindow, {
    title: "导出脱敏诊断包",
    defaultPath: path.join(app.getPath("documents"), safeDiagnosticFilename()),
    buttonLabel: "导出诊断包",
    filters: [
      {
        name: `${PRODUCT_NAME} 脱敏诊断包`,
        extensions: ["json"],
      },
    ],
    properties: ["showOverwriteConfirmation", "createDirectory"],
  });
  if (selection.canceled || !selection.filePath) {
    return { saved: false, canceled: true };
  }
  const destination = selection.filePath.endsWith(".json")
    ? selection.filePath
    : `${selection.filePath}.json`;
  const bundle = buildRedactedDiagnosticBundle({
    now: new Date(),
    appVersion: app.getVersion(),
    packaged: app.isPackaged,
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    versions: process.versions,
    runningServices: [...serviceChildren.keys()],
    servicesReady,
    encryptedVolumeAttested: encryptedVolumeAttested(),
    genericLoopbackHttpEnabled:
      process.env.ALETHEIA_MODEL_PROVIDER_ALLOW_LOOPBACK_HTTP === "true",
    dataDir: localDataDir(),
    logsDir: app.getPath("logs"),
  });
  const bytes = Buffer.from(`${JSON.stringify(bundle, null, 2)}\n`, "utf8");
  writeOwnerOnlyFileAtomically(destination, bytes);
  return {
    saved: true,
    canceled: false,
    bytes: bytes.byteLength,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    createdAt: bundle.created_at,
  };
}

function parseBackupUtilityResult(output, expectedAction) {
  const lines = String(output).trim().split("\n");
  if (lines.length !== 1 || !lines[0]) {
    throw new Error("The backup utility returned an invalid response");
  }
  let parsed;
  try {
    parsed = JSON.parse(lines[0]);
  } catch {
    throw new Error("The backup utility returned an invalid response");
  }
  if (
    !parsed ||
    parsed.ok !== true ||
    parsed.action !== expectedAction ||
    typeof parsed.format !== "string"
  ) {
    throw new Error("The backup utility did not complete successfully");
  }
  return parsed;
}

function hashFileSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const input = fs.createReadStream(filePath);
    input.on("error", reject);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("end", () => resolve(hash.digest("hex")));
  });
}

async function createEncryptedBackup() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw new Error(`The ${PRODUCT_NAME} window is unavailable`);
  }
  const selection = await dialog.showSaveDialog(mainWindow, {
    title: "创建加密工作区备份",
    defaultPath: path.join(app.getPath("documents"), safeBackupFilename()),
    buttonLabel: "创建备份",
    filters: [
      {
        name: `${PRODUCT_NAME} 加密备份`,
        extensions: ["aletheia-backup"],
      },
    ],
    properties: ["showOverwriteConfirmation", "createDirectory"],
  });
  if (selection.canceled || !selection.filePath) {
    return { saved: false, canceled: true };
  }
  const destination = selection.filePath.endsWith(".aletheia-backup")
    ? selection.filePath
    : `${selection.filePath}.aletheia-backup`;
  const backendDir = path.join(resourceRoot(), "backend");
  const backupModule = path.join(backendDir, "dist", "desktopBackup.js");
  const keyBase64 = derivedBackupKeyBase64();
  let backupResult = null;
  let operationError = null;
  let restartError = null;
  let restartRequired = false;

  try {
    restartRequired = true;
    await stopServicesAndWait();
    const output = await runUtilityOnce("encrypted backup", backupModule, {
      cwd: backendDir,
      args: [
        "create",
        "--source",
        localDataDir(),
        "--output",
        destination,
        "--key-base64-env",
        "ALETHEIA_BACKUP_KEY_BASE64",
      ],
      env: { ALETHEIA_BACKUP_KEY_BASE64: keyBase64 },
      timeoutMs: 30 * 60_000,
    });
    backupResult = parseBackupUtilityResult(output, "create");
  } catch (error) {
    operationError = error;
  } finally {
    if (restartRequired) {
      try {
        await startServices();
      } catch (error) {
        restartError = error;
      }
    }
  }

  if (operationError || restartError) {
    const operationMessage = operationError
      ? operationError instanceof Error
        ? operationError.message
        : String(operationError)
      : null;
    const restartMessage = restartError
      ? restartError instanceof Error
        ? restartError.message
        : String(restartError)
      : null;
    throw new Error(
      [
        operationMessage,
        restartMessage && `Local services failed to restart: ${restartMessage}`,
      ]
        .filter(Boolean)
        .join(" "),
    );
  }
  if (!backupResult) throw new Error("The encrypted backup was not created");

  return {
    saved: true,
    canceled: false,
    filePath: destination,
    bytes: backupResult.encrypted_bytes,
    sha256: await hashFileSha256(destination),
    createdAt: backupResult.created_at,
  };
}

async function inspectEncryptedBackup() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw new Error(`The ${PRODUCT_NAME} window is unavailable`);
  }
  const selection = await dialog.showOpenDialog(mainWindow, {
    title: "检查加密工作区备份",
    buttonLabel: "检查备份",
    filters: [
      {
        name: `${PRODUCT_NAME} 加密备份`,
        extensions: ["aletheia-backup"],
      },
    ],
    properties: ["openFile"],
  });
  const input = selection.filePaths[0];
  if (selection.canceled || !input) return { canceled: true };

  const backendDir = path.join(resourceRoot(), "backend");
  try {
    const output = await runUtilityOnce(
      "backup preflight",
      path.join(backendDir, "dist", "desktopBackup.js"),
      {
        cwd: backendDir,
        args: [
          "inspect",
          "--input",
          input,
          "--key-base64-env",
          "ALETHEIA_BACKUP_KEY_BASE64",
        ],
        env: { ALETHEIA_BACKUP_KEY_BASE64: derivedBackupKeyBase64() },
        timeoutMs: 30 * 60_000,
      },
    );
    const result = parseBackupUtilityResult(output, "inspect");
    verifiedBackupSelection = {
      filePath: input,
      sha256: await hashFileSha256(input),
      createdAt: result.created_at,
    };
    return {
      canceled: false,
      ok: true,
      filePath: input,
      createdAt: result.created_at,
      files: result.files,
      bytes: result.plaintext_bytes,
      checks: [
        {
          id: "authentication",
          ok: true,
          detail: "加密封装已通过身份验证。",
        },
        {
          id: "archive",
          ok: true,
          detail: "归档路径和条目类型安全。",
        },
        {
          id: "manifest",
          ok: true,
          detail: "文件大小与 SHA-256 校验值一致。",
        },
        {
          id: "workspace",
          ok: true,
          detail: "所需数据库和工作区目录完整。",
        },
      ],
    };
  } catch (error) {
    verifiedBackupSelection = null;
    const detail = (error instanceof Error ? error.message : String(error))
      .replace(/\s+/g, " ")
      .slice(0, 800);
    return {
      canceled: false,
      ok: false,
      filePath: input,
      checks: [{ id: "integrity", ok: false, detail }],
    };
  }
}

function validatedRollbackPath(candidate) {
  const target = fs.realpathSync(localDataDir());
  const parent = path.dirname(target);
  const resolved = path.resolve(String(candidate || ""));
  const info = fs.lstatSync(resolved);
  if (
    path.dirname(resolved) !== parent ||
    !path.basename(resolved).startsWith(".aletheia-restore-rollback-") ||
    info.isSymbolicLink() ||
    !info.isDirectory()
  ) {
    throw new Error("The restore utility returned an invalid rollback path");
  }
  return { target, rollback: resolved };
}

function appendRestoreJournal(entry) {
  const journalPath = path.join(
    app.getPath("userData"),
    "restore-journal.jsonl",
  );
  const key = Buffer.from(derivedBackupKeyBase64(), "base64");
  try {
    const records = fs.existsSync(journalPath)
      ? fs
          .readFileSync(journalPath, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
    let previousHash = null;
    for (const record of records) {
      const { eventHash, ...payload } = record;
      if (payload.previousHash !== previousHash) {
        throw new Error("Restore journal chain is invalid");
      }
      const expected = crypto
        .createHmac("sha256", key)
        .update(previousHash || "")
        .update("\n")
        .update(JSON.stringify(payload))
        .digest("hex");
      if (eventHash !== expected) {
        throw new Error("Restore journal authentication failed");
      }
      previousHash = eventHash;
    }
    const payload = {
      schema: "aletheia-restore-journal-v1",
      previousHash,
      restoredAt: new Date().toISOString(),
      backupCreatedAt: entry.createdAt,
      backupSha256: entry.backupSha256,
      files: entry.files,
      plaintextBytes: entry.bytes,
    };
    const eventHash = crypto
      .createHmac("sha256", key)
      .update(previousHash || "")
      .update("\n")
      .update(JSON.stringify(payload))
      .digest("hex");
    const descriptor = fs.openSync(journalPath, "a", 0o600);
    try {
      fs.writeSync(
        descriptor,
        `${JSON.stringify({ ...payload, eventHash })}\n`,
      );
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.chmodSync(journalPath, 0o600);
  } finally {
    key.fill(0);
  }
}

async function restoreEncryptedBackup() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw new Error(`The ${PRODUCT_NAME} window is unavailable`);
  }
  const verified = verifiedBackupSelection;
  if (!verified) {
    throw new Error("Check a backup successfully before restoring it");
  }
  if ((await hashFileSha256(verified.filePath)) !== verified.sha256) {
    verifiedBackupSelection = null;
    throw new Error("The checked backup changed; run preflight again");
  }
  const confirmation = await dialog.showMessageBox(mainWindow, {
    type: "warning",
    title: `恢复 ${PRODUCT_NAME} 工作区`,
    message: "替换当前本地工作区？",
    detail: `${PRODUCT_NAME} 将停止本地服务、再次验证备份并替换当前数据。如果恢复后的服务无法启动，当前工作区会自动还原。`,
    buttons: ["取消", "恢复工作区"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  if (confirmation.response !== 1) return { restored: false, canceled: true };

  const backendDir = path.join(resourceRoot(), "backend");
  const backupModule = path.join(backendDir, "dist", "desktopBackup.js");
  let rollback = null;
  let servicesStopped = false;
  try {
    await stopServicesAndWait();
    servicesStopped = true;
    const output = await runUtilityOnce("encrypted restore", backupModule, {
      cwd: backendDir,
      args: [
        "restore",
        "--input",
        verified.filePath,
        "--target",
        localDataDir(),
        "--pending-record",
        pendingRestorePath(),
        "--key-base64-env",
        "ALETHEIA_BACKUP_KEY_BASE64",
      ],
      env: { ALETHEIA_BACKUP_KEY_BASE64: derivedBackupKeyBase64() },
      timeoutMs: 30 * 60_000,
    });
    const result = parseBackupUtilityResult(output, "restore");
    const paths = validatedRollbackPath(result.rollback_path);
    rollback = paths.rollback;
    if (process.env.ALETHEIA_TEST_EXIT_AFTER_RESTORE_SWAP === "true") {
      app.exit(91);
      return new Promise(() => undefined);
    }
    try {
      await startServices();
      appendRestoreJournal({
        createdAt: result.created_at,
        backupSha256: verified.sha256,
        files: result.files,
        bytes: result.plaintext_bytes,
      });
      servicesStopped = false;
    } catch (startError) {
      await stopServicesAndWait().catch(() => undefined);
      fs.rmSync(paths.target, { recursive: true, force: true });
      fs.renameSync(paths.rollback, paths.target);
      rollback = null;
      clearPendingRestoreRecord();
      try {
        await startServices();
        servicesStopped = false;
      } catch (rollbackStartError) {
        throw new Error(
          `Restored services failed to start and the prior workspace could not restart: ${rollbackStartError instanceof Error ? rollbackStartError.message : String(rollbackStartError)}`,
        );
      }
      throw new Error(
        `Restored services failed to start; the prior workspace was reinstated: ${startError instanceof Error ? startError.message : String(startError)}`,
      );
    }
    fs.rmSync(rollback, { recursive: true, force: true });
    rollback = null;
    clearPendingRestoreRecord();
    verifiedBackupSelection = null;
    return {
      restored: true,
      canceled: false,
      createdAt: result.created_at,
      files: result.files,
      bytes: result.plaintext_bytes,
    };
  } catch (error) {
    if (servicesStopped) {
      reconcilePendingRestore();
      await startServices().catch(() => undefined);
    }
    throw error;
  }
}

async function openLocalDirectory(kind) {
  const target = kind === "data" ? localDataDir() : app.getPath("logs");
  fs.mkdirSync(target, {
    recursive: true,
    mode: kind === "data" ? 0o700 : 0o755,
  });
  if (kind === "data") fs.chmodSync(target, 0o700);
  const error = await shell.openPath(target);
  if (error) throw new Error(error);
  return { opened: true };
}

function safeDocxFilename(value) {
  const normalized = String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f/\\:]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);
  const base = normalized || `${PRODUCT_NAME} litigation artifact`;
  return base.toLowerCase().endsWith(".docx") ? base : `${base}.docx`;
}

function safeCalendarFilename(value) {
  const normalized = String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f/\\:]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);
  const base = normalized || `${PRODUCT_NAME} Work Queue`;
  return base.toLowerCase().endsWith(".ics") ? base : `${base}.ics`;
}

function cleanNotificationText(value, maximum, label) {
  const result = String(value ?? "")
    .replace(/[\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximum);
  if (!result) throw new Error(`${label} is required`);
  return result;
}

function showNativeNotification(input) {
  if (!Notification.isSupported()) {
    return { supported: false, shown: false };
  }
  const title = cleanNotificationText(input?.title, 120, "Notification title");
  const body = cleanNotificationText(input?.body, 600, "Notification body");
  const tag = cleanNotificationText(
    input?.tag || crypto.randomUUID(),
    180,
    "Notification tag",
  );
  const href = input?.href == null ? null : String(input.href);
  if (
    href !== null &&
    (!href.startsWith("/aletheia/") ||
      href.includes("\\") ||
      href.includes("\0"))
  ) {
    throw new Error(
      `Notification destination must stay inside ${PRODUCT_NAME}`,
    );
  }

  const previous = activeNotifications.get(tag);
  if (previous) previous.close();
  const notification = new Notification({ title, body, silent: false });
  activeNotifications.set(tag, notification);
  notification.on("click", () => {
    if (href) void navigateWorkspace(href);
  });
  notification.on("close", () => {
    if (activeNotifications.get(tag) === notification) {
      activeNotifications.delete(tag);
    }
  });
  notification.show();
  return { supported: true, shown: true };
}

function dismissNativeNotification(value) {
  const tag = cleanNotificationText(value, 180, "Notification tag");
  const notification = activeNotifications.get(tag);
  if (!notification) return { dismissed: false };
  activeNotifications.delete(tag);
  notification.close();
  return { dismissed: true };
}

function assertOpaqueIdentifier(value, label) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,160}$/.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

async function saveLitigationArtifactDownload(input) {
  const matterId = assertOpaqueIdentifier(input?.matterId, "matter ID");
  const exportId = assertOpaqueIdentifier(input?.exportId, "export ID");
  const suggestedName = safeDocxFilename(input?.suggestedName);
  const response = await fetch(
    `${BACKEND_URL}/aletheia/matters/${matterId}/litigation/exports/${exportId}/download`,
    {
      headers: {
        Accept:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        Authorization: `Bearer ${DESKTOP_SESSION_TOKEN}`,
      },
      signal: AbortSignal.timeout(60_000),
    },
  );
  if (!response.ok) {
    const body = await response.text();
    let detail = `Artifact download failed (${response.status})`;
    try {
      const parsed = JSON.parse(body);
      if (typeof parsed.detail === "string" && parsed.detail) {
        detail = parsed.detail;
      }
    } catch {
      // Keep the bounded status message for a non-JSON backend response.
    }
    throw new Error(detail);
  }
  const mimeType = response.headers.get("content-type")?.split(";", 1)[0];
  if (
    mimeType !==
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    throw new Error("Backend returned an unexpected artifact type");
  }
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > 200 * 1024 * 1024) {
    throw new Error("Artifact exceeds the 200 MB desktop save limit");
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (
    bytes.length === 0 ||
    bytes.length > 200 * 1024 * 1024 ||
    bytes[0] !== 0x50 ||
    bytes[1] !== 0x4b
  ) {
    throw new Error("Downloaded artifact is not a valid DOCX container");
  }
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw new Error(`The ${PRODUCT_NAME} window is unavailable`);
  }
  const selection = await dialog.showSaveDialog(mainWindow, {
    title: "Save approved litigation document",
    defaultPath: path.join(app.getPath("documents"), suggestedName),
    buttonLabel: input?.openAfterSave ? "Save and Open" : "Save",
    filters: [{ name: "Microsoft Word Document", extensions: ["docx"] }],
    properties: ["showOverwriteConfirmation", "createDirectory"],
  });
  if (selection.canceled || !selection.filePath) {
    return { saved: false, canceled: true, opened: false };
  }
  const destination = selection.filePath.toLowerCase().endsWith(".docx")
    ? selection.filePath
    : `${selection.filePath}.docx`;
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${crypto.randomUUID()}.tmp`,
  );
  let descriptor = null;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporary, destination);
    fs.chmodSync(destination, 0o600);
  } catch (error) {
    if (descriptor !== null) fs.closeSync(descriptor);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    throw error;
  }
  let opened = false;
  let openError = null;
  if (input?.openAfterSave === true) {
    openError = await shell.openPath(destination);
    opened = !openError;
  }
  return {
    saved: true,
    canceled: false,
    opened,
    openError: openError || null,
    filePath: destination,
  };
}

async function saveOriginalMatterDocument(input) {
  const matterId = assertOpaqueIdentifier(input?.matterId, "matter ID");
  const documentId = assertOpaqueIdentifier(input?.documentId, "document ID");
  const response = await fetch(
    `${BACKEND_URL}/aletheia/matters/${matterId}/documents/${documentId}/original`,
    {
      headers: {
        Accept: Array.from(MIME_EXTENSIONS.keys()).join(", "),
        Authorization: `Bearer ${DESKTOP_SESSION_TOKEN}`,
      },
      signal: AbortSignal.timeout(60_000),
    },
  );
  if (!response.ok) {
    const body = await response.text();
    let detail = `Original document access failed (${response.status})`;
    try {
      const parsed = JSON.parse(body);
      if (typeof parsed.detail === "string" && parsed.detail)
        detail = parsed.detail;
    } catch {
      // Keep the bounded status message for a non-JSON backend response.
    }
    throw new Error(detail);
  }
  const mimeType = response.headers.get("content-type")?.split(";", 1)[0] ?? "";
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > MAX_ORIGINAL_BYTES) {
    throw new Error("Original document exceeds the 100 MB desktop limit");
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  validateOriginalDocumentBytes({
    bytes,
    mimeType,
    expectedSha256: response.headers.get("x-aletheia-content-sha256"),
    contentLength,
  });
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw new Error(`The ${PRODUCT_NAME} window is unavailable`);
  }
  const suggestedName = safeOriginalFilename(input?.suggestedName, mimeType);
  const extensions = MIME_EXTENSIONS.get(mimeType);
  const selection = await dialog.showSaveDialog(mainWindow, {
    title: "Save original evidence",
    defaultPath: path.join(app.getPath("documents"), suggestedName),
    buttonLabel: input?.openAfterSave ? "Save and Open" : "Save",
    filters: [{ name: "Original evidence", extensions }],
    properties: ["showOverwriteConfirmation", "createDirectory"],
  });
  if (selection.canceled || !selection.filePath) {
    return { saved: false, canceled: true, opened: false };
  }
  const destination = path.join(
    path.dirname(selection.filePath),
    safeOriginalFilename(path.basename(selection.filePath), mimeType),
  );
  if (input?.openAfterSave === true) {
    const confirmation = await dialog.showMessageBox(mainWindow, {
      type: "warning",
      title: "Open original evidence?",
      message: "Original files can contain active or unsafe content.",
      detail:
        "Vera verified this file against the stored import hash, but that does not establish authenticity or make the content safe. Open it only if you trust the source and your endpoint protections are active.",
      buttons: ["Cancel", "Save and Open"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (confirmation.response !== 1) {
      return { saved: false, canceled: true, opened: false };
    }
  }
  const savedPath = writeOwnerOnlyFileAtomically(destination, bytes);
  let opened = false;
  let openError = null;
  if (input?.openAfterSave === true) {
    openError = await shell.openPath(savedPath);
    opened = !openError;
  }
  return {
    saved: true,
    canceled: false,
    opened,
    openError: openError || null,
    filePath: savedPath,
  };
}

async function saveTaskCalendar(input) {
  const status = input?.status ?? "open";
  if (!new Set(["open", "completed", "all"]).has(status)) {
    throw new Error("Invalid task calendar status");
  }
  const response = await fetch(
    `${BACKEND_URL}/aletheia/tasks/calendar.ics?status=${encodeURIComponent(status)}`,
    {
      headers: {
        Accept: "text/calendar",
        Authorization: `Bearer ${DESKTOP_SESSION_TOKEN}`,
      },
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) {
    const body = await response.text();
    let detail = `Calendar export failed (${response.status})`;
    try {
      const parsed = JSON.parse(body);
      if (typeof parsed.detail === "string" && parsed.detail) {
        detail = parsed.detail;
      }
    } catch {
      // Keep the bounded status message for a non-JSON backend response.
    }
    throw new Error(detail);
  }
  const mimeType = response.headers.get("content-type")?.split(";", 1)[0];
  if (mimeType !== "text/calendar") {
    throw new Error("Backend returned an unexpected calendar type");
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const text = bytes.toString("utf8");
  if (
    bytes.length === 0 ||
    bytes.length > 5 * 1024 * 1024 ||
    !text.startsWith("BEGIN:VCALENDAR\r\n") ||
    !text.endsWith("END:VCALENDAR\r\n")
  ) {
    throw new Error("Downloaded task calendar is invalid");
  }
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw new Error(`The ${PRODUCT_NAME} window is unavailable`);
  }
  const suggestedName = safeCalendarFilename(input?.suggestedName);
  const selection = await dialog.showSaveDialog(mainWindow, {
    title: "Save work queue calendar",
    defaultPath: path.join(app.getPath("documents"), suggestedName),
    buttonLabel: input?.openAfterSave ? "Save and Open" : "Save",
    filters: [{ name: "Calendar", extensions: ["ics"] }],
    properties: ["showOverwriteConfirmation", "createDirectory"],
  });
  if (selection.canceled || !selection.filePath) {
    return { saved: false, canceled: true, opened: false };
  }
  const destination = selection.filePath.toLowerCase().endsWith(".ics")
    ? selection.filePath
    : `${selection.filePath}.ics`;
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${crypto.randomUUID()}.tmp`,
  );
  let descriptor = null;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporary, destination);
    fs.chmodSync(destination, 0o600);
  } catch (error) {
    if (descriptor !== null) fs.closeSync(descriptor);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    throw error;
  }
  let opened = false;
  let openError = null;
  if (input?.openAfterSave === true) {
    openError = await shell.openPath(destination);
    opened = !openError;
  }
  return {
    saved: true,
    canceled: false,
    opened,
    openError: openError || null,
    filePath: destination,
  };
}

async function restartServices() {
  if (restartingServices) return restartingServices;
  restartingServices = (async () => {
    await stopServicesAndWait();
    await startServices();
    if (mainWindow && !mainWindow.isDestroyed()) {
      await mainWindow.loadURL(`${FRONTEND_URL}${WORKSPACE_PATH}`);
    }
    return { restarted: true };
  })().finally(() => {
    restartingServices = null;
  });
  return restartingServices;
}

async function applyAuditAnchorConfiguration(nextConfig) {
  if (changingAuditAnchor) return changingAuditAnchor;
  changingAuditAnchor = (async () => {
    const userDataDir = app.getPath("userData");
    const previous = snapshotAuditAnchorConfig(userDataDir);
    await stopServicesAndWait();
    try {
      writeAuditAnchorConfigAtomically(userDataDir, nextConfig);
      await startServices();
      if (mainWindow && !mainWindow.isDestroyed()) {
        await mainWindow.loadURL(`${FRONTEND_URL}/settings`);
      }
      return getAuditAnchorConfiguration();
    } catch (error) {
      await stopServicesAndWait().catch(() => undefined);
      let rollbackError = null;
      try {
        restoreAuditAnchorConfigAtomically(userDataDir, previous);
        await startServices();
        if (mainWindow && !mainWindow.isDestroyed()) {
          await mainWindow.loadURL(`${FRONTEND_URL}/settings`);
        }
      } catch (reason) {
        rollbackError =
          reason instanceof Error ? reason.message : String(reason);
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        rollbackError
          ? `Audit anchor change failed and prior services could not be restored: ${message}; rollback: ${rollbackError}`
          : `Audit anchor change failed; previous configuration was restored: ${message}`,
      );
    }
  })().finally(() => {
    changingAuditAnchor = null;
  });
  return changingAuditAnchor;
}

async function configureAuditAnchor() {
  if (hasExternallyManagedAnchorEnvironment()) {
    throw new Error(
      "Audit anchoring is managed by the launch environment and is read-only here.",
    );
  }
  const selection = await dialog.showOpenDialog(mainWindow, {
    title: "Choose external audit anchor location",
    properties: ["openDirectory", "createDirectory"],
    buttonLabel: "Choose",
  });
  if (selection.canceled || selection.filePaths.length !== 1) {
    return {
      changed: false,
      canceled: true,
      configuration: getAuditAnchorConfiguration(),
    };
  }
  const externalParent = selection.filePaths[0];
  const confirmation = await dialog.showMessageBox(mainWindow, {
    type: "warning",
    title: "Enable external audit anchoring?",
    message:
      "Vera will create an owner-only signed audit journal in the selected directory and restart local services.",
    detail:
      "The private key stays in Vera's owner-only application directory and is never exposed to the workspace UI. This is not a qualified electronic signature, trusted timestamp, notarization, or WORM guarantee.",
    buttons: ["Cancel", "Enable and restart"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  if (confirmation.response !== 1) {
    return {
      changed: false,
      canceled: true,
      configuration: getAuditAnchorConfiguration(),
    };
  }
  const next = provisionAuditAnchorConfiguration({
    userDataDir: app.getPath("userData"),
    localDataDirectory: localDataDir(),
    externalParent,
  });
  return {
    changed: true,
    canceled: false,
    configuration: await applyAuditAnchorConfiguration(next),
  };
}

async function disableAuditAnchor() {
  if (hasExternallyManagedAnchorEnvironment()) {
    throw new Error(
      "Audit anchoring is managed by the launch environment and is read-only here.",
    );
  }
  const current = getAuditAnchorConfiguration();
  if (!current.enabled) {
    return { changed: false, canceled: false, configuration: current };
  }
  const confirmation = await dialog.showMessageBox(mainWindow, {
    type: "warning",
    title: "Disable external audit anchoring?",
    message:
      "Vera will stop writing new audit anchors and restart local services.",
    detail:
      "Existing keys and signed journal entries will be preserved for verification and later re-enablement.",
    buttons: ["Cancel", "Disable and restart"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  if (confirmation.response !== 1) {
    return { changed: false, canceled: true, configuration: current };
  }
  const next = disabledAuditAnchorConfiguration(app.getPath("userData"));
  return {
    changed: true,
    canceled: false,
    configuration: await applyAuditAnchorConfiguration(next),
  };
}

async function navigateWorkspace(pathname) {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  if (!servicesReady) {
    await boot();
    if (!servicesReady) return;
  }
  await mainWindow.loadURL(`${FRONTEND_URL}${pathname}`);
  mainWindow.show();
  mainWindow.focus();
}

function installApplicationMenu() {
  const template = [
    ...(process.platform === "darwin"
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          },
        ]
      : []),
    {
      label: "文件",
      submenu: [
        {
          label: "打开数据文件夹",
          click: () => void openLocalDirectory("data"),
        },
        {
          label: "打开日志文件夹",
          click: () => void openLocalDirectory("logs"),
        },
        ...(process.platform === "darwin"
          ? []
          : [{ type: "separator" }, { role: "quit" }]),
      ],
    },
    {
      label: "编辑",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "显示",
      submenu: [
        { role: "reload" },
        { role: "toggleDevTools", visible: !app.isPackaged },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "窗口",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        ...(process.platform === "darwin"
          ? [{ type: "separator" }, { role: "front" }]
          : [{ role: "close" }]),
      ],
    },
    {
      label: "帮助",
      submenu: [
        {
          label: "重新启动本地服务",
          click: () => void restartServices(),
        },
        {
          label: "打开日志文件夹",
          click: () => void openLocalDirectory("logs"),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function registerIpc() {
  function assertTrustedSender(event) {
    const senderUrl = event.senderFrame?.url ?? "";
    if (!senderUrl.startsWith(`${FRONTEND_URL}/`)) {
      throw new Error("Untrusted desktop IPC sender");
    }
  }

  ipcMain.handle("aletheia:get-info", (event) => {
    assertTrustedSender(event);
    const encryptionPolicy =
      activeEncryptionPolicy ?? desktopEncryptionPolicy();
    return {
      appVersion: app.getVersion(),
      backendUrl: BACKEND_URL,
      workspaceApiUrl: `${BACKEND_URL.replace(/\/$/, "")}/api/v1`,
      frontendUrl: FRONTEND_URL,
      localClient: true,
      encryptedVolumeAttested: encryptedVolumeAttested(),
      applicationEncryption: encryptionPolicy.applicationEncryption,
      databaseEncryption: encryptionPolicy.databaseEncryption,
    };
  });

  ipcMain.handle("aletheia:get-auth-token", (event) => {
    assertTrustedSender(event);
    return DESKTOP_SESSION_TOKEN;
  });

  ipcMain.handle("aletheia:open-data-directory", async (event) => {
    assertTrustedSender(event);
    return openLocalDirectory("data");
  });

  ipcMain.handle("aletheia:open-logs-directory", async (event) => {
    assertTrustedSender(event);
    return openLocalDirectory("logs");
  });

  ipcMain.handle("aletheia:export-diagnostics", async (event) => {
    assertTrustedSender(event);
    return exportRedactedDiagnosticBundle();
  });

  ipcMain.handle("aletheia:restart-local-services", async (event) => {
    assertTrustedSender(event);
    return restartServices();
  });

  ipcMain.handle("aletheia:get-audit-anchor-configuration", (event) => {
    assertTrustedSender(event);
    return getAuditAnchorConfiguration();
  });

  ipcMain.handle("aletheia:configure-audit-anchor", async (event) => {
    assertTrustedSender(event);
    return configureAuditAnchor();
  });

  ipcMain.handle("aletheia:disable-audit-anchor", async (event) => {
    assertTrustedSender(event);
    return disableAuditAnchor();
  });

  ipcMain.handle("aletheia:create-encrypted-backup", async (event) => {
    assertTrustedSender(event);
    return createEncryptedBackup();
  });

  ipcMain.handle("aletheia:inspect-encrypted-backup", async (event) => {
    assertTrustedSender(event);
    return inspectEncryptedBackup();
  });

  ipcMain.handle("aletheia:restore-encrypted-backup", async (event) => {
    assertTrustedSender(event);
    return restoreEncryptedBackup();
  });

  ipcMain.handle("aletheia:save-litigation-artifact", async (event, input) => {
    assertTrustedSender(event);
    return saveLitigationArtifactDownload(input);
  });

  ipcMain.handle(
    "aletheia:save-original-matter-document",
    async (event, input) => {
      assertTrustedSender(event);
      return saveOriginalMatterDocument(input);
    },
  );

  ipcMain.handle("aletheia:notification-support", (event) => {
    assertTrustedSender(event);
    return { supported: Notification.isSupported() };
  });

  ipcMain.handle("aletheia:show-notification", (event, input) => {
    assertTrustedSender(event);
    return showNativeNotification(input);
  });

  ipcMain.handle("aletheia:dismiss-notification", (event, tag) => {
    assertTrustedSender(event);
    return dismissNativeNotification(tag);
  });

  ipcMain.handle("aletheia:save-task-calendar", async (event, input) => {
    assertTrustedSender(event);
    return saveTaskCalendar(input);
  });
}

async function handleUnexpectedServiceExit(label, code) {
  if (
    handlingUnexpectedServiceFailure ||
    serviceShutdownExpected ||
    quitShutdownStarted ||
    quitAfterServiceStop
  ) {
    return handlingUnexpectedServiceFailure;
  }
  handlingUnexpectedServiceFailure = (async () => {
    desktopLog("error", "desktop", "required_service_stopped", {
      service: label,
      code,
    });
    await stopServicesAndWait().catch((error) => {
      desktopLog("error", "desktop", "service_cleanup_failed", { error });
    });
    if (!mainWindow || mainWindow.isDestroyed()) {
      app.quit();
      return;
    }
    await mainWindow
      .loadURL(
        `data:text/html;charset=utf-8,${encodeURIComponent(
          loadingHtml("必要的本地服务已停止，Vera 已安全关闭其余服务。"),
        )}`,
      )
      .catch(() => undefined);
    const result = await dialog.showMessageBox(mainWindow, {
      type: "error",
      title: `${PRODUCT_NAME} 本地服务已停止`,
      message: "必要的本地工作区服务意外停止。",
      detail: `${label} 已退出（代码 ${code ?? "未知"}）。本地数据仍保留在此设备上。`,
      buttons: ["重新启动服务", "打开日志", "退出"],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    if (result.response === 0) {
      await boot();
      return;
    }
    if (result.response === 1) {
      await openLocalDirectory("logs");
      await boot();
      return;
    }
    app.quit();
  })().finally(() => {
    handlingUnexpectedServiceFailure = null;
  });
  return handlingUnexpectedServiceFailure;
}

async function boot() {
  try {
    if (!servicesReady) reconcilePendingRestore();
    if (!mainWindow || mainWindow.isDestroyed()) createWindow();
    if (!servicesReady) await startServices();
    await mainWindow.loadURL(`${FRONTEND_URL}${WORKSPACE_PATH}`);
  } catch (error) {
    desktopLog("error", "desktop", "startup_failed", { error });
    await stopServicesAndWait().catch((stopError) => {
      desktopLog("error", "desktop", "startup_cleanup_failed", {
        error: stopError,
      });
    });
    if (quitShutdownStarted || quitAfterServiceStop) return;
    if (explicitUserDataDirectory) {
      exitAfterIsolatedProfileFailure(error, "startup_failed");
      return;
    }
    const detail =
      redactText(error instanceof Error ? error.message : String(error)) ||
      "本地运行时报告了已脱敏的启动错误。";
    const errorDialogOptions = {
      type: "error",
      title: `${PRODUCT_NAME} 无法启动`,
      message: "本地工作区服务未能启动。",
      detail,
      buttons: ["重试", "打开日志", "退出"],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    };
    const result =
      mainWindow && !mainWindow.isDestroyed()
        ? await dialog.showMessageBox(mainWindow, errorDialogOptions)
        : await dialog.showMessageBox(errorDialogOptions);
    if (result.response === 0) return boot();
    if (result.response === 1) {
      await openLocalDirectory("logs");
      return boot();
    }
    app.quit();
  }
}

if (singleInstanceLockAcquired) {
  app.on("second-instance", () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      void boot();
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app
    .whenReady()
    .then(() => {
      configureDesktopSessionSecurity();
      registerIpc();
      installApplicationMenu();
      return boot();
    })
    .catch((error) => {
      if (explicitUserDataDirectory) {
        exitAfterIsolatedProfileFailure(error, "bootstrap_failed");
        return;
      }
      desktopLog("error", "desktop", "bootstrap_failed", { error });
      const detail =
        redactText(error instanceof Error ? error.message : String(error)) ||
        "本地运行时报告了已脱敏的启动错误。";
      dialog.showErrorBox(
        `${PRODUCT_NAME} 无法启动`,
        `本地客户端初始化失败。\n\n${detail}`,
      );
      app.exit(1);
    });

  app.on("before-quit", (event) => {
    if (quitAfterServiceStop) return;
    event.preventDefault();
    if (quitShutdownStarted) return;
    quitShutdownStarted = true;
    void stopServicesAndWait()
      .catch((error) => {
        desktopLog("error", "desktop", "shutdown_cleanup_failed", { error });
      })
      .finally(() => {
        quitAfterServiceStop = true;
        app.quit();
      });
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void boot();
  });
}
