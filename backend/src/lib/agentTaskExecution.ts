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
  AgentModelRequestTimeoutError,
  completeAgentTextWithQueueRetry,
  buildAgentVerifierRepairMutationIdentity,
  executeAgentStep,
  isAgentTaskExecutionInterrupted,
  isTransientModelError,
  type AgentStepExecutionResult,
  type AgentStepRepairDirective,
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
import {
  AGENT_VERIFICATION_REPAIR_KEY,
  buildAgentVerificationRepairReceiptV1,
  coordinateOneAgentVerificationRepairV1,
  decideAgentVerificationRepairV1,
  readAgentVerificationRepairReceiptV1,
} from "./agent-kernel/verification/repairEligibility";
import { ContractPlaybookStructuredOutputError } from "./agent-packs/contract/contractPlaybookPack";
import { ContractPlaybookWordMaterializationError } from "./agentContractPlaybookWordMaterializer";
import {
  buildAgentTaskProviderDiagnosticV1,
  classifyAgentTaskProviderProtocolError,
} from "./agentTaskRetryPolicy";
import {
  executeLitigationEvidenceInventoryStep,
  isLitigationEvidenceInventoryCreationStep,
} from "./agentLitigationEvidenceInventoryStepExecutor";
import { LitigationEvidenceInventoryDownstreamContextError } from "./agentLitigationEvidenceInventoryDownstreamContext";
import { readLitigationEvidenceInventoryContext } from "./agent-packs/litigation/litigationEvidenceInventoryContext";
import { getUserModelSettings } from "./userSettings";
import { DEFAULT_MAIN_MODEL, providerForModel } from "./llm";

type Db = ReturnType<typeof createServerSupabase>;
type Snapshot = NonNullable<Awaited<ReturnType<typeof getAgentTaskSnapshot>>>;

export class AgentStepPostconditionError extends Error {
  constructor(
    readonly missing: string[],
    readonly facts: Record<string, unknown>,
  ) {
    super(`Step postconditions are not satisfied: ${missing.join(", ")}`);
    this.name = "AgentStepPostconditionError";
  }
}

