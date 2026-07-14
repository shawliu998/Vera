#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  deleteGenericPassword,
  readGenericPassword,
  SECURITY_MAX_BUFFER_BYTES,
  SECURITY_PATH,
  SECURITY_TIMEOUT_MS,
  WORKSPACE_MODEL_CREDENTIAL_ACCOUNT_PREFIX,
  WORKSPACE_MODEL_CREDENTIAL_SERVICE,
  workspaceModelCredentialAccount,
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
      args: [
        "add-generic-password",
        "-s",
        WORKSPACE_MODEL_CREDENTIAL_SERVICE,
        "-a",
        account,
        "-w",
      ],
      assert({ args, options }) {
        assertSecurityOptions(options, "pipe");
        assert.equal(options.input, `${secret}\n`);
        assert.equal(args.includes(secret), false);
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
      args: [
        "add-generic-password",
        "-s",
        WORKSPACE_MODEL_CREDENTIAL_SERVICE,
        "-a",
        account,
        "-w",
      ],
      error: securityError({
        message: `security failed for ${account} with ${secret}`,
      }),
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

function auditStaticIntegration() {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"),
  );
  assert.equal(
    packageJson.scripts["test:keychain-credential-store"],
    "node scripts/macOsKeychainCredentialStoreAudit.js",
  );
  assert.equal(packageJson.build.files.includes("macOsKeychain.js"), true);
}

auditAccountNaming();
auditWriteUsesBoundedRedactedCommand();
auditReadAndDeleteBehaviors();
auditSanitizedFailures();
auditWriteRejectsLineBreakSecrets();
auditStaticIntegration();

console.log(
  JSON.stringify(
    {
      ok: true,
      suite: "vera-macos-keychain-credential-store-v1",
      checks: [
        "model-profile account naming is deterministic and origin-bound without exposing raw origin",
        "generic password writes use argv arrays, stdin secret input, timeout, maxBuffer, and no shell",
        "generic password reads and deletes stay bounded and classify missing items safely",
        "credential-store command failures stay redacted and never echo secret, account, or service names",
      ],
    },
    null,
    2,
  ),
);
