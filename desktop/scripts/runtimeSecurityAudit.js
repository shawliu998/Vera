"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const desktopRoot = path.resolve(__dirname, "..");
const main = fs.readFileSync(path.join(desktopRoot, "main.js"), "utf8");
const preload = fs.readFileSync(path.join(desktopRoot, "preload.js"), "utf8");
const encryptionPolicy = fs.readFileSync(
  path.join(desktopRoot, "encryptionPolicy.js"),
  "utf8",
);
const desktopPackage = JSON.parse(
  fs.readFileSync(path.join(desktopRoot, "package.json"), "utf8"),
);
const packagedAppSmoke = fs.readFileSync(
  path.join(desktopRoot, "scripts", "packagedAppSmoke.js"),
  "utf8",
);
const frontendProxy = fs.readFileSync(
  path.join(desktopRoot, "..", "frontend", "src", "proxy.ts"),
  "utf8",
);
const frontendLayout = fs.readFileSync(
  path.join(desktopRoot, "..", "frontend", "src", "app", "layout.tsx"),
  "utf8",
);
const workspaceRuntime = fs.readFileSync(
  path.join(
    desktopRoot,
    "..",
    "backend",
    "src",
    "lib",
    "workspace",
    "runtime.ts",
  ),
  "utf8",
);
const genericTransport = fs.readFileSync(
  path.join(
    desktopRoot,
    "..",
    "backend",
    "src",
    "lib",
    "workspace",
    "providers",
    "hardenedGenericTransport.ts",
  ),
  "utf8",
);

const backendLocalConfigStart = main.indexOf(
  "const BACKEND_LOCAL_CONFIG_ENV_KEYS = [",
);
const backendLocalConfigEnd = main.indexOf("\n];", backendLocalConfigStart);
assert.ok(
  backendLocalConfigStart >= 0 && backendLocalConfigEnd > backendLocalConfigStart,
  "the backend local configuration allowlist must have an auditable static boundary",
);
const backendLocalConfigSource = main.slice(
  backendLocalConfigStart,
  backendLocalConfigEnd,
);

