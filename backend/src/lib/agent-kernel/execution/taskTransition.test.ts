import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  AgentTaskStateTransitionError,
  agentTaskStateTransitionWasApplied,
  commitAgentTaskStateTransition,
  type AgentTaskStateTransitionInput,
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
