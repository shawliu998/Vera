import { redactSensitiveText } from "../../safeError";
import type {
  CreateWorkspaceJobInput,
  WorkspaceJobCancellation,
  WorkspaceJobError,
  WorkspaceJobErrorInput,
  WorkspaceJobEvent,
  WorkspaceJobLogProjection,
  WorkspaceJobRecord,
  WorkspaceJobStatus,
  WorkspaceJobType,
  WorkspaceJobValueProjection,
} from "./types";
import {
  WORKSPACE_JOB_STATUSES,
  WORKSPACE_JOB_TYPES,
} from "./types";

const MAX_JOB_ATTEMPTS = 100;
const MAX_PROJECTION_KEYS = 8;
const MAX_VALIDATION_DEPTH = 8;
const SENSITIVE_KEY_PATTERN =
  /(prompt|document|content|text|api[_-]?key|token|secret|authorization|bearer)/i;

export const WORKSPACE_JOB_ALLOWED_TRANSITIONS: Record<
  WorkspaceJobStatus,
  readonly WorkspaceJobStatus[]
> = {
  queued: ["running", "cancelled"],
  running: ["complete", "failed", "cancelled", "interrupted"],
  complete: [],
  failed: ["queued", "cancelled"],
  cancelled: [],
  interrupted: ["queued", "cancelled"],
};

function invariant(message: string): never {
  throw new Error(message);
}

function assertNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    invariant(`${name} must be a non-empty string.`);
  }
  return value.trim();
}

function assertTimestamp(value: unknown, name: string): string {
  const text = assertNonEmptyString(value, name);
  if (Number.isNaN(Date.parse(text))) {
    invariant(`${name} must be a valid timestamp.`);
  }
  return text;
}

function assertPositiveInteger(value: unknown, name: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > MAX_JOB_ATTEMPTS
  ) {
    invariant(`${name} must be an integer between 1 and ${MAX_JOB_ATTEMPTS}.`);
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertWorkspaceJobType(value: unknown): WorkspaceJobType {
  if (
    typeof value !== "string" ||
    !(WORKSPACE_JOB_TYPES as readonly string[]).includes(value)
  ) {
    invariant(`Workspace job type ${String(value)} is not supported.`);
  }
  return value as WorkspaceJobType;
}

function assertWorkspaceJobStatus(value: unknown): WorkspaceJobStatus {
  if (
    typeof value !== "string" ||
    !(WORKSPACE_JOB_STATUSES as readonly string[]).includes(value)
  ) {
    invariant(`Workspace job status ${String(value)} is not supported.`);
  }
  return value as WorkspaceJobStatus;
}

function validateWorkspaceJobValue(
  value: unknown,
  name: string,
  depth = 0,
  seen = new WeakSet<object>(),
): void {
  if (depth > MAX_VALIDATION_DEPTH) {
    invariant(`${name} exceeds the maximum supported nesting depth.`);
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invariant(`${name} must not contain NaN or Infinity.`);
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      validateWorkspaceJobValue(
        value[index],
        `${name}[${index}]`,
        depth + 1,
        seen,
      );
    }
    return;
  }
  if (!isPlainObject(value)) {
    invariant(`${name} must be JSON-like data.`);
  }
  if (seen.has(value)) {
    invariant(`${name} must not contain circular references.`);
  }
  seen.add(value);
  for (const [key, nested] of Object.entries(value)) {
    validateWorkspaceJobValue(nested, `${name}.${key}`, depth + 1, seen);
  }
  seen.delete(value);
}

function normalizeIdempotencyKey(
  type: WorkspaceJobType,
  value: string | null | undefined,
): string | null {
  if (value == null) return null;
  const trimmed = assertNonEmptyString(value, "idempotencyKey");
  if (type !== "tabular_cell") {
    invariant("Only tabular_cell jobs may declare an idempotency key.");
  }
  if (trimmed.length > 200) {
    invariant("idempotencyKey must be 200 characters or fewer.");
  }
  return trimmed;
}

