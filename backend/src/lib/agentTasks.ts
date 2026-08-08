import { randomUUID } from "node:crypto";

import { createServerSupabase } from "./supabase";
import { taskDeliverablePurpose } from "./agentTaskDeliverables";
import type {
  AgentTaskDeliverableDefinition,
  AgentTaskPlanningRequest,
  GoalAwareTaskPlan,
} from "./agentTaskPlanner";
import {
  deriveAgentReviewStatus,
  getAgentReviewVersionState,
} from "./agentTaskReviewVersions";
import {
  mergeAgentTaskProviderPauseCheckpoint,
  type AgentProviderDiagnosticV1,
  type AgentTaskExecutionPauseClassification,
  type AgentTaskRetryCheckpoint,
} from "./agent-kernel/outcomes/executionOutcome";
import {
  FIXED_MATTER_CONTEXT_CHECKPOINT_KEY,
  mergeImmutableAgentTaskCheckpoint,
  MatterContextInvalidError,
  readFixedMatterContext,
  type MatterContextManifestV1,
} from "./agent-kernel/context/matterContext";
import { extendFixedMatterContext } from "./agent-kernel/context/matterContextRepository";
import type { AgentTaskArtifactContractV1 } from "./agent-kernel/contracts/taskContract";
import { extendAgentTaskContractContext } from "./agent-kernel/contracts/taskContract";
import { contractPlaybookReceiptSchema } from "./agent-packs/contract/contractPlaybookPack";
import {
  applyContractPlaybookDispositionRevisionIntent,
  contractPlaybookDispositionRevisionIntentSchema,
} from "./agent-packs/contract/contractPlaybookDisposition";
import {
  AgentRequiredInputSubmissionError,
  agentRequiredInputResponseSchema,
  readAgentRequiredInput,
  readResolvedRequiredInputIds,
  validateRequiredInputSubmission,
  type AgentRequiredInputV1,
  type AgentRequiredInputResponseV1,
} from "./agent-kernel/contracts/requiredInput";
import {
  readAgentStepContracts,
  readAgentStepReceipts,
  type AgentStepReceiptV1,
} from "./agent-kernel/contracts/stepContract";
import {
  assertAgentTaskExecutionRecovery,
  evaluateAgentTaskExecutionRecovery,
} from "./agent-kernel/recovery/executionRecovery";
import {
  AgentTaskStateTransitionError,
  agentTaskInputTransitionWasApplied,
  agentTaskPauseTransitionWasApplied,
  agentTaskReviewDecisionTransitionWasApplied,
  agentTaskResumeTransitionWasApplied,
  agentTaskRevisionTransitionWasApplied,
  agentTaskRetryTransitionWasApplied,
  agentTaskStateTransitionWasApplied,
  agentTaskStopTransitionWasApplied,
  commitAgentTaskInputTransition,
  commitAgentTaskPauseTransition,
  commitAgentTaskReviewDecisionTransition,
  commitAgentTaskResumeTransition,
  commitAgentTaskRevisionTransition,
  commitAgentTaskRetryTransition,
  commitAgentTaskStateTransition,
  commitAgentTaskStopTransition,
  commitAgentTaskVerifierRetryTransition,
  type AgentTaskInputTransitionInput,
  type AgentTaskPauseTransitionInput,
  type AgentTaskReviewDecisionTransitionInput,
  type AgentTaskRevisionTransitionInput,
  type AgentTaskRetryTransitionInput,
  type AgentTaskStateTransitionInput,
  type AgentTaskStopTransitionInput,
} from "./agent-kernel/execution/taskTransition";
import { requireAgentTaskVerifierRetryStarted } from "./agent-kernel/verification/verifierRetry";

export type {
  AgentTaskExecutionPauseClassification,
  AgentTaskRetryCheckpoint,
} from "./agent-kernel/outcomes/executionOutcome";

export type AgentTaskStatus =
  | "queued"
  | "running"
  | "waiting_input"
  | "verifying"
  | "paused"
  | "completed"
  | "failed";

export type AgentStepStatus =
  | "pending"
  | "running"
  | "completed"
  | "blocked"
  | "skipped";

export type AgentArtifactType =
  | "chat"
  | "document"
  | "draft"
  | "workflow_run"
  | "citation_snapshot"
  | "tabular_review";

type Db = ReturnType<typeof createServerSupabase>;

type StepDefinition = {
  title: string;
  expected_output: string;
};

export type AgentArtifactLinkInput = {
  artifact_type: AgentArtifactType;
  artifact_id: string;
  purpose: string;
};

export type AgentReviewDecision = {
  id: string;
  task_id: string;
  status: "review_required" | "changes_requested" | "approved";
  reviewer_id: string | null;
  reviewer_email: string | null;
  reviewer_name: string | null;
  note: string;
  artifact_snapshot: unknown[];
  created_at: string;
};

export type AgentTaskSupplementalInput = {
  submission_id?: string;
  step_id: string;
  attempt: number;
  submitted_at: string;
  message?: string;
  document_ids: string[];
  structured_responses?: AgentRequiredInputResponseV1[];
};

export const DEFAULT_WORK_PLAN: StepDefinition[] = [
  {
    title: "Read the matter documents",
    expected_output: "A complete source set with stable document references.",
  },
  {
    title: "Extract facts and contract positions",
    expected_output:
      "Verified facts separated from assumptions and open questions.",
  },
  {
    title: "Build the risk matrix",
    expected_output:
      "A clause-by-clause risk matrix linked to source passages.",
  },
  {
    title: "Draft the review memo",
    expected_output:
      "A reviewable memo draft with citations and recommendations.",
  },
  {
    title: "Verify deliverables",
    expected_output:
      "Coverage, source, contradiction, and artifact checks completed.",
  },
];

export const DEFAULT_DELIVERABLES = [
  {
    key: "risk-matrix",
    title: "Risk matrix",
    description: "Clause findings, severity, source, and review status.",
    required: true,
    artifact_type: "tabular_review",
    purpose: "Risk matrix",
  },
  {
    key: "review-memo",
    title: "Review memo",
    description: "Facts, analysis, recommendations, and open questions.",
    required: true,
    artifact_type: "draft",
    purpose: "Review memo draft",
  },
];

function now() {
  return new Date().toISOString();
}

function dbError(error: { message: string } | null, fallback: string) {
  return new Error(error?.message ?? fallback);
}

export function verifierRepairAlreadyAttempted(task: {
  latest_checkpoint?: unknown;
}) {
  const checkpoint = task.latest_checkpoint;
  if (!checkpoint || typeof checkpoint !== "object") return false;
  const summary = (checkpoint as { summary?: unknown }).summary;
  return (
    typeof summary === "string" &&
    /^(?:Verifier repair 1\/1 started:|Provider queue during verifier repair 1\/1:)/.test(
      summary,
    )
  );
}

export function readAgentTaskSupplementalInput(task: {
  latest_checkpoint?: unknown;
}): AgentTaskSupplementalInput | null {
  const checkpoint = task.latest_checkpoint;
  if (!checkpoint || typeof checkpoint !== "object") return null;
  const value = (checkpoint as { user_input?: unknown }).user_input;
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (
    typeof row.step_id !== "string" ||
    typeof row.attempt !== "number" ||
    typeof row.submitted_at !== "string"
  ) {
    return null;
  }
  const structuredResponses = agentRequiredInputResponseSchema.safeParse(
    row.structured_responses,
  );
  return {
    ...(typeof row.submission_id === "string" && row.submission_id.trim()
      ? { submission_id: row.submission_id.trim() }
      : {}),
    step_id: row.step_id,
    attempt: row.attempt,
    submitted_at: row.submitted_at,
    ...(typeof row.message === "string" && row.message.trim()
      ? { message: row.message.trim() }
      : {}),
    document_ids: Array.isArray(row.document_ids)
      ? row.document_ids.filter(
          (documentId): documentId is string => typeof documentId === "string",
        )
      : [],
    ...(structuredResponses.success
      ? {
          structured_responses: structuredResponses.data,
        }
      : {}),
  };
}

