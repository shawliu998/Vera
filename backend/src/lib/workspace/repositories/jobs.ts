import { isDeepStrictEqual } from "node:util";

import type { WorkspaceDatabaseAdapter } from "../migrations";
import {
  WORKSPACE_JOB_SELECT_COLUMNS as JOB_SELECT_COLUMNS,
  WorkspaceJobPersistenceError,
  assertWorkspaceJobResourceTypeV7,
  parseWorkspaceJobRowV7,
  type WorkspaceJobResourceType,
  type WorkspaceJobRow,
  type WorkspaceJobStoredRecord,
} from "../jobPersistenceV7";
import {
  assertWorkspaceJobRecord,
  canRetryWorkspaceJob,
  createWorkspaceJob,
  projectWorkspaceJobForLogs,
  recoverRunningWorkspaceJobs,
  transitionWorkspaceJob,
} from "../jobs/stateMachine";
import { WORKSPACE_JOB_TYPES } from "../jobs/types";
import type {
  CreateWorkspaceJobInput,
  WorkspaceJobCancellation,
  WorkspaceJobEvent,
  WorkspaceJobLogProjection,
  WorkspaceJobRecord,
  WorkspaceJobStatus,
  WorkspaceJobType,
} from "../jobs/types";

export type {
  WorkspaceJobResourceType,
  WorkspaceJobStoredRecord,
} from "../jobPersistenceV7";

export interface CreateWorkspaceStoredJobInput {
  job: WorkspaceJobRecord;
  resourceType: WorkspaceJobResourceType;
  resourceId: string;
  priority?: number;
  scheduledAt?: string;
  queuedAt?: string;
}

export interface ListWorkspaceJobsInput {
  status?: WorkspaceJobStatus;
  type?: WorkspaceJobStoredRecord["type"];
  resourceType?: WorkspaceJobResourceType;
  resourceId?: string;
  limit?: number;
}

export class WorkspaceJobsRepositoryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkspaceJobsRepositoryError";
  }
}

export class DuplicateWorkspaceJobError extends WorkspaceJobsRepositoryError {
  constructor(message: string) {
    super(message);
    this.name = "DuplicateWorkspaceJobError";
  }
}

export class WorkspaceJobConflictError extends WorkspaceJobsRepositoryError {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceJobConflictError";
  }
}

export class WorkspaceJobLeaseLostError extends WorkspaceJobsRepositoryError {
  constructor(message = "Workspace job claim lease was lost.") {
    super(message);
    this.name = "WorkspaceJobLeaseLostError";
  }
}

export interface RenewWorkspaceJobClaimLeaseInput {
  id: string;
  leaseOwner: string;
  attempt: number;
  at: string;
  leaseExpiresAt: string;
}

export interface FinishWorkspaceJobClaimInput {
  id: string;
  leaseOwner: string;
  attempt: number;
  event: WorkspaceJobEvent;
}

export interface AssertWorkspaceJobClaimInput {
  id: string;
  type: WorkspaceJobType;
  resourceType: WorkspaceJobResourceType;
  resourceId: string;
  leaseOwner: string;
  attempt: number;
  at: string;
  /** When present, the persisted payload must match exactly. */
  payload?: unknown;
}

export interface FinishWorkspaceJobClaimInCurrentTransactionInput extends Omit<
  AssertWorkspaceJobClaimInput,
  "at"
> {
  event: WorkspaceJobEvent;
}

function invariant(message: string): never {
  throw new WorkspaceJobsRepositoryError(message);
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
  if (typeof value !== "string")
    invariant(`${name} must be stored as JSON text.`);
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new WorkspaceJobsRepositoryError(
      `${name} must contain valid JSON.`,
      error instanceof Error ? { cause: error } : undefined,
    );
  }
}

function stringifyJson(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return JSON.stringify(value);
}

function assertResourceType(value: unknown): WorkspaceJobResourceType {
  try {
    return assertWorkspaceJobResourceTypeV7(value);
  } catch (error) {
    if (error instanceof WorkspaceJobPersistenceError) {
      throw new WorkspaceJobsRepositoryError(error.message, { cause: error });
    }
    throw error;
  }
}

function retryableFromJob(job: WorkspaceJobRecord) {
  return job.error?.retryable === true;
}

function uniqueConstraintMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
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
  return {
    requestedAt: assertTimestamp(
      payload.requestedAt,
      "legacy cancellation.requestedAt",
    ),
    reason:
      payload.reason === null || payload.reason === undefined
        ? null
        : String(payload.reason),
  };
}

