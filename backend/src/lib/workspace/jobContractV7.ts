import { z } from "zod";

import {
  StructuredErrorSchema,
  UnicodeCodePointStringSchemaV1,
  type StructuredErrorV1,
} from "./workspacePersistencePrimitivesV1";

export const JOB_CONTRACT_V7_MANIFEST = {
  version: "workspace-job-contract-v7",
  limits: {
    maxAttempts: 100,
    maxValidationDepth: 8,
    maxIdempotencyKey: 200,
    maxProjectionKeys: 8,
  },
  enums: {
    types: [
      "document_parse",
      "assistant_generate",
      "workflow_run",
      "tabular_cell",
    ],
    statuses: [
      "queued",
      "running",
      "complete",
      "failed",
      "cancelled",
      "interrupted",
    ],
    resourceTypes: [
      "document",
      "chat",
      "workflow_run",
      "tabular_cell",
      "tabular_review",
      "project",
    ],
  },
  idempotency: {
    onlyType: "tabular_cell",
    maxLength: 200,
  },
  jsonValue: {
    finiteNumbersOnly: true,
    plainObjectsOnly: true,
    maxDepth: 8,
  },
  logProjection: {
    redactsStringValues: true,
    maxObjectKeys: 8,
    sensitiveKeyRegex:
      "(prompt|document|content|text|api[_-]?key|token|secret|authorization|bearer)",
    sensitiveKeyRegexFlags: "i",
  },
  error: {
    schema:
      "StructuredErrorV1 with details limited to WorkspaceJobValueProjection",
    nullableStatuses: ["queued", "running", "complete"],
    requiredStatuses: ["failed", "interrupted"],
    cancelled: "may_be_null_or_valid_error_object",
  },
  cancellation: {
    requestedAt: "valid_timestamp",
    reason: { nullable: true, max: 500 },
  },
  lifecycle: {
    queued: { startedAt: null, completedAt: null },
    running: { startedAt: "required", completedAt: null },
    complete: { startedAt: "required", completedAt: "required", error: null },
    failed: {
      startedAt: "required",
      completedAt: "required",
      error: "required",
    },
    interrupted: {
      startedAt: "required",
      completedAt: "required",
      error: "required",
    },
    cancelled: { completedAt: "required", cancellation: "required" },
  },
} as const;

export const WORKSPACE_JOB_TYPES = JOB_CONTRACT_V7_MANIFEST.enums.types;
export const WORKSPACE_JOB_STATUSES = JOB_CONTRACT_V7_MANIFEST.enums.statuses;
export const WORKSPACE_JOB_RESOURCE_TYPES =
  JOB_CONTRACT_V7_MANIFEST.enums.resourceTypes;

export type WorkspaceJobType = (typeof WORKSPACE_JOB_TYPES)[number];
export type WorkspaceJobStatus = (typeof WORKSPACE_JOB_STATUSES)[number];
export type WorkspaceJobResourceType =
  (typeof WORKSPACE_JOB_RESOURCE_TYPES)[number];

const WORKSPACE_JOB_PROJECTION_KINDS = [
  "null",
  "string",
  "number",
  "boolean",
  "array",
  "object",
] as const;
const WORKSPACE_JOB_SENSITIVE_PROJECTION_KEY_PATTERN = new RegExp(
  JOB_CONTRACT_V7_MANIFEST.logProjection.sensitiveKeyRegex,
  JOB_CONTRACT_V7_MANIFEST.logProjection.sensitiveKeyRegexFlags,
);

export interface WorkspaceJobErrorInput {
  code: string;
  message: string;
  retryable: boolean;
  details?: unknown;
}

export type WorkspaceJobError = Omit<StructuredErrorV1, "details"> & {
  details: WorkspaceJobValueProjection | null;
};

export interface WorkspaceJobCancellation {
  requestedAt: string;
  reason: string | null;
}

