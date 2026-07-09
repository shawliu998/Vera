import {
  computeArtifactId,
  computeCitationCoverage,
  createDefaultAgentRun,
} from "./schemas";
import {
  evidenceAndIssuesToDraftMemo,
  evidenceToIssueCandidates,
  gateResultsToAuditEvents,
  issuesToRiskRegister,
  reviewCommentsToEvalCases,
  validateDraftMemoDependencies,
} from "./handoff";
import type {
  AgentRun,
  AgentOpsMatterWorkspace,
  AuditEvent,
  ArtifactRef,
  DraftMemo,
  EvidenceItem,
  GateResult,
  IssueNode,
  Matter,
  MatterDocument,
  ProfessionalAgent,
  ReviewComment,
  RiskItem,
} from "./types";

const now = "2026-07-09T09:00:00.000Z";

export const sampleDocuments: MatterDocument[] = [
  {
    id: "doc-master-services-agreement",
    matter_id: "matter-agentops-demo-001",
    title: "Master Services Agreement",
    filename: "master-services-agreement.pdf",
    document_type: "contract",
    status: "indexed",
    uploaded_at: "2026-07-09T08:10:00.000Z",
    hash: "sha256:demo-contract",
  },
  {
    id: "doc-security-policy",
    matter_id: "matter-agentops-demo-001",
    title: "Security Policy Addendum",
    filename: "security-policy-addendum.pdf",
    document_type: "policy",
    status: "indexed",
    uploaded_at: "2026-07-09T08:12:00.000Z",
    hash: "sha256:demo-policy",
  },
  {
    id: "doc-customer-email",
    matter_id: "matter-agentops-demo-001",
    title: "Customer Escalation Email",
    filename: "customer-escalation-email.eml",
    document_type: "correspondence",
    status: "indexed",
    uploaded_at: "2026-07-09T08:15:00.000Z",
    hash: "sha256:demo-email",
  },
];

export const sampleMatter: Matter = {
  id: "matter-agentops-demo-001",
  title: "Vendor Security Breach Review",
  type: "compliance_review",
  risk_level: "high",
  status: "review_needed",
  documents: sampleDocuments,
  created_at: "2026-07-09T08:00:00.000Z",
  updated_at: now,
};

export const sampleAgents: ProfessionalAgent[] = [
  {
    id: "agent-intake",
    name: "Intake Agent",
    role: "intake",
    status: "done",
    current_task: "Matter profile, objectives, parties, and document inventory normalized.",
    last_run_id: "run-intake-demo-001",
    next_action: "Hand off to evidence agent",
  },
  {
    id: "agent-evidence",
    name: "Evidence Agent",
    role: "evidence",
    status: "review_needed",
    current_task: "Validate source quotes against breach notice obligations",
    last_run_id: "run-evidence-demo-001",
    next_action: "Human reviewer checks quote support",
  },
  {
    id: "agent-issue",
    name: "Issue Agent",
    role: "issue",
    status: "working",
    current_task: "Map notice timing and security control questions to evidence.",
    last_run_id: "run-issue-demo-001",
    next_action: "Separate confirmed issues from open factual questions.",
  },
  {
    id: "agent-research",
    name: "Research Agent",
    role: "research",
    status: "blocked",
    current_task: "Check incident timeline against contractual notice standard.",
    blocked_reason: "Incident confirmation timestamp and forensic logs are missing.",
    last_run_id: "run-research-demo-001",
    next_action: "Request incident report, notification log, and access-log export.",
  },
  {
    id: "agent-risk",
    name: "Risk Agent",
    role: "risk",
    status: "working",
    current_task: "Score late-notice and missing-forensics risks.",
    last_run_id: "run-risk-demo-001",
    next_action: "Confirm likelihood once timeline evidence arrives.",
  },
  {
    id: "agent-memo",
    name: "Memo Agent",
    role: "memo",
    status: "waiting_for_approval",
    current_task: "Hold draft memo behind citation and human approval gates.",
    blocked_reason: "High-risk matter requires expert approval before export.",
    last_run_id: "run-memo-demo-001",
    next_action: "Route draft memo to legal and security reviewers.",
  },
  {
    id: "agent-review",
    name: "Review Agent",
    role: "review",
    status: "review_needed",
    current_task: "Inspect pending evidence, memo open items, and gate warnings.",
    last_run_id: "run-review-demo-001",
    next_action: "Resolve high-severity reviewer comment on open items.",
  },
  {
    id: "agent-audit",
    name: "Audit Agent",
    role: "audit",
    status: "done",
    current_task: "Matter creation and draft memo provenance captured.",
    last_run_id: "run-audit-demo-001",
    next_action: "Append events when gates or reviewer decisions change.",
  },
  {
    id: "agent-eval",
    name: "Eval Agent",
    role: "eval",
    status: "idle",
    current_task: "Await reviewed badcase conversion.",
    last_run_id: "run-eval-demo-001",
    next_action: "Convert expert feedback into a reusable citation-gate skill.",
  },
];

