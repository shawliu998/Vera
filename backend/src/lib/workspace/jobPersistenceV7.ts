import {
  assertWorkspaceJobCancellationV7,
  assertWorkspaceJobRecordV7,
  assertWorkspaceJobResourceTypeV7,
  type WorkspaceJobCancellation,
  type WorkspaceJobRecord,
  type WorkspaceJobResourceType,
  type WorkspaceJobStatus,
} from "./jobContractV7";

export type { WorkspaceJobResourceType } from "./jobContractV7";
export { assertWorkspaceJobResourceTypeV7 } from "./jobContractV7";

export interface WorkspaceJobStoredRecord extends WorkspaceJobRecord {
  resourceType: WorkspaceJobResourceType;
  resourceId: string;
  priority: number;
  scheduledAt: string;
  lockedAt: string | null;
  cancelRequestedAt: string | null;
  cancellationReason: string | null;
  retryable: boolean;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
}

export type WorkspaceJobRow = Record<string, unknown>;

export const WORKSPACE_JOB_SELECT_COLUMNS = `
  id,
  type,
  status,
  resource_type,
  resource_id,
  idempotency_key,
  priority,
  attempt,
  max_attempts,
  retryable,
  payload_json,
  result_json,
  error_json,
  error_code,
  scheduled_at,
  queued_at,
  locked_at,
  lease_owner,
  lease_expires_at,
  started_at,
  completed_at,
  cancel_requested_at,
  cancellation_reason,
  created_at,
  updated_at
`;

export class WorkspaceJobPersistenceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkspaceJobPersistenceError";
  }
}

function invariant(message: string): never {
  throw new WorkspaceJobPersistenceError(message);
}

function assertNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    invariant(`${name} must be a non-empty string.`);
  }
  return value.trim();
}

function parseOptionalString(value: unknown, name: string): string | null {
  if (value === null || value === undefined) return null;
  return assertNonEmptyString(value, name);
}

function assertTimestamp(value: unknown, name: string): string {
  const text = assertNonEmptyString(value, name);
  if (Number.isNaN(Date.parse(text))) {
    invariant(`${name} must be a valid timestamp.`);
  }
  return text;
}

function parseOptionalTimestamp(value: unknown, name: string): string | null {
  if (value === null || value === undefined) return null;
  return assertTimestamp(value, name);
}

function assertInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    invariant(`${name} must be a safe integer.`);
  }
  return value;
}

function parseInteger(value: unknown, name: string): number {
  const parsed =
    typeof value === "number" ? value : Number.parseInt(String(value), 10);
  return assertInteger(parsed, name);
}

function parseBooleanFlag(value: unknown, name: string): boolean {
  const parsed = parseInteger(value, name);
  if (parsed !== 0 && parsed !== 1) {
    invariant(`${name} must be 0 or 1.`);
  }
  return parsed === 1;
}

function parseJsonText(value: unknown, name: string): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    invariant(`${name} must be stored as JSON text.`);
  }
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new WorkspaceJobPersistenceError(
      `${name} must contain valid JSON.`,
      error instanceof Error ? { cause: error } : undefined,
    );
  }
}

function parseLegacyCancellationEnvelope(
  value: unknown,
): WorkspaceJobCancellation | null {
  if (
    value === null ||
    typeof value !== "object" ||
    !("schema" in value) ||
    !("cancellation" in value)
  ) {
    return null;
  }
  const record = value as {
    schema?: unknown;
    cancellation?: unknown;
  };
  if (record.schema !== "vera-workspace-job-cancellation-v1") return null;
  if (record.cancellation === null || typeof record.cancellation !== "object") {
    return null;
  }
  const payload = record.cancellation as Record<string, unknown>;
  const candidate: WorkspaceJobCancellation = {
    requestedAt: assertTimestamp(
      payload.requestedAt,
      "legacy cancellation.requestedAt",
    ),
    reason:
      payload.reason === null || payload.reason === undefined
        ? null
        : assertNonEmptyString(payload.reason, "legacy cancellation.reason"),
  };
  try {
    return assertWorkspaceJobCancellationV7(candidate);
  } catch (error) {
    throw new WorkspaceJobPersistenceError(
      "Persisted workspace job legacy cancellation violates the frozen v7 job contract.",
      error instanceof Error ? { cause: error } : undefined,
    );
  }
}

