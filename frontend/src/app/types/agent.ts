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
  required_input?: AgentRequiredInput;
  execution_pause?: unknown;
  source_acquisition?: unknown;
};

export type AgentRequiredInputChoice = {
  id: string;
  kind: "choice";
  question: string;
  options: { value: string }[];
  allow_other: boolean;
  other_label: string;
  response_prefix?: string;
};

export type AgentRequiredInputDocuments = {
  id: string;
  kind: "documents";
  document_types: string[];
  /** Missing on legacy checkpoints; the server treats omission as required. */
  required?: boolean;
  response_prefix?: string;
};

export type AgentRequiredInput = {
  kind: "required_input_v1";
  request_id: string;
  step_id: string;
  reason_code:
    | "missing_source"
    | "missing_fact"
    | "lawyer_choice"
    | "source_version_changed";
  prompt: string;
  items: (AgentRequiredInputChoice | AgentRequiredInputDocuments)[];
  resume_strategy: "retry_step" | "replan_remaining";
  created_at: string;
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

export type AgentCurrentArtifactVersion = {
  artifact_type: "draft" | "tabular_review";
  artifact_id: string;
  purpose: string;
  current_version_id: string | null;
  current_version_number: number | null;
  current_filename: string | null;
  current_file_type: string | null;
  current_version_available: boolean;
  approved_version_id: string | null;
  approved_version_number: number | null;
  edited_after_approval: boolean;
  review_current_required: boolean;
};

export type AgentReviewVersionState = {
  latest_approved_decision_id: string | null;
  latest_approved_at: string | null;
  has_previous_approval: boolean;
  has_unapproved_changes: boolean;
  current_artifacts: AgentCurrentArtifactVersion[];
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
  execution_recovery:
    | { allowed: true; issue_code: null; detail: null }
    | {
        allowed: false;
        issue_code:
          | "assignment_contract_invalid"
          | "step_contract_invalid"
          | "capability_grant_invalid";
        detail: string;
      };
  review: {
    status: AgentReviewStatus | null;
    decisions: AgentReviewDecision[];
    version_state: AgentReviewVersionState;
  };
};
