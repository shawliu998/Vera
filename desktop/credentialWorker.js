"use strict";

const {
  MacOsKeychainItemCollisionError,
  WORKSPACE_MODEL_CREDENTIAL_SERVICE,
  readGenericPassword,
  workspaceModelCredentialLocator,
  writeGenericPassword,
  deleteWorkspaceModelCredential,
} = require("./macOsKeychain");

const CREDENTIAL_RPC_SCHEMA = "vera-credential-rpc-v1";
const CREDENTIAL_PORT_BOOTSTRAP = "vera-credential-port-v1";
const CREDENTIAL_PORT_READY = "vera-credential-port-ready-v1";
const CREDENTIAL_AVAILABILITY_PROBE_ACCOUNT =
  "vera-keychain-availability-probe-v1";
const MAX_SECRET_BYTES = 8 * 1024;
const MAX_REQUEST_ID_LENGTH = 80;
const PROVIDERS = new Set([
  "openai",
  "deepseek",
  "anthropic",
  "gemini",
  "openai_compatible",
]);
const OPERATIONS = new Set(["ping", "store", "resolve", "delete"]);

class CredentialWorkerProtocolError extends Error {
  constructor() {
    super("Credential worker request is invalid.");
    this.name = "CredentialWorkerProtocolError";
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function parseBinding(value) {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["profileId", "provider", "canonicalOrigin"]) ||
    typeof value.profileId !== "string" ||
    typeof value.provider !== "string" ||
    !PROVIDERS.has(value.provider) ||
    typeof value.canonicalOrigin !== "string" ||
    value.canonicalOrigin.length > 500
  ) {
    throw new CredentialWorkerProtocolError();
  }
  let origin;
  try {
    origin = new URL(value.canonicalOrigin);
  } catch {
    throw new CredentialWorkerProtocolError();
  }
  if (
    origin.origin !== value.canonicalOrigin ||
    (origin.protocol !== "https:" && origin.protocol !== "http:") ||
    origin.username ||
    origin.password
  ) {
    throw new CredentialWorkerProtocolError();
  }
  return {
    profileId: value.profileId,
    provider: value.provider,
    canonicalOrigin: value.canonicalOrigin,
  };
}

function parseLocatorPayload(value, includeSecret) {
  const keys = includeSecret
    ? ["reference", "binding", "secret"]
    : ["reference", "binding"];
  if (
    !isRecord(value) ||
    !hasExactKeys(value, keys) ||
    typeof value.reference !== "string" ||
    value.reference.length > 256
  ) {
    throw new CredentialWorkerProtocolError();
  }
  const binding = parseBinding(value.binding);
  // This validates the modern locator, profile UUID, provider, origin and the
  // exact deterministic account without returning it across the process port.
  workspaceModelCredentialLocator({
    reference: value.reference,
    binding,
  });
  if (includeSecret) {
    if (
      typeof value.secret !== "string" ||
      value.secret.length === 0 ||
      /[\r\n]/.test(value.secret) ||
      Buffer.byteLength(value.secret, "utf8") > MAX_SECRET_BYTES
    ) {
      throw new CredentialWorkerProtocolError();
    }
    return { reference: value.reference, binding, secret: value.secret };
  }
  return { reference: value.reference, binding };
}

function parseRequest(value) {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["schema", "id", "operation", "payload"]) ||
    value.schema !== CREDENTIAL_RPC_SCHEMA ||
    typeof value.id !== "string" ||
    !/^[A-Za-z0-9_-]{16,80}$/.test(value.id) ||
    value.id.length > MAX_REQUEST_ID_LENGTH ||
    typeof value.operation !== "string" ||
    !OPERATIONS.has(value.operation)
  ) {
    throw new CredentialWorkerProtocolError();
  }
  if (value.operation === "ping") {
    if (!isRecord(value.payload) || !hasExactKeys(value.payload, [])) {
      throw new CredentialWorkerProtocolError();
    }
    return { id: value.id, operation: value.operation, payload: {} };
  }
  return {
    id: value.id,
    operation: value.operation,
    payload: parseLocatorPayload(value.payload, value.operation === "store"),
  };
}

function success(id, result) {
  return { schema: CREDENTIAL_RPC_SCHEMA, id, ok: true, result };
}

function failure(id, code) {
  return {
    schema: CREDENTIAL_RPC_SCHEMA,
    id,
    ok: false,
    error: { code },
  };
}