export const sampleEvidence: EvidenceItem[] = [
  {
    id: "evidence-notice-window",
    matter_id: sampleMatter.id,
    source_document_id: "doc-master-services-agreement",
    page: 12,
    section: "8.2 Security Incident Notice",
    quote:
      "Vendor must notify Customer of a confirmed security incident without undue delay and no later than 48 hours after confirmation.",
    normalized_fact:
      "The agreement requires notice no later than 48 hours after confirmation of a security incident.",
    supports_claim_ids: ["issue-notice-timing"],
    confidence: 0.94,
    review_status: "approved",
    reviewer_id: "reviewer-legal-001",
    created_by_run_id: "run-evidence-demo-001",
  },
  {
    id: "evidence-delayed-escalation",
    matter_id: sampleMatter.id,
    source_document_id: "doc-customer-email",
    page: 1,
    section: "Escalation thread",
    quote:
      "We learned of the confirmed incident on Monday but did not receive written notice until Thursday afternoon.",
    normalized_fact:
      "The customer email alleges written notice came roughly three days after confirmation.",
    supports_claim_ids: ["issue-notice-timing", "issue-customer-impact"],
    confidence: 0.82,
    review_status: "pending",
    created_by_run_id: "run-evidence-demo-001",
  },
  {
    id: "evidence-policy-encryption",
    matter_id: sampleMatter.id,
    source_document_id: "doc-security-policy",
    page: 4,
    section: "Data Protection Controls",
    quote:
      "Production customer data must remain encrypted at rest using managed keys and access logging.",
    normalized_fact:
      "The security policy requires encryption at rest and access logging for production customer data.",
    supports_claim_ids: ["issue-control-compliance"],
    confidence: 0.9,
    review_status: "approved",
    reviewer_id: "reviewer-security-001",
    created_by_run_id: "run-evidence-demo-001",
  },
];

export const sampleIssues: IssueNode[] = [
  {
    id: "issue-notice-timing",
    matter_id: sampleMatter.id,
    title: "Whether breach notice was timely under the contract",
    description:
      "The contract sets a 48-hour notice period, while correspondence suggests notice arrived after that window.",
    legal_or_professional_standard:
      "Contractual security incident notice obligations and customer notification governance.",
    related_evidence_ids: ["evidence-notice-window", "evidence-delayed-escalation"],
    open_questions: [
      "When was the incident confirmed by the vendor?",
      "Was oral notice provided before written notice?",
    ],
    risk_level: "high",
    review_status: "pending",
  },
  {
    id: "issue-control-compliance",
    matter_id: sampleMatter.id,
    title: "Whether required security controls were followed",
    description:
      "The security policy requires encryption and access logging, but the current record does not include incident forensic logs.",
    legal_or_professional_standard:
      "Security policy control adherence and audit evidence sufficiency.",
    related_evidence_ids: ["evidence-policy-encryption"],
    open_questions: ["Obtain incident report and relevant access logs."],
    risk_level: "medium",
    review_status: "needs_revision",
  },
];

export const sampleRiskRegister: RiskItem[] = [
  {
    id: "risk-late-notice",
    matter_id: sampleMatter.id,
    title: "Potential late breach notice",
    description:
      "If confirmation occurred Monday and written notice was Thursday, the notice window may have been missed.",
    severity: "high",
    likelihood: "medium",
    related_issue_ids: ["issue-notice-timing"],
    related_evidence_ids: ["evidence-notice-window", "evidence-delayed-escalation"],
    recommendation:
      "Confirm incident timeline and preserve all notification evidence before sending any final response.",
    owner: "Legal review lead",
    status: "open",
  },
  {
    id: "risk-missing-forensics",
    matter_id: sampleMatter.id,
    title: "Missing forensic support for control compliance",
    description:
      "Policy evidence exists, but logs and incident analysis are missing from the workspace.",
    severity: "medium",
    likelihood: "high",
    related_issue_ids: ["issue-control-compliance"],
    related_evidence_ids: ["evidence-policy-encryption"],
    recommendation:
      "Request incident report, encryption evidence, access logs, and remediation records.",
    owner: "Security reviewer",
    status: "mitigating",
  },
];

