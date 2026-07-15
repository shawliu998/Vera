#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  deleteGenericPassword,
  SECURITY_MAX_BUFFER_BYTES,
  SECURITY_PATH,
  SECURITY_TIMEOUT_MS,
  ensureMacOsKeychainKey,
  isMacOsKeychainItemNotFound,
  strict32ByteBase64,
} = require("../macOsKeychain");

const SERVICE = "com.aletheia.desktop.application-encryption";
const ACCOUNT = "aletheia-local-master-key";
const LABEL = "application encryption";
const PRODUCT_NAME = "Vera";

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

function runProvisioning(options) {
  ensureMacOsKeychainKey({
    service: SERVICE,
    account: ACCOUNT,
    label: LABEL,
    productName: PRODUCT_NAME,
    platform: "darwin",
    ...options,
  });
}

function assertNoOverwrite(calls) {
  for (const call of calls) {
    assert.equal(
      call.args.includes("-U"),
      false,
      "Provisioning must never use overwrite mode.",
    );
    assert.equal(
      /(^|\s)-U(?:\s|$)/.test(String(call.options.input ?? "")),
      false,
      "Provisioning must never send overwrite mode to security -i.",
    );
  }
}

function nonPromptingPasswordInput(service, account, secret) {
  return `add-generic-password -s ${service} -a ${account} -X ${Buffer.from(
    secret,
    "utf8",
  ).toString("hex")}\n`;
}

function assertSharedSecurityOptions(options, stdinMode) {
  assert.equal(options.encoding, "utf8");
  assert.equal(options.timeout, SECURITY_TIMEOUT_MS);
  assert.equal(options.maxBuffer, SECURITY_MAX_BUFFER_BYTES);
  assert.equal(options.shell, false);
  assert.deepEqual(options.stdio, [stdinMode, "pipe", "pipe"]);
}

function auditMissingCreatesNewKey() {
  const generated = Buffer.alloc(32, 7);
  const encoded = generated.toString("base64");
  assert.equal(strict32ByteBase64(encoded), true);
  const mock = securityMock([
    {
      args: ["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"],
      error: securityError({
        status: 44,
        stderr: `security: SecKeychainSearchCopyNext: ${"The specified item could not be found in the keychain."}\n`,
      }),
      assert({ options }) {
        assertSharedSecurityOptions(options, "ignore");
      },
    },
    {
      args: ["-i"],
      assert({ args, options }) {
        assertSharedSecurityOptions(options, "pipe");
        assert.equal(
          options.input,
          nonPromptingPasswordInput(SERVICE, ACCOUNT, encoded),
        );
        assert.equal(args.includes(encoded), false);
        assert.equal(options.input.includes(encoded), false);
      },
    },
    {
      args: ["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"],
      stdout: `${encoded}\n`,
      assert({ options }) {
        assertSharedSecurityOptions(options, "ignore");
      },
    },
  ]);
  runProvisioning({
    execFileSyncImpl: mock.execFileSyncImpl,
    randomBytesImpl(size) {
      assert.equal(size, 32);
      return generated;
    },
  });
  mock.assertComplete();
  assertNoOverwrite(mock.calls);
}

function auditValidExistingReused() {
  const encoded = crypto.randomBytes(32).toString("base64");
  const mock = securityMock([
    {
      args: ["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"],
      stdout: `${encoded}\n`,
      assert({ options }) {
        assertSharedSecurityOptions(options, "ignore");
      },
    },
  ]);
  runProvisioning({
    execFileSyncImpl: mock.execFileSyncImpl,
    randomBytesImpl() {
      throw new Error("randomBytes must not run when the key already exists.");
    },
  });
  mock.assertComplete();
  assert.equal(
    mock.calls.some((call) => call.args[0] === "add-generic-password"),
    false,
  );
}

