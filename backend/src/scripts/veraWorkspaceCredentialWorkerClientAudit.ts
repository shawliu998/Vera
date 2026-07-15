import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";

import {
  CREDENTIAL_PORT_BOOTSTRAP,
  CREDENTIAL_PORT_READY,
  CREDENTIAL_RPC_SCHEMA,
  CredentialWorkerCredentialNotFoundError,
  CredentialWorkerProtocolError,
  CredentialWorkerRpcClient,
  CredentialWorkerUnavailableError,
  receiveCredentialWorkerClient,
  type CredentialMessagePort,
  type CredentialParentPort,
} from "../lib/workspace/services/credentialWorkerClient";
import {
  CREDENTIAL_STORE_OPERATION_MODE,
  CredentialStoreCollisionError,
  MAX_MODEL_CREDENTIAL_RESOLVE_SECRET_BYTES,
  MAX_MODEL_CREDENTIAL_STORE_SECRET_BYTES,
} from "../lib/workspace/services/credentialStore";

const profileId = "00000000-0000-4000-8000-000000000931";
const reference = `keychain://vera/model-profile/${profileId}/0123456789abcdef`;
const binding = {
  profileId,
  provider: "openai" as const,
  canonicalOrigin: "https://api.openai.com",
};
const secret = "client-secret-must-not-appear-in-errors";

type RequestEnvelope = {
  schema: string;
  id: string;
  operation: string;
  payload: Record<string, unknown>;
};

class FakePort extends EventEmitter implements CredentialMessagePort {
  readonly requests: RequestEnvelope[] = [];
  started = false;
  closed = false;

  constructor(
    private readonly respond?: (request: RequestEnvelope) => unknown,
  ) {
    super();
  }

  postMessage(value: unknown) {
    const request = value as RequestEnvelope;
    this.requests.push(request);
    if (!this.respond) return;
    const response = this.respond(request);
    queueMicrotask(() => this.emit("message", { data: response }));
  }

  start() {
    this.started = true;
  }

  close() {
    this.closed = true;
  }
}

function success(request: RequestEnvelope, result: unknown) {
  return {
    schema: CREDENTIAL_RPC_SCHEMA,
    id: request.id,
    ok: true,
    result,
  };
}

function failure(request: RequestEnvelope, code: string) {
  return {
    schema: CREDENTIAL_RPC_SCHEMA,
    id: request.id,
    ok: false,
    error: { code },
  };
}

async function assertRejectsWith(
  promise: Promise<unknown>,
  ErrorType: new () => Error,
) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ErrorType);
    assert.equal(error.message.includes(secret), false);
    assert.equal(error.message.includes(reference), false);
    return true;
  });
}

async function auditLifecycleAndStrictResponses() {
  const port = new FakePort((request) => {
    switch (request.operation) {
      case "ping":
        return success(request, {
          available: true,
          secretReadbackToRenderer: false,
        });
      case "store":
        assert.deepEqual(request.payload, { reference, binding, secret });
        return success(request, { stored: true });
      case "resolve":
        assert.deepEqual(request.payload, { reference, binding });
        return success(request, { secret });
      case "delete":
        assert.deepEqual(request.payload, { reference, binding });
        return success(request, { deleted: true });
      default:
        throw new Error("unexpected operation");
    }
  });
  const client = new CredentialWorkerRpcClient(port, 500);
  assert.equal(port.started, true);
  assert.equal(client[CREDENTIAL_STORE_OPERATION_MODE], "asynchronous");
  assert.equal(client.isAvailable(), false);
  await assertRejectsWith(
    client.store({ reference, binding, secret }),
    CredentialWorkerUnavailableError,
  );
  assert.equal(port.requests.length, 0);
  assert.deepEqual(await client.capabilities(), {
    available: true,
    secretReadbackToRenderer: false,
  });
  assert.equal(client.isAvailable(), true);
  await client.store({ reference, binding, secret });
  assert.equal(await client.resolve({ reference, binding }), secret);
  await client.delete({ reference, binding });
  assert.deepEqual(
    port.requests.map((request) => request.operation),
    ["ping", "store", "resolve", "delete"],
  );
  assert.equal(
    port.requests.every(
      (request) =>
        request.schema === CREDENTIAL_RPC_SCHEMA &&
        /^[A-Za-z0-9_-]{32,80}$/.test(request.id),
    ),
    true,
  );
  client.close();
  assert.equal(port.closed, true);
  assert.equal(client.isAvailable(), false);
  await assertRejectsWith(
    client.capabilities(),
    CredentialWorkerUnavailableError,
  );
}

