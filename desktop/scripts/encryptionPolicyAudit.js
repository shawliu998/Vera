#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");

const {
  DesktopEncryptionPolicyError,
  resolveDesktopEncryptionPolicy,
} = require("../encryptionPolicy");

assert.deepEqual(
  resolveDesktopEncryptionPolicy({ packaged: true, environment: {} }),
  {
    applicationEncryption: "required",
    databaseEncryption: "sqlcipher_required",
  },
);

assert.deepEqual(
  resolveDesktopEncryptionPolicy({
    packaged: true,
    environment: {
      ALETHEIA_APPLICATION_ENCRYPTION: " REQUIRED ",
      ALETHEIA_DATABASE_ENCRYPTION: "SQLCIPHER_REQUIRED",
    },
  }),
  {
    applicationEncryption: "required",
    databaseEncryption: "sqlcipher_required",
  },
);

assert.throws(
  () =>
    resolveDesktopEncryptionPolicy({
      packaged: true,
      environment: {
        ALETHEIA_APPLICATION_ENCRYPTION: "disabled",
        ALETHEIA_DATABASE_ENCRYPTION: "sqlcipher_required",
      },
    }),
  (error) =>
    error instanceof DesktopEncryptionPolicyError &&
    /requires application file encryption/.test(error.message),
);

assert.throws(
  () =>
    resolveDesktopEncryptionPolicy({
      packaged: true,
      environment: {
        ALETHEIA_APPLICATION_ENCRYPTION: "required",
        ALETHEIA_DATABASE_ENCRYPTION: "metadata_plaintext",
      },
    }),
  (error) =>
    error instanceof DesktopEncryptionPolicyError &&
    /requires SQLCipher database encryption/.test(error.message),
);

assert.deepEqual(
  resolveDesktopEncryptionPolicy({
    packaged: false,
    environment: {
      ALETHEIA_APPLICATION_ENCRYPTION: "disabled",
      ALETHEIA_DATABASE_ENCRYPTION: "metadata_plaintext",
    },
  }),
  {
    applicationEncryption: "disabled",
    databaseEncryption: "metadata_plaintext",
  },
);

assert.throws(
  () =>
    resolveDesktopEncryptionPolicy({
      packaged: false,
      environment: { ALETHEIA_APPLICATION_ENCRYPTION: "optional" },
    }),
  DesktopEncryptionPolicyError,
);

assert.throws(
  () =>
    resolveDesktopEncryptionPolicy({
      packaged: false,
      environment: { ALETHEIA_DATABASE_ENCRYPTION: "sqlite" },
    }),
  DesktopEncryptionPolicyError,
);

console.log(
  JSON.stringify(
    {
      ok: true,
      suite: "vera-desktop-encryption-policy-v1",
      checks: [
        "packaged defaults require file encryption and SQLCipher",
        "packaged application-encryption downgrade is rejected",
        "packaged database-encryption downgrade is rejected",
        "development encryption modes remain explicit and validated",
      ],
    },
    null,
    2,
  ),
);
