import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  AgentTaskStateTransitionError,
  agentTaskRetryTransitionWasApplied,
  agentTaskStateTransitionWasApplied,
  agentTaskStopTransitionWasApplied,
  commitAgentTaskRetryTransition,
  commitAgentTaskStateTransition,
  commitAgentTaskStopTransition,
  type AgentTaskRetryTransitionInput,
  type AgentTaskStateTransitionInput,
  type AgentTaskStopTransitionInput,
} from "./taskTransition";

const input: AgentTaskStateTransitionInput = {
  taskId: "00000000-0000-4000-8000-000000000001",
  userId: "user-fixture",
  leaseOwner: "00000000-0000-4000-8000-000000000002",
  expectedTaskStatus: "running",
  stepId: "00000000-0000-4000-8000-000000000003",
  expectedStepAttempt: 2,
  resultSummary: "Completed the bounded step.",
  latestCheckpoint: { step_id: "step-fixture" },
  reviewNote: null,
};

test("maps the server-owned transition to the atomic RPC", async () => {
  let call: { name: string; args: Record<string, unknown> } | null = null;
  const db = {
    async rpc(name: string, args: Record<string, unknown>) {
      call = { name, args };
      return {
        data: [
          {
            outcome: "advanced",
            task_status: "verifying",
            current_step: "next-step",
          },
        ],
        error: null,
      };
    },
  };
  const result = await commitAgentTaskStateTransition(db as never, input);
  assert.equal(call?.name, "advance_agent_task_state_v1");
  assert.deepEqual(call?.args, {
    p_task_id: input.taskId,
    p_user_id: input.userId,
    p_lease_owner: input.leaseOwner,
    p_expected_task_status: input.expectedTaskStatus,
    p_step_id: input.stepId,
    p_expected_step_attempt: input.expectedStepAttempt,
    p_result_summary: input.resultSummary,
    p_latest_checkpoint: input.latestCheckpoint,
    p_review_note: input.reviewNote,
  });
  assert.deepEqual(result, {
    outcome: "advanced",
    taskStatus: "verifying",
    currentStep: "next-step",
  });
});

test("wraps database failures as a recoverable state-transition error", async () => {
  const db = {
    async rpc() {
      return { data: null, error: { message: "database unavailable" } };
    },
  };
  await assert.rejects(
    commitAgentTaskStateTransition(db as never, input),
    (error: unknown) =>
      error instanceof AgentTaskStateTransitionError &&
      error.code === "task_state_transition_unavailable",
  );
});

test("recognizes a committed completion after an uncertain response", () => {
  assert.equal(
    agentTaskStateTransitionWasApplied(
      {
        task: {
          status: "verifying",
          current_step: "next-step",
          current_plan: [
            { id: input.stepId, status: "completed", attempt: 2 },
            { id: "next-step", status: "running", attempt: 1 },
          ],
        },
      },
      input,
    ),
    true,
  );
});

test("does not mistake the unchanged current Step for a committed transition", () => {
  assert.equal(
    agentTaskStateTransitionWasApplied(
      {
        task: {
          status: "running",
          current_step: input.stepId,
          current_plan: [{ id: input.stepId, status: "running", attempt: 2 }],
        },
      },
      input,
    ),
    false,
  );
});

test("recognizes an atomically started queued Step", () => {
  const start = {
    ...input,
    expectedTaskStatus: "queued" as const,
    expectedStepAttempt: 0,
    resultSummary: null,
  };
  assert.equal(
    agentTaskStateTransitionWasApplied(
      {
        task: {
          status: "running",
          current_step: input.stepId,
          current_plan: [
            { id: input.stepId, status: "running", attempt: 1 },
            { id: "next-step", status: "pending", attempt: 0 },
          ],
        },
      },
      start,
    ),
    true,
  );
});

