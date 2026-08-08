import {
  advanceAgentTask,
  applyAgentTaskPlan,
  deferAgentTaskForProvider,
  getAgentTaskSnapshot,
  linkAgentTaskArtifacts,
  pauseAgentTaskForContext,
  pauseAgentTaskForStateTransition,
  pauseAgentTaskForStepPostcondition,
  recordAgentTaskCheckpoint,
  stopAgentTask,
  verifierRepairAlreadyAttempted,
} from "./agentTasks";
import { recordAgentTaskExecutionCheckpoint } from "./agentTaskExecutionCheckpoint";
import {
  planAgentTask,
  readAgentTaskPlanningRequest,
} from "./agentTaskPlanner";
import {
  evaluateTaskDeliverables,
  requiredTaskDeliverables,
  taskDeliverablePurpose,
} from "./agentTaskDeliverables";
import {
  executeAgentStep,
  isAgentTaskExecutionInterrupted,
  isTransientModelError,
  type AgentStepExecutionResult,
  verifyTaskCitationLinks,
} from "./agentStepExecutor";
import {
  executeAgentSourceAcquisitionStep,
  providerSourceAcquisitionPauseSummary,
} from "./agentSourceAcquisitionExecutor";
import { compileCompletedAgentSourceContext } from "./agentSourceAcquisitionContext";
import { createServerSupabase } from "./supabase";
import { assertAgentTaskAssignmentContract } from "./agent-kernel/contracts/taskContract";
import {
  MatterContextInvalidError,
  readFixedMatterContext,
} from "./agent-kernel/context/matterContext";
import { assertFixedMatterContextCurrent } from "./agent-kernel/context/matterContextRepository";
import {
  assertAgentStepContracts,
  buildAgentStepReceipt,
  buildAgentStepReviewReceipt,
  readAgentStepContracts,
  type AgentStepPostcondition,
} from "./agent-kernel/contracts/stepContract";
import {
  assertAgentStepCapabilityGrants,
  readAgentStepCapabilityGrants,
} from "./agent-kernel/capability/stepCapability";
import { providerSourceAcquisitionStateSchema } from "./providerSourceAcquisitionState";
import {
  isAgentStepEffectTransitionError,
  readAgentStepEffectReceipts,
} from "./agent-kernel/effects/stepEffect";
import {
  AgentTaskLeaseBusyError,
  type AgentTaskLeaseGuard,
  withAgentTaskLease,
} from "./agent-kernel/execution/taskLease";
import {
  AgentTaskStateTransitionError,
  isAgentTaskStateTransitionError,
} from "./agent-kernel/execution/taskTransition";
import { AgentVerifierStructuredOutputError } from "./agent-kernel/verification/verifierCore";
import { ContractPlaybookStructuredOutputError } from "./agent-packs/contract/contractPlaybookPack";
import { ContractPlaybookWordMaterializationError } from "./agentContractPlaybookWordMaterializer";

type Db = ReturnType<typeof createServerSupabase>;
type Snapshot = NonNullable<Awaited<ReturnType<typeof getAgentTaskSnapshot>>>;

class AgentStepPostconditionError extends Error {
  constructor(
    readonly missing: string[],
    readonly facts: Record<string, unknown>,
  ) {
    super(`Step postconditions are not satisfied: ${missing.join(", ")}`);
    this.name = "AgentStepPostconditionError";
  }
}

