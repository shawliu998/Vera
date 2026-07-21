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
  "pending" | "running" | "completed" | "blocked" | "skipped";

export type AgentDeliverable = {
  key: string;
  title: string;
  description?: string;
  required: boolean;
  artifact_type?: AgentArtifactType;
  artifact_id?: string;
  purpose?: string;
};

export type AgentCheckpoint = {
  step_id: string;
  iteration: number;
  summary: string;
  created_at: string;
  runner_retry?: {
    attempt: number;
    retry_at: string;
    classification: "rate_limit" | "provider_unavailable" | "network";
  };
  user_input?: {
    step_id: string;
    attempt: number;
    submitted_at: string;
    message?: string;
    document_ids: string[];
  };
};

export type AgentTask = {
  id: string;
  matter_id: string;
  goal: string;
  mode: AgentMode;
  status: AgentTaskStatus;
  execution_model: string;
  deliverables: AgentDeliverable[];
  current_plan: AgentStep[];
  current_step: string | null;
  latest_checkpoint: AgentCheckpoint | null;
  created_at: string;
  updated_at: string;
  review_status?: AgentReviewStatus | null;
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

export type AgentReviewStatus =
  "review_required" | "changes_requested" | "approved";

export type ApprovedArtifactSnapshot = {
  artifact_type: "draft" | "tabular_review";
  artifact_id: string;
  purpose: string;
  document_id: string;
  version_id: string;
  version_number: number | null;
  filename: string;
  file_type: string | null;
  size_bytes: number;
  sha256: string;
};

export type AgentReviewDecision = {
  id: string;
  task_id: string;
  status: AgentReviewStatus;
  reviewer_id: string | null;
  reviewer_email: string | null;
  reviewer_name: string | null;
  note: string;
  artifact_snapshot: ApprovedArtifactSnapshot[];
  created_at: string;
};

export type AgentEvidenceStatus =
  "exact" | "drifted" | "missing" | "version_mismatch";

export type AgentEvidenceCitation = {
  id: string;
  ref: number | null;
  document_id: string | null;
  version_id: string | null;
  current_version_id: string | null;
  version_number: number | null;
  filename: string;
  file_type: string | null;
  page: number | string | null;
  quote: string;
  sheet: string | null;
  cell: string | null;
  status: AgentEvidenceStatus;
  detail: string;
  openable: boolean;
};

export type AgentEvidenceSnapshot = {
  artifact_id: string;
  citations: AgentEvidenceCitation[];
};

export type AgentTaskSnapshot = {
  task: AgentTask;
  artifacts: ArtifactLink[];
  review: {
    status: AgentReviewStatus | null;
    decisions: AgentReviewDecision[];
  };
};
