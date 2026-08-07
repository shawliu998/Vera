import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  AgentTaskStateTransitionError,
  agentTaskInputTransitionWasApplied,
  agentTaskPauseTransitionWasApplied,
  agentTaskReviewDecisionTransitionWasApplied,
  agentTaskRevisionTransitionWasApplied,
  agentTaskRetryTransitionWasApplied,
  agentTaskResumeTransitionWasApplied,
  agentTaskStateTransitionWasApplied,
  agentTaskStopTransitionWasApplied,
  commitAgentTaskInputTransition,
  commitAgentTaskPauseTransition,
  commitAgentTaskReviewDecisionTransition,
  commitAgentTaskRevisionTransition,
  commitAgentTaskRetryTransition,
  commitAgentTaskResumeTransition,
  commitAgentTaskStateTransition,
  commitAgentTaskStopTransition,
  type AgentTaskInputTransitionInput,
  type AgentTaskPauseTransitionInput,
  type AgentTaskReviewDecisionTransitionInput,
  type AgentTaskRevisionTransitionInput,
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

test("maps supplemental input to one atomic activation RPC", async () => {
  let call: { name: string; args: Record<string, unknown> } | null = null;
  const db = {
    async rpc(name: string, args: Record<string, unknown>) {
      call = { name, args };
      return {
        data: [
          {
            outcome: "activated",
            task_status: "running",
            current_step: input.stepId,
          },
        ],
        error: null,
      };
    },
  };
  const supplemental: AgentTaskInputTransitionInput = {
    taskId: input.taskId,
    userId: input.userId,
    stepId: input.stepId,
    expectedStepAttempt: 2,
    documentIds: ["00000000-0000-4000-8000-000000000004"],
    latestCheckpoint: {
      user_input: { submission_id: "submission-fixture" },
    },
    submissionId: "submission-fixture",
  };
  assert.equal(
    (await commitAgentTaskInputTransition(db as never, supplemental)).outcome,
    "activated",
  );
  assert.equal(call?.name, "submit_agent_task_input_v1");
  assert.deepEqual(call?.args.p_document_ids, supplemental.documentIds);
  assert.equal(call?.args.p_expected_step_attempt, 2);
});

test("accepts an uncertain input commit only for its exact submission id", () => {
  const supplemental: AgentTaskInputTransitionInput = {
    taskId: input.taskId,
    userId: input.userId,
    stepId: input.stepId,
    expectedStepAttempt: 2,
    documentIds: [],
    latestCheckpoint: {},
    submissionId: "submission-fixture",
  };
  const snapshot = {
    task: {
      status: "running",
      current_step: input.stepId,
      latest_checkpoint: {
        user_input: { submission_id: "submission-fixture" },
      },
      current_plan: [{ id: input.stepId, status: "running", attempt: 3 }],
    },
  };
  assert.equal(
    agentTaskInputTransitionWasApplied(snapshot, supplemental),
    true,
  );
  assert.equal(
    agentTaskInputTransitionWasApplied(snapshot, {
      ...supplemental,
      submissionId: "different-submission",
    }),
    false,
  );
  assert.equal(
    agentTaskInputTransitionWasApplied(
      {
        task: {
          status: "completed",
          current_step: "a-later-step",
          latest_checkpoint: snapshot.task.latest_checkpoint,
          current_plan: [{ id: input.stepId, status: "completed", attempt: 3 }],
        },
      },
      supplemental,
    ),
    true,
    "a fast executor may advance after the atomic input commit but before recovery reads",
  );
});