export function parseWorkspaceJobRowV7(
  row: WorkspaceJobRow,
): WorkspaceJobStoredRecord {
  const status = assertNonEmptyString(
    row.status,
    "row.status",
  ) as WorkspaceJobStatus;
  const payload = parseJsonText(row.payload_json, "row.payload_json");
  const parsedResult = parseJsonText(row.result_json, "row.result_json");
  const parsedError = parseJsonText(row.error_json, "row.error_json");
  const completedAt = parseOptionalTimestamp(
    row.completed_at,
    "row.completed_at",
  );
  const cancelRequestedAt = parseOptionalTimestamp(
    row.cancel_requested_at,
    "row.cancel_requested_at",
  );
  const cancellationReason = parseOptionalString(
    row.cancellation_reason,
    "row.cancellation_reason",
  );
  const legacyCancellation = parseLegacyCancellationEnvelope(parsedResult);
  const cancellation =
    status === "cancelled"
      ? {
          requestedAt:
            cancelRequestedAt ??
            legacyCancellation?.requestedAt ??
            completedAt ??
            assertTimestamp(row.updated_at, "row.updated_at"),
          reason: cancellationReason ?? legacyCancellation?.reason ?? null,
        }
      : null;
  const queuedAt = assertTimestamp(
    row.queued_at ?? row.scheduled_at,
    "row.queued_at",
  );
  const leaseOwner = parseOptionalString(row.lease_owner, "row.lease_owner");
  const leaseExpiresAt = parseOptionalTimestamp(
    row.lease_expires_at,
    "row.lease_expires_at",
  );
  if ((leaseOwner === null) !== (leaseExpiresAt === null)) {
    invariant("row lease owner and expiry must be paired.");
  }
  const record: WorkspaceJobStoredRecord = {
    id: assertNonEmptyString(row.id, "row.id"),
    type: assertNonEmptyString(
      row.type,
      "row.type",
    ) as WorkspaceJobStoredRecord["type"],
    status,
    payload,
    result: status === "complete" ? parsedResult : null,
    error: parsedError as WorkspaceJobRecord["error"],
    attempt: parseInteger(row.attempt, "row.attempt"),
    maxAttempts: parseInteger(row.max_attempts, "row.max_attempts"),
    idempotencyKey: parseOptionalString(
      row.idempotency_key,
      "row.idempotency_key",
    ),
    createdAt: assertTimestamp(row.created_at, "row.created_at"),
    queuedAt,
    startedAt: parseOptionalTimestamp(row.started_at, "row.started_at"),
    completedAt,
    cancellation,
    updatedAt: assertTimestamp(row.updated_at, "row.updated_at"),
    resourceType: assertWorkspaceJobResourceTypeV7(row.resource_type),
    resourceId: assertNonEmptyString(row.resource_id, "row.resource_id"),
    priority: parseInteger(row.priority, "row.priority"),
    scheduledAt: queuedAt,
    lockedAt: leaseExpiresAt,
    cancelRequestedAt,
    cancellationReason,
    retryable: parseBooleanFlag(row.retryable, "row.retryable"),
    leaseOwner,
    leaseExpiresAt,
  };
  if (
    record.error === null &&
    row.error_code !== null &&
    row.error_code !== undefined
  ) {
    invariant("row.error_code requires error_json.");
  }
  if (record.error !== null && record.error.code !== (row.error_code ?? null)) {
    invariant("row.error_code must match error_json.code.");
  }
  try {
    assertWorkspaceJobRecordV7(record);
  } catch (error) {
    throw new WorkspaceJobPersistenceError(
      "Persisted workspace job row violates the frozen v7 job contract.",
      error instanceof Error ? { cause: error } : undefined,
    );
  }
  if (
    (record.status === "failed" || record.status === "interrupted") &&
    record.error !== null &&
    record.retryable !== record.error.retryable
  ) {
    invariant("row.retryable must match error_json.retryable.");
  }
  return record;
}
