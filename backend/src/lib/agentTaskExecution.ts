import {
  advanceAgentTask,
  applyAgentTaskPlan,
  deferAgentTaskForProvider,
  getAgentTaskSnapshot,
  linkAgentTaskArtifacts,
  pauseAgentTaskForContext,
  pauseAgentTaskForStepPostcondition,
  recordAgentTaskCheckpoint,
  stopAgentTask,
  verifierRepairAlreadyAttempted,
} from "./agentTasks";
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
  verifyTaskCitationLinks,
} from "./agentStepExecutor";
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
import { assertAgentStepCapabilityGrants } from "./agent-kernel/capability/stepCapability";
import {
  AgentTaskLeaseBusyError,
  type AgentTaskLeaseGuard,
  withAgentTaskLease,
} from "./agent-kernel/execution/taskLease";
import { AgentVerifierStructuredOutputError } from "./agent-kernel/verification/verifierCore";

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

async function completeVerifierForLawyerReview(input: {
  db: Db;
  taskId: string;
  userId: string;
  snapshot: Snapshot;
  execution: Awaited<ReturnType<typeof executeAgentStep>>;
  summary: string;
}) {
  const result = { ...input.execution, summary: input.summary };
  const stepReceipt = await buildCurrentStepReceipt(
    input.db,
    input.snapshot,
    result,
  );
  return advanceAgentTask(input.db, input.taskId, input.userId, {
    ...result,
    stepReceipt,
  });
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

async function taskCanContinue(db: Db, taskId: string, userId: string) {
  const snapshot = await getAgentTaskSnapshot(db, taskId, userId);
  return {
    snapshot,
    active: Boolean(
      snapshot && ["running", "verifying"].includes(snapshot.task.status),
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
  const executionCanContinue = async () => {
    if (input.leaseGuard && !(await input.leaseGuard.verifyOwner())) {
      return {
        snapshot: await getAgentTaskSnapshot(db, taskId, userId),
        active: false,
      };
    }
    return taskCanContinue(db, taskId, userId);
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
    const beforeStart = await executionCanContinue();
    if (!beforeStart.active) return beforeStart.snapshot;
    return advanceAgentTask(db, taskId, userId);
  }
  if (!["running", "verifying"].includes(current.task.status)) {
    return current;
  }

  let execution;
  try {
    execution = await executeAgentStep({
      db,
      snapshot: current,
      userId,
      userEmail,
      shouldContinue,
    });
  } catch (error) {
    if (isAgentTaskExecutionInterrupted(error)) {
      return getAgentTaskSnapshot(db, taskId, userId);
    }
    if (error instanceof AgentVerifierStructuredOutputError) {
      return deferAgentTaskForProvider(
        db,
        taskId,
        userId,
        "The verifier response could not be mechanically validated. Existing deliverables were preserved and this Step can be resumed.",
        { classification: "provider_structured_output" },
      );
    }
    if (isTransientModelError(error)) throw error;
    return stopAgentTask(db, taskId, userId, {
      status: "failed",
      summary: agentTaskExecutionErrorMessage(error),
    });
  }

  const afterExecution = await executionCanContinue();
  if (!afterExecution.active) return afterExecution.snapshot;
  if (execution.waitingForInput) {
    return stopAgentTask(db, taskId, userId, {
      status: "waiting_input",
      summary: execution.summary,
      requiredInput: execution.requiredInput,
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
      });
    }
  }

  const beforeCommit = await executionCanContinue();
  if (!beforeCommit.active) return beforeCommit.snapshot;
  try {
    const stepReceipt = await buildCurrentStepReceipt(db, current, execution);
    return advanceAgentTask(db, taskId, userId, {
      ...execution,
      stepReceipt,
    });
  } catch (error) {
    if (error instanceof AgentStepPostconditionError) {
      return pauseAgentTaskForStepPostcondition(db, taskId, userId, {
        summary: `${error.message}. Existing work was preserved for a resumable review.`,
        facts: error.facts,
        artifacts: execution.artifacts,
      });
    }
    throw error;
  }
}
