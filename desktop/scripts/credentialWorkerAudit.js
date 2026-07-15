"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");

const {
  CREDENTIAL_AVAILABILITY_PROBE_ACCOUNT,
  CREDENTIAL_PORT_BOOTSTRAP,
  CREDENTIAL_PORT_READY,
  CREDENTIAL_RPC_SCHEMA,
  attachCredentialWorkerParentPort,
  attachCredentialWorkerPort,
  createCredentialWorkerHandler,
} = require("../credentialWorker");
const {
  MacOsKeychainItemCollisionError,
  workspaceModelCredentialLocator,
} = require("../macOsKeychain");

const profileId = "00000000-0000-4000-8000-000000000921";
const binding = {
  profileId,
  provider: "openai",
  canonicalOrigin: "https://api.openai.com",
};
const reference = `keychain://vera/model-profile/${profileId}/0123456789abcdef`;
const secret = "worker-secret-must-not-appear-in-errors";
let requestSequence = 0;

function request(operation, payload) {
  requestSequence += 1;
  return {
    schema: CREDENTIAL_RPC_SCHEMA,
    id: `request_${String(requestSequence).padStart(12, "0")}`,
    operation,
    payload,
  };
}

function auditLifecycleAndRedaction() {
  const calls = [];
  const locator = workspaceModelCredentialLocator({ reference, binding });
  const handler = createCredentialWorkerHandler({
    platform: "darwin",
    probeKeychain() {},
    writeGenericPassword(input) {
      calls.push({ operation: "store", ...input });
    },
    readGenericPassword(input) {
      calls.push({ operation: "resolve", ...input });
      return secret;
    },
    deleteWorkspaceModelCredential(input) {
      calls.push({ operation: "delete", ...input });
      return true;
    },
  });

  assert.deepEqual(handler(request("ping", {})).result, {
    available: true,
    secretReadbackToRenderer: false,
  });
  const stored = handler(request("store", { reference, binding, secret }));
  assert.deepEqual(stored.result, { stored: true });
  assert.equal(JSON.stringify(stored).includes(secret), false);
  assert.deepEqual(calls[0], {
    operation: "store",
    ...locator,
    secret,
  });
  assert.deepEqual(calls[1], { operation: "resolve", ...locator });

  const resolved = handler(request("resolve", { reference, binding }));
  assert.deepEqual(resolved.result, { secret });
  assert.deepEqual(calls[2], { operation: "resolve", ...locator });

  const deleted = handler(request("delete", { reference, binding }));
  assert.deepEqual(deleted.result, { deleted: true });
  assert.deepEqual(calls[3], {
    operation: "delete",
    reference,
    binding,
  });

  let verificationCleanup = 0;
  const unverified = createCredentialWorkerHandler({
    platform: "darwin",
    writeGenericPassword() {},
    readGenericPassword() {
      return "";
    },
    deleteWorkspaceModelCredential(input) {
      verificationCleanup += 1;
      assert.deepEqual(input, { reference, binding });
      return true;
    },
  })(request("store", { reference, binding, secret }));
  assert.deepEqual(unverified.error, { code: "KEYCHAIN_UNAVAILABLE" });
  assert.equal(verificationCleanup, 1);
  assert.equal(JSON.stringify(unverified).includes(secret), false);
  assert.equal(JSON.stringify(unverified).includes(reference), false);

  const missing = createCredentialWorkerHandler({
    platform: "darwin",
    readGenericPassword: () => null,
  })(request("resolve", { reference, binding }));
  assert.deepEqual(missing.error, { code: "CREDENTIAL_NOT_FOUND" });
  assert.equal(JSON.stringify(missing).includes(reference), false);
  assert.equal(JSON.stringify(missing).includes(secret), false);

  const collision = createCredentialWorkerHandler({
    platform: "darwin",
    writeGenericPassword() {
      throw new MacOsKeychainItemCollisionError();
    },
  })(request("store", { reference, binding, secret }));
  assert.deepEqual(collision.error, { code: "CREDENTIAL_COLLISION" });
  assert.equal(JSON.stringify(collision).includes(secret), false);

  const unavailable = createCredentialWorkerHandler({
    platform: "darwin",
    readGenericPassword() {
      throw new Error(`do not echo ${secret} or ${reference}`);
    },
  })(request("resolve", { reference, binding }));
  assert.deepEqual(unavailable.error, { code: "KEYCHAIN_UNAVAILABLE" });
  assert.equal(JSON.stringify(unavailable).includes(secret), false);
  assert.equal(JSON.stringify(unavailable).includes(reference), false);
}

