import { createServerSupabase } from "./supabase";
import { taskDeliverablePurpose } from "./agentTaskDeliverables";
import type {
  AgentTaskDeliverableDefinition,
  AgentTaskPlanningRequest,
  GoalAwareTaskPlan,
} from "./agentTaskPlanner";

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

export type AgentTaskRetryCheckpoint = {
  attempt: number;
  retry_at: string;
  classification: "rate_limit" | "provider_unavailable" | "network";
};

export type AgentTaskSupplementalInput = {
  step_id: string;
  attempt: number;
  submitted_at: string;
  message?: string;
  document_ids: string[];
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
  return {
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
  input: { message?: string; documentIds?: string[] },
  submittedAt = now(),
) {
  const message = input.message?.trim() ?? "";
  const documentIds = Array.from(
    new Set((input.documentIds ?? []).map((documentId) => documentId.trim())),
  ).filter(Boolean);
  if (!message && !documentIds.length) {
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
  delete checkpoint.runner_retry;
  delete checkpoint.planner_request;
  delete checkpoint.user_input;
  const userInput = {
    step_id: current.id,
    attempt: nextAttempt,
    submitted_at: submittedAt,
    ...(message ? { message } : {}),
    document_ids: documentIds,
  } satisfies AgentTaskSupplementalInput;
  return {
    current,
    nextAttempt,
    documentIds,
    status: (activeIndex === snapshot.task.current_plan.length - 1
      ? "verifying"
      : "running") as AgentTaskStatus,
    checkpoint: {
      ...checkpoint,
      step_id: current.id,
      iteration: nextAttempt,
      summary:
        typeof checkpoint.summary === "string"
          ? checkpoint.summary
          : "User input received. Continuing automatically.",
      created_at: submittedAt,
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

export async function reserveAgentTaskInputStep(
  db: Db,
  input: {
    taskId: string;
    stepId: string;
    currentAttempt: number;
    nextAttempt: number;
    updatedAt: string;
  },
) {
  const { data, error } = await db
    .from("agent_steps")
    .update({
      status: "running",
      attempt: input.nextAttempt,
      updated_at: input.updatedAt,
    })
    .eq("id", input.stepId)
    .eq("task_id", input.taskId)
    .eq("status", "blocked")
    .eq("attempt", input.currentAttempt)
    .select("id")
    .maybeSingle();
  if (error) throw dbError(error, "Failed to reserve task step");
  return Boolean(data);
}

export async function createAgentTask(
  db: Db,
  input: {
    userId: string;
    matterId: string;
    goal: string;
    executionModel: string;
    plan?: StepDefinition[];
    deliverables?: AgentTaskDeliverableDefinition[];
    planningRequest?: AgentTaskPlanningRequest;
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
      latest_checkpoint: input.planningRequest
        ? {
            step_id: "planner",
            iteration: 0,
            summary: "Preparing a goal-aligned work plan.",
            created_at: now(),
            planner_request: input.planningRequest,
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
      latest_checkpoint: null,
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
        "id,task_id,title,status,expected_output,attempt,result_summary,position",
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
  return {
    task: {
      ...publicTask,
      current_plan: (steps ?? []).map(
        ({ position: _position, ...step }) => step,
      ),
    },
    artifacts: artifacts ?? [],
    review: {
      status:
        latestReview?.status ??
        (task.status === "completed" ? "review_required" : null),
      decisions,
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
        "id,task_id,title,status,expected_output,attempt,result_summary,position",
      )
      .in(
        "task_id",
        tasks.map((task) => task.id),
      )
      .order("position", { ascending: true }),
    db
      .from("agent_task_review_decisions")
      .select("id,task_id,status,created_at")
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
  const reviewByTask = new Map<string, AgentReviewDecision["status"]>();
  for (const decision of reviewDecisions ?? []) {
    reviewByTask.set(
      decision.task_id as string,
      decision.status as AgentReviewDecision["status"],
    );
  }

  return tasks.map((task) => ({
    ...task,
    review_status:
      reviewByTask.get(task.id) ??
      (task.status === "completed" ? "review_required" : null),
    current_plan: (stepsByTask.get(task.id) ?? []).map(
      ({ position: _position, ...step }) => step,
    ),
  }));
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
  result?: { summary?: string; artifacts?: AgentArtifactLinkInput[] },
) {
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

  if (task.status === "queued") {
    currentIndex = steps.findIndex((step) => step.status === "pending");
    if (currentIndex < 0) throw new Error("Task has no executable steps");
    const current = steps[currentIndex];
    const { error } = await db
      .from("agent_steps")
      .update({
        status: "running",
        attempt: current.attempt + 1,
        updated_at: updatedAt,
      })
      .eq("id", current.id)
      .eq("task_id", taskId);
    if (error) throw dbError(error, "Failed to start task step");
  } else {
    if (currentIndex < 0) throw new Error("Running task has no current step");
    const current = steps[currentIndex];
    const summary = result?.summary?.trim() || "Step completed.";
    const { error } = await db
      .from("agent_steps")
      .update({
        status: "completed",
        result_summary: summary,
        updated_at: updatedAt,
      })
      .eq("id", current.id)
      .eq("task_id", taskId);
    if (error) throw dbError(error, "Failed to complete task step");
    if (result?.artifacts?.length) {
      await linkAgentTaskArtifacts(db, taskId, userId, result.artifacts);
    }
    currentIndex += 1;
    if (currentIndex < steps.length) {
      const next = steps[currentIndex];
      const { error: nextError } = await db
        .from("agent_steps")
        .update({
          status: "running",
          attempt: next.attempt + 1,
          updated_at: updatedAt,
        })
        .eq("id", next.id)
        .eq("task_id", taskId);
      if (nextError) throw dbError(nextError, "Failed to start next task step");
    }
  }

  const isComplete = currentIndex >= steps.length;
  const isVerifying = !isComplete && currentIndex === steps.length - 1;
  const activeStep = isComplete ? null : steps[currentIndex];
  const completedStep =
    task.status === "queued" ? null : steps[currentIndex - 1];
  const { error: taskUpdateError } = await db
    .from("agent_tasks")
    .update({
      status: isComplete ? "completed" : isVerifying ? "verifying" : "running",
      current_step: activeStep?.id ?? null,
      latest_checkpoint: completedStep
        ? {
            step_id: completedStep.id,
            iteration: completedStep.attempt,
            summary: result?.summary?.trim() || "Step completed.",
            created_at: updatedAt,
          }
        : snapshot.task.latest_checkpoint,
      updated_at: updatedAt,
    })
    .eq("id", taskId)
    .eq("user_id", userId);
  if (taskUpdateError)
    throw dbError(taskUpdateError, "Failed to update task state");
  if (isComplete) {
    const { error: reviewError } = await db
      .from("agent_task_review_decisions")
      .insert({
        task_id: taskId,
        status: "review_required",
        note: "Execution and automated verification completed. Lawyer review is required before final export.",
        artifact_snapshot: [],
      });
    if (reviewError) throw dbError(reviewError, "Failed to open lawyer review");
  }
  return getAgentTaskSnapshot(db, taskId, userId);
}

export async function deferAgentTaskForProvider(
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
      status: "paused",
      latest_checkpoint: current
        ? {
            step_id: current.id,
            iteration: current.attempt,
            summary,
            created_at: updatedAt,
          }
        : snapshot.task.latest_checkpoint,
      updated_at: updatedAt,
    })
    .eq("id", taskId)
    .eq("user_id", userId);
  if (error) throw dbError(error, "Failed to defer provider-queued task");
  return getAgentTaskSnapshot(db, taskId, userId);
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
        ? {
            step_id: current.id,
            iteration: current.attempt,
            summary,
            created_at: updatedAt,
          }
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
    !["rate_limit", "provider_unavailable", "network"].includes(
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
  const current = snapshot.task.current_plan.find(
    (step: { status: AgentStepStatus }) => step.status === "blocked",
  );
  if (!current) throw new Error("Blocked task has no recoverable step");
  const activeIndex = snapshot.task.current_plan.findIndex(
    (step: { id: string }) => step.id === current.id,
  );
  const updatedAt = now();
  const { error: stepError } = await db
    .from("agent_steps")
    .update({
      status: "running",
      attempt: current.attempt + 1,
      updated_at: updatedAt,
    })
    .eq("id", current.id)
    .eq("task_id", taskId);
  if (stepError) throw dbError(stepError, "Failed to retry task step");
  const status: AgentTaskStatus =
    activeIndex === snapshot.task.current_plan.length - 1
      ? "verifying"
      : "running";
  const { error } = await db
    .from("agent_tasks")
    .update({ status, current_step: current.id, updated_at: updatedAt })
    .eq("id", taskId)
    .eq("user_id", userId);
  if (error) throw dbError(error, "Failed to retry task");
  return getAgentTaskSnapshot(db, taskId, userId);
}

export async function reviseAgentTask(db: Db, taskId: string, userId: string) {
  const snapshot = await getAgentTaskSnapshot(db, taskId, userId);
  if (!snapshot) return null;
  if (snapshot.task.status !== "completed") {
    throw new Error("Only a completed task can start a revision");
  }
  const latestDecision = snapshot.review.decisions.at(-1) ?? null;
  if (latestDecision?.status !== "changes_requested") {
    throw new Error("Only a task with requested changes can start a revision");
  }

  const verifierPosition = snapshot.task.current_plan.length - 1;
  const generatedStep = snapshot.task.current_plan.findIndex(
    (step: { title: string; expected_output: string }, position: number) =>
      position > 0 &&
      position < verifierPosition &&
      /create|draft|revise|proofread|matrix|table|work product|生成|起草|修订|表格|矩阵/i.test(
        `${step.title} ${step.expected_output}`,
      ),
  );
  const revisionStart =
    generatedStep >= 0 ? generatedStep : Math.min(2, verifierPosition);
  const { data: revisionSteps, error: stepsError } = await db
    .from("agent_steps")
    .select("id,attempt,position")
    .eq("task_id", taskId)
    .gte("position", revisionStart)
    .order("position", { ascending: true });
  if (stepsError) throw dbError(stepsError, "Failed to load revision steps");
  const first = revisionSteps?.[0];
  if (!first) throw new Error("Task has no revisable deliverable steps");

  const updatedAt = now();
  const { error: resetError } = await db
    .from("agent_steps")
    .update({
      status: "pending",
      result_summary: null,
      updated_at: updatedAt,
    })
    .eq("task_id", taskId)
    .gte("position", revisionStart);
  if (resetError) throw dbError(resetError, "Failed to reset revision steps");

  const { error: startError } = await db
    .from("agent_steps")
    .update({
      status: "running",
      attempt: ((first.attempt as number | null) ?? 0) + 1,
      updated_at: updatedAt,
    })
    .eq("id", first.id)
    .eq("task_id", taskId);
  if (startError) throw dbError(startError, "Failed to start task revision");

  const note = latestDecision.note.trim();
  const { error: taskError } = await db
    .from("agent_tasks")
    .update({
      status: "running",
      current_step: first.id,
      latest_checkpoint: {
        step_id: first.id,
        iteration: ((first.attempt as number | null) ?? 0) + 1,
        summary: `Revision requested: ${note}`.slice(0, 4000),
        created_at: updatedAt,
      },
      updated_at: updatedAt,
    })
    .eq("id", taskId)
    .eq("user_id", userId);
  if (taskError) throw dbError(taskError, "Failed to start task revision");
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
  input: { message?: string; documentIds?: string[] },
) {
  const snapshot = await getAgentTaskSnapshot(db, taskId, userId);
  if (!snapshot) return null;
  const updatedAt = now();
  const transition = prepareAgentTaskInputTransition(
    snapshot,
    input,
    updatedAt,
  );
  const { current, nextAttempt, documentIds } = transition;
  const reserved = await reserveAgentTaskInputStep(db, {
    taskId,
    stepId: current.id,
    currentAttempt: current.attempt,
    nextAttempt,
    updatedAt,
  });
  if (!reserved) {
    throw new Error("Only one response can resume the blocked task step");
  }

  let activated = false;
  try {
    await addAgentArtifactLinks(
      db,
      taskId,
      documentIds.map((artifactId) => ({
        artifact_type: "document" as const,
        artifact_id: artifactId,
        purpose: "Source document",
      })),
    );
    const { data: updatedTask, error: taskError } = await db
      .from("agent_tasks")
      .update({
        status: transition.status,
        current_step: current.id,
        latest_checkpoint: transition.checkpoint,
        updated_at: updatedAt,
      })
      .eq("id", taskId)
      .eq("user_id", userId)
      .eq("status", "waiting_input")
      .select("id")
      .maybeSingle();
    if (taskError) throw dbError(taskError, "Failed to resume task with input");
    if (!updatedTask) {
      throw new Error("Only one response can resume the blocked task step");
    }
    activated = true;
  } finally {
    if (!activated) {
      await db
        .from("agent_steps")
        .update({
          status: "blocked",
          attempt: current.attempt,
          updated_at: now(),
        })
        .eq("id", current.id)
        .eq("task_id", taskId)
        .eq("status", "running")
        .eq("attempt", nextAttempt);
    }
  }
  return getAgentTaskSnapshot(db, taskId, userId);
}

export async function pauseAgentTask(db: Db, taskId: string, userId: string) {
  const snapshot = await getAgentTaskSnapshot(db, taskId, userId);
  if (!snapshot) return null;
  if (!["running", "verifying"].includes(snapshot.task.status)) {
    throw new Error("Only a running or verifying task can be paused");
  }
  const { error } = await db
    .from("agent_tasks")
    .update({ status: "paused", updated_at: now() })
    .eq("id", taskId)
    .eq("user_id", userId);
  if (error) throw dbError(error, "Failed to pause task");
  return getAgentTaskSnapshot(db, taskId, userId);
}

export async function resumeAgentTask(db: Db, taskId: string, userId: string) {
  const snapshot = await getAgentTaskSnapshot(db, taskId, userId);
  if (!snapshot) return null;
  if (snapshot.task.status !== "paused") {
    throw new Error("Only a paused task can be resumed");
  }
  const steps = snapshot.task.current_plan as Array<{
    status: AgentStepStatus;
  }>;
  const activeIndex = steps.findIndex((step) => step.status === "running");
  const status: AgentTaskStatus =
    activeIndex === steps.length - 1 ? "verifying" : "running";
  const { error } = await db
    .from("agent_tasks")
    .update({ status, updated_at: now() })
    .eq("id", taskId)
    .eq("user_id", userId);
  if (error) throw dbError(error, "Failed to resume task");
  return getAgentTaskSnapshot(db, taskId, userId);
}

export async function updateAgentTaskExecutionModel(
  db: Db,
  taskId: string,
  userId: string,
  executionModel: string,
) {
  const { data: task, error: taskError } = await db
    .from("agent_tasks")
    .select("id,status")
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
  const { error } = await db
    .from("agent_tasks")
    .update({ execution_model: executionModel, updated_at: now() })
    .eq("id", taskId)
    .eq("user_id", userId);
  if (error) throw dbError(error, "Failed to update task model");
  return getAgentTaskSnapshot(db, taskId, userId);
}

export async function stopAgentTask(
  db: Db,
  taskId: string,
  userId: string,
  input: { status: "waiting_input" | "failed"; summary: string },
) {
  const snapshot = await getAgentTaskSnapshot(db, taskId, userId);
  if (!snapshot) return null;
  const current = snapshot.task.current_plan.find(
    (step: { status: AgentStepStatus }) => step.status === "running",
  );
  const updatedAt = now();
  if (current) {
    const { error: stepError } = await db
      .from("agent_steps")
      .update({
        status: "blocked",
        result_summary: input.summary,
        updated_at: updatedAt,
      })
      .eq("id", current.id)
      .eq("task_id", taskId);
    if (stepError) throw dbError(stepError, "Failed to block task step");
  }
  const { error } = await db
    .from("agent_tasks")
    .update({
      status: input.status,
      current_step: current?.id ?? snapshot.task.current_step,
      latest_checkpoint: current
        ? {
            step_id: current.id,
            iteration: current.attempt,
            summary: input.summary,
            created_at: updatedAt,
          }
        : snapshot.task.latest_checkpoint,
      updated_at: updatedAt,
    })
    .eq("id", taskId)
    .eq("user_id", userId);
  if (error) throw dbError(error, "Failed to stop task");
  return getAgentTaskSnapshot(db, taskId, userId);
}
