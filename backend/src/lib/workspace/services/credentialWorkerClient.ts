import { randomBytes } from "node:crypto";

import {
  CREDENTIAL_STORE_OPERATION_MODE,
  CredentialStoreCollisionError,
  MAX_MODEL_CREDENTIAL_RESOLVE_SECRET_BYTES,
  MAX_MODEL_CREDENTIAL_STORE_SECRET_BYTES,
  type AsynchronousCredentialStorePort,
  type CredentialBindingKey,
  type CredentialDeletionInput,
  type CredentialStorageInput,
} from "./credentialStore";

const CREDENTIAL_RPC_SCHEMA = "vera-credential-rpc-v1";
const CREDENTIAL_PORT_BOOTSTRAP = "vera-credential-port-v1";
const CREDENTIAL_PORT_READY = "vera-credential-port-ready-v1";
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_PORT_TIMEOUT_MS = 15_000;
const MAX_IN_FLIGHT_REQUESTS = 32;

type PortEvent = { data?: unknown; ports?: unknown[] } | unknown;

export interface CredentialMessagePort {
  on(event: string, listener: (event: PortEvent) => void): unknown;
  off?(event: string, listener: (event: PortEvent) => void): unknown;
  postMessage(value: unknown): void;
  start?(): void;
  close?(): void;
}

export interface CredentialParentPort {
  once(event: "message", listener: (event: PortEvent) => void): unknown;
  off?(event: "message", listener: (event: PortEvent) => void): unknown;
  postMessage?(value: unknown): void;
}

export type CredentialWorkerCapabilities = {
  available: boolean;
  secretReadbackToRenderer: false;
};

export class CredentialWorkerUnavailableError extends Error {
  readonly code = "CREDENTIAL_WORKER_UNAVAILABLE";

  constructor() {
    super("The local credential store is unavailable.");
    this.name = "CredentialWorkerUnavailableError";
  }
}

export class CredentialWorkerCredentialNotFoundError extends Error {
  readonly code = "CREDENTIAL_NOT_FOUND";

  constructor() {
    super("The configured local credential was not found.");
    this.name = "CredentialWorkerCredentialNotFoundError";
  }
}

export class CredentialWorkerProtocolError extends Error {
  readonly code = "CREDENTIAL_WORKER_PROTOCOL_ERROR";

  constructor() {
    super("The local credential worker returned an invalid response.");
    this.name = "CredentialWorkerProtocolError";
  }
}