function auditKeychainAvailabilityProbe() {
  let probed = 0;
  const available = createCredentialWorkerHandler({
    platform: "darwin",
    probeKeychain() {
      probed += 1;
    },
  });
  assert.deepEqual(available(request("ping", {})).result, {
    available: true,
    secretReadbackToRenderer: false,
  });
  assert.equal(probed, 1);

  const unavailable = createCredentialWorkerHandler({
    platform: "darwin",
    probeKeychain() {
      throw new Error(`${secret} ${reference}`);
    },
  });
  const response = unavailable(request("ping", {}));
  assert.deepEqual(response.result, {
    available: false,
    secretReadbackToRenderer: false,
  });
  assert.equal(JSON.stringify(response).includes(secret), false);
  assert.equal(JSON.stringify(response).includes(reference), false);

  let nonDarwinProbeCalled = false;
  const nonDarwin = createCredentialWorkerHandler({
    platform: "linux",
    probeKeychain() {
      nonDarwinProbeCalled = true;
    },
  });
  assert.equal(nonDarwin(request("ping", {})).result.available, false);
  assert.equal(nonDarwinProbeCalled, false);
  assert.equal(CREDENTIAL_AVAILABILITY_PROBE_ACCOUNT.includes(secret), false);
}

function auditStrictProtocolAndUnavailablePlatform() {
  let called = false;
  const unavailable = createCredentialWorkerHandler({
    platform: "linux",
    readGenericPassword() {
      called = true;
      return secret;
    },
  });
  assert.deepEqual(unavailable(request("ping", {})).result, {
    available: false,
    secretReadbackToRenderer: false,
  });
  assert.deepEqual(
    unavailable(request("resolve", { reference, binding })).error,
    { code: "KEYCHAIN_UNAVAILABLE" },
  );
  assert.equal(called, false);

  const handler = createCredentialWorkerHandler({ platform: "darwin" });
  const invalidRequests = [
    null,
    {},
    { ...request("ping", {}), extra: true },
    request("unknown", {}),
    request("ping", { extra: true }),
    request("store", { reference, binding, secret: "line\nbreak" }),
    request("store", { reference, binding, secret: "x".repeat(8193) }),
    request("resolve", {
      reference,
      binding: { ...binding, profileId: crypto.randomUUID() },
    }),
    request("resolve", {
      reference: `keychain://vera/model-profile/${profileId}`,
      binding,
    }),
    request("resolve", {
      reference,
      binding: { ...binding, extra: true },
    }),
  ];
  for (const invalid of invalidRequests) {
    const response = handler(invalid);
    assert.equal(response.ok, false);
    assert.deepEqual(response.error, { code: "INVALID_REQUEST" });
    assert.equal(JSON.stringify(response).includes(secret), false);
  }
}

function auditMessagePortBoundary() {
  class FakePort extends EventEmitter {
    constructor() {
      super();
      this.responses = [];
      this.started = false;
    }
    postMessage(value) {
      this.responses.push(value);
    }
    start() {
      this.started = true;
    }
  }

  const port = new FakePort();
  attachCredentialWorkerPort(port, { platform: "linux" });
  assert.equal(port.started, true);
  const ping = request("ping", {});
  port.emit("message", { data: ping });
  assert.equal(port.responses.length, 1);
  assert.equal(port.responses[0].id, ping.id);
  assert.deepEqual(port.responses[0].result, {
    available: false,
    secretReadbackToRenderer: false,
  });
}

function auditParentReadinessHandshake() {
  class FakeParent extends EventEmitter {
    constructor() {
      super();
      this.controls = [];
    }
    postMessage(value) {
      this.controls.push(value);
    }
  }
  const parent = new FakeParent();
  assert.equal(attachCredentialWorkerParentPort(parent), true);
  assert.deepEqual(parent.controls, [{ type: CREDENTIAL_PORT_READY }]);
  const port = new EventEmitter();
  port.postMessage = () => undefined;
  port.start = () => undefined;
  parent.emit("message", {
    data: { type: CREDENTIAL_PORT_BOOTSTRAP },
    ports: [port],
  });
}

function auditStaticNoLoggingBoundary() {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "credentialWorker.js"),
    "utf8",
  );
  assert.equal(/console\.(?:log|info|warn|error)/.test(source), false);
  assert.equal(source.includes("ipcMain"), false);
  assert.equal(source.includes("contextBridge"), false);
  assert.equal(source.includes("webContents"), false);
  assert.equal(source.includes("CREDENTIAL_NOT_FOUND"), true);
  assert.equal(source.includes("CREDENTIAL_COLLISION"), true);
}

auditLifecycleAndRedaction();
auditKeychainAvailabilityProbe();
auditStrictProtocolAndUnavailablePlatform();
auditMessagePortBoundary();
auditParentReadinessHandshake();
auditStaticNoLoggingBoundary();

console.log(
  JSON.stringify(
    {
      ok: true,
      suite: "vera-credential-worker-v1",
      checks: [
        "strict request schema and origin-bound locators",
        "create-only collision and unavailable Keychain classification",
        "real read-only Keychain availability probe",
        "secret-free error envelopes and no logging bridge",
          "non-darwin fail-closed capability",
          "retrying parent-port readiness handshake",
          "dedicated message-port request boundary",
      ],
    },
    null,
    2,
  ),
);
