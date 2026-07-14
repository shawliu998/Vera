"use strict";

const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const SECURITY_PATH = "/usr/bin/security";
const SECURITY_TIMEOUT_MS = 10_000;
const SECURITY_MAX_BUFFER_BYTES = 64 * 1024;
const ITEM_NOT_FOUND_MESSAGE =
  "The specified item could not be found in the keychain.";
const WORKSPACE_MODEL_CREDENTIAL_SERVICE =
  "ai.aletheia.workspace-model-profile-credentials";
const WORKSPACE_MODEL_CREDENTIAL_ACCOUNT_PREFIX = "vera-model-profile-account";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOCATOR_ID_PATTERN = /^[a-z0-9]{16,128}$/;

function securityExecOptions(overrides = {}) {
  return {
    encoding: "utf8",
    timeout: SECURITY_TIMEOUT_MS,
    maxBuffer: SECURITY_MAX_BUFFER_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    ...overrides,
  };
}

function strict32ByteBase64(value) {
  if (typeof value !== "string") return false;
  if (value.trim() !== value) return false;
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) return false;
  const decoded = Buffer.from(value, "base64");
  return decoded.length === 32 && decoded.toString("base64") === value;
}

function securityErrorText(error) {
  const parts = [];
  if (typeof error?.stderr === "string" && error.stderr.trim()) {
    parts.push(error.stderr.trim());
  } else if (Buffer.isBuffer(error?.stderr) && error.stderr.length > 0) {
    parts.push(error.stderr.toString("utf8").trim());
  }
  if (typeof error?.stdout === "string" && error.stdout.trim()) {
    parts.push(error.stdout.trim());
  } else if (Buffer.isBuffer(error?.stdout) && error.stdout.length > 0) {
    parts.push(error.stdout.toString("utf8").trim());
  }
  if (error instanceof Error && error.message.trim()) {
    parts.push(error.message.trim());
  } else if (error !== undefined && error !== null) {
    parts.push(String(error).trim());
  }
  return parts.join("\n");
}

function isMacOsKeychainItemNotFound(error) {
  if (error && Number.isInteger(error.status) && error.status === 44) {
    return true;
  }
  const text = securityErrorText(error);
  return (
    text.includes(ITEM_NOT_FOUND_MESSAGE) ||
    /\berrSecItemNotFound\b/.test(text) ||
    /\b-25300\b/.test(text)
  );
}

function keychainFailure(productName, label) {
  return new Error(
    `Unable to access the ${productName} ${label} key in macOS Keychain.`,
  );
}

function genericKeychainFailure(operation) {
  return new Error(`Unable to ${operation} the requested macOS Keychain item.`);
}

function stripSingleTrailingNewline(value) {
  if (value.endsWith("\r\n")) return value.slice(0, -2);
  if (value.endsWith("\n")) return value.slice(0, -1);
  return value;
}

function runSecurityCommand(args, options = {}) {
  return stripSingleTrailingNewline(
    String(
      (options.execFileSyncImpl ?? execFileSync)(
        SECURITY_PATH,
        args,
        securityExecOptions({
          ...(options.input !== undefined ? { input: options.input } : {}),
          stdio: [options.stdin === "pipe" ? "pipe" : "ignore", "pipe", "pipe"],
        }),
      ),
    ),
  );
}

function findGenericPassword({ service, account, execFileSyncImpl }) {
  try {
    return {
      state: "found",
      value: runSecurityCommand(
        ["find-generic-password", "-s", service, "-a", account, "-w"],
        { execFileSyncImpl },
      ),
    };
  } catch (error) {
    if (isMacOsKeychainItemNotFound(error)) return { state: "missing" };
    return { state: "error", error };
  }
}

function readGenericPassword({
  service,
  account,
  execFileSyncImpl = execFileSync,
}) {
  const result = findGenericPassword({ service, account, execFileSyncImpl });
  if (result.state === "found") return result.value;
  if (result.state === "missing") return null;
  throw genericKeychainFailure("read");
}