function sanitizeMessage(value: unknown, fallback: string): string {
  const raw =
    typeof value === "string"
      ? value
      : value instanceof Error
        ? value.message
        : fallback;
  const sanitized = redactSensitiveText(raw).trim();
  return sanitized.slice(0, 1_000) || fallback;
}

function sanitizeReason(value: string | null | undefined): string | null {
  if (value == null) return null;
  const sanitized = redactSensitiveText(String(value)).trim().slice(0, 500);
  return sanitized || null;
}

function projectKeyName(value: string): string | null {
  if (SENSITIVE_KEY_PATTERN.test(value)) return null;
  return value.slice(0, 64);
}

function projectionKind(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value === "object" ? "object" : typeof value;
}

export function projectWorkspaceJobValueForLogs(
  value: unknown,
): WorkspaceJobValueProjection {
  validateWorkspaceJobValue(value, "jobValue");
  if (value === null) return { kind: "null" };
  if (typeof value === "string") {
    return { kind: "string", length: value.length, redacted: true };
  }
  if (typeof value === "number") return { kind: "number" };
  if (typeof value === "boolean") return { kind: "boolean" };
  if (Array.isArray(value)) {
    const itemKinds = Array.from(
      new Set(value.map((item) => projectionKind(item))),
    );
    return {
      kind: "array",
      length: value.length,
      itemKinds: itemKinds.slice(0, MAX_PROJECTION_KEYS),
    };
  }
  if (!isPlainObject(value)) {
    invariant("jobValue must be a plain object.");
  }
  const keys = Object.keys(value);
  const visibleKeys = keys
    .map((key) => projectKeyName(key))
    .filter((key): key is string => key !== null)
    .slice(0, MAX_PROJECTION_KEYS);
  return {
    kind: "object",
    totalKeys: keys.length,
    keys: visibleKeys,
    sensitiveKeyCount: keys.length - visibleKeys.length,
  };
}

function normalizeWorkspaceJobError(
  input: WorkspaceJobErrorInput,
  fallbackCode: string,
  fallbackMessage: string,
  fallbackRetryable: boolean,
): WorkspaceJobError {
  if (!isPlainObject(input)) {
    invariant("Workspace job error input must be an object.");
  }
  const code = assertNonEmptyString(input.code ?? fallbackCode, "error.code")
    .replace(/[^A-Za-z0-9_.-]/g, "_")
    .slice(0, 120);
  const retryable =
    typeof input.retryable === "boolean" ? input.retryable : fallbackRetryable;
  const details =
    input.details === undefined
      ? null
      : projectWorkspaceJobValueForLogs(input.details);
  return {
    code,
    message: sanitizeMessage(input.message, fallbackMessage),
    retryable,
    details,
  };
}

function assertTransitionAllowed(
  current: WorkspaceJobStatus,
  next: WorkspaceJobStatus,
): void {
  if (!WORKSPACE_JOB_ALLOWED_TRANSITIONS[current].includes(next)) {
    invariant(`Workspace job transition ${current} -> ${next} is not allowed.`);
  }
}

export function canRetryWorkspaceJob(job: WorkspaceJobRecord): boolean {
  assertWorkspaceJobRecord(job);
  return (
    (job.status === "failed" || job.status === "interrupted") &&
    job.error?.retryable === true &&
    job.attempt < job.maxAttempts
  );
}

export function canCancelWorkspaceJob(job: WorkspaceJobRecord): boolean {
  assertWorkspaceJobRecord(job);
  return job.status !== "complete" && job.status !== "cancelled";
}

export function canReuseCompletedJob(
  job: WorkspaceJobRecord,
  type: WorkspaceJobType,
  idempotencyKey: string | null | undefined,
): boolean {
  assertWorkspaceJobRecord(job);
  const normalizedKey = normalizeIdempotencyKey(type, idempotencyKey);
  return (
    job.status === "complete" &&
    job.type === type &&
    normalizedKey !== null &&
    job.idempotencyKey === normalizedKey
  );
}

