"use strict";

const APPLICATION_ENCRYPTION_MODES = new Set(["disabled", "required"]);
const DATABASE_ENCRYPTION_MODES = new Set([
  "metadata_plaintext",
  "sqlcipher_required",
]);

class DesktopEncryptionPolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = "DesktopEncryptionPolicyError";
  }
}

function normalizedMode(environment, name, fallback) {
  const configured = environment[name];
  return configured === undefined
    ? fallback
    : String(configured).trim().toLowerCase();
}

function resolveDesktopEncryptionPolicy({
  packaged,
  environment = process.env,
}) {
  const applicationEncryption = normalizedMode(
    environment,
    "ALETHEIA_APPLICATION_ENCRYPTION",
    "required",
  );
  if (!APPLICATION_ENCRYPTION_MODES.has(applicationEncryption)) {
    throw new DesktopEncryptionPolicyError(
      "ALETHEIA_APPLICATION_ENCRYPTION must be disabled or required.",
    );
  }

  const databaseEncryption = normalizedMode(
    environment,
    "ALETHEIA_DATABASE_ENCRYPTION",
    packaged ? "sqlcipher_required" : "metadata_plaintext",
  );
  if (!DATABASE_ENCRYPTION_MODES.has(databaseEncryption)) {
    throw new DesktopEncryptionPolicyError(
      "ALETHEIA_DATABASE_ENCRYPTION must be metadata_plaintext or sqlcipher_required.",
    );
  }

  if (packaged && applicationEncryption !== "required") {
    throw new DesktopEncryptionPolicyError(
      "Packaged Vera requires application file encryption.",
    );
  }
  if (packaged && databaseEncryption !== "sqlcipher_required") {
    throw new DesktopEncryptionPolicyError(
      "Packaged Vera requires SQLCipher database encryption.",
    );
  }

  return Object.freeze({
    applicationEncryption,
    databaseEncryption,
  });
}

module.exports = {
  DesktopEncryptionPolicyError,
  resolveDesktopEncryptionPolicy,
};
