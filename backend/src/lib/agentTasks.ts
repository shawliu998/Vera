import { createServerSupabase } from "./supabase";

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
  },
  {
    key: "review-memo",
    title: "Review memo",
    description: "Facts, analysis, recommendations, and open questions.",
    required: true,
    artifact_type: "draft",
  },
];

function now() {
  return new Date().toISOString();
}

function dbError(error: { message: string } | null, fallback: string) {
  return new Error(error?.message ?? fallback);
}

export async function createAgentTask(
  db: Db,
  input: {
    userId: string;
    matterId: string;
    goal: string;
    executionModel: string;
    plan?: StepDefinition[];
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
      deliverables: DEFAULT_DELIVERABLES,
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
  ]);
  if (stepsError) throw dbError(stepsError, "Failed to load task plan");
  if (artifactsError)
    throw dbError(artifactsError, "Failed to load task artifacts");

  const { user_id: _userId, ...publicTask } = task;
  return {
    task: {
      ...publicTask,
      current_plan: (steps ?? []).map(
        ({ position: _position, ...step }) => step,
      ),
    },
    artifacts: artifacts ?? [],
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
  return data ?? [];
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
    const match = links.find((link) =>
      deliverable.key === "risk-matrix"
        ? link.purpose === "Risk matrix"
        : deliverable.key === "review-memo"
          ? link.purpose === "Review memo draft"
          : false,
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

export async function attachAgentTaskDocuments(
  db: Db,
  taskId: string,
  userId: string,
  documentIds: string[],
) {
  const snapshot = await getAgentTaskSnapshot(db, taskId, userId);
  if (!snapshot) return null;
  await addAgentArtifactLinks(
    db,
    taskId,
    documentIds.map((artifactId) => ({
      artifact_type: "document" as const,
      artifact_id: artifactId,
      purpose: "Source document",
    })),
  );
  if (snapshot.task.status === "waiting_input") {
    return retryAgentTask(db, taskId, userId);
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
  if (
    ["running", "verifying", "completed"].includes(task.status)
  ) {
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