async function auditFailureClassificationAndMalformedReplies() {
  for (const [code, ErrorType] of [
    ["CREDENTIAL_COLLISION", CredentialStoreCollisionError],
    ["CREDENTIAL_NOT_FOUND", CredentialWorkerCredentialNotFoundError],
    ["KEYCHAIN_UNAVAILABLE", CredentialWorkerUnavailableError],
    ["INVALID_REQUEST", CredentialWorkerProtocolError],
    ["UNRECOGNIZED", CredentialWorkerProtocolError],
  ] as const) {
    const port = new FakePort((request) =>
      request.operation === "ping"
        ? success(request, {
            available: true,
            secretReadbackToRenderer: false,
          })
        : failure(request, code),
    );
    const client = new CredentialWorkerRpcClient(port, 500);
    await client.capabilities();
    await assertRejectsWith(
      client.store({ reference, binding, secret }),
      ErrorType,
    );
    if (code === "CREDENTIAL_NOT_FOUND") {
      assert.equal(client.isAvailable(), true);
    } else if (code === "KEYCHAIN_UNAVAILABLE") {
      assert.equal(client.isAvailable(), false);
    }
    client.close();
  }

  const malformedResults: Array<(request: RequestEnvelope) => unknown> = [
    (request) => ({ id: request.id, ok: true, result: { stored: true } }),
    (request) => ({
      schema: CREDENTIAL_RPC_SCHEMA,
      id: request.id,
      ok: "true",
      result: { stored: true },
    }),
    (request) => ({
      ...success(request, { stored: true }),
      extra: secret,
    }),
    (request) => success(request, { stored: false }),
    (request) => ({
      schema: CREDENTIAL_RPC_SCHEMA,
      id: request.id,
      ok: false,
      error: { code: "KEYCHAIN_UNAVAILABLE", detail: secret },
    }),
  ];
  for (const respond of malformedResults) {
    const client = new CredentialWorkerRpcClient(
      new FakePort((request) =>
        request.operation === "ping"
          ? success(request, {
              available: true,
              secretReadbackToRenderer: false,
            })
          : respond(request),
      ),
      500,
    );
    await client.capabilities();
    await assertRejectsWith(
      client.store({ reference, binding, secret }),
      CredentialWorkerProtocolError,
    );
    client.close();
  }

  const invalidatedPort = new FakePort((request) =>
    request.operation === "ping"
      ? success(request, {
          available: true,
          secretReadbackToRenderer: false,
        })
      : success(request, { stored: false }),
  );
  const invalidatedClient = new CredentialWorkerRpcClient(invalidatedPort, 500);
  await invalidatedClient.capabilities();
  assert.equal(invalidatedClient.isAvailable(), true);
  await assertRejectsWith(
    invalidatedClient.store({ reference, binding, secret }),
    CredentialWorkerProtocolError,
  );
  assert.equal(invalidatedClient.isAvailable(), false);
  invalidatedClient.close();

  const protocolFailurePort = new FakePort();
  const protocolFailureClient = new CredentialWorkerRpcClient(
    protocolFailurePort,
    500,
  );
  const first = protocolFailureClient.capabilities();
  const concurrent = protocolFailureClient.capabilities();
  const firstRequest = protocolFailurePort.requests[0];
  protocolFailurePort.emit("message", {
    data: { id: firstRequest.id, ok: true, result: {} },
  });
  await assertRejectsWith(first, CredentialWorkerProtocolError);
  await assertRejectsWith(concurrent, CredentialWorkerProtocolError);
  assert.equal(protocolFailurePort.closed, true);
  await assertRejectsWith(
    protocolFailureClient.capabilities(),
    CredentialWorkerUnavailableError,
  );

  const concurrentMissingPort = new FakePort((request) => {
    if (request.operation === "ping") {
      return success(request, {
        available: true,
        secretReadbackToRenderer: false,
      });
    }
    if (request.operation === "resolve") {
      return failure(request, "CREDENTIAL_NOT_FOUND");
    }
    if (request.operation === "delete") {
      return success(request, { deleted: false });
    }
    return success(request, { stored: true });
  });
  const concurrentMissingClient = new CredentialWorkerRpcClient(
    concurrentMissingPort,
    500,
  );
  await concurrentMissingClient.capabilities();
  const missingResolution = concurrentMissingClient.resolve({
    reference,
    binding,
  });
  const concurrentDelete = concurrentMissingClient.delete({
    reference,
    binding,
  });
  await assertRejectsWith(
    missingResolution,
    CredentialWorkerCredentialNotFoundError,
  );
  await concurrentDelete;
  assert.equal(concurrentMissingClient.isAvailable(), true);
  await concurrentMissingClient.store({ reference, binding, secret });
  assert.equal(concurrentMissingClient.isAvailable(), true);
  concurrentMissingClient.close();
}

