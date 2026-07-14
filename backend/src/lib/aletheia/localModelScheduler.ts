import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import {
  BoundedResponseBodyError,
  readBoundedResponseBody,
} from "../network/readBoundedResponseBody";

export type LocalModelAdapter = "ollama" | "openai-compatible";
export type LocalModelLifecycleState =
  | "stopped"
  | "starting"
  | "ready"
  | "unhealthy"
  | "stopping"
  | "crashed";

export type LocalModelMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type ManagedLocalModelProcess = {
  executable: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  shutdownGraceMs?: number;
  startupTimeoutMs?: number;
  autoRestart?: boolean;
  maxRestartAttempts?: number;
  restartBackoffMs?: number;
};

export type LocalModelDefinition = {
  id: string;
  adapter: LocalModelAdapter;
  endpoint: string;
  model: string;
  revision?: string;
  contextWindowTokens: number;
  maxOutputTokens: number;
  concurrency?: number;
  queueLimit?: number;
  requestTimeoutMs?: number;
  healthTimeoutMs?: number;
  responseMaxBytes?: number;
  process?: ManagedLocalModelProcess;
};

export type LocalModelGenerateRequest = {
  modelId: string;
  prompt?: string;
  systemPrompt?: string;
  messages?: LocalModelMessage[];
  maxOutputTokens?: number;
  temperature?: number;
  reasoningEffort?: "off" | "low" | "medium" | "high";
  fastMode?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
};

const FAST_MODE_MAX_OUTPUT_TOKENS = 1_024;

export type LocalModelGenerateResult = {
  text: string;
  modelId: string;
  providerModel: string;
  estimatedInputTokens: number;
  outputTokens?: number;
  totalTokens?: number;
  durationMs: number;
};

export type LocalModelStatusSnapshot = {
  id: string;
  adapter: LocalModelAdapter;
  endpoint: string;
  model: string;
  modelRevision?: string;
  managed: boolean;
  state: LocalModelLifecycleState;
  pid?: number;
  activeRequests: number;
  queuedRequests: number;
  concurrency: number;
  queueLimit: number;
  contextWindowTokens: number;
  maxOutputTokens: number;
  lastHealthCheckAt?: string;
  lastHealthyAt?: string;
  lastError?: string;
  restartAttempts: number;
  logTail: string;
};

export type LocalModelSchedulerOptions = {
  managedExecutableAllowlist?: readonly string[];
  managedEnvironmentAllowlist?: readonly string[];
  healthCheckIntervalMs?: number;
  maxManagedLogBytes?: number;
};

type QueueEntry = {
  grant: () => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  abort?: () => void;
};

type ModelRuntime = {
  definition: Required<
    Omit<
      LocalModelDefinition,
      | "process"
      | "concurrency"
      | "queueLimit"
      | "requestTimeoutMs"
      | "healthTimeoutMs"
      | "responseMaxBytes"
      | "revision"
    >
  > & {
    concurrency: number;
    queueLimit: number;
    requestTimeoutMs: number;
    healthTimeoutMs: number;
    responseMaxBytes: number;
    revision?: string;
    process?: ManagedLocalModelProcess;
  };
  state: LocalModelLifecycleState;
  process?: ChildProcess;
  activeRequests: number;
  queue: QueueEntry[];
  activeControllers: Set<AbortController>;
  lastHealthCheckAt?: string;
  lastHealthyAt?: string;
  lastError?: string;
  restartAttempts: number;
  restartTimer?: NodeJS.Timeout;
  stopRequested: boolean;
  logBuffer: BoundedLogBuffer;
  observedRevision?: string;
};

const DEFAULT_CONCURRENCY = 1;
const DEFAULT_QUEUE_LIMIT = 16;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 3_000;
const DEFAULT_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_HEALTH_INTERVAL_MS = 30_000;
const DEFAULT_LOG_MAX_BYTES = 256 * 1024;

export class LocalModelSchedulerError extends Error {
  constructor(
    message: string,
    readonly code:
      | "INVALID_CONFIGURATION"
      | "MODEL_NOT_FOUND"
      | "MODEL_UNAVAILABLE"
      | "QUEUE_FULL"
      | "TOKEN_BUDGET_EXCEEDED"
      | "REQUEST_ABORTED"
      | "REQUEST_TIMEOUT"
      | "LOCAL_MODEL_ERROR"
      | "SCHEDULER_CLOSED",
  ) {
    super(message);
    this.name = "LocalModelSchedulerError";
  }
}

class BoundedLogBuffer {
  private value = Buffer.alloc(0);

  constructor(private readonly maxBytes: number) {}

  append(source: "scheduler", chunk: Buffer | string): void {
    const prefix = Buffer.from(
      `[${new Date().toISOString()}] ${source}: `,
      "utf8",
    );
    const body = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
    this.value = Buffer.concat([this.value, prefix, body]);
    if (this.value.byteLength > this.maxBytes) {
      this.value = this.value.subarray(this.value.byteLength - this.maxBytes);
    }
  }

