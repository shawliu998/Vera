import {
  deferAgentTaskForProvider,
  getAgentTaskSnapshot,
  readAgentTaskRetryCheckpoint,
  recordAgentTaskRetryCheckpoint,
  stopAgentTask,
} from "./agentTasks";
import {
  providerPauseClassificationForRetry,
  providerPauseSummary,
  type AgentTaskExecutionPauseClassification,
  type AgentTaskRetryCheckpoint,
} from "./agent-kernel/outcomes/executionOutcome";
import {
  advanceAgentTaskExecution,
  agentTaskExecutionErrorMessage,
} from "./agentTaskExecution";
import {
  MAX_AGENT_TASK_TRANSIENT_RETRIES,
  MAX_AGENT_TASK_TRANSIENT_WAIT_MS,
  agentTaskRetryBaseMs,
  calculateAgentTaskBackoffMs,
  classifyAgentTaskError,
  classifyAgentTaskProviderProtocolError,
  parseRetryAfterMs,
  type TransientAgentTaskError,
} from "./agentTaskRetryPolicy";
import { createServerSupabase } from "./supabase";

const ACTIVE_STATUSES = ["queued", "running", "verifying"] as const;

export {
  calculateAgentTaskBackoffMs,
  classifyAgentTaskError,
  parseRetryAfterMs,
  type TransientAgentTaskError,
} from "./agentTaskRetryPolicy";

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

type AgentTaskRunnerDependencies = {
  loadTask: (job: AgentTaskRunnerJob) => Promise<RunnerTaskSnapshot | null>;
  runIteration: (job: AgentTaskRunnerJob) => Promise<RunnerTaskSnapshot | null>;
  recordRetry: (
    job: AgentTaskRunnerJob,
    retry: AgentTaskRetryCheckpoint,
  ) => Promise<RunnerTaskSnapshot | null>;
  failTask: (job: AgentTaskRunnerJob, summary: string) => Promise<void>;
  /** Optional only for legacy test seams; the production runner always binds it. */
  deferTask?: (
    job: AgentTaskRunnerJob,
    summary: string,
    classification: AgentTaskExecutionPauseClassification,
  ) => Promise<void>;
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
              Math.min(MAX_AGENT_TASK_TRANSIENT_WAIT_MS, retryAtMs - now()),
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
          const protocol = classifyAgentTaskProviderProtocolError(error);
          if (protocol) {
            const summary = providerPauseSummary("provider_protocol", 0);
            if (this.dependencies.deferTask) {
              await this.dependencies.deferTask(
                job,
                summary,
                protocol.classification,
              );
            } else {
              await this.dependencies.failTask(job, summary);
            }
            return;
          }
          await this.dependencies.failTask(
            job,
            agentTaskExecutionErrorMessage(error),
          );
          return;
        }
        if (retryAttempt >= MAX_AGENT_TASK_TRANSIENT_RETRIES) {
          const classification = providerPauseClassificationForRetry(
            transient.classification,
          );
          const summary = providerPauseSummary(
            classification,
            MAX_AGENT_TASK_TRANSIENT_RETRIES,
          );
          if (this.dependencies.deferTask) {
            await this.dependencies.deferTask(job, summary, classification);
          } else {
            await this.dependencies.failTask(job, summary);
          }
          return;
        }
        retryAttempt += 1;
        const delayMs = calculateAgentTaskBackoffMs(retryAttempt, {
          retryAfterMs: transient.retryAfterMs,
          baseMs: agentTaskRetryBaseMs(transient.classification),
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
  deferTask: (job, summary, classification) =>
    deferAgentTaskForProvider(
      createServerSupabase(),
      job.taskId,
      job.userId,
      summary,
      { classification },
    ).then(() => {}),
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