export async function buildCurrentStepReceipt(
  db: Db,
  snapshot: Snapshot,
  userId: string,
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
      if (artifact.artifact_type === "tabular_review") {
        const { data: review, error } = await db
          .from("tabular_reviews")
          .select("id,project_id,user_id,row_protocol")
          .eq("id", artifact.artifact_id)
          .maybeSingle();
        if (error) throw new Error(error.message);
        if (
          review &&
          review.project_id === snapshot.task.matter_id &&
          review.user_id === userId &&
          review.row_protocol === "document_rows"
        ) {
          satisfied.add("artifact_current_version");
        }
      } else {
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
    const verifiedArtifacts = verification?.verifiedArtifacts ?? [];
    const controlledDeliverables: Array<
      | {
          kind: "draft";
          documentId: string;
          versionId: string;
          acceptedViewSha256: string;
        }
      | {
          kind: "tabular_review";
          reviewId: string;
          acceptedViewSha256: string;
        }
    > = [];
    for (const deliverable of verification?.packet.deliverables ?? []) {
      if (
        deliverable.artifact_type === "draft" &&
        deliverable.document_id !== null &&
        deliverable.current_version_id !== null &&
        deliverable.accepted_view_sha256 !== null
      ) {
        controlledDeliverables.push({
          kind: "draft",
          documentId: deliverable.document_id,
          versionId: deliverable.current_version_id,
          acceptedViewSha256: deliverable.accepted_view_sha256,
        });
        continue;
      }
      if (
        deliverable.artifact_type === "tabular_review" &&
        deliverable.artifact_id !== null &&
        deliverable.accepted_view_sha256 !== null
      ) {
        controlledDeliverables.push({
          kind: "tabular_review",
          reviewId: deliverable.artifact_id,
          acceptedViewSha256: deliverable.accepted_view_sha256,
        });
      }
    }
    const matchesExactlyOnce = controlledDeliverables.every((deliverable) => {
      const matches = verifiedArtifacts.filter((artifact) =>
        deliverable.kind === "draft"
          ? artifact.kind === "agent_verified_draft_artifact_v1" &&
            artifact.document_id === deliverable.documentId &&
            artifact.version_id === deliverable.versionId &&
            artifact.accepted_view_sha256 === deliverable.acceptedViewSha256
          : artifact.kind === "agent_verified_tabular_artifact_v1" &&
            artifact.review_id === deliverable.reviewId &&
            artifact.accepted_view_sha256 === deliverable.acceptedViewSha256,
      );
      return matches.length === 1;
    });
    const hasNoExtraIdentity = verifiedArtifacts.every((artifact) =>
      controlledDeliverables.some((deliverable) =>
        deliverable.kind === "draft"
          ? artifact.kind === "agent_verified_draft_artifact_v1" &&
            artifact.document_id === deliverable.documentId &&
            artifact.version_id === deliverable.versionId &&
            artifact.accepted_view_sha256 === deliverable.acceptedViewSha256
          : artifact.kind === "agent_verified_tabular_artifact_v1" &&
            artifact.review_id === deliverable.reviewId &&
            artifact.accepted_view_sha256 === deliverable.acceptedViewSha256,
      ),
    );
    if (
      verification?.result.outcome === "clean_pass" &&
      (!matchesExactlyOnce ||
        !hasNoExtraIdentity ||
        controlledDeliverables.length !== verifiedArtifacts.length)
    ) {
      throw new AgentStepPostconditionError(["verified_artifact_identity"], {
        step_id: step.id,
        attempt: step.attempt,
        reason:
          "The final verifier identity does not exactly match every readable controlled deliverable.",
        expected_identity_count: controlledDeliverables.length,
        actual_identity_count: verifiedArtifacts.length,
      });
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
        verifiedArtifacts: execution.verification?.verifiedArtifacts ?? [],
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
    verifiedArtifacts:
      contract.capability === "verify"
        ? (execution.verification?.verifiedArtifacts ?? [])
        : undefined,
  });
}

/**
 * Classifies the one final Step transition before any Task state write. A
 * verifier identity mismatch is a recoverable postcondition pause, while a
 * review receipt advances normally into the existing lawyer-review path.
 */
export async function prepareCurrentAgentStepTransition(
  db: Db,
  snapshot: Snapshot,
  userId: string,
  execution: Awaited<ReturnType<typeof executeAgentStep>>,
): Promise<
  | {
      kind: "advance";
      stepReceipt: Awaited<ReturnType<typeof buildCurrentStepReceipt>>;
    }
  | {
      kind: "postcondition_pause";
      summary: string;
      facts: Record<string, unknown>;
      artifacts: Awaited<ReturnType<typeof executeAgentStep>>["artifacts"];
    }
