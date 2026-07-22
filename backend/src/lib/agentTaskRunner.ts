import {
  getAgentTaskSnapshot,
  readAgentTaskRetryCheckpoint,
  recordAgentTaskRetryCheckpoint,
  stopAgentTask,
  type AgentTaskRetryCheckpoint,
} from "./agentTasks";
import {
  advanceAgentTaskExecution,
  agentTaskExecutionErrorMessage,
} from "./agentTaskExecution";
import { isTransientModelError } from "./agentStepExecutor";
import { createServerSupabase } from "./supabase";

const ACTIVE_STATUSES = ["queued", "running", "verifying"] as const;
const MAX_TRANSIENT_RETRY_ATTEMPTS = 3;
const MAX_TRANSIENT_RETRY_WAIT_MS = 60_000;

export type AgentTaskRunnerJob = {
  taskId: string;
  userId: string;
  userEmail?: string;
};

type RunnerTaskSnapshot = {
  task: {
    status: string;
    latest_checkpoint?: unknown;
  };
};

export type TransientAgentTaskError = {
  classification: AgentTaskRetryCheckpoint["classification"];
  retryAfterMs: number | null;
};

function numericStatus(error: unknown) {
  if (!error || typeof error !== "object") return null;
  const row = error as {
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown };
  };
  for (const value of [row.status, row.statusCode, row.response?.status]) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
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
      const value = getter.call(headers, "retry-after");
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    const record = headers as Record<string, unknown>;
    const value = record["retry-after"] ?? record["Retry-After"];
    if (typeof value === "string" || typeof value === "number") {
      return String(value);
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  return message.match(/retry-after\s*[:=]\s*([^\s,;]+)/i)?.[1] ?? null;
}

export function parseRetryAfterMs(value: string | null, nowMs: number) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const dateMs = Date.parse(value);
  if (Number.isNaN(dateMs)) return null;
  return Math.max(0, dateMs - nowMs);
}

export function classifyAgentTaskError(
  error: unknown,
  nowMs = Date.now(),
): TransientAgentTaskError | null {
  const status = numericStatus(error);
  if (status && [400, 401, 403, 404, 405, 409, 422].includes(status)) {
    return null;
  }
  const message = error instanceof Error ? error.message : String(error);
  const transient =
    status === 429 || status === 503 || isTransientModelError(error);
  if (!transient) return null;
  const retryAfterMs = parseRetryAfterMs(retryAfterHeader(error), nowMs);
  const classification: TransientAgentTaskError["classification"] =
    status === 429 || /\b429\b|rate.?limit|throttl/i.test(message)
      ? "rate_limit"
      : status === 503 ||
          /\b503\b|overloaded|queue|resource exhausted/i.test(message)
        ? "provider_unavailable"
        : "network";
  return { classification, retryAfterMs };
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
  const maxMs = options.maxMs ?? MAX_TRANSIENT_RETRY_WAIT_MS;
  if (options.retryAfterMs != null) {
    return Math.max(0, Math.min(maxMs, Math.round(options.retryAfterMs)));
  }
  const baseMs = options.baseMs ?? 2_000;
  const jitterRatio = options.jitterRatio ?? 0.2;
  const random = options.random ?? Math.random;
  const exponential = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  const factor = 1 - jitterRatio + random() * jitterRatio * 2;
  return Math.max(0, Math.min(maxMs, Math.round(exponential * factor)));
}

type AgentTaskRunnerDependencies = {
  loadTask: (job: AgentTaskRunnerJob) => Promise<RunnerTaskSnapshot | null>;
  runIteration: (job: AgentTaskRunnerJob) => Promise<RunnerTaskSnapshot | null>;
  recordRetry: (
    job: AgentTaskRunnerJob,
    retry: AgentTaskRetryCheckpoint,
  ) => Promise<RunnerTaskSnapshot | null>;
  failTask: (job: AgentTaskRunnerJob, summary: string) => Promise<void>;
  recoverJobs: () => Promise<AgentTaskRunnerJob[]>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
};

export class AgentTaskRunner {
  private readonly queued = new Map<string, AgentTaskRunnerJob>();
  private readonly cancelled = new Set<string>();
  private runningTaskId: string | null = null;
  private pumpPromise: Promise<void> | null = null;

  constructor(private readonly dependencies: AgentTaskRunnerDependencies) {}

  wake(job: AgentTaskRunnerJob) {
    this.cancelled.delete(job.taskId);
    if (this.runningTaskId === job.taskId || this.queued.has(job.taskId)) {
      return false;
    }
    this.queued.set(job.taskId, job);
    this.ensurePump();
    return true;
  }

  cancel(taskId: string) {
    this.queued.delete(taskId);
    this.cancelled.add(taskId);
  }

