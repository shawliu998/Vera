import assert from "node:assert/strict";
import {
  AgentTaskRunner,
  calculateAgentTaskBackoffMs,
  classifyAgentTaskError,
  parseRetryAfterMs,
  type AgentTaskRunnerJob,
} from "../src/lib/agentTaskRunner";
import { clearAgentTaskRunnerRetryCheckpoint } from "../src/lib/agentTasks";

type FakeTask = {
  status: string;
  latest_checkpoint: unknown;
};

function snapshot(task: FakeTask) {
  return { task };
}

async function retryAndLifecycleSuite() {
  const tasks = new Map<string, FakeTask>([
    [
      "task_1",
      {
        status: "running",
        latest_checkpoint: {
          user_input: {
            step_id: "step_1",
            attempt: 1,
            submitted_at: "2026-07-21T08:00:00.000Z",
            message: "适用新加坡法；立场为客户方。",
            document_ids: [],
          },
        },
      },
    ],
  ]);
  let iterations = 0;
  let retryWrites = 0;
  let retryPreservedUserInput = true;
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
        ...((task.latest_checkpoint as Record<string, unknown> | null) ?? {}),
        step_id: "step_1",
        iteration: 1,
        summary: "Model is busy. Retrying automatically.",
        created_at: new Date(0).toISOString(),
        runner_retry: retry,
      };
      retryPreservedUserInput &&= Boolean(
        (task.latest_checkpoint as Record<string, unknown>).user_input,
      );
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
  assert.equal(
    retryPreservedUserInput,
    true,
    "503 retry checkpoints must preserve the submitted user input",
  );
  assert.deepEqual(sleeps, [30_000, 60_000]);
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

async function retryExhaustionSuite() {
  const task: FakeTask = { status: "running", latest_checkpoint: null };
  let iterations = 0;
  let retryWrites = 0;
  let deferrals = 0;
  let deferralClassification = "";
  const sleeps: number[] = [];
  const runner = new AgentTaskRunner({
    loadTask: async () => snapshot(task),
    runIteration: async () => {
      iterations += 1;
      throw Object.assign(new Error("503 provider overloaded"), {
        status: 503,
      });
    },
    recordRetry: async (_job, retry) => {
      retryWrites += 1;
      task.latest_checkpoint = {
        step_id: "step_retry",
        iteration: 1,
        summary: "Model is busy. Retrying automatically.",
        created_at: new Date(0).toISOString(),
        runner_retry: retry,
      };
      return snapshot(task);
    },
    failTask: async () => {
      task.status = "failed";
    },
    deferTask: async (_job, _summary, classification) => {
      deferrals += 1;
      deferralClassification = classification;
      task.status = "paused";
    },
    recoverJobs: async () => [],
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => 0,
    random: () => 0.5,
  });

  runner.wake({ taskId: "task_exhausted", userId: "user_1" });
  await runner.waitForIdle();

  assert.equal(
    iterations,
    4,
    "the runner must stop after three scheduled transient retries",
  );
  assert.equal(retryWrites, 3, "only three retry checkpoints may be written");
  assert.deepEqual(sleeps, [30_000, 60_000, 60_000]);
  assert.equal(task.status, "paused");
  assert.equal(deferrals, 1);
  assert.equal(deferralClassification, "provider_capacity");
}

