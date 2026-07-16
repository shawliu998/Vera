import {
  WorkspaceJobAbortRegistry,
  WorkspaceJobsService,
  WorkspaceJobRuntime,
  type WorkspaceJobHandlers,
} from "../services/jobs";
import {
  WORKSPACE_JOB_TYPES,
  type ProjectInferenceScopeResolver,
  type WorkspaceJobType,
} from "../jobs/types";
import type { WorkspaceJobStoredRecord } from "../repositories/jobs";

export interface WorkspaceJobPumpTimerHandle {
  cancel(): void;
}

export interface WorkspaceJobPumpTimer {
  now(): Date;
  setTimeout(
    callback: () => void,
    delayMs: number,
  ): WorkspaceJobPumpTimerHandle;
}

export interface WorkspaceJobPumpCapabilities {
  leaseHeartbeatSupported: true;
  leaseTokenFencingSupported: true;
  notes: readonly string[];
}

export interface WorkspaceJobPumpOptions {
  jobs: WorkspaceJobsService;
  handlers: WorkspaceJobHandlers;
  abortRegistry: WorkspaceJobAbortRegistry;
  timer?: WorkspaceJobPumpTimer;
  concurrency?: number;
  idleBackoffMs?: number;
  maxIdleBackoffMs?: number;
  drainTimeoutMs?: number;
  leaseOwner?: string;
  leaseDurationMs?: number;
  inferenceScopeResolver?: ProjectInferenceScopeResolver;
}

export interface WorkspaceJobPumpStartResult {
  alreadyStarted: boolean;
  recoveredJobs: WorkspaceJobStoredRecord[];
  capabilities: WorkspaceJobPumpCapabilities;
}

export interface WorkspaceJobPumpStopResult {
  alreadyStopped: boolean;
  drained: boolean;
  timedOut: boolean;
  restartBlocked: boolean;
}

export interface WorkspaceJobPumpSnapshot {
  started: boolean;
  stopping: boolean;
  restartBlocked: boolean;
  activeWorkers: number;
  idleBackoffMs: number;
}

const DEFAULT_IDLE_BACKOFF_MS = 250;
const DEFAULT_MAX_IDLE_BACKOFF_MS = 5_000;
const DEFAULT_DRAIN_TIMEOUT_MS = 10_000;
const MAX_CONCURRENCY = 64;

const CAPABILITY_NOTES: readonly string[] = [];

function invariant(message: string): never {
  throw new Error(message);
}

function assertPositiveInteger(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    invariant(`${name} must be a positive integer.`);
  }
  return resolved;
}

function assertConcurrency(value: number | undefined): number {
  const resolved = assertPositiveInteger(value, 1, "concurrency");
  if (resolved > MAX_CONCURRENCY) {
    invariant(`concurrency must be ${MAX_CONCURRENCY} or lower.`);
  }
  return resolved;
}

function registeredHandlerTypes(
  handlers: WorkspaceJobHandlers,
): readonly WorkspaceJobType[] {
  const knownTypes = new Set<string>(WORKSPACE_JOB_TYPES);
  for (const [type, handler] of Object.entries(handlers)) {
    if (handler === undefined) continue;
    if (!knownTypes.has(type)) {
      invariant(`Unsupported workspace job handler type ${type}.`);
    }
    if (typeof handler !== "function") {
      invariant(`Workspace job handler ${type} must be a function.`);
    }
  }
  const registered = WORKSPACE_JOB_TYPES.filter(
    (type) => typeof handlers[type] === "function",
  );
  if (registered.length === 0) {
    invariant("Workspace job pump requires at least one registered handler.");
  }
  return registered;
}

