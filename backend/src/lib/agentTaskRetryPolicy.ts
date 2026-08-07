import type { AgentTaskRetryClassification } from "./agent-kernel/outcomes/executionOutcome";

export type TransientAgentTaskError = {
  classification: AgentTaskRetryClassification;
  retryAfterMs: number | null;
};

export type AgentTaskProviderProtocolError = {
  classification: "provider_protocol" | "provider_structured_output";
};

export const MAX_AGENT_TASK_TRANSIENT_RETRIES = 3;
export const MAX_AGENT_TASK_TRANSIENT_WAIT_MS = 60_000;

const RATE_LIMIT_HTTP_STATUSES = new Set([429]);
const PROVIDER_UNAVAILABLE_HTTP_STATUSES = new Set([500, 502, 503]);
const TIMEOUT_HTTP_STATUSES = new Set([408, 504]);
const REQUIRED_TOOL_CALL_PROTOCOL_ERROR =
  /^(DeepSeek|Kimi|Gemini|Zhipu|Claude|OpenAI) did not return the required ([A-Za-z][A-Za-z0-9_-]*) tool call for this iteration\.$/;

function numericStatus(error: unknown) {
  if (!error || typeof error !== "object") return null;
  const row = error as {
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown };
  };
  for (const value of [row.status, row.statusCode, row.response?.status]) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && /^\d{3}$/.test(value.trim())) {
      return Number(value.trim());
    }
  }
  return null;
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (!error || typeof error !== "object") {
    return typeof error === "string" ? error : "";
  }
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" ? message : "";
}

function retryAfterHeader(error: unknown) {
  if (!error || typeof error !== "object") return null;
  const row = error as {
    retryAfter?: unknown;
    headers?: unknown;
    response?: { headers?: unknown };
  };
  if (
    typeof row.retryAfter === "string" ||
    typeof row.retryAfter === "number"
  ) {
    return String(row.retryAfter);
  }
  for (const headers of [row.headers, row.response?.headers]) {
    if (!headers || typeof headers !== "object") continue;
    const getter = (headers as { get?: unknown }).get;
    if (typeof getter === "function") {
      try {
        const value = getter.call(headers, "retry-after");
        if (typeof value === "string" && value.trim()) return value.trim();
      } catch {
        // An unreadable provider header must not make retry classification fail.
      }
    }
    const record = headers as Record<string, unknown>;
    const value = record["retry-after"] ?? record["Retry-After"];
    if (typeof value === "string" || typeof value === "number") {
      return String(value);
    }
  }
  return (
    errorMessage(error).match(/retry-after\s*[:=]\s*([^\s,;]+)/i)?.[1] ?? null
  );
}

export function parseRetryAfterMs(value: string | null, nowMs: number) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const dateMs = Date.parse(value);
  return Number.isNaN(dateMs) ? null : Math.max(0, dateMs - nowMs);
}

function hasRateLimitSignal(message: string) {
  return /\b1302\b|rate.?limit|throttl|速率限制|请求(?:过于|太)?频繁|resource[_ ]exhausted/i.test(
    message,
  );
}

function hasProviderCapacitySignal(message: string) {
  return /\b1305\b|访问量过大|overloaded|queue|temporarily unavailable|service[_ ]unavailable|service is too busy|\btoo busy\b/i.test(
    message,
  );
}

function hasTimeoutSignal(error: unknown, message: string) {
  const name =
    error && typeof error === "object"
      ? (error as { name?: unknown }).name
      : undefined;
  return (
    name === "TimeoutError" ||
    name === "AbortError" ||
    /\b(?:etimedout|deadline[_ ]exceeded)\b|\btimed? out\b|\btimeout\b|\babort(?:ed)?\b/i.test(
      message,
    )
  );
}

function hasNetworkSignal(message: string) {
  return /\b(?:econnreset|enetunreach|eai_again)\b|fetch failed|network error|socket hang up/i.test(
    message,
  );
}

/**
 * Classifies only provider capacity, timeout, and network failures that can safely
 * resume the current server-owned Task and Step. HTTP 200 is fail-closed
 * unless its SSE error text carries one of the explicit provider signals.
 */
export function classifyAgentTaskError(
  error: unknown,
  nowMs = Date.now(),
): TransientAgentTaskError | null {
  const status = numericStatus(error);
  const message = errorMessage(error);
  const rateLimited = hasRateLimitSignal(message);
  const unavailable = hasProviderCapacitySignal(message);

  if (status === 200) {
    if (!rateLimited && !unavailable) return null;
    return {
      classification: rateLimited ? "rate_limit" : "provider_unavailable",
      retryAfterMs: parseRetryAfterMs(retryAfterHeader(error), nowMs),
    };
  }
  if (
    status != null &&
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 429
  ) {
    return null;
  }
  if (status === 429 || rateLimited) {
    return {
      classification: "rate_limit",
      retryAfterMs: parseRetryAfterMs(retryAfterHeader(error), nowMs),
    };
  }
  if (PROVIDER_UNAVAILABLE_HTTP_STATUSES.has(status ?? -1) || unavailable) {
    return {
      classification: "provider_unavailable",
      retryAfterMs: parseRetryAfterMs(retryAfterHeader(error), nowMs),
    };
  }
  if (
    TIMEOUT_HTTP_STATUSES.has(status ?? -1) ||
    hasTimeoutSignal(error, message)
  ) {
    return {
      classification: "timeout",
      retryAfterMs: parseRetryAfterMs(retryAfterHeader(error), nowMs),
    };
  }
  if (hasNetworkSignal(message)) {
    return {
      classification: "network",
      retryAfterMs: parseRetryAfterMs(retryAfterHeader(error), nowMs),
    };
  }
  return null;
}

/**
 * Accepts only the provider-neutral, server-owned required-tool diagnostic.
 * All policy, registration, authorization, argument, and target errors remain
 * fail-closed because they do not match this complete diagnostic exactly.
 */
export function classifyAgentTaskProviderProtocolError(
  error: unknown,
): AgentTaskProviderProtocolError | null {
  if (REQUIRED_TOOL_CALL_PROTOCOL_ERROR.test(errorMessage(error))) {
    return { classification: "provider_protocol" };
  }
  const name =
    error && typeof error === "object"
      ? (error as { name?: unknown }).name
      : null;
  return name === "AgentVerifierStructuredOutputError"
    ? { classification: "provider_structured_output" }
    : null;
}

export function agentTaskRetryBaseMs(
  classification: TransientAgentTaskError["classification"],
) {
  return classification === "provider_unavailable"
    ? 30_000
    : classification === "rate_limit"
      ? 10_000
      : 2_000;
}

export function calculateAgentTaskBackoffMs(
  attempt: number,
  options: {
    retryAfterMs?: number | null;
    baseMs?: number;
    maxMs?: number;
    jitterRatio?: number;
    random?: () => number;
  } = {},
) {
  const maxMs = options.maxMs ?? MAX_AGENT_TASK_TRANSIENT_WAIT_MS;
  if (options.retryAfterMs != null) {
    return Math.max(0, Math.min(maxMs, Math.round(options.retryAfterMs)));
  }
  const exponential = Math.min(
    maxMs,
    (options.baseMs ?? 2_000) * 2 ** Math.max(0, attempt - 1),
  );
  const jitter = options.jitterRatio ?? 0.2;
  const factor = 1 - jitter + (options.random ?? Math.random)() * jitter * 2;
  return Math.max(0, Math.min(maxMs, Math.round(exponential * factor)));
}