type PendingRequest = {
  operation: "ping" | "store" | "resolve" | "delete";
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function eventData(event: PortEvent) {
  return isRecord(event) && "data" in event ? event.data : event;
}

function safeWorkerFailure(code: unknown): Error {
  if (code === "CREDENTIAL_COLLISION") {
    return new CredentialStoreCollisionError();
  }
  if (code === "CREDENTIAL_NOT_FOUND") {
    return new CredentialWorkerCredentialNotFoundError();
  }
  if (code === "KEYCHAIN_UNAVAILABLE") {
    return new CredentialWorkerUnavailableError();
  }
  return new CredentialWorkerProtocolError();
}

function requestId() {
  return randomBytes(24).toString("base64url");
}

export class CredentialWorkerRpcClient implements AsynchronousCredentialStorePort {
  readonly [CREDENTIAL_STORE_OPERATION_MODE] = "asynchronous" as const;
  private readonly pending = new Map<string, PendingRequest>();
  private closed = false;
  private workerAvailable = false;
  private readonly onMessage = (event: PortEvent) => {
    this.receive(eventData(event));
  };
  private readonly onPortFailure = () => {
    this.terminate(new CredentialWorkerUnavailableError(), false);
  };

  constructor(
    private readonly port: CredentialMessagePort,
    private readonly requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ) {
    if (
      !Number.isSafeInteger(requestTimeoutMs) ||
      requestTimeoutMs < 1 ||
      requestTimeoutMs > 60_000
    ) {
      throw new CredentialWorkerProtocolError();
    }
    port.on("message", this.onMessage);
    port.on("messageerror", this.onPortFailure);
    port.on("close", this.onPortFailure);
    port.start?.();
  }

  private terminate(error: Error, closePort: boolean) {
    if (this.closed) return;
    this.workerAvailable = false;
    this.closed = true;
    this.port.off?.("message", this.onMessage);
    this.port.off?.("messageerror", this.onPortFailure);
    this.port.off?.("close", this.onPortFailure);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
    if (closePort) {
      try {
        this.port.close?.();
      } catch {
        // The connection is already unusable; close failures are non-actionable.
      }
    }
  }

  private protocolViolation() {
    const error = new CredentialWorkerProtocolError();
    this.terminate(error, true);
    return error;
  }

  private receive(value: unknown) {
    if (!isRecord(value) || typeof value.id !== "string") return;
    const pending = this.pending.get(value.id);
    if (!pending) return;
    this.pending.delete(value.id);
    clearTimeout(pending.timeout);
    if (
      value.schema !== CREDENTIAL_RPC_SCHEMA ||
      typeof value.ok !== "boolean"
    ) {
      const error = new CredentialWorkerProtocolError();
      pending.reject(error);
      this.terminate(error, true);
      return;
    }
    if (value.ok) {
      if (!hasExactKeys(value, ["schema", "id", "ok", "result"])) {
        const error = new CredentialWorkerProtocolError();
        pending.reject(error);
        this.terminate(error, true);
        return;
      }
      pending.resolve(value.result);
      return;
    }
    if (
      !hasExactKeys(value, ["schema", "id", "ok", "error"]) ||
      !isRecord(value.error) ||
      !hasExactKeys(value.error, ["code"])
    ) {
      const error = new CredentialWorkerProtocolError();
      pending.reject(error);
      this.terminate(error, true);
      return;
    }
    if (
      value.error.code === "KEYCHAIN_UNAVAILABLE" ||
      (value.error.code !== "CREDENTIAL_COLLISION" &&
        value.error.code !== "CREDENTIAL_NOT_FOUND")
    ) {
      this.workerAvailable = false;
    }
    const failure = safeWorkerFailure(value.error.code);
    pending.reject(failure);
    if (failure instanceof CredentialWorkerProtocolError) {
      this.terminate(failure, true);
    }
  }

  private request(
    operation: PendingRequest["operation"],
    payload: Record<string, unknown>,
  ): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new CredentialWorkerUnavailableError());
    }
    if (operation !== "ping" && !this.workerAvailable) {
      return Promise.reject(new CredentialWorkerUnavailableError());
    }
    if (this.pending.size >= MAX_IN_FLIGHT_REQUESTS) {
      return Promise.reject(new CredentialWorkerUnavailableError());
    }
    const id = requestId();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        this.workerAvailable = false;
        pending.reject(new CredentialWorkerUnavailableError());
      }, this.requestTimeoutMs);
      this.pending.set(id, { operation, resolve, reject, timeout });
      try {
        this.port.postMessage({
          schema: CREDENTIAL_RPC_SCHEMA,
          id,
          operation,
          payload,
        });
      } catch {
        clearTimeout(timeout);
        this.pending.delete(id);
        this.workerAvailable = false;
        reject(new CredentialWorkerUnavailableError());
      }
    });
  }

  async capabilities(): Promise<CredentialWorkerCapabilities> {
    let result: unknown;
    try {
      result = await this.request("ping", {});
    } catch (error) {
      this.workerAvailable = false;
      throw error;
    }
    if (
      !isRecord(result) ||
      !hasExactKeys(result, ["available", "secretReadbackToRenderer"]) ||
      typeof result.available !== "boolean" ||
      result.secretReadbackToRenderer !== false
    ) {
      throw this.protocolViolation();
    }
    this.workerAvailable = result.available;
    return {
      available: result.available,
      secretReadbackToRenderer: false,
    };
  }

  isAvailable() {
    return !this.closed && this.workerAvailable;
  }

  async store(input: CredentialStorageInput): Promise<void> {
    if (
      typeof input.secret !== "string" ||
      input.secret.length === 0 ||
      /[\r\n]/.test(input.secret) ||
      Buffer.byteLength(input.secret, "utf8") >
        MAX_MODEL_CREDENTIAL_STORE_SECRET_BYTES
    ) {
      throw new CredentialWorkerProtocolError();
    }
    const result = await this.request("store", {
      reference: input.reference,
      binding: input.binding,
      secret: input.secret,
    });
    if (
      !isRecord(result) ||
      !hasExactKeys(result, ["stored"]) ||
      result.stored !== true
    ) {
      throw this.protocolViolation();
    }
  }

  async resolve(input: {
    reference: string;
    binding: CredentialBindingKey;
  }): Promise<string> {
    const result = await this.request("resolve", {
      reference: input.reference,
      binding: input.binding,
    });
    if (
      !isRecord(result) ||
      !hasExactKeys(result, ["secret"]) ||
      typeof result.secret !== "string" ||
      result.secret.length === 0 ||
      /[\r\n]/.test(result.secret) ||
      Buffer.byteLength(result.secret, "utf8") >
        MAX_MODEL_CREDENTIAL_RESOLVE_SECRET_BYTES
    ) {
      throw this.protocolViolation();
    }
    return result.secret;
  }

  async delete(input: CredentialDeletionInput): Promise<void> {
    const result = await this.request("delete", {
      reference: input.reference,
      binding: input.binding,
    });
    if (
      !isRecord(result) ||
      !hasExactKeys(result, ["deleted"]) ||
      typeof result.deleted !== "boolean"
    ) {
      throw this.protocolViolation();
    }
  }

  close() {
    this.terminate(new CredentialWorkerUnavailableError(), true);
  }
}