export function prepareAgentTaskInputTransition(
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
  input: {
    message?: string;
    documentIds?: string[];
    responses?: AgentRequiredInputResponseV1[];
    serverCheckpointValues?: Record<string, unknown>;
  },
  submittedAt = now(),
  submissionId = randomUUID(),
) {
  const message = input.message?.trim() ?? "";
  const documentIds = Array.from(
    new Set((input.documentIds ?? []).map((documentId) => documentId.trim())),
  ).filter(Boolean);
  if (!message && !documentIds.length && !input.responses?.length) {
    throw new Error("A message or Matter document is required");
  }
  if (message.length > 4000) {
    throw new Error("The supplemental message is too long");
  }
  if (snapshot.task.status !== "waiting_input") {
    throw new Error("Only a task waiting for input can accept a response");
  }
  const current = snapshot.task.current_plan.find(
    (step) => step.status === "blocked",
  );
  if (!current) throw new Error("Input-blocked task has no recoverable step");
  const activeIndex = snapshot.task.current_plan.findIndex(
    (step) => step.id === current.id,
  );
  const nextAttempt = current.attempt + 1;
  const checkpoint =
    snapshot.task.latest_checkpoint &&
    typeof snapshot.task.latest_checkpoint === "object"
      ? { ...(snapshot.task.latest_checkpoint as Record<string, unknown>) }
      : {};
  const requiredInput = readAgentRequiredInput(checkpoint.required_input);
  const resolvedRequiredInput = requiredInput
    ? validateRequiredInputSubmission(requiredInput, {
        message,
        documentIds,
        responses: input.responses,
      })
    : null;
  delete checkpoint.runner_retry;
  delete checkpoint.planner_request;
  delete checkpoint.user_input;
  delete checkpoint.required_input;
  const resolvedRequiredInputIds = Array.from(
    new Set([
      ...readResolvedRequiredInputIds(checkpoint),
      ...(resolvedRequiredInput ? [resolvedRequiredInput.requestId] : []),
    ]),
  ).slice(-100);
  const userInput = {
    submission_id: submissionId,
    step_id: current.id,
    attempt: nextAttempt,
    submitted_at: submittedAt,
    ...(message ? { message } : {}),
    document_ids: documentIds,
    ...(resolvedRequiredInput?.responses
      ? { structured_responses: resolvedRequiredInput.responses }
      : {}),
  } satisfies AgentTaskSupplementalInput;
  return {
    current,
    nextAttempt,
    documentIds,
    submissionId,
    resolvedRequiredInputId: resolvedRequiredInput?.requestId ?? null,
    status: (snapshot.task.current_plan.some(
      (step, position) => position > activeIndex && step.status === "pending",
    )
      ? "running"
      : "verifying") as AgentTaskStatus,
    checkpoint: {
      ...checkpoint,
      ...(resolvedRequiredInputIds.length
        ? { resolved_required_input_ids: resolvedRequiredInputIds }
        : {}),
      step_id: current.id,
      iteration: nextAttempt,
      summary:
        typeof checkpoint.summary === "string"
          ? checkpoint.summary
          : "User input received. Continuing automatically.",
      created_at: submittedAt,
      ...(input.serverCheckpointValues ?? {}),
      user_input: userInput,
    },
  };
}

export function agentTaskInputDocumentsMatch(
  requestedDocumentIds: string[],
  availableDocuments: Array<{ id: string }>,
) {
  const requested = new Set(requestedDocumentIds);
  const available = new Set(availableDocuments.map((document) => document.id));
  return (
    requested.size === available.size &&
    [...requested].every((id) => available.has(id))
  );
}

export async function createAgentTask(
  db: Db,
  input: {
    userId: string;
    matterId: string;
    goal: string;
    executionModel: string;
    plan?: StepDefinition[];
    deliverables?:
      | AgentTaskDeliverableDefinition[]
      | AgentTaskArtifactContractV1[];
    planningRequest?: AgentTaskPlanningRequest;
    fixedMatterContext?: MatterContextManifestV1;
    initialCheckpoint?: Record<string, unknown>;
    initialArtifacts?: AgentArtifactLinkInput[];
  },
) {
  const plan = input.plan?.length ? input.plan.slice(0, 10) : DEFAULT_WORK_PLAN;
  const { data: task, error: taskError } = await db
    .from("agent_tasks")
    .insert({
      user_id: input.userId,
      matter_id: input.matterId,
      goal: input.goal.trim(),
      mode: "work",
      status: "queued",
      execution_model: input.executionModel,
      deliverables: input.deliverables ?? DEFAULT_DELIVERABLES,
      latest_checkpoint: input.initialCheckpoint
        ? input.initialCheckpoint
        : input.planningRequest || input.fixedMatterContext
          ? {
              step_id: "planner",
              iteration: 0,
              summary: "Preparing a goal-aligned work plan.",
              created_at: now(),
              ...(input.planningRequest
                ? { planner_request: input.planningRequest }
                : {}),
              ...(input.fixedMatterContext
                ? {
                    [FIXED_MATTER_CONTEXT_CHECKPOINT_KEY]:
                      input.fixedMatterContext,
                  }
                : {}),
            }
          : null,
    })
    .select("*")
    .single();
  if (taskError || !task) throw dbError(taskError, "Failed to create task");

  const { error: stepError } = await db.from("agent_steps").insert(
    plan.map((step, position) => ({
      task_id: task.id,
      position,
      title: step.title.trim(),
      expected_output: step.expected_output.trim(),
      status: "pending",
    })),
  );
  if (stepError) {
    await db.from("agent_tasks").delete().eq("id", task.id);
    throw dbError(stepError, "Failed to create task plan");
  }
  if (input.initialArtifacts?.length) {
    try {
      await addAgentArtifactLinks(db, task.id, input.initialArtifacts);
    } catch (error) {
      await db.from("agent_tasks").delete().eq("id", task.id);
      throw error;
    }
  }
  return getAgentTaskSnapshot(db, task.id, input.userId);
}

export async function applyAgentTaskPlan(
  db: Db,
  taskId: string,
  userId: string,
  plan: GoalAwareTaskPlan,
) {
  const snapshot = await getAgentTaskSnapshot(db, taskId, userId);
  if (!snapshot) return null;
  if (snapshot.task.status !== "queued") {
    throw new Error("Only a queued task can receive its initial work plan");
  }
  const { data: rows, error: rowsError } = await db
    .from("agent_steps")
    .select("id,position")
    .eq("task_id", taskId)
    .order("position", { ascending: true });
  if (rowsError) throw dbError(rowsError, "Failed to load provisional plan");

  for (const [position, step] of plan.steps.entries()) {
    const existing = rows?.find((row) => row.position === position);
    if (existing) {
      const { error } = await db
        .from("agent_steps")
        .update({
          title: step.title,
          expected_output: step.expected_output,
          status: "pending",
          result_summary: null,
          updated_at: now(),
        })
        .eq("id", existing.id)
        .eq("task_id", taskId);
      if (error) throw dbError(error, "Failed to update planned step");
    } else {
      const { error } = await db.from("agent_steps").insert({
        task_id: taskId,
        position,
        title: step.title,
        expected_output: step.expected_output,
        status: "pending",
      });
      if (error) throw dbError(error, "Failed to add planned step");
    }
  }
  const { error: deleteError } = await db
    .from("agent_steps")
    .delete()
    .eq("task_id", taskId)
    .gte("position", plan.steps.length);
  if (deleteError)
    throw dbError(deleteError, "Failed to trim provisional plan");

  const { error: taskError } = await db
    .from("agent_tasks")
    .update({
      deliverables: plan.deliverables,
      latest_checkpoint: mergeImmutableAgentTaskCheckpoint(
        snapshot.task.latest_checkpoint,
        null,
      ),
      updated_at: now(),
    })
    .eq("id", taskId)
    .eq("user_id", userId)
    .eq("status", "queued");
  if (taskError) throw dbError(taskError, "Failed to save goal-aligned plan");
  return getAgentTaskSnapshot(db, taskId, userId);
}

