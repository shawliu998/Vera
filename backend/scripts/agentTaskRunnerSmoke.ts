import assert from "node:assert/strict";
import {
  AgentTaskRunner,
  calculateAgentTaskBackoffMs,
  classifyAgentTaskError,
  parseRetryAfterMs,
  type AgentTaskRunnerJob,
} from "../src/lib/agentTaskRunner";

type FakeTask = {
  status: string;
  latest_checkpoint: unknown;
};

function snapshot(task: FakeTask) {
  return { task };
}

async function retryAndLifecycleSuite() {
  const tasks = new Map<string, FakeTask>([
    ["task_1", { status: "running", latest_checkpoint: null }],
  ]);
  let iterations = 0;
  let retryWrites = 0;
  let active = 0;
  let maxActive = 0;
  const sleeps: number[] = [];
  const runner = new AgentTaskRunner({
    loadTask: async (job) => {
      const task = tasks.get(job.taskId);
      return task ? snapshot(task) : null;
    },
    runIteration: async (job) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        iterations += 1;
        if (iterations <= 2) {
          const error = new Error("503 provider overloaded") as Error & {
            status: number;
          };
          error.status = 503;
          throw error;
        }
        const task = tasks.get(job.taskId)!;
        task.status = "completed";
        task.latest_checkpoint = null;
        return snapshot(task);
      } finally {
        active -= 1;
      }
    },
    recordRetry: async (job, retry) => {
      retryWrites += 1;
      const task = tasks.get(job.taskId)!;
      task.latest_checkpoint = {
        step_id: "step_1",
        iteration: 1,
        summary: "Model is busy. Retrying automatically.",
        created_at: new Date(0).toISOString(),
        runner_retry: retry,
      };
      return snapshot(task);
    },
    failTask: async (job) => {
      tasks.get(job.taskId)!.status = "failed";
    },
    recoverJobs: async () => [],
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => 0,
    random: () => 0.5,
  });

  const job = { taskId: "task_1", userId: "user_1" };
  assert.equal(runner.wake(job), true);
  assert.equal(
    runner.wake(job),
    false,
    "the same task must not be queued twice",
  );
  await runner.waitForIdle();
  assert.equal(
    iterations,
    3,
    "two transient failures must retry and then succeed",
  );
  assert.equal(retryWrites, 2);
  assert.deepEqual(sleeps, [2_000, 4_000]);
  assert.equal(maxActive, 1, "one task must never execute concurrently twice");
  assert.equal(tasks.get("task_1")?.status, "completed");
}

async function pauseResumeSuite() {
  const task: FakeTask = { status: "running", latest_checkpoint: null };
  let runs = 0;
  const runner = new AgentTaskRunner({
    loadTask: async () => snapshot(task),
    runIteration: async () => {
      runs += 1;
      task.status = runs === 1 ? "paused" : "completed";
      return snapshot(task);
    },
    recordRetry: async () => snapshot(task),
    failTask: async () => {
      task.status = "failed";
    },
    recoverJobs: async () => [],
    sleep: async () => undefined,
  });
  const job = { taskId: "task_pause", userId: "user_1" };
  runner.wake(job);
  await runner.waitForIdle();
  assert.equal(task.status, "paused");
  assert.equal(runs, 1, "pause must stop before a new iteration");

  task.status = "running";
  runner.wake(job);
  await runner.waitForIdle();
  assert.equal(task.status, "completed");
  assert.equal(runs, 2, "resume must continue the same task once");
}

async function plannerRetrySuite() {
  const task: FakeTask = {
    status: "queued",
    latest_checkpoint: {
      step_id: "planner",
      iteration: 0,
      summary: "Preparing a goal-aligned work plan.",
      planner_request: {
        document_ids: ["doc_1", "doc_2"],
        workflow_id: "builtin-compare-documents",
      },
    },
  };
  let runs = 0;
  let preservedPlannerRequest = false;
  const runner = new AgentTaskRunner({
    loadTask: async () => snapshot(task),
    runIteration: async () => {
      runs += 1;
      if (runs === 1) {
        throw Object.assign(new Error("planner 503 overloaded"), {
          status: 503,
        });
      }
      task.status = "completed";
      task.latest_checkpoint = null;
      return snapshot(task);
    },
    recordRetry: async (_job, retry) => {
      const current = task.latest_checkpoint as Record<string, unknown>;
      task.latest_checkpoint = {
        ...current,
        summary: "Model is busy. Retrying automatically.",
        runner_retry: retry,
      };
      preservedPlannerRequest = Boolean(
        (task.latest_checkpoint as Record<string, unknown>).planner_request,
      );
      return snapshot(task);
    },
    failTask: async () => {
      task.status = "failed";
    },
    recoverJobs: async () => [],
    sleep: async () => undefined,
    now: () => 0,
    random: () => 0.5,
  });

  runner.wake({ taskId: "task_planner", userId: "user_1" });
  await runner.waitForIdle();
  assert.equal(runs, 2, "planner must retry after a transient 503 and succeed");
  assert.equal(preservedPlannerRequest, true);
  assert.equal(task.status, "completed");
}