async function buildCurrentStepReceipt(
  db: Db,
  snapshot: Snapshot,
  execution: Awaited<ReturnType<typeof executeAgentStep>>,
) {
  const contractRead = readAgentStepContracts(snapshot.task);
  if (contractRead.state === "legacy") return undefined;
  if (contractRead.state === "invalid") {
    throw new AgentStepPostconditionError(["step_contract_valid"], {
      reason: contractRead.reason,
    });
  }
  const stepIndex = snapshot.task.current_plan.findIndex(
    (step: { status: string }) => step.status === "running",
  );
  const step = snapshot.task.current_plan[stepIndex];
  const contract = contractRead.contracts[stepIndex];
  if (!step || !contract) {
    throw new AgentStepPostconditionError(["running_step_bound"], {
      step_index: stepIndex,
    });
  }

  const satisfied = new Set<AgentStepPostcondition>();
  if (execution.summary.trim()) satisfied.add("summary_present");

  const fixedContext = readFixedMatterContext(snapshot.task);
  const sourceVersionIds =
    fixedContext?.sources.map((source) => source.version_id) ?? [];
  if (
    contract.operation === "source.acquire" &&
    execution.checkpointValues?.source_acquisition
  ) {
    const acquisitionState = providerSourceAcquisitionStateSchema.parse(
      execution.checkpointValues.source_acquisition,
    );
    sourceVersionIds.push(
      ...acquisitionState.import_receipts.map((receipt) => receipt.version_id),
    );
  }
  if (
    contract.source_requirement.mode === "none" ||
    sourceVersionIds.length > 0
  ) {
    satisfied.add("source_versions_recorded");
  }

  const allArtifacts = [...snapshot.artifacts, ...execution.artifacts];
  const artifactIds: string[] = [];
  if (contract.output_expectation.kind === "artifact") {
    const expectation = contract.output_expectation;
    const deliverable = requiredTaskDeliverables(snapshot.task).find(
      (candidate) => candidate.key === expectation.deliverable_key,
    );
    const purpose = deliverable ? taskDeliverablePurpose(deliverable) : null;
    const artifact = purpose
      ? [...execution.artifacts]
          .reverse()
          .find(
            (candidate) =>
              candidate.purpose === purpose &&
              candidate.artifact_type === expectation.artifact_type,
          )
      : null;
    if (artifact) {
      artifactIds.push(artifact.artifact_id);
      satisfied.add("artifact_created");
      const { data: document, error } = await db
        .from("documents")
        .select("id,project_id,current_version_id")
        .eq("id", artifact.artifact_id)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (
        document &&
        document.project_id === snapshot.task.matter_id &&
        typeof document.current_version_id === "string" &&
        document.current_version_id
      ) {
        satisfied.add("artifact_current_version");
      }
    }
  }

  const hasFixedSources = Boolean(fixedContext?.sources.length);
  const authoritySatisfied = Boolean(
    fixedContext?.sources.some((source) => source.role === "authority"),
  );
  const citationsSatisfied =
    !contract.source_requirement.citations_required ||
    (execution.citationCheck.total > 0 &&
      execution.citationCheck.missing === 0);
  const sourceRequirementSatisfied =
    contract.source_requirement.mode === "none" ||
    (hasFixedSources &&
      (contract.source_requirement.mode !== "authority" ||
        authoritySatisfied) &&
      citationsSatisfied);
  if (sourceRequirementSatisfied) {
    satisfied.add("source_requirement_satisfied");
  }

  if (contract.capability === "verify") {
    const verification = execution.verification;
    artifactIds.push(
      ...(verification?.packet.deliverables.flatMap((deliverable) =>
        deliverable.artifact_id ? [deliverable.artifact_id] : [],
      ) ?? []),
    );
    if (verification?.result.dimensions.artifact_integrity === "pass") {
      satisfied.add("required_deliverables_current");
    }
    if (
      verification?.result.outcome === "clean_pass" &&
      verification.result.dimensions.workflow_completion === "pass" &&
      verification.result.dimensions.source_support === "pass"
    ) {
      satisfied.add("verifier_passed");
    }
  }

  const missing = contract.deterministic_postconditions.filter(
    (postcondition) => !satisfied.has(postcondition),
  );
  if (missing.length) {
    if (contract.capability === "verify") {
      return buildAgentStepReviewReceipt({
        contract,
        attempt: step.attempt,
        summary: execution.summary,
        sourceVersionIds,
        artifactIds,
        satisfiedPostconditions: [...satisfied],
      });
    }
    throw new AgentStepPostconditionError(missing, {
      step_id: step.id,
      step_position: stepIndex,
      attempt: step.attempt,
      capability: contract.capability,
      operation: contract.operation,
      artifact_ids: artifactIds,
      source_version_ids: sourceVersionIds,
    });
  }
  return buildAgentStepReceipt({
    contract,
    attempt: step.attempt,
    summary: execution.summary,
    sourceVersionIds,
    artifactIds,
    satisfiedPostconditions: [...satisfied],
  });
}

