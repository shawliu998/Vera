import { createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { LocalDatabase } from "./localDatabase";

export const DURABLE_EXECUTOR_VERSION = "aletheia-durable-executor-v1";

export type DurableRunStatus =
  | "queued"
  | "running"
  | "cancel_requested"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out";

export type DurableStepStatus =
  | "pending"
  | "running"
  | "retry_wait"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out";

export type DurableStepDefinition = {
  key: string;
  title: string;
  handler: string;
  input?: Record<string, unknown>;
  maxAttempts?: number;
  timeoutMs?: number;
};

export type EnqueueDurableRunInput = {
  matterId: string;
  userId: string;
  workflow: string;
  goal: string;
  modelProfile?: string | null;
  metadata?: Record<string, unknown>;
  steps: DurableStepDefinition[];
  runTimeoutMs?: number;
  maxRunAttempts?: number;
};

export type ClaimedDurableRun = {
  id: string;
  matterId: string;
  userId: string;
  workflow: string;
  goal: string;
  modelProfile: string | null;
  leaseOwner: string;
  leaseExpiresAt: string;
  deadlineAt: string;
};

export type DurableStepExecution = {
  runId: string;
  matterId: string;
  userId: string;
  stepId: string;
  stepKey: string;
  handler: string;
  workflow: string;
  modelProfile: string | null;
  attempt: number;
  input: Record<string, unknown>;
  signal: AbortSignal;
};

export interface DurableStepExecutor {
  execute(step: DurableStepExecution): Promise<Record<string, unknown>>;
}

export type DurableAgentQueueOptions = {
  databasePath?: string;
  leaseMs?: number;
  defaultRunTimeoutMs?: number;
  defaultStepTimeoutMs?: number;
  defaultStepMaxAttempts?: number;
  defaultMaxRunAttempts?: number;
  retryBaseMs?: number;
  now?: () => Date;
};

type SqlValue = string | number | bigint | Uint8Array | null;
type SqlRow = Record<string, SqlValue>;
type BegunStep = {
  id: string;
  step_key: string;
  handler: string;
  timeout_ms: number;
  attempt_count: number;
  input: Record<string, unknown>;
};

const TERMINAL_RUN_STATUSES = new Set<DurableRunStatus>([
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
]);

const RUN_TRANSITIONS: Record<DurableRunStatus, Set<DurableRunStatus>> = {
  queued: new Set(["running", "cancelled", "failed", "timed_out"]),
  running: new Set([
    "queued",
    "cancel_requested",
    "succeeded",
    "failed",
    "cancelled",
    "timed_out",
  ]),
  cancel_requested: new Set(["cancelled"]),
  succeeded: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  timed_out: new Set(),
};

function localDataDir() {
  return (
    process.env.ALETHEIA_DATA_DIR ??
    process.env.ALET_HEIA_DATA_DIR ??
    path.resolve(process.cwd(), ".data", "aletheia")
  );
}

function defaultDatabasePath() {
  const root = localDataDir();
  if (!existsSync(root)) mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  return path.join(root, "aletheia.db");
}

function positiveInteger(value: number | undefined, fallback: number) {
  return Number.isInteger(value) && Number(value) > 0
    ? Number(value)
    : fallback;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  return Math.min(maximum, Math.max(minimum, positiveInteger(value, fallback)));
}

function serialize(value: unknown) {
  return JSON.stringify(value ?? {});
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

function executorHmacKey(databasePath: string) {
  const configured = process.env.ALETHEIA_AUDIT_HMAC_SECRET?.trim();
  if (configured) return Buffer.from(configured, "utf8");
  const keyPath = path.join(path.dirname(databasePath), ".audit-hmac-key");
  if (!existsSync(keyPath))
    writeFileSync(keyPath, randomBytes(32), { mode: 0o600 });
  chmodSync(keyPath, 0o600);
  return readFileSync(keyPath);
}

function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || !value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function ensureColumn(
  db: LocalDatabase,
  table: string,
  column: string,
  definition: string,
) {
  const columns = db.prepare(`pragma table_info(${table})`).all() as Array<{
    name?: string;
  }>;
  if (!columns.some((item) => item.name === column)) {
    db.exec(`alter table ${table} add column ${column} ${definition}`);
  }
}

function isoAfter(date: Date, milliseconds: number) {
  return new Date(date.getTime() + milliseconds).toISOString();
}

function errorMessage(error: unknown) {
  return error instanceof Error
    ? error.message.slice(0, 2000)
    : String(error).slice(0, 2000);
}

class StepTimeoutError extends Error {
  constructor() {
    super("Durable agent step exceeded its execution deadline");
    this.name = "StepTimeoutError";
  }
}

class StepCancelledError extends Error {
  constructor() {
    super("Durable agent run was cancelled");
    this.name = "StepCancelledError";
  }
}

class LeaseLostError extends Error {
  constructor() {
    super("Durable agent worker lost its lease");
    this.name = "LeaseLostError";
  }
}

export class DurableAgentQueue {
  private readonly db: LocalDatabase;
  private readonly leaseMs: number;
  private readonly defaultRunTimeoutMs: number;
  private readonly defaultStepTimeoutMs: number;
  private readonly defaultStepMaxAttempts: number;
  private readonly defaultMaxRunAttempts: number;
  private readonly retryBaseMs: number;
  private readonly clock: () => Date;
  private readonly hmacKey: Buffer;

  constructor(options: DurableAgentQueueOptions = {}) {
    const databasePath = options.databasePath ?? defaultDatabasePath();
    this.db = new LocalDatabase(databasePath);
    this.db.exec("pragma journal_mode = WAL");
    this.db.exec("pragma foreign_keys = ON");
    this.db.exec("pragma busy_timeout = 5000");
    if (existsSync(databasePath)) chmodSync(databasePath, 0o600);
    this.hmacKey = executorHmacKey(databasePath);
    this.leaseMs = boundedInteger(options.leaseMs, 30_000, 1_000, 10 * 60_000);
    this.defaultRunTimeoutMs = boundedInteger(
      options.defaultRunTimeoutMs,
      30 * 60_000,
      1_000,
      24 * 60 * 60_000,
    );
    this.defaultStepTimeoutMs = boundedInteger(
      options.defaultStepTimeoutMs,
      5 * 60_000,
      100,
      6 * 60 * 60_000,
    );
    this.defaultStepMaxAttempts = boundedInteger(
      options.defaultStepMaxAttempts,
      3,
      1,
      10,
    );
    this.defaultMaxRunAttempts = boundedInteger(
      options.defaultMaxRunAttempts,
      50,
      1,
      1_000,
    );
    this.retryBaseMs = boundedInteger(options.retryBaseMs, 1_000, 1, 60_000);
    this.clock = options.now ?? (() => new Date());
    this.ensureSchema();
  }

  close() {
    this.db.close();
  }

  private ensureSchema() {
    const requiredTables = [
      "aletheia_matters",
      "aletheia_agent_runs",
      "aletheia_agent_steps",
    ];
    for (const table of requiredTables) {
      const row = this.db
        .prepare(
          "select name from sqlite_master where type = 'table' and name = ?",
        )
        .get(table);
      if (!row) {
        throw new Error(
          `Durable agent executor requires the initialized local Aletheia schema (${table} is missing)`,
        );
      }
    }

    const runColumns: Array<[string, string]> = [
      ["executor_version", "text"],
      ["attempt_count", "integer not null default 0"],
      ["max_attempts", "integer not null default 50"],
      ["run_timeout_ms", "integer not null default 1800000"],
      ["available_at", "text"],
      ["deadline_at", "text"],
      ["lease_owner", "text"],
      ["lease_expires_at", "text"],
      ["heartbeat_at", "text"],
      ["cancel_requested_at", "text"],
      ["failure_code", "text"],
      ["failure_message", "text"],
    ];
    for (const [column, definition] of runColumns) {
      ensureColumn(this.db, "aletheia_agent_runs", column, definition);
    }

    const stepColumns: Array<[string, string]> = [
      ["handler", "text"],
      ["attempt_count", "integer not null default 0"],
      ["max_attempts", "integer not null default 3"],
      ["timeout_ms", "integer not null default 300000"],
      ["available_at", "text"],
      ["error", "text"],
      ["updated_at", "text"],
    ];
    for (const [column, definition] of stepColumns) {
      ensureColumn(this.db, "aletheia_agent_steps", column, definition);
    }

    this.db.exec(`
      create unique index if not exists idx_durable_agent_step_key
        on aletheia_agent_steps(run_id, step_key)
        where handler is not null;
      create index if not exists idx_durable_agent_run_claim
        on aletheia_agent_runs(executor_version, status, available_at, created_at);
      create table if not exists aletheia_executor_events (
        id text primary key,
        run_id text not null references aletheia_agent_runs(id) on delete cascade,
        matter_id text not null references aletheia_matters(id) on delete cascade,
        user_id text not null,
        sequence integer not null,
        event_type text not null,
        worker_id text,
        step_id text,
        details text not null default '{}',
        previous_hash text,
        event_hash text not null,
        created_at text not null,
        unique(run_id, sequence)
      );
      create index if not exists idx_executor_events_run_sequence
        on aletheia_executor_events(run_id, sequence);
    `);
    ensureColumn(this.db, "aletheia_executor_events", "previous_hash", "text");
    ensureColumn(this.db, "aletheia_executor_events", "event_hash", "text");
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("begin immediate");
    try {
      const result = operation();
      this.db.exec("commit");
      return result;
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  private event(
    run: SqlRow,
    eventType: string,
    details: Record<string, unknown> = {},
    workerId: string | null = null,
    stepId: string | null = null,
  ) {
    const row = this.db
      .prepare(
        `select sequence, event_hash from aletheia_executor_events
         where run_id = ? order by sequence desc limit 1`,
      )
      .get(String(run.id)) as
      | { sequence?: number; event_hash?: string | null }
      | undefined;
    const id = randomUUID();
    const sequence = Number(row?.sequence ?? 0) + 1;
    const previousHash = row?.event_hash ?? null;
    const createdAt = this.clock().toISOString();
    const payload: Record<string, unknown> = {
      id,
      runId: String(run.id),
      matterId: String(run.matter_id),
      userId: String(run.user_id),
      sequence,
      eventType,
      workerId,
      stepId,
      details,
      previousHash,
      createdAt,
    };
    const eventHash = `hmac-sha256:${createHmac("sha256", this.hmacKey)
      .update(stableJson(payload))
      .digest("hex")}`;
    this.db
      .prepare(
        `insert into aletheia_executor_events
          (id, run_id, matter_id, user_id, sequence, event_type, worker_id,
           step_id, details, previous_hash, event_hash, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        String(run.id),
        String(run.matter_id),
        String(run.user_id),
        sequence,
        eventType,
        workerId,
        stepId,
        serialize(details),
        previousHash,
        eventHash,
        createdAt,
      );
  }

  verifyEventChain(runId: string) {
    const events = this.db
      .prepare(
        "select * from aletheia_executor_events where run_id = ? order by sequence asc",
      )
      .all(runId) as SqlRow[];
    let previousHash: string | null = null;
    let expectedSequence = 1;
    for (const event of events) {
      const details = parseObject(event.details);
      const payload: Record<string, unknown> = {
        id: String(event.id),
        runId: String(event.run_id),
        matterId: String(event.matter_id),
        userId: String(event.user_id),
        sequence: Number(event.sequence),
        eventType: String(event.event_type),
        workerId: event.worker_id === null ? null : String(event.worker_id),
        stepId: event.step_id === null ? null : String(event.step_id),
        details,
        previousHash,
        createdAt: String(event.created_at),
      };
      const expectedHash: string = `hmac-sha256:${createHmac(
        "sha256",
        this.hmacKey,
      )
        .update(stableJson(payload))
        .digest("hex")}`;
      if (
        Number(event.sequence) !== expectedSequence ||
        event.previous_hash !== previousHash ||
        event.event_hash !== expectedHash
      ) {
        return {
          ok: false,
          eventId: String(event.id),
          expectedSequence,
          actualSequence: Number(event.sequence),
        };
      }
      previousHash = expectedHash;
      expectedSequence += 1;
    }
    return { ok: true, eventCount: events.length, lastHash: previousHash };
  }

  private assertRunTransition(run: SqlRow, target: DurableRunStatus) {
    const source = String(run.status) as DurableRunStatus;
    if (!RUN_TRANSITIONS[source]?.has(target)) {
      throw new Error(
        `Illegal durable run state transition: ${source} -> ${target}`,
      );
    }
  }

  enqueue(input: EnqueueDurableRunInput) {
    if (!input.steps.length)
      throw new Error("At least one durable agent step is required");
    if (input.steps.length > 200)
      throw new Error("Durable agent runs are limited to 200 steps");
    const duplicateKeys = input.steps
      .map((step) => step.key)
      .filter((key, index, keys) => keys.indexOf(key) !== index);
    if (duplicateKeys.length)
      throw new Error("Durable agent step keys must be unique");
    for (const step of input.steps) {
      if (!step.key.trim() || !step.handler.trim()) {
        throw new Error("Every durable agent step requires a key and handler");
      }
    }

    const matter = this.db
      .prepare("select id from aletheia_matters where id = ? and user_id = ?")
      .get(input.matterId, input.userId);
    if (!matter) return null;

    const runId = randomUUID();
    const createdAt = this.clock().toISOString();
    const runTimeoutMs = boundedInteger(
      input.runTimeoutMs,
      this.defaultRunTimeoutMs,
      1_000,
      24 * 60 * 60_000,
    );
    const maxRunAttempts = boundedInteger(
      input.maxRunAttempts,
      this.defaultMaxRunAttempts,
      1,
      1_000,
    );

    this.transaction(() => {
      this.db
        .prepare(
          `insert into aletheia_agent_runs (
             id, matter_id, user_id, workflow, goal, status, current_step_key,
             model_profile, storage_driver, budget, metadata, started_at,
             completed_at, created_at, updated_at, executor_version,
             attempt_count, max_attempts, run_timeout_ms, available_at
           ) values (?, ?, ?, ?, ?, 'queued', ?, ?, 'local', '{}', ?, null,
                     null, ?, ?, ?, 0, ?, ?, ?)`,
        )
        .run(
          runId,
          input.matterId,
          input.userId,
          input.workflow,
          input.goal,
          input.steps[0]?.key ?? null,
          input.modelProfile ?? null,
          serialize({ ...(input.metadata ?? {}), durableExecutor: true }),
          createdAt,
          createdAt,
          DURABLE_EXECUTOR_VERSION,
          maxRunAttempts,
          runTimeoutMs,
          createdAt,
        );

      for (const [index, step] of input.steps.entries()) {
        const stepId = randomUUID();
        this.db
          .prepare(
            `insert into aletheia_agent_steps (
               id, run_id, matter_id, user_id, step_key, title, sequence, status,
               input, output, validation_errors, metrics, started_at, completed_at,
               created_at, handler, attempt_count, max_attempts, timeout_ms,
               available_at, error, updated_at
             ) values (?, ?, ?, ?, ?, ?, ?, 'pending', ?, '{}', '[]', '{}', null,
                       null, ?, ?, 0, ?, ?, ?, null, ?)`,
          )
          .run(
            stepId,
            runId,
            input.matterId,
            input.userId,
            step.key,
            step.title,
            index,
            serialize(step.input ?? {}),
            createdAt,
            step.handler,
            boundedInteger(
              step.maxAttempts,
              this.defaultStepMaxAttempts,
              1,
              10,
            ),
            boundedInteger(
              step.timeoutMs,
              this.defaultStepTimeoutMs,
              100,
              6 * 60 * 60_000,
            ),
            createdAt,
            createdAt,
          );
      }
      const run = this.db
        .prepare("select * from aletheia_agent_runs where id = ?")
        .get(runId) as SqlRow;
      this.event(run, "run.enqueued", {
        workflow: input.workflow,
        stepCount: input.steps.length,
        runTimeoutMs,
        maxRunAttempts,
      });
    });
    return this.getRun(input.userId, runId);
  }

  getRun(userId: string, runId: string) {
    const run = this.db
      .prepare(
        "select * from aletheia_agent_runs where id = ? and user_id = ? and executor_version = ?",
      )
      .get(runId, userId, DURABLE_EXECUTOR_VERSION) as SqlRow | undefined;
    if (!run) return null;
    const steps = this.db
      .prepare(
        "select * from aletheia_agent_steps where run_id = ? order by sequence asc",
      )
      .all(runId) as SqlRow[];
    const events = this.db
      .prepare(
        "select * from aletheia_executor_events where run_id = ? order by sequence asc",
      )
      .all(runId) as SqlRow[];
    return {
      ...run,
      budget: parseObject(run.budget),
      metadata: parseObject(run.metadata),
      steps: steps.map((step) => ({
        ...step,
        input: parseObject(step.input),
        output: parseObject(step.output),
        metrics: parseObject(step.metrics),
      })),
      events: events.map((event) => ({
        ...event,
        details: parseObject(event.details),
      })),
    };
  }

  latestRun(userId: string, matterId: string, workflow: string) {
    const row = this.db
      .prepare(
        `select id from aletheia_agent_runs
          where user_id = ? and matter_id = ? and workflow = ?
            and executor_version = ?
          order by created_at desc, rowid desc limit 1`,
      )
      .get(userId, matterId, workflow, DURABLE_EXECUTOR_VERSION) as
      | { id?: SqlValue }
      | undefined;
    return row?.id ? this.getRun(userId, String(row.id)) : null;
  }

  cancel(userId: string, runId: string) {
    return this.transaction(() => {
      const run = this.db
        .prepare(
          "select * from aletheia_agent_runs where id = ? and user_id = ? and executor_version = ?",
        )
        .get(runId, userId, DURABLE_EXECUTOR_VERSION) as SqlRow | undefined;
      if (!run) return null;
      const status = String(run.status) as DurableRunStatus;
      if (TERMINAL_RUN_STATUSES.has(status)) return this.getRun(userId, runId);
      if (status === "cancel_requested") return this.getRun(userId, runId);
      const timestamp = this.clock().toISOString();
      if (status === "queued") {
        this.assertRunTransition(run, "cancelled");
        this.db
          .prepare(
            `update aletheia_agent_runs
             set status = 'cancelled', cancel_requested_at = ?, completed_at = ?, updated_at = ?
             where id = ? and status = 'queued'`,
          )
          .run(timestamp, timestamp, timestamp, runId);
        this.db
          .prepare(
            `update aletheia_agent_steps set status = 'cancelled', completed_at = ?, updated_at = ?
             where run_id = ? and status in ('pending', 'retry_wait')`,
          )
          .run(timestamp, timestamp, runId);
        this.event(run, "run.cancelled", { mode: "before_claim" });
      } else {
        this.assertRunTransition(run, "cancel_requested");
        this.db
          .prepare(
            `update aletheia_agent_runs
             set status = 'cancel_requested', cancel_requested_at = ?, updated_at = ?
             where id = ? and status in ('running', 'cancel_requested')`,
          )
          .run(timestamp, timestamp, runId);
        this.event(run, "run.cancel_requested");
      }
      return this.getRun(userId, runId);
    });
  }

  recoverExpiredRuns() {
    const timestamp = this.clock().toISOString();
    return this.transaction(() => {
      const rows = this.db
        .prepare(
          `select * from aletheia_agent_runs
           where executor_version = ?
             and status in ('running', 'cancel_requested')
             and (lease_expires_at is null or lease_expires_at <= ?)`,
        )
        .all(DURABLE_EXECUTOR_VERSION, timestamp) as SqlRow[];
      for (const run of rows) {
        const runId = String(run.id);
        if (run.cancel_requested_at || run.status === "cancel_requested") {
          this.finishCancelledInTransaction(run, "expired_lease");
          continue;
        }
        if (run.deadline_at && String(run.deadline_at) <= timestamp) {
          this.failRunInTransaction(
            run,
            "timed_out",
            "RUN_TIMEOUT",
            "Run deadline expired",
          );
          continue;
        }
        if (Number(run.attempt_count ?? 0) >= Number(run.max_attempts ?? 1)) {
          this.failRunInTransaction(
            run,
            "failed",
            "RUN_ATTEMPTS_EXHAUSTED",
            "Run recovery attempts exhausted",
          );
          continue;
        }
        const exhaustedStep = this.db
          .prepare(
            `select * from aletheia_agent_steps
             where run_id = ? and status = 'running' and attempt_count >= max_attempts
             order by sequence asc limit 1`,
          )
          .get(runId) as SqlRow | undefined;
        if (exhaustedStep) {
          this.db
            .prepare(
              `update aletheia_agent_steps
               set status = 'failed', error = ?, completed_at = ?, updated_at = ? where id = ?`,
            )
            .run(
              "Worker crashed during the final permitted step attempt",
              timestamp,
              timestamp,
              String(exhaustedStep.id),
            );
          this.failRunInTransaction(
            run,
            "failed",
            "STEP_ATTEMPTS_EXHAUSTED",
            "Worker crashed during the final permitted step attempt",
          );
          continue;
        }
        this.db
          .prepare(
            `update aletheia_agent_steps
             set status = 'retry_wait', available_at = ?, error = ?, updated_at = ?
             where run_id = ? and status = 'running'`,
          )
          .run(
            timestamp,
            "Worker lease expired before step completion",
            timestamp,
            runId,
          );
        this.assertRunTransition(run, "queued");
        this.db
          .prepare(
            `update aletheia_agent_runs
             set status = 'queued', available_at = ?, lease_owner = null,
                 lease_expires_at = null, heartbeat_at = null, updated_at = ?
             where id = ?`,
          )
          .run(timestamp, timestamp, runId);
        this.event(run, "run.recovered", { reason: "expired_lease" });
      }
      return rows.length;
    });
  }

  claimNext(workerId: string): ClaimedDurableRun | null {
    if (!workerId.trim()) throw new Error("workerId is required");
    return this.transaction(() => {
      const timestamp = this.clock().toISOString();
      while (true) {
        const run = this.db
          .prepare(
            `select * from aletheia_agent_runs
             where executor_version = ? and status = 'queued'
               and cancel_requested_at is null
               and (available_at is null or available_at <= ?)
             order by created_at asc, id asc limit 1`,
          )
          .get(DURABLE_EXECUTOR_VERSION, timestamp) as SqlRow | undefined;
        if (!run) return null;
        if (Number(run.attempt_count ?? 0) >= Number(run.max_attempts ?? 1)) {
          this.failRunInTransaction(
            run,
            "failed",
            "RUN_ATTEMPTS_EXHAUSTED",
            "Run claim attempts exhausted",
          );
          continue;
        }
        const deadlineAt = run.deadline_at
          ? String(run.deadline_at)
          : isoAfter(this.clock(), Number(run.run_timeout_ms));
        if (deadlineAt <= timestamp) {
          this.failRunInTransaction(
            run,
            "timed_out",
            "RUN_TIMEOUT",
            "Run deadline expired",
          );
          continue;
        }
        const leaseExpiresAt = isoAfter(this.clock(), this.leaseMs);
        this.assertRunTransition(run, "running");
        const result = this.db
          .prepare(
            `update aletheia_agent_runs
             set status = 'running', attempt_count = attempt_count + 1,
                 started_at = coalesce(started_at, ?), deadline_at = ?,
                 lease_owner = ?, lease_expires_at = ?, heartbeat_at = ?, updated_at = ?
             where id = ? and status = 'queued' and cancel_requested_at is null`,
          )
          .run(
            timestamp,
            deadlineAt,
            workerId,
            leaseExpiresAt,
            timestamp,
            timestamp,
            String(run.id),
          );
        if (Number(result.changes) !== 1) continue;
        this.event(
          run,
          "run.claimed",
          { attempt: Number(run.attempt_count ?? 0) + 1, leaseExpiresAt },
          workerId,
        );
        return {
          id: String(run.id),
          matterId: String(run.matter_id),
          userId: String(run.user_id),
          workflow: String(run.workflow),
          goal: String(run.goal),
          modelProfile:
            run.model_profile === null ? null : String(run.model_profile),
          leaseOwner: workerId,
          leaseExpiresAt,
          deadlineAt,
        };
      }
    });
  }

  heartbeat(
    runId: string,
    workerId: string,
  ): "ok" | "cancel_requested" | "lost" {
    const timestamp = this.clock().toISOString();
    const leaseExpiresAt = isoAfter(this.clock(), this.leaseMs);
    const result = this.db
      .prepare(
        `update aletheia_agent_runs set heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
         where id = ? and lease_owner = ? and status in ('running', 'cancel_requested')`,
      )
      .run(timestamp, leaseExpiresAt, timestamp, runId, workerId);
    if (Number(result.changes) !== 1) return "lost";
    const run = this.db
      .prepare(
        "select status, cancel_requested_at from aletheia_agent_runs where id = ?",
      )
      .get(runId) as SqlRow | undefined;
    return run?.cancel_requested_at || run?.status === "cancel_requested"
      ? "cancel_requested"
      : "ok";
  }

  nextStep(runId: string, workerId: string) {
    const run = this.ownedLease(runId, workerId);
    if (!run) return null;
    return (this.db
      .prepare(
        `select * from aletheia_agent_steps
         where run_id = ? and status in ('pending', 'retry_wait')
         order by sequence asc limit 1`,
      )
      .get(runId) ?? null) as SqlRow | null;
  }

  beginStep(runId: string, stepId: string, workerId: string): BegunStep | null {
    return this.transaction(() => {
      const run = this.ownedLease(runId, workerId);
      if (!run) return null;
      const timestamp = this.clock().toISOString();
      const step = this.db
        .prepare(
          `select * from aletheia_agent_steps
           where id = ? and run_id = ? and status in ('pending', 'retry_wait')`,
        )
        .get(stepId, runId) as SqlRow | undefined;
      if (!step) return null;
      const result = this.db
        .prepare(
          `update aletheia_agent_steps
           set status = 'running', attempt_count = attempt_count + 1,
               started_at = ?, completed_at = null, error = null, updated_at = ?
           where id = ? and run_id = ? and status in ('pending', 'retry_wait')`,
        )
        .run(timestamp, timestamp, stepId, runId);
      if (Number(result.changes) !== 1) return null;
      this.db
        .prepare(
          "update aletheia_agent_runs set current_step_key = ?, updated_at = ? where id = ?",
        )
        .run(String(step.step_key), timestamp, runId);
      this.event(
        run,
        "step.started",
        {
          stepKey: String(step.step_key),
          attempt: Number(step.attempt_count ?? 0) + 1,
        },
        workerId,
        stepId,
      );
      return {
        id: String(step.id),
        step_key: String(step.step_key),
        handler: String(step.handler),
        timeout_ms: Number(step.timeout_ms),
        attempt_count: Number(step.attempt_count ?? 0) + 1,
        input: parseObject(step.input),
      };
    });
  }

  completeStep(
    runId: string,
    stepId: string,
    workerId: string,
    output: Record<string, unknown>,
    durationMs: number,
  ) {
    return this.transaction(() => {
      const run = this.ownedLease(runId, workerId);
      if (!run) return false;
      const timestamp = this.clock().toISOString();
      const result = this.db
        .prepare(
          `update aletheia_agent_steps
           set status = 'succeeded', output = ?, metrics = ?, completed_at = ?, updated_at = ?
           where id = ? and run_id = ? and status = 'running'`,
        )
        .run(
          serialize(output),
          serialize({ durationMs }),
          timestamp,
          timestamp,
          stepId,
          runId,
        );
      if (Number(result.changes) !== 1) return false;
      this.event(run, "step.succeeded", { durationMs }, workerId, stepId);
      return true;
    });
  }

  failStep(
    runId: string,
    stepId: string,
    workerId: string,
    error: unknown,
    code: "STEP_ERROR" | "STEP_TIMEOUT",
  ) {
    return this.transaction(() => {
      const run = this.ownedLease(runId, workerId);
      if (!run) return "lost" as const;
      const step = this.db
        .prepare(
          "select * from aletheia_agent_steps where id = ? and run_id = ?",
        )
        .get(stepId, runId) as SqlRow | undefined;
      if (!step || step.status !== "running") return "lost" as const;
      const timestamp = this.clock().toISOString();
      const message = errorMessage(error);
      const attempts = Number(step.attempt_count ?? 0);
      const maxAttempts = Number(step.max_attempts ?? 1);
      if (run.deadline_at && String(run.deadline_at) <= timestamp) {
        this.db
          .prepare(
            `update aletheia_agent_steps set status = 'timed_out', error = ?, completed_at = ?, updated_at = ?
             where id = ?`,
          )
          .run(message, timestamp, timestamp, stepId);
        this.failRunInTransaction(
          run,
          "timed_out",
          "RUN_TIMEOUT",
          "Run deadline expired",
        );
        return "terminal" as const;
      }
      if (attempts < maxAttempts) {
        const backoffMs = Math.min(
          this.retryBaseMs * 2 ** (attempts - 1),
          15 * 60_000,
        );
        const availableAt = isoAfter(this.clock(), backoffMs);
        this.db
          .prepare(
            `update aletheia_agent_steps
             set status = 'retry_wait', error = ?, available_at = ?, updated_at = ? where id = ?`,
          )
          .run(message, availableAt, timestamp, stepId);
        this.assertRunTransition(run, "queued");
        this.db
          .prepare(
            `update aletheia_agent_runs
             set status = 'queued', available_at = ?, lease_owner = null,
                 lease_expires_at = null, heartbeat_at = null, failure_code = ?,
                 failure_message = ?, updated_at = ? where id = ?`,
          )
          .run(availableAt, code, message, timestamp, runId);
        this.event(
          run,
          "step.retry_scheduled",
          { code, attempt: attempts, maxAttempts, backoffMs },
          workerId,
          stepId,
        );
        return "retry" as const;
      }
      const status: DurableStepStatus =
        code === "STEP_TIMEOUT" ? "timed_out" : "failed";
      this.db
        .prepare(
          `update aletheia_agent_steps set status = ?, error = ?, completed_at = ?, updated_at = ?
           where id = ?`,
        )
        .run(status, message, timestamp, timestamp, stepId);
      this.event(
        run,
        status === "timed_out" ? "step.timed_out" : "step.failed",
        { code, attempt: attempts, maxAttempts },
        workerId,
        stepId,
      );
      this.failRunInTransaction(run, "failed", code, message);
      return "terminal" as const;
    });
  }

  completeRun(runId: string, workerId: string) {
    return this.transaction(() => {
      const run = this.ownedLease(runId, workerId);
      if (!run) return false;
      const unfinished = this.db
        .prepare(
          "select count(*) as count from aletheia_agent_steps where run_id = ? and status != 'succeeded'",
        )
        .get(runId) as { count?: number } | undefined;
      if (Number(unfinished?.count ?? 0) !== 0) return false;
      const timestamp = this.clock().toISOString();
      this.assertRunTransition(run, "succeeded");
      this.db
        .prepare(
          `update aletheia_agent_runs
           set status = 'succeeded', current_step_key = null, completed_at = ?,
               lease_owner = null, lease_expires_at = null, heartbeat_at = null,
               failure_code = null, failure_message = null, updated_at = ? where id = ?`,
        )
        .run(timestamp, timestamp, runId);
      this.event(run, "run.succeeded", {}, workerId);
      return true;
    });
  }

  finishCancelled(runId: string, workerId: string) {
    return this.transaction(() => {
      const run = this.ownedLease(runId, workerId);
      if (!run) return false;
      this.finishCancelledInTransaction(
        run,
        "worker_observed_request",
        workerId,
      );
      return true;
    });
  }

  private ownedLease(runId: string, workerId: string) {
    return this.db
      .prepare(
        `select * from aletheia_agent_runs
         where id = ? and lease_owner = ? and status in ('running', 'cancel_requested')`,
      )
      .get(runId, workerId) as SqlRow | undefined;
  }

  private finishCancelledInTransaction(
    run: SqlRow,
    reason: string,
    workerId: string | null = null,
  ) {
    const timestamp = this.clock().toISOString();
    this.assertRunTransition(run, "cancelled");
    this.db
      .prepare(
        `update aletheia_agent_steps
         set status = 'cancelled', completed_at = ?, updated_at = ?
         where run_id = ? and status in ('pending', 'retry_wait', 'running')`,
      )
      .run(timestamp, timestamp, String(run.id));
    this.db
      .prepare(
        `update aletheia_agent_runs
         set status = 'cancelled', completed_at = ?, lease_owner = null,
             lease_expires_at = null, heartbeat_at = null, updated_at = ? where id = ?`,
      )
      .run(timestamp, timestamp, String(run.id));
    this.event(run, "run.cancelled", { reason }, workerId);
  }

  private failRunInTransaction(
    run: SqlRow,
    status: "failed" | "timed_out",
    code: string,
    message: string,
  ) {
    const timestamp = this.clock().toISOString();
    this.assertRunTransition(run, status);
    this.db
      .prepare(
        `update aletheia_agent_steps
         set status = case when status = 'running' and ? = 'timed_out' then 'timed_out'
                           when status in ('pending', 'retry_wait', 'running') then 'cancelled'
                           else status end,
             completed_at = case when status in ('pending', 'retry_wait', 'running') then ? else completed_at end,
             updated_at = ?
         where run_id = ?`,
      )
      .run(status, timestamp, timestamp, String(run.id));
    this.db
      .prepare(
        `update aletheia_agent_runs set status = ?, failure_code = ?, failure_message = ?,
             completed_at = ?, lease_owner = null, lease_expires_at = null,
             heartbeat_at = null, updated_at = ? where id = ?`,
      )
      .run(status, code, message, timestamp, timestamp, String(run.id));
    this.event(run, status === "timed_out" ? "run.timed_out" : "run.failed", {
      code,
      message,
    });
  }
}

export type DurableAgentWorkerOptions = {
  workerId?: string;
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  canProcess?: () => boolean;
};

export class DurableAgentWorker {
  readonly workerId: string;
  private readonly pollIntervalMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly canProcess: () => boolean;
  private stopped = true;
  private loopTimer: NodeJS.Timeout | null = null;
  private ticking = false;
  private activeController: AbortController | null = null;

  constructor(
    private readonly queue: DurableAgentQueue,
    private readonly executor: DurableStepExecutor,
    options: DurableAgentWorkerOptions = {},
  ) {
    this.workerId = options.workerId ?? `local-worker-${randomUUID()}`;
    this.pollIntervalMs = boundedInteger(
      options.pollIntervalMs,
      500,
      25,
      60_000,
    );
    this.heartbeatIntervalMs = boundedInteger(
      options.heartbeatIntervalMs,
      1_000,
      50,
      60_000,
    );
    this.canProcess = options.canProcess ?? (() => true);
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.queue.recoverExpiredRuns();
    void this.tick();
    this.loopTimer = setInterval(() => void this.tick(), this.pollIntervalMs);
    this.loopTimer.unref();
  }

  stop() {
    this.stopped = true;
    if (this.loopTimer) clearInterval(this.loopTimer);
    this.loopTimer = null;
    this.activeController?.abort(new Error("Durable agent worker is stopping"));
  }

  async waitForIdle(timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (this.ticking && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return !this.ticking;
  }

  async runOnce() {
    if (!this.canProcess()) return false;
    const claim = this.queue.claimNext(this.workerId);
    if (!claim) return false;

    while (!this.stopped || this.loopTimer === null) {
      const heartbeat = this.queue.heartbeat(claim.id, this.workerId);
      if (heartbeat === "cancel_requested") {
        this.queue.finishCancelled(claim.id, this.workerId);
        return true;
      }
      if (heartbeat === "lost") return true;

      const pending = this.queue.nextStep(claim.id, this.workerId);
      if (!pending) {
        this.queue.completeRun(claim.id, this.workerId);
        return true;
      }
      const step = this.queue.beginStep(
        claim.id,
        String(pending.id),
        this.workerId,
      );
      if (!step) return true;
      const controller = new AbortController();
      this.activeController = controller;
      const started = Date.now();
      const stepDeadlineMs = Math.max(
        1,
        Math.min(
          Number(step.timeout_ms),
          new Date(claim.deadlineAt).getTime() - Date.now(),
        ),
      );
      let timeout: NodeJS.Timeout | null = null;
      let heartbeatTimer: NodeJS.Timeout | null = null;
      const control = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new StepTimeoutError());
        }, stepDeadlineMs);
        heartbeatTimer = setInterval(() => {
          const state = this.queue.heartbeat(claim.id, this.workerId);
          if (state === "ok") return;
          controller.abort();
          reject(
            state === "cancel_requested"
              ? new StepCancelledError()
              : new LeaseLostError(),
          );
        }, this.heartbeatIntervalMs);
      });

      try {
        const output = await Promise.race([
          this.executor.execute({
            runId: claim.id,
            matterId: claim.matterId,
            userId: claim.userId,
            stepId: String(step.id),
            stepKey: String(step.step_key),
            handler: String(step.handler),
            workflow: claim.workflow,
            modelProfile: claim.modelProfile,
            attempt: Number(step.attempt_count),
            input: step.input as Record<string, unknown>,
            signal: controller.signal,
          }),
          control,
        ]);
        this.queue.completeStep(
          claim.id,
          String(step.id),
          this.workerId,
          output,
          Date.now() - started,
        );
      } catch (error) {
        if (error instanceof StepCancelledError) {
          this.queue.finishCancelled(claim.id, this.workerId);
          return true;
        }
        if (error instanceof LeaseLostError) return true;
        const outcome = this.queue.failStep(
          claim.id,
          String(step.id),
          this.workerId,
          error,
          error instanceof StepTimeoutError ? "STEP_TIMEOUT" : "STEP_ERROR",
        );
        if (outcome === "retry" || outcome === "terminal" || outcome === "lost")
          return true;
      } finally {
        if (this.activeController === controller) this.activeController = null;
        if (timeout) clearTimeout(timeout);
        if (heartbeatTimer) clearInterval(heartbeatTimer);
      }
    }
    return true;
  }

  private async tick() {
    if (this.stopped || this.ticking) return;
    this.ticking = true;
    try {
      while (!this.stopped && (await this.runOnce())) {
        // Drain immediately available local work before returning to polling.
      }
    } finally {
      this.ticking = false;
    }
  }
}