> {
  try {
    return {
      kind: "advance",
      stepReceipt: await buildCurrentStepReceipt(
        db,
        snapshot,
        userId,
        execution,
      ),
    };
  } catch (error) {
    if (!(error instanceof AgentStepPostconditionError)) throw error;
    return {
      kind: "postcondition_pause",
      summary: `${error.message}. Existing work was preserved for a resumable review.`,
      facts: error.facts,
      artifacts: execution.artifacts,
    };
  }
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

  // A committed Tabular effect only establishes the fixed task-owned Review.
  // It is not the completed legal work in that Review, so it cannot advance
  // the Step through generic committed-effect recovery. Word effects remain
  // recoverable as before.
  if (expectation.artifact_type === "tabular_review") return null;

  let candidates: Array<{
    attempt: number;
    artifactType: "draft";
    artifactId: string;
    versionId: string | null;
  }>;
  try {
    candidates = readAgentStepEffectReceipts(step.result_data)
      .filter(
        (receipt) =>
          receipt.status === "committed" &&
          receipt.step_id === step.id &&
          (options?.includePriorAttempt
            ? receipt.attempt <= step.attempt
            : receipt.attempt === step.attempt) &&
          receipt.effect?.artifact_type === expectation.artifact_type,
      )
      .map((receipt) => ({
        attempt: receipt.attempt,
        artifactType: "draft" as const,
        artifactId: receipt.effect!.document_id,
        versionId: receipt.effect!.version_id,
      }));
  } catch {
    return null;
  }
  const recoveredAttempt = candidates.reduce(
    (latest, receipt) => Math.max(latest, receipt.attempt),
    0,
  );
  const committed = candidates.filter(
    (receipt) => receipt.attempt === recoveredAttempt,
  );
  if (committed.length !== 1) return null;

  const deliverable = requiredTaskDeliverables(snapshot.task).find(
    (candidate) => candidate.key === expectation.deliverable_key,
  );
  if (!deliverable) return null;

  return {
    summary:
      "The declared Artifact was created and preserved. A later duplicate mutation request in the same Step was rejected by the idempotency fence; the preserved Artifact will continue to deterministic verification and lawyer review.",
    artifacts: [
      {
        artifact_type: committed[0].artifactType,
        artifact_id: committed[0].artifactId,
        purpose: taskDeliverablePurpose(deliverable),
      },
    ],
    waitingForInput: false,
    citationCheck: { total: 0, relocatable: 0, missing: 0 },
    committedVersionId: committed[0].versionId,
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

export function committedStepEffectRecoveryAllowed(input: {
  receiptAttempt: number;
  stepAttempt: number;
  checkpoint: unknown;
}) {
  if (input.receiptAttempt === input.stepAttempt) return true;
  return (
    input.receiptAttempt < input.stepAttempt &&
    checkpointAllowsPriorEffectRecovery(input.checkpoint)
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
    input.userId,
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

function providerDiagnosticForTaskError(error: unknown, snapshot: Snapshot) {
  const model =
    typeof snapshot.task.execution_model === "string" &&
    snapshot.task.execution_model.trim()
      ? snapshot.task.execution_model
      : DEFAULT_MAIN_MODEL;
  let provider: string | null = null;
  try {
    provider = providerForModel(model);
  } catch {
    // Invalid legacy model identifiers remain fail-closed elsewhere, but must
    // not suppress the bounded provider diagnostic attached to a pause.
  }
  return buildAgentTaskProviderDiagnosticV1(error, { provider, model });
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
  const leaseGuard = input.leaseGuard;
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
    committedStepEffectRecoveryAllowed({
      receiptAttempt: priorCommittedEffect.receiptAttempt,
      stepAttempt: runningStep.attempt,
      checkpoint: current.task.latest_checkpoint,
    }) &&
    (await committedStepEffectIsCurrent(db, current, priorCommittedEffect))
  ) {
    const stepReceipt = await buildCurrentStepReceipt(
      db,
      current,
      userId,
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
    const litigationEvidenceContext = readLitigationEvidenceInventoryContext(
      current.task.latest_checkpoint &&
        typeof current.task.latest_checkpoint === "object" &&
        !Array.isArray(current.task.latest_checkpoint)
        ? (current.task.latest_checkpoint as Record<string, unknown>)
            .litigation_evidence_inventory_context
        : undefined,
    );
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
    } else if (
      isLitigationEvidenceInventoryCreationStep({
        workflowId: fixedMatterContext?.workflow?.id,
        contract,
      }) &&
      litigationEvidenceContext
    ) {
      if (
        !runningStep ||
        !contract ||
        contract.output_expectation.kind !== "artifact"
      ) {
        throw new Error(
          "Litigation Evidence Inventory Step is missing its fixed execution contract",
        );
      }
      const deliverableKey = contract.output_expectation.deliverable_key;
      const deliverable = requiredTaskDeliverables(current.task).find(
        (candidate) => candidate.key === deliverableKey,
      );
      if (!deliverable) {
        throw new Error(
          "Litigation Evidence Inventory has no unique declared deliverable",
        );
      }
      const { api_keys: apiKeys } = await getUserModelSettings(userId, db);
      const model =
        typeof current.task.execution_model === "string" &&
        current.task.execution_model
          ? current.task.execution_model
          : DEFAULT_MAIN_MODEL;
      const litigation = await executeLitigationEvidenceInventoryStep({
        db,
        snapshot: current,
        userId,
        leaseOwner: input.leaseGuard.ownerToken,
        step: runningStep,
        context: litigationEvidenceContext,
        declaredTaskDeliverablePurpose: taskDeliverablePurpose(deliverable),
        model,
        apiKeys,
        complete: (request) =>
          completeAgentTextWithQueueRetry({
            ...request,
            shouldContinue,
          }),
        shouldContinue,
        recordPublicationCheckpoint: async ({ receipt, artifact }) => {
          const recorded = await recordAgentTaskExecutionCheckpoint(db, {
            taskId,
            userId,
            leaseOwner: input.leaseGuard!.ownerToken,
            expectedTaskStatus: "running",
            step: runningStep,
            previousCheckpoint: current.task.latest_checkpoint,
            summary:
              "Published the fixed task-owned Evidence Inventory and preserved its source-bound generation receipt.",
            checkpointValues: {
              litigation_evidence_inventory_receipt: receipt,
            },
          });
          if (recorded) {
            await linkAgentTaskArtifacts(db, taskId, userId, [artifact]);
          }
          return recorded;
        },
      });
      execution = litigation.result;
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
    if (error instanceof LitigationEvidenceInventoryDownstreamContextError) {
      return pauseAgentTaskForStateTransition(
        db,
        taskId,
        userId,
        new AgentTaskStateTransitionError(
          "task_state_transition_conflict",
          "The server could not safely bind the completed Evidence Inventory to this downstream Step. Existing evidence and lawyer decisions were preserved for resumable review.",
          {
            litigation_evidence_downstream_context_issue_code: error.code,
            ...error.facts,
          },
        ),
        { leaseOwner: input.leaseGuard.ownerToken },
      );
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
          userId,
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
    const providerDiagnostic = providerDiagnosticForTaskError(error, current);
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
          diagnostic: providerDiagnostic,
        },
      );
    }
    if (error instanceof AgentModelRequestTimeoutError) {
      return deferAgentTaskForProvider(
        db,
        taskId,
        userId,
        "The selected model exceeded the bounded request deadline. Existing work was preserved and this Step can be resumed or continued with another configured model.",
        {
          classification: "provider_timeout",
          leaseOwner: input.leaseGuard.ownerToken,
          diagnostic: providerDiagnostic,
        },
      );
    }
    const providerProtocol = classifyAgentTaskProviderProtocolError(error);
    if (
      providerProtocol?.classification === "provider_configuration" ||
      providerProtocol?.classification === "provider_protocol"
    ) {
      return deferAgentTaskForProvider(
        db,
        taskId,
        userId,
        providerProtocol.classification === "provider_configuration"
          ? "The selected provider rejected the configured credentials, balance, billing state, or model access. Existing work was preserved; update the provider configuration or choose another configured model, then resume."
          : "The selected provider did not satisfy the required request protocol. Existing work was preserved; resume with a compatible configured model.",
        {
          classification: providerProtocol.classification,
          leaseOwner: input.leaseGuard.ownerToken,
          diagnostic: providerDiagnostic,
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
    await linkAgentTaskArtifacts(db, taskId, userId, execution.artifacts);
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
    const runningVerifier = current.task.current_plan.find(
      (step: { status: string }) => step.status === "running",
    );
    const storedRepair = readAgentVerificationRepairReceiptV1(
      current.task.latest_checkpoint,
    );
    if (storedRepair.state === "invalid" || !runningVerifier) {
      return completeVerifierForLawyerReview({
        db,
        taskId,
        userId,
        snapshot: current,
        execution,
        summary:
          "Verification preserved the current deliverables, but the bounded repair identity is unavailable or malformed. Lawyer review is required; no Artifact was mutated.",
        leaseGuard: input.leaseGuard,
      });
    }
    const currentStoredRepair =
      storedRepair.state === "valid" &&
      storedRepair.receipt.task_id === taskId &&
      storedRepair.receipt.step_id === runningVerifier.id &&
      storedRepair.receipt.step_attempt === runningVerifier.attempt
        ? storedRepair.receipt
        : null;
    let repairEffects;
    try {
      repairEffects = readAgentStepEffectReceipts(runningVerifier.result_data);
    } catch {
      return completeVerifierForLawyerReview({
        db,
        taskId,
        userId,
        snapshot: current,
        execution,
        summary:
          "Verification preserved the current deliverables, but the current repair effect receipt is malformed. Lawyer review is required; no further automatic mutation was attempted.",
        leaseGuard: input.leaseGuard,
      });
    }
    const currentRepairEffect = currentStoredRepair
      ? repairEffects.find(
          (receipt) =>
            receipt.effect_key ===
              `agent-step:${runningVerifier.id}:attempt:${runningVerifier.attempt}:generate_docx` &&
            receipt.target.document_id === currentStoredRepair.document_id &&
            receipt.target.version_id === currentStoredRepair.target_version_id,
        )
      : null;
    const repairDecision = decideAgentVerificationRepairV1({
      packet: execution.verification.packet,
      result: execution.verification.result,
      repairAlreadyAttempted: Boolean(currentStoredRepair && currentRepairEffect),
    });
    if (repairDecision.kind !== "bounded_artifact_edit") {
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
    const deliverable = execution.verification.packet.deliverables.find(
      (candidate) => candidate.key === repairDecision.deliverableKey,
    );
    if (
      !deliverable ||
      deliverable.artifact_type !== "draft" ||
      deliverable.document_id !== repairDecision.documentId ||
      deliverable.current_version_id !== repairDecision.versionId ||
      !deliverable.accepted_view_complete ||
      !deliverable.accepted_view_sha256 ||
      !deliverable.accepted_view_text
    ) {
      return completeVerifierForLawyerReview({
        db,
        taskId,
        userId,
        snapshot: current,
        execution,
        summary:
          "Verification found a possible content repair, but the affected draft is not one complete fixed current Version. Existing work was preserved for lawyer review.",
        leaseGuard: input.leaseGuard,
      });
    }
    const mutation = buildAgentVerifierRepairMutationIdentity({
      taskId,
      stepId: runningVerifier.id,
      stepAttempt: runningVerifier.attempt,
      deliverableKey: deliverable.key,
      documentId: deliverable.document_id,
      baseVersionId: deliverable.current_version_id,
    });
    const repairReceipt = buildAgentVerificationRepairReceiptV1({
      kind: "agent_verification_repair_v1",
      task_id: taskId,
      step_id: runningVerifier.id,
      step_attempt: runningVerifier.attempt,
      issue_code: repairDecision.issueCode,
      deliverable_key: deliverable.key,
      document_id: deliverable.document_id,
      base_version_id: deliverable.current_version_id,
      target_version_id: mutation.versionId,
      accepted_view_sha256: deliverable.accepted_view_sha256,
      goal_excerpt: repairDecision.goalExcerpt,
    });
    if (
      currentStoredRepair &&
      JSON.stringify(currentStoredRepair) !== JSON.stringify(repairReceipt)
    ) {
      return completeVerifierForLawyerReview({
        db,
        taskId,
        userId,
        snapshot: current,
        execution,
        summary:
          "Verification found a repairable gap, but the persisted repair target no longer matches the current fixed draft. Existing work was preserved for lawyer review.",
        leaseGuard: input.leaseGuard,
      });
    }
    const repairCheckpointValues = {
      ...(execution.checkpointValues ?? {}),
      [AGENT_VERIFICATION_REPAIR_KEY]: repairReceipt,
    };
    if (!currentStoredRepair) {
      const recorded = await recordAgentTaskExecutionCheckpoint(db, {
        taskId,
        userId,
        leaseOwner: input.leaseGuard.ownerToken,
        expectedTaskStatus: "verifying",
        step: {
          id: runningVerifier.id,
          attempt: runningVerifier.attempt,
        },
        previousCheckpoint: current.task.latest_checkpoint,
        summary: `Verifier repair 1/1 started for ${deliverable.key}.`,
        checkpointValues: repairCheckpointValues,
      });
      if (!recorded) return getAgentTaskSnapshot(db, taskId, userId);
    }

    const repairDirective: AgentStepRepairDirective = {
      kind: "bounded_artifact_edit_v1",
      issueCode: repairDecision.issueCode,
      deliverableKey: deliverable.key,
      documentId: deliverable.document_id,
      baseVersionId: deliverable.current_version_id,
      acceptedViewSha256: deliverable.accepted_view_sha256,
      acceptedViewText: deliverable.accepted_view_text,
      goalExcerpt: repairDecision.goalExcerpt,
    };
    const repairState: {
      repair: AgentStepExecutionResult | null;
      recheck: AgentStepExecutionResult | null;
    } = { repair: null, recheck: null };
    try {
      await coordinateOneAgentVerificationRepairV1({
        packet: execution.verification.packet,
        result: execution.verification.result,
        repairAlreadyAttempted: false,
        executeRepair: async (decision) => {
          if (
            decision.kind !== "bounded_artifact_edit" ||
            decision.documentId !== repairDirective.documentId ||
            decision.versionId !== repairDirective.baseVersionId ||
            decision.deliverableKey !== repairDirective.deliverableKey ||
            decision.issueCode !== repairDirective.issueCode
          ) {
            throw new Error(
              "The repair coordinator changed the fixed Artifact target",
            );
          }
          repairState.repair = await executeAgentStep({
            db,
            snapshot: current,
            userId,
            userEmail,
            leaseOwner: leaseGuard.ownerToken,
            shouldContinue,
            repairDirective,
          });
          await linkAgentTaskArtifacts(
            db,
            taskId,
            userId,
            repairState.repair.artifacts,
          );
        },
        recheck: async () => {
          if (!repairState.repair) {
            throw new Error("The bounded repair did not produce a result");
          }
          // The committed repair effect updates both the Document's current
          // Version and the running Verifier Step result_data. Reusing the
          // pre-mutation snapshot would compare the new Version against the
          // original create-Step receipt and manufacture a version-drift gap.
          const repairedSnapshot = await getAgentTaskSnapshot(
            db,
            taskId,
            userId,
          );
          const refreshedVerifier = repairedSnapshot?.task.current_plan.find(
            (step: { status: string }) => step.status === "running",
          );
          if (
            !repairedSnapshot ||
            repairedSnapshot.task.status !== "verifying" ||
            refreshedVerifier?.id !== runningVerifier.id ||
            refreshedVerifier.attempt !== runningVerifier.attempt
          ) {
            throw new AgentTaskStateTransitionError(
              "task_state_transition_conflict",
              "The bounded repair committed, but the Verifier state changed before its fresh recheck.",
              {
                task_id: taskId,
                expected_step_id: runningVerifier.id,
                expected_attempt: runningVerifier.attempt,
              },
            );
          }
          repairState.recheck = await executeAgentStep({
            db,
            snapshot: repairedSnapshot,
            userId,
            userEmail,
            leaseOwner: leaseGuard.ownerToken,
            shouldContinue,
          });
          if (!repairState.recheck.verification) {
            throw new Error("The bounded repair recheck returned no Verifier result");
          }
          return {
            packet: repairState.recheck.verification.packet,
            result: repairState.recheck.verification.result,
          };
        },
      });
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
        return pauseAgentTaskForStateTransition(
          db,
          taskId,
          userId,
          new AgentTaskStateTransitionError(
            "task_state_transition_conflict",
            "The bounded Word repair could not be committed from the current Task state. Existing Versions were preserved for safe re-verification.",
            error.facts,
          ),
          { leaseOwner: input.leaseGuard.ownerToken },
        );
      }
      const providerDiagnostic = providerDiagnosticForTaskError(error, current);
      if (error instanceof AgentVerifierStructuredOutputError) {
        return deferAgentTaskForProvider(
          db,
          taskId,
          userId,
          "The repaired Artifact was preserved, but the fresh verifier response could not be mechanically validated. Resume this same Step or choose another configured model.",
          {
            classification: "provider_structured_output",
            leaseOwner: input.leaseGuard.ownerToken,
            checkpointValues: repairCheckpointValues,
            diagnostic: providerDiagnostic,
          },
        );
      }
      if (error instanceof AgentModelRequestTimeoutError) {
        return deferAgentTaskForProvider(
          db,
          taskId,
          userId,
          "The one bounded repair timed out. Existing work and any committed Version were preserved; resume with a responsive configured model.",
          {
            classification: "provider_timeout",
            leaseOwner: input.leaseGuard.ownerToken,
            checkpointValues: repairCheckpointValues,
            diagnostic: providerDiagnostic,
          },
        );
      }
      const providerProtocol = classifyAgentTaskProviderProtocolError(error);
      if (
        providerProtocol?.classification === "provider_configuration" ||
        providerProtocol?.classification === "provider_protocol"
      ) {
        return deferAgentTaskForProvider(
          db,
          taskId,
          userId,
          providerProtocol.classification === "provider_configuration"
            ? "The configured provider could not run the bounded repair. Existing work was preserved; update the provider configuration or select another compatible model."
            : "The configured provider cannot guarantee the one required Word mutation. Existing work was preserved; resume with a compatible model.",
          {
            classification: providerProtocol.classification,
            leaseOwner: input.leaseGuard.ownerToken,
            checkpointValues: repairCheckpointValues,
            diagnostic: providerDiagnostic,
          },
        );
      }
      if (isTransientModelError(error)) throw error;
      return completeVerifierForLawyerReview({
        db,
        taskId,
        userId,
        snapshot: current,
        execution: {
          ...execution,
          artifacts: [
            ...execution.artifacts,
            ...(repairState.repair?.artifacts ?? []),
          ],
        },
        summary: `The one bounded Word repair could not be safely completed: ${agentTaskExecutionErrorMessage(error)} Existing deliverables and Versions were preserved for lawyer review.`,
        leaseGuard: input.leaseGuard,
      });
    }
    if (!repairState.repair || !repairState.recheck?.verification) {
      return completeVerifierForLawyerReview({
        db,
        taskId,
        userId,
        snapshot: current,
        execution,
        summary:
          "The bounded repair did not produce one complete re-verification result. Existing deliverables were preserved for lawyer review.",
        leaseGuard: input.leaseGuard,
      });
    }
    execution = {
      ...repairState.recheck,
      summary: `Verifier repair 1/1 completed. ${repairState.recheck.summary}`,
      artifacts: [
        ...execution.artifacts,
        ...repairState.repair.artifacts,
        ...repairState.recheck.artifacts,
      ],
    };
    if (execution.verification?.result.outcome === "review_required") {
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
        const providerDiagnostic = providerDiagnosticForTaskError(
          error,
          current,
        );
        const providerProtocol = classifyAgentTaskProviderProtocolError(error);
        if (providerProtocol) {
          return deferAgentTaskForProvider(
            db,
            taskId,
            userId,
            providerProtocol.classification === "provider_configuration"
              ? "The configured provider could not run the bounded verifier repair. Existing work was preserved; update provider settings or choose another compatible model."
              : "The configured provider could not complete the bounded verifier protocol. Existing work was preserved; resume with a compatible model.",
            {
              classification: providerProtocol.classification,
              leaseOwner: input.leaseGuard.ownerToken,
              diagnostic: providerDiagnostic,
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
  const transition = await prepareCurrentAgentStepTransition(
    db,
    current,
    userId,
    execution,
  );
  if (transition.kind === "postcondition_pause") {
    return pauseAgentTaskForStepPostcondition(db, taskId, userId, {
      summary: transition.summary,
      facts: transition.facts,
      artifacts: transition.artifacts,
      leaseOwner: input.leaseGuard.ownerToken,
    });
  }
  return commitAgentTaskAdvance({
    db,
    taskId,
    userId,
    leaseGuard: input.leaseGuard,
    result: { ...execution, stepReceipt: transition.stepReceipt },
  });
}