export function recoverCommittedStepEffectArtifact(
  snapshot: Snapshot,
  options?: { includePriorAttempt?: boolean },
) {
  const stepIndex = snapshot.task.current_plan.findIndex(
    (step: { status: string }) => step.status === "running",
  );
  const step = snapshot.task.current_plan[stepIndex];
  if (!step) return null;

  const contractRead = readAgentStepContracts(snapshot.task);
  if (contractRead.state !== "valid") return null;
  const contract = contractRead.contracts[stepIndex];
  if (!contract || contract.output_expectation.kind !== "artifact") return null;
  const expectation = contract.output_expectation;

  let receipts;
  try {
    receipts = readAgentStepEffectReceipts(step.result_data);
  } catch {
    return null;
  }
  const candidates = receipts.filter(
    (receipt) =>
      receipt.status === "committed" &&
      receipt.step_id === step.id &&
      (options?.includePriorAttempt
        ? receipt.attempt <= step.attempt
        : receipt.attempt === step.attempt) &&
      receipt.effect?.artifact_type === expectation.artifact_type,
  );
  const recoveredAttempt = candidates.reduce(
    (latest, receipt) => Math.max(latest, receipt.attempt),
    0,
  );
  const committed = candidates.filter(
    (receipt) => receipt.attempt === recoveredAttempt,
  );
  if (committed.length !== 1 || !committed[0].effect) return null;

  const deliverable = requiredTaskDeliverables(snapshot.task).find(
    (candidate) => candidate.key === expectation.deliverable_key,
  );
  if (!deliverable) return null;

  return {
    summary:
      "The declared Artifact was created and preserved. A later duplicate mutation request in the same Step was rejected by the idempotency fence; the preserved current Version will continue to deterministic verification and lawyer review.",
    artifacts: [
      {
        artifact_type: committed[0].effect.artifact_type,
        artifact_id: committed[0].effect.document_id,
        purpose: taskDeliverablePurpose(deliverable),
      },
    ],
    waitingForInput: false,
    citationCheck: { total: 0, relocatable: 0, missing: 0 },
    committedVersionId: committed[0].effect.version_id,
    receiptAttempt: committed[0].attempt,
  };
}

