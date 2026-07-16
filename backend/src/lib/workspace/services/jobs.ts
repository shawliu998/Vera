import { randomUUID } from "node:crypto";

import { safeErrorMessage } from "../../safeError";
import {
  canReuseCompletedJob,
  projectWorkspaceJobForLogs,
} from "../jobs/stateMachine";
import {
  PROJECT_INFERENCE_JOB_TYPES,
  type ProjectInferenceScopeResolver,
  type WorkspaceInferenceActivityScope,
  type WorkspaceJobEvent,
  type WorkspaceJobType,
} from "../jobs/types";
import {
  DuplicateWorkspaceJobError,
  FinishWorkspaceJobClaimInput,
  WorkspaceJobsRepository,
  WorkspaceJobLeaseLostError,
  WorkspaceJobsRepositoryError,
  WorkspaceJobConflictError,
  type RenewWorkspaceJobClaimLeaseInput,
  type CreateWorkspaceStoredJobInput,
  type WorkspaceJobResourceType,
  type WorkspaceJobStoredRecord,
} from "../repositories/jobs";
import { WorkspaceIdSchema } from "../workspacePersistencePrimitivesV1";

export type WorkspaceJobExecutionClaim = Readonly<{
  leaseOwner: string;
  attempt: number;
}>;

export type HandlerSignalContext = {
  signal: AbortSignal;
  job: WorkspaceJobStoredRecord;
  claim?: WorkspaceJobExecutionClaim;
};

export type WorkspaceJobHandler = (
  context: HandlerSignalContext,
) => Promise<unknown> | unknown;

export type WorkspaceJobHandlers = Partial<
  Record<WorkspaceJobType, WorkspaceJobHandler>
>;

export interface CreateWorkspaceJobServiceInput {
  type: WorkspaceJobType;
  payload: unknown;
  resourceType: WorkspaceJobResourceType;
  resourceId: string;
  maxAttempts?: number;
  idempotencyKey?: string | null;
  priority?: number;
  scheduledAt?: string;
}

export interface TransactionlessWorkspaceJobEnqueueInput {
  id: string;
  type: WorkspaceJobType;
  payload: unknown;
  resourceType: WorkspaceJobResourceType;
  resourceId: string;
  maxAttempts: number;
  now: string;
  idempotencyKey?: string | null;
  priority?: number;
  queuedAt?: string;
}

export interface CreateWorkspaceJobServiceResult {
  job: WorkspaceJobStoredRecord;
  created: boolean;
}

export interface WorkspaceJobsServiceOptions {
  now?: () => Date;
  createId?: () => string;
  abortRegistry?: WorkspaceJobAbortRegistry;
  inferenceScopeResolver?: ProjectInferenceScopeResolver;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function invariant(message: string): never {
  throw new WorkspaceJobsRepositoryError(message);
}

function assertTimestamp(value: string, name: string): string {
  if (!value.trim() || Number.isNaN(Date.parse(value))) {
    invariant(`${name} must be a valid timestamp.`);
  }
  return value;
}

function assertMaxAttempts(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 100) {
    invariant("maxAttempts must be an integer between 1 and 100.");
  }
  return value;
}

