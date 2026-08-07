import type { createServerSupabase } from "../../supabase";

type Db = ReturnType<typeof createServerSupabase>;

export type AgentTaskStateTransitionInput = {
  taskId: string;
  userId: string;
  leaseOwner: string;
  expectedTaskStatus: "queued" | "running" | "verifying";
  stepId: string;
  expectedStepAttempt: number;
  resultSummary: string | null;
  latestCheckpoint: unknown;
  reviewNote: string | null;
};

export type AgentTaskStateTransitionOutcome =
  | "advanced"
  | "conflict"
  | "invalid_input"
  | "lease_lost"
  | "not_found";

export type AgentTaskStopTransitionInput = {
  taskId: string;
  userId: string;
  leaseOwner: string;
  expectedTaskStatus: "queued" | "running" | "verifying";
  stepId: string | null;
  expectedStepAttempt: number | null;
  targetStatus: "waiting_input" | "failed";
  resultSummary: string;
  latestCheckpoint: unknown;
};

export type AgentTaskRetryTransitionInput = {
  taskId: string;
  userId: string;
  expectedTaskStatus: "waiting_input" | "failed";
  stepId: string | null;
  expectedStepAttempt: number | null;
  latestCheckpoint: unknown;
};

export type AgentTaskInputTransitionInput = {
  taskId: string;
  userId: string;
  stepId: string;
  expectedStepAttempt: number;
  documentIds: string[];
  latestCheckpoint: unknown;
  submissionId: string;
};

export class AgentTaskStateTransitionError extends Error {
  constructor(
    readonly code:
      | "task_state_transition_conflict"
      | "task_state_transition_unavailable",
    message: string,
    readonly facts: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AgentTaskStateTransitionError";
  }
}

export function isAgentTaskStateTransitionError(
  error: unknown,
): error is AgentTaskStateTransitionError {
  return (
    error instanceof AgentTaskStateTransitionError ||
    Boolean(
      error &&
      typeof error === "object" &&
      (error as { name?: unknown }).name === "AgentTaskStateTransitionError",
    )
  );
}

function firstRow(value: unknown) {
  return Array.isArray(value) ? value[0] : value;
}

function transitionError(message: string, facts: Record<string, unknown>) {
  return new AgentTaskStateTransitionError(
    "task_state_transition_unavailable",
    message,
    facts,
  );
}

function readOutcome<const TAllowed extends readonly string[]>(
  data: unknown,
  allowed: TAllowed,
  facts: Record<string, unknown>,
) {
  const row = firstRow(data) as Record<string, unknown> | null;
  const outcome = row?.outcome;
  if (typeof outcome !== "string" || !allowed.includes(outcome)) {
    throw transitionError(
      "The Agent Task state transition returned an invalid result.",
      { ...facts, outcome: outcome ?? null },
    );
  }
  return {
    outcome: outcome as TAllowed[number],
    taskStatus: typeof row?.task_status === "string" ? row.task_status : null,
    currentStep:
      typeof row?.current_step === "string" ? row.current_step : null,
  };
}

