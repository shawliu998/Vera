#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  decodeKeychainSecretEnvelope,
  deleteGenericPassword,
  deleteWorkspaceModelCredential,
  encodeKeychainSecretEnvelope,
  isMacOsKeychainItemCollision,
  MacOsKeychainItemCollisionError,
  readGenericPassword,
  SECURITY_MAX_BUFFER_BYTES,
  SECURITY_PATH,
  SECURITY_TIMEOUT_MS,
  WORKSPACE_MODEL_CREDENTIAL_ACCOUNT_PREFIX,
  WORKSPACE_MODEL_CREDENTIAL_SERVICE,
  workspaceModelCredentialAccount,
  workspaceModelCredentialLocator,
  writeGenericPassword,
} = require("../macOsKeychain");

function securityError(properties = {}) {
  const error = new Error(properties.message ?? "security failed");
  return Object.assign(error, properties);
}

function securityMock(steps) {
  const queue = [...steps];
  const calls = [];

  function execFileSyncImpl(file, args, options) {
    calls.push({ file, args: [...args], options });
    const step = queue.shift();
    assert(step, `Unexpected security invocation: ${args.join(" ")}`);
    assert.equal(file, SECURITY_PATH);
    assert.deepEqual(args, step.args);
    if (typeof step.assert === "function") step.assert({ file, args, options });
    if (step.error) throw step.error;
    return step.stdout ?? "";
  }

  return {
    calls,
    execFileSyncImpl,
    assertComplete() {
      assert.equal(queue.length, 0, "Not all mocked security calls were used.");
    },
  };
}

function assertSecurityOptions(options, stdinMode) {
  assert.equal(options.encoding, "utf8");
  assert.equal(options.timeout, SECURITY_TIMEOUT_MS);
  assert.equal(options.maxBuffer, SECURITY_MAX_BUFFER_BYTES);
  assert.equal(options.shell, false);
  assert.deepEqual(options.stdio, [stdinMode, "pipe", "pipe"]);
}

function interactiveWorkspaceCommand(service, account, secret) {
  const stored = encodeKeychainSecretEnvelope(secret);
  return `add-generic-password -s ${service} -a ${account} -X ${Buffer.from(
    stored,
    "utf8",
  ).toString("hex")}\n`;
}

function auditSecretEnvelope() {
  const secret = "Vera 凭据 !@#$%^&*()";
  const encoded = encodeKeychainSecretEnvelope(secret);
  assert.equal(encoded.includes(secret), false);
  assert.equal(decodeKeychainSecretEnvelope(encoded), secret);
  assert.equal(decodeKeychainSecretEnvelope("legacy-plain-secret"), "legacy-plain-secret");
  assert.throws(
    () => decodeKeychainSecretEnvelope(`${encoded.slice(0, -1)}A`),
    /Unable to decode the requested macOS Keychain item/,
  );
}

function auditAccountNaming() {
  const base = {
    profileId: "00000000-0000-4000-8000-000000000901",
    provider: "openai",
    canonicalOrigin: "https://api.openai.com",
    locatorId: "0000000000000901",
  };
  const first = workspaceModelCredentialAccount(base);
  const second = workspaceModelCredentialAccount(base);
  const changedOrigin = workspaceModelCredentialAccount({
    ...base,
    canonicalOrigin: "https://proxy.example.com",
  });
  const changedLocator = workspaceModelCredentialAccount({
    ...base,
    locatorId: "0000000000000902",
  });

  assert.equal(first, second);
  assert.notEqual(first, changedOrigin);
  assert.notEqual(first, changedLocator);
  assert.equal(
    first.startsWith(`${WORKSPACE_MODEL_CREDENTIAL_ACCOUNT_PREFIX}:`),
    true,
  );
  assert.equal(first.includes(base.canonicalOrigin), false);
}