function nextCancellation(
  at: string,
  reason: string | null | undefined,
): WorkspaceJobCancellation {
  return {
    requestedAt: at,
    reason: sanitizeReason(reason),
  };
}

export function createWorkspaceJob(
  input: CreateWorkspaceJobInput,
): WorkspaceJobRecord {
  const type = assertWorkspaceJobType(input.type);
  const createdAt = assertTimestamp(input.createdAt, "createdAt");
  validateWorkspaceJobValue(input.payload, "payload");
  return {
    id: assertNonEmptyString(input.id, "id"),
    type,
    status: "queued",
    payload: input.payload,
    result: null,
    error: null,
    attempt: 0,
    maxAttempts: assertPositiveInteger(input.maxAttempts, "maxAttempts"),
    idempotencyKey: normalizeIdempotencyKey(type, input.idempotencyKey),
    createdAt,
    queuedAt: createdAt,
    startedAt: null,
    completedAt: null,
    cancellation: null,
    updatedAt: createdAt,
  };
}

export function assertWorkspaceJobRecord(job: WorkspaceJobRecord): void {
  assertNonEmptyString(job.id, "job.id");
  assertWorkspaceJobType(job.type);
  const status = assertWorkspaceJobStatus(job.status);
  validateWorkspaceJobValue(job.payload, "job.payload");
  if (job.result !== null) validateWorkspaceJobValue(job.result, "job.result");
  assertPositiveInteger(job.maxAttempts, "job.maxAttempts");
  if (!Number.isSafeInteger(job.attempt) || job.attempt < 0) {
    invariant("job.attempt must be a non-negative integer.");
  }
  if (job.attempt > job.maxAttempts) {
    invariant("job.attempt must not exceed job.maxAttempts.");
  }
  normalizeIdempotencyKey(job.type, job.idempotencyKey);
  assertTimestamp(job.createdAt, "job.createdAt");
  assertTimestamp(job.queuedAt, "job.queuedAt");
  assertTimestamp(job.updatedAt, "job.updatedAt");
  if (job.startedAt !== null) assertTimestamp(job.startedAt, "job.startedAt");
  if (job.completedAt !== null) {
    assertTimestamp(job.completedAt, "job.completedAt");
  }
  if (job.error) {
    assertNonEmptyString(job.error.code, "job.error.code");
    assertNonEmptyString(job.error.message, "job.error.message");
    if (typeof job.error.retryable !== "boolean") {
      invariant("job.error.retryable must be a boolean.");
    }
  }
  if (job.cancellation) {
    assertTimestamp(job.cancellation.requestedAt, "job.cancellation.requestedAt");
  }
  if (status === "queued") {
    if (job.startedAt !== null || job.completedAt !== null) {
      invariant("Queued jobs must not carry startedAt or completedAt.");
    }
  }
  if (status === "running") {
    if (job.startedAt === null || job.completedAt !== null) {
      invariant("Running jobs require startedAt and must not carry completedAt.");
    }
  }
  if (status === "complete") {
    if (job.startedAt === null || job.completedAt === null) {
      invariant("Complete jobs require startedAt and completedAt.");
    }
    if (job.error !== null) {
      invariant("Complete jobs must not carry an error.");
    }
  }
  if (status === "failed" || status === "interrupted") {
    if (job.startedAt === null || job.completedAt === null || job.error === null) {
      invariant(`${status} jobs require startedAt, completedAt, and an error.`);
    }
  }
  if (status === "cancelled") {
    if (job.completedAt === null || job.cancellation === null) {
      invariant("Cancelled jobs require completedAt and cancellation details.");
    }
  }
}

