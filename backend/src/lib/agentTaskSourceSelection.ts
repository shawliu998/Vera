import { randomUUID } from "node:crypto";

import { readAgentStepCapabilityGrants } from "./agent-kernel/capability/stepCapability";
import { readAgentStepContracts } from "./agent-kernel/contracts/stepContract";
import {
  agentTaskInputTransitionWasApplied,
  AgentTaskStateTransitionError,
  commitAgentTaskInputTransition,
  type AgentTaskInputTransitionInput,
} from "./agent-kernel/execution/taskTransition";
import { assertAgentTaskExecutionRecovery } from "./agent-kernel/recovery/executionRecovery";
import {
  getAgentTaskSnapshot,
  type AgentStepStatus,
  type AgentTaskStatus,
  type AgentTaskSupplementalInput,
} from "./agentTasks";
import {
  PROVIDER_SOURCE_ACQUISITION_CHECKPOINT_KEY,
  providerSourceSelectionCheckpointSchema,
  providerSourceAcquisitionStateSchema,
  selectProviderSourceDiscoveries,
} from "./providerSourceAcquisitionState";
import { createServerSupabase } from "./supabase";

type Db = ReturnType<typeof createServerSupabase>;

export function prepareAgentTaskSourceSelectionTransition(
  snapshot: {
    task: {
      status: AgentTaskStatus;
      latest_checkpoint?: unknown;
      current_plan: Array<{
        id: string;
        status: AgentStepStatus;
        attempt: number;
      }>;
    };
  },
  discoveryRefs: string[],
  submittedAt = new Date().toISOString(),
  submissionId = randomUUID(),
) {
  if (snapshot.task.status !== "waiting_input") {
    throw new Error("Only a task waiting for source selection can continue");
  }
  const current = snapshot.task.current_plan.find(
    (step) => step.status === "blocked",
  );
  if (!current) {
    throw new Error("Source-selection Task has no recoverable Step");
  }
  const position = snapshot.task.current_plan.findIndex(
    (step) => step.id === current.id,
  );
  const contractRead = readAgentStepContracts(snapshot.task);
  const grantRead = readAgentStepCapabilityGrants(snapshot.task);
  const contract =
    contractRead.state === "valid"
      ? contractRead.contracts[position]
      : undefined;
  const grant =
    grantRead.state === "valid" ? grantRead.grants[position] : undefined;
  if (
    contract?.operation !== "source.acquire" ||
    grant?.operation !== "source.acquire" ||
    grant.step_position !== position
  ) {
    throw new Error(
      "Only a fixed source.acquire Step can accept provider discoveries",
    );
  }
  const previous =
    snapshot.task.latest_checkpoint &&
    typeof snapshot.task.latest_checkpoint === "object" &&
    !Array.isArray(snapshot.task.latest_checkpoint)
      ? { ...(snapshot.task.latest_checkpoint as Record<string, unknown>) }
      : null;
  if (!previous) throw new Error("Source acquisition checkpoint is missing");
  const priorState = providerSourceAcquisitionStateSchema.parse(
    previous[PROVIDER_SOURCE_ACQUISITION_CHECKPOINT_KEY],
  );
  const state = selectProviderSourceDiscoveries({
    state: priorState,
    discoveryRefs,
  });
  const nextAttempt = current.attempt + 1;
  delete previous.runner_retry;
  delete previous.planner_request;
  delete previous.required_input;
  delete previous.execution_pause;
  delete previous.user_input;
  const selectedRefs = state.selected_discovery_refs;
  const userInput = {
    submission_id: submissionId,
    step_id: current.id,
    attempt: nextAttempt,
    submitted_at: submittedAt,
    message: `Selected ${selectedRefs.length} provider source${selectedRefs.length === 1 ? "" : "s"} for bounded import.`,
    document_ids: [] as string[],
  } satisfies AgentTaskSupplementalInput;
  return {
    current,
    submissionId,
    status: (snapshot.task.current_plan.some(
      (step, index) => index > position && step.status === "pending",
    )
      ? "running"
      : "verifying") as AgentTaskStatus,
    checkpoint: {
      ...previous,
      step_id: current.id,
      iteration: nextAttempt,
      summary: userInput.message,
      created_at: submittedAt,
      user_input: userInput,
      source_selection: providerSourceSelectionCheckpointSchema.parse({
        schema_version: "provider_source_selection_v1",
        submission_id: submissionId,
        selected_discovery_refs: selectedRefs,
        submitted_at: submittedAt,
      }),
      [PROVIDER_SOURCE_ACQUISITION_CHECKPOINT_KEY]: state,
    },
  };
}

export async function submitAgentTaskSourceSelection(
  db: Db,
  taskId: string,
  userId: string,
  discoveryRefs: string[],
) {
  const snapshot = await getAgentTaskSnapshot(db, taskId, userId);
  if (!snapshot) return null;
  assertAgentTaskExecutionRecovery(snapshot.task);
  const transition = prepareAgentTaskSourceSelectionTransition(
    snapshot,
    discoveryRefs,
  );
  const atomicInput: AgentTaskInputTransitionInput = {
    taskId,
    userId,
    stepId: transition.current.id,
    expectedStepAttempt: transition.current.attempt,
    documentIds: [],
    latestCheckpoint: transition.checkpoint,
    submissionId: transition.submissionId,
  };
  let committed: Awaited<ReturnType<typeof commitAgentTaskInputTransition>>;
  try {
    committed = await commitAgentTaskInputTransition(db, atomicInput);
  } catch (error) {
    if (!(error instanceof AgentTaskStateTransitionError)) throw error;
    const recovered = await getAgentTaskSnapshot(db, taskId, userId);
    if (agentTaskInputTransitionWasApplied(recovered, atomicInput)) {
      return recovered;
    }
    throw error;
  }
  const recovered = await getAgentTaskSnapshot(db, taskId, userId);
  if (committed.outcome === "activated") {
    if (
      committed.taskStatus !== transition.status ||
      committed.currentStep !== transition.current.id
    ) {
      throw new Error(
        "The source-selection transition returned an unexpected Task phase",
      );
    }
    return recovered;
  }
  if (agentTaskInputTransitionWasApplied(recovered, atomicInput)) {
    return recovered;
  }
  if (committed.outcome === "lease_busy") {
    throw new Error(
      "The previous execution is still closing. Submit the source selection again in a moment.",
    );
  }
  if (!recovered) return null;
  throw new Error("Only one source selection can resume the blocked Task Step");
}