function auditWriteUsesBoundedRedactedCommand() {
  const secret = "vera-model-secret";
  const account = workspaceModelCredentialAccount({
    profileId: "00000000-0000-4000-8000-000000000902",
    provider: "openai",
    canonicalOrigin: "https://api.openai.com",
    locatorId: "0000000000000902",
  });
  const mock = securityMock([
    {
      args: ["-i"],
      assert({ args, options }) {
        assertSecurityOptions(options, "pipe");
        assert.equal(
          options.input,
          interactiveWorkspaceCommand(
            WORKSPACE_MODEL_CREDENTIAL_SERVICE,
            account,
            secret,
          ),
        );
        assert.equal(args.includes(secret), false);
        assert.equal(options.input.includes(secret), false);
        assert.equal(args.includes("-U"), false);
        assert.equal(options.input.includes(" -U "), false);
      },
    },
  ]);

  writeGenericPassword({
    service: WORKSPACE_MODEL_CREDENTIAL_SERVICE,
    account,
    secret,
    execFileSyncImpl: mock.execFileSyncImpl,
  });
  mock.assertComplete();
}

function auditCreateOnlyCollisionClassification() {
  const account = workspaceModelCredentialAccount({
    profileId: "00000000-0000-4000-8000-000000000908",
    provider: "openai",
    canonicalOrigin: "https://api.openai.com",
    locatorId: "0000000000000908",
  });
  const secret = "must-not-overwrite-existing";
  const collision = securityError({
    status: 45,
    stderr: "security: SecKeychainItemAdd: errSecDuplicateItem (-25299)",
  });
  assert.equal(isMacOsKeychainItemCollision(collision), true);
  assert.equal(
    isMacOsKeychainItemCollision(
      securityError({ status: 1, stderr: "security: permission denied" }),
    ),
    false,
  );
  const mock = securityMock([
    {
      args: ["-i"],
      error: collision,
      assert({ args, options }) {
        assert.equal(args.includes("-U"), false);
        assert.equal(args.includes(secret), false);
        assertSecurityOptions(options, "pipe");
        assert.equal(
          options.input,
          interactiveWorkspaceCommand(
            WORKSPACE_MODEL_CREDENTIAL_SERVICE,
            account,
            secret,
          ),
        );
      },
    },
  ]);
  assert.throws(
    () =>
      writeGenericPassword({
        service: WORKSPACE_MODEL_CREDENTIAL_SERVICE,
        account,
        secret,
        execFileSyncImpl: mock.execFileSyncImpl,
      }),
    (error) => {
      assert.equal(error instanceof MacOsKeychainItemCollisionError, true);
      assert.equal(error.code, "MACOS_KEYCHAIN_ITEM_COLLISION");
      assert.equal(error.message.includes(account), false);
      assert.equal(error.message.includes(secret), false);
      return true;
    },
  );
  mock.assertComplete();
}

function auditReadAndDeleteBehaviors() {
  const account = workspaceModelCredentialAccount({
    profileId: "00000000-0000-4000-8000-000000000903",
    provider: "openai_compatible",
    canonicalOrigin: "https://proxy.example.com",
    locatorId: "0000000000000903",
  });
  const secret = "  stored-secret  ";
  const readMock = securityMock([
    {
      args: [
        "find-generic-password",
        "-s",
        WORKSPACE_MODEL_CREDENTIAL_SERVICE,
        "-a",
        account,
        "-w",
      ],
      stdout: `${secret}\n`,
      assert({ options }) {
        assertSecurityOptions(options, "ignore");
      },
    },
  ]);
  assert.equal(
    readGenericPassword({
      service: WORKSPACE_MODEL_CREDENTIAL_SERVICE,
      account,
      execFileSyncImpl: readMock.execFileSyncImpl,
    }),
    secret,
  );
  readMock.assertComplete();

  const missingMock = securityMock([
    {
      args: [
        "find-generic-password",
        "-s",
        WORKSPACE_MODEL_CREDENTIAL_SERVICE,
        "-a",
        account,
        "-w",
      ],
      error: securityError({
        status: 44,
        stderr:
          "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n",
      }),
      assert({ options }) {
        assertSecurityOptions(options, "ignore");
      },
    },
  ]);
  assert.equal(
    readGenericPassword({
      service: WORKSPACE_MODEL_CREDENTIAL_SERVICE,
      account,
      execFileSyncImpl: missingMock.execFileSyncImpl,
    }),
    null,
  );
  missingMock.assertComplete();

  const deleteMock = securityMock([
    {
      args: [
        "delete-generic-password",
        "-s",
        WORKSPACE_MODEL_CREDENTIAL_SERVICE,
        "-a",
        account,
      ],
      assert({ options }) {
        assertSecurityOptions(options, "ignore");
      },
    },
  ]);
  assert.equal(
    deleteGenericPassword({
      service: WORKSPACE_MODEL_CREDENTIAL_SERVICE,
      account,
      execFileSyncImpl: deleteMock.execFileSyncImpl,
    }),
    true,
  );
  deleteMock.assertComplete();
}

