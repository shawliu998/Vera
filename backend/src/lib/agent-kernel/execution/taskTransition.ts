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
    throw new AgentTaskStateTransitionError(
      "task_state_transition_unavailable",
      `Failed to commit the Agent Task state transition: ${error.message}`,
      {
        task_id: input.taskId,
        step_id: input.stepId,
        expected_task_status: input.expectedTaskStatus,
        expected_step_attempt: input.expectedStepAttempt,
      },
    );
  }
  const row = firstRow(data) as Record<string, unknown> | null;
  const outcome = row?.outcome;
  if (
    outcome !== "advanced" &&
    outcome !== "conflict" &&
    outcome !== "invalid_input" &&
    outcome !== "lease_lost" &&
    outcome !== "not_found"
  ) {
    throw new AgentTaskStateTransitionError(
      "task_state_transition_unavailable",
      "The Agent Task state transition returned an invalid result.",
      {
        task_id: input.taskId,
        step_id: input.stepId,
        outcome: outcome ?? null,
      },
    );
  }
  return {
    outcome: outcome as AgentTaskStateTransitionOutcome,
    taskStatus: typeof row?.task_status === "string" ? row.task_status : null,
    currentStep:
      typeof row?.current_step === "string" ? row.current_step : null,
  };
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
