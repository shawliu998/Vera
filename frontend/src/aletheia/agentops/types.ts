export type MatterType =
  | "legal_review"
  | "compliance_review"
  | "audit_review"
  | "due_diligence"
  | "regulatory_response"
  | "other";

export type RiskLevel = "low" | "medium" | "high";

export type MatterStatus =
  | "draft"
  | "active"
  | "blocked"
  | "review_needed"
  | "waiting_for_approval"
  | "approved"
  | "closed"
  | "archived";

export type DocumentStatus = "pending" | "indexed" | "failed" | "excluded";

export type MatterDocument = {
  id: string;
  matter_id: string;
  title: string;
  filename?: string;
  document_type:
    | "contract"
    | "correspondence"
    | "policy"
    | "regulation"
    | "financial"
    | "pleading"
    | "evidence"
    | "other";
  status: DocumentStatus;
  uploaded_at: string;
  source_uri?: string;
  hash?: string;
};

export type Matter = {
  id: string;
  title: string;
  type: MatterType;
  risk_level: RiskLevel;
  status: MatterStatus;
  documents: MatterDocument[];
  created_at: string;
  updated_at: string;
};

export type AgentRole =
  | "intake"
  | "evidence"
  | "issue"
  | "research"
  | "risk"
  | "memo"
  | "review"
  | "audit"
  | "eval";

export type ProfessionalAgentStatus =
  | "idle"
  | "working"
  | "blocked"
  | "review_needed"
  | "waiting_for_approval"
  | "done"
  | "failed";

export type ProfessionalAgent = {
  id: string;
  name: string;
  role: AgentRole;
  status: ProfessionalAgentStatus;
  current_task?: string;
  blocked_reason?: string;
  last_run_id?: string;
  next_action?: string;
};

export type ArtifactType =
  | "matter"
  | "document"
  | "evidence_item"
  | "issue_node"
  | "risk_item"
  | "draft_memo"
  | "review_comment"
  | "gate_result"
  | "audit_event"
  | "eval_case"
  | "professional_skill"
  | "agent_run"
  | "audit_pack"
  | "export";

export type AgentRunStatus =
  | "queued"
  | "working"
  | "blocked"
  | "review_needed"
  | "waiting_for_approval"
  | "done"
  | "failed"
  | "cancelled";

export type ArtifactRef = {
  id: string;
  type: ArtifactType;
  title?: string;
  hash?: string;
};

export type BigAtReferenceResolutionRecord = {
  raw: string;
  type: string;
  status: "resolved" | "ambiguous" | "missing";
  resolved_artifact_refs: ArtifactRef[];
  candidate_artifact_refs?: ArtifactRef[];
  message?: string;
};

export type ToolCall = {
  id: string;
  name: string;
  started_at: string;
  ended_at?: string;
  status: "started" | "succeeded" | "failed" | "skipped";
  input?: unknown;
  output?: unknown;
  error?: string;
};

export type TraceEvent = {
  id: string;
  timestamp: string;
  level: "debug" | "info" | "warning" | "error";
  message: string;
  metadata?: Record<string, unknown>;
};

export type TokenUsage = {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
};

export type AgentRun = {
  id: string;
  matter_id: string;
  agent_id: string;
  started_at: string;
  ended_at?: string;
  status: AgentRunStatus;
  input_artifacts: ArtifactRef[];
  output_artifacts: ArtifactRef[];
  tool_calls: ToolCall[];
  trace_events: TraceEvent[];
  model?: string;
  token_usage?: TokenUsage;
  errors: string[];
  referenced_artifacts?: ArtifactRef[];
  big_at_references?: string[];
  big_at_resolution_records?: BigAtReferenceResolutionRecord[];
};

export type ReviewStatus = "pending" | "approved" | "rejected" | "needs_revision";

export type EvidenceItem = {
  id: string;
  matter_id: string;
  source_document_id: string;
  source_chunk_id?: string;
  page?: number;
  section?: string;
  quote: string;
  quote_start?: number;
  quote_end?: number;
  normalized_fact: string;
  supports_claim_ids: string[];
  confidence: number;
  original_confidence?: "low" | "medium" | "high";
  relevance?: "direct" | "indirect" | "weak";
  support_status?: "supports" | "contradicts" | "insufficient";
  review_status: ReviewStatus;
  reviewer_id?: string;
  created_by_run_id?: string;
  metadata?: Record<string, unknown>;
};