async function providerTransportPauseClassificationSuite() {
  const cases = [
    {
      name: "timeout",
      error: Object.assign(new Error("provider timed out"), {
        name: "TimeoutError",
      }),
      expectedClassification: "provider_timeout",
      expectedSummary: /timed out/i,
    },
    {
      name: "network",
      error: new Error("ECONNRESET"),
      expectedClassification: "provider_network",
      expectedSummary: /connection/i,
    },
  ] as const;

  for (const transportCase of cases) {
    const task: FakeTask = { status: "running", latest_checkpoint: null };
    let iterations = 0;
    let retryWrites = 0;
    let failures = 0;
    let deferrals = 0;
    const runner = new AgentTaskRunner({
      loadTask: async () => snapshot(task),
      runIteration: async () => {
        iterations += 1;
        throw transportCase.error;
      },
      recordRetry: async (_job, retry) => {
        retryWrites += 1;
        task.latest_checkpoint = { runner_retry: retry };
        return snapshot(task);
      },
      failTask: async () => {
        failures += 1;
        task.status = "failed";
      },
      deferTask: async (_job, summary, classification) => {
        deferrals += 1;
        assert.equal(classification, transportCase.expectedClassification);
        assert.match(summary, transportCase.expectedSummary);
        task.status = "paused";
      },
      recoverJobs: async () => [],
      sleep: async () => undefined,
      now: () => 0,
      random: () => 0.5,
    });

    runner.wake({
      taskId: `task_transport_${transportCase.name}`,
      userId: "user_1",
    });
    await runner.waitForIdle();
    assert.equal(iterations, 4);
    assert.equal(retryWrites, 3);
    assert.equal(deferrals, 1);
    assert.equal(failures, 0);
    assert.equal(task.status, "paused");
  }
}

async function sseProviderPauseAndResumeSuite() {
  for (const providerError of [
    { message: "SSE data.error code 1302", expected: "provider_capacity" },
    { message: "SSE data.error code 1305", expected: "provider_capacity" },
  ] as const) {
    const step = { id: "step_fixed", attempt: 1 };
    const durableEffects = new Set([
      "runner-seam:existing-artifact-link",
      "runner-seam:existing-citation",
    ]);
    const initialEffectsFingerprint = [...durableEffects].sort().join("|");
    const durableEffectsFingerprint = () =>
      [...durableEffects].sort().join("|");
    const completedEffectId = "runner-seam:step_fixed-completed";
    const task: FakeTask = {
      status: "running",
      latest_checkpoint: {
        user_input: {
          step_id: step.id,
          attempt: step.attempt,
          submitted_at: "2026-08-07T00:00:00.000Z",
          document_ids: ["doc_fixed"],
        },
        existing_checkpoint: "retain-me",
      },
    };
    const job = {
      taskId: `task_${providerError.message.slice(-4)}`,
      userId: "user_1",
    };
    let iterations = 0;
    let retries = 0;
    let failures = 0;
    let pausedTaskId = "";
    let successfulExecution = 0;
    const runner = new AgentTaskRunner({
      loadTask: async () => snapshot(task),
      runIteration: async () => {
        iterations += 1;
        if (iterations <= 4) {
          assert.equal(step.attempt, 1);
          assert.equal(durableEffectsFingerprint(), initialEffectsFingerprint);
          throw Object.assign(new Error(providerError.message), {
            status: "200",
          });
        }
        assert.equal(step.attempt, 1);
        assert.equal(durableEffects.has(completedEffectId), false);
        durableEffects.add(completedEffectId);
        successfulExecution += 1;
        task.status = "completed";
        return snapshot(task);
      },
      recordRetry: async (_job, retry) => {
        retries += 1;
        assert.equal(step.attempt, 1);
        assert.equal(durableEffectsFingerprint(), initialEffectsFingerprint);
        task.latest_checkpoint = {
          ...(task.latest_checkpoint as Record<string, unknown>),
          runner_retry: retry,
        };
        return snapshot(task);
      },
      failTask: async () => {
        failures += 1;
        task.status = "failed";
      },
      deferTask: async (deferredJob, _summary, classification) => {
        pausedTaskId = deferredJob.taskId;
        assert.equal(classification, providerError.expected);
        assert.equal(step.attempt, 1);
        assert.equal(durableEffectsFingerprint(), initialEffectsFingerprint);
        task.latest_checkpoint = {
          ...(task.latest_checkpoint as Record<string, unknown>),
          step_id: step.id,
          iteration: step.attempt,
          execution_pause: {
            kind: "agent_task_execution_pause_v1",
            classification,
            step_id: step.id,
            attempt: step.attempt,
          },
        };
        task.status = "paused";
      },
      recoverJobs: async () => [],
      sleep: async () => undefined,
      now: () => 0,
      random: () => 0.5,
    });

    runner.wake(job);
    await runner.waitForIdle();
    assert.equal(
      retries,
      3,
      "each SSE capacity error has exactly three retries",
    );
    assert.equal(
      failures,
      0,
      "provider capacity exhaustion must not fail work",
    );
    assert.equal(task.status, "paused");
    assert.equal(pausedTaskId, job.taskId);
    assert.equal(step.attempt, 1, "pausing must not advance the Step attempt");
    assert.equal(durableEffectsFingerprint(), initialEffectsFingerprint);
    assert.deepEqual(
      (task.latest_checkpoint as Record<string, unknown>).user_input,
      {
        step_id: step.id,
        attempt: 1,
        submitted_at: "2026-08-07T00:00:00.000Z",
        document_ids: ["doc_fixed"],
      },
      "provider pause must merge, rather than replace, the existing checkpoint",
    );
    assert.equal(
      (task.latest_checkpoint as Record<string, unknown>).existing_checkpoint,
      "retain-me",
    );

    task.status = "running"; // Existing explicit resume preserves the Task and Step IDs.
    runner.wake(job);
    await runner.waitForIdle();
    assert.equal(task.status, "completed");
    assert.equal(
      iterations,
      5,
      "the resumed task continues after the provider recovers",
    );
    assert.equal(successfulExecution, 1);
    assert.deepEqual([...durableEffects].sort(), [
      "runner-seam:existing-artifact-link",
      "runner-seam:existing-citation",
      completedEffectId,
    ]);
    assert.equal(
      durableEffects.size,
      3,
      "the success effect must be idempotent",
    );
  }
}