export async function getAgentTaskSnapshot(
  db: Db,
  taskId: string,
  userId: string,
) {
  const { data: task, error: taskError } = await db
    .from("agent_tasks")
    .select("*")
    .eq("id", taskId)
    .eq("user_id", userId)
    .maybeSingle();
  if (taskError) throw dbError(taskError, "Failed to load task");
  if (!task) return null;

  const [
    { data: steps, error: stepsError },
    { data: artifacts, error: artifactsError },
    { data: reviewDecisions, error: reviewError },
  ] = await Promise.all([
    db
      .from("agent_steps")
      .select(
        "id,task_id,title,status,expected_output,attempt,result_summary,result_data,position",
      )
      .eq("task_id", taskId)
      .order("position", { ascending: true }),
    db
      .from("agent_artifact_links")
      .select("task_id,artifact_type,artifact_id,purpose")
      .eq("task_id", taskId)
      .order("created_at", { ascending: true }),
    db
      .from("agent_task_review_decisions")
      .select(
        "id,task_id,status,reviewer_id,reviewer_email,reviewer_name,note,artifact_snapshot,created_at",
      )
      .eq("task_id", taskId)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true }),
  ]);
  if (stepsError) throw dbError(stepsError, "Failed to load task plan");
  if (artifactsError)
    throw dbError(artifactsError, "Failed to load task artifacts");
  if (reviewError)
    throw dbError(reviewError, "Failed to load lawyer review decisions");

  const decisions = (reviewDecisions ?? []) as AgentReviewDecision[];
  const latestReview = decisions.at(-1) ?? null;

  const { user_id: _userId, ...publicTask } = task;
  const snapshot = {
    task: {
      ...publicTask,
      current_plan: (steps ?? []).map(
        ({ position: _position, ...step }) => step,
      ),
    },
    artifacts: artifacts ?? [],
    review: {
      decisions,
    },
  };
  const versionState = await getAgentReviewVersionState(db, snapshot, userId);
  return {
    ...snapshot,
    execution_recovery: evaluateAgentTaskExecutionRecovery(snapshot.task),
    review: {
      ...snapshot.review,
      status: deriveAgentReviewStatus(
        task.status as AgentTaskStatus,
        latestReview?.status ?? null,
        versionState,
      ),
      version_state: versionState,
    },
  };
}

export async function listAgentTasks(
  db: Db,
  userId: string,
  matterId?: string,
) {
  let query = db
    .from("agent_tasks")
    .select(
      "id,matter_id,goal,mode,status,execution_model,deliverables,current_step,latest_checkpoint,created_at,updated_at",
    )
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(100);
  if (matterId) query = query.eq("matter_id", matterId);
  const { data, error } = await query;
  if (error) throw dbError(error, "Failed to list tasks");
  const tasks = data ?? [];
  if (!tasks.length) return [];

  const [
    { data: steps, error: stepsError },
    { data: reviewDecisions, error: reviewError },
  ] = await Promise.all([
    db
      .from("agent_steps")
      .select(
        "id,task_id,title,status,expected_output,attempt,result_summary,result_data,position",
      )
      .in(
        "task_id",
        tasks.map((task) => task.id),
      )
      .order("position", { ascending: true }),
    db
      .from("agent_task_review_decisions")
      .select("id,task_id,status,artifact_snapshot,created_at")
      .in(
        "task_id",
        tasks.map((task) => task.id),
      )
      .order("created_at", { ascending: true })
      .order("id", { ascending: true }),
  ]);
  if (stepsError) throw dbError(stepsError, "Failed to load task progress");
  if (reviewError)
    throw dbError(reviewError, "Failed to load task review status");

  const stepsByTask = new Map<string, typeof steps>();
  for (const step of steps ?? []) {
    const taskSteps = stepsByTask.get(step.task_id) ?? [];
    taskSteps.push(step);
    stepsByTask.set(step.task_id, taskSteps);
  }
  const reviewByTask = new Map<
    string,
    {
      status: AgentReviewDecision["status"];
      artifactSnapshot: unknown[];
    }
  >();
  for (const decision of reviewDecisions ?? []) {
    reviewByTask.set(decision.task_id as string, {
      status: decision.status as AgentReviewDecision["status"],
      artifactSnapshot: Array.isArray(decision.artifact_snapshot)
        ? decision.artifact_snapshot
        : [],
    });
  }

  const approvedCurrentVersionPairs = [...reviewByTask.values()]
    .filter((review) => review.status === "approved")
    .flatMap((review) => approvedDocumentVersionPairs(review.artifactSnapshot));
  const { data: approvedDocuments, error: documentError } =
    approvedCurrentVersionPairs.length
      ? await db
          .from("documents")
          .select("id,current_version_id")
          .in(
            "id",
            Array.from(
              new Set(
                approvedCurrentVersionPairs.map((pair) => pair.documentId),
              ),
            ),
          )
      : { data: [], error: null };
  if (documentError)
    throw dbError(documentError, "Failed to load current output versions");
  const currentVersionByDocument = new Map(
    (approvedDocuments ?? []).map((document) => [
      document.id as string,
      (document.current_version_id as string | null) ?? null,
    ]),
  );

  return tasks.map((task) => ({
    ...task,
    review_status: (() => {
      const review = reviewByTask.get(task.id);
      const changedAfterApproval =
        review?.status === "approved" &&
        approvedDocumentVersionPairs(review.artifactSnapshot).some(
          (artifact) =>
            currentVersionByDocument.get(artifact.documentId) !==
            artifact.approvedVersionId,
        );
      return changedAfterApproval
        ? "review_required"
        : (review?.status ??
            (task.status === "completed" ? "review_required" : null));
    })(),
    current_plan: (stepsByTask.get(task.id) ?? []).map(
      ({ position: _position, ...step }) => step,
    ),
  }));
}

/**
 * Approved review snapshots can contain both Document-backed outputs and
 * Tabular Reviews. Only the former participate in DocumentVersion drift
 * checks. Treating a Review id as a document id makes one historical approval
 * break the entire Work Tasks list with an invalid UUID query.
 */
export function approvedDocumentVersionPairs(snapshot: unknown): Array<{
  documentId: string;
  approvedVersionId: string;
}> {
  if (!Array.isArray(snapshot)) return [];
  return snapshot.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const artifact = value as Record<string, unknown>;
    if (artifact.artifact_type === "tabular_review") return [];
    const documentId =
      typeof artifact.document_id === "string"
        ? artifact.document_id.trim()
        : "";
    const approvedVersionId =
      typeof artifact.version_id === "string" ? artifact.version_id.trim() : "";
    return documentId && approvedVersionId
      ? [{ documentId, approvedVersionId }]
      : [];
  });
}

export async function addAgentArtifactLinks(
  db: Db,
  taskId: string,
  links: AgentArtifactLinkInput[],
) {
  if (!links.length) return;
  const { error } = await db.from("agent_artifact_links").upsert(
    links.map((link) => ({ task_id: taskId, ...link })),
    { onConflict: "task_id,artifact_type,artifact_id" },
  );
  if (error) throw dbError(error, "Failed to link task artifacts");
}