export type IssueNode = {
  id: string;
  matter_id: string;
  title: string;
  description: string;
  legal_or_professional_standard: string;
  related_evidence_ids: string[];
  open_questions: string[];
  risk_level: RiskLevel;
  review_status: ReviewStatus;
};

export type RiskItemStatus =
  | "open"
  | "mitigating"
  | "accepted"
  | "resolved"
  | "closed";

export type RiskItem = {
  id: string;
  matter_id: string;
  title: string;
  description: string;
  severity: RiskLevel;
  likelihood: RiskLevel;
  related_issue_ids: string[];
  related_evidence_ids: string[];
  recommendation: string;
  owner?: string;
  status: RiskItemStatus;
};

export type DraftMemoSection = {
  id: string;
  title: string;
  body: string;
  evidence_reference_ids: string[];
  issue_reference_ids?: string[];
  unsupported_claim_count?: number;
  referenced_artifacts?: ArtifactRef[];
  big_at_references?: string[];
  big_at_resolution_records?: BigAtReferenceResolutionRecord[];
};

export type GateStatus = "passed" | "failed" | "warning" | "skipped";

export type DraftMemo = {
  id: string;
  matter_id: string;
  title: string;
  sections: DraftMemoSection[];
  citation_coverage_score: number;
  unsupported_claim_count: number;
  review_status: ReviewStatus;
  gate_status: GateStatus;
};

export type ReviewCommentSeverity = "low" | "medium" | "high";

export type ReviewComment = {
  id: string;
  matter_id: string;
  artifact_id: string;
  artifact_type: ArtifactType;
  target_type?: string;
  target_id?: string;
  tag?: string;
  work_product_id?: string;
  evidence_item_id?: string;
  author: string;
  comment: string;
  severity: ReviewCommentSeverity;
  status: "open" | "resolved" | "rejected";
  created_at: string;
  referenced_artifacts?: ArtifactRef[];
  big_at_references?: string[];
  big_at_resolution_records?: BigAtReferenceResolutionRecord[];
};

export type GateType =
  | "citation"
  | "human_approval"
  | "missing_material"
  | "conflict"
  | "jurisdiction"
  | "privilege"
  | "export";

export type GateResult = {
  id: string;
  matter_id: string;
  gate_type: GateType;
  status: GateStatus;
  reason: string;
  affected_artifact_ids: string[];
  required_action?: string;
  created_at: string;
};

export type AuditActorType = "human" | "agent" | "system";

export type AuditEvent = {
  id: string;
  matter_id: string;
  actor_type: AuditActorType;
  actor_id: string;
  action: string;
  artifact_id?: string;
  artifact_type?: ArtifactType;
  before_hash?: string;
  after_hash?: string;
  timestamp: string;
  referenced_artifacts?: ArtifactRef[];
  big_at_references?: string[];
  big_at_resolution_records?: BigAtReferenceResolutionRecord[];
};

export type EvalFailureType =
  | "unsupported_claim"
  | "missing_citation"
  | "missed_issue"
  | "wrong_risk_level"
  | "contradiction_missed"
  | "bad_memo_structure"
  | "expert_override";

export type EvalCase = {
  id: string;
  matter_id: string;
  source_run_id: string;
  failure_type: EvalFailureType;
  input_snapshot: unknown;
  expected_behavior: string;
  expert_feedback: string;
  status: "open" | "triaged" | "converted_to_skill" | "closed";
};

export type ProfessionalSkillApprovalStatus =
  | "candidate"
  | "approved"
  | "rejected"
  | "deprecated";

export type ProfessionalSkill = {
  id: string;
  name: string;
  description: string;
  trigger_conditions: string[];
  required_inputs: ArtifactType[];
  expected_outputs: ArtifactType[];
  evidence_requirements: string[];
  approval_status: ProfessionalSkillApprovalStatus;
  created_from_eval_case_ids: string[];
  version: string;
};

export type AgentOpsMatterWorkspace = {
  matter: Matter;
  agents: ProfessionalAgent[];
  runs: AgentRun[];
  evidence: EvidenceItem[];
  issues: IssueNode[];
  risks: RiskItem[];
  draft_memos: DraftMemo[];
  review_comments: ReviewComment[];
  gate_results: GateResult[];
  audit_events: AuditEvent[];
  eval_cases: EvalCase[];
  skills: ProfessionalSkill[];
};