async function auditTimeoutDisconnectAndConcurrencyBound() {
  const timeoutClient = new CredentialWorkerRpcClient(new FakePort(), 5);
  await assertRejectsWith(
    timeoutClient.capabilities(),
    CredentialWorkerUnavailableError,
  );
  timeoutClient.close();

  const disconnectPort = new FakePort();
  const disconnectClient = new CredentialWorkerRpcClient(disconnectPort, 500);
  const pending = disconnectClient.capabilities();
  disconnectPort.emit("close");
  await assertRejectsWith(pending, CredentialWorkerUnavailableError);
  await assertRejectsWith(
    disconnectClient.resolve({ reference, binding }),
    CredentialWorkerUnavailableError,
  );

  const saturatedPort = new FakePort();
  const saturatedClient = new CredentialWorkerRpcClient(saturatedPort, 500);
  const requests = Array.from({ length: 32 }, () =>
    saturatedClient.capabilities().catch((error: unknown) => error),
  );
  await assertRejectsWith(
    saturatedClient.capabilities(),
    CredentialWorkerUnavailableError,
  );
  assert.equal(saturatedPort.requests.length, 32);
  saturatedClient.close();
  const failures = await Promise.all(requests);
  assert.equal(
    failures.every(
      (error) => error instanceof CredentialWorkerUnavailableError,
    ),
    true,
  );
}

async function auditSecretByteBoundary() {
  const port = new FakePort((request) =>
    request.operation === "ping"
      ? success(request, {
          available: true,
          secretReadbackToRenderer: false,
        })
      : success(request, { stored: true }),
  );
  const client = new CredentialWorkerRpcClient(port, 500);
  await client.capabilities();
  const boundarySecret = "😀".repeat(256);
  assert.equal(
    Buffer.byteLength(boundarySecret, "utf8"),
    MAX_MODEL_CREDENTIAL_STORE_SECRET_BYTES,
  );
  await client.store({ reference, binding, secret: boundarySecret });
  assert.equal(port.requests.length, 2);
  assert.equal(port.requests[1]?.payload.secret, boundarySecret);

  await assertRejectsWith(
    client.store({
      reference,
      binding,
      secret: "x".repeat(MAX_MODEL_CREDENTIAL_STORE_SECRET_BYTES + 1),
    }),
    CredentialWorkerProtocolError,
  );
  await assertRejectsWith(
    client.store({ reference, binding, secret: "😀".repeat(257) }),
    CredentialWorkerProtocolError,
  );
  assert.equal(port.requests.length, 2);
  client.close();
}