const memoSections = [
  {
    id: "memo-summary",
    title: "Executive Summary",
    body:
      "Current evidence supports a high-risk notice timing issue and a separate control-evidence gap.",
    evidence_reference_ids: ["evidence-notice-window", "evidence-delayed-escalation"],
    issue_reference_ids: ["issue-notice-timing", "issue-control-compliance"],
  },
  {
    id: "memo-standard",
    title: "Applicable Standard",
    body:
      "The contract requires notice no later than 48 hours after confirmed security incident awareness.",
    evidence_reference_ids: ["evidence-notice-window"],
    issue_reference_ids: ["issue-notice-timing"],
  },
  {
    id: "memo-analysis",
    title: "Evidence Analysis",
    body:
      "The correspondence indicates a potential delay, but the confirmation timestamp and any oral notice remain unresolved.",
    evidence_reference_ids: ["evidence-delayed-escalation"],
    issue_reference_ids: ["issue-notice-timing"],
  },
  {
    id: "memo-open-items",
    title: "Open Items",
    body:
      "The workspace still needs forensic logs, incident confirmation time, and notification channel records.",
    evidence_reference_ids: [],
    issue_reference_ids: ["issue-notice-timing", "issue-control-compliance"],
    unsupported_claim_count: 1,
  },
];

const memoCoverage = computeCitationCoverage(memoSections);

export const sampleDraftMemo: DraftMemo = {
  id: "draft-memo-vendor-security-breach",
  matter_id: sampleMatter.id,
  title: "Draft Vendor Security Breach Review Memo",
  sections: memoSections,
  citation_coverage_score: memoCoverage.citation_coverage_score,
  unsupported_claim_count: memoCoverage.unsupported_claim_count,
  review_status: "pending",
  gate_status: "warning",
};

export const sampleGateResults: GateResult[] = [
  {
    id: "gate-citation-coverage",
    matter_id: sampleMatter.id,
    gate_type: "citation",
    status: "warning",
    reason: "One memo section has no evidence reference.",
    affected_artifact_ids: [sampleDraftMemo.id, "memo-open-items"],
    required_action: "Add source evidence or mark the section as an open item.",
    created_at: now,
  },
  {
    id: "gate-human-approval",
    matter_id: sampleMatter.id,
    gate_type: "human_approval",
    status: "failed",
    reason: "High-risk matter requires expert approval before export.",
    affected_artifact_ids: [sampleDraftMemo.id],
    required_action: "Route to legal and security reviewers.",
    created_at: now,
  },
];

export const sampleAuditEvents: AuditEvent[] = [
  {
    id: "audit-matter-created",
    matter_id: sampleMatter.id,
    actor_type: "human",
    actor_id: "operator-demo",
    action: "matter_created",
    artifact_id: sampleMatter.id,
    artifact_type: "matter",
    after_hash: computeArtifactId("matter", sampleMatter.id, sampleMatter.updated_at),
    timestamp: sampleMatter.created_at,
  },
  {
    id: "audit-memo-generated",
    matter_id: sampleMatter.id,
    actor_type: "agent",
    actor_id: "agent-memo",
    action: "draft_memo_generated",
    artifact_id: sampleDraftMemo.id,
    artifact_type: "draft_memo",
    after_hash: computeArtifactId("draft_memo", sampleMatter.id, sampleDraftMemo.title),
    timestamp: now,
  },
];

function demoRun(params: {
  id: string;
  agent_id: string;
  status: AgentRun["status"];
  started_at: string;
  output_artifacts?: ArtifactRef[];
  errors?: string[];
}): AgentRun {
  return {
    ...createDefaultAgentRun({
      matter_id: sampleMatter.id,
      agent_id: params.agent_id,
      id: params.id,
      status: params.status,
      started_at: params.started_at,
      model: "deterministic-local",
    }),
    output_artifacts: params.output_artifacts ?? [],
    errors: params.errors ?? [],
  };
}