  async recover() {
    const jobs = await this.dependencies.recoverJobs();
    for (const job of jobs) this.wake(job);
    await this.waitForIdle();
  }

  async waitForIdle() {
    while (this.pumpPromise) await this.pumpPromise;
  }

  private ensurePump() {
    if (this.pumpPromise) return;
    this.pumpPromise = this.pump().finally(() => {
      this.pumpPromise = null;
      if (this.queued.size) this.ensurePump();
    });
  }

  private async pump() {
    while (this.queued.size) {
      const first = this.queued.entries().next().value as
        | [string, AgentTaskRunnerJob]
        | undefined;
      if (!first) return;
      const [taskId, job] = first;
      this.queued.delete(taskId);
      if (this.cancelled.has(taskId)) continue;
      this.runningTaskId = taskId;
      try {
        await this.runJob(job);
      } finally {
        this.runningTaskId = null;
      }
    }
  }

  private async runJob(job: AgentTaskRunnerJob) {
    const sleep =
      this.dependencies.sleep ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const now = this.dependencies.now ?? Date.now;
    let snapshot = await this.dependencies.loadTask(job);
    let retryAttempt = snapshot
      ? (readAgentTaskRetryCheckpoint(snapshot.task)?.attempt ?? 0)
      : 0;

    while (
      snapshot &&
      ACTIVE_STATUSES.includes(
        snapshot.task.status as (typeof ACTIVE_STATUSES)[number],
      ) &&
      !this.cancelled.has(job.taskId)
    ) {
      const persistedRetry = readAgentTaskRetryCheckpoint(snapshot.task);
      if (persistedRetry) {
        const retryAtMs = Date.parse(persistedRetry.retry_at);
        const waitMs = Number.isNaN(retryAtMs)
          ? 0
          : Math.max(
              0,
              Math.min(MAX_TRANSIENT_RETRY_WAIT_MS, retryAtMs - now()),
            );
        if (waitMs > 0) await sleep(waitMs);
        if (this.cancelled.has(job.taskId)) return;
        snapshot = await this.dependencies.loadTask(job);
        if (
          !snapshot ||
          !ACTIVE_STATUSES.includes(snapshot.task.status as never)
        ) {
          return;
        }
      }

      try {
        snapshot = await this.dependencies.runIteration(job);
        retryAttempt = 0;
      } catch (error) {
        const transient = classifyAgentTaskError(error, now());
        if (!transient) {
          await this.dependencies.failTask(
            job,
            agentTaskExecutionErrorMessage(error),
          );
          return;
        }
        if (retryAttempt >= MAX_TRANSIENT_RETRY_ATTEMPTS) {
          await this.dependencies.failTask(
            job,
            `The selected model remained unavailable after ${MAX_TRANSIENT_RETRY_ATTEMPTS} automatic retries. Retry the current step when the provider is available.`,
          );
          return;
        }
        retryAttempt += 1;
        const delayMs = calculateAgentTaskBackoffMs(retryAttempt, {
          retryAfterMs: transient.retryAfterMs,
          random: this.dependencies.random,
        });
        const retry: AgentTaskRetryCheckpoint = {
          attempt: retryAttempt,
          retry_at: new Date(now() + delayMs).toISOString(),
          classification: transient.classification,
        };
        snapshot = await this.dependencies.recordRetry(job, retry);
        if (!snapshot) return;
      }
    }
  }
}

async function recoverAgentTaskJobs() {
  const db = createServerSupabase();
  const { data, error } = await db
    .from("agent_tasks")
    .select("id,user_id,status")
    .in("status", [...ACTIVE_STATUSES])
    .order("updated_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []).map((task) => ({
    taskId: task.id as string,
    userId: task.user_id as string,
  }));
}

export const agentTaskRunner = new AgentTaskRunner({
  loadTask: (job) =>
    getAgentTaskSnapshot(createServerSupabase(), job.taskId, job.userId),
  runIteration: (job) =>
    advanceAgentTaskExecution({
      db: createServerSupabase(),
      taskId: job.taskId,
      userId: job.userId,
      userEmail: job.userEmail,
    }),
  recordRetry: (job, retry) =>
    recordAgentTaskRetryCheckpoint(
      createServerSupabase(),
      job.taskId,
      job.userId,
      retry,
    ),
  failTask: async (job, summary) => {
    await stopAgentTask(createServerSupabase(), job.taskId, job.userId, {
      status: "failed",
      summary,
    });
  },
  recoverJobs: recoverAgentTaskJobs,
});

export function wakeAgentTaskRunner(job: AgentTaskRunnerJob) {
  return agentTaskRunner.wake(job);
}

export function cancelAgentTaskRunner(taskId: string) {
  agentTaskRunner.cancel(taskId);
}

export async function recoverAgentTaskRunner() {
  await agentTaskRunner.recover();
}