async function syncDeliverables(
  db: Db,
  taskId: string,
  userId: string,
  links: AgentArtifactLinkInput[],
) {
  if (!links.length) return;
  const { data: row, error } = await db
    .from("agent_tasks")
    .select("deliverables")
    .eq("id", taskId)
    .eq("user_id", userId)
    .single();
  if (error || !row) throw dbError(error, "Failed to load task deliverables");
  const deliverables = (
    Array.isArray(row.deliverables) ? row.deliverables : []
  ).map((deliverable: Record<string, unknown>) => {
    const match = links.find(
      (link) =>
        link.purpose === taskDeliverablePurpose(deliverable) &&
        (typeof deliverable.artifact_type !== "string" ||
          link.artifact_type === deliverable.artifact_type),
    );
    return match
      ? { ...deliverable, artifact_id: match.artifact_id }
      : deliverable;
  });
  const { error: updateError } = await db
    .from("agent_tasks")
    .update({ deliverables, updated_at: now() })
    .eq("id", taskId)
    .eq("user_id", userId);
  if (updateError)
    throw dbError(updateError, "Failed to update task deliverables");
}

export async function linkAgentTaskArtifacts(
  db: Db,
  taskId: string,
  userId: string,
  links: AgentArtifactLinkInput[],
) {
  if (!links.length) return;
  await addAgentArtifactLinks(db, taskId, links);
  await syncDeliverables(db, taskId, userId, links);
}

export async function advanceAgentTask(
  db: Db,
  taskId: string,
  userId: string,
  result:
    | {
        summary?: string;
        artifacts?: AgentArtifactLinkInput[];
        stepReceipt?: AgentStepReceiptV1;
        checkpointValues?: Record<string, unknown>;
      }
    | undefined,
  options: { leaseOwner: string },
) {
  if (!options.leaseOwner) {
    throw new Error("Agent Task state transitions require an execution lease");
  }
  const snapshot = await getAgentTaskSnapshot(db, taskId, userId);
  if (!snapshot) return null;
  const task = snapshot.task as {
    status: AgentTaskStatus;
    current_step: string | null;
  };
  if (
    ["completed", "failed", "paused", "waiting_input"].includes(task.status)
  ) {
    return snapshot;
  }

  const steps = snapshot.task.current_plan as Array<{
    id: string;
    status: AgentStepStatus;
    attempt: number;
  }>;
  let currentIndex = steps.findIndex((step) => step.status === "running");
  const updatedAt = now();
  const isStart = task.status === "queued";
  if (isStart) {
    currentIndex = steps.findIndex((step) => step.status === "pending");
    if (currentIndex < 0) {
      throw new AgentTaskStateTransitionError(
        "task_state_transition_conflict",
        "Queued Task has no executable Step.",
        { task_id: taskId, task_status: task.status },
      );
    }
  } else {
    if (currentIndex < 0) {
      throw new AgentTaskStateTransitionError(
        "task_state_transition_conflict",
        "Active Task has no running Step.",
        {
          task_id: taskId,
          task_status: task.status,
          current_step: task.current_step,
        },
      );
    }
    if (result?.artifacts?.length) {
      await linkAgentTaskArtifacts(db, taskId, userId, result.artifacts);
    }
  }

  const current = steps[currentIndex];
  const nextPendingIndex = isStart
    ? currentIndex
    : steps.findIndex(
        (step, position) =>
          position > currentIndex && step.status === "pending",
      );
  const isComplete = !isStart && nextPendingIndex < 0;
  const completedStep = isStart ? null : current;
  const priorReceipts = readAgentStepReceipts(snapshot.task.latest_checkpoint);
  const nextReceipts = result?.stepReceipt
    ? [
        ...priorReceipts.filter(
          (receipt) =>
            !(
              receipt.position === result.stepReceipt!.position &&
              receipt.attempt === result.stepReceipt!.attempt
            ),
        ),
        result.stepReceipt,
      ].slice(-60)
    : priorReceipts;
  const summary = isStart ? null : result?.summary?.trim() || "Step completed.";
  const transition: AgentTaskStateTransitionInput = {
    taskId,
    userId,
    leaseOwner: options.leaseOwner,
    expectedTaskStatus: task.status as "queued" | "running" | "verifying",
    stepId: current.id,
    expectedStepAttempt: current.attempt,
    resultSummary: summary,
    latestCheckpoint: completedStep
      ? mergeImmutableAgentTaskCheckpoint(snapshot.task.latest_checkpoint, {
          step_id: completedStep.id,
          iteration: completedStep.attempt,
          summary: summary ?? "Step completed.",
          created_at: updatedAt,
          ...(result?.checkpointValues ?? {}),
          ...(result?.stepReceipt ? { step_receipts: nextReceipts } : {}),
        })
      : snapshot.task.latest_checkpoint,
    reviewNote: isComplete
      ? result?.stepReceipt?.outcome === "review_required"
        ? "Automated verification preserved the current deliverables and identified a gap requiring lawyer review before final export."
        : "Execution and automated verification completed. Lawyer review is required before final export."
      : null,
  };
  try {
    const committed = await commitAgentTaskStateTransition(db, transition);
    if (committed.outcome === "advanced") {
      return getAgentTaskSnapshot(db, taskId, userId);
    }
    const recovered = await getAgentTaskSnapshot(db, taskId, userId);
    if (agentTaskStateTransitionWasApplied(recovered, transition)) {
      return recovered;
    }
    if (committed.outcome === "lease_lost") {
      return recovered;
    }
    if (
      !recovered ||
      !["queued", "running", "verifying"].includes(recovered.task.status)
    ) {
      return recovered;
    }
    throw new AgentTaskStateTransitionError(
      "task_state_transition_conflict",
      "The Agent Task state changed before this Step could be committed.",
      {
        task_id: taskId,
        step_id: current.id,
        expected_task_status: task.status,
        expected_step_attempt: current.attempt,
        transition_outcome: committed.outcome,
      },
    );
  } catch (error) {
    if (!(error instanceof AgentTaskStateTransitionError)) throw error;
    const recovered = await getAgentTaskSnapshot(db, taskId, userId);
    if (agentTaskStateTransitionWasApplied(recovered, transition)) {
      return recovered;
    }
    throw error;
  }
}

async function pauseAgentTaskSnapshotAtomically(
  db: Db,
  taskId: string,
  userId: string,
  snapshot: NonNullable<Awaited<ReturnType<typeof getAgentTaskSnapshot>>>,
  input: {
    latestCheckpoint: unknown;
    leaseOwner?: string | null;
    forceRevoke?: boolean;
  },
) {
  const current = snapshot.task.current_plan.find(
    (step: { status: AgentStepStatus }) => step.status === "running",
  );
  const transition: AgentTaskPauseTransitionInput = {
    taskId,
    userId,
    expectedTaskStatus: snapshot.task.status as
      | "queued"
      | "running"
      | "verifying",
    stepId: current?.id ?? null,
    expectedStepAttempt: current?.attempt ?? null,
    leaseOwner: input.leaseOwner ?? null,
    forceRevoke: input.forceRevoke ?? false,
    latestCheckpoint: input.latestCheckpoint,
  };
  let committed: Awaited<ReturnType<typeof commitAgentTaskPauseTransition>>;
  try {
    committed = await commitAgentTaskPauseTransition(db, transition);
  } catch (error) {
    if (!(error instanceof AgentTaskStateTransitionError)) throw error;
    const recovered = await getAgentTaskSnapshot(db, taskId, userId);
    if (agentTaskPauseTransitionWasApplied(recovered, transition)) {
      return recovered;
    }
    throw error;
  }
  const recovered = await getAgentTaskSnapshot(db, taskId, userId);
  if (
    committed.outcome === "paused" ||
    agentTaskPauseTransitionWasApplied(recovered, transition)
  ) {
    return recovered;
  }
  if (committed.outcome === "not_found") return null;
  if (
    committed.outcome === "lease_busy" ||
    committed.outcome === "lease_lost"
  ) {
    return recovered;
  }
  throw new AgentTaskStateTransitionError(
    "task_state_transition_conflict",
    "The Agent Task state changed before it could be paused.",
    {
      task_id: taskId,
      step_id: transition.stepId,
      expected_task_status: transition.expectedTaskStatus,
      expected_step_attempt: transition.expectedStepAttempt,
      transition_outcome: committed.outcome,
    },
  );
}