async function singleConcurrencySuite() {
  const tasks = new Map<string, FakeTask>([
    ["task_a", { status: "running", latest_checkpoint: null }],
    ["task_b", { status: "running", latest_checkpoint: null }],
  ]);
  let active = 0;
  let maxActive = 0;
  const completed: string[] = [];
  const runner = new AgentTaskRunner({
    loadTask: async (job) => snapshot(tasks.get(job.taskId)!),
    runIteration: async (job) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      tasks.get(job.taskId)!.status = "completed";
      completed.push(job.taskId);
      active -= 1;
      return snapshot(tasks.get(job.taskId)!);
    },
    recordRetry: async (job) => snapshot(tasks.get(job.taskId)!),
    failTask: async (job) => {
      tasks.get(job.taskId)!.status = "failed";
    },
    recoverJobs: async () => [],
    sleep: async () => undefined,
  });

  runner.wake({ taskId: "task_a", userId: "user_1" });
  runner.wake({ taskId: "task_b", userId: "user_1" });
  await runner.waitForIdle();

  assert.equal(maxActive, 1, "the runner must execute only one task at a time");
  assert.deepEqual(completed, ["task_a", "task_b"]);
}

async function recoverySuite() {
  const task: FakeTask = { status: "running", latest_checkpoint: null };
  let recoveredRuns = 0;
  const recoveredJob: AgentTaskRunnerJob = {
    taskId: "task_recovered",
    userId: "user_1",
  };
  const runner = new AgentTaskRunner({
    loadTask: async () => snapshot(task),
    runIteration: async () => {
      recoveredRuns += 1;
      task.status = "completed";
      return snapshot(task);
    },
    recordRetry: async () => snapshot(task),
    failTask: async () => {
      task.status = "failed";
    },
    recoverJobs: async () => [recoveredJob],
    sleep: async () => undefined,
  });
  await runner.recover();
  assert.equal(recoveredRuns, 1);
  assert.equal(task.status, "completed");
}

async function main() {
  const now = Date.parse("2026-07-21T00:00:00.000Z");
  assert.equal(parseRetryAfterMs("12", now), 12_000);
  assert.equal(parseRetryAfterMs("Tue, 21 Jul 2026 00:00:09 GMT", now), 9_000);
  assert.equal(parseRetryAfterMs("invalid", now), null);

  const limited = new Error("rate limited") as Error & {
    status: number;
    headers: Record<string, string>;
  };
  limited.status = 429;
  limited.headers = { "Retry-After": "7" };
  assert.deepEqual(classifyAgentTaskError(limited, now), {
    classification: "rate_limit",
    retryAfterMs: 7_000,
  });
  assert.equal(
    classifyAgentTaskError(
      Object.assign(new Error("invalid request"), { status: 400 }),
    ),
    null,
  );
  assert.equal(
    classifyAgentTaskError(
      Object.assign(new Error("unauthorized"), { status: 401 }),
    ),
    null,
  );
  assert.deepEqual(classifyAgentTaskError(new Error("ECONNRESET"), now), {
    classification: "network",
    retryAfterMs: null,
  });

  assert.equal(calculateAgentTaskBackoffMs(1, { random: () => 0.5 }), 2_000);
  assert.equal(
    calculateAgentTaskBackoffMs(20, { random: () => 1 }),
    60_000,
    "exponential backoff including jitter must remain capped",
  );
  assert.equal(
    calculateAgentTaskBackoffMs(3, {
      baseMs: 1_000,
      maxMs: 20_000,
      jitterRatio: 0.25,
      random: () => 0,
    }),
    3_000,
    "jitter must be controllable for deterministic tests",
  );
  assert.equal(
    calculateAgentTaskBackoffMs(9, { retryAfterMs: 91_000 }),
    91_000,
    "Retry-After must take precedence over the local cap",
  );

  await retryAndLifecycleSuite();
  await singleConcurrencySuite();
  await plannerRetrySuite();
  await pauseResumeSuite();
  await recoverySuite();

  console.log(
    JSON.stringify({ ok: true, suite: "agent-task-runner-smoke-v1" }, null, 2),
  );
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