async function providerProtocolPauseAndResumeSuite() {
  for (const provider of [
    "DeepSeek",
    "Kimi",
    "Gemini",
    "Zhipu",
    "Claude",
    "OpenAI",
  ]) {
    const step = { id: "step_protocol", attempt: 1 };
    const durableEffects = new Set(["runner-seam:existing-artifact-link"]);
    const initialEffectsFingerprint = [...durableEffects].join("|");
    const completedEffectId = `runner-seam:${provider}-protocol-completed`;
    const task: FakeTask = {
      status: "running",
      latest_checkpoint: {
        step_id: step.id,
        iteration: step.attempt,
        existing_checkpoint: "retain-me",
      },
    };
    const job = { taskId: `task_protocol_${provider}`, userId: "user_1" };
    let iterations = 0;
    let retryWrites = 0;
    let failures = 0;
    let deferrals = 0;
    let successfulExecution = 0;
    let deferredTaskId = "";
    const sleeps: number[] = [];
    const runner = new AgentTaskRunner({
      loadTask: async () => snapshot(task),
      runIteration: async () => {
        iterations += 1;
        if (iterations === 1) {
          assert.equal(step.attempt, 1);
          assert.equal(
            [...durableEffects].join("|"),
            initialEffectsFingerprint,
          );
          throw new Error(
            `${provider} did not return the required read_document tool call for this iteration.`,
          );
        }
        assert.equal(step.attempt, 1);
        assert.equal(durableEffects.has(completedEffectId), false);
        durableEffects.add(completedEffectId);
        successfulExecution += 1;
        task.status = "completed";
        return snapshot(task);
      },
      recordRetry: async () => {
        retryWrites += 1;
        assert.fail("a protocol pause must not write a retry checkpoint");
      },
      failTask: async () => {
        failures += 1;
        task.status = "failed";
      },
      deferTask: async (deferredJob, _summary, classification) => {
        deferrals += 1;
        deferredTaskId = deferredJob.taskId;
        assert.equal(classification, "provider_protocol");
        assert.equal(step.id, "step_protocol");
        assert.equal(step.attempt, 1);
        assert.equal([...durableEffects].join("|"), initialEffectsFingerprint);
        assert.deepEqual(task.latest_checkpoint, {
          step_id: step.id,
          iteration: step.attempt,
          existing_checkpoint: "retain-me",
        });
        task.status = "paused";
      },
      recoverJobs: async () => [],
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    runner.wake(job);
    await runner.waitForIdle();
    assert.equal(iterations, 1, `${provider} must pause after one attempt`);
    assert.equal(deferrals, 1);
    assert.equal(retryWrites, 0);
    assert.equal(sleeps.length, 0);
    assert.equal(failures, 0);
    assert.equal(task.status, "paused");
    assert.equal(deferredTaskId, job.taskId);
    assert.equal(step.attempt, 1);
    assert.equal([...durableEffects].join("|"), initialEffectsFingerprint);

    task.status = "running"; // Existing explicit resume retains the Task and Step IDs.
    runner.wake(job);
    await runner.waitForIdle();
    assert.equal(task.status, "completed");
    assert.equal(successfulExecution, 1);
    assert.deepEqual(
      [...durableEffects],
      ["runner-seam:existing-artifact-link", completedEffectId],
    );
    assert.equal(durableEffects.size, 2);
  }
}

async function unknownProviderProtocolFailureSuite() {
  const task: FakeTask = { status: "running", latest_checkpoint: null };
  let iterations = 0;
  let retryWrites = 0;
  let sleeps = 0;
  let failures = 0;
  let deferrals = 0;
  const runner = new AgentTaskRunner({
    loadTask: async () => snapshot(task),
    runIteration: async () => {
      iterations += 1;
      throw new Error(
        "UnknownAI did not return the required read_document tool call for this iteration.",
      );
    },
    recordRetry: async () => {
      retryWrites += 1;
      return snapshot(task);
    },
    failTask: async () => {
      failures += 1;
      task.status = "failed";
    },
    deferTask: async () => {
      deferrals += 1;
      task.status = "paused";
    },
    recoverJobs: async () => [],
    sleep: async () => {
      sleeps += 1;
    },
  });

  runner.wake({ taskId: "task_protocol_unknown", userId: "user_1" });
  await runner.waitForIdle();
  assert.equal(iterations, 1);
  assert.equal(retryWrites, 0);
  assert.equal(sleeps, 0);
  assert.equal(deferrals, 0);
  assert.equal(failures, 1);
  assert.equal(task.status, "failed");
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

async function recoveryRetryWaitBoundSuite() {
  const task: FakeTask = {
    status: "running",
    latest_checkpoint: {
      step_id: "step_retry",
      iteration: 1,
      runner_retry: {
        attempt: 1,
        retry_at: new Date(91_000).toISOString(),
        classification: "provider_unavailable",
      },
    },
  };
  const sleeps: number[] = [];
  let runs = 0;
  const runner = new AgentTaskRunner({
    loadTask: async () => snapshot(task),
    runIteration: async () => {
      runs += 1;
      task.status = "completed";
      task.latest_checkpoint = null;
      return snapshot(task);
    },
    recordRetry: async () => snapshot(task),
    failTask: async () => {
      task.status = "failed";
    },
    recoverJobs: async () => [],
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => 0,
  });

  runner.wake({ taskId: "task_recovery_retry", userId: "user_1" });
  await runner.waitForIdle();
  assert.deepEqual(
    sleeps,
    [60_000],
    "a recovered retry checkpoint must retain the same bounded wait cap",
  );
  assert.equal(runs, 1);
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
  assert.deepEqual(
    clearAgentTaskRunnerRetryCheckpoint({
      step_id: "step_1",
      iteration: 3,
      summary: "Model is busy. Retrying automatically.",
      runner_retry: {
        attempt: 3,
        retry_at: "2026-07-21T00:00:08.000Z",
        classification: "provider_unavailable",
      },
    }),
    {
      step_id: "step_1",
      iteration: 3,
      summary: "Model is busy. Retrying automatically.",
    },
    "manual retry must reset the persisted automatic retry budget",
  );

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
    60_000,
    "Retry-After must remain within the bounded wait cap",
  );

  await retryAndLifecycleSuite();
  await singleConcurrencySuite();
  await plannerRetrySuite();
  await retryExhaustionSuite();
  await providerTransportPauseClassificationSuite();
  await sseProviderPauseAndResumeSuite();
  await providerProtocolPauseAndResumeSuite();
  await unknownProviderProtocolFailureSuite();
  await pauseResumeSuite();
  await recoverySuite();
  await recoveryRetryWaitBoundSuite();

  console.log(
    JSON.stringify({ ok: true, suite: "agent-task-runner-smoke-v1" }, null, 2),
  );
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
