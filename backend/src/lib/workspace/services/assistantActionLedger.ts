import { createHash } from "node:crypto";

import type { WorkspaceDatabaseAdapter } from "../migrations";

export const ASSISTANT_ACTION_BUDGETS = {
  create_draft: 1,
  suggest_draft_edit: 5,
  run_workflow: 2,
  run_contract_review: 1,
} as const;

export type AssistantActionType = keyof typeof ASSISTANT_ACTION_BUDGETS;
export type AssistantActionResourceType =
  | "draft"
  | "draft_suggestion"
  | "workflow_run"
  | "tabular_review";
export type AssistantActionLedgerStatus = "reserved" | "complete";

export type AssistantActionLedgerRecord = Readonly<{
  jobId: string;
  actionKey: string;
  actionType: AssistantActionType;
  projectId: string;
  inputSha256: string;
  status: AssistantActionLedgerStatus;
  reservedAttempt: number;
  reservedLeaseOwner: string;
  completedAttempt: number | null;
  completedLeaseOwner: string | null;
  resourceType: AssistantActionResourceType | null;
  resourceId: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}>;

export type ReserveAssistantActionInput = Readonly<{
  jobId: string;
  attempt: number;
  leaseOwner: string;
  projectId: string;
  actionKey: string;
  actionType: AssistantActionType;
  input: unknown;
}>;

export type CompleteAssistantActionInput = ReserveAssistantActionInput &
  Readonly<{
    resourceType: AssistantActionResourceType;
    resourceId: string;
  }>;

export type AssistantActionLedgerErrorCode =
  | "INVALID_INPUT"
  | "GENERATION_NOT_FOUND"
  | "GENERATION_NOT_RUNNING"
  | "GENERATION_ATTEMPT_STALE"
  | "GENERATION_LEASE_INVALID"
  | "GENERATION_CANCEL_REQUESTED"
  | "MATTER_MISMATCH"
  | "ACTION_CONFLICT"
  | "ACTION_BUDGET_EXHAUSTED"
  | "ACTION_NOT_FOUND"
  | "ACTION_STATE_CONFLICT"
  | "CORRUPT_RECORD";

export class WorkspaceAssistantActionLedgerError extends Error {
  constructor(
    readonly code: AssistantActionLedgerErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WorkspaceAssistantActionLedgerError";
  }
}

const ACTION_RESOURCE_TYPES: Readonly<
  Record<AssistantActionType, AssistantActionResourceType>
> = {
  create_draft: "draft",
  suggest_draft_edit: "draft_suggestion",
  run_workflow: "workflow_run",
  run_contract_review: "tabular_review",
};
const MAX_CANONICAL_INPUT_CHARACTERS = 1_000_000;
const MAX_ATTEMPTS = 100;
const ACTION_TYPES = new Set<AssistantActionType>(
  Object.keys(ASSISTANT_ACTION_BUDGETS) as AssistantActionType[],
);
const RESOURCE_TYPES = new Set<AssistantActionResourceType>(
  Object.values(ACTION_RESOURCE_TYPES),
);

function fail(
  code: AssistantActionLedgerErrorCode,
  message: string,
  cause?: unknown,
): never {
  throw new WorkspaceAssistantActionLedgerError(
    code,
    message,
    cause instanceof Error ? { cause } : undefined,
  );
}

function canonicalJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      fail(
        "INVALID_INPUT",
        "Assistant action input must contain finite numbers.",
      );
    }
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    fail("INVALID_INPUT", "Assistant action input must be JSON-compatible.");
  }
  if (ancestors.has(value)) {
    fail("INVALID_INPUT", "Assistant action input must not be cyclic.");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) {
          fail(
            "INVALID_INPUT",
            "Assistant action input arrays must not be sparse.",
          );
        }
        items.push(canonicalJson(value[index], ancestors));
      }
      return `[${items.join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail(
        "INVALID_INPUT",
        "Assistant action input must use plain JSON objects.",
      );
    }
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson(record[key], ancestors)}`,
      );
    return `{${entries.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function hashAssistantActionInput(value: unknown): string {
  const canonical = canonicalJson(value);
  if (canonical.length > MAX_CANONICAL_INPUT_CHARACTERS) {
    fail("INVALID_INPUT", "Assistant action input is too large.");
  }
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function boundedText(value: unknown, name: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value !== value.trim() ||
    value.includes("\0")
  ) {
    fail("INVALID_INPUT", `${name} is invalid.`);
  }
  return value;
}

function attempt(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_ATTEMPTS
  ) {
    fail("INVALID_INPUT", "Assistant action attempt is invalid.");
  }
  return value;
}

function actionType(value: unknown): AssistantActionType {
  if (!ACTION_TYPES.has(value as AssistantActionType)) {
    fail("INVALID_INPUT", "Assistant action type is invalid.");
  }
  return value as AssistantActionType;
}

function resourceType(value: unknown): AssistantActionResourceType {
  if (!RESOURCE_TYPES.has(value as AssistantActionResourceType)) {
    fail("INVALID_INPUT", "Assistant action resource type is invalid.");
  }
  return value as AssistantActionResourceType;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length < 1) {
    fail("CORRUPT_RECORD", `Persisted Assistant action ${name} is invalid.`);
  }
  return value;
}

function optionalString(value: unknown, name: string): string | null {
  if (value === null || value === undefined) return null;
  return requiredString(value, name);
}

function requiredInteger(value: unknown, name: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    fail("CORRUPT_RECORD", `Persisted Assistant action ${name} is invalid.`);
  }
  return parsed;
}

function optionalInteger(value: unknown, name: string): number | null {
  if (value === null || value === undefined) return null;
  return requiredInteger(value, name);
}

function mapRow(row: Record<string, unknown>): AssistantActionLedgerRecord {
  const storedActionType = actionType(row.action_type);
  const status = requiredString(row.status, "status");
  if (status !== "reserved" && status !== "complete") {
    fail("CORRUPT_RECORD", "Persisted Assistant action status is invalid.");
  }
  const storedResourceType = optionalString(row.resource_type, "resource type");
  if (
    storedResourceType !== null &&
    !RESOURCE_TYPES.has(storedResourceType as AssistantActionResourceType)
  ) {
    fail(
      "CORRUPT_RECORD",
      "Persisted Assistant action resource type is invalid.",
    );
  }
  return {
    jobId: requiredString(row.job_id, "job id"),
    actionKey: requiredString(row.action_key, "key"),
    actionType: storedActionType,
    projectId: requiredString(row.project_id, "Matter id"),
    inputSha256: requiredString(row.input_sha256, "input hash"),
    status,
    reservedAttempt: requiredInteger(row.reserved_attempt, "reserved attempt"),
    reservedLeaseOwner: requiredString(
      row.reserved_lease_owner,
      "reserved lease owner",
    ),
    completedAttempt: optionalInteger(
      row.completed_attempt,
      "completed attempt",
    ),
    completedLeaseOwner: optionalString(
      row.completed_lease_owner,
      "completed lease owner",
    ),
    resourceType: storedResourceType as AssistantActionResourceType | null,
    resourceId: optionalString(row.resource_id, "resource id"),
    createdAt: requiredString(row.created_at, "created time"),
    updatedAt: requiredString(row.updated_at, "updated time"),
    completedAt: optionalString(row.completed_at, "completed time"),
  };
}

function timestamp(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    fail("INVALID_INPUT", "Assistant action clock returned an invalid time.");
  }
  return value.toISOString();
}

export class WorkspaceAssistantActionLedger {
  constructor(
    private readonly database: WorkspaceDatabaseAdapter,
    private readonly now: () => Date = () => new Date(),
  ) {}

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
        // Preserve the primary failure.
      }
      throw error;
    }
  }

  private normalized(input: ReserveAssistantActionInput) {
    const normalizedActionType = actionType(input.actionType);
    return {
      jobId: boundedText(input.jobId, "Assistant action job id", 200),
      attempt: attempt(input.attempt),
      leaseOwner: boundedText(
        input.leaseOwner,
        "Assistant action lease owner",
        240,
      ),
      projectId: boundedText(
        input.projectId,
        "Assistant action Matter id",
        200,
      ),
      actionKey: boundedText(input.actionKey, "Assistant action key", 240),
      actionType: normalizedActionType,
      inputSha256: hashAssistantActionInput(input.input),
    };
  }

  private assertCurrentMatter(
    input: ReturnType<typeof this.normalized>,
    checkedAt: string,
  ) {
    const row = this.database
      .prepare(
        `SELECT job.type,job.status,job.attempt,job.lease_owner,
                job.lease_expires_at,job.cancel_requested_at,
                json_extract(job.payload_json,'$.projectId') AS payload_project_id,
                snapshot.chat_id,chat.scope,chat.project_id,project.status AS project_status
           FROM jobs job
           LEFT JOIN assistant_generation_snapshots snapshot
             ON snapshot.job_id=job.id
           LEFT JOIN chats chat
             ON chat.id=snapshot.chat_id
           LEFT JOIN projects project
             ON project.id=chat.project_id
          WHERE job.id=?`,
      )
      .get(input.jobId);
    if (!row || row.type !== "assistant_generate") {
      fail("GENERATION_NOT_FOUND", "Assistant generation job was not found.");
    }
    if (row.status !== "running") {
      fail(
        "GENERATION_NOT_RUNNING",
        "Assistant generation job is not running.",
      );
    }
    if (Number(row.attempt) !== input.attempt) {
      fail(
        "GENERATION_ATTEMPT_STALE",
        "Assistant action attempt is not the current generation attempt.",
      );
    }
    if (row.cancel_requested_at !== null) {
      fail(
        "GENERATION_CANCEL_REQUESTED",
        "Assistant generation cancellation has already been requested.",
      );
    }
    if (
      row.lease_owner !== input.leaseOwner ||
      typeof row.lease_expires_at !== "string" ||
      Number.isNaN(Date.parse(row.lease_expires_at)) ||
      Date.parse(row.lease_expires_at) <= Date.parse(checkedAt)
    ) {
      fail(
        "GENERATION_LEASE_INVALID",
        "Assistant generation claim lease is not current.",
      );
    }
    if (
      row.scope !== "project" ||
      row.payload_project_id !== input.projectId ||
      row.project_id !== input.projectId ||
      row.project_status !== "active"
    ) {
      fail(
        "MATTER_MISMATCH",
        "Assistant action is outside the current active Matter snapshot.",
      );
    }
  }

  private find(jobId: string, actionKey: string) {
    const row = this.database
      .prepare(
        `SELECT job_id,action_key,action_type,project_id,input_sha256,status,
                reserved_attempt,reserved_lease_owner,
                completed_attempt,completed_lease_owner,resource_type,resource_id,
                created_at,updated_at,completed_at
           FROM assistant_action_ledger
          WHERE job_id=? AND action_key=?`,
      )
      .get(jobId, actionKey);
    return row ? mapRow(row) : null;
  }

  private assertBinding(
    record: AssistantActionLedgerRecord,
    input: ReturnType<typeof this.normalized>,
  ) {
    if (
      record.actionType !== input.actionType ||
      record.projectId !== input.projectId ||
      record.inputSha256 !== input.inputSha256
    ) {
      fail(
        "ACTION_CONFLICT",
        "Assistant action key is already bound to different immutable input.",
      );
    }
  }

  reserve(input: ReserveAssistantActionInput): {
    record: AssistantActionLedgerRecord;
    created: boolean;
  } {
    const normalized = this.normalized(input);
    const checkedAt = timestamp(this.now);
    return this.transaction(() => {
      this.assertCurrentMatter(normalized, checkedAt);
      const existing = this.find(normalized.jobId, normalized.actionKey);
      if (existing) {
        this.assertBinding(existing, normalized);
        return { record: existing, created: false };
      }
      const count = Number(
        this.database
          .prepare(
            `SELECT count(*) AS count
               FROM assistant_action_ledger
              WHERE job_id=? AND action_type=?`,
          )
          .get(normalized.jobId, normalized.actionType)?.count ?? 0,
      );
      if (count >= ASSISTANT_ACTION_BUDGETS[normalized.actionType]) {
        fail(
          "ACTION_BUDGET_EXHAUSTED",
          "Assistant action budget is exhausted for this generation job.",
        );
      }
      try {
        this.database
          .prepare(
            `INSERT INTO assistant_action_ledger
              (job_id,action_key,action_type,project_id,input_sha256,status,
               reserved_attempt,reserved_lease_owner,
               completed_attempt,completed_lease_owner,resource_type,resource_id,
               created_at,updated_at,completed_at)
             VALUES (?,?,?,?,?,'reserved',?,?,NULL,NULL,NULL,NULL,?,?,NULL)`,
          )
          .run(
            normalized.jobId,
            normalized.actionKey,
            normalized.actionType,
            normalized.projectId,
            normalized.inputSha256,
            normalized.attempt,
            normalized.leaseOwner,
            checkedAt,
            checkedAt,
          );
      } catch (error) {
        if (/budget exhausted/i.test(String(error))) {
          fail(
            "ACTION_BUDGET_EXHAUSTED",
            "Assistant action budget is exhausted for this generation job.",
            error,
          );
        }
        throw error;
      }
      const created = this.find(normalized.jobId, normalized.actionKey);
      if (!created) {
        fail(
          "CORRUPT_RECORD",
          "Assistant action reservation was not persisted.",
        );
      }
      return { record: created, created: true };
    });
  }

  complete(input: CompleteAssistantActionInput): {
    record: AssistantActionLedgerRecord;
    completed: boolean;
  } {
    const normalized = this.normalized(input);
    const checkedAt = timestamp(this.now);
    const normalizedResourceType = resourceType(input.resourceType);
    const resourceId = boundedText(
      input.resourceId,
      "Assistant action resource id",
      240,
    );
    if (
      ACTION_RESOURCE_TYPES[normalized.actionType] !== normalizedResourceType
    ) {
      fail(
        "ACTION_CONFLICT",
        "Assistant action resource type does not match its action type.",
      );
    }
    return this.transaction(() => {
      this.assertCurrentMatter(normalized, checkedAt);
      const existing = this.find(normalized.jobId, normalized.actionKey);
      if (!existing) {
        fail("ACTION_NOT_FOUND", "Assistant action reservation was not found.");
      }
      this.assertBinding(existing, normalized);
      if (existing.status === "complete") {
        if (
          existing.resourceType !== normalizedResourceType ||
          existing.resourceId !== resourceId
        ) {
          fail(
            "ACTION_STATE_CONFLICT",
            "Completed Assistant action resource binding cannot change.",
          );
        }
        return { record: existing, completed: false };
      }
      this.database
        .prepare(
          `UPDATE assistant_action_ledger
              SET status='complete',completed_attempt=?,completed_lease_owner=?,
                  resource_type=?,resource_id=?,
                  updated_at=?,completed_at=?
            WHERE job_id=? AND action_key=? AND status='reserved'`,
        )
        .run(
          normalized.attempt,
          normalized.leaseOwner,
          normalizedResourceType,
          resourceId,
          checkedAt,
          checkedAt,
          normalized.jobId,
          normalized.actionKey,
        );
      const completed = this.find(normalized.jobId, normalized.actionKey);
      if (!completed || completed.status !== "complete") {
        fail(
          "ACTION_STATE_CONFLICT",
          "Assistant action completion was rejected.",
        );
      }
      return { record: completed, completed: true };
    });
  }

  get(jobId: string, actionKey: string): AssistantActionLedgerRecord | null {
    return this.find(
      boundedText(jobId, "Assistant action job id", 200),
      boundedText(actionKey, "Assistant action key", 240),
    );
  }
}