  text(): string {
    return this.value.toString("utf8");
  }
}

function configurationError(message: string): LocalModelSchedulerError {
  return new LocalModelSchedulerError(message, "INVALID_CONFIGURATION");
}

function positiveInteger(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw configurationError(
      `${name} must be an integer between 1 and ${maximum}.`,
    );
  }
  return value;
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 1_000);
  return String(error).slice(0, 1_000);
}

/**
 * Rejects cloud, LAN and Unix-socket proxy endpoints. Model traffic is allowed
 * only over an HTTP endpoint whose host is the current machine's loopback.
 */
export function assertLoopbackModelEndpoint(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw configurationError("Local model endpoint is not a valid URL.");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw configurationError("Local model endpoint must use http or https.");
  }
  if (parsed.username || parsed.password) {
    throw configurationError(
      "Credentials are not allowed in a local model endpoint URL.",
    );
  }
  if (parsed.hash || parsed.search) {
    throw configurationError(
      "Query strings and fragments are not allowed in a local model endpoint URL.",
    );
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const ipVersion = isIP(hostname);
  const isIpv4Loopback = ipVersion === 4 && hostname.startsWith("127.");
  const isIpv6Loopback = ipVersion === 6 && hostname === "::1";
  if (hostname !== "localhost" && !isIpv4Loopback && !isIpv6Loopback) {
    throw configurationError(
      "Local model endpoint must resolve explicitly to loopback.",
    );
  }

  if (!parsed.port) {
    throw configurationError(
      "Local model endpoint must specify an explicit loopback port.",
    );
  }

  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  return parsed;
}

function endpointUrl(base: string, suffix: string): URL {
  const parsed = assertLoopbackModelEndpoint(base);
  const prefix = parsed.pathname === "/" ? "" : parsed.pathname;
  parsed.pathname = `${prefix}/${suffix.replace(/^\/+/, "")}`;
  return parsed;
}

function estimateTokens(text: string): number {
  if (!text) return 0;
  // A deliberately conservative tokenizer-independent approximation. UTF-8
  // bytes / 3 avoids materially undercounting Chinese legal text while the
  // fixed per-message charge accounts for chat envelope tokens.
  return Math.ceil(Buffer.byteLength(text, "utf8") / 3);
}

function estimateRequestTokens(request: LocalModelGenerateRequest): number {
  let total = estimateTokens(request.systemPrompt ?? "");
  total += estimateTokens(request.prompt ?? "");
  for (const message of request.messages ?? []) {
    total += 4 + estimateTokens(message.role) + estimateTokens(message.content);
  }
  return total + 8;
}

function validateDefinition(
  definition: LocalModelDefinition,
): ModelRuntime["definition"] {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(definition.id)) {
    throw configurationError("Model id contains unsupported characters.");
  }
  if (!definition.model.trim() || definition.model.length > 256) {
    throw configurationError(
      "Provider model id is required and must be at most 256 characters.",
    );
  }
  const revision = definition.revision?.trim();
  if (
    revision &&
    (!/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,255}$/.test(revision) ||
      revision.length > 256)
  ) {
    throw configurationError("Model revision contains unsupported characters.");
  }
  assertLoopbackModelEndpoint(definition.endpoint);
  const contextWindowTokens = positiveInteger(
    definition.contextWindowTokens,
    "contextWindowTokens",
    10_000_000,
  );
  const maxOutputTokens = positiveInteger(
    definition.maxOutputTokens,
    "maxOutputTokens",
    1_000_000,
  );
  if (maxOutputTokens >= contextWindowTokens) {
    throw configurationError(
      "maxOutputTokens must be smaller than contextWindowTokens.",
    );
  }

  return {
    id: definition.id,
    adapter: definition.adapter,
    endpoint: assertLoopbackModelEndpoint(definition.endpoint).toString(),
    model: definition.model.trim(),
    revision,
    contextWindowTokens,
    maxOutputTokens,
    concurrency: positiveInteger(
      definition.concurrency ?? DEFAULT_CONCURRENCY,
      "concurrency",
      128,
    ),
    queueLimit: positiveInteger(
      definition.queueLimit ?? DEFAULT_QUEUE_LIMIT,
      "queueLimit",
      10_000,
    ),
    requestTimeoutMs: positiveInteger(
      definition.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      "requestTimeoutMs",
      3_600_000,
    ),
    healthTimeoutMs: positiveInteger(
      definition.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS,
      "healthTimeoutMs",
      60_000,
    ),
    responseMaxBytes: positiveInteger(
      definition.responseMaxBytes ?? DEFAULT_RESPONSE_MAX_BYTES,
      "responseMaxBytes",
      64 * 1024 * 1024,
    ),
    process: definition.process,
  };
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
): Promise<string> {
  try {
    return await readBoundedResponseBody(response, maxBytes);
  } catch (error) {
    if (
      error instanceof BoundedResponseBodyError &&
      (error.reason === "content_length" || error.reason === "limit_exceeded")
    ) {
      throw new LocalModelSchedulerError(
        "Local model response exceeded the configured limit.",
        "LOCAL_MODEL_ERROR",
      );
    }
    throw error;
  }
}