function auditPermissionDeniedFailsClosed() {
  const mock = securityMock([
    {
      args: ["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"],
      error: securityError({
        status: 128,
        stderr: "security: User interaction is not allowed.\n",
      }),
      assert({ options }) {
        assertSharedSecurityOptions(options, "ignore");
      },
    },
  ]);
  assert.throws(
    () => runProvisioning({ execFileSyncImpl: mock.execFileSyncImpl }),
    /Unable to access the Vera application encryption key in macOS Keychain/,
  );
  mock.assertComplete();
  assert.equal(
    mock.calls.some((call) => call.args[0] === "add-generic-password"),
    false,
  );
}

function auditTimeoutFailsClosed() {
  const mock = securityMock([
    {
      args: ["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"],
      error: securityError({
        code: "ETIMEDOUT",
        signal: "SIGTERM",
        message: "spawnSync /usr/bin/security ETIMEDOUT",
      }),
      assert({ options }) {
        assertSharedSecurityOptions(options, "ignore");
      },
    },
  ]);
  assert.throws(
    () => runProvisioning({ execFileSyncImpl: mock.execFileSyncImpl }),
    /Unable to access the Vera application encryption key in macOS Keychain/,
  );
  mock.assertComplete();
}

function auditUnexpectedCommandErrorFailsClosed() {
  const mock = securityMock([
    {
      args: ["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"],
      error: securityError({
        status: 1,
        stderr: "security: command failed\n",
      }),
      assert({ options }) {
        assertSharedSecurityOptions(options, "ignore");
      },
    },
  ]);
  assert.throws(
    () => runProvisioning({ execFileSyncImpl: mock.execFileSyncImpl }),
    /Unable to access the Vera application encryption key in macOS Keychain/,
  );
  mock.assertComplete();
}

function auditInvalidExistingFailsClosed() {
  const invalid = Buffer.alloc(16, 1).toString("base64");
  const mock = securityMock([
    {
      args: ["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"],
      stdout: `${invalid}\n`,
      assert({ options }) {
        assertSharedSecurityOptions(options, "ignore");
      },
    },
  ]);
  assert.equal(strict32ByteBase64(invalid), false);
  assert.throws(
    () => runProvisioning({ execFileSyncImpl: mock.execFileSyncImpl }),
    /Unable to access the Vera application encryption key in macOS Keychain/,
  );
  mock.assertComplete();
  assert.equal(
    mock.calls.some((call) => call.args[0] === "add-generic-password"),
    false,
  );
}

function auditVerifyFailureFailsClosed() {
  const generated = Buffer.alloc(32, 11);
  const encoded = generated.toString("base64");
  const other = Buffer.alloc(32, 12).toString("base64");
  const mock = securityMock([
    {
      args: ["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"],
      error: securityError({
        message: "security: SecKeychainSearchCopyNext: errSecItemNotFound",
      }),
      assert({ options }) {
        assertSharedSecurityOptions(options, "ignore");
      },
    },
    {
      args: ["-i"],
      assert({ options }) {
        assertSharedSecurityOptions(options, "pipe");
        assert.equal(
          options.input,
          nonPromptingPasswordInput(SERVICE, ACCOUNT, encoded),
        );
      },
    },
    {
      args: ["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"],
      stdout: `${other}\n`,
      assert({ options }) {
        assertSharedSecurityOptions(options, "ignore");
      },
    },
  ]);
  assert.throws(
    () =>
      runProvisioning({
        execFileSyncImpl: mock.execFileSyncImpl,
        randomBytesImpl: () => generated,
      }),
    /Unable to access the Vera application encryption key in macOS Keychain/,
  );
  mock.assertComplete();
  assertNoOverwrite(mock.calls);
}

function auditCreateCollisionFailsClosed() {
  const generated = Buffer.alloc(32, 13);
  const encoded = generated.toString("base64");
  const mock = securityMock([
    {
      args: ["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"],
      error: securityError({
        status: 44,
        stderr:
          "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n",
      }),
    },
    {
      args: ["-i"],
      error: securityError({
        status: 45,
        stderr:
          "security: SecKeychainAddGenericPassword: errSecDuplicateItem\n",
      }),
      assert({ options }) {
        assertSharedSecurityOptions(options, "pipe");
        assert.equal(
          options.input,
          nonPromptingPasswordInput(SERVICE, ACCOUNT, encoded),
        );
      },
    },
  ]);
  assert.throws(
    () =>
      runProvisioning({
        execFileSyncImpl: mock.execFileSyncImpl,
        randomBytesImpl: () => generated,
      }),
    /Unable to access the Vera application encryption key in macOS Keychain/,
  );
  mock.assertComplete();
  assertNoOverwrite(mock.calls);
}