export function transitionWorkspaceJob(
  job: WorkspaceJobRecord,
  event: WorkspaceJobEvent,
): WorkspaceJobRecord {
  assertWorkspaceJobRecord(job);
  const at = assertTimestamp(event.at, `${event.type}.at`);
  switch (event.type) {
    case "start": {
      assertTransitionAllowed(job.status, "running");
      if (job.attempt >= job.maxAttempts) {
        invariant("Workspace job has exhausted maxAttempts.");
      }
      const next: WorkspaceJobRecord = {
        ...job,
        status: "running",
        attempt: job.attempt + 1,
        startedAt: at,
        completedAt: null,
        error: null,
        result: null,
        cancellation: null,
        updatedAt: at,
      };
      assertWorkspaceJobRecord(next);
      return next;
    }
    case "complete": {
      assertTransitionAllowed(job.status, "complete");
      validateWorkspaceJobValue(event.result, "result");
      const next: WorkspaceJobRecord = {
        ...job,
        status: "complete",
        result: event.result,
        error: null,
        completedAt: at,
        updatedAt: at,
      };
      assertWorkspaceJobRecord(next);
      return next;
    }
    case "fail": {
      assertTransitionAllowed(job.status, "failed");
      const next: WorkspaceJobRecord = {
        ...job,
        status: "failed",
        result: null,
        error: normalizeWorkspaceJobError(
          event.error,
          "workspace_job_failed",
          "Workspace job failed.",
          false,
        ),
        completedAt: at,
        updatedAt: at,
      };
      assertWorkspaceJobRecord(next);
      return next;
    }
    case "cancel": {
      assertTransitionAllowed(job.status, "cancelled");
      const next: WorkspaceJobRecord = {
        ...job,
        status: "cancelled",
        completedAt: at,
        cancellation: nextCancellation(at, event.reason),
        updatedAt: at,
      };
      assertWorkspaceJobRecord(next);
      return next;
    }
    case "interrupt": {
      assertTransitionAllowed(job.status, "interrupted");
      const next: WorkspaceJobRecord = {
        ...job,
        status: "interrupted",
        result: null,
        error: normalizeWorkspaceJobError(
          {
            code: event.error?.code ?? "workspace_job_interrupted",
            message:
              event.error?.message ??
              "Workspace job was interrupted before completion.",
            retryable: event.error?.retryable ?? true,
            details: event.error?.details,
          },
          "workspace_job_interrupted",
          "Workspace job was interrupted before completion.",
          true,
        ),
        completedAt: at,
        updatedAt: at,
      };
      assertWorkspaceJobRecord(next);
      return next;
    }
    case "retry": {
      assertTransitionAllowed(job.status, "queued");
      if (!canRetryWorkspaceJob(job)) {
        invariant(
          "Workspace job cannot be retried unless it is retryable and within maxAttempts.",
        );
      }
      const next: WorkspaceJobRecord = {
        ...job,
        status: "queued",
        result: null,
        error: null,
        queuedAt: at,
        startedAt: null,
        completedAt: null,
        cancellation: null,
        updatedAt: at,
      };
      assertWorkspaceJobRecord(next);
      return next;
    }
  }
}

export function recoverRunningWorkspaceJobs(
  jobs: readonly WorkspaceJobRecord[],
  recoveredAt: string,
): WorkspaceJobRecord[] {
  const at = assertTimestamp(recoveredAt, "recoveredAt");
  return jobs.map((job) =>
    job.status === "running"
      ? transitionWorkspaceJob(job, {
          type: "interrupt",
          at,
          error: {
            code: "workspace_job_recovered_after_restart",
            message:
              "Workspace job was running during process restart recovery and must be retried.",
            retryable: true,
            details: { recovery: "restart", previousStatus: "running" },
          },
        })
      : (assertWorkspaceJobRecord(job), job),
  );
}

export function projectWorkspaceJobForLogs(
  job: WorkspaceJobRecord,
): WorkspaceJobLogProjection {
  assertWorkspaceJobRecord(job);
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    attempt: job.attempt,
    maxAttempts: job.maxAttempts,
    idempotencyKey: job.idempotencyKey,
    createdAt: job.createdAt,
    queuedAt: job.queuedAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    cancellation: job.cancellation,
    error: job.error,
    payload: projectWorkspaceJobValueForLogs(job.payload),
    result:
      job.result === null ? null : projectWorkspaceJobValueForLogs(job.result),
  };
}