export type WorkspaceJobValueProjection =
  | { kind: "null" }
  | { kind: "string"; length: number; redacted: true }
  | { kind: "number" }
  | { kind: "boolean" }
  | { kind: "array"; length: number; itemKinds: string[] }
  | {
      kind: "object";
      totalKeys: number;
      keys: string[];
      sensitiveKeyCount: number;
    };

const WorkspaceJobValueProjectionSchema: z.ZodType<WorkspaceJobValueProjection> =
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("null") }).strict(),
    z
      .object({
        kind: z.literal("string"),
        length: z.number().int().nonnegative().finite(),
        redacted: z.literal(true),
      })
      .strict(),
    z.object({ kind: z.literal("number") }).strict(),
    z.object({ kind: z.literal("boolean") }).strict(),
    z
      .object({
        kind: z.literal("array"),
        length: z.number().int().nonnegative().finite(),
        itemKinds: z
          .array(z.enum(WORKSPACE_JOB_PROJECTION_KINDS))
          .max(JOB_CONTRACT_V7_MANIFEST.limits.maxProjectionKeys),
      })
      .strict(),
    z
      .object({
        kind: z.literal("object"),
        totalKeys: z.number().int().nonnegative().finite(),
        keys: z
          .array(z.string().min(1).max(64))
          .max(JOB_CONTRACT_V7_MANIFEST.limits.maxProjectionKeys)
          .superRefine((keys, context) => {
            for (const [index, key] of keys.entries()) {
              if (WORKSPACE_JOB_SENSITIVE_PROJECTION_KEY_PATTERN.test(key)) {
                context.addIssue({
                  code: z.ZodIssueCode.custom,
                  path: [index],
                  message: "sensitive projection keys are not allowed",
                });
              }
            }
          }),
        sensitiveKeyCount: z.number().int().nonnegative().finite(),
      })
      .strict(),
  ]);

const WorkspaceJobErrorSchema: z.ZodType<WorkspaceJobError> =
  StructuredErrorSchema.extend({
    details: WorkspaceJobValueProjectionSchema.nullable(),
  }).strict() as z.ZodType<WorkspaceJobError>;
const WorkspaceJobCancellationSchema: z.ZodType<WorkspaceJobCancellation> = z
  .object({
    requestedAt: z.string().min(1),
    reason: UnicodeCodePointStringSchemaV1({
      min: 1,
      max: JOB_CONTRACT_V7_MANIFEST.cancellation.reason.max,
      trimForMin: true,
    }).nullable(),
  })
  .strict();

export function assertWorkspaceJobCancellationV7(
  value: WorkspaceJobCancellation,
): WorkspaceJobCancellation {
  try {
    return WorkspaceJobCancellationSchema.parse(value);
  } catch (error) {
    workspaceJobContractInvariantV7(
      error instanceof Error ? error.message : "job.cancellation is invalid.",
    );
  }
}

export interface WorkspaceJobRecord {
  id: string;
  type: WorkspaceJobType;
  status: WorkspaceJobStatus;
  payload: unknown;
  result: unknown | null;
  error: WorkspaceJobError | null;
  attempt: number;
  maxAttempts: number;
  idempotencyKey: string | null;
  createdAt: string;
  queuedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  cancellation: WorkspaceJobCancellation | null;
  updatedAt: string;
}

export interface CreateWorkspaceJobInput {
  id: string;
  type: WorkspaceJobType;
  payload: unknown;
  maxAttempts: number;
  createdAt: string;
  idempotencyKey?: string | null;
}

export type WorkspaceJobEvent =
  | { type: "start"; at: string }
  | { type: "complete"; at: string; result: unknown }
  | { type: "fail"; at: string; error: WorkspaceJobErrorInput }
  | { type: "cancel"; at: string; reason?: string | null }
  | { type: "interrupt"; at: string; error?: Partial<WorkspaceJobErrorInput> }
  | { type: "retry"; at: string };

export interface WorkspaceJobLogProjection {
  id: string;
  type: WorkspaceJobType;
  status: WorkspaceJobStatus;
  attempt: number;
  maxAttempts: number;
  idempotencyKey: string | null;
  createdAt: string;
  queuedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  cancellation: WorkspaceJobCancellation | null;
  error: WorkspaceJobError | null;
  payload: WorkspaceJobValueProjection;
  result: WorkspaceJobValueProjection | null;
}

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

