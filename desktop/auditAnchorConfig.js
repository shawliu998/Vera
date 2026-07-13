"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const AUDIT_ANCHOR_INTERVAL_MS = 900000;
const AUDIT_ANCHOR_ENV_KEYS = [
  "ALETHEIA_AUDIT_ANCHOR_ENABLED",
  "ALETHEIA_AUDIT_ANCHOR_HIGH_ASSURANCE",
  "ALETHEIA_AUDIT_ANCHOR_DIR",
  "ALETHEIA_AUDIT_ANCHOR_PRIVATE_KEY_FILE",
  "ALETHEIA_AUDIT_ANCHOR_PUBLIC_KEY_FILE",
  "ALETHEIA_AUDIT_ANCHOR_INTERVAL_MS",
  "ALETHEIA_AUDIT_ANCHOR_EXPECTED_HEAD_HASH",
];
const CONFIG_FILE_NAME = "audit-anchor-config.json";
const KEY_DIRECTORY_NAME = "audit-anchor-keys";
const JOURNAL_DIRECTORY_NAME = "Vera Audit Anchor Journal";
const ASSURANCE_TEXT =
  "Operator-key local audit anchoring only; not a qualified electronic signature, trusted timestamp, notarization, or WORM storage.";

function isPathInside(candidate, parent) {
  const resolvedCandidate = path.resolve(candidate);
  const resolvedParent = path.resolve(parent);
  return (
    resolvedCandidate === resolvedParent ||
    resolvedCandidate.startsWith(`${resolvedParent}${path.sep}`)
  );
}

function assertNoSymlinks(candidate) {
  const resolved = path.resolve(candidate);
  const parsed = path.parse(resolved);
  const relativeParts = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (const part of relativeParts) {
    current = path.join(current, part);
    const info = fs.lstatSync(current);
    if (info.isSymbolicLink()) {
      throw new Error("Audit anchor paths must not contain symbolic links.");
    }
  }
  return resolved;
}

function ensureOwnerOnlyDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const resolved = assertNoSymlinks(directory);
  const info = fs.statSync(resolved);
  if (!info.isDirectory()) {
    throw new Error("Audit anchor path must be a directory.");
  }
  fs.chmodSync(resolved, 0o700);
  return resolved;
}

function auditAnchorPaths(userDataDir) {
  const root = path.resolve(userDataDir);
  return {
    configFile: path.join(root, CONFIG_FILE_NAME),
    keyDirectory: path.join(root, KEY_DIRECTORY_NAME),
    privateKeyFile: path.join(root, KEY_DIRECTORY_NAME, "private-key.pem"),
    publicKeyFile: path.join(root, KEY_DIRECTORY_NAME, "public-key.pem"),
  };
}

function validateExternalParent(externalParent, localDataDirectory) {
  if (typeof externalParent !== "string" || !externalParent.trim()) {
    throw new Error("Choose an external directory for the audit anchor journal.");
  }
  const selected = assertNoSymlinks(externalParent);
  const info = fs.statSync(selected);
  if (!info.isDirectory()) {
    throw new Error("The audit anchor location must be a directory.");
  }
  if (isPathInside(selected, localDataDirectory)) {
    throw new Error("The audit anchor location cannot be inside local data.");
  }
  return selected;
}

function createDedicatedJournalDirectory(externalParent, localDataDirectory) {
  const parent = validateExternalParent(externalParent, localDataDirectory);
  const journalDirectory = path.join(parent, JOURNAL_DIRECTORY_NAME);
  if (isPathInside(journalDirectory, localDataDirectory)) {
    throw new Error("The audit anchor journal cannot be inside local data.");
  }
  return ensureOwnerOnlyDirectory(journalDirectory);
}

function keyIdFromPublicKey(publicKey) {
  const key = publicKey?.type === "public" ? publicKey : crypto.createPublicKey(publicKey);
  const publicDer = key.export({
    type: "spki",
    format: "der",
  });
  return crypto.createHash("sha256").update(publicDer).digest("hex").slice(0, 24);
}