async function committedStepEffectIsCurrent(
  db: Db,
  snapshot: Snapshot,
  recovered: NonNullable<ReturnType<typeof recoverCommittedStepEffectArtifact>>,
) {
  const artifact = recovered.artifacts[0];
  const { data, error } = await db
    .from("documents")
    .select("id,project_id,status,current_version_id")
    .eq("id", artifact.artifact_id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return Boolean(
    data &&
    data.project_id === snapshot.task.matter_id &&
    data.status === "ready" &&
    data.current_version_id === recovered.committedVersionId,
  );
}

export function checkpointAllowsPriorEffectRecovery(checkpoint: unknown) {
  if (
    !checkpoint ||
    typeof checkpoint !== "object" ||
    Array.isArray(checkpoint)
  ) {
    return false;
  }
  const row = checkpoint as Record<string, unknown>;
  if (Object.hasOwn(row, "state_transition_pause")) {
    const pause = row.state_transition_pause;
    if (!pause || typeof pause !== "object" || Array.isArray(pause)) {
      return false;
    }
    const issue = (pause as Record<string, unknown>).issue;
    return Boolean(
      issue &&
      typeof issue === "object" &&
      !Array.isArray(issue) &&
      (issue as Record<string, unknown>).kind === "agent_execution_issue_v1" &&
      (issue as Record<string, unknown>).code ===
        "task_state_transition_conflict" &&
      (issue as Record<string, unknown>).recoverable === true,
    );
  }
  return (
    row.summary ===
      "The Step effect could not be published from the current Task state" ||
    row.summary ===
      "The server could not safely commit this Step transition. Existing work was preserved; resume after checking the execution service."
  );
}

async function completeVerifierForLawyerReview(input: {
  db: Db;
  taskId: string;
  userId: string;
  snapshot: Snapshot;
  execution: Awaited<ReturnType<typeof executeAgentStep>>;
  summary: string;
  leaseGuard: AgentTaskLeaseGuard;
}) {
  const result = { ...input.execution, summary: input.summary };
  const stepReceipt = await buildCurrentStepReceipt(
    input.db,
    input.snapshot,
    result,
  );
  return commitAgentTaskAdvance({
    db: input.db,
    taskId: input.taskId,
    userId: input.userId,
    leaseGuard: input.leaseGuard,
    result: { ...result, stepReceipt },
  });
}

async function commitAgentTaskAdvance(input: {
  db: Db;
  taskId: string;
  userId: string;
  leaseGuard: AgentTaskLeaseGuard;
  result?: Parameters<typeof advanceAgentTask>[3];
}) {
  try {
    return await advanceAgentTask(
      input.db,
      input.taskId,
      input.userId,
      input.result,
      { leaseOwner: input.leaseGuard.ownerToken },
    );
  } catch (error) {
    if (isAgentTaskStateTransitionError(error)) {
      return pauseAgentTaskForStateTransition(
        input.db,
        input.taskId,
        input.userId,
        error,
        { leaseOwner: input.leaseGuard.ownerToken },
      );
    }
    throw error;
  }
}

export function agentTaskExecutionErrorMessage(error: unknown) {
  const message =
    error instanceof Error ? error.message : "Model or tool execution failed";
  if (/deepseek api key/i.test(message)) {
    return "DeepSeek is unavailable. Configure a DeepSeek API key in Settings before running this task.";
  }
  if (/kimi api key/i.test(message)) {
    return "Kimi is unavailable. Configure a Kimi API key in Settings before running this task.";
  }
  if (/gemini api key/i.test(message)) {
    return "Gemini is unavailable. Configure a Gemini API key in Settings before running this task.";
  }
  if (/api key is not configured/i.test(message)) {
    return "The selected model is unavailable. Configure its API key in Settings before running this task.";
  }
  if (isTransientModelError(error)) {
    return "The selected model is temporarily unavailable.";
  }
  return message;
}

export function agentTaskStatusAllowsExecution(
  status: string,
  phase: "start" | "continue",
) {
  return phase === "start"
    ? status === "queued"
    : ["running", "verifying"].includes(status);
}

async function taskCanContinue(
  db: Db,
  taskId: string,
  userId: string,
  phase: "start" | "continue" = "continue",
) {
  const snapshot = await getAgentTaskSnapshot(db, taskId, userId);
  return {
    snapshot,
    active: Boolean(
      snapshot && agentTaskStatusAllowsExecution(snapshot.task.status, phase),
    ),
  };
}

export async function advanceAgentTaskExecution(input: {
  db: Db;
  taskId: string;
  userId: string;
  userEmail?: string;
  throwOnLeaseBusy?: boolean;
  leaseGuard?: AgentTaskLeaseGuard;
}): Promise<Snapshot | null> {
  const { db, taskId, userId, userEmail } = input;
  const executionCanContinue = async (
    phase: "start" | "continue" = "continue",
  ) => {
    if (input.leaseGuard && !(await input.leaseGuard.verifyOwner())) {
      return {
        snapshot: await getAgentTaskSnapshot(db, taskId, userId),
        active: false,
      };
    }
    return taskCanContinue(db, taskId, userId, phase);
  };
  const shouldContinue = async () => (await executionCanContinue()).active;
  const current = await getAgentTaskSnapshot(db, taskId, userId);
  if (!current) return null;
  assertAgentTaskAssignmentContract(current.task);
  assertAgentStepContracts(current.task);
  assertAgentStepCapabilityGrants(current.task);
  let fixedMatterContext;
  try {
    fixedMatterContext = readFixedMatterContext(current.task);
    if (fixedMatterContext) {
      await assertFixedMatterContextCurrent(db, fixedMatterContext);
      const linkedSourceIds = current.artifacts
        .filter(
          (artifact) =>
            artifact.artifact_type === "document" &&
            artifact.purpose === "Source document",
        )
        .map((artifact) => artifact.artifact_id);
      const fixedSourceIds = fixedMatterContext.sources.map(
        (source) => source.document_id,
      );
      if (
        linkedSourceIds.length !== fixedSourceIds.length ||
        fixedSourceIds.some(
          (documentId) => !linkedSourceIds.includes(documentId),
        )
      ) {
        throw new MatterContextInvalidError(
          "matter_context_scope_mismatch",
          "Linked task sources do not match the fixed Matter context.",
          {
            fixed_document_ids: fixedSourceIds,
            linked_document_ids: linkedSourceIds,
          },
        );
      }
      const linkedWorkflowId = current.artifacts.find(
        (artifact) =>
          artifact.artifact_type === "workflow_run" &&
          artifact.purpose.startsWith("Selected workflow:"),
      )?.artifact_id;
      if (
        (linkedWorkflowId ?? null) !== (fixedMatterContext.workflow?.id ?? null)
      ) {
        throw new MatterContextInvalidError(
          "matter_context_workflow_mismatch",
          "Linked Workflow does not match the fixed Workflow snapshot.",
          {
            fixed_workflow_id: fixedMatterContext.workflow?.id ?? null,
            linked_workflow_id: linkedWorkflowId ?? null,
          },
        );
      }
    }
  } catch (error) {
    if (error instanceof MatterContextInvalidError) {
      return pauseAgentTaskForContext(db, taskId, userId, error);
    }
    throw error;
  }
  if (!input.leaseGuard) {
    const lease = await withAgentTaskLease(
      {
        db,
        taskId,
        userId,
        getSnapshot: () => getAgentTaskSnapshot(db, taskId, userId),
      },
      {},
      (leaseGuard) =>
        advanceAgentTaskExecution({
          ...input,
          leaseGuard,
        }),
    );
    if (lease.status === "unavailable") {
      if (lease.reason === "busy" && input.throwOnLeaseBusy) {
        throw new AgentTaskLeaseBusyError();
      }
      return lease.snapshot as Snapshot | null;
    }
    return lease.result;
  }
  if (current.task.status === "queued") {
    const planningRequest = readAgentTaskPlanningRequest(current.task);
    if (planningRequest) {
      const planned = await planAgentTask({
        db,
        userId,
        userEmail,
        matterId: current.task.matter_id,
        goal: current.task.goal,
        model: current.task.execution_model,
        request: planningRequest,
        contextManifest: fixedMatterContext,
      });
      const beforePlanWrite = await executionCanContinue();
      if (!beforePlanWrite.active) return beforePlanWrite.snapshot;
      const updated = await applyAgentTaskPlan(
        db,
        taskId,
        userId,
        planned.plan,
      );
      if (!updated) return null;
    }
    const beforeStart = await executionCanContinue("start");
    if (!beforeStart.active) return beforeStart.snapshot;
    return commitAgentTaskAdvance({
      db,
      taskId,
      userId,
      leaseGuard: input.leaseGuard,
    });
  }
  if (!["running", "verifying"].includes(current.task.status)) {
    return current;
  }

  const priorCommittedEffect = recoverCommittedStepEffectArtifact(current, {
    includePriorAttempt: true,
  });
  const runningStep = current.task.current_plan.find(
    (step: { status: string }) => step.status === "running",
  );
  if (
    priorCommittedEffect &&
    runningStep &&
    priorCommittedEffect.receiptAttempt < runningStep.attempt &&
    checkpointAllowsPriorEffectRecovery(current.task.latest_checkpoint) &&
    (await committedStepEffectIsCurrent(db, current, priorCommittedEffect))
  ) {
    const stepReceipt = await buildCurrentStepReceipt(
      db,
      current,
      priorCommittedEffect,
    );
    return commitAgentTaskAdvance({
      db,
      taskId,
      userId,
      leaseGuard: input.leaseGuard,
      result: { ...priorCommittedEffect, stepReceipt },
    });
  }

  let execution: AgentStepExecutionResult;
  try {
    const stepIndex = current.task.current_plan.findIndex(
      (step: { status: string }) => step.status === "running",
    );
    const contractRead = readAgentStepContracts(current.task);
    const grantRead = readAgentStepCapabilityGrants(current.task);
    const contract =
      contractRead.state === "valid"
        ? contractRead.contracts[stepIndex]
        : undefined;
    const grant =
      grantRead.state === "valid" ? grantRead.grants[stepIndex] : undefined;
    if (contract?.operation === "source.acquire") {
      if (!runningStep || !grant) {
        throw new Error(
          "Source acquisition Step is missing its fixed execution grant",
        );
      }
      const acquisition = await executeAgentSourceAcquisitionStep({
        db,
        snapshot: current,
        userId,
        step: runningStep,
        contract,
        grant,
        shouldContinue,
        dependencies: {
          recordProgress: (state) =>
            (async () => {
              let checkpointValues: Record<string, unknown> & {
                source_acquisition: unknown;
              } = { source_acquisition: state };
              let sourceDocumentIds: string[] = [];
              if (state.phase === "completed") {
                if (!fixedMatterContext) {
                  throw new Error(
                    "Completed source acquisition has no fixed Matter context",
                  );
                }
                const completedContext =
                  await compileCompletedAgentSourceContext({
                    db,
                    previousCheckpoint: current.task.latest_checkpoint,
                    previousContext: fixedMatterContext,
                    acquisitionState: state,
                  });
                sourceDocumentIds = completedContext.sourceDocumentIds;
                checkpointValues = completedContext.checkpointValues;
              }
              return recordAgentTaskExecutionCheckpoint(db, {
                taskId,
                userId,
                leaseOwner: input.leaseGuard!.ownerToken,
                expectedTaskStatus: current.task.status as
                  | "running"
                  | "verifying",
                step: runningStep,
                previousCheckpoint: current.task.latest_checkpoint,
                summary:
                  state.phase === "search_pending"
                    ? `Source search page committed; continuing page ${state.next_page}.`
                    : state.phase === "selection_required"
                      ? `Source search completed with ${state.discoveries.length} bounded result${state.discoveries.length === 1 ? "" : "s"}; waiting for lawyer selection.`
                      : state.phase === "read_pending"
                        ? `Imported ${state.import_receipts.length} of ${state.selected_discovery_refs.length} selected provider sources.`
                        : state.phase === "completed"
                          ? `Imported all ${state.import_receipts.length} selected provider sources.`
                          : "Source acquisition preserved for lawyer review.",
                checkpointValues,
                sourceDocumentIds,
              });
            })(),
        },
      });
      if (acquisition.kind === "provider_pause") {
        const summary = providerSourceAcquisitionPauseSummary({
          providerId: grant.read_only_connector_pins[0]?.provider_id ?? "",
          classification: acquisition.classification,
        });
        return deferAgentTaskForProvider(db, taskId, userId, summary, {
          classification: acquisition.classification,
          leaseOwner: input.leaseGuard.ownerToken,
          checkpointValues: acquisition.checkpointValues,
        });
      }
      execution = acquisition.result;
    } else {
      execution = await executeAgentStep({
        db,
        snapshot: current,
        userId,
        userEmail,
        leaseOwner: input.leaseGuard.ownerToken,
        shouldContinue,
      });
    }
  } catch (error) {
    if (isAgentTaskExecutionInterrupted(error)) {
      return getAgentTaskSnapshot(db, taskId, userId);
    }
    if (isAgentTaskStateTransitionError(error)) {
      return pauseAgentTaskForStateTransition(db, taskId, userId, error, {
        leaseOwner: input.leaseGuard.ownerToken,
      });
    }
    if (isAgentStepEffectTransitionError(error)) {
      if (error.outcome === "lease_lost") {
        return getAgentTaskSnapshot(db, taskId, userId);
      }
      const recoveredSnapshot = await getAgentTaskSnapshot(db, taskId, userId);
      const recovered = recoveredSnapshot
        ? recoverCommittedStepEffectArtifact(recoveredSnapshot)
        : null;
      if (
        recoveredSnapshot &&
        recovered &&
        (await committedStepEffectIsCurrent(db, recoveredSnapshot, recovered))
      ) {
        const stepReceipt = await buildCurrentStepReceipt(
          db,
          recoveredSnapshot,
          recovered,
        );
        return commitAgentTaskAdvance({
          db,
          taskId,
          userId,
          leaseGuard: input.leaseGuard,
          result: { ...recovered, stepReceipt },
        });
      }
      return pauseAgentTaskForStateTransition(
        db,
        taskId,
        userId,
        new AgentTaskStateTransitionError(
          "task_state_transition_conflict",
          error.message,
          error.facts,
        ),
        { leaseOwner: input.leaseGuard.ownerToken },
      );
    }
    if (error instanceof ContractPlaybookWordMaterializationError) {
      return pauseAgentTaskForStateTransition(
        db,
        taskId,
        userId,
        new AgentTaskStateTransitionError(
          "task_state_transition_conflict",
          "Contract Word materialization stopped before an unsafe or unprovable mutation. Existing sources and completed effects were preserved for bounded lawyer review.",
          {
            contract_materialization_issue_code: error.issueCode,
            ...error.facts,
          },
        ),
        { leaseOwner: input.leaseGuard.ownerToken },
      );
    }
    if (
      error instanceof AgentVerifierStructuredOutputError ||
      error instanceof ContractPlaybookStructuredOutputError
    ) {
      return deferAgentTaskForProvider(
        db,
        taskId,
        userId,
        error instanceof ContractPlaybookStructuredOutputError
          ? "The Contract Playbook analysis could not be mechanically validated after one bounded correction. Existing work was preserved and this Step can be resumed."
          : "The verifier response could not be mechanically validated. Existing deliverables were preserved and this Step can be resumed.",
        {
          classification: "provider_structured_output",
          leaseOwner: input.leaseGuard.ownerToken,
        },
      );
    }
    if (isTransientModelError(error)) throw error;
    return stopAgentTask(db, taskId, userId, {
      status: "failed",
      summary: agentTaskExecutionErrorMessage(error),
      leaseOwner: input.leaseGuard.ownerToken,
    });
  }

  const afterExecution = await executionCanContinue();
  if (!afterExecution.active) return afterExecution.snapshot;
  if (execution.waitingForInput) {
    return stopAgentTask(db, taskId, userId, {
      status: "waiting_input",
      summary: execution.summary,
      requiredInput: execution.requiredInput,
      checkpointValues: execution.checkpointValues,
      leaseOwner: input.leaseGuard.ownerToken,
    });
  }

  if (
    current.task.status === "verifying" &&
    execution.verification?.result.outcome === "review_required"
  ) {
    return completeVerifierForLawyerReview({
      db,
      taskId,
      userId,
      snapshot: current,
      execution,
      summary: execution.summary,
      leaseGuard: input.leaseGuard,
    });
  }

  // Unversioned Tasks retain their historical verifier compatibility path.
  // Every Task with a fixed Step Contract uses the structured current-Artifact
  // packet above and cannot enter this free-text GAP/repair branch.
  if (current.task.status === "verifying" && !execution.verification) {
    execution.citationCheck = await verifyTaskCitationLinks(
      db,
      current,
      userId,
    );
    const allArtifacts = [...current.artifacts, ...execution.artifacts];
    const deliverableState = async () =>
      evaluateTaskDeliverables(db, { ...current, artifacts: allArtifacts });
    const summaryHasGap = /\bGAP\b/i.test(execution.summary);
    const hasSources = current.artifacts.some(
      (artifact) =>
        artifact.artifact_type === "document" &&
        artifact.purpose === "Source document",
    );
    const citationGap =
      hasSources &&
      (execution.citationCheck.total === 0 ||
        execution.citationCheck.missing > 0);
    const citationReason =
      execution.citationCheck.total === 0
        ? "no source citations were available for relocation checks"
        : `${execution.citationCheck.missing} citation(s) could not be relocated`;
    const initialDeliverables = await deliverableState();
    const incompleteSteps = current.task.current_plan
      .slice(0, -1)
      .filter((step: { status: string }) => step.status !== "completed")
      .map((step: { title: string }) => step.title);
    const initialGaps = [
      ...initialDeliverables.missing,
      ...initialDeliverables.outsideMatter.map(
        (title) => `${title} is outside the Matter`,
      ),
      ...incompleteSteps.map((title: string) => `${title} is incomplete`),
    ];

    if (initialGaps.length || summaryHasGap || citationGap) {
      const reasons = [
        initialGaps.length ? initialGaps.join("; ") : null,
        summaryHasGap ? "the verifier reported one or more GAP findings" : null,
        citationGap ? citationReason : null,
      ]
        .filter(Boolean)
        .join("; ");
      if (verifierRepairAlreadyAttempted(current.task)) {
        return completeVerifierForLawyerReview({
          db,
          taskId,
          userId,
          snapshot: current,
          execution,
          summary: `Automated verification still requires lawyer review after one bounded repair: ${reasons}. Existing deliverables were preserved.`,
          leaseGuard: input.leaseGuard,
        });
      }

      await recordAgentTaskCheckpoint(
        db,
        taskId,
        userId,
        `Verifier repair 1/1 started: ${reasons}.`,
      );
      const explicitRepairTargets = initialDeliverables.resolved.filter(
        ({ deliverable }) => {
          const label =
            deliverable.title || taskDeliverablePurpose(deliverable);
          return (
            initialDeliverables.missing.includes(label) ||
            initialDeliverables.outsideMatter.includes(label)
          );
        },
      );
      const repairTarget =
        explicitRepairTargets.length === 1
          ? explicitRepairTargets[0].deliverable
          : explicitRepairTargets.length === 0 &&
              initialDeliverables.required.length === 1
            ? initialDeliverables.required[0]
            : null;
      if (!repairTarget) {
        return completeVerifierForLawyerReview({
          db,
          taskId,
          userId,
          snapshot: current,
          execution,
          summary:
            "Verification preserved the existing deliverables but could not prove one unique document target for automatic repair. Lawyer review is required.",
          leaseGuard: input.leaseGuard,
        });
      }
      let repair;
      let recheck;
      try {
        repair = await executeAgentStep({
          db,
          snapshot: current,
          userId,
          userEmail,
          leaseOwner: input.leaseGuard.ownerToken,
          shouldContinue,
          instructionOverride: `This is the single permitted repair pass. Repair: ${reasons}. Re-read the sources, update or recreate only the affected deliverables, and preserve lawyer-review status.`,
          repairArtifactPurpose: taskDeliverablePurpose(repairTarget),
        });
        const afterRepair = await executionCanContinue();
        if (!afterRepair.active) return afterRepair.snapshot;
        await linkAgentTaskArtifacts(db, taskId, userId, repair.artifacts);
        const repairedSnapshot = {
          ...current,
          artifacts: [
            ...current.artifacts,
            ...repair.artifacts.map((artifact) => ({
              task_id: taskId,
              ...artifact,
            })),
          ],
        };
        recheck = await executeAgentStep({
          db,
          snapshot: repairedSnapshot,
          userId,
          userEmail,
          leaseOwner: input.leaseGuard.ownerToken,
          shouldContinue,
          instructionOverride:
            "Re-run the five verifier checks after the one permitted repair. Do not repair again. Return PASS or GAP for every check.",
        });
        const afterRecheck = await executionCanContinue();
        if (!afterRecheck.active) return afterRecheck.snapshot;
        recheck.citationCheck = await verifyTaskCitationLinks(
          db,
          {
            ...repairedSnapshot,
            artifacts: [
              ...repairedSnapshot.artifacts,
              ...recheck.artifacts.map((artifact) => ({
                task_id: taskId,
                ...artifact,
              })),
            ],
          },
          userId,
        );
      } catch (error) {
        if (isAgentTaskExecutionInterrupted(error)) {
          return getAgentTaskSnapshot(db, taskId, userId);
        }
        if (isTransientModelError(error)) throw error;
        return stopAgentTask(db, taskId, userId, {
          status: "failed",
          summary: agentTaskExecutionErrorMessage(error),
          leaseOwner: input.leaseGuard.ownerToken,
        });
      }

      allArtifacts.push(...repair.artifacts);
      const remainingState = await deliverableState();
      const remaining = [
        ...remainingState.missing,
        ...remainingState.outsideMatter.map(
          (title) => `${title} is outside the Matter`,
        ),
      ];
      if (
        remaining.length ||
        /\bGAP\b/i.test(recheck.summary) ||
        (hasSources &&
          (recheck.citationCheck.total === 0 ||
            recheck.citationCheck.missing > 0))
      ) {
        const missing = remaining.length
          ? remaining.join(" and ")
          : "one or more verifier checks";
        return completeVerifierForLawyerReview({
          db,
          taskId,
          userId,
          snapshot: current,
          execution: {
            ...recheck,
            artifacts: [
              ...execution.artifacts,
              ...repair.artifacts,
              ...recheck.artifacts,
            ],
          },
          summary: `Automated verification still requires lawyer review after one bounded repair: ${missing}. Existing deliverables were preserved.`,
          leaseGuard: input.leaseGuard,
        });
      }
      execution = {
        ...recheck,
        summary: `Verifier repair 1/1 completed.\n${recheck.summary}`,
        artifacts: [
          ...execution.artifacts,
          ...repair.artifacts,
          ...recheck.artifacts,
        ],
      };
    } else if (hasSources && execution.citationCheck.total === 0) {
      return completeVerifierForLawyerReview({
        db,
        taskId,
        userId,
        snapshot: current,
        execution,
        summary:
          "Deterministic citation relocation could not be completed. Existing deliverables were preserved for lawyer review.",
        leaseGuard: input.leaseGuard,
      });
    }
  }

  const beforeCommit = await executionCanContinue();
  if (!beforeCommit.active) return beforeCommit.snapshot;
  try {
    const stepReceipt = await buildCurrentStepReceipt(db, current, execution);
    return commitAgentTaskAdvance({
      db,
      taskId,
      userId,
      leaseGuard: input.leaseGuard,
      result: { ...execution, stepReceipt },
    });
  } catch (error) {
    if (error instanceof AgentStepPostconditionError) {
      return pauseAgentTaskForStepPostcondition(db, taskId, userId, {
        summary: `${error.message}. Existing work was preserved for a resumable review.`,
        facts: error.facts,
        artifacts: execution.artifacts,
        leaseOwner: input.leaseGuard.ownerToken,
      });
    }
    throw error;
  }
}