export function workspaceJobContractInvariantV7(message: string): never {
  throw new Error(message);
}

export function assertWorkspaceJobNonEmptyStringV7(
  value: unknown,
  name: string,
): string {
  if (typeof value !== "string" || value.trim() === "") {
    workspaceJobContractInvariantV7(`${name} must be a non-empty string.`);
  }
  return value.trim();
}

export function assertWorkspaceJobTimestampV7(
  value: unknown,
  name: string,
): string {
  const text = assertWorkspaceJobNonEmptyStringV7(value, name);
  if (Number.isNaN(Date.parse(text))) {
    workspaceJobContractInvariantV7(`${name} must be a valid timestamp.`);
  }
  return text;
}

export function assertWorkspaceJobPositiveMaxAttemptsV7(
  value: unknown,
  name: string,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > JOB_CONTRACT_V7_MANIFEST.limits.maxAttempts
  ) {
    workspaceJobContractInvariantV7(
      `${name} must be an integer between 1 and ${JOB_CONTRACT_V7_MANIFEST.limits.maxAttempts}.`,
    );
  }
  return value;
}

export function isWorkspaceJobPlainObjectV7(
  value: unknown,
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function assertWorkspaceJobTypeV7(value: unknown): WorkspaceJobType {
  if (
    typeof value !== "string" ||
    !(WORKSPACE_JOB_TYPES as readonly string[]).includes(value)
  ) {
    workspaceJobContractInvariantV7(
      `Workspace job type ${String(value)} is not supported.`,
    );
  }
  return value as WorkspaceJobType;
}

export function assertWorkspaceJobStatusV7(value: unknown): WorkspaceJobStatus {
  if (
    typeof value !== "string" ||
    !(WORKSPACE_JOB_STATUSES as readonly string[]).includes(value)
  ) {
    workspaceJobContractInvariantV7(
      `Workspace job status ${String(value)} is not supported.`,
    );
  }
  return value as WorkspaceJobStatus;
}

export function assertWorkspaceJobResourceTypeV7(
  value: unknown,
): WorkspaceJobResourceType {
  if (
    typeof value !== "string" ||
    !(WORKSPACE_JOB_RESOURCE_TYPES as readonly string[]).includes(value)
  ) {
    workspaceJobContractInvariantV7(
      `Unsupported resourceType ${String(value)}.`,
    );
  }
  return value as WorkspaceJobResourceType;
}

export function validateWorkspaceJobValueV7(
  value: unknown,
  name: string,
  depth = 0,
  seen = new WeakSet<object>(),
): void {
  if (depth > JOB_CONTRACT_V7_MANIFEST.limits.maxValidationDepth) {
    workspaceJobContractInvariantV7(
      `${name} exceeds the maximum supported nesting depth.`,
    );
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      workspaceJobContractInvariantV7(
        `${name} must not contain NaN or Infinity.`,
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      validateWorkspaceJobValueV7(
        value[index],
        `${name}[${index}]`,
        depth + 1,
        seen,
      );
    }
    return;
  }
  if (!isWorkspaceJobPlainObjectV7(value)) {
    workspaceJobContractInvariantV7(`${name} must be JSON-like data.`);
  }
  if (seen.has(value)) {
    workspaceJobContractInvariantV7(
      `${name} must not contain circular references.`,
    );
  }
  seen.add(value);
  for (const [key, nested] of Object.entries(value)) {
    validateWorkspaceJobValueV7(nested, `${name}.${key}`, depth + 1, seen);
  }
  seen.delete(value);
}

export function normalizeWorkspaceJobIdempotencyKeyV7(
  type: WorkspaceJobType,
  value: string | null | undefined,
): string | null {
  if (value == null) return null;
  const trimmed = assertWorkspaceJobNonEmptyStringV7(value, "idempotencyKey");
  if (type !== JOB_CONTRACT_V7_MANIFEST.idempotency.onlyType) {
    workspaceJobContractInvariantV7(
      "Only tabular_cell jobs may declare an idempotency key.",
    );
  }
  if (trimmed.length > JOB_CONTRACT_V7_MANIFEST.limits.maxIdempotencyKey) {
    workspaceJobContractInvariantV7(
      "idempotencyKey must be 200 characters or fewer.",
    );
  }
  return trimmed;
}

export function assertWorkspaceJobRecordV7(job: WorkspaceJobRecord): void {
  assertWorkspaceJobNonEmptyStringV7(job.id, "job.id");
  assertWorkspaceJobTypeV7(job.type);
  const status = assertWorkspaceJobStatusV7(job.status);
  validateWorkspaceJobValueV7(job.payload, "job.payload");
  if (job.result !== null)
    validateWorkspaceJobValueV7(job.result, "job.result");
  assertWorkspaceJobPositiveMaxAttemptsV7(job.maxAttempts, "job.maxAttempts");
  if (!Number.isSafeInteger(job.attempt) || job.attempt < 0) {
    workspaceJobContractInvariantV7(
      "job.attempt must be a non-negative integer.",
    );
  }
  if (job.attempt > job.maxAttempts) {
    workspaceJobContractInvariantV7(
      "job.attempt must not exceed job.maxAttempts.",
    );
  }
  normalizeWorkspaceJobIdempotencyKeyV7(job.type, job.idempotencyKey);
  assertWorkspaceJobTimestampV7(job.createdAt, "job.createdAt");
  assertWorkspaceJobTimestampV7(job.queuedAt, "job.queuedAt");
  assertWorkspaceJobTimestampV7(job.updatedAt, "job.updatedAt");
  if (job.startedAt !== null) {
    assertWorkspaceJobTimestampV7(job.startedAt, "job.startedAt");
  }
  if (job.completedAt !== null) {
    assertWorkspaceJobTimestampV7(job.completedAt, "job.completedAt");
  }
  if (job.error !== null) {
    try {
      WorkspaceJobErrorSchema.parse(job.error);
    } catch (error) {
      workspaceJobContractInvariantV7(
        error instanceof Error ? error.message : "job.error is invalid.",
      );
    }
  }
  if (job.cancellation !== null) {
    assertWorkspaceJobCancellationV7(job.cancellation);
    assertWorkspaceJobTimestampV7(
      job.cancellation.requestedAt,
      "job.cancellation.requestedAt",
    );
  }
  if (status === "queued") {
    if (
      job.startedAt !== null ||
      job.completedAt !== null ||
      job.error !== null
    ) {
      workspaceJobContractInvariantV7(
        "Queued jobs must not carry startedAt, completedAt, or error.",
      );
    }
  }
  if (status === "running") {
    if (
      job.startedAt === null ||
      job.completedAt !== null ||
      job.error !== null
    ) {
      workspaceJobContractInvariantV7(
        "Running jobs require startedAt and must not carry completedAt or error.",
      );
    }
  }
  if (status === "complete") {
    if (job.startedAt === null || job.completedAt === null) {
      workspaceJobContractInvariantV7(
        "Complete jobs require startedAt and completedAt.",
      );
    }
    if (job.error !== null) {
      workspaceJobContractInvariantV7("Complete jobs must not carry an error.");
    }
  }
  if (status === "failed" || status === "interrupted") {
    if (
      job.startedAt === null ||
      job.completedAt === null ||
      job.error === null
    ) {
      workspaceJobContractInvariantV7(
        `${status} jobs require startedAt, completedAt, and an error.`,
      );
    }
  }
  if (status === "cancelled") {
    if (job.completedAt === null || job.cancellation === null) {
      workspaceJobContractInvariantV7(
        "Cancelled jobs require completedAt and cancellation details.",
      );
    }
  } else if (job.cancellation !== null) {
    workspaceJobContractInvariantV7(
      "Only cancelled jobs may carry cancellation details.",
    );
  }
}