function parseJsonObject(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Response was not an object.");
    }
    return value as Record<string, unknown>;
  } catch (error) {
    throw new LocalModelSchedulerError(
      `Local model returned invalid JSON: ${safeErrorMessage(error)}`,
      "LOCAL_MODEL_ERROR",
    );
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });
}

export class LocalModelScheduler {
  private readonly runtimes = new Map<string, ModelRuntime>();
  private readonly executableAllowlist: Set<string>;
  private readonly environmentAllowlist: Set<string>;
  private readonly healthTimer: NodeJS.Timeout;
  private readonly maxManagedLogBytes: number;
  private closed = false;

  constructor(options: LocalModelSchedulerOptions = {}) {
    this.executableAllowlist = new Set(
      (options.managedExecutableAllowlist ?? []).map((item) =>
        this.canonicalExecutable(item),
      ),
    );
    this.environmentAllowlist = new Set(
      options.managedEnvironmentAllowlist ?? [],
    );
    this.maxManagedLogBytes = positiveInteger(
      options.maxManagedLogBytes ?? DEFAULT_LOG_MAX_BYTES,
      "maxManagedLogBytes",
      16 * 1024 * 1024,
    );
    const interval = positiveInteger(
      options.healthCheckIntervalMs ?? DEFAULT_HEALTH_INTERVAL_MS,
      "healthCheckIntervalMs",
      3_600_000,
    );
    this.healthTimer = setInterval(
      () => void this.checkRunningModels(),
      interval,
    );
    this.healthTimer.unref();
  }

  registerModel(definition: LocalModelDefinition): void {
    this.assertOpen();
    const normalized = validateDefinition(definition);
    if (this.runtimes.has(normalized.id)) {
      throw configurationError(
        `Model '${normalized.id}' is already registered.`,
      );
    }
    if (normalized.process) this.validateManagedProcess(normalized.process);
    this.runtimes.set(normalized.id, {
      definition: normalized,
      state: "stopped",
      activeRequests: 0,
      queue: [],
      activeControllers: new Set(),
      restartAttempts: 0,
      stopRequested: false,
      logBuffer: new BoundedLogBuffer(this.maxManagedLogBytes),
    });
  }

  unregisterModel(modelId: string): void {
    const runtime = this.requireRuntime(modelId);
    if (runtime.process || runtime.activeRequests || runtime.queue.length) {
      throw new LocalModelSchedulerError(
        `Model '${modelId}' must be stopped and idle before unregistering.`,
        "MODEL_UNAVAILABLE",
      );
    }
    if (runtime.restartTimer) clearTimeout(runtime.restartTimer);
    this.runtimes.delete(modelId);
  }

  async startModel(modelId: string): Promise<LocalModelStatusSnapshot> {
    this.assertOpen();
    return this.startModelInternal(modelId, true);
  }

  async startAll(): Promise<LocalModelStatusSnapshot[]> {
    return Promise.all(
      [...this.runtimes.keys()].map((modelId) => this.startModel(modelId)),
    );
  }

  async stopModel(modelId: string): Promise<LocalModelStatusSnapshot> {
    const runtime = this.requireRuntime(modelId);
    runtime.stopRequested = true;
    if (runtime.restartTimer) {
      clearTimeout(runtime.restartTimer);
      runtime.restartTimer = undefined;
    }
    this.rejectQueued(
      runtime,
      new LocalModelSchedulerError("Model is stopping.", "MODEL_UNAVAILABLE"),
    );
    for (const controller of runtime.activeControllers)
      controller.abort(new Error("Model is stopping."));

    if (!runtime.process) {
      runtime.state = "stopped";
      return this.snapshotRuntime(runtime);
    }

    runtime.state = "stopping";
    const child = runtime.process;
    const graceMs = positiveInteger(
      runtime.definition.process?.shutdownGraceMs ?? 5_000,
      "shutdownGraceMs",
      60_000,
    );
    child.kill("SIGTERM");
    const exited = await this.waitForExit(child, graceMs);
    if (!exited) {
      child.kill("SIGKILL");
      await this.waitForExit(child, 2_000);
    }
    if (runtime.process === child) runtime.process = undefined;
    runtime.state = "stopped";
    return this.snapshotRuntime(runtime);
  }