function createCredentialWorkerHandler(dependencies = {}) {
  const read = dependencies.readGenericPassword ?? readGenericPassword;
  const write = dependencies.writeGenericPassword ?? writeGenericPassword;
  const remove =
    dependencies.deleteWorkspaceModelCredential ??
    deleteWorkspaceModelCredential;
  const platform = dependencies.platform ?? process.platform;
  const probeKeychain =
    dependencies.probeKeychain ??
    (() => {
      // A missing sentinel is an expected successful probe. readGenericPassword
      // returns null only for an exact item-not-found result and throws for a
      // locked, denied, unavailable, or malformed Keychain invocation.
      read({
        service: WORKSPACE_MODEL_CREDENTIAL_SERVICE,
        account: CREDENTIAL_AVAILABILITY_PROBE_ACCOUNT,
      });
    });

  return (rawRequest) => {
    let request;
    try {
      request = parseRequest(rawRequest);
    } catch {
      const id =
        isRecord(rawRequest) &&
        typeof rawRequest.id === "string" &&
        /^[A-Za-z0-9_-]{16,80}$/.test(rawRequest.id)
          ? rawRequest.id
          : "invalid-request-id";
      return failure(id, "INVALID_REQUEST");
    }
    if (request.operation === "ping") {
      let available = false;
      if (platform === "darwin") {
        try {
          probeKeychain();
          available = true;
        } catch {
          // Keep Keychain failure details inside the isolated worker.
        }
      }
      return success(request.id, {
        available,
        secretReadbackToRenderer: false,
      });
    }
    if (platform !== "darwin") {
      return failure(request.id, "KEYCHAIN_UNAVAILABLE");
    }
    try {
      if (request.operation === "store") {
        const locator = workspaceModelCredentialLocator(request.payload);
        write({ ...locator, secret: request.payload.secret });
        try {
          const verified = read(locator);
          if (verified !== request.payload.secret) {
            throw new Error("Credential write verification failed.");
          }
        } catch {
          // The create-only write may have succeeded even when verification
          // fails. Remove that exact locator best-effort and never report a
          // configured credential unless immediate read-back is identical.
          try {
            remove(request.payload);
          } catch {
            // The durable backend orphan intent retries cleanup on startup.
          }
          return failure(request.id, "KEYCHAIN_UNAVAILABLE");
        }
        return success(request.id, { stored: true });
      }
      if (request.operation === "resolve") {
        const locator = workspaceModelCredentialLocator(request.payload);
        const secret = read(locator);
        if (secret === null) {
          return failure(request.id, "CREDENTIAL_NOT_FOUND");
        }
        return success(request.id, { secret });
      }
      const deleted = remove(request.payload);
      return success(request.id, { deleted });
    } catch (error) {
      if (error instanceof MacOsKeychainItemCollisionError) {
        return failure(request.id, "CREDENTIAL_COLLISION");
      }
      if (error instanceof CredentialWorkerProtocolError) {
        return failure(request.id, "INVALID_REQUEST");
      }
      return failure(request.id, "KEYCHAIN_UNAVAILABLE");
    }
  };
}

function attachCredentialWorkerPort(port, dependencies = {}) {
  if (
    !port ||
    typeof port.on !== "function" ||
    typeof port.postMessage !== "function"
  ) {
    throw new CredentialWorkerProtocolError();
  }
  const handle = createCredentialWorkerHandler(dependencies);
  port.on("message", (event) => {
    const data = isRecord(event) && "data" in event ? event.data : event;
    port.postMessage(handle(data));
  });
  port.start?.();
}

function attachCredentialWorkerParentPort(parentPort = process.parentPort) {
  if (!parentPort || typeof parentPort.once !== "function") return false;
  let readinessInterval = null;
  const stopReadiness = () => {
    if (readinessInterval) clearInterval(readinessInterval);
    readinessInterval = null;
  };
  const onMessage = (event) => {
    stopReadiness();
    const data = isRecord(event) && "data" in event ? event.data : event;
    const ports =
      isRecord(event) && Array.isArray(event.ports) ? event.ports : [];
    if (
      !isRecord(data) ||
      !hasExactKeys(data, ["type"]) ||
      data.type !== CREDENTIAL_PORT_BOOTSTRAP ||
      ports.length !== 1
    ) {
      throw new CredentialWorkerProtocolError();
    }
    attachCredentialWorkerPort(ports[0]);
  };
  parentPort.once("message", onMessage);
  const announceReadiness = () => {
    try {
      parentPort.postMessage?.({ type: CREDENTIAL_PORT_READY });
      return null;
    } catch (error) {
      return error;
    }
  };
  const initialReadinessError = announceReadiness();
  if (initialReadinessError) {
    stopReadiness();
    parentPort.off?.("message", onMessage);
    throw initialReadinessError;
  }
  if (parentPort.postMessage) {
    readinessInterval = setInterval(() => {
      if (announceReadiness()) {
        stopReadiness();
        parentPort.off?.("message", onMessage);
      }
    }, 250);
    // Keep the isolated worker alive until the host transfers its private
    // MessagePort. Electron's parentPort listener alone is not a ref'ed event
    // loop handle in a packaged utility process. onMessage clears this timer
    // immediately after the one-shot bootstrap succeeds.
  }
  return true;
}

attachCredentialWorkerParentPort();

module.exports = {
  CREDENTIAL_AVAILABILITY_PROBE_ACCOUNT,
  CREDENTIAL_PORT_BOOTSTRAP,
  CREDENTIAL_PORT_READY,
  CREDENTIAL_RPC_SCHEMA,
  CredentialWorkerProtocolError,
  attachCredentialWorkerParentPort,
  attachCredentialWorkerPort,
  createCredentialWorkerHandler,
  parseRequest,
};