function processParentPort(): CredentialParentPort | null {
  return (
    (process as unknown as { parentPort?: CredentialParentPort }).parentPort ??
    null
  );
}

export async function receiveCredentialWorkerClient(
  options: {
    required?: boolean;
    parentPort?: CredentialParentPort | null;
    portTimeoutMs?: number;
    requestTimeoutMs?: number;
  } = {},
): Promise<CredentialWorkerRpcClient | null> {
  const required =
    options.required ??
    process.env.VERA_DESKTOP_CREDENTIAL_PORT_REQUIRED === "true";
  if (!required) return null;
  const parentPort = options.parentPort ?? processParentPort();
  if (!parentPort) throw new CredentialWorkerUnavailableError();
  const timeoutMs = options.portTimeoutMs ?? DEFAULT_PORT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new CredentialWorkerProtocolError();
  }

  const port = await new Promise<CredentialMessagePort>((resolve, reject) => {
    let readinessInterval: NodeJS.Timeout | null = null;
    const stopReadiness = () => {
      if (readinessInterval) clearInterval(readinessInterval);
      readinessInterval = null;
    };
    const timeout = setTimeout(() => {
      stopReadiness();
      parentPort.off?.("message", onMessage);
      reject(new CredentialWorkerUnavailableError());
    }, timeoutMs);
    const onMessage = (event: PortEvent) => {
      clearTimeout(timeout);
      stopReadiness();
      const data = eventData(event);
      const ports =
        isRecord(event) && Array.isArray(event.ports) ? event.ports : [];
      if (
        !isRecord(data) ||
        !hasExactKeys(data, ["type"]) ||
        data.type !== CREDENTIAL_PORT_BOOTSTRAP ||
        ports.length !== 1
      ) {
        reject(new CredentialWorkerProtocolError());
        return;
      }
      const candidate = ports[0] as CredentialMessagePort;
      if (
        !candidate ||
        typeof candidate.on !== "function" ||
        typeof candidate.postMessage !== "function"
      ) {
        reject(new CredentialWorkerProtocolError());
        return;
      }
      resolve(candidate);
    };
    parentPort.once("message", onMessage);
    const announceReadiness = () => {
      try {
        parentPort.postMessage?.({ type: CREDENTIAL_PORT_READY });
        return true;
      } catch {
        clearTimeout(timeout);
        stopReadiness();
        parentPort.off?.("message", onMessage);
        reject(new CredentialWorkerUnavailableError());
        return false;
      }
    };
    if (announceReadiness() && parentPort.postMessage) {
      readinessInterval = setInterval(() => {
        announceReadiness();
      }, 250);
      readinessInterval.unref();
    }
  });
  return new CredentialWorkerRpcClient(
    port,
    options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  );
}

export {
  CREDENTIAL_PORT_BOOTSTRAP,
  CREDENTIAL_PORT_READY,
  CREDENTIAL_RPC_SCHEMA,
};