function auditNotFoundClassifier() {
  assert.equal(
    isMacOsKeychainItemNotFound(
      securityError({
        status: 44,
        stderr: `security: ${"The specified item could not be found in the keychain."}`,
      }),
    ),
    true,
  );
  assert.equal(
    isMacOsKeychainItemNotFound(
      securityError({ message: "security: errSecItemNotFound (-25300)" }),
    ),
    true,
  );
  assert.equal(
    isMacOsKeychainItemNotFound(
      securityError({ message: "security: User interaction is not allowed." }),
    ),
    false,
  );
}

function auditRealFreshKeyProvisioning() {
  if (process.platform !== "darwin") return "skipped";
  const suffix = crypto.randomBytes(12).toString("hex");
  const service = `ai.vera.key-provisioning-audit.${suffix}`;
  const account = `vera-key-${suffix}`;
  const generated = crypto.randomBytes(32);
  const encoded = generated.toString("base64");
  let provisioned = false;
  try {
    ensureMacOsKeychainKey({
      service,
      account,
      label: "fresh install audit",
      productName: PRODUCT_NAME,
      platform: "darwin",
      randomBytesImpl: () => generated,
    });
    provisioned = true;
    const directRead = String(
      execFileSync(
        SECURITY_PATH,
        ["find-generic-password", "-s", service, "-a", account, "-w"],
        {
          encoding: "utf8",
          timeout: SECURITY_TIMEOUT_MS,
          maxBuffer: SECURITY_MAX_BUFFER_BYTES,
          stdio: ["ignore", "pipe", "pipe"],
          shell: false,
        },
      ),
    ).replace(/\r?\n$/, "");
    assert.equal(directRead, encoded);
    ensureMacOsKeychainKey({
      service,
      account,
      label: "fresh install audit",
      productName: PRODUCT_NAME,
      platform: "darwin",
      randomBytesImpl() {
        throw new Error("A verified existing key must be reused.");
      },
    });
  } finally {
    const deleted = deleteGenericPassword({ service, account });
    if (provisioned) assert.equal(deleted, true);
  }
  return "passed";
}

function auditStaticIntegration() {
  const main = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"),
  );
  assert.match(
    main,
    /desktopUtilityModulePath\("macOsKeychain\.js"\)/,
    "the packaged host must load Keychain code from the real external utility directory",
  );
  assert.match(main, /productName: PRODUCT_NAME/);
  assert.equal(
    packageJson.scripts["test:keychain-provisioning"],
    "node scripts/macOsKeychainProvisioningAudit.js",
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

auditMissingCreatesNewKey();
auditValidExistingReused();
auditPermissionDeniedFailsClosed();
auditTimeoutFailsClosed();
auditUnexpectedCommandErrorFailsClosed();
auditInvalidExistingFailsClosed();
auditVerifyFailureFailsClosed();
auditCreateCollisionFailsClosed();
auditNotFoundClassifier();
const realFreshProvisioning = auditRealFreshKeyProvisioning();
auditStaticIntegration();

console.log(
  JSON.stringify(
    {
      ok: true,
      suite: "vera-macos-keychain-provisioning-v1",
      checks: [
        "missing keychain item provisions a new key without overwrite mode",
        "valid existing 32-byte base64 key is reused",
        "permission denial, timeout, and command errors fail closed",
        "invalid existing key material fails closed without replacement",
        "non-prompting security -i writes keep key material out of argv",
        "create collisions and post-create verification mismatches fail closed without overwrite",
        `real fresh base64 key create/direct-read/reuse/delete round trip: ${realFreshProvisioning}`,
        "static desktop wiring and package inclusion stay intact",
      ],
    },
    null,
    2,
  ),
);