export async function pauseAgentTaskForStateTransition(
  db: Db,
  taskId: string,
  userId: string,
  error: AgentTaskStateTransitionError,
  options?: { leaseOwner?: string | null },
) {
  const snapshot = await getAgentTaskSnapshot(db, taskId, userId);
  if (!snapshot) return null;
  if (!["queued", "running", "verifying"].includes(snapshot.task.status)) {
    return snapshot;
  }
  const current = snapshot.task.current_plan.find(
    (step: { status: AgentStepStatus }) => step.status === "running",
  );
  const updatedAt = now();
  const previous =
    snapshot.task.latest_checkpoint &&
    typeof snapshot.task.latest_checkpoint === "object" &&
    !Array.isArray(snapshot.task.latest_checkpoint)
      ? (snapshot.task.latest_checkpoint as Record<string, unknown>)
      : {};
  return pauseAgentTaskSnapshotAtomically(db, taskId, userId, snapshot, {
    leaseOwner: options?.leaseOwner,
    latestCheckpoint: {
      ...previous,
      step_id: current?.id ?? snapshot.task.current_step ?? "planner",
      iteration: current?.attempt ?? 0,
      summary:
        "The server could not safely commit this Step transition. Existing work was preserved; resume after checking the execution service.",
      created_at: updatedAt,
      state_transition_pause: {
        kind: "agent_task_state_transition_pause_v1",
        created_at: updatedAt,
        issue: {
          kind: "agent_execution_issue_v1",
          code: error.code,
          category: "execution",
          recoverable: true,
          retry_scope: "current_step",
          facts: error.facts,
        },
      },
    },
  });
}

export async function deferAgentTaskForProvider(
  db: Db,
  taskId: string,
  userId: string,
  summary: string,
  options: {
    classification: AgentTaskExecutionPauseClassification;
    leaseOwner?: string | null;
    checkpointValues?: Record<string, unknown>;
    diagnostic?: AgentProviderDiagnosticV1 | null;
  },
) {
  const snapshot = await getAgentTaskSnapshot(db, taskId, userId);
  if (!snapshot) return null;
  const task = snapshot.task as {
    status: AgentTaskStatus;
    current_step?: string | null;
    latest_checkpoint?: unknown;
  };
  if (!["queued", "running", "verifying"].includes(task.status)) {
    return snapshot;
  }
  const current = snapshot.task.current_plan.find(
    (step: { status: AgentStepStatus }) => step.status === "running",
  );
  const updatedAt = now();
  const providerCheckpoint = mergeAgentTaskProviderPauseCheckpoint({
    previous: task.latest_checkpoint,
    currentStep: current ? { id: current.id, attempt: current.attempt } : null,
    classification: options.classification,
    summary,
    createdAt: updatedAt,
    diagnostic: options.diagnostic,
  });
  const checkpoint = options.checkpointValues
    ? mergeImmutableAgentTaskCheckpoint(providerCheckpoint, {
        ...providerCheckpoint,
        ...options.checkpointValues,
      })
    : providerCheckpoint;
  return pauseAgentTaskSnapshotAtomically(db, taskId, userId, snapshot, {
    leaseOwner: options.leaseOwner,
    latestCheckpoint: checkpoint,
  });
}

export async function pauseAgentTaskForContext(
  db: Db,
  taskId: string,
  userId: string,
  error: MatterContextInvalidError,
  options?: { leaseOwner?: string | null },
) {
  const snapshot = await getAgentTaskSnapshot(db, taskId, userId);
  if (!snapshot) return null;
  if (!["queued", "running", "verifying"].includes(snapshot.task.status)) {
    return snapshot;
  }
  const updatedAt = now();
  const previous =
    snapshot.task.latest_checkpoint &&
    typeof snapshot.task.latest_checkpoint === "object" &&
    !Array.isArray(snapshot.task.latest_checkpoint)
      ? (snapshot.task.latest_checkpoint as Record<string, unknown>)
      : {};
  return pauseAgentTaskSnapshotAtomically(db, taskId, userId, snapshot, {
    leaseOwner: options?.leaseOwner,
    latestCheckpoint: {
      ...previous,
      summary: error.message,
      created_at: updatedAt,
      context_pause: {
        kind: "agent_task_context_pause_v1",
        created_at: updatedAt,
        issue: {
          kind: "agent_execution_issue_v1",
          code: error.code,
          category: "context",
          recoverable: true,
          retry_scope: "task",
          facts: error.facts,
        },
      },
    },
  });
}

export async function pauseAgentTaskForStepPostcondition(
  db: Db,
  taskId: string,
  userId: string,
  input: {
    summary: string;
    facts: Record<string, unknown>;
    artifacts?: AgentArtifactLinkInput[];
    leaseOwner?: string | null;
  },
) {
  if (input.artifacts?.length) {
    await linkAgentTaskArtifacts(db, taskId, userId, input.artifacts);
  }
  const snapshot = await getAgentTaskSnapshot(db, taskId, userId);
  if (!snapshot) return null;
  if (!["running", "verifying"].includes(snapshot.task.status)) {
    return snapshot;
  }
  const current = snapshot.task.current_plan.find(
    (step: { status: AgentStepStatus }) => step.status === "running",
  );
  const updatedAt = now();
  const previous =
    snapshot.task.latest_checkpoint &&
    typeof snapshot.task.latest_checkpoint === "object" &&
    !Array.isArray(snapshot.task.latest_checkpoint)
      ? (snapshot.task.latest_checkpoint as Record<string, unknown>)
      : {};
  return pauseAgentTaskSnapshotAtomically(db, taskId, userId, snapshot, {
    leaseOwner: input.leaseOwner,
    latestCheckpoint: {
      ...previous,
      step_id: current?.id ?? snapshot.task.current_step,
      iteration: current?.attempt ?? 0,
      summary: input.summary,
      created_at: updatedAt,
      step_pause: {
        kind: "agent_task_step_pause_v1",
        created_at: updatedAt,
        issue: {
          kind: "agent_execution_issue_v1",
          code: "step_postcondition_unsatisfied",
          category: "execution",
          recoverable: true,
          retry_scope: "current_step",
          facts: input.facts,
        },
      },
    },
  });
}

export async function recordAgentTaskCheckpoint(
  db: Db,
  taskId: string,
  userId: string,
  summary: string,
) {
  const snapshot = await getAgentTaskSnapshot(db, taskId, userId);
  if (!snapshot) return null;
  const current = snapshot.task.current_plan.find(
    (step: { status: AgentStepStatus }) => step.status === "running",
  );
  const updatedAt = now();
  const { error } = await db
    .from("agent_tasks")
    .update({
      latest_checkpoint: current
        ? mergeImmutableAgentTaskCheckpoint(snapshot.task.latest_checkpoint, {
            step_id: current.id,
            iteration: current.attempt,
            summary,
            created_at: updatedAt,
          })
        : snapshot.task.latest_checkpoint,
      updated_at: updatedAt,
    })
    .eq("id", taskId)
    .eq("user_id", userId);
  if (error) throw dbError(error, "Failed to record task checkpoint");
  return getAgentTaskSnapshot(db, taskId, userId);
}