function validateExistingKeyPair(paths) {
  assertNoSymlinks(paths.privateKeyFile);
  assertNoSymlinks(paths.publicKeyFile);
  const privateKey = crypto.createPrivateKey(fs.readFileSync(paths.privateKeyFile));
  const publicKey = crypto.createPublicKey(fs.readFileSync(paths.publicKeyFile));
  const derivedPublicDer = crypto.createPublicKey(privateKey).export({
    type: "spki",
    format: "der",
  });
  const publicDer = publicKey.export({ type: "spki", format: "der" });
  if (!Buffer.from(derivedPublicDer).equals(Buffer.from(publicDer))) {
    throw new Error("Existing audit anchor keys do not form a trusted pair.");
  }
  fs.chmodSync(paths.privateKeyFile, 0o600);
  fs.chmodSync(paths.publicKeyFile, 0o644);
  return keyIdFromPublicKey(publicKey);
}

function ensureAuditAnchorKeyPair(userDataDir) {
  const paths = auditAnchorPaths(userDataDir);
  ensureOwnerOnlyDirectory(paths.keyDirectory);
  const privateExists = fs.existsSync(paths.privateKeyFile);
  const publicExists = fs.existsSync(paths.publicKeyFile);
  if (privateExists || publicExists) {
    if (!privateExists || !publicExists) {
      throw new Error("Existing audit anchor keys are incomplete; refusing to replace them.");
    }
    return { ...paths, keyId: validateExistingKeyPair(paths), reused: true };
  }

  const pair = crypto.generateKeyPairSync("ed25519");
  const privatePem = pair.privateKey.export({ type: "pkcs8", format: "pem" });
  const publicPem = pair.publicKey.export({ type: "spki", format: "pem" });
  try {
    fs.writeFileSync(paths.privateKeyFile, privatePem, { mode: 0o600, flag: "wx" });
    fs.writeFileSync(paths.publicKeyFile, publicPem, { mode: 0o644, flag: "wx" });
    fs.chmodSync(paths.privateKeyFile, 0o600);
    fs.chmodSync(paths.publicKeyFile, 0o644);
  } catch (error) {
    // A partially created keypair is not trusted and is never silently replaced.
    throw new Error(
      `Unable to create audit anchor keys without replacing existing keys: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { ...paths, keyId: keyIdFromPublicKey(pair.publicKey), reused: false };
}

function assertConfigShape(config) {
  if (
    !config ||
    config.schema !== "vera-audit-anchor-config-v1" ||
    typeof config.enabled !== "boolean" ||
    (config.journalDirectory !== null && typeof config.journalDirectory !== "string") ||
    (config.keyId !== null && typeof config.keyId !== "string")
  ) {
    throw new Error("Audit anchor configuration is invalid.");
  }
  return config;
}

function readAuditAnchorConfig(userDataDir) {
  const { configFile } = auditAnchorPaths(userDataDir);
  if (!fs.existsSync(configFile)) return null;
  assertNoSymlinks(configFile);
  const info = fs.statSync(configFile);
  if (!info.isFile()) throw new Error("Audit anchor configuration must be a file.");
  try {
    return assertConfigShape(JSON.parse(fs.readFileSync(configFile, "utf8")));
  } catch (error) {
    if (error instanceof Error && error.message === "Audit anchor configuration is invalid.") {
      throw error;
    }
    throw new Error("Audit anchor configuration is invalid.");
  }
}

function writeAuditAnchorConfigAtomically(userDataDir, config) {
  const root = ensureOwnerOnlyDirectory(userDataDir);
  const { configFile } = auditAnchorPaths(root);
  const normalized = assertConfigShape(config);
  const temporary = path.join(
    root,
    `.${CONFIG_FILE_NAME}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`,
  );
  const descriptor = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(normalized)}\n`, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  try {
    fs.renameSync(temporary, configFile);
    fs.chmodSync(configFile, 0o600);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
  return normalized;
}

function snapshotAuditAnchorConfig(userDataDir) {
  const { configFile } = auditAnchorPaths(userDataDir);
  if (!fs.existsSync(configFile)) return null;
  assertNoSymlinks(configFile);
  return fs.readFileSync(configFile, "utf8");
}

function restoreAuditAnchorConfigAtomically(userDataDir, snapshot) {
  const { configFile } = auditAnchorPaths(userDataDir);
  if (snapshot !== null) {
    let parsed;
    try {
      parsed = JSON.parse(snapshot);
    } catch {
      throw new Error("Prior audit anchor configuration is invalid.");
    }
    return writeAuditAnchorConfigAtomically(userDataDir, parsed);
  }
  if (!fs.existsSync(configFile)) return null;
  assertNoSymlinks(configFile);
  const retired = `${configFile}.retired-${crypto.randomBytes(8).toString("hex")}`;
  fs.renameSync(configFile, retired);
  fs.rmSync(retired, { force: true });
  return null;
}

function hasExternallyManagedAnchorEnvironment(environment = process.env) {
  return AUDIT_ANCHOR_ENV_KEYS.some((key) => environment[key] !== undefined);
}

function publicAuditAnchorConfiguration({ config, managedExternally, environment = process.env }) {
  const externallyEnabled = environment.ALETHEIA_AUDIT_ANCHOR_ENABLED === "true";
  const enabled = managedExternally ? externallyEnabled : Boolean(config?.enabled);
  const journalDirectory = managedExternally
    ? environment.ALETHEIA_AUDIT_ANCHOR_DIR ?? null
    : config?.journalDirectory ?? null;
  const keyId = managedExternally ? null : config?.keyId ?? null;
  const state = enabled ? "Enabled." : "Disabled.";
  const ownership = managedExternally ? " Managed externally; controls are read-only." : "";
  return {
    enabled,
    managedExternally: Boolean(managedExternally),
    journalDirectory,
    keyId,
    status: `${state}${ownership} ${ASSURANCE_TEXT}`,
  };
}

function localAuditAnchorEnvironment(userDataDir) {
  const config = readAuditAnchorConfig(userDataDir);
  if (!config?.enabled) {
    return {
      ALETHEIA_AUDIT_ANCHOR_ENABLED: "false",
      ALETHEIA_AUDIT_ANCHOR_HIGH_ASSURANCE: "false",
    };
  }
  const keys = ensureAuditAnchorKeyPair(userDataDir);
  if (keys.keyId !== config.keyId) {
    throw new Error("Audit anchor configuration does not match its trusted keypair.");
  }
  return {
    ALETHEIA_AUDIT_ANCHOR_ENABLED: "true",
    ALETHEIA_AUDIT_ANCHOR_HIGH_ASSURANCE: "true",
    ALETHEIA_AUDIT_ANCHOR_DIR: config.journalDirectory,
    ALETHEIA_AUDIT_ANCHOR_PRIVATE_KEY_FILE: keys.privateKeyFile,
    ALETHEIA_AUDIT_ANCHOR_PUBLIC_KEY_FILE: keys.publicKeyFile,
    ALETHEIA_AUDIT_ANCHOR_INTERVAL_MS: String(AUDIT_ANCHOR_INTERVAL_MS),
  };
}

function provisionAuditAnchorConfiguration({ userDataDir, localDataDirectory, externalParent }) {
  const journalDirectory = createDedicatedJournalDirectory(externalParent, localDataDirectory);
  const keys = ensureAuditAnchorKeyPair(userDataDir);
  return {
    schema: "vera-audit-anchor-config-v1",
    enabled: true,
    journalDirectory,
    keyId: keys.keyId,
  };
}

function disabledAuditAnchorConfiguration(userDataDir) {
  const existing = readAuditAnchorConfig(userDataDir);
  return {
    schema: "vera-audit-anchor-config-v1",
    enabled: false,
    journalDirectory: existing?.journalDirectory ?? null,
    keyId: existing?.keyId ?? null,
  };
}

module.exports = {
  ASSURANCE_TEXT,
  AUDIT_ANCHOR_ENV_KEYS,
  AUDIT_ANCHOR_INTERVAL_MS,
  assertNoSymlinks,
  auditAnchorPaths,
  createDedicatedJournalDirectory,
  disabledAuditAnchorConfiguration,
  ensureAuditAnchorKeyPair,
  hasExternallyManagedAnchorEnvironment,
  isPathInside,
  localAuditAnchorEnvironment,
  provisionAuditAnchorConfiguration,
  publicAuditAnchorConfiguration,
  readAuditAnchorConfig,
  restoreAuditAnchorConfigAtomically,
  snapshotAuditAnchorConfig,
  validateExternalParent,
  writeAuditAnchorConfigAtomically,
};