test("keeps atomic input migrations mirrored and source/version bound", async () => {
  const backend = await readFile(
    new URL(
      "../../../../migrations/20260807_04_agent_task_atomic_input.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const supabase = await readFile(
    new URL(
      "../../../../../supabase/migrations/20260807000004_agent_task_atomic_input.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.equal(backend, supabase);
  assert.match(
    backend,
    /d\.current_version_id::text = context_sources\.item ->> 'version_id'/i,
  );
  assert.doesNotMatch(backend, /as sources\(source\)/i);
  assert.doesNotMatch(backend, /(?<![.\w])source ->>/i);
  assert.match(backend, /on conflict \(task_id, artifact_type, artifact_id\)/i);
  assert.match(backend, /execution_lease_expires_at > clock_timestamp\(\)/i);
  assert.match(backend, /from public, anon, authenticated/i);
});

test("maps lawyer review and revision to serialized atomic RPCs", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const db = {
    async rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      return {
        data: [
          name === "record_agent_task_review_decision_v1"
            ? {
                outcome: "recorded",
                task_status: "completed",
                current_step: input.stepId,
              }
            : {
                outcome: "revised",
                task_status: "running",
                current_step: input.stepId,
              },
        ],
        error: null,
      };
    },
  };
  const review: AgentTaskReviewDecisionTransitionInput = {
    decisionId: "00000000-0000-4000-8000-000000000004",
    taskId: input.taskId,
    userId: input.userId,
    expectedLatestDecisionId: "00000000-0000-4000-8000-000000000005",
    status: "changes_requested",
    note: "Correct the governing-law analysis.",
    reviewerEmail: "reviewer@example.com",
    reviewerName: "Reviewer",
    artifactSnapshot: [],
  };
  const revision: AgentTaskRevisionTransitionInput = {
    taskId: input.taskId,
    userId: input.userId,
    revisionId: "00000000-0000-4000-8000-000000000006",
    reviewDecisionId: review.decisionId,
    firstStepId: input.stepId,
    revisionStart: 2,
    expectedFirstStepAttempt: 1,
    latestCheckpoint: {
      revision_request: {
        revision_id: "00000000-0000-4000-8000-000000000006",
      },
    },
  };
  assert.equal(
    (await commitAgentTaskReviewDecisionTransition(db as never, review))
      .outcome,
    "recorded",
  );
  assert.equal(
    (await commitAgentTaskRevisionTransition(db as never, revision)).outcome,
    "revised",
  );
  assert.deepEqual(
    calls.map((call) => call.name),
    ["record_agent_task_review_decision_v1", "start_agent_task_revision_v1"],
  );
  assert.equal(
    calls[0]?.args.p_expected_latest_decision_id,
    "00000000-0000-4000-8000-000000000005",
  );
  assert.equal(calls[1]?.args.p_expected_first_step_attempt, 1);
});

test("recognizes only the exact review decision and revision identity", () => {
  const review: AgentTaskReviewDecisionTransitionInput = {
    decisionId: "00000000-0000-4000-8000-000000000004",
    taskId: input.taskId,
    userId: input.userId,
    expectedLatestDecisionId: null,
    status: "changes_requested",
    note: "Revise.",
    reviewerEmail: null,
    reviewerName: null,
    artifactSnapshot: [],
  };
  assert.equal(
    agentTaskReviewDecisionTransitionWasApplied(
      {
        review: {
          decisions: [
            {
              id: review.decisionId,
              status: review.status,
              reviewer_id: review.userId,
              reviewer_email: review.reviewerEmail,
              reviewer_name: review.reviewerName,
              note: review.note,
              artifact_snapshot: review.artifactSnapshot,
            },
          ],
        },
      },
      review,
    ),
    true,
  );
  assert.equal(
    agentTaskReviewDecisionTransitionWasApplied(
      {
        review: {
          decisions: [
            {
              id: review.decisionId,
              status: review.status,
              reviewer_id: review.userId,
              reviewer_email: review.reviewerEmail,
              reviewer_name: review.reviewerName,
              note: "A different direction.",
              artifact_snapshot: review.artifactSnapshot,
            },
          ],
        },
      },
      review,
    ),
    false,
  );
  const revision: AgentTaskRevisionTransitionInput = {
    taskId: input.taskId,
    userId: input.userId,
    revisionId: "00000000-0000-4000-8000-000000000006",
    reviewDecisionId: review.decisionId,
    firstStepId: input.stepId,
    revisionStart: 2,
    expectedFirstStepAttempt: 1,
    latestCheckpoint: {},
  };
  const revised = {
    task: {
      latest_checkpoint: {
        revision_request: {
          revision_id: revision.revisionId,
          review_decision_id: revision.reviewDecisionId,
          first_step_id: revision.firstStepId,
          revision_start: revision.revisionStart,
          attempt: revision.expectedFirstStepAttempt + 1,
        },
      },
      current_plan: [{ id: input.stepId, status: "running", attempt: 2 }],
    },
  };
  assert.equal(agentTaskRevisionTransitionWasApplied(revised, revision), true);
  assert.equal(
    agentTaskRevisionTransitionWasApplied(revised, {
      ...revision,
      revisionId: "00000000-0000-4000-8000-000000000007",
    }),
    false,
  );
});

test("keeps atomic review/revision migrations mirrored and fenced", async () => {
  const backend = await readFile(
    new URL(
      "../../../../migrations/20260807_05_agent_task_atomic_review_revision.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const supabase = await readFile(
    new URL(
      "../../../../../supabase/migrations/20260807000005_agent_task_atomic_review_revision.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.equal(backend, supabase);
  assert.match(backend, /for update of d/i);
  assert.match(backend, /status not in \('completed', 'skipped'\)/i);
  assert.match(
    backend,
    /latest_checkpoint -> 'contract'[\s\S]*is distinct from p_latest_checkpoint -> 'contract'/i,
  );
  assert.match(backend, /execution_lease_expires_at > clock_timestamp\(\)/i);
  assert.match(backend, /from public, anon, authenticated/i);
  assert.match(backend, /to service_role/i);
});

test("maps pause and resume to server-owned atomic transitions", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const db = {
    async rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      return {
        data: [
          name === "pause_agent_task_state_v1"
            ? {
                outcome: "paused",
                task_status: "paused",
                current_step: input.stepId,
              }
            : {
                outcome: "resumed",
                task_status: "running",
                current_step: input.stepId,
              },
        ],
        error: null,
      };
    },
  };
  const pause: AgentTaskPauseTransitionInput = {
    taskId: input.taskId,
    userId: input.userId,
    expectedTaskStatus: "running",
    stepId: input.stepId,
    expectedStepAttempt: 2,
    leaseOwner: input.leaseOwner,
    forceRevoke: false,
    latestCheckpoint: { step_id: input.stepId },
  };
  assert.equal(
    (await commitAgentTaskPauseTransition(db as never, pause)).outcome,
    "paused",
  );
  assert.equal(
    (
      await commitAgentTaskResumeTransition(db as never, {
        taskId: input.taskId,
        userId: input.userId,
      })
    ).outcome,
    "resumed",
  );
  assert.deepEqual(
    calls.map((call) => call.name),
    ["pause_agent_task_state_v1", "resume_agent_task_state_v1"],
  );
  assert.equal(calls[0]?.args.p_expected_step_attempt, 2);
  assert.equal(calls[0]?.args.p_lease_owner, input.leaseOwner);
  assert.equal(calls[0]?.args.p_force_revoke, false);
});

test("recognizes pause and resume recovery without changing the Step attempt", () => {
  const pause: AgentTaskPauseTransitionInput = {
    taskId: input.taskId,
    userId: input.userId,
    expectedTaskStatus: "running",
    stepId: input.stepId,
    expectedStepAttempt: 2,
    leaseOwner: null,
    forceRevoke: true,
    latestCheckpoint: null,
  };
  assert.equal(
    agentTaskPauseTransitionWasApplied(
      {
        task: {
          status: "paused",
          current_step: input.stepId,
          current_plan: [{ id: input.stepId, status: "running", attempt: 2 }],
        },
      },
      pause,
    ),
    true,
  );
  assert.equal(
    agentTaskPauseTransitionWasApplied(
      {
        task: {
          status: "paused",
          current_step: input.stepId,
          current_plan: [{ id: input.stepId, status: "running", attempt: 3 }],
        },
      },
      pause,
    ),
    true,
    "a user-forced pause may serialize after the Task advances to a new attempt",
  );
  assert.equal(
    agentTaskPauseTransitionWasApplied(
      {
        task: {
          status: "paused",
          current_step: input.stepId,
          current_plan: [{ id: input.stepId, status: "running", attempt: 3 }],
        },
      },
      { ...pause, forceRevoke: false },
    ),
    false,
  );
  assert.equal(
    agentTaskResumeTransitionWasApplied({ task: { status: "verifying" } }),
    true,
  );
  assert.equal(
    agentTaskResumeTransitionWasApplied({ task: { status: "paused" } }),
    false,
  );
});

test("keeps pause/resume migrations mirrored, lease-fenced and service-only", async () => {
  const backend = await readFile(
    new URL(
      "../../../../migrations/20260807_07_agent_task_atomic_pause_resume.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const supabase = await readFile(
    new URL(
      "../../../../../supabase/migrations/20260807000007_agent_task_atomic_pause_resume.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.equal(backend, supabase);
  assert.match(backend, /status in \('queued', 'running', 'verifying'\)/i);
  assert.match(backend, /execution_lease_owner = null/i);
  assert.match(backend, /v_step\.attempt <> v_expected_step_attempt/i);
  assert.match(backend, /from public, anon, authenticated/i);
  assert.match(backend, /to service_role/i);
});