const intakeRun = demoRun({
  id: "run-intake-demo-001",
  agent_id: "agent-intake",
  status: "done",
  started_at: "2026-07-09T08:20:00.000Z",
  output_artifacts: [
    {
      id: sampleMatter.id,
      type: "matter",
      title: sampleMatter.title,
    },
  ],
});

const evidenceRun = demoRun({
  id: "run-evidence-demo-001",
  agent_id: "agent-evidence",
  status: "review_needed",
  started_at: "2026-07-09T08:25:00.000Z",
  output_artifacts: sampleEvidence.map((item) => ({
    id: item.id,
    type: "evidence_item" as const,
    title: item.normalized_fact,
  })),
});

const issueRun = demoRun({
  id: "run-issue-demo-001",
  agent_id: "agent-issue",
  status: "working",
  started_at: "2026-07-09T08:33:00.000Z",
  output_artifacts: sampleIssues.map((item) => ({
    id: item.id,
    type: "issue_node",
    title: item.title,
  })),
});

const researchRun = demoRun({
  id: "run-research-demo-001",
  agent_id: "agent-research",
  status: "blocked",
  started_at: "2026-07-09T08:38:00.000Z",
  output_artifacts: [
    {
      id: "issue-notice-timing",
      type: "issue_node",
      title: "Notice timing research checkpoint",
    },
  ],
  errors: ["Missing incident confirmation timestamp and forensic log export."],
});

const riskRun = demoRun({
  id: "run-risk-demo-001",
  agent_id: "agent-risk",
  status: "working",
  started_at: "2026-07-09T08:42:00.000Z",
  output_artifacts: sampleRiskRegister.map((item) => ({
    id: item.id,
    type: "risk_item",
    title: item.title,
  })),
});

const memoRun = demoRun({
  id: "run-memo-demo-001",
  agent_id: "agent-memo",
  status: "waiting_for_approval",
  started_at: "2026-07-09T08:47:00.000Z",
  output_artifacts: [
    {
      id: sampleDraftMemo.id,
      type: "draft_memo",
      title: sampleDraftMemo.title,
    },
  ],
});

const reviewRun = demoRun({
  id: "run-review-demo-001",
  agent_id: "agent-review",
  status: "review_needed",
  started_at: "2026-07-09T08:52:00.000Z",
  output_artifacts: [
    {
      id: "review-comment-open-items",
      type: "review_comment",
      title: "Open-items memo review",
    },
  ],
});

const auditRun = demoRun({
  id: "run-audit-demo-001",
  agent_id: "agent-audit",
  status: "done",
  started_at: "2026-07-09T08:56:00.000Z",
  output_artifacts: sampleAuditEvents.map((item) => ({
    id: item.id,
    type: "audit_event",
    title: item.action,
  })),
});

const evalRun = demoRun({
  id: "run-eval-demo-001",
  agent_id: "agent-eval",
  status: "queued",
  started_at: "2026-07-09T08:59:00.000Z",
  output_artifacts: [
    {
      id: "eval-late-notice-open-item",
      type: "eval_case",
      title: "Late notice open-item badcase",
    },
    {
      id: "eval-forensic-logs-missing-source",
      type: "eval_case",
      title: "Forensic log missing-source badcase",
    },
    {
      id: "skill-high-risk-citation-gate",
      type: "professional_skill",
      title: "High-risk citation gate candidate",
    },
  ],
});

export const sampleReviewComments: ReviewComment[] = [
  {
    id: "review-comment-open-items",
    matter_id: sampleMatter.id,
    artifact_id: "memo-open-items",
    artifact_type: "draft_memo",
    author: "reviewer-legal-001",
    comment:
      "Keep this as an open item until the incident confirmation timestamp is sourced.",
    severity: "high",
    status: "open",
    created_at: now,
  },
];

export const sampleDerivedIssueCandidates =
  evidenceToIssueCandidates(sampleEvidence);

export const sampleDerivedRiskRegister = issuesToRiskRegister(sampleIssues);

export const sampleDerivedDraftMemo = evidenceAndIssuesToDraftMemo({
  matter_id: sampleMatter.id,
  title: "Derived Vendor Security Breach Review Memo",
  evidence: sampleEvidence,
  issues: sampleIssues,
});