export function readAgentTaskRetryCheckpoint(task: {
  latest_checkpoint?: unknown;
}): AgentTaskRetryCheckpoint | null {
  const checkpoint = task.latest_checkpoint;
  if (!checkpoint || typeof checkpoint !== "object") return null;
  const retry = (checkpoint as { runner_retry?: unknown }).runner_retry;
  if (!retry || typeof retry !== "object") return null;
  const row = retry as Record<string, unknown>;
  if (
    typeof row.attempt !== "number" ||
    !Number.isInteger(row.attempt) ||
    row.attempt < 1 ||
    typeof row.retry_at !== "string" ||
    !["rate_limit", "provider_unavailable", "timeout", "network"].includes(
      String(row.classification),
    )
  ) {
    return null;
  }
  return {
    attempt: row.attempt,
    retry_at: row.retry_at,
    classification:
      row.classification as AgentTaskRetryCheckpoint["classification"],
  };
}

export function clearAgentTaskRunnerRetryCheckpoint(checkpoint: unknown) {
  if (
    !checkpoint ||
    typeof checkpoint !== "object" ||
    Array.isArray(checkpoint)
  ) {
    return checkpoint ?? null;
  }
  const { runner_retry: _runnerRetry, ...retained } = checkpoint as Record<
    string,
    unknown
  >;
  return retained;
}