assert.match(
  main,
  /app\.requestSingleInstanceLock\(\)/,
  "the desktop must own one process lock for its local data directory",
);
const userDataBinding = main.indexOf(
  'app.setPath("userData", desktopUserDataDirectory)',
);
assert.match(
  main,
  /function canonicalLocalDataTarget\(\)[\s\S]*fs\.realpathSync\(path\.dirname\(target\)\)[\s\S]*const expectedTarget = canonicalLocalDataTarget\(\)/,
  "pending restore validation must canonicalize macOS parent aliases even when the swapped target is absent",
);
const sessionDataBinding = main.indexOf(
  'app.setPath("sessionData", desktopUserDataDirectory)',
);
const isolatedLogsBinding = main.indexOf(
  "app.setAppLogsPath(isolatedLogDirectory)",
);
const singletonBinding = main.indexOf("app.requestSingleInstanceLock()");
assert.ok(
  userDataBinding >= 0 && userDataBinding < singletonBinding,
  "the effective user-data override must be bound before acquiring the singleton lock",
);
assert.ok(
  sessionDataBinding >= 0 && sessionDataBinding < singletonBinding,
  "Chromium session state must follow the effective user-data directory",
);
assert.ok(
  isolatedLogsBinding >= 0 && isolatedLogsBinding < singletonBinding,
  "explicit profiles must keep their diagnostic logs isolated",
);
assert.match(
  main,
  /const isolatedLogDirectory = path\.join\(desktopUserDataDirectory, "logs"\)/,
  "explicit profile logs must be derived from the effective user-data directory",
);
assert.match(
  main,
  /desktopUserDataInfo\.isSymbolicLink\(\)/,
  "an explicit user-data path must reject a terminal symbolic link",
);
assert.match(
  main,
  /path\.isAbsolute\(explicitUserDataDirectory\)/,
  "an explicit user-data path must be absolute",
);
assert.match(
  main,
  /app\.on\("second-instance"/,
  "a second launch must focus the existing Vera window",
);
assert.match(
  main,
  /const WORKSPACE_PATH = "\/assistant"/,
  "the packaged client must open the real Assistant workspace by default",
);
const bootStart = main.indexOf("async function boot()");
const bootEnd = main.indexOf("\nif (singleInstanceLockAcquired)", bootStart);
const bootSource = main.slice(bootStart, bootEnd);
const pendingRestoreReconciliation = bootSource.indexOf(
  "reconcilePendingRestore()",
);
const rendererWindowCreation = bootSource.indexOf("createWindow()");
assert.ok(
  bootStart >= 0 &&
    bootEnd > bootStart &&
    pendingRestoreReconciliation >= 0 &&
    rendererWindowCreation > pendingRestoreReconciliation,
  "pending restore state must be reconciled before any renderer window is created during startup",
);
assert.doesNotMatch(
  main,
  /FRONTEND_URL}\/aletheia\/settings/,
  "desktop settings restarts must return to the Mike/Vera settings route",
);
assert.match(
  main,
  /const SERVICE_STOP_ORDER = \["frontend", "backend", "credential worker"\]/,
  "renderer requests must stop before the backend, and the backend must release the credential channel before Keychain worker shutdown",
);
assert.match(
  main,
  /serviceChildren\.get\(label\) !== child \|\| !children\.has\(child\)/,
  "all three persistent services must still be alive before readiness is published",
);
assert.match(
  main,
  /servicesReady &&[\s\S]*?!serviceShutdownExpected[\s\S]*?handleUnexpectedServiceExit\(label, code\)/,
  "an unexpected persistent-service exit must invalidate the desktop runtime",
);
assert.match(
  main,
  /app\.on\("before-quit", \(event\) => \{[\s\S]*?event\.preventDefault\(\)[\s\S]*?stopServicesAndWait\(\)[\s\S]*?app\.quit\(\)/,
  "application quit must wait for the ordered local-service shutdown",
);
assert.match(main, /nodeIntegration: false/);
assert.match(main, /contextIsolation: true/);
assert.match(main, /sandbox: true/);
assert.match(main, /setWindowOpenHandler/);
assert.match(main, /will-navigate/);
assert.match(
  main,
  /setPermissionCheckHandler\(\(\) => false\)/,
  "ambient renderer permissions must be denied",
);
assert.match(
  main,
  /setPermissionRequestHandler\([\s\S]*?callback\(false\)/,
  "interactive renderer permission requests must be denied",
);
assert.match(main, /VERA_DESKTOP_CSP: "true"/);
assert.match(main, /VERA_DESKTOP_BACKEND_ORIGIN: BACKEND_URL/);
assert.match(
  main,
  /resolveDesktopEncryptionPolicy\(\{[\s\S]*?packaged: app\.isPackaged,[\s\S]*?environment: process\.env/,
  "the effective desktop encryption policy must know whether it is running from a package",
);
assert.match(
  encryptionPolicy,
  /packaged && applicationEncryption !== "required"/,
  "packaged Vera must reject an application-file-encryption downgrade",
);
assert.match(
  encryptionPolicy,
  /packaged && databaseEncryption !== "sqlcipher_required"/,
  "packaged Vera must reject a SQLCipher downgrade",
);
assert.match(
  main,
  /applicationEncryption: encryptionPolicy\.applicationEncryption,[\s\S]*?databaseEncryption: encryptionPolicy\.databaseEncryption/,
  "desktop info must report the active policy instead of hard-coded encryption claims",
);
assert.ok(
  desktopPackage.build.files.includes("encryptionPolicy.js"),
  "the packaged application must include its fail-closed encryption policy",
);
assert.match(
  main,
  /ALETHEIA_MODEL_CALL_LOG_DIR: path\.join\(app\.getPath\("logs"\), "vera"\)/,
  "the packaged backend must enable redacted rotating model-call diagnostics",
);
assert.match(
  main,
  /"ALETHEIA_MODEL_PROVIDER_ALLOW_LOOPBACK_HTTP"/,
  "the packaged E2E loopback-provider switch must use the explicit backend environment allowlist",
);
assert.doesNotMatch(
  backendLocalConfigSource,
  /VERA_ENABLE_LEGACY_(?:ROUTES|RUNTIME)/,
  "raw Legacy feature values must not enter the backend configuration passthrough allowlist",
);
assert.match(
  main,
  /VERA_ENABLE_LEGACY_ROUTES:\s*\n?\s*process\.env\.VERA_ENABLE_LEGACY_ROUTES === "true" \? "true" : "false"/,
  "Legacy routes must default off and require an exact parent true opt-in",
);
assert.match(
  main,
  /VERA_ENABLE_LEGACY_RUNTIME:\s*\n?\s*process\.env\.VERA_ENABLE_LEGACY_RUNTIME === "true" \? "true" : "false"/,
  "Legacy runtime must default off and require an exact parent true opt-in",
);
assert.match(
  main,
  /env:\s*\{[\s\S]*?selectedProcessEnvironment\(BACKEND_LOCAL_CONFIG_ENV_KEYS\),[\s\S]*?\.\.\.legacyFeatureEnvironment\(\),[\s\S]*?NODE_ENV: "production"/,
  "the formal backend environment must receive both normalized Legacy feature decisions",
);
assert.ok(
  desktopPackage.build.extraResources.some(
    (entry) => entry.to === "aletheia/backend/voice_sidecar",
  ),
  "Legacy voice resources must remain packaged until their removal gate is reached",
);
assert.match(
  packagedAppSmoke,
  /VERA_ENABLE_LEGACY_ROUTES: "false",[\s\S]*?VERA_ENABLE_LEGACY_RUNTIME: "false"/,
  "the formal packaged smoke must pin both Legacy surfaces off regardless of its parent shell",
);
assert.match(
  packagedAppSmoke,
  /health\?\.vera\?\.legacy\?\.status, "disabled"/,
  "the packaged smoke must require a truthful disabled Legacy health status",
);
assert.match(
  packagedAppSmoke,
  /legacyRoute\.status,[\s\S]*?404/,
  "the packaged smoke must prove that a retained Legacy route is not mounted by default",
);
assert.match(
  workspaceRuntime,
  /process\.env\.ALETHEIA_MODEL_PROVIDER_ALLOW_LOOPBACK_HTTP === "true"/,
  "the loopback-provider switch must be disabled unless its exact true value is supplied",
);
assert.match(
  genericTransport,
  /options\.allowLoopbackHttp \|\| !exactLoopback/,
  "the development switch must never permit HTTP to a non-loopback host",
);
assert.match(
  genericTransport,
  /addresses\.some\(\(entry\) => !isPublicGenericTransportAddress\(entry\.address\)\)/,
  "all public-provider DNS answers must be rejected when any answer is non-public",
);
assert.match(main, /contentSecurityPolicy\.includes\("'unsafe-eval'"\)/);
assert.match(main, /callback\(\{ cancel: true \}\)/);
assert.doesNotMatch(
  main,
  /VERA_DESKTOP_CSP:\s*"false"/,
  "the packaged renderer CSP must not be optional",
);
assert.match(frontendLayout, /export const dynamic = "force-dynamic"/);
assert.match(frontendProxy, /'nonce-\$\{nonce\}' 'strict-dynamic'/);
assert.match(frontendProxy, /connect-src 'self' \$\{backendOrigin\}/);
assert.match(frontendProxy, /value\.hostname !== "127\.0\.0\.1"/);
assert.doesNotMatch(frontendProxy, /script-src[^\n]*unsafe-eval/);
assert.doesNotMatch(
  preload,
  /require\("(?:node:)?(?:fs|child_process|net|http|https|tls)"\)/,
  "preload must not expose broad local or network modules",
);

console.log(
  JSON.stringify(
    {
      ok: true,
      suite: "vera-desktop-runtime-security-v1",
      checks: [
        "single-instance local-data ownership",
        "explicit profile data, session, and log isolation",
        "Assistant default startup route",
        "pending restore reconciliation before renderer creation",
        "ordered fail-closed local-service lifecycle",
        "sandboxed and isolated renderer",
        "navigation and window denial",
        "default-deny browser permissions",
        "packaged encryption downgrade rejection and truthful mode reporting",
        "exact loopback-only renderer connect policy",
        "default-off exact-loopback Generic provider test policy",
        "default-off exact-opt-in Legacy routes and runtime",
        "packaged health and route proof for disabled Legacy surfaces",
        "Legacy compatibility resources retained behind feature gates",
      ],
    },
    null,
    2,
  ),
);