function auditRestartSafeBoundCredentialDeletion() {
  const binding = {
    profileId: "00000000-0000-4000-8000-000000000906",
    provider: "anthropic",
    canonicalOrigin: "https://api.anthropic.com",
  };
  const locatorId = "0000000000000906";
  const reference = `keychain://vera/model-profile/${binding.profileId}/${locatorId}`;
  const beforeRestart = workspaceModelCredentialLocator({
    reference,
    binding,
  });
  const afterRestart = workspaceModelCredentialLocator({
    reference,
    binding: { ...binding },
  });
  assert.deepEqual(afterRestart, beforeRestart);
  assert.equal(
    beforeRestart.account,
    workspaceModelCredentialAccount({ ...binding, locatorId }),
  );

  const mock = securityMock([
    {
      args: [
        "delete-generic-password",
        "-s",
        WORKSPACE_MODEL_CREDENTIAL_SERVICE,
        "-a",
        beforeRestart.account,
      ],
      assert({ options }) {
        assertSecurityOptions(options, "ignore");
      },
    },
  ]);
  assert.equal(
    deleteWorkspaceModelCredential({
      reference,
      binding: { ...binding },
      execFileSyncImpl: mock.execFileSyncImpl,
    }),
    true,
  );
  mock.assertComplete();

  assert.throws(
    () =>
      workspaceModelCredentialLocator({
        reference,
        binding: {
          ...binding,
          profileId: "00000000-0000-4000-8000-000000000907",
        },
      }),
    /binding does not match/,
  );
  assert.throws(
    () =>
      workspaceModelCredentialLocator({
        reference: `keychain://vera/model-profile/${binding.profileId}`,
        binding,
      }),
    /locator is invalid/,
  );
  assert.notEqual(
    workspaceModelCredentialLocator({
      reference,
      binding: {
        ...binding,
        canonicalOrigin: "https://proxy.example.com",
      },
    }).account,
    beforeRestart.account,
  );
}

function auditSanitizedFailures() {
  const account = workspaceModelCredentialAccount({
    profileId: "00000000-0000-4000-8000-000000000904",
    provider: "gemini",
    canonicalOrigin: "https://generativelanguage.googleapis.com",
    locatorId: "0000000000000904",
  });
  const secret = "dont-leak-me";
  const writeMock = securityMock([
    {
      args: ["-i"],
      error: securityError({
        message: `security failed for ${account} with ${secret}`,
      }),
      assert({ args, options }) {
        assert.equal(
          args.includes("-U"),
          false,
          "Credential writes must be create-only and never overwrite collisions.",
        );
        assert.equal(options.input.includes(" -U "), false);
      },
    },
  ]);
  assert.throws(
    () =>
      writeGenericPassword({
        service: WORKSPACE_MODEL_CREDENTIAL_SERVICE,
        account,
        secret,
        execFileSyncImpl: writeMock.execFileSyncImpl,
      }),
    (error) => {
      assert.match(
        error.message,
        /Unable to write the requested macOS Keychain item/,
      );
      assert.equal(error.message.includes(secret), false);
      assert.equal(error.message.includes(account), false);
      assert.equal(
        error.message.includes(WORKSPACE_MODEL_CREDENTIAL_SERVICE),
        false,
      );
      return true;
    },
  );
  writeMock.assertComplete();

  const deleteMock = securityMock([
    {
      args: [
        "delete-generic-password",
        "-s",
        WORKSPACE_MODEL_CREDENTIAL_SERVICE,
        "-a",
        account,
      ],
      error: securityError({
        status: 1,
        stderr: `security: delete failed for ${account}`,
      }),
    },
  ]);
  assert.throws(
    () =>
      deleteGenericPassword({
        service: WORKSPACE_MODEL_CREDENTIAL_SERVICE,
        account,
        execFileSyncImpl: deleteMock.execFileSyncImpl,
      }),
    (error) => {
      assert.match(
        error.message,
        /Unable to delete the requested macOS Keychain item/,
      );
      assert.equal(error.message.includes(account), false);
      assert.equal(
        error.message.includes(WORKSPACE_MODEL_CREDENTIAL_SERVICE),
        false,
      );
      return true;
    },
  );
  deleteMock.assertComplete();
}