function defaultLeaseExpiresAt(now: string): string {
  return new Date(Date.parse(now) + 5 * 60 * 1000).toISOString();
}

function normalizeAllowedJobTypes(
  allowedTypes: readonly WorkspaceJobType[],
): WorkspaceJobType[] {
  if (!Array.isArray(allowedTypes) || allowedTypes.length === 0) {
    invariant("allowedTypes must contain at least one workspace job type.");
  }
  const normalized = [...new Set(allowedTypes)];
  for (const type of normalized) {
    if (!(WORKSPACE_JOB_TYPES as readonly string[]).includes(type)) {
      invariant(`Unsupported workspace job type ${String(type)}.`);
    }
  }
  return normalized;
}

function staleRunningRecoveryError(at: string) {
  return {
    code: "workspace_job_recovered",
    message: "Workspace job lease expired before completion.",
    retryable: true,
    details: { recoveredAt: at },
  } as const;
}

export class WorkspaceJobsRepository {
  constructor(private readonly database: WorkspaceDatabaseAdapter) {}

  private transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Preserve the original error.
      }
      throw error;
    }
  }

  private selectRowById(id: string): WorkspaceJobRow | undefined {
    return this.database
      .prepare(`SELECT ${JOB_SELECT_COLUMNS} FROM jobs WHERE id = ?`)
      .get(id);
  }

  private selectRowByIdempotencyKey(
    idempotencyKey: string,
  ): WorkspaceJobRow | undefined {
    return this.database
      .prepare(
        `SELECT ${JOB_SELECT_COLUMNS} FROM jobs WHERE idempotency_key = ?`,
      )
      .get(idempotencyKey);
  }

  private rowToRecord(row: WorkspaceJobRow): WorkspaceJobStoredRecord {
    try {
      return parseWorkspaceJobRowV7(row);
    } catch (error) {
      if (error instanceof WorkspaceJobPersistenceError) {
        throw new WorkspaceJobsRepositoryError(error.message, {
          cause: error,
        });
      }
      throw error;
    }
  }

  private updateStoredJob(
    current: WorkspaceJobStoredRecord,
    next: WorkspaceJobRecord,
    options: {
      queuedAt?: string;
      leaseOwner?: string | null;
      leaseExpiresAt?: string | null;
      cancelRequestedAt?: string | null;
      cancellationReason?: string | null;
    } = {},
  ): WorkspaceJobStoredRecord {
    assertWorkspaceJobRecord(next);
    const queuedAt = assertTimestamp(
      options.queuedAt ?? current.queuedAt,
      "queuedAt",
    );
    const leaseOwner =
      options.leaseOwner === undefined
        ? current.leaseOwner
        : options.leaseOwner;
    const leaseExpiresAt =
      options.leaseExpiresAt === undefined
        ? current.leaseExpiresAt
        : options.leaseExpiresAt;
    const cancelRequestedAt =
      options.cancelRequestedAt === undefined
        ? current.cancelRequestedAt
        : options.cancelRequestedAt;
    const cancellationReason =
      options.cancellationReason === undefined
        ? current.cancellationReason
        : options.cancellationReason;
    if ((leaseOwner === null) !== (leaseExpiresAt === null)) {
      invariant("leaseOwner and leaseExpiresAt must be paired.");
    }
    const retryable = retryableFromJob(next);
    this.database
      .prepare(
        `UPDATE jobs
            SET status = ?,
                attempt = ?,
                max_attempts = ?,
                retryable = ?,
                payload_json = ?,
                result_json = ?,
                error_json = ?,
                error_code = ?,
                scheduled_at = ?,
                queued_at = ?,
                locked_at = ?,
                lease_owner = ?,
                lease_expires_at = ?,
                started_at = ?,
                completed_at = ?,
                cancel_requested_at = ?,
                cancellation_reason = ?,
                updated_at = ?
          WHERE id = ?`,
      )
      .run(
        next.status,
        next.attempt,
        next.maxAttempts,
        retryable ? 1 : 0,
        stringifyJson(next.payload) ?? "{}",
        stringifyJson(next.result),
        stringifyJson(next.error),
        next.error?.code ?? null,
        queuedAt,
        queuedAt,
        leaseExpiresAt,
        leaseOwner,
        leaseExpiresAt,
        next.startedAt,
        next.completedAt,
        cancelRequestedAt,
        cancellationReason,
        next.updatedAt,
        next.id,
      );
    const row = this.selectRowById(next.id);
    if (!row) invariant(`Workspace job ${next.id} disappeared after update.`);
    return this.rowToRecord(row);
  }

  createJob(input: CreateWorkspaceStoredJobInput): WorkspaceJobStoredRecord {
    return this.transaction(() => this.insertPreparedJob(input));
  }

  insertPreparedJob(
    input: CreateWorkspaceStoredJobInput,
  ): WorkspaceJobStoredRecord {
    assertWorkspaceJobRecord(input.job);
    const resourceType = assertResourceType(input.resourceType);
    const resourceId = assertNonEmptyString(input.resourceId, "resourceId");
    const priority = input.priority ?? 0;
    if (!Number.isSafeInteger(priority)) {
      invariant("priority must be a safe integer.");
    }
    const queuedAt = assertTimestamp(
      input.queuedAt ?? input.scheduledAt ?? input.job.queuedAt,
      "queuedAt",
    );
    const cancelRequestedAt =
      input.job.status === "cancelled"
        ? (input.job.cancellation?.requestedAt ?? input.job.completedAt)
        : null;
    const cancellationReason =
      input.job.status === "cancelled"
        ? (input.job.cancellation?.reason ?? null)
        : null;
    try {
      this.database
        .prepare(
          `INSERT INTO jobs (
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
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.job.id,
          input.job.type,
          input.job.status,
          resourceType,
          resourceId,
          input.job.idempotencyKey,
          priority,
          input.job.attempt,
          input.job.maxAttempts,
          retryableFromJob(input.job) ? 1 : 0,
          stringifyJson(input.job.payload) ?? "{}",
          stringifyJson(input.job.result),
          stringifyJson(input.job.error),
          input.job.error?.code ?? null,
          queuedAt,
          queuedAt,
          null,
          null,
          null,
          input.job.startedAt,
          input.job.completedAt,
          cancelRequestedAt,
          cancellationReason,
          input.job.createdAt,
          input.job.updatedAt,
        );
    } catch (error) {
      const message = uniqueConstraintMessage(error);
      if (/UNIQUE constraint failed: jobs\.id\b/i.test(message)) {
        throw new DuplicateWorkspaceJobError(
          `Workspace job ${input.job.id} already exists.`,
        );
      }
      if (/UNIQUE constraint failed: jobs\.idempotency_key\b/i.test(message)) {
        throw new DuplicateWorkspaceJobError(
          `Workspace job idempotency key ${input.job.idempotencyKey} already exists.`,
        );
      }
      throw error;
    }
    const row = this.selectRowById(input.job.id);
    if (!row) invariant(`Workspace job ${input.job.id} was not persisted.`);
    return this.rowToRecord(row);
  }

  getJob(id: string): WorkspaceJobStoredRecord | null {
    const row = this.selectRowById(assertNonEmptyString(id, "id"));
    return row ? this.rowToRecord(row) : null;
  }

  getJobByIdempotencyKey(
    idempotencyKey: string,
  ): WorkspaceJobStoredRecord | null {
    const row = this.selectRowByIdempotencyKey(
      assertNonEmptyString(idempotencyKey, "idempotencyKey"),
    );
    return row ? this.rowToRecord(row) : null;
  }

  listJobs(input: ListWorkspaceJobsInput = {}): WorkspaceJobStoredRecord[] {
    const clauses: string[] = [];
    const parameters: unknown[] = [];
    if (input.status) {
      clauses.push("status = ?");
      parameters.push(input.status);
    }
    if (input.type) {
      clauses.push("type = ?");
      parameters.push(input.type);
    }
    if (input.resourceType) {
      clauses.push("resource_type = ?");
      parameters.push(input.resourceType);
    }
    if (input.resourceId) {
      clauses.push("resource_id = ?");
      parameters.push(assertNonEmptyString(input.resourceId, "resourceId"));
    }
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1_000) {
      invariant("limit must be between 1 and 1000.");
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.database
      .prepare(
        `SELECT ${JOB_SELECT_COLUMNS}
           FROM jobs
           ${where}
       ORDER BY created_at ASC, id ASC
          LIMIT ?`,
      )
      .all(...parameters, limit);
    return rows.map((row) => this.rowToRecord(row));
  }

  private assertClaimLeaseHeld(
    current: WorkspaceJobStoredRecord,
    leaseOwner: string,
    attempt: number,
    at: string,
  ): void {
    if (
      current.status !== "running" ||
      current.leaseOwner !== leaseOwner ||
      current.attempt !== attempt ||
      current.leaseExpiresAt === null ||
      Date.parse(current.leaseExpiresAt) <= Date.parse(at)
    ) {
      throw new WorkspaceJobLeaseLostError();
    }
  }

  private rejectPendingAssistantDocumentEditsInCurrentTransaction(
    current: WorkspaceJobStoredRecord,
    next: WorkspaceJobRecord,
    resolvedAt: string,
  ) {
    if (
      current.type !== "assistant_generate" ||
      next.status === "running" ||
      next.status === "complete"
    ) {
      return;
    }
    this.database
      .prepare(
        `UPDATE document_edits
            SET status='rejected',resolved_at=?
          WHERE status='pending' AND resolved_at IS NULL
            AND message_id IN (
              SELECT id FROM chat_messages WHERE job_id=?
            )`,
      )
      .run(resolvedAt, current.id);
  }

  private assertClaimInCurrentTransactionWithPolicy(
    input: AssertWorkspaceJobClaimInput,
    allowCancellationRequested: boolean,
  ): WorkspaceJobStoredRecord {
    const id = assertNonEmptyString(input.id, "id");
    const leaseOwner = assertNonEmptyString(input.leaseOwner, "leaseOwner");
    const attempt = parseInteger(input.attempt, "attempt");
    const at = assertTimestamp(input.at, "at");
    const resourceId = assertNonEmptyString(input.resourceId, "resourceId");
    const row = this.selectRowById(id);
    if (!row) throw new WorkspaceJobLeaseLostError();
    const current = this.rowToRecord(row);
    this.assertClaimLeaseHeld(current, leaseOwner, attempt, at);
    const expectsPayload = Object.prototype.hasOwnProperty.call(
      input,
      "payload",
    );
    if (
      current.type !== input.type ||
      current.resourceType !== input.resourceType ||
      current.resourceId !== resourceId ||
      (!allowCancellationRequested && current.cancelRequestedAt !== null) ||
      (expectsPayload && !isDeepStrictEqual(current.payload, input.payload))
    ) {
      throw new WorkspaceJobLeaseLostError();
    }
    return current;
  }

  assertClaimInCurrentTransaction(
    input: AssertWorkspaceJobClaimInput,
  ): WorkspaceJobStoredRecord {
    return this.assertClaimInCurrentTransactionWithPolicy(input, false);
  }

  private finalizeRecoveredRunningJob(
    current: WorkspaceJobStoredRecord,
    at: string,
  ): WorkspaceJobStoredRecord {
    if (current.cancelRequestedAt) {
      const cancelled = transitionWorkspaceJob(current, {
        type: "cancel",
        at,
        reason:
          current.cancellationReason ??
          current.cancellation?.reason ??
          "Workspace job cancellation requested.",
      });
      this.rejectPendingAssistantDocumentEditsInCurrentTransaction(
        current,
        cancelled,
        at,
      );
      return this.updateStoredJob(current, cancelled, {
        queuedAt: current.queuedAt,
        leaseOwner: null,
        leaseExpiresAt: null,
        cancelRequestedAt:
          current.cancelRequestedAt ??
          cancelled.cancellation?.requestedAt ??
          at,
        cancellationReason:
          cancelled.cancellation?.reason ?? current.cancellationReason ?? null,
      });
    }
    const interrupted = transitionWorkspaceJob(current, {
      type: "interrupt",
      at,
      error: staleRunningRecoveryError(at),
    });
    if (current.attempt < current.maxAttempts) {
      const retried = transitionWorkspaceJob(interrupted, {
        type: "retry",
        at,
      });
      this.rejectPendingAssistantDocumentEditsInCurrentTransaction(
        current,
        retried,
        at,
      );
      return this.updateStoredJob(current, retried, {
        queuedAt: retried.queuedAt,
        leaseOwner: null,
        leaseExpiresAt: null,
        cancelRequestedAt: null,
        cancellationReason: null,
      });
    }
    this.rejectPendingAssistantDocumentEditsInCurrentTransaction(
      current,
      interrupted,
      at,
    );
    return this.updateStoredJob(current, interrupted, {
      queuedAt: current.queuedAt,
      leaseOwner: null,
      leaseExpiresAt: null,
      cancelRequestedAt: current.cancelRequestedAt,
      cancellationReason: current.cancellationReason,
    });
  }

  claimNextQueued(
    now: string,
    leaseOwner = "workspace-job-runtime",
    leaseExpiresAt = defaultLeaseExpiresAt(now),
  ): WorkspaceJobStoredRecord | null {
    return this.claimNextQueuedMatching(now, leaseOwner, leaseExpiresAt, null);
  }

  claimNextQueuedForTypes(
    now: string,
    allowedTypes: readonly WorkspaceJobType[],
    leaseOwner = "workspace-job-runtime",
    leaseExpiresAt = defaultLeaseExpiresAt(now),
  ): WorkspaceJobStoredRecord | null {
    return this.claimNextQueuedMatching(
      now,
      leaseOwner,
      leaseExpiresAt,
      normalizeAllowedJobTypes(allowedTypes),
    );
  }

  private claimNextQueuedMatching(
    now: string,
    leaseOwner: string,
    leaseExpiresAt: string,
    allowedTypes: readonly WorkspaceJobType[] | null,
  ): WorkspaceJobStoredRecord | null {
    const timestamp = assertTimestamp(now, "now");
    const owner = assertNonEmptyString(leaseOwner, "leaseOwner");
    const expiresAt = assertTimestamp(leaseExpiresAt, "leaseExpiresAt");
    const typePredicate =
      allowedTypes === null
        ? ""
        : `AND type IN (${allowedTypes.map(() => "?").join(", ")})`;
    const selectParameters =
      allowedTypes === null ? [timestamp] : [timestamp, ...allowedTypes];
    return this.transaction(() => {
      while (true) {
        const row = this.database
          .prepare(
            `SELECT ${JOB_SELECT_COLUMNS}
               FROM jobs
              WHERE status = 'queued'
                AND cancel_requested_at IS NULL
                AND attempt < max_attempts
                AND queued_at <= ?
                ${typePredicate}
           ORDER BY priority DESC, queued_at ASC, created_at ASC, id ASC
              LIMIT 1`,
          )
          .get(...selectParameters);
        if (!row) return null;
        const current = this.rowToRecord(row);
        const next = transitionWorkspaceJob(current, {
          type: "start",
          at: timestamp,
        });
        const result = this.database
          .prepare(
            `UPDATE jobs
                SET status = ?,
                    attempt = ?,
                    retryable = ?,
                    payload_json = ?,
                    result_json = NULL,
                    error_json = NULL,
                    error_code = NULL,
                    scheduled_at = ?,
                    queued_at = ?,
                    locked_at = ?,
                    lease_owner = ?,
                    lease_expires_at = ?,
                    started_at = ?,
                    completed_at = NULL,
                    cancel_requested_at = NULL,
                    cancellation_reason = NULL,
                    updated_at = ?
              WHERE id = ?
                AND status = 'queued'
                AND cancel_requested_at IS NULL
                AND attempt = ?
                AND updated_at = ?`,
          )
          .run(
            next.status,
            next.attempt,
            0,
            stringifyJson(next.payload) ?? "{}",
            current.queuedAt,
            current.queuedAt,
            expiresAt,
            owner,
            expiresAt,
            next.startedAt,
            next.updatedAt,
            current.id,
            current.attempt,
            current.updatedAt,
          ) as { changes?: unknown };
        if (Number(result?.changes ?? 0) !== 1) continue;
        const claimed = this.selectRowById(current.id);
        if (!claimed)
          invariant(`Claimed workspace job ${current.id} vanished.`);
        return this.rowToRecord(claimed);
      }
    });
  }

  transitionJobInCurrentTransaction(
    id: string,
    event: WorkspaceJobEvent,
  ): WorkspaceJobStoredRecord {
    const row = this.selectRowById(assertNonEmptyString(id, "id"));
    if (!row) invariant(`Workspace job ${id} was not found.`);
    const current = this.rowToRecord(row);
    const next = transitionWorkspaceJob(current, event);
    this.rejectPendingAssistantDocumentEditsInCurrentTransaction(
      current,
      next,
      event.at,
    );
    const cancelRequestedAt =
      event.type === "cancel"
        ? (current.cancelRequestedAt ??
          next.cancellation?.requestedAt ??
          event.at)
        : event.type === "retry"
          ? null
          : current.cancelRequestedAt;
    const cancellationReason =
      event.type === "cancel"
        ? (next.cancellation?.reason ?? current.cancellationReason)
        : event.type === "retry" || next.status !== "running"
          ? null
          : current.cancellationReason;
    const queuedAt = event.type === "retry" ? next.queuedAt : current.queuedAt;
    const leaseOwner = next.status === "running" ? current.leaseOwner : null;
    const leaseExpiresAt =
      next.status === "running" ? current.leaseExpiresAt : null;
    return this.updateStoredJob(current, next, {
      queuedAt,
      leaseOwner,
      leaseExpiresAt,
      cancelRequestedAt,
      cancellationReason,
    });
  }

  persistTransition(
    id: string,
    event: WorkspaceJobEvent,
  ): WorkspaceJobStoredRecord {
    return this.transaction(() =>
      this.transitionJobInCurrentTransaction(id, event),
    );
  }

  requestCancellation(
    id: string,
    at: string,
    reason?: string | null,
  ): WorkspaceJobStoredRecord {
    const timestamp = assertTimestamp(at, "at");
    return this.transaction(() => {
      const row = this.selectRowById(assertNonEmptyString(id, "id"));
      if (!row) invariant(`Workspace job ${id} was not found.`);
      const current = this.rowToRecord(row);
      if (current.status === "complete" || current.status === "cancelled") {
        invariant("Completed or cancelled jobs cannot be cancelled again.");
      }
      const cancellation = transitionWorkspaceJob(current, {
        type: "cancel",
        at: timestamp,
        reason,
      }).cancellation;
      if (current.status === "running") {
        if (current.cancelRequestedAt) return current;
        this.database
          .prepare(
            `UPDATE jobs
                SET cancel_requested_at = ?,
                    cancellation_reason = ?,
                    updated_at = ?
              WHERE id = ?
                AND status = 'running'
                AND cancel_requested_at IS NULL`,
          )
          .run(
            cancellation?.requestedAt ?? timestamp,
            cancellation?.reason ?? null,
            timestamp,
            current.id,
          );
        const updated = this.selectRowById(current.id);
        if (!updated) invariant(`Workspace job ${current.id} disappeared.`);
        return this.rowToRecord(updated);
      }
      return this.transitionJobInCurrentTransaction(current.id, {
        type: "cancel",
        at: timestamp,
        reason,
      });
    });
  }

  retryJob(id: string, at: string): WorkspaceJobStoredRecord {
    const timestamp = assertTimestamp(at, "at");
    return this.transaction(() => {
      const row = this.selectRowById(assertNonEmptyString(id, "id"));
      if (!row) invariant(`Workspace job ${id} was not found.`);
      const current = this.rowToRecord(row);
      if (!canRetryWorkspaceJob(current)) {
        invariant("Workspace job is not eligible for retry.");
      }
      return this.transitionJobInCurrentTransaction(current.id, {
        type: "retry",
        at: timestamp,
      });
    });
  }

  recoverRunningJobs(at: string): WorkspaceJobStoredRecord[] {
    const timestamp = assertTimestamp(at, "at");
    return this.transaction(() => {
      const rows = this.database
        .prepare(
          `SELECT ${JOB_SELECT_COLUMNS}
             FROM jobs
            WHERE status = 'running'`,
        )
        .all();
      const current = rows.map((row) => this.rowToRecord(row));
      const recovered = recoverRunningWorkspaceJobs(current, timestamp);
      return recovered.map((next) => {
        const previous = current.find((job) => job.id === next.id);
        if (!previous)
          invariant(`Recovered job ${next.id} missing original state.`);
        this.rejectPendingAssistantDocumentEditsInCurrentTransaction(
          previous,
          next,
          timestamp,
        );
        return this.updateStoredJob(previous, next, {
          queuedAt: previous.queuedAt,
          leaseOwner: null,
          leaseExpiresAt: null,
          cancelRequestedAt: null,
          cancellationReason: null,
        });
      });
    });
  }

  recoverStaleRunningJobs(at: string): WorkspaceJobStoredRecord[] {
    const timestamp = assertTimestamp(at, "at");
    return this.transaction(() => {
      const rows = this.database
        .prepare(
          `SELECT ${JOB_SELECT_COLUMNS}
             FROM jobs
            WHERE status = 'running'
              AND (
                lease_owner IS NULL OR
                lease_expires_at IS NULL OR
                lease_expires_at <= ?
              )`,
        )
        .all(timestamp);
      return rows.map((row) =>
        this.finalizeRecoveredRunningJob(this.rowToRecord(row), timestamp),
      );
    });
  }

  renewClaimLease(
    input: RenewWorkspaceJobClaimLeaseInput,
  ): WorkspaceJobStoredRecord {
    const id = assertNonEmptyString(input.id, "id");
    const leaseOwner = assertNonEmptyString(input.leaseOwner, "leaseOwner");
    const at = assertTimestamp(input.at, "at");
    const leaseExpiresAt = assertTimestamp(
      input.leaseExpiresAt,
      "leaseExpiresAt",
    );
    const attempt = parseInteger(input.attempt, "attempt");
    return this.transaction(() => {
      const row = this.selectRowById(id);
      if (!row) throw new WorkspaceJobLeaseLostError();
      const current = this.rowToRecord(row);
      this.assertClaimLeaseHeld(current, leaseOwner, attempt, at);
      const result = this.database
        .prepare(
          `UPDATE jobs
              SET locked_at = ?,
                  lease_expires_at = ?,
                  updated_at = ?
            WHERE id = ?
              AND status = 'running'
              AND lease_owner = ?
              AND attempt = ?
              AND lease_expires_at IS NOT NULL
              AND lease_expires_at > ?`,
        )
        .run(
          leaseExpiresAt,
          leaseExpiresAt,
          at,
          id,
          leaseOwner,
          attempt,
          at,
        ) as { changes?: unknown };
      if (Number(result?.changes ?? 0) !== 1) {
        throw new WorkspaceJobLeaseLostError();
      }
      const updated = this.selectRowById(id);
      if (!updated) throw new WorkspaceJobLeaseLostError();
      return this.rowToRecord(updated);
    });
  }

  private finishValidatedClaimInCurrentTransaction(
    current: WorkspaceJobStoredRecord,
    input: FinishWorkspaceJobClaimInCurrentTransactionInput,
    at: string,
    allowCancellationRequested: boolean,
  ): WorkspaceJobStoredRecord {
    const next = transitionWorkspaceJob(current, input.event);
    this.rejectPendingAssistantDocumentEditsInCurrentTransaction(
      current,
      next,
      at,
    );
    const cancelRequestedAt =
      input.event.type === "cancel"
        ? (current.cancelRequestedAt ?? next.cancellation?.requestedAt ?? at)
        : current.cancelRequestedAt;
    const cancellationReason =
      input.event.type === "cancel"
        ? (next.cancellation?.reason ?? current.cancellationReason ?? null)
        : null;
    const queuedAt =
      next.status === "queued" ? next.queuedAt : current.queuedAt;
    const result = this.database
      .prepare(
        `UPDATE jobs
            SET status = ?,
                attempt = ?,
                max_attempts = ?,
                retryable = ?,
                payload_json = ?,
                result_json = ?,
                error_json = ?,
                error_code = ?,
                scheduled_at = ?,
                queued_at = ?,
                locked_at = ?,
                lease_owner = ?,
                lease_expires_at = ?,
                started_at = ?,
                completed_at = ?,
                cancel_requested_at = ?,
                cancellation_reason = ?,
                updated_at = ?
          WHERE id = ?
            AND type = ?
            AND resource_type = ?
            AND resource_id = ?
            AND status = 'running'
            AND lease_owner = ?
            AND attempt = ?
            AND lease_expires_at IS NOT NULL
            AND lease_expires_at > ?
            AND (? = 1 OR cancel_requested_at IS NULL)`,
      )
      .run(
        next.status,
        next.attempt,
        next.maxAttempts,
        retryableFromJob(next) ? 1 : 0,
        stringifyJson(next.payload) ?? "{}",
        stringifyJson(next.result),
        stringifyJson(next.error),
        next.error?.code ?? null,
        queuedAt,
        queuedAt,
        null,
        null,
        null,
        next.startedAt,
        next.completedAt,
        cancelRequestedAt,
        cancellationReason,
        next.updatedAt,
        current.id,
        current.type,
        current.resourceType,
        current.resourceId,
        input.leaseOwner,
        input.attempt,
        at,
        allowCancellationRequested ? 1 : 0,
      ) as { changes?: unknown };
    if (Number(result?.changes ?? 0) !== 1) {
      throw new WorkspaceJobLeaseLostError();
    }
    const updated = this.selectRowById(current.id);
    if (!updated) throw new WorkspaceJobLeaseLostError();
    return this.rowToRecord(updated);
  }

  private finishClaimInCurrentTransactionWithPolicy(
    input: FinishWorkspaceJobClaimInCurrentTransactionInput,
    allowCancellationRequested: boolean,
  ): WorkspaceJobStoredRecord {
    const at = assertTimestamp(input.event.at, `${input.event.type}.at`);
    const claimInput: AssertWorkspaceJobClaimInput = {
      id: input.id,
      type: input.type,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      leaseOwner: input.leaseOwner,
      attempt: input.attempt,
      at,
    };
    if (Object.prototype.hasOwnProperty.call(input, "payload")) {
      claimInput.payload = input.payload;
    }
    const current = this.assertClaimInCurrentTransactionWithPolicy(
      claimInput,
      allowCancellationRequested,
    );
    return this.finishValidatedClaimInCurrentTransaction(
      current,
      input,
      at,
      allowCancellationRequested,
    );
  }

  finishClaimInCurrentTransaction(
    input: FinishWorkspaceJobClaimInCurrentTransactionInput,
  ): WorkspaceJobStoredRecord {
    return this.finishClaimInCurrentTransactionWithPolicy(input, false);
  }

  private finishLegacyClaimInCurrentTransaction(
    input: FinishWorkspaceJobClaimInput,
  ): WorkspaceJobStoredRecord {
    const id = assertNonEmptyString(input.id, "id");
    const row = this.selectRowById(id);
    if (!row) throw new WorkspaceJobLeaseLostError();
    const current = this.rowToRecord(row);
    return this.finishClaimInCurrentTransactionWithPolicy(
      {
        id,
        type: current.type,
        resourceType: current.resourceType,
        resourceId: current.resourceId,
        leaseOwner: input.leaseOwner,
        attempt: input.attempt,
        event: input.event,
      },
      input.event.type === "cancel",
    );
  }

  finishClaim(input: FinishWorkspaceJobClaimInput): WorkspaceJobStoredRecord {
    return this.transaction(() =>
      this.finishLegacyClaimInCurrentTransaction(input),
    );
  }

  renewLease(
    id: string,
    leaseOwner: string,
    leaseExpiresAt: string,
    at = leaseExpiresAt,
  ): WorkspaceJobStoredRecord {
    const owner = assertNonEmptyString(leaseOwner, "leaseOwner");
    const expiresAt = assertTimestamp(leaseExpiresAt, "leaseExpiresAt");
    const updatedAt = assertTimestamp(at, "at");
    return this.transaction(() => {
      const row = this.selectRowById(assertNonEmptyString(id, "id"));
      if (!row) invariant(`Workspace job ${id} was not found.`);
      const current = this.rowToRecord(row);
      if (current.status !== "running") {
        invariant("Only running jobs may renew a lease.");
      }
      if (current.leaseOwner !== owner) {
        invariant("Workspace job lease owner does not match.");
      }
      this.database
        .prepare(
          `UPDATE jobs
              SET locked_at = ?,
                  lease_owner = ?,
                  lease_expires_at = ?,
                  updated_at = ?
            WHERE id = ?
              AND status = 'running'
              AND lease_owner = ?`,
        )
        .run(expiresAt, owner, expiresAt, updatedAt, current.id, owner);
      const updated = this.selectRowById(current.id);
      if (!updated) invariant(`Workspace job ${current.id} disappeared.`);
      return this.rowToRecord(updated);
    });
  }

  releaseLease(
    id: string,
    leaseOwner: string,
    at: string,
  ): WorkspaceJobStoredRecord {
    const owner = assertNonEmptyString(leaseOwner, "leaseOwner");
    const updatedAt = assertTimestamp(at, "at");
    return this.transaction(() => {
      const row = this.selectRowById(assertNonEmptyString(id, "id"));
      if (!row) invariant(`Workspace job ${id} was not found.`);
      const current = this.rowToRecord(row);
      if (current.status !== "running") {
        invariant("Only running jobs may release a lease.");
      }
      if (current.leaseOwner !== owner) {
        invariant("Workspace job lease owner does not match.");
      }
      this.database
        .prepare(
          `UPDATE jobs
              SET locked_at = NULL,
                  lease_owner = NULL,
                  lease_expires_at = NULL,
                  updated_at = ?
            WHERE id = ?
              AND status = 'running'
              AND lease_owner = ?`,
        )
        .run(updatedAt, current.id, owner);
      const updated = this.selectRowById(current.id);
      if (!updated) invariant(`Workspace job ${current.id} disappeared.`);
      return this.rowToRecord(updated);
    });
  }

  logProjection(id: string): WorkspaceJobLogProjection | null {
    const job = this.getJob(id);
    return job ? projectWorkspaceJobForLogs(job) : null;
  }

  fromRow(row: WorkspaceJobRow) {
    return this.rowToRecord(row);
  }

  toRecord(input: CreateWorkspaceJobInput) {
    return createWorkspaceJob(input);
  }
}