function systemTimer(): WorkspaceJobPumpTimer {
  return {
    now: () => new Date(),
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

type IdleWaitState = {
  promise: Promise<void>;
  resolve: () => void;
  handle: WorkspaceJobPumpTimerHandle;
};

export class WorkspaceJobPump {
  readonly capabilities: WorkspaceJobPumpCapabilities = {
    leaseHeartbeatSupported: true,
    leaseTokenFencingSupported: true,
    notes: CAPABILITY_NOTES,
  };

  readonly runtime: WorkspaceJobRuntime;

  private readonly timer: WorkspaceJobPumpTimer;
  private readonly concurrency: number;
  private readonly idleBackoffMs: number;
  private readonly maxIdleBackoffMs: number;
  private readonly drainTimeoutMs: number;
  private readonly workerPromises = new Set<Promise<void>>();

  private startPromise: Promise<WorkspaceJobPumpStartResult> | null = null;
  private stopPromise: Promise<WorkspaceJobPumpStopResult> | null = null;
  private started = false;
  private stopping = false;
  private restartBlocked = false;
  private idleWait: IdleWaitState | null = null;
  private currentIdleBackoffMs: number;

  constructor(options: WorkspaceJobPumpOptions) {
    this.timer = options.timer ?? systemTimer();
    this.concurrency = assertConcurrency(options.concurrency);
    this.idleBackoffMs = assertPositiveInteger(
      options.idleBackoffMs,
      DEFAULT_IDLE_BACKOFF_MS,
      "idleBackoffMs",
    );
    this.maxIdleBackoffMs = assertPositiveInteger(
      options.maxIdleBackoffMs,
      DEFAULT_MAX_IDLE_BACKOFF_MS,
      "maxIdleBackoffMs",
    );
    if (this.maxIdleBackoffMs < this.idleBackoffMs) {
      invariant(
        "maxIdleBackoffMs must be greater than or equal to idleBackoffMs.",
      );
    }
    this.drainTimeoutMs = assertPositiveInteger(
      options.drainTimeoutMs,
      DEFAULT_DRAIN_TIMEOUT_MS,
      "drainTimeoutMs",
    );
    this.currentIdleBackoffMs = this.idleBackoffMs;
    const allowedJobTypes = registeredHandlerTypes(options.handlers);
    this.runtime = new WorkspaceJobRuntime(
      options.jobs.repository,
      options.handlers,
      {
        now: () => this.timer.now(),
        abortRegistry: options.abortRegistry,
        leaseOwner: options.leaseOwner,
        leaseDurationMs: options.leaseDurationMs,
        recoveryMode: "fenced",
        allowedJobTypes,
        inferenceScopeResolver: options.inferenceScopeResolver,
        manageProcessSignals: false,
        timer: this.timer,
      },
    );
  }

  snapshot(): WorkspaceJobPumpSnapshot {
    return {
      started: this.started,
      stopping: this.stopping,
      restartBlocked: this.restartBlocked,
      activeWorkers: this.workerPromises.size,
      idleBackoffMs: this.currentIdleBackoffMs,
    };
  }

  async start(): Promise<WorkspaceJobPumpStartResult> {
    if (this.restartBlocked) {
      invariant("Workspace job pump cannot restart after a timed-out stop.");
    }
    if (this.startPromise) return this.startPromise;
    if (this.started && !this.stopping) {
      return {
        alreadyStarted: true,
        recoveredJobs: [],
        capabilities: this.capabilities,
      };
    }
    this.startPromise = this.doStart();
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  private async doStart(): Promise<WorkspaceJobPumpStartResult> {
    this.stopping = false;
    const recoveredJobs = await this.runtime.start();
    this.started = true;
    this.currentIdleBackoffMs = this.idleBackoffMs;
    this.spawnWorkers();
    return {
      alreadyStarted: false,
      recoveredJobs,
      capabilities: this.capabilities,
    };
  }

  async stop(): Promise<WorkspaceJobPumpStopResult> {
    if (this.stopPromise) return this.stopPromise;
    if (!this.started && !this.stopping) {
      return {
        alreadyStopped: true,
        drained: true,
        timedOut: false,
        restartBlocked: this.restartBlocked,
      };
    }
    this.stopPromise = this.doStop();
    try {
      return await this.stopPromise;
    } finally {
      this.stopPromise = null;
    }
  }

  private async doStop(): Promise<WorkspaceJobPumpStopResult> {
    this.started = false;
    this.stopping = true;
    this.resolveIdleWait();
    const { drained } = await this.runtime.stopWithTimeout(this.drainTimeoutMs);
    this.stopping = false;
    this.resolveIdleWait();
    if (!drained) {
      this.restartBlocked = true;
    }
    return {
      alreadyStopped: false,
      drained,
      timedOut: !drained,
      restartBlocked: this.restartBlocked,
    };
  }

  private spawnWorkers(): void {
    while (
      this.started &&
      !this.stopping &&
      this.workerPromises.size < this.concurrency
    ) {
      const worker = this.runWorker().finally(() => {
        this.workerPromises.delete(worker);
        if (this.started && !this.stopping) {
          this.spawnWorkers();
        }
      });
      this.workerPromises.add(worker);
    }
  }

  private async runWorker(): Promise<void> {
    while (this.started && !this.stopping) {
      try {
        const result = await this.runtime.claimAndRun();
        if (!this.started || this.stopping) return;
        if (result === null) {
          await this.waitForIdleBackoff();
          continue;
        }
        this.resetIdleBackoff();
        this.resolveIdleWait();
      } catch {
        if (!this.started || this.stopping) return;
        await this.waitForIdleBackoff();
      }
    }
  }

  private resetIdleBackoff() {
    this.currentIdleBackoffMs = this.idleBackoffMs;
  }

  private async waitForIdleBackoff(): Promise<void> {
    if (this.idleWait) {
      await this.idleWait.promise;
      return;
    }
    const delayMs = this.currentIdleBackoffMs;
    const nextBackoff = Math.min(
      this.currentIdleBackoffMs * 2,
      this.maxIdleBackoffMs,
    );
    let resolveWait = () => {};
    const promise = new Promise<void>((resolve) => {
      resolveWait = resolve;
    });
    const handle = this.timer.setTimeout(() => {
      if (this.idleWait?.handle !== handle) return;
      this.idleWait = null;
      this.currentIdleBackoffMs = nextBackoff;
      resolveWait();
    }, delayMs);
    this.idleWait = {
      promise,
      resolve: () => {
        if (this.idleWait?.handle !== handle) return;
        handle.cancel();
        this.idleWait = null;
        resolveWait();
      },
      handle,
    };
    await promise;
  }

  private resolveIdleWait(): void {
    this.idleWait?.resolve();
  }
}

export function createWorkspaceJobPump(options: WorkspaceJobPumpOptions) {
  return new WorkspaceJobPump(options);
}