function auditWriteRejectsLineBreakSecrets() {
  const account = workspaceModelCredentialAccount({
    profileId: "00000000-0000-4000-8000-000000000905",
    provider: "openai",
    canonicalOrigin: "https://api.openai.com",
    locatorId: "0000000000000905",
  });
  assert.throws(
    () =>
      writeGenericPassword({
        service: WORKSPACE_MODEL_CREDENTIAL_SERVICE,
        account,
        secret: "line-1\nline-2",
      }),
    /Unable to write the requested macOS Keychain item/,
  );
  assert.throws(
    () =>
      writeGenericPassword({
        service: WORKSPACE_MODEL_CREDENTIAL_SERVICE,
        account,
        secret: "line-1\rline-2",
      }),
    /Unable to write the requested macOS Keychain item/,
  );
}

function auditRealMacOsRoundTrip() {
  if (process.platform !== "darwin") return "skipped";
  const suffix = crypto.randomBytes(12).toString("hex");
  const service = WORKSPACE_MODEL_CREDENTIAL_SERVICE;
  const account = `vera-roundtrip-${suffix}`;
  const secret = `Vera:${crypto.randomBytes(24).toString("base64url")}:中文`;
  let created = false;
  try {
    assert.equal(readGenericPassword({ service, account }), null);
    writeGenericPassword({ service, account, secret });
    created = true;
    assert.equal(readGenericPassword({ service, account }), secret);
    assert.throws(
      () => writeGenericPassword({ service, account, secret: "replacement" }),
      (error) => error instanceof MacOsKeychainItemCollisionError,
    );
    assert.equal(readGenericPassword({ service, account }), secret);
  } finally {
    const deleted = deleteGenericPassword({ service, account });
    if (created) assert.equal(deleted, true);
  }
  assert.equal(readGenericPassword({ service, account }), null);
  return "passed";
}

function auditStaticIntegration() {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"),
  );
  assert.equal(
    packageJson.scripts["test:keychain-credential-store"],
    "node scripts/macOsKeychainCredentialStoreAudit.js",
  );
  assert.equal(packageJson.build.files.includes("macOsKeychain.js"), false);
  assert.equal(
    packageJson.build.extraResources.some(
      (entry) =>
        entry.from === "macOsKeychain.js" &&
        entry.to === "aletheia/desktop/macOsKeychain.js",
    ),
    true,
  );
}

auditAccountNaming();
auditSecretEnvelope();
auditWriteUsesBoundedRedactedCommand();
auditCreateOnlyCollisionClassification();
auditReadAndDeleteBehaviors();
auditRestartSafeBoundCredentialDeletion();
auditSanitizedFailures();
auditWriteRejectsLineBreakSecrets();
const realRoundTrip = auditRealMacOsRoundTrip();
auditStaticIntegration();

console.log(
  JSON.stringify(
    {
      ok: true,
      suite: "vera-macos-keychain-credential-store-v1",
      checks: [
        "model-profile account naming is deterministic and origin-bound without exposing raw origin",
        "versioned UTF-8 secret envelopes round-trip non-ASCII values while retaining legacy plain-value reads",
        "model credential writes are create-only without -U and use validated security interactive tokens with an exact UTF-8 envelope only on bounded stdin",
        "duplicate-item failures are classified as definite no-write collisions without exposing account or secret material",
        "generic password reads and deletes stay bounded and classify missing items safely",
        `real macOS Keychain write/read/collision/delete round trip: ${realRoundTrip}`,
        "reference plus immutable binding reconstructs the exact delete account after restart and rejects incomplete or cross-profile locators",
        "credential-store command failures stay redacted and never echo secret, account, or service names",
      ],
    },
    null,
    2,
  ),
);
