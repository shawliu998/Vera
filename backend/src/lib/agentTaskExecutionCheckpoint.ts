import { mergeImmutableAgentTaskCheckpoint } from "./agent-kernel/context/matterContext";
import {
  AgentTaskStateTransitionError,
  commitAgentTaskCheckpointTransition,
  type AgentTaskCheckpointTransitionInput,
} from "./agent-kernel/execution/taskTransition";
import { createServerSupabase } from "./supabase";

type Db = ReturnType<typeof createServerSupabase>;

export async function recordAgentTaskExecutionCheckpoint(
  db: Db,
  input: {
    taskId: string;
    userId: string;
    leaseOwner: string;
    expectedTaskStatus: "running" | "verifying";
    step: { id: string; attempt: number };
    previousCheckpoint: unknown;
    summary: string;
    checkpointValues: Record<string, unknown> & {
      source_acquisition: unknown;
    };
    sourceDocumentIds?: string[];
  },
) {
  const createdAt = new Date().toISOString();
  const previous =
    input.previousCheckpoint &&
    typeof input.previousCheckpoint === "object" &&
    !Array.isArray(input.previousCheckpoint)
      ? { ...(input.previousCheckpoint as Record<string, unknown>) }
      : {};
  delete previous.execution_pause;
  delete previous.runner_retry;
  const transition: AgentTaskCheckpointTransitionInput = {
    taskId: input.taskId,
    userId: input.userId,
    leaseOwner: input.leaseOwner,
    expectedTaskStatus: input.expectedTaskStatus,
    stepId: input.step.id,
    expectedStepAttempt: input.step.attempt,
    latestCheckpoint: mergeImmutableAgentTaskCheckpoint(
      input.previousCheckpoint,
      {
        ...previous,
        step_id: input.step.id,
        iteration: input.step.attempt,
        summary: input.summary,
        created_at: createdAt,
        ...input.checkpointValues,
      },
    ),
    sourceDocumentIds: input.sourceDocumentIds ?? [],
  };
  const committed = await commitAgentTaskCheckpointTransition(db, transition);
  if (committed.outcome === "recorded") return true;
  if (
    committed.outcome === "conflict" ||
    committed.outcome === "lease_lost" ||
    committed.outcome === "not_found"
  ) {
    return false;
  }
  throw new AgentTaskStateTransitionError(
    "task_state_transition_conflict",
    "The Agent Task acquisition checkpoint was rejected.",
    {
      task_id: input.taskId,
      step_id: input.step.id,
      transition_outcome: committed.outcome,
    },
  );
}