export async function recordAgentTaskRetryCheckpoint(
  db: Db,
  taskId: string,
  userId: string,
  input: AgentTaskRetryCheckpoint,
) {
  const snapshot = await getAgentTaskSnapshot(db, taskId, userId);
  if (!snapshot) return null;
  const current = snapshot.task.current_plan.find(
    (step: { status: AgentStepStatus }) => step.status === "running",
  );
  const updatedAt = now();
  const retryTime = new Date(input.retry_at);
  const retryLabel = Number.isNaN(retryTime.getTime())
    ? "soon"
    : retryTime.toLocaleTimeString("en", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
  const { error } = await db
    .from("agent_tasks")
    .update({
      latest_checkpoint: {
        ...(snapshot.task.latest_checkpoint &&
        typeof snapshot.task.latest_checkpoint === "object"
          ? snapshot.task.latest_checkpoint
          : {}),
        step_id: current?.id ?? "planner",
        iteration: current?.attempt ?? 0,
        summary: `Model is busy. Retrying automatically at ${retryLabel}.`,
        created_at: updatedAt,
        runner_retry: input,
      },
      updated_at: updatedAt,
    })
    .eq("id", taskId)
    .eq("user_id", userId);
  if (error) throw dbError(error, "Failed to schedule task retry");
  return getAgentTaskSnapshot(db, taskId, userId);
}

export async function retryAgentTask(db: Db, taskId: string, userId: string) {
  const snapshot = await getAgentTaskSnapshot(db, taskId, userId);
  if (!snapshot) return null;
  if (!["failed", "waiting_input"].includes(snapshot.task.status)) {
    throw new Error("Only a failed or input-blocked task can be retried");
  }
  assertAgentTaskExecutionRecovery(snapshot.task);
  const current = snapshot.task.current_plan.find(
    (step: { status: AgentStepStatus }) => step.status === "blocked",
  );
  if (
    !current &&
    (snapshot.task.status !== "failed" || snapshot.task.current_step != null)
  ) {
    throw new Error("Blocked task has no recoverable step");
  }
  const activeIndex = current
    ? snapshot.task.current_plan.findIndex(
        (step: { id: string }) => step.id === current.id,
      )
    : -1;
  const transition: AgentTaskRetryTransitionInput = {
    taskId,
    userId,
    expectedTaskStatus: snapshot.task.status as "failed" | "waiting_input",
    stepId: current?.id ?? null,
    expectedStepAttempt: current?.attempt ?? null,
    latestCheckpoint: clearAgentTaskRunnerRetryCheckpoint(
      snapshot.task.latest_checkpoint,
    ),
  };
  const expectedStatus: AgentTaskStatus = current
    ? snapshot.task.current_plan.some(
        (step: { status: AgentStepStatus }, position: number) =>
          position > activeIndex && step.status === "pending",
      )
      ? "running"
      : "verifying"
    : "queued";
  let committed: Awaited<ReturnType<typeof commitAgentTaskRetryTransition>>;
  try {
    committed = await commitAgentTaskRetryTransition(db, transition);
  } catch (error) {
    if (!(error instanceof AgentTaskStateTransitionError)) throw error;
    const recovered = await getAgentTaskSnapshot(db, taskId, userId);
    if (agentTaskRetryTransitionWasApplied(recovered, transition)) {
      return recovered;
    }
    throw error;
  }
  const recovered = await getAgentTaskSnapshot(db, taskId, userId);
  if (
    committed.outcome === "retried" ||
    agentTaskRetryTransitionWasApplied(recovered, transition)
  ) {
    if (recovered?.task.status !== expectedStatus) {
      throw new Error(
        "The retried Step does not match the expected Task phase",
      );
    }
    return recovered;
  }
  if (committed.outcome === "lease_busy") {
    throw new Error(
      "The previous execution is still closing. Retry again in a moment.",
    );
  }
  if (!recovered) return null;
  throw new Error("Only one request can retry this task stage");
}

export function prepareAgentTaskRevisionTransition(
  snapshot: NonNullable<Awaited<ReturnType<typeof getAgentTaskSnapshot>>>,
  startedAt = now(),
  revisionId = randomUUID(),
) {
  if (snapshot.task.status !== "completed") {
    throw new Error("Only a completed task can start a revision");
  }
  const latestDecision = snapshot.review.decisions.at(-1) ?? null;
  if (latestDecision?.status !== "changes_requested") {
    throw new Error("Only a task with requested changes can start a revision");
  }
  if (!latestDecision.note.trim()) {
    throw new Error("Requested changes must include a lawyer direction");
  }

  const checkpoint =
    snapshot.task.latest_checkpoint &&
    typeof snapshot.task.latest_checkpoint === "object" &&
    !Array.isArray(snapshot.task.latest_checkpoint)
      ? (snapshot.task.latest_checkpoint as Record<string, unknown>)
      : {};
  const dispositionIntent = latestDecision.artifact_snapshot.find(
    (item) =>
      item &&
      typeof item === "object" &&
      !Array.isArray(item) &&
      (item as { kind?: unknown }).kind ===
        "contract_playbook_disposition_revision_v1",
  );

  const verifierPosition = snapshot.task.current_plan.length - 1;
  const contractRead = readAgentStepContracts(snapshot.task);
  if (contractRead.state === "invalid") {
    throw new Error(`Step Contract is invalid: ${contractRead.reason}`);
  }
  const dispositionRevisionStart =
    contractRead.state === "valid" && dispositionIntent !== undefined
      ? contractRead.contracts.findIndex(
          (contract, position) =>
            position > 0 &&
            position < verifierPosition &&
            contract.capability === "create_draft",
        )
      : -1;
  const contractedRevisionStart =
    contractRead.state === "valid"
      ? contractRead.contracts.findIndex(
          (contract, position) =>
            position > 0 &&
            position < verifierPosition &&
            contract.capability !== "read_sources" &&
            contract.capability !== "verify",
        )
      : -1;
  const revisionStart =
    dispositionRevisionStart >= 0
      ? dispositionRevisionStart
      : contractedRevisionStart >= 0
        ? contractedRevisionStart
        : Math.min(1, verifierPosition);
  const first = snapshot.task.current_plan[revisionStart];
  if (!first) throw new Error("Task has no revisable deliverable steps");
  if (
    snapshot.task.current_plan.some(
      (step: { status: AgentStepStatus }) =>
        step.status !== "completed" && step.status !== "skipped",
    )
  ) {
    throw new Error("Completed task has inconsistent revision Step states");
  }

  const nextAttempt = first.attempt + 1;
  const revisionRequest = {
    kind: "agent_task_revision_v1",
    revision_id: revisionId,
    review_decision_id: latestDecision.id,
    first_step_id: first.id,
    revision_start: revisionStart,
    attempt: nextAttempt,
    requested_at: startedAt,
    ...(dispositionIntent === undefined
      ? {}
      : { scope: "contract_playbook_dispositions_v1" }),
  };
  let revisedReceipt: unknown;
  if (dispositionIntent !== undefined) {
    const receipt = contractPlaybookReceiptSchema.parse(
      checkpoint.contract_playbook_pack_receipt,
    );
    revisedReceipt = applyContractPlaybookDispositionRevisionIntent({
      receipt,
      intent:
        contractPlaybookDispositionRevisionIntentSchema.parse(
          dispositionIntent,
        ),
    });
  }
  return {
    revisionStart,
    first,
    nextAttempt,
    revisionId,
    latestDecision,
    checkpoint: mergeImmutableAgentTaskCheckpoint(
      snapshot.task.latest_checkpoint,
      {
        step_id: first.id,
        iteration: nextAttempt,
        summary: `Revision requested: ${latestDecision.note.trim()}`.slice(
          0,
          4000,
        ),
        created_at: startedAt,
        revision_request: revisionRequest,
        ...(revisedReceipt === undefined
          ? {}
          : { contract_playbook_pack_receipt: revisedReceipt }),
      },
    ),
  };
}

export async function recordAgentTaskReviewDecision(
  db: Db,
  input: Omit<AgentTaskReviewDecisionTransitionInput, "decisionId"> & {
    decisionId?: string;
  },
) {
  const transition: AgentTaskReviewDecisionTransitionInput = {
    ...input,
    decisionId: input.decisionId ?? randomUUID(),
  };
  let committed: Awaited<
    ReturnType<typeof commitAgentTaskReviewDecisionTransition>
  >;
  try {
    committed = await commitAgentTaskReviewDecisionTransition(db, transition);
  } catch (error) {
    if (!(error instanceof AgentTaskStateTransitionError)) throw error;
    const recovered = await getAgentTaskSnapshot(
      db,
      transition.taskId,
      transition.userId,
    );
    if (agentTaskReviewDecisionTransitionWasApplied(recovered, transition)) {
      return recovered;
    }
    throw error;
  }
  const recovered = await getAgentTaskSnapshot(
    db,
    transition.taskId,
    transition.userId,
  );
  if (
    committed.outcome === "recorded" ||
    agentTaskReviewDecisionTransitionWasApplied(recovered, transition)
  ) {
    return recovered;
  }
  if (committed.outcome === "lease_busy") {
    throw new Error(
      "Task execution is still closing. Record the review decision again in a moment.",
    );
  }
  if (committed.outcome === "task_not_completed") {
    throw new Error("Lawyer review is available only after task completion");
  }
  if (committed.outcome === "invalid_artifacts") {
    throw new Error(
      "The approval snapshot no longer matches the current Matter deliverables.",
    );
  }
  if (!recovered) return null;
  throw new Error(
    "The Task review state changed before the decision was saved",
  );
}

export async function reviseAgentTask(db: Db, taskId: string, userId: string) {
  const snapshot = await getAgentTaskSnapshot(db, taskId, userId);
  if (!snapshot) return null;
  const prepared = prepareAgentTaskRevisionTransition(snapshot);
  const transition: AgentTaskRevisionTransitionInput = {
    taskId,
    userId,
    revisionId: prepared.revisionId,
    reviewDecisionId: prepared.latestDecision.id,
    firstStepId: prepared.first.id,
    revisionStart: prepared.revisionStart,
    expectedFirstStepAttempt: prepared.first.attempt,
    latestCheckpoint: prepared.checkpoint,
  };
  let committed: Awaited<ReturnType<typeof commitAgentTaskRevisionTransition>>;
  try {
    committed = await commitAgentTaskRevisionTransition(db, transition);
  } catch (error) {
    if (!(error instanceof AgentTaskStateTransitionError)) throw error;
    const recovered = await getAgentTaskSnapshot(db, taskId, userId);
    if (agentTaskRevisionTransitionWasApplied(recovered, transition)) {
      return recovered;
    }
    throw error;
  }
  const recovered = await getAgentTaskSnapshot(db, taskId, userId);
  if (committed.outcome === "revised") {
    if (
      committed.taskStatus !== "running" ||
      committed.currentStep !== prepared.first.id
    ) {
      throw new Error("The revision transition returned an unexpected phase");
    }
    return recovered;
  }
  if (agentTaskRevisionTransitionWasApplied(recovered, transition)) {
    return recovered;
  }
  if (committed.outcome === "lease_busy") {
    throw new Error(
      "The previous execution is still closing. Start the revision again in a moment.",
    );
  }
  if (!recovered) return null;
  throw new Error("Only one request can start this task revision");
}

export async function reverifyCompletedAgentTask(
  db: Db,
  taskId: string,
  userId: string,
) {
  const snapshot = await getAgentTaskSnapshot(db, taskId, userId);
  if (!snapshot) return null;
  if (snapshot.task.status !== "completed") {
    throw new Error("Only a completed task can restart verification");
  }
  const verifier = snapshot.task.current_plan.at(-1);
  const verifierReceipt = readAgentStepReceipts(
    snapshot.task.latest_checkpoint,
  ).at(-1);
  if (
    !verifier ||
    verifier.status !== "completed" ||
    verifierReceipt?.capability !== "verify" ||
    verifierReceipt.outcome !== "review_required"
  ) {
    throw new Error(
      "Re-verification is available only for a completed review gap",
    );
  }

  requireAgentTaskVerifierRetryStarted(
    await commitAgentTaskVerifierRetryTransition(db, {
      taskId,
      userId,
      retryId: [
      "agent-task-verifier-retry",
      taskId,
      verifier.id,
      verifier.attempt + 1,
      ].join(":"),
    }),
  );
  return getAgentTaskSnapshot(db, taskId, userId);
}

export async function attachAgentTaskDocuments(
  db: Db,
  taskId: string,
  userId: string,
  documentIds: string[],
) {
  return submitAgentTaskInput(db, taskId, userId, {
    documentIds,
  });
}

export async function submitAgentTaskInput(
  db: Db,
  taskId: string,
  userId: string,
  input: {
    message?: string;
    documentIds?: string[];
    responses?: AgentRequiredInputResponseV1[];
    serverCheckpointValues?: Record<string, unknown>;
  },
) {
  const snapshot = await getAgentTaskSnapshot(db, taskId, userId);
  if (!snapshot) return null;
  assertAgentTaskExecutionRecovery(snapshot.task);
  const updatedAt = now();
  const transition = prepareAgentTaskInputTransition(
    snapshot,
    input,
    updatedAt,
  );
  const { current, documentIds } = transition;
  const fixedMatterContext = readFixedMatterContext(snapshot.task);
  const extendedMatterContext =
    fixedMatterContext && documentIds.length
      ? await extendFixedMatterContext(
          db,
          fixedMatterContext,
          documentIds,
          updatedAt,
        )
      : fixedMatterContext;
  const revisedCheckpoint =
    fixedMatterContext && extendedMatterContext && documentIds.length
      ? extendAgentTaskContractContext({
          checkpoint: transition.checkpoint,
          previousContext: fixedMatterContext,
          nextContext: extendedMatterContext,
          requestId: transition.resolvedRequiredInputId,
          createdAt: updatedAt,
        })
      : transition.checkpoint;
  const checkpoint = extendedMatterContext
    ? {
        ...revisedCheckpoint,
        [FIXED_MATTER_CONTEXT_CHECKPOINT_KEY]: extendedMatterContext,
      }
    : revisedCheckpoint;
  const atomicInput: AgentTaskInputTransitionInput = {
    taskId,
    userId,
    stepId: current.id,
    expectedStepAttempt: current.attempt,
    documentIds,
    latestCheckpoint: checkpoint,
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
      committed.currentStep !== current.id
    ) {
      throw new Error("The input transition returned an unexpected Task phase");
    }
    return recovered;
  }
  if (agentTaskInputTransitionWasApplied(recovered, atomicInput)) {
    return recovered;
  }
  if (committed.outcome === "lease_busy") {
    throw new Error(
      "The previous execution is still closing. Submit the input again in a moment.",
    );
  }
  if (committed.outcome === "source_invalid") {
    throw new Error(
      "One or more supplemental documents are not ready current Versions in this Matter.",
    );
  }
  if (committed.outcome === "context_invalid") {
    throw new Error(
      "The fixed Matter source context changed before the input was committed.",
    );
  }
  if (committed.outcome === "invalid_input") {
    throw new AgentRequiredInputSubmissionError(
      "The required input submission did not match the fixed request.",
    );
  }
  if (committed.outcome === "not_found") return null;
  if (committed.outcome === "conflict") {
    throw new Error(
      "The required input request changed or was already resolved.",
    );
  }
  if (!recovered) return null;
  throw new Error("The blocked task step could not be resumed safely.");
}