test("keeps backend and Supabase transition migrations mirrored and service-only", async () => {
  const backend = await readFile(
    new URL(
      "../../../../migrations/20260807_02_agent_task_atomic_transition.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const supabase = await readFile(
    new URL(
      "../../../../../supabase/migrations/20260807000002_agent_task_atomic_transition.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.equal(backend, supabase);
  assert.match(backend, /security definer/i);
  assert.match(
    backend,
    /execution_lease_owner is distinct from p_lease_owner/i,
  );
  assert.match(backend, /from public, anon, authenticated/i);
  assert.match(backend, /to service_role/i);
});

test("maps leased stop and lease-free retry to separate atomic RPCs", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const db = {
    async rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      return {
        data: [
          name === "stop_agent_task_state_v1"
            ? {
                outcome: "stopped",
                task_status: "failed",
                current_step: input.stepId,
              }
            : {
                outcome: "retried",
                task_status: "running",
                current_step: input.stepId,
              },
        ],
        error: null,
      };
    },
  };
  const stop: AgentTaskStopTransitionInput = {
    taskId: input.taskId,
    userId: input.userId,
    leaseOwner: input.leaseOwner,
    expectedTaskStatus: "running",
    stepId: input.stepId,
    expectedStepAttempt: 2,
    targetStatus: "failed",
    resultSummary: "Bounded failure.",
    latestCheckpoint: { step_id: input.stepId },
  };
  const retry: AgentTaskRetryTransitionInput = {
    taskId: input.taskId,
    userId: input.userId,
    expectedTaskStatus: "failed",
    stepId: input.stepId,
    expectedStepAttempt: 2,
    latestCheckpoint: { step_id: input.stepId },
  };
  assert.equal(
    (await commitAgentTaskStopTransition(db as never, stop)).outcome,
    "stopped",
  );
  assert.equal(
    (await commitAgentTaskRetryTransition(db as never, retry)).outcome,
    "retried",
  );
  assert.deepEqual(
    calls.map((call) => call.name),
    ["stop_agent_task_state_v1", "retry_agent_task_state_v1"],
  );
  assert.equal(calls[0]?.args.p_lease_owner, input.leaseOwner);
  assert.equal(Object.hasOwn(calls[1]!.args, "p_lease_owner"), false);
});

test("recognizes uncertain stop and retry commits by exact Step attempt", () => {
  const stop: AgentTaskStopTransitionInput = {
    taskId: input.taskId,
    userId: input.userId,
    leaseOwner: input.leaseOwner,
    expectedTaskStatus: "running",
    stepId: input.stepId,
    expectedStepAttempt: 2,
    targetStatus: "waiting_input",
    resultSummary: "More evidence is required.",
    latestCheckpoint: {},
  };
  const stopped = {
    task: {
      status: "waiting_input",
      current_step: input.stepId,
      current_plan: [{ id: input.stepId, status: "blocked", attempt: 2 }],
    },
  };
  assert.equal(agentTaskStopTransitionWasApplied(stopped, stop), true);
  const retry: AgentTaskRetryTransitionInput = {
    taskId: input.taskId,
    userId: input.userId,
    expectedTaskStatus: "waiting_input",
    stepId: input.stepId,
    expectedStepAttempt: 2,
    latestCheckpoint: {},
  };
  assert.equal(
    agentTaskRetryTransitionWasApplied(
      {
        task: {
          status: "verifying",
          current_step: input.stepId,
          current_plan: [{ id: input.stepId, status: "running", attempt: 3 }],
        },
      },
      retry,
    ),
    true,
  );
  assert.equal(
    agentTaskRetryTransitionWasApplied(
      {
        task: {
          status: "queued",
          current_step: null,
          current_plan: [{ id: "pending-step", status: "pending", attempt: 0 }],
        },
      },
      {
        ...retry,
        expectedTaskStatus: "failed",
        stepId: null,
        expectedStepAttempt: null,
      },
    ),
    true,
  );
});

test("keeps recovery migrations mirrored and fences stop/retry leases", async () => {
  const backend = await readFile(
    new URL(
      "../../../../migrations/20260807_03_agent_task_atomic_recovery.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const supabase = await readFile(
    new URL(
      "../../../../../supabase/migrations/20260807000003_agent_task_atomic_recovery.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.equal(backend, supabase);
  assert.match(
    backend,
    /execution_lease_owner is distinct from p_lease_owner/i,
  );
  assert.match(backend, /execution_lease_expires_at > clock_timestamp\(\)/i);
  assert.match(backend, /from public, anon, authenticated/i);
  assert.match(backend, /to service_role/i);
});
