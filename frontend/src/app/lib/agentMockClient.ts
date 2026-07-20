import type {
  AgentArtifactType,
  AgentStep,
  AgentTask,
  AgentTaskSnapshot,
  ArtifactLink,
} from "@/app/types/agent";

const STORAGE_PREFIX = "vera:mock-agent-task:";

const STEP_DEFINITIONS = [
  {
    title: "Read the matter documents",
    expected_output: "A complete source set with stable document references.",
  },
  {
    title: "Extract facts and contract positions",
    expected_output: "Verified facts separated from assumptions and open questions.",
  },
  {
    title: "Build the risk matrix",
    expected_output: "A clause-by-clause risk matrix linked to source passages.",
  },
  {
    title: "Draft the review memo",
    expected_output: "A reviewable memo draft with citations and recommendations.",
  },
  {
    title: "Verify deliverables",
    expected_output: "Coverage, source, contradiction, and artifact checks completed.",
  },
] as const;

const RESULT_SUMMARIES = [
  "Read 1 source document and retained the current document version for citation checks.",
  "Separated verified contract terms from one unresolved liability-cap conclusion.",
  "Created a six-item risk matrix with source-linked findings and review flags.",
  "Created a review memo draft; legal conclusions remain marked for lawyer review.",
  "All required deliverables exist, citations resolve, and no execution step remains open.",
] as const;

const ARTIFACTS_BY_STEP: Partial<
  Record<number, { artifact_type: AgentArtifactType; artifact_id: string; purpose: string }>
> = {
  0: {
    artifact_type: "document",
    artifact_id: "synthetic-software-license-review",
    purpose: "Source document set",
  },
  2: {
    artifact_type: "tabular_review",
    artifact_id: "contract-risk-matrix",
    purpose: "Clause risk matrix",
  },
  3: {
    artifact_type: "draft",
    artifact_id: "review-memo-draft",
    purpose: "Review memo draft",
  },
};

export type CreateMockAgentTaskInput = {
  goal: string;
  matterId?: string;
};

function now() {
  return new Date().toISOString();
}

function storageKey(taskId: string) {
  return `${STORAGE_PREFIX}${taskId}`;
}

function readSnapshot(taskId: string): AgentTaskSnapshot | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(storageKey(taskId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AgentTaskSnapshot;
  } catch {
    return null;
  }
}

function writeSnapshot(snapshot: AgentTaskSnapshot) {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(storageKey(snapshot.task.id), JSON.stringify(snapshot));
  }
  return snapshot;
}

function buildSteps(taskId: string): AgentStep[] {
  return STEP_DEFINITIONS.map((definition, index) => ({
    id: `${taskId}:step:${index + 1}`,
    task_id: taskId,
    title: definition.title,
    status: "pending",
    expected_output: definition.expected_output,
    attempt: 0,
    result_summary: null,
  }));
}

export async function createMockAgentTask(
  input: CreateMockAgentTaskInput,
): Promise<AgentTaskSnapshot> {
  const taskId = `mock-${crypto.randomUUID()}`;
  const createdAt = now();
  const steps = buildSteps(taskId);
  const task: AgentTask = {
    id: taskId,
    matter_id: input.matterId ?? "matter-project-cedar",
    goal: input.goal,
    mode: "work",
    status: "queued",
    deliverables: [
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
    ],
    current_plan: steps,
    current_step: null,
    latest_checkpoint: null,
    created_at: createdAt,
    updated_at: createdAt,
  };
  return writeSnapshot({ task, artifacts: [] });
}

export async function getMockAgentTask(taskId: string) {
  return readSnapshot(taskId);
}

export async function advanceMockAgentTask(taskId: string) {
  const snapshot = readSnapshot(taskId);
  if (!snapshot) throw new Error("Mock task not found");
  if (["completed", "failed", "paused", "waiting_input"].includes(snapshot.task.status)) {
    return snapshot;
  }

  const steps = snapshot.task.current_plan.map((step) => ({ ...step }));
  let currentIndex = steps.findIndex((step) => step.status === "running");

  if (snapshot.task.status === "queued") {
    currentIndex = 0;
    steps[0].status = "running";
    steps[0].attempt = 1;
  } else if (currentIndex >= 0) {
    steps[currentIndex].status = "completed";
    steps[currentIndex].result_summary = RESULT_SUMMARIES[currentIndex];
    const producedArtifact = ARTIFACTS_BY_STEP[currentIndex];
    if (
      producedArtifact &&
      !snapshot.artifacts.some(
        (artifact) => artifact.artifact_id === producedArtifact.artifact_id,
      )
    ) {
      snapshot.artifacts = [
        ...snapshot.artifacts,
        { task_id: taskId, ...producedArtifact } satisfies ArtifactLink,
      ];
    }
    currentIndex += 1;
    if (currentIndex < steps.length) {
      steps[currentIndex].status = "running";
      steps[currentIndex].attempt += 1;
    }
  }

  const isComplete = steps.every((step) =>
    ["completed", "skipped"].includes(step.status),
  );
  const isVerifying = !isComplete && currentIndex === steps.length - 1;
  const updatedAt = now();
  const completedStep = [...steps].reverse().find((step) => step.status === "completed");

  snapshot.task = {
    ...snapshot.task,
    status: isComplete ? "completed" : isVerifying ? "verifying" : "running",
    current_plan: steps,
    current_step: isComplete ? null : steps[currentIndex]?.id ?? null,
    latest_checkpoint: completedStep
      ? {
          step_id: completedStep.id,
          iteration: completedStep.attempt,
          summary: completedStep.result_summary ?? "Step completed.",
          created_at: updatedAt,
        }
      : snapshot.task.latest_checkpoint,
    deliverables: snapshot.task.deliverables.map((deliverable) => {
      const artifact = snapshot.artifacts.find(
        (candidate) => candidate.artifact_type === deliverable.artifact_type,
      );
      return artifact
        ? { ...deliverable, artifact_id: artifact.artifact_id }
        : deliverable;
    }),
    updated_at: updatedAt,
  };
  return writeSnapshot(snapshot);
}

export async function pauseMockAgentTask(taskId: string) {
  const snapshot = readSnapshot(taskId);
  if (!snapshot) throw new Error("Mock task not found");
  snapshot.task = { ...snapshot.task, status: "paused", updated_at: now() };
  return writeSnapshot(snapshot);
}

export async function resumeMockAgentTask(taskId: string) {
  const snapshot = readSnapshot(taskId);
  if (!snapshot) throw new Error("Mock task not found");
  const verifying = snapshot.task.current_plan.findIndex(
    (step) => step.status === "running",
  ) === snapshot.task.current_plan.length - 1;
  snapshot.task = {
    ...snapshot.task,
    status: verifying ? "verifying" : "running",
    updated_at: now(),
  };
  return writeSnapshot(snapshot);
}