export async function pauseAgentTask(db: Db, taskId: string, userId: string) {
  const snapshot = await getAgentTaskSnapshot(db, taskId, userId);
  if (!snapshot) return null;
  if (!["running", "verifying"].includes(snapshot.task.status)) {
    throw new Error("Only a running or verifying task can be paused");
  }
  return pauseAgentTaskSnapshotAtomically(db, taskId, userId, snapshot, {
    forceRevoke: true,
    latestCheckpoint: snapshot.task.latest_checkpoint,
  });
}

export async function resumeAgentTask(db: Db, taskId: string, userId: string) {
  const snapshot = await getAgentTaskSnapshot(db, taskId, userId);
  if (!snapshot) return null;
  if (snapshot.task.status !== "paused") {
    throw new Error("Only a paused task can be resumed");
  }
  assertAgentTaskExecutionRecovery(snapshot.task);
  const retryCheckpoint = readAgentTaskRetryCheckpoint(snapshot.task);
  const clearedCheckpoint = clearAgentTaskRunnerRetryCheckpoint(
    snapshot.task.latest_checkpoint,
  );
  const latestCheckpoint =
    retryCheckpoint &&
    clearedCheckpoint &&
    typeof clearedCheckpoint === "object" &&
    !Array.isArray(clearedCheckpoint)
      ? {
          ...clearedCheckpoint,
          summary:
            "Task resumed. Retrying the current step with a fresh automatic retry budget.",
          created_at: now(),
        }
      : clearedCheckpoint;
  let committed: Awaited<ReturnType<typeof commitAgentTaskResumeTransition>>;
  try {
    committed = await commitAgentTaskResumeTransition(db, {
      taskId,
      userId,
      latestCheckpoint,
    });
  } catch (error) {
    if (!(error instanceof AgentTaskStateTransitionError)) throw error;
    const recovered = await getAgentTaskSnapshot(db, taskId, userId);
    if (agentTaskResumeTransitionWasApplied(recovered)) return recovered;
    throw error;
  }
  const recovered = await getAgentTaskSnapshot(db, taskId, userId);
  if (
    committed.outcome === "resumed" ||
    agentTaskResumeTransitionWasApplied(recovered)
  ) {
    return recovered;
  }
  if (committed.outcome === "not_found") return null;
  throw new Error("Only a paused task with a consistent Step can be resumed");
}

export async function updateAgentTaskExecutionModel(
  db: Db,
  taskId: string,
  userId: string,
  executionModel: string,
) {
  const { data: task, error: taskError } = await db
    .from("agent_tasks")
    .select("id,status,latest_checkpoint")
    .eq("id", taskId)
    .eq("user_id", userId)
    .maybeSingle();
  if (taskError) throw dbError(taskError, "Failed to load task");
  if (!task) return null;
  if (["running", "verifying", "completed"].includes(task.status)) {
    throw new Error(
      `Only a queued, paused, failed, or input-blocked task can switch models (current: ${task.status})`,
    );
  }
  const updatedAt = now();
  const retryCheckpoint = readAgentTaskRetryCheckpoint({
    latest_checkpoint: task.latest_checkpoint,
  });
  const clearedCheckpoint = retryCheckpoint
    ? clearAgentTaskRunnerRetryCheckpoint(task.latest_checkpoint)
    : task.latest_checkpoint;
  const nextCheckpoint =
    retryCheckpoint &&
    clearedCheckpoint &&
    typeof clearedCheckpoint === "object" &&
    !Array.isArray(clearedCheckpoint)
      ? {
          ...clearedCheckpoint,
          summary: `Model changed to ${executionModel}. Resume retries the current step with the new model.`,
          created_at: updatedAt,
        }
      : clearedCheckpoint;
  const { error } = await db
    .from("agent_tasks")
    .update({
      execution_model: executionModel,
      latest_checkpoint: nextCheckpoint,
      updated_at: updatedAt,
    })
    .eq("id", taskId)
    .eq("user_id", userId)
    .eq("status", task.status);
  if (error) throw dbError(error, "Failed to update task model");
  return getAgentTaskSnapshot(db, taskId, userId);
}

export async function stopAgentTask(
  db: Db,
  taskId: string,
  userId: string,
  input: {
    status: "waiting_input" | "failed";
    summary: string;
    requiredInput?: AgentRequiredInputV1 | null;
    checkpointValues?: Record<string, unknown>;
    leaseOwner: string;
  },
) {
  const snapshot = await getAgentTaskSnapshot(db, taskId, userId);
  if (!snapshot) return null;
  const current = snapshot.task.current_plan.find(
    (step: { status: AgentStepStatus }) => step.status === "running",
  );
  const updatedAt = now();
  if (!["queued", "running", "verifying"].includes(snapshot.task.status)) {
    return snapshot;
  }
  const checkpoint = mergeImmutableAgentTaskCheckpoint(
    snapshot.task.latest_checkpoint,
    {
      step_id: current?.id ?? "planner",
      iteration: current?.attempt ?? 0,
      summary: input.summary,
      created_at: updatedAt,
      ...(input.checkpointValues ?? {}),
      ...(input.requiredInput ? { required_input: input.requiredInput } : {}),
    },
  );
  const transition: AgentTaskStopTransitionInput = {
    taskId,
    userId,
    leaseOwner: input.leaseOwner,
    expectedTaskStatus: snapshot.task.status as
      | "queued"
      | "running"
      | "verifying",
    stepId: current?.id ?? null,
    expectedStepAttempt: current?.attempt ?? null,
    targetStatus: input.status,
    resultSummary: input.summary.trim() || "Task stopped.",
    latestCheckpoint: checkpoint ?? {},
  };
  try {
    const committed = await commitAgentTaskStopTransition(db, transition);
    const recovered = await getAgentTaskSnapshot(db, taskId, userId);
    if (
      committed.outcome === "stopped" ||
      agentTaskStopTransitionWasApplied(recovered, transition)
    ) {
      return recovered;
    }
    if (committed.outcome === "lease_lost") return recovered;
    if (
      !recovered ||
      !["queued", "running", "verifying"].includes(recovered.task.status)
    ) {
      return recovered;
    }
    throw new AgentTaskStateTransitionError(
      "task_state_transition_conflict",
      "The Agent Task state changed before it could be stopped.",
      {
        task_id: taskId,
        step_id: current?.id ?? null,
        expected_task_status: snapshot.task.status,
        expected_step_attempt: current?.attempt ?? null,
        target_status: input.status,
        transition_outcome: committed.outcome,
      },
    );
  } catch (error) {
    if (!(error instanceof AgentTaskStateTransitionError)) throw error;
    const recovered = await getAgentTaskSnapshot(db, taskId, userId);
    if (agentTaskStopTransitionWasApplied(recovered, transition)) {
      return recovered;
    }
    return pauseAgentTaskForStateTransition(db, taskId, userId, error, {
      leaseOwner: input.leaseOwner,
    });
  }
}
