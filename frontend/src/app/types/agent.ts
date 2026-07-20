export type AgentMode = "ask" | "work";

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

export type AgentDeliverable = {
  key: string;
  title: string;
  description?: string;
  required: boolean;
  artifact_type?: AgentArtifactType;
  artifact_id?: string;
};

export type AgentCheckpoint = {
  step_id: string;
  iteration: number;
  summary: string;
  created_at: string;
};

export type AgentTask = {
  id: string;
  matter_id: string;
  goal: string;
  mode: AgentMode;
  status: AgentTaskStatus;
  deliverables: AgentDeliverable[];
  current_plan: AgentStep[];
  current_step: string | null;
  latest_checkpoint: AgentCheckpoint | null;
  created_at: string;
  updated_at: string;
};

export type AgentStep = {
  id: string;
  task_id: string;
  title: string;
  status: AgentStepStatus;
  expected_output: string;
  attempt: number;
  result_summary: string | null;
};

export type AgentArtifactType =
  | "chat"
  | "document"
  | "draft"
  | "workflow_run"
  | "citation_snapshot"
  | "tabular_review";

export type ArtifactLink = {
  task_id: string;
  artifact_type: AgentArtifactType;
  artifact_id: string;
  purpose: string;
};

export type AgentArtifactLink = ArtifactLink;

export type AgentTaskSnapshot = {
  task: AgentTask;
  artifacts: ArtifactLink[];
};