export const sampleDerivedReviewEvalCases = reviewCommentsToEvalCases(
  sampleReviewComments,
  { source_run_id: reviewRun.id },
);

export const sampleDerivedGateAuditEvents = gateResultsToAuditEvents(
  sampleGateResults,
  {
    actor_id: "typed-artifact-handoff",
    now,
    artifact_types_by_id: {
      [sampleDraftMemo.id]: "draft_memo",
      "memo-open-items": "draft_memo",
    },
  },
);

export const sampleDraftMemoDependencyValidation =
  validateDraftMemoDependencies({
    memo: sampleDraftMemo,
    evidence: sampleEvidence,
    issues: sampleIssues,
  });

export const sampleAgentOpsWorkspace: AgentOpsMatterWorkspace = {
  matter: sampleMatter,
  agents: sampleAgents,
  runs: [
    intakeRun,
    evidenceRun,
    issueRun,
    researchRun,
    riskRun,
    memoRun,
    reviewRun,
    auditRun,
    evalRun,
  ],
  evidence: sampleEvidence,
  issues: sampleIssues,
  risks: sampleRiskRegister,
  draft_memos: [sampleDraftMemo],
  review_comments: sampleReviewComments,
  gate_results: sampleGateResults,
  audit_events: [...sampleAuditEvents, ...sampleDerivedGateAuditEvents],
  eval_cases: [
    ...sampleDerivedReviewEvalCases,
    {
      id: "eval-late-notice-open-item",
      matter_id: sampleMatter.id,
      source_run_id: evidenceRun.id,
      failure_type: "missing_citation",
      input_snapshot: {
        memo_section_id: "memo-open-items",
        available_evidence_ids: sampleEvidence.map((item) => item.id),
      },
      expected_behavior:
        "Memo sections that assert missing materials should either cite the source of the gap or be marked as open questions.",
      expert_feedback:
        "The open-items section needs clearer source grounding before export.",
      status: "converted_to_skill",
    },
    {
      id: "eval-forensic-logs-missing-source",
      matter_id: sampleMatter.id,
      source_run_id: evidenceRun.id,
      failure_type: "missing_citation",
      input_snapshot: {
        memo_section_id: "memo-open-items",
        missing_material: "incident forensic logs",
      },
      expected_behavior:
        "Requests for missing forensic material should identify the source record showing why the material matters.",
      expert_feedback:
        "The forensic-log gap is real, but the memo should tie it to a cited policy or correspondence source.",
      status: "converted_to_skill",
    },
    {
      id: "eval-human-approval-export-block",
      matter_id: sampleMatter.id,
      source_run_id: memoRun.id,
      failure_type: "expert_override",
      input_snapshot: {
        gate_id: "gate-human-approval",
        attempted_action: "export",
      },
      expected_behavior:
        "High-risk exports must stay blocked until a human reviewer approves the work product.",
      expert_feedback:
        "Do not treat a warning-level memo as exportable until legal and security reviewers approve it.",
      status: "triaged",
    },
  ],
  skills: [
    {
      id: "skill-high-risk-citation-gate",
      name: "High-risk citation gate",
      description:
        "Require cited evidence or explicit open-question labeling for every high-risk memo section.",
      trigger_conditions: ["matter.risk_level == high", "artifact_type == draft_memo"],
      required_inputs: ["draft_memo", "evidence_item"],
      expected_outputs: ["gate_result", "review_comment"],
      evidence_requirements: [
        "Every material factual assertion must reference approved or pending evidence.",
      ],
      approval_status: "candidate",
      created_from_eval_case_ids: [
        "eval-late-notice-open-item",
        "eval-forensic-logs-missing-source",
      ],
      version: "0.1.0",
    },
    {
      id: "skill-high-risk-human-approval-export",
      name: "High-risk human approval export gate",
      description:
        "Block external export for high-risk professional work until named human reviewers approve the work product.",
      trigger_conditions: ["matter.risk_level == high", "action == export"],
      required_inputs: ["draft_memo", "gate_result", "review_comment"],
      expected_outputs: ["gate_result", "audit_event", "export"],
      evidence_requirements: [
        "Approval records must identify reviewer, affected artifact, approval timestamp, and any unresolved caveats.",
      ],
      approval_status: "approved",
      created_from_eval_case_ids: ["eval-human-approval-export-block"],
      version: "1.0.0",
    },
  ],
};
