const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  ASSURANCE_TEXT,
  auditAnchorPaths,
  disabledAuditAnchorConfiguration,
  ensureAuditAnchorKeyPair,
  hasExternallyManagedAnchorEnvironment,
  localAuditAnchorEnvironment,
  provisionAuditAnchorConfiguration,
  publicAuditAnchorConfiguration,
  readAuditAnchorConfig,
  restoreAuditAnchorConfigAtomically,
  snapshotAuditAnchorConfig,
  validateExternalParent,
  writeAuditAnchorConfigAtomically,
} = require("../auditAnchorConfig");

const root = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "vera-anchor-config-")),
);
try {
  const userDataDir = path.join(root, "user-data");
  const localDataDirectory = path.join(userDataDir, "aletheia-data");
  const externalParent = path.join(root, "external");
  fs.mkdirSync(localDataDirectory, { recursive: true, mode: 0o700 });
  fs.mkdirSync(externalParent, { recursive: true, mode: 0o700 });

  assert.throws(
    () => validateExternalParent(localDataDirectory, localDataDirectory),
    /cannot be inside local data/i,
  );
  if (process.platform !== "win32") {
    const symlink = path.join(root, "external-link");
    fs.symlinkSync(externalParent, symlink);
    assert.throws(
      () => validateExternalParent(symlink, localDataDirectory),
      /symbolic links/i,
    );
  }

  const configured = provisionAuditAnchorConfiguration({
    userDataDir,
    localDataDirectory,
    externalParent,
  });
  assert.equal(configured.enabled, true);
  assert.match(configured.keyId, /^[a-f0-9]{24}$/);
  assert.equal(configured.journalDirectory.startsWith(externalParent), true);
  assert.equal(fs.statSync(configured.journalDirectory).mode & 0o777, 0o700);

  const paths = auditAnchorPaths(userDataDir);
  assert.equal(fs.statSync(paths.privateKeyFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(paths.publicKeyFile).mode & 0o777, 0o644);
  const reused = ensureAuditAnchorKeyPair(userDataDir);
  assert.equal(reused.reused, true);
  assert.equal(reused.keyId, configured.keyId);

  writeAuditAnchorConfigAtomically(userDataDir, configured);
  assert.deepEqual(readAuditAnchorConfig(userDataDir), configured);
  assert.equal(fs.statSync(paths.configFile).mode & 0o777, 0o600);
  const localEnvironment = localAuditAnchorEnvironment(userDataDir);
  assert.equal(localEnvironment.ALETHEIA_AUDIT_ANCHOR_ENABLED, "true");
  assert.equal(
    localEnvironment.ALETHEIA_AUDIT_ANCHOR_HIGH_ASSURANCE,
    "true",
    "desktop-managed anchoring must fail closed when the journal cannot advance",
  );
  assert.equal(localEnvironment.ALETHEIA_AUDIT_ANCHOR_INTERVAL_MS, "900000");
  assert.equal(localEnvironment.ALETHEIA_AUDIT_ANCHOR_DIR, configured.journalDirectory);

  const publicState = publicAuditAnchorConfiguration({
    config: configured,
    managedExternally: false,
    environment: {},
  });
  assert.equal(publicState.enabled, true);
  assert.equal(publicState.keyId, configured.keyId);
  const serializedPublic = JSON.stringify(publicState);
  assert.doesNotMatch(serializedPublic, /private-key|BEGIN PRIVATE|PRIVATE_KEY_FILE/i);
  assert.match(publicState.status, /not a qualified electronic signature/i);
  assert.match(ASSURANCE_TEXT, /notarization.*WORM/i);

  const snapshot = snapshotAuditAnchorConfig(userDataDir);
  const disabled = disabledAuditAnchorConfiguration(userDataDir);
  writeAuditAnchorConfigAtomically(userDataDir, disabled);
  assert.equal(localAuditAnchorEnvironment(userDataDir).ALETHEIA_AUDIT_ANCHOR_ENABLED, "false");
  assert.equal(fs.existsSync(paths.privateKeyFile), true);
  assert.equal(fs.existsSync(configured.journalDirectory), true);
  restoreAuditAnchorConfigAtomically(userDataDir, snapshot);
  assert.equal(readAuditAnchorConfig(userDataDir).enabled, true);

  const externalEnvironment = {
    ALETHEIA_AUDIT_ANCHOR_ENABLED: "true",
    ALETHEIA_AUDIT_ANCHOR_DIR: "/operator/journal",
    ALETHEIA_AUDIT_ANCHOR_PRIVATE_KEY_FILE: "/operator/private.pem",
  };
  assert.equal(hasExternallyManagedAnchorEnvironment(externalEnvironment), true);
  const externalState = publicAuditAnchorConfiguration({
    config: null,
    managedExternally: true,
    environment: externalEnvironment,
  });
  assert.equal(externalState.managedExternally, true);
  assert.equal(externalState.keyId, null);
  assert.doesNotMatch(JSON.stringify(externalState), /private\.pem/);

  const main = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  const preload = fs.readFileSync(path.join(__dirname, "..", "preload.js"), "utf8");
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"),
  );
  assert.match(main, /applyAuditAnchorConfiguration/);
  assert.match(main, /restoreAuditAnchorConfigAtomically/);
  assert.match(main, /aletheia:configure-audit-anchor/);
  assert.match(main, /aletheia:disable-audit-anchor/);
  assert.match(preload, /getAuditAnchorConfiguration/);
  assert.match(preload, /configureAuditAnchor/);
  assert.match(preload, /disableAuditAnchor/);
  assert(packageJson.build.files.includes("auditAnchorConfig.js"));

  console.log(
    JSON.stringify(
      {
        ok: true,
        suite: "vera-desktop-audit-anchor-config-v1",
        checks: [
          "external path and symlink rejection",
          "owner-only Ed25519 key provisioning, reuse, and fail-closed runtime",
          "atomic owner-only configuration persistence and restore",
          "disabled configuration preserves keys and journal",
          "environment-managed read-only precedence",
          "renderer response excludes private key material",
          "IPC and packaged file contracts",
        ],
      },
      null,
      2,
    ),
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