  async stopAll(): Promise<void> {
    await Promise.allSettled(
      [...this.runtimes.keys()].map((modelId) => this.stopModel(modelId)),
    );
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.healthTimer);
    await this.stopAll();
  }

  async healthCheck(modelId: string): Promise<LocalModelStatusSnapshot> {
    this.assertOpen();
    const runtime = this.requireRuntime(modelId);
    if (
      runtime.state === "stopped" ||
      runtime.state === "stopping" ||
      runtime.state === "crashed"
    ) {
      return this.snapshotRuntime(runtime);
    }
    const healthy = await this.probeHealth(runtime);
    if (
      !new Set<LocalModelLifecycleState>(["stopping", "stopped"]).has(
        runtime.state,
      )
    ) {
      runtime.state = healthy ? "ready" : "unhealthy";
    }
    return this.snapshotRuntime(runtime);
  }

  snapshots(): LocalModelStatusSnapshot[] {
    return [...this.runtimes.values()].map((runtime) =>
      this.snapshotRuntime(runtime),
    );
  }

  snapshot(modelId: string): LocalModelStatusSnapshot {
    return this.snapshotRuntime(this.requireRuntime(modelId));
  }

  async generate(
    request: LocalModelGenerateRequest,
  ): Promise<LocalModelGenerateResult> {
    this.assertOpen();
    const runtime = this.requireRuntime(request.modelId);
    this.validateGenerateRequest(runtime, request);

    if (
      runtime.state === "stopped" ||
      runtime.state === "crashed" ||
      runtime.state === "unhealthy"
    ) {
      await this.startModelInternal(request.modelId, true);
    }
    if (runtime.state !== "ready") {
      throw new LocalModelSchedulerError(
        `Local model '${request.modelId}' is not healthy.`,
        "MODEL_UNAVAILABLE",
      );
    }

    const timeoutMs = Math.min(
      request.timeoutMs === undefined
        ? runtime.definition.requestTimeoutMs
        : positiveInteger(request.timeoutMs, "timeoutMs", 3_600_000),
      runtime.definition.requestTimeoutMs,
    );
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error("Local model request timed out.")),
      timeoutMs,
    );
    timeout.unref();
    const onCallerAbort = () =>
      controller.abort(
        request.signal?.reason ?? new Error("Request cancelled."),
      );
    request.signal?.addEventListener("abort", onCallerAbort, { once: true });
    if (request.signal?.aborted) onCallerAbort();

    let release: (() => void) | undefined;
    const startedAt = Date.now();
    try {
      release = await this.acquire(runtime, controller.signal);
      runtime.activeControllers.add(controller);
      const raw = await this.callProvider(runtime, request, controller.signal);
      return {
        ...raw,
        modelId: runtime.definition.id,
        providerModel: runtime.definition.model,
        estimatedInputTokens: estimateRequestTokens(request),
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      if (controller.signal.aborted) {
        const timedOut =
          Date.now() - startedAt >= timeoutMs - 5 && !request.signal?.aborted;
        throw new LocalModelSchedulerError(
          timedOut
            ? "Local model request timed out."
            : "Local model request was cancelled.",
          timedOut ? "REQUEST_TIMEOUT" : "REQUEST_ABORTED",
        );
      }
      if (error instanceof LocalModelSchedulerError) throw error;
      throw new LocalModelSchedulerError(
        safeErrorMessage(error),
        "LOCAL_MODEL_ERROR",
      );
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", onCallerAbort);
      runtime.activeControllers.delete(controller);
      release?.();
    }
  }

  private async startModelInternal(
    modelId: string,
    resetRestartAttempts: boolean,
  ): Promise<LocalModelStatusSnapshot> {
    const runtime = this.requireRuntime(modelId);
    if (runtime.state === "ready") return this.snapshotRuntime(runtime);
    if (runtime.state === "starting") {
      throw new LocalModelSchedulerError(
        `Model '${modelId}' is already starting.`,
        "MODEL_UNAVAILABLE",
      );
    }
    if (runtime.state === "stopping") {
      throw new LocalModelSchedulerError(
        `Model '${modelId}' is stopping.`,
        "MODEL_UNAVAILABLE",
      );
    }
    if (resetRestartAttempts) runtime.restartAttempts = 0;
    runtime.stopRequested = false;
    runtime.state = "starting";
    runtime.lastError = undefined;

    if (runtime.definition.process) {
      try {
        await this.spawnManagedProcess(runtime);
      } catch (error) {
        runtime.state = "crashed";
        runtime.lastError = safeErrorMessage(error);
        throw error;
      }
      const startupTimeoutMs = positiveInteger(
        runtime.definition.process.startupTimeoutMs ?? 30_000,
        "startupTimeoutMs",
        300_000,
      );
      const deadline = Date.now() + startupTimeoutMs;
      while (
        Date.now() < deadline &&
        runtime.process &&
        !runtime.stopRequested
      ) {
        if (await this.probeHealth(runtime)) {
          runtime.state = "ready";
          return this.snapshotRuntime(runtime);
        }
        await wait(Math.min(250, Math.max(1, deadline - Date.now())));
      }
      await this.stopModel(modelId);
      if (!resetRestartAttempts) {
        runtime.stopRequested = false;
        runtime.state = "crashed";
      }
      throw new LocalModelSchedulerError(
        `Managed model '${modelId}' did not become healthy before startup timeout.`,
        "MODEL_UNAVAILABLE",
      );
    }

    const healthy = await this.probeHealth(runtime);
    runtime.state = healthy ? "ready" : "unhealthy";
    if (!healthy) {
      throw new LocalModelSchedulerError(
        `External local model '${modelId}' failed its health check.`,
        "MODEL_UNAVAILABLE",
      );
    }
    return this.snapshotRuntime(runtime);
  }

  private async spawnManagedProcess(runtime: ModelRuntime): Promise<void> {
    const processDefinition = runtime.definition.process;
    if (!processDefinition) return;
    this.validateManagedProcess(processDefinition);
    const executable = this.canonicalExecutable(processDefinition.executable);
    const args = processDefinition.args ?? [];
    const cwd = processDefinition.cwd
      ? realpathSync(processDefinition.cwd)
      : undefined;
    const baseEnvironment = [
      "HOME",
      "PATH",
      "TMPDIR",
      "LANG",
      "LC_ALL",
    ].reduce<NodeJS.ProcessEnv>((result, key) => {
      if (process.env[key] !== undefined) result[key] = process.env[key];
      return result;
    }, {});
    const configuredEnvironment = Object.fromEntries(
      Object.entries(processDefinition.env ?? {}).filter(([key]) =>
        this.environmentAllowlist.has(key),
      ),
    );
    if (
      Object.keys(configuredEnvironment).length !==
      Object.keys(processDefinition.env ?? {}).length
    ) {
      throw configurationError(
        "Managed process environment contains a key not present in the allowlist.",
      );
    }

    const child = spawn(executable, args, {
      cwd,
      env: { ...baseEnvironment, ...configuredEnvironment },
      shell: false,
      detached: false,
      // Raw model output is intentionally discarded: a model server may echo
      // prompts or completions to stdout/stderr, which must not enter app logs.
      stdio: ["ignore", "ignore", "ignore"],
      windowsHide: true,
    });
    runtime.process = child;
    runtime.logBuffer.append(
      "scheduler",
      `managed process started (pid=${String(child.pid)})\n`,
    );
    child.once("error", (error) => {
      runtime.lastError = safeErrorMessage(error);
    });
    child.once("exit", (code, signal) => {
      if (runtime.process !== child) return;
      runtime.process = undefined;
      const exitedWhileStarting = runtime.state === "starting";
      if (
        runtime.stopRequested ||
        runtime.state === "stopping" ||
        this.closed
      ) {
        runtime.state = "stopped";
        return;
      }
      runtime.state = "crashed";
      runtime.logBuffer.append(
        "scheduler",
        `managed process exited (code=${String(code)}, signal=${String(signal)})\n`,
      );
      runtime.lastError = `Managed process exited with code ${String(code)} and signal ${String(signal)}.`;
      if (!exitedWhileStarting) this.scheduleRestart(runtime);
    });

    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => {
        child.removeListener("error", onError);
        resolve();
      };
      const onError = (error: Error) => {
        child.removeListener("spawn", onSpawn);
        reject(error);
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });
  }

  private scheduleRestart(runtime: ModelRuntime): void {
    const processDefinition = runtime.definition.process;
    if (
      !processDefinition?.autoRestart ||
      runtime.stopRequested ||
      runtime.restartTimer ||
      this.closed
    )
      return;
    const maximum = processDefinition.maxRestartAttempts ?? 3;
    if (runtime.restartAttempts >= maximum) return;
    runtime.restartAttempts += 1;
    const delay = processDefinition.restartBackoffMs ?? 1_000;
    runtime.restartTimer = setTimeout(() => {
      runtime.restartTimer = undefined;
      void this.startModelInternal(runtime.definition.id, false).catch(
        (error) => {
          runtime.lastError = safeErrorMessage(error);
          this.scheduleRestart(runtime);
        },
      );
    }, delay);
    runtime.restartTimer.unref();
  }

  private validateManagedProcess(definition: ManagedLocalModelProcess): void {
    if (!path.isAbsolute(definition.executable)) {
      throw configurationError(
        "Managed model executable must be an explicit absolute path.",
      );
    }
    const executable = this.canonicalExecutable(definition.executable);
    if (!this.executableAllowlist.has(executable)) {
      throw configurationError(
        "Managed model executable is not present in the operator allowlist.",
      );
    }
    const args = definition.args ?? [];
    if (
      args.length > 128 ||
      args.some((item) => item.includes("\0") || item.length > 8_192)
    ) {
      throw configurationError(
        "Managed model process arguments exceed the safety limits.",
      );
    }
    if (definition.cwd) {
      if (
        !path.isAbsolute(definition.cwd) ||
        !existsSync(definition.cwd) ||
        !statSync(definition.cwd).isDirectory()
      ) {
        throw configurationError(
          "Managed model working directory must be an existing absolute directory.",
        );
      }
      realpathSync(definition.cwd);
    }
    const env = definition.env ?? {};
    for (const [key, value] of Object.entries(env)) {
      if (
        !/^[A-Z_][A-Z0-9_]*$/.test(key) ||
        value.includes("\0") ||
        value.length > 32_768
      ) {
        throw configurationError(
          "Managed model process environment is invalid.",
        );
      }
      if (!this.environmentAllowlist.has(key)) {
        throw configurationError(
          `Managed model process environment key '${key}' is not allowed.`,
        );
      }
    }
    if (definition.shutdownGraceMs !== undefined) {
      positiveInteger(definition.shutdownGraceMs, "shutdownGraceMs", 60_000);
    }
    if (definition.startupTimeoutMs !== undefined) {
      positiveInteger(definition.startupTimeoutMs, "startupTimeoutMs", 300_000);
    }
    if (definition.autoRestart) {
      positiveInteger(
        definition.maxRestartAttempts ?? 3,
        "maxRestartAttempts",
        100,
      );
      positiveInteger(
        definition.restartBackoffMs ?? 1_000,
        "restartBackoffMs",
        300_000,
      );
    }
  }

  private canonicalExecutable(value: string): string {
    if (
      !path.isAbsolute(value) ||
      !existsSync(value) ||
      !statSync(value).isFile()
    ) {
      throw configurationError(
        "Managed executable must be an existing absolute file.",
      );
    }
    return realpathSync(value);
  }

  private validateGenerateRequest(
    runtime: ModelRuntime,
    request: LocalModelGenerateRequest,
  ): void {
    const hasPrompt = typeof request.prompt === "string";
    const hasMessages =
      Array.isArray(request.messages) && request.messages.length > 0;
    if (hasPrompt === hasMessages) {
      throw configurationError("Provide exactly one of prompt or messages.");
    }
    const totalCharacters =
      (request.prompt?.length ?? 0) +
      (request.systemPrompt?.length ?? 0) +
      (request.messages ?? []).reduce(
        (total, message) => total + (message?.content?.length ?? 0),
        0,
      );
    if (
      totalCharacters > 20_000_000 ||
      (request.messages?.length ?? 0) > 100_000
    ) {
      throw new LocalModelSchedulerError(
        "Local model input is too large.",
        "TOKEN_BUDGET_EXCEEDED",
      );
    }
    for (const message of request.messages ?? []) {
      if (
        !message ||
        !["system", "user", "assistant"].includes(message.role) ||
        typeof message.content !== "string"
      ) {
        throw configurationError(
          "Local model messages contain an invalid entry.",
        );
      }
    }
    const requestedOutputTokens =
      request.maxOutputTokens ?? runtime.definition.maxOutputTokens;
    const outputTokens = request.fastMode
      ? Math.min(requestedOutputTokens, FAST_MODE_MAX_OUTPUT_TOKENS)
      : requestedOutputTokens;
    positiveInteger(
      outputTokens,
      "maxOutputTokens",
      runtime.definition.maxOutputTokens,
    );
    const inputTokens = estimateRequestTokens(request);
    if (inputTokens + outputTokens > runtime.definition.contextWindowTokens) {
      throw new LocalModelSchedulerError(
        `Request needs approximately ${inputTokens + outputTokens} tokens but the context window is ${runtime.definition.contextWindowTokens}.`,
        "TOKEN_BUDGET_EXCEEDED",
      );
    }
    if (
      request.temperature !== undefined &&
      (!Number.isFinite(request.temperature) ||
        request.temperature < 0 ||
        request.temperature > 2)
    ) {
      throw configurationError("temperature must be between 0 and 2.");
    }
    if (
      request.reasoningEffort !== undefined &&
      !["off", "low", "medium", "high"].includes(request.reasoningEffort)
    ) {
      throw configurationError(
        "reasoningEffort must be off, low, medium, or high.",
      );
    }
    if (
      request.fastMode !== undefined &&
      typeof request.fastMode !== "boolean"
    ) {
      throw configurationError("fastMode must be boolean.");
    }
  }

  private async callProvider(
    runtime: ModelRuntime,
    request: LocalModelGenerateRequest,
    signal: AbortSignal,
  ): Promise<
    Pick<LocalModelGenerateResult, "text" | "outputTokens" | "totalTokens">
  > {
    const requestedMaximum =
      request.maxOutputTokens ?? runtime.definition.maxOutputTokens;
    const maximum = request.fastMode
      ? Math.min(requestedMaximum, FAST_MODE_MAX_OUTPUT_TOKENS)
      : requestedMaximum;
    const reasoningEffort = request.fastMode
      ? "off"
      : (request.reasoningEffort ?? "off");
    const isOllama = runtime.definition.adapter === "ollama";
    const messages = request.messages
      ? request.messages
      : [
          ...(request.systemPrompt
            ? ([
                { role: "system", content: request.systemPrompt },
              ] as LocalModelMessage[])
            : []),
          { role: "user", content: request.prompt ?? "" } as LocalModelMessage,
        ];
    const url = endpointUrl(
      runtime.definition.endpoint,
      isOllama ? "api/generate" : "v1/chat/completions",
    );
    const body = isOllama
      ? {
          model: runtime.definition.model,
          prompt:
            request.prompt ??
            messages
              .map((message) => `${message.role}: ${message.content}`)
              .join("\n\n"),
          system: request.systemPrompt,
          think: reasoningEffort !== "off",
          stream: false,
          options: { num_predict: maximum, temperature: request.temperature },
        }
      : {
          model: runtime.definition.model,
          messages,
          max_tokens: maximum,
          temperature: request.temperature,
          ...(reasoningEffort !== "off"
            ? { reasoning_effort: reasoningEffort }
            : {}),
          stream: false,
        };
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
      redirect: "error",
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new LocalModelSchedulerError(
        "Local model redirects are not allowed.",
        "LOCAL_MODEL_ERROR",
      );
    }
    const text = await readBoundedBody(
      response,
      runtime.definition.responseMaxBytes,
    );
    if (!response.ok) {
      throw new LocalModelSchedulerError(
        `Local model returned HTTP ${response.status}.`,
        "LOCAL_MODEL_ERROR",
      );
    }
    const parsed = parseJsonObject(text);
    if (isOllama) {
      if (typeof parsed.response !== "string") {
        throw new LocalModelSchedulerError(
          "Ollama response omitted response text.",
          "LOCAL_MODEL_ERROR",
        );
      }
      return {
        text: parsed.response,
        outputTokens:
          typeof parsed.eval_count === "number" ? parsed.eval_count : undefined,
        totalTokens:
          typeof parsed.eval_count === "number" &&
          typeof parsed.prompt_eval_count === "number"
            ? parsed.eval_count + parsed.prompt_eval_count
            : undefined,
      };
    }

    const choices = parsed.choices;
    const first = Array.isArray(choices) ? choices[0] : undefined;
    const message =
      first && typeof first === "object"
        ? (first as Record<string, unknown>).message
        : undefined;
    const content =
      message && typeof message === "object"
        ? (message as Record<string, unknown>).content
        : undefined;
    if (typeof content !== "string") {
      throw new LocalModelSchedulerError(
        "OpenAI-compatible response omitted message content.",
        "LOCAL_MODEL_ERROR",
      );
    }
    const usage =
      parsed.usage && typeof parsed.usage === "object"
        ? (parsed.usage as Record<string, unknown>)
        : {};
    return {
      text: content,
      outputTokens:
        typeof usage.completion_tokens === "number"
          ? usage.completion_tokens
          : undefined,
      totalTokens:
        typeof usage.total_tokens === "number" ? usage.total_tokens : undefined,
    };
  }

  private async probeHealth(runtime: ModelRuntime): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      runtime.definition.healthTimeoutMs,
    );
    timer.unref();
    runtime.lastHealthCheckAt = new Date().toISOString();
    try {
      const suffix =
        runtime.definition.adapter === "ollama" ? "api/tags" : "v1/models";
      const response = await fetch(
        endpointUrl(runtime.definition.endpoint, suffix),
        {
          method: "GET",
          signal: controller.signal,
          redirect: "error",
        },
      );
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new Error("Health endpoint attempted a redirect.");
      }
      const body = await readBoundedBody(
        response,
        Math.min(runtime.definition.responseMaxBytes, 512 * 1024),
      );
      if (!response.ok)
        throw new Error(`Health endpoint returned HTTP ${response.status}.`);
      const payload = parseJsonObject(body);
      if (runtime.definition.adapter === "ollama") {
        const models = Array.isArray(payload.models) ? payload.models : [];
        const match = models.find((item) => {
          if (!item || typeof item !== "object" || Array.isArray(item))
            return false;
          const row = item as Record<string, unknown>;
          return (
            row.name === runtime.definition.model ||
            row.model === runtime.definition.model
          );
        }) as Record<string, unknown> | undefined;
        const digest = typeof match?.digest === "string" ? match.digest : "";
        if (!/^sha256:[a-f0-9]{64}$/.test(digest)) {
          throw new Error(
            "Ollama health response did not expose the configured model digest.",
          );
        }
        runtime.observedRevision = digest;
      } else {
        const models = Array.isArray(payload.data) ? payload.data : [];
        const modelAvailable = models.some(
          (item) =>
            item &&
            typeof item === "object" &&
            !Array.isArray(item) &&
            (item as Record<string, unknown>).id === runtime.definition.model,
        );
        if (!modelAvailable) {
          throw new Error(
            "OpenAI-compatible health response did not list the configured model.",
          );
        }
        runtime.observedRevision = runtime.definition.revision;
      }
      runtime.lastHealthyAt = new Date().toISOString();
      runtime.lastError = undefined;
      return true;
    } catch (error) {
      runtime.lastError = safeErrorMessage(error);
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  private async checkRunningModels(): Promise<void> {
    if (this.closed) return;
    await Promise.allSettled(
      [...this.runtimes.values()]
        .filter(
          (runtime) =>
            runtime.state === "ready" || runtime.state === "unhealthy",
        )
        .map(async (runtime) => {
          const healthy = await this.probeHealth(runtime);
          if (runtime.state === "ready" || runtime.state === "unhealthy") {
            runtime.state = healthy ? "ready" : "unhealthy";
          }
        }),
    );
  }

  private acquire(
    runtime: ModelRuntime,
    signal: AbortSignal,
  ): Promise<() => void> {
    if (signal.aborted)
      return Promise.reject(signal.reason ?? new Error("Request cancelled."));
    if (runtime.activeRequests < runtime.definition.concurrency) {
      runtime.activeRequests += 1;
      return Promise.resolve(() => this.release(runtime));
    }
    if (runtime.queue.length >= runtime.definition.queueLimit) {
      return Promise.reject(
        new LocalModelSchedulerError(
          `Queue for model '${runtime.definition.id}' is full.`,
          "QUEUE_FULL",
        ),
      );
    }

    return new Promise<() => void>((resolve, reject) => {
      const entry: QueueEntry = {
        signal,
        reject,
        grant: () => {
          if (entry.abort) signal.removeEventListener("abort", entry.abort);
          runtime.activeRequests += 1;
          resolve(() => this.release(runtime));
        },
      };
      entry.abort = () => {
        const index = runtime.queue.indexOf(entry);
        if (index >= 0) runtime.queue.splice(index, 1);
        reject(signal.reason ?? new Error("Request cancelled."));
      };
      signal.addEventListener("abort", entry.abort, { once: true });
      runtime.queue.push(entry);
    });
  }

  private release(runtime: ModelRuntime): void {
    runtime.activeRequests = Math.max(0, runtime.activeRequests - 1);
    const next = runtime.queue.shift();
    next?.grant();
  }

  private rejectQueued(runtime: ModelRuntime, error: Error): void {
    for (const entry of runtime.queue.splice(0)) {
      if (entry.abort && entry.signal)
        entry.signal.removeEventListener("abort", entry.abort);
      entry.reject(error);
    }
  }

  private waitForExit(
    child: ChildProcess,
    timeoutMs: number,
  ): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null)
      return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.removeListener("exit", onExit);
        resolve(false);
      }, timeoutMs);
      timer.unref();
      const onExit = () => {
        clearTimeout(timer);
        resolve(true);
      };
      child.once("exit", onExit);
    });
  }

  private snapshotRuntime(runtime: ModelRuntime): LocalModelStatusSnapshot {
    return {
      id: runtime.definition.id,
      adapter: runtime.definition.adapter,
      endpoint: runtime.definition.endpoint,
      model: runtime.definition.model,
      modelRevision: runtime.observedRevision ?? runtime.definition.revision,
      managed: Boolean(runtime.definition.process),
      state: runtime.state,
      pid: runtime.process?.pid,
      activeRequests: runtime.activeRequests,
      queuedRequests: runtime.queue.length,
      concurrency: runtime.definition.concurrency,
      queueLimit: runtime.definition.queueLimit,
      contextWindowTokens: runtime.definition.contextWindowTokens,
      maxOutputTokens: runtime.definition.maxOutputTokens,
      lastHealthCheckAt: runtime.lastHealthCheckAt,
      lastHealthyAt: runtime.lastHealthyAt,
      lastError: runtime.lastError,
      restartAttempts: runtime.restartAttempts,
      logTail: runtime.logBuffer.text(),
    };
  }

  private requireRuntime(modelId: string): ModelRuntime {
    const runtime = this.runtimes.get(modelId);
    if (!runtime) {
      throw new LocalModelSchedulerError(
        `Unknown local model '${modelId}'.`,
        "MODEL_NOT_FOUND",
      );
    }
    return runtime;
  }

  private assertOpen(): void {
    if (this.closed)
      throw new LocalModelSchedulerError(
        "Local model scheduler is closed.",
        "SCHEDULER_CLOSED",
      );
  }
}