function assertUuid(value: string, name: string): string {
  if (!UUID_PATTERN.test(value)) {
    invariant(`${name} must be a UUID.`);
  }
  return value;
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`);
  return `{${entries.join(",")}}`;
}

function isAbortLike(error: unknown): boolean {
  if (error instanceof Error) {
    return error.name === "AbortError" || /aborted|abort/i.test(error.message);
  }
  return false;
}

function structuredHandlerError(error: unknown) {
  if (error === null || typeof error !== "object") return null;
  const record = error as Record<string, unknown>;
  if (typeof record.message !== "string") return null;
  return {
    code:
      typeof record.code === "string" && record.code.trim()
        ? record.code.trim()
        : "workspace_job_failed",
    message: record.message,
    retryable: record.retryable === true,
    details: record.details,
  };
}

function normalizeOptionalIdempotencyKey(value: string | null | undefined) {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

type IdempotentCompatibilityInput = {
  type: WorkspaceJobType;
  resourceType: WorkspaceJobResourceType;
  resourceId: string;
  payload: unknown;
  maxAttempts: number;
  idempotencyKey: string;
};

function assertCompatibleIdempotentJob(
  existing: WorkspaceJobStoredRecord,
  input: IdempotentCompatibilityInput,
) {
  if (
    existing.type !== input.type ||
    existing.resourceType !== input.resourceType ||
    existing.resourceId !== input.resourceId ||
    existing.maxAttempts !== input.maxAttempts ||
    canonicalize(existing.payload) !== canonicalize(input.payload)
  ) {
    throw new WorkspaceJobConflictError(
      "Workspace job idempotencyKey conflicts with a different job configuration.",
    );
  }
}

function transitionCancelReason(
  job: WorkspaceJobStoredRecord,
  fallback = "Workspace job cancellation requested.",
) {
  return job.cancellationReason ?? job.cancellation?.reason ?? fallback;
}

export class WorkspaceJobAbortRegistry {
  private readonly entries = new Map<
    string,
    Map<AbortController, WorkspaceInferenceActivityScope | null>
  >();

  /**
   * Read-only execution snapshot for transaction-local policy checks. The
   * caller receives copied frozen scope values, never AbortControllers or the
   * live registry map.
   */
  activeInferenceScopes(): readonly WorkspaceInferenceActivityScope[] {
    return [...this.entries.values()]
      .flatMap((entries) => [...entries.values()])
      .filter(
        (scope): scope is WorkspaceInferenceActivityScope => scope !== null,
      )
      .map((scope) => Object.freeze({ ...scope }));
  }

  register(
    jobId: string,
    controller: AbortController,
    activityScope: WorkspaceInferenceActivityScope | null = null,
  ): void {
    const entries =
      this.entries.get(jobId) ??
      new Map<AbortController, WorkspaceInferenceActivityScope | null>();
    entries.set(controller, activityScope);
    this.entries.set(jobId, entries);
  }

  unregister(jobId: string, controller: AbortController): void {
    const entries = this.entries.get(jobId);
    if (!entries) return;
    entries.delete(controller);
    if (entries.size === 0) this.entries.delete(jobId);
  }

  abort(jobId: string): boolean {
    const entries = this.entries.get(jobId);
    if (!entries || entries.size === 0) return false;
    for (const controller of entries.keys()) controller.abort();
    return true;
  }

  abortAll(): void {
    // Aborting is not execution completion. Keep every scope registered until
    // its handler's controller-identity finally block independently unwinds.
    for (const entries of this.entries.values()) {
      for (const controller of entries.keys()) controller.abort();
    }
  }
}

export class WorkspaceJobsService {
  constructor(
    readonly repository: WorkspaceJobsRepository,
    private readonly options: WorkspaceJobsServiceOptions = {},
  ) {}

  private now() {
    return (this.options.now ?? (() => new Date()))().toISOString();
  }

  private createId() {
    return assertUuid((this.options.createId ?? randomUUID)(), "job id");
  }

  private normalizedTabularCompatibilityInput(
    input:
      | CreateWorkspaceJobServiceInput
      | TransactionlessWorkspaceJobEnqueueInput,
  ): IdempotentCompatibilityInput | null {
    const idempotencyKey = normalizeOptionalIdempotencyKey(
      input.idempotencyKey,
    );
    if (input.type !== "tabular_cell") {
      if (idempotencyKey !== null) {
        invariant("Only tabular_cell jobs may provide an idempotencyKey.");
      }
      return null;
    }
    if (idempotencyKey === null) {
      invariant("tabular_cell jobs require a stable idempotencyKey.");
    }
    return {
      type: input.type,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      payload: input.payload,
      maxAttempts: assertMaxAttempts(input.maxAttempts ?? 3),
      idempotencyKey,
    };
  }

  private preparedInputFromPublic(
    input: CreateWorkspaceJobServiceInput,
  ): CreateWorkspaceStoredJobInput {
    assertUuid(input.resourceId, "resourceId");
    const createdAt = this.now();
    const maxAttempts = assertMaxAttempts(input.maxAttempts ?? 3);
    const scheduledAt = input.scheduledAt ?? createdAt;
    return {
      job: this.repository.toRecord({
        id: this.createId(),
        type: input.type,
        payload: input.payload,
        maxAttempts,
        createdAt,
        idempotencyKey: normalizeOptionalIdempotencyKey(input.idempotencyKey),
      }),
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      priority: input.priority,
      scheduledAt,
      queuedAt: scheduledAt,
    };
  }

  private preparedInputFromPort(
    input: TransactionlessWorkspaceJobEnqueueInput,
  ): CreateWorkspaceStoredJobInput {
    assertUuid(input.id, "job id");
    assertUuid(input.resourceId, "resourceId");
    const createdAt = assertTimestamp(input.now, "now");
    const maxAttempts = assertMaxAttempts(input.maxAttempts);
    const queuedAt = input.queuedAt ?? createdAt;
    const idempotencyKey =
      input.type === "tabular_cell"
        ? (this.normalizedTabularCompatibilityInput(input)?.idempotencyKey ??
          null)
        : null;
    return {
      job: this.repository.toRecord({
        id: input.id,
        type: input.type,
        payload: input.payload,
        maxAttempts,
        createdAt,
        idempotencyKey,
      }),
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      priority: input.priority,
      scheduledAt: queuedAt,
      queuedAt,
    };
  }

  private reuseOrConflictForTabular(
    compatibility: IdempotentCompatibilityInput | null,
    existing: WorkspaceJobStoredRecord,
  ): WorkspaceJobStoredRecord {
    if (compatibility === null) return existing;
    assertCompatibleIdempotentJob(existing, compatibility);
    return existing;
  }

  prepareCreateJob(input: CreateWorkspaceJobServiceInput) {
    this.normalizedTabularCompatibilityInput(input);
    return this.preparedInputFromPublic(input);
  }

  preparePortJob(input: TransactionlessWorkspaceJobEnqueueInput) {
    if (input.type === "workflow_run") {
      assertUuid(input.resourceId, "resourceId");
      assertTimestamp(input.now, "now");
      assertMaxAttempts(input.maxAttempts);
      return this.preparedInputFromPort({
        ...input,
        idempotencyKey: null,
      });
    }
    this.normalizedTabularCompatibilityInput(input);
    return this.preparedInputFromPort(input);
  }

  enqueuePreparedJob(
    prepared: CreateWorkspaceStoredJobInput,
  ): WorkspaceJobStoredRecord {
    return this.repository.insertPreparedJob(prepared);
  }

  enqueueJobInCurrentTransaction(
    input: TransactionlessWorkspaceJobEnqueueInput,
  ): WorkspaceJobStoredRecord {
    const compatibility =
      input.type === "workflow_run"
        ? null
        : this.normalizedTabularCompatibilityInput(input);
    if (compatibility) {
      const existing = this.repository.getJobByIdempotencyKey(
        compatibility.idempotencyKey,
      );
      if (existing) {
        return this.reuseOrConflictForTabular(compatibility, existing);
      }
    }
    const prepared = this.preparePortJob(input);
    try {
      return this.repository.insertPreparedJob(prepared);
    } catch (error) {
      if (
        error instanceof DuplicateWorkspaceJobError &&
        compatibility !== null
      ) {
        const existing = this.repository.getJobByIdempotencyKey(
          compatibility.idempotencyKey,
        );
        if (!existing) throw error;
        return this.reuseOrConflictForTabular(compatibility, existing);
      }
      throw error;
    }
  }

  createJob(
    input: CreateWorkspaceJobServiceInput,
  ): CreateWorkspaceJobServiceResult {
    const compatibility = this.normalizedTabularCompatibilityInput(input);
    if (compatibility) {
      const existing = this.repository.getJobByIdempotencyKey(
        compatibility.idempotencyKey,
      );
      if (existing) {
        const reusable = this.reuseOrConflictForTabular(
          compatibility,
          existing,
        );
        if (
          reusable.status === "complete" &&
          canReuseCompletedJob(
            reusable,
            compatibility.type,
            compatibility.idempotencyKey,
          )
        ) {
          return { job: reusable, created: false };
        }
        return { job: reusable, created: false };
      }
    }
    const prepared = this.preparedInputFromPublic(input);
    try {
      return {
        job: this.repository.createJob(prepared),
        created: true,
      };
    } catch (error) {
      if (
        error instanceof DuplicateWorkspaceJobError &&
        compatibility !== null
      ) {
        const existing = this.repository.getJobByIdempotencyKey(
          compatibility.idempotencyKey,
        );
        if (!existing) throw error;
        return {
          job: this.reuseOrConflictForTabular(compatibility, existing),
          created: false,
        };
      }
      throw error;
    }
  }

  getJob(id: string) {
    return this.repository.getJob(id);
  }

  listJobs(input?: Parameters<WorkspaceJobsRepository["listJobs"]>[0]) {
    return this.repository.listJobs(input);
  }

  transitionJobInCurrentTransaction(id: string, event: WorkspaceJobEvent) {
    return this.repository.transitionJobInCurrentTransaction(id, event);
  }

  retryJob(id: string) {
    return this.repository.retryJob(id, this.now());
  }

  requestCancellation(id: string, reason?: string | null) {
    const job = this.repository.requestCancellation(id, this.now(), reason);
    if (job.status === "running" && job.cancelRequestedAt) {
      this.options.abortRegistry?.abort(job.id);
    }
    return job;
  }

  /**
   * Used only after a feature service has atomically persisted its own
   * cancelled state together with the Jobs transition.
   */
  abortActiveJob(id: string): boolean {
    return this.options.abortRegistry?.abort(id) ?? false;
  }

  recoverRunningJobs(at?: string) {
    return this.repository.recoverRunningJobs(
      assertTimestamp(at ?? this.now(), "at"),
    );
  }

  recoverStaleRunningJobs(at?: string) {
    return this.repository.recoverStaleRunningJobs(
      assertTimestamp(at ?? this.now(), "at"),
    );
  }

  renewClaimLease(input: RenewWorkspaceJobClaimLeaseInput) {
    return this.repository.renewClaimLease({
      ...input,
      at: assertTimestamp(input.at, "at"),
      leaseExpiresAt: assertTimestamp(input.leaseExpiresAt, "leaseExpiresAt"),
    });
  }

  finishClaim(input: FinishWorkspaceJobClaimInput) {
    return this.repository.finishClaim(input);
  }
}

export class WorkspaceJobRuntime {
  private readonly inFlight = new Set<Promise<WorkspaceJobStoredRecord>>();
  private readonly processCleanup = () => {
    this.abortRegistry.abortAll();
  };
  private readonly leaseOwner: string;
  private readonly leaseDurationMs: number;
  private readonly manageProcessSignals: boolean;
  private readonly mode: "legacy" | "fenced";
  private readonly allowedJobTypes: readonly WorkspaceJobType[] | null;
  private readonly timer: {
    setTimeout(callback: () => void, delayMs: number): { cancel(): void };
  };
  private started = false;
  private stopping = false;

  constructor(
    private readonly repository: WorkspaceJobsRepository,
    private readonly handlers: WorkspaceJobHandlers,
    private readonly options: WorkspaceJobsServiceOptions & {
      leaseDurationMs?: number;
      leaseOwner?: string;
      manageProcessSignals?: boolean;
      recoveryMode?: "legacy" | "fenced";
      allowedJobTypes?: readonly WorkspaceJobType[];
      timer?: {
        setTimeout(callback: () => void, delayMs: number): { cancel(): void };
      };
    } = {},
  ) {
    this.leaseOwner =
      options.leaseOwner?.trim() || `workspace-job-runtime:${randomUUID()}`;
    this.leaseDurationMs = options.leaseDurationMs ?? 5 * 60 * 1000;
    this.manageProcessSignals = options.manageProcessSignals ?? true;
    this.mode = options.recoveryMode ?? "legacy";
    this.allowedJobTypes =
      options.allowedJobTypes === undefined
        ? null
        : [...new Set(options.allowedJobTypes)];
    if (this.allowedJobTypes !== null && this.allowedJobTypes.length === 0) {
      invariant(
        "allowedJobTypes must contain at least one workspace job type.",
      );
    }
    this.timer = options.timer ?? {
      setTimeout(callback, delayMs) {
        const handle = setTimeout(callback, delayMs);
        return {
          cancel() {
            clearTimeout(handle);
          },
        };
      },
    };
  }

  private get abortRegistry() {
    return this.options.abortRegistry ?? this.localAbortRegistry;
  }

  private readonly localAbortRegistry = new WorkspaceJobAbortRegistry();

  private nowDate() {
    return (this.options.now ?? (() => new Date()))();
  }

  private nowIso(date = this.nowDate()) {
    return date.toISOString();
  }

  private leaseExpiresAt(date: Date) {
    return new Date(date.getTime() + this.leaseDurationMs).toISOString();
  }

  private installProcessSignalHandlers() {
    if (!this.manageProcessSignals) return;
    process.on("beforeExit", this.processCleanup);
    process.on("SIGINT", this.processCleanup);
    process.on("SIGTERM", this.processCleanup);
  }

  private removeProcessSignalHandlers() {
    if (!this.manageProcessSignals) return;
    process.off("beforeExit", this.processCleanup);
    process.off("SIGINT", this.processCleanup);
    process.off("SIGTERM", this.processCleanup);
  }

  async start(): Promise<WorkspaceJobStoredRecord[]> {
    if (this.started) return [];
    const recovered =
      this.mode === "fenced"
        ? this.repository.recoverStaleRunningJobs(this.nowIso())
        : this.repository.recoverRunningJobs(this.nowIso());
    this.started = true;
    this.stopping = false;
    this.installProcessSignalHandlers();
    return recovered;
  }

  async stop(): Promise<void> {
    await this.stopWithTimeout(0);
  }

  async stopWithTimeout(timeoutMs: number): Promise<{ drained: boolean }> {
    if (!this.started && !this.stopping) {
      return { drained: true };
    }
    this.started = false;
    this.stopping = true;
    this.abortRegistry.abortAll();
    this.removeProcessSignalHandlers();
    const drainPromise = this.drain().finally(() => {
      this.stopping = false;
    });
    if (timeoutMs <= 0) {
      await drainPromise;
      return { drained: true };
    }
    const timedOut = await new Promise<boolean>((resolve) => {
      let settled = false;
      const handle = this.timer.setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(true);
      }, timeoutMs);
      drainPromise.then(
        () => {
          if (settled) return;
          settled = true;
          handle.cancel();
          resolve(false);
        },
        () => {
          if (settled) return;
          settled = true;
          handle.cancel();
          resolve(false);
        },
      );
    });
    if (timedOut) return { drained: false };
    await drainPromise;
    return { drained: true };
  }

  async drain(): Promise<void> {
    await Promise.all([...this.inFlight]);
  }

  async claimAndRun(
    signal?: AbortSignal,
  ): Promise<WorkspaceJobStoredRecord | null> {
    if (!this.started) {
      invariant("Workspace job runtime is not started.");
    }
    if (signal?.aborted) return null;
    const claimTime = this.nowDate();
    // A lease that was still valid during startup can outlive its former
    // process for a short period. Re-check stale claims before every fenced
    // claim so those jobs become eligible as soon as the lease expires,
    // instead of remaining `running` until the next application restart.
    if (this.mode === "fenced") {
      this.repository.recoverStaleRunningJobs(this.nowIso(claimTime));
    }
    const claimed =
      this.allowedJobTypes === null
        ? this.repository.claimNextQueued(
            this.nowIso(claimTime),
            this.leaseOwner,
            this.leaseExpiresAt(claimTime),
          )
        : this.repository.claimNextQueuedForTypes(
            this.nowIso(claimTime),
            this.allowedJobTypes,
            this.leaseOwner,
            this.leaseExpiresAt(claimTime),
          );
    if (!claimed) return null;
    const claim =
      this.mode === "fenced"
        ? {
            id: claimed.id,
            leaseOwner: claimed.leaseOwner ?? this.leaseOwner,
            attempt: claimed.attempt,
          }
        : null;
    const task = this.runClaimedJob(claimed, signal, claim);
    this.inFlight.add(task);
    try {
      return await task;
    } finally {
      this.inFlight.delete(task);
    }
  }

  private heartbeatIntervalMs() {
    // Lease renewal must happen by leaseDuration/3, while cancellation from a
    // different database handle should become observable promptly in the
    // desktop UI. A one-second ceiling satisfies both without a second timer.
    return Math.max(1, Math.min(1_000, Math.floor(this.leaseDurationMs / 3)));
  }

  private startHeartbeat(
    claim: {
      id: string;
      leaseOwner: string;
      attempt: number;
    } | null,
    controller: AbortController,
  ) {
    if (claim === null) {
      return () => {};
    }
    let cancelled = false;
    let handle: { cancel(): void } | null = null;
    const tick = async () => {
      if (cancelled || controller.signal.aborted || this.stopping) return;
      try {
        const now = this.nowDate();
        const renewed = this.repository.renewClaimLease({
          id: claim.id,
          leaseOwner: claim.leaseOwner,
          attempt: claim.attempt,
          at: this.nowIso(now),
          leaseExpiresAt: this.leaseExpiresAt(now),
        });
        if (renewed.cancelRequestedAt) {
          controller.abort();
          return;
        }
      } catch {
        controller.abort();
        return;
      }
      handle = this.timer.setTimeout(() => {
        void tick();
      }, this.heartbeatIntervalMs());
    };
    handle = this.timer.setTimeout(() => {
      void tick();
    }, this.heartbeatIntervalMs());
    return () => {
      cancelled = true;
      handle?.cancel();
    };
  }

  private finishEvent(
    claimed: WorkspaceJobStoredRecord,
    claim: {
      id: string;
      leaseOwner: string;
      attempt: number;
    } | null,
    event: WorkspaceJobEvent,
  ): WorkspaceJobStoredRecord {
    if (claim === null) {
      return this.repository.persistTransition(claimed.id, event);
    }
    try {
      return this.repository.finishClaim({
        id: claimed.id,
        leaseOwner: claim.leaseOwner,
        attempt: claim.attempt,
        event,
      });
    } catch (error) {
      if (error instanceof WorkspaceJobLeaseLostError) {
        return this.repository.getJob(claimed.id) ?? claimed;
      }
      throw error;
    }
  }

  private abortEvent(
    claimed: WorkspaceJobStoredRecord,
    current: WorkspaceJobStoredRecord | null,
    error: unknown,
  ): WorkspaceJobEvent {
    if (current?.status === "running" && current.cancelRequestedAt) {
      return {
        type: "cancel",
        at: this.nowIso(),
        reason: transitionCancelReason(current),
      };
    }
    return {
      type: "interrupt",
      at: this.nowIso(),
      error: {
        code: "workspace_job_aborted",
        message: safeErrorMessage(
          error,
          "Workspace job execution was aborted.",
        ),
        retryable: true,
        details: { aborted: true, type: claimed.type },
      },
    };
  }

  private inferenceActivityScope(
    claimed: WorkspaceJobStoredRecord,
  ): WorkspaceInferenceActivityScope | null {
    const inferenceType = PROJECT_INFERENCE_JOB_TYPES.find(
      (type) => type === claimed.type,
    );
    if (!inferenceType) return null;
    const unresolved = (): WorkspaceInferenceActivityScope =>
      Object.freeze({
        jobId: claimed.id,
        type: inferenceType,
        scope: "unresolved" as const,
        projectId: null,
      });
    try {
      const resolved = this.options.inferenceScopeResolver?.(claimed);
      if (
        resolved === undefined ||
        resolved === null ||
        resolved.jobId !== claimed.id ||
        resolved.type !== inferenceType ||
        !WorkspaceIdSchema.safeParse(resolved.jobId).success ||
        (resolved.scope === "project"
          ? !WorkspaceIdSchema.safeParse(resolved.projectId).success
          : (resolved.scope !== "global" && resolved.scope !== "unresolved") ||
            resolved.projectId !== null)
      ) {
        return unresolved();
      }
      return Object.freeze({ ...resolved });
    } catch {
      return unresolved();
    }
  }

  private async runClaimedJob(
    claimed: WorkspaceJobStoredRecord,
    externalSignal?: AbortSignal,
    claim: {
      id: string;
      leaseOwner: string;
      attempt: number;
    } | null = null,
  ): Promise<WorkspaceJobStoredRecord> {
    const handler = this.handlers[claimed.type];
    if (!handler) {
      return this.finishEvent(claimed, claim, {
        type: "fail",
        at: this.nowIso(),
        error: {
          code: "workspace_job_handler_missing",
          message: `No runtime handler is registered for ${claimed.type}.`,
          retryable: false,
          details: { type: claimed.type },
        },
      });
    }
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (externalSignal?.aborted) {
      controller.abort();
    } else {
      externalSignal?.addEventListener("abort", onAbort, { once: true });
    }
    // Scope resolution is deliberately synchronous and precedes registration;
    // a resolver failure becomes an unresolved fail-closed entry rather than
    // opening an untracked provider-execution window.
    const activityScope = this.inferenceActivityScope(claimed);
    this.abortRegistry.register(claimed.id, controller, activityScope);
    const stopHeartbeat = this.startHeartbeat(claim, controller);
    try {
      if (controller.signal.aborted) {
        return this.finishEvent(
          claimed,
          claim,
          this.abortEvent(
            claimed,
            this.repository.getJob(claimed.id),
            new Error("aborted"),
          ),
        );
      }
      const result = await handler({
        signal: controller.signal,
        job: claimed,
        ...(claim === null
          ? {}
          : {
              claim: {
                leaseOwner: claim.leaseOwner,
                attempt: claim.attempt,
              },
            }),
      });
      const current = this.repository.getJob(claimed.id);
      if (controller.signal.aborted) {
        return this.finishEvent(
          claimed,
          claim,
          this.abortEvent(claimed, current, new Error("aborted")),
        );
      }
      if (current?.status === "running" && current.cancelRequestedAt) {
        controller.abort();
        return this.finishEvent(
          claimed,
          claim,
          this.abortEvent(claimed, current, new Error("aborted")),
        );
      }
      return this.finishEvent(claimed, claim, {
        type: "complete",
        at: this.nowIso(),
        result,
      });
    } catch (error) {
      const current = this.repository.getJob(claimed.id);
      if (controller.signal.aborted) {
        return this.finishEvent(
          claimed,
          claim,
          this.abortEvent(claimed, current, error),
        );
      }
      return this.finishEvent(claimed, claim, {
        type: isAbortLike(error) ? "interrupt" : "fail",
        at: this.nowIso(),
        error: {
          code:
            structuredHandlerError(error)?.code ??
            (isAbortLike(error)
              ? "workspace_job_aborted"
              : "workspace_job_failed"),
          message: safeErrorMessage(
            structuredHandlerError(error)?.message ?? error,
            isAbortLike(error)
              ? "Workspace job execution was aborted."
              : "Workspace job execution failed.",
          ),
          retryable:
            structuredHandlerError(error)?.retryable ?? isAbortLike(error),
          details:
            structuredHandlerError(error)?.details ??
            projectWorkspaceJobForLogs(claimed).payload,
        },
      });
    } finally {
      stopHeartbeat();
      externalSignal?.removeEventListener("abort", onAbort);
      this.abortRegistry.unregister(claimed.id, controller);
    }
  }
}