async function auditLegacyResolveByteBoundary() {
  const legacyBoundarySecret = "😀".repeat(2048);
  assert.equal(
    Buffer.byteLength(legacyBoundarySecret, "utf8"),
    MAX_MODEL_CREDENTIAL_RESOLVE_SECRET_BYTES,
  );
  const compatiblePort = new FakePort((request) =>
    request.operation === "ping"
      ? success(request, {
          available: true,
          secretReadbackToRenderer: false,
        })
      : success(request, { secret: legacyBoundarySecret }),
  );
  const compatibleClient = new CredentialWorkerRpcClient(compatiblePort, 500);
  await compatibleClient.capabilities();
  assert.equal(
    await compatibleClient.resolve({ reference, binding }),
    legacyBoundarySecret,
  );
  assert.equal(compatibleClient.isAvailable(), true);
  compatibleClient.close();

  const oversizedLegacySecret = "x".repeat(
    MAX_MODEL_CREDENTIAL_RESOLVE_SECRET_BYTES + 1,
  );
  const rejectingPort = new FakePort((request) =>
    request.operation === "ping"
      ? success(request, {
          available: true,
          secretReadbackToRenderer: false,
        })
      : success(request, { secret: oversizedLegacySecret }),
  );
  const rejectingClient = new CredentialWorkerRpcClient(rejectingPort, 500);
  await rejectingClient.capabilities();
  await assertRejectsWith(
    rejectingClient.resolve({ reference, binding }),
    CredentialWorkerProtocolError,
  );
  assert.equal(rejectingClient.isAvailable(), false);
  assert.equal(rejectingPort.closed, true);
}

async function auditBootstrapBoundary() {
  assert.equal(await receiveCredentialWorkerClient({ required: false }), null);

  const parent = new EventEmitter() as CredentialParentPort & EventEmitter;
  const controlMessages: unknown[] = [];
  parent.postMessage = (value: unknown) => controlMessages.push(value);
  const port = new FakePort((request) =>
    success(request, {
      available: false,
      secretReadbackToRenderer: false,
    }),
  );
  const receiving = receiveCredentialWorkerClient({
    required: true,
    parentPort: parent,
    portTimeoutMs: 500,
    requestTimeoutMs: 500,
  });
  assert.deepEqual(controlMessages, [{ type: CREDENTIAL_PORT_READY }]);
  parent.emit("message", {
    data: { type: CREDENTIAL_PORT_BOOTSTRAP },
    ports: [port],
  });
  const client = await receiving;
  assert.ok(client);
  assert.deepEqual(await client.capabilities(), {
    available: false,
    secretReadbackToRenderer: false,
  });
  assert.equal(client.isAvailable(), false);
  client.close();

  const invalidParent = new EventEmitter() as CredentialParentPort &
    EventEmitter;
  const invalid = receiveCredentialWorkerClient({
    required: true,
    parentPort: invalidParent,
    portTimeoutMs: 500,
  });
  invalidParent.emit("message", {
    data: { type: CREDENTIAL_PORT_BOOTSTRAP, extra: true },
    ports: [new FakePort()],
  });
  await assertRejectsWith(invalid, CredentialWorkerProtocolError);

  await assertRejectsWith(
    receiveCredentialWorkerClient({
      required: true,
      parentPort: null,
      portTimeoutMs: 5,
    }),
    CredentialWorkerUnavailableError,
  );
}

function auditStaticBoundary() {
  const source = fs.readFileSync(
    path.join(
      __dirname,
      "..",
      "lib",
      "workspace",
      "services",
      "credentialWorkerClient.ts",
    ),
    "utf8",
  );
  assert.equal(/console\.(?:log|info|warn|error)/.test(source), false);
  assert.equal(source.includes("ipcRenderer"), false);
  assert.equal(source.includes("contextBridge"), false);
  assert.equal(source.includes("secretReadbackToRenderer: false"), true);
  assert.equal(source.includes("MAX_IN_FLIGHT_REQUESTS = 32"), true);
}

async function main() {
  await auditLifecycleAndStrictResponses();
  await auditFailureClassificationAndMalformedReplies();
  await auditTimeoutDisconnectAndConcurrencyBound();
  await auditSecretByteBoundary();
  await auditLegacyResolveByteBoundary();
  await auditBootstrapBoundary();
  auditStaticBoundary();
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        suite: "vera-workspace-credential-worker-client-v1",
        checks: [
          "strict lifecycle request and response envelopes",
          "safe collision, unavailable and protocol classification",
          "credential-not-found isolation without worker invalidation",
          "connection-wide fail-closed handling after protocol violations",
          "bounded timeout, disconnect and concurrent requests",
          "1,024-byte UTF-8 secret boundary before MessagePort writes",
          "8,192-byte bounded legacy resolve compatibility",
          "retrying readiness handshake and one-shot transferred-port bootstrap",
          "secret-free errors and no renderer bridge",
        ],
      },
      null,
      2,
    )}\n`,
  );
}

void main();