function writeGenericPassword({
  service,
  account,
  secret,
  replace = false,
  execFileSyncImpl = execFileSync,
}) {
  if (typeof secret !== "string" || /[\r\n]/.test(secret)) {
    throw genericKeychainFailure("write");
  }
  try {
    runSecurityCommand(
      [
        "add-generic-password",
        ...(replace ? ["-U"] : []),
        "-s",
        service,
        "-a",
        account,
        "-w",
      ],
      {
        execFileSyncImpl,
        input: `${secret}\n`,
        stdin: "pipe",
      },
    );
  } catch {
    throw genericKeychainFailure("write");
  }
}

function deleteGenericPassword({
  service,
  account,
  execFileSyncImpl = execFileSync,
}) {
  try {
    runSecurityCommand(
      ["delete-generic-password", "-s", service, "-a", account],
      { execFileSyncImpl },
    );
    return true;
  } catch (error) {
    if (isMacOsKeychainItemNotFound(error)) return false;
    throw genericKeychainFailure("delete");
  }
}

function workspaceModelCredentialAccount({
  profileId,
  provider,
  canonicalOrigin,
  locatorId,
}) {
  if (!UUID_PATTERN.test(String(profileId ?? ""))) {
    throw new Error("Model credential profileId must be a UUID.");
  }
  if (typeof provider !== "string" || provider.trim().length === 0) {
    throw new Error("Model credential provider must be a non-empty string.");
  }
  if (
    typeof canonicalOrigin !== "string" ||
    canonicalOrigin.trim().length === 0
  ) {
    throw new Error(
      "Model credential canonicalOrigin must be a non-empty string.",
    );
  }
  if (!LOCATOR_ID_PATTERN.test(String(locatorId ?? ""))) {
    throw new Error(
      "Model credential locatorId must be 16-128 lowercase base36 characters.",
    );
  }
  const originHash = crypto
    .createHash("sha256")
    .update(canonicalOrigin)
    .digest("hex")
    .slice(0, 24);
  return `${WORKSPACE_MODEL_CREDENTIAL_ACCOUNT_PREFIX}:${profileId}:${provider}:${originHash}:${locatorId}`;
}

function ensureMacOsKeychainKey({
  service,
  account,
  label,
  productName,
  platform = process.platform,
  execFileSyncImpl = execFileSync,
  randomBytesImpl = crypto.randomBytes,
}) {
  if (platform !== "darwin") {
    throw new Error(
      `${label} needs an operator-provided key on this platform.`,
    );
  }

  const existing = findGenericPassword({ service, account, execFileSyncImpl });
  if (existing.state === "found") {
    if (!strict32ByteBase64(existing.value)) {
      throw keychainFailure(productName, label);
    }
    return;
  }
  if (existing.state !== "missing") {
    throw keychainFailure(productName, label);
  }

  const generated = Buffer.from(randomBytesImpl(32)).toString("base64");
  if (!strict32ByteBase64(generated)) {
    throw keychainFailure(productName, label);
  }

  try {
    writeGenericPassword({
      service,
      account,
      secret: generated,
      execFileSyncImpl,
    });
  } catch {
    throw keychainFailure(productName, label);
  }

  const verified = findGenericPassword({ service, account, execFileSyncImpl });
  if (
    verified.state !== "found" ||
    !strict32ByteBase64(verified.value) ||
    verified.value !== generated
  ) {
    throw keychainFailure(productName, label);
  }
}

module.exports = {
  SECURITY_PATH,
  SECURITY_TIMEOUT_MS,
  SECURITY_MAX_BUFFER_BYTES,
  WORKSPACE_MODEL_CREDENTIAL_SERVICE,
  WORKSPACE_MODEL_CREDENTIAL_ACCOUNT_PREFIX,
  deleteGenericPassword,
  ensureMacOsKeychainKey,
  isMacOsKeychainItemNotFound,
  readGenericPassword,
  strict32ByteBase64,
  stripSingleTrailingNewline,
  workspaceModelCredentialAccount,
  writeGenericPassword,
};