export async function commitAgentTaskStateTransition(
  db: Db,
  input: AgentTaskStateTransitionInput,
) {
  const { data, error } = await db.rpc("advance_agent_task_state_v1", {
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
  if (error) {
    throw transitionError(
      `Failed to commit the Agent Task state transition: ${error.message}`,
      {
        task_id: input.taskId,
        step_id: input.stepId,
        expected_task_status: input.expectedTaskStatus,
        expected_step_attempt: input.expectedStepAttempt,
      },
    );
  }
  return readOutcome(
    data,
    ["advanced", "conflict", "invalid_input", "lease_lost", "not_found"],
    { task_id: input.taskId, step_id: input.stepId },
  ) as {
    outcome: AgentTaskStateTransitionOutcome;
    taskStatus: string | null;
    currentStep: string | null;
  };
}

export async function commitAgentTaskStopTransition(
  db: Db,
  input: AgentTaskStopTransitionInput,
) {
  const { data, error } = await db.rpc("stop_agent_task_state_v1", {
    p_task_id: input.taskId,
    p_user_id: input.userId,
    p_lease_owner: input.leaseOwner,
    p_expected_task_status: input.expectedTaskStatus,
    p_step_id: input.stepId,
    p_expected_step_attempt: input.expectedStepAttempt,
    p_target_status: input.targetStatus,
    p_result_summary: input.resultSummary,
    p_latest_checkpoint: input.latestCheckpoint,
  });
  if (error) {
    throw transitionError(
      `Failed to stop the Agent Task atomically: ${error.message}`,
      {
        task_id: input.taskId,
        step_id: input.stepId,
        expected_task_status: input.expectedTaskStatus,
        expected_step_attempt: input.expectedStepAttempt,
        target_status: input.targetStatus,
      },
    );
  }
  return readOutcome(
    data,
    ["stopped", "conflict", "invalid_input", "lease_lost", "not_found"],
    { task_id: input.taskId, step_id: input.stepId },
  );
}

export async function commitAgentTaskRetryTransition(
  db: Db,
  input: AgentTaskRetryTransitionInput,
) {
  const { data, error } = await db.rpc("retry_agent_task_state_v1", {
    p_task_id: input.taskId,
    p_user_id: input.userId,
    p_expected_task_status: input.expectedTaskStatus,
    p_step_id: input.stepId,
    p_expected_step_attempt: input.expectedStepAttempt,
    p_latest_checkpoint: input.latestCheckpoint,
  });
  if (error) {
    throw transitionError(
      `Failed to retry the Agent Task atomically: ${error.message}`,
      {
        task_id: input.taskId,
        step_id: input.stepId,
        expected_task_status: input.expectedTaskStatus,
        expected_step_attempt: input.expectedStepAttempt,
      },
    );
  }
  return readOutcome(
    data,
    ["retried", "conflict", "invalid_input", "lease_busy", "not_found"],
    { task_id: input.taskId, step_id: input.stepId },
  );
}

export async function commitAgentTaskInputTransition(
  db: Db,
  input: AgentTaskInputTransitionInput,
) {
  const { data, error } = await db.rpc("submit_agent_task_input_v1", {
    p_task_id: input.taskId,
    p_user_id: input.userId,
    p_step_id: input.stepId,
    p_expected_step_attempt: input.expectedStepAttempt,
    p_document_ids: input.documentIds,
    p_latest_checkpoint: input.latestCheckpoint,
  });
  if (error) {
    throw transitionError(
      `Failed to submit Agent Task input atomically: ${error.message}`,
      {
        task_id: input.taskId,
        step_id: input.stepId,
        expected_step_attempt: input.expectedStepAttempt,
        submission_id: input.submissionId,
      },
    );
  }
  return readOutcome(
    data,
    [
      "activated",
      "conflict",
      "context_invalid",
      "invalid_input",
      "lease_busy",
      "not_found",
      "source_invalid",
    ],
    {
      task_id: input.taskId,
      step_id: input.stepId,
      submission_id: input.submissionId,
    },
  );
}

export function agentTaskStateTransitionWasApplied(
  snapshot: {
    task: {
      status: string;
      current_step?: string | null;
      current_plan: Array<{ id: string; status: string; attempt: number }>;
    };
  } | null,
  input: AgentTaskStateTransitionInput,
) {
  if (!snapshot) return false;
  const step = snapshot.task.current_plan.find(
    (candidate) => candidate.id === input.stepId,
  );
  if (!step) return false;
  if (input.expectedTaskStatus === "queued") {
    return (
      step.status === "running" &&
      step.attempt === input.expectedStepAttempt + 1 &&
      snapshot.task.current_step === input.stepId &&
      ["running", "verifying"].includes(snapshot.task.status)
    );
  }
  return (
    step.status === "completed" &&
    step.attempt === input.expectedStepAttempt &&
    snapshot.task.current_step !== input.stepId &&
    ["running", "verifying", "completed"].includes(snapshot.task.status)
  );
}

export function agentTaskStopTransitionWasApplied(
  snapshot: {
    task: {
      status: string;
      current_step?: string | null;
      current_plan: Array<{ id: string; status: string; attempt: number }>;
    };
  } | null,
  input: AgentTaskStopTransitionInput,
) {
  if (!snapshot || snapshot.task.status !== input.targetStatus) return false;
  if (!input.stepId) return input.expectedTaskStatus === "queued";
  const step = snapshot.task.current_plan.find(
    (candidate) => candidate.id === input.stepId,
  );
  return Boolean(
    step &&
    step.status === "blocked" &&
    step.attempt === input.expectedStepAttempt &&
    snapshot.task.current_step === input.stepId,
  );
}

export function agentTaskRetryTransitionWasApplied(
  snapshot: {
    task: {
      status: string;
      current_step?: string | null;
      current_plan: Array<{ id: string; status: string; attempt: number }>;
    };
  } | null,
  input: AgentTaskRetryTransitionInput,
) {
  if (!snapshot || !["running", "verifying"].includes(snapshot.task.status)) {
    return Boolean(
      snapshot &&
      input.stepId === null &&
      snapshot.task.status === "queued" &&
      snapshot.task.current_step == null,
    );
  }
  if (!input.stepId || input.expectedStepAttempt == null) return false;
  const step = snapshot.task.current_plan.find(
    (candidate) => candidate.id === input.stepId,
  );
  return Boolean(
    step &&
    step.status === "running" &&
    step.attempt === input.expectedStepAttempt + 1 &&
    snapshot.task.current_step === input.stepId,
  );
}

export function agentTaskInputTransitionWasApplied(
  snapshot: {
    task: {
      status: string;
      current_step?: string | null;
      latest_checkpoint?: unknown;
      current_plan: Array<{ id: string; status: string; attempt: number }>;
    };
  } | null,
  input: AgentTaskInputTransitionInput,
) {
  if (!snapshot) return false;
  const step = snapshot.task.current_plan.find(
    (candidate) => candidate.id === input.stepId,
  );
  const checkpoint = snapshot.task.latest_checkpoint;
  const userInput =
    checkpoint && typeof checkpoint === "object" && !Array.isArray(checkpoint)
      ? (checkpoint as { user_input?: unknown }).user_input
      : null;
  const submissionId =
    userInput && typeof userInput === "object" && !Array.isArray(userInput)
      ? (userInput as { submission_id?: unknown }).submission_id
      : null;
  return Boolean(
    step &&
    step.status !== "pending" &&
    step.attempt === input.expectedStepAttempt + 1 &&
    submissionId === input.submissionId,
  );
}
