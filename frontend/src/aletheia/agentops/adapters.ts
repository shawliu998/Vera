import type {
  AletheiaAgentRunRecord,
  AletheiaEvidenceRecord,
  AletheiaMatterDetail,
  AletheiaReviewRecord,
  AletheiaWorkProductRecord,
} from "@/app/lib/aletheiaApi";
import type {
  AgentOpsMatterWorkspace,
  AgentRunStatus,
  ArtifactType,
  AuditEvent,
  DraftMemo,
  EvalCase,
  EvidenceItem,
  GateResult,
  IssueNode,
  Matter,
  MatterStatus,
  MatterType,
  ProfessionalAgent,
  ProfessionalAgentStatus,
  ProfessionalSkill,
  ReviewComment,
  ReviewStatus,
  RiskItem,
  RiskLevel,
  ToolCall,
} from "./types";
import { computeArtifactId, withComputedMemoCoverage } from "./schemas";

function matterType(template: AletheiaMatterDetail["matter"]["template"]): MatterType {
  if (template === "compliance_impact_review") return "compliance_review";
  if (template === "deal_due_diligence") return "due_diligence";
  return "legal_review";
}

function matterStatus(detail: AletheiaMatterDetail): MatterStatus {
  const hasOpenCheckpoint = (detail.agentRuns ?? []).some((run) =>
    (run.human_checkpoints ?? []).some((checkpoint) => checkpoint.status === "open"),
  );
  if (hasOpenCheckpoint) return "waiting_for_approval";
  if (detail.matter.status === "in_progress") return "active";
  if (detail.matter.status === "needs_review") return "review_needed";
  if (detail.matter.status === "completed") return "closed";
  return detail.matter.status;
}

function riskLevel(value: string | null | undefined): RiskLevel {
  return value === "low" || value === "medium" || value === "high"
    ? value
    : "medium";
}

function reviewStatus(value: string | null | undefined): ReviewStatus {
  if (value === "accepted" || value === "approved" || value === "source_linked") {
    return "approved";
  }
  if (value === "rejected") return "rejected";
  if (value === "needs_revision" || value === "needs_human_review") {
    return "needs_revision";
  }
  return "pending";
}

function normalizedFact(item: AletheiaEvidenceRecord) {
  const metadataFact = item.metadata.normalizedFact;
  if (typeof metadataFact === "string" && metadataFact.trim()) {
    return metadataFact.trim();
  }
  return item.quote.replace(/\s+/g, " ").trim().slice(0, 240);
}

function confidence(value: AletheiaEvidenceRecord["confidence"]) {
  if (value === "high") return 0.9;
  if (value === "medium") return 0.72;
  if (value === "low") return 0.5;
  return 0.6;
}

function runStatus(status: AletheiaAgentRunRecord["status"]): AgentRunStatus {
  if (status === "running") return "working";
  if (status === "needs_human") return "waiting_for_approval";
  if (status === "completed") return "done";
  return status;
}

function runAgentId(run: AletheiaAgentRunRecord) {
  const currentStep = run.steps?.find(
    (step) => step.step_key === run.current_step_key,
  );
  const key = `${currentStep?.step_key ?? ""} ${currentStep?.title ?? ""}`.toLowerCase();
  if (key.includes("evidence") || key.includes("source")) return "agent-evidence";
  if (key.includes("issue")) return "agent-issue";
  if (key.includes("risk")) return "agent-risk";
  if (key.includes("memo") || key.includes("register") || key.includes("red flag")) {
    return "agent-memo";
  }
  if (key.includes("review") || key.includes("checkpoint")) return "agent-review";
  if (key.includes("audit") || key.includes("export")) return "agent-audit";
  if (key.includes("eval") || key.includes("feedback")) return "agent-eval";
  return "agent-intake";
}

function toolStatus(status: string): ToolCall["status"] {
  if (status === "completed") return "succeeded";
  if (status === "failed") return "failed";
  if (status === "pending" || status === "running") return "started";
  return "skipped";
}

function artifactTypeForReview(review: AletheiaReviewRecord): ArtifactType {
  if (review.target_type === "evidence") return "evidence_item";
  if (review.target_type === "claim") return "issue_node";
  if (review.target_type === "matter") return "matter";
  if (review.target_type === "work_product") return "draft_memo";
  return "draft_memo";
}

function agentStatus(detail: AletheiaMatterDetail, role: ProfessionalAgent["role"]): ProfessionalAgentStatus {
  if (role === "review" && detail.reviews.length > 0) return "done";
  if (role === "evidence" && detail.evidence.length > 0) return "done";
  if (role === "audit" && detail.auditEvents.length > 0) return "review_needed";
  return detail.matter.status === "needs_review" ? "review_needed" : "idle";
}

function adaptMatter(detail: AletheiaMatterDetail): Matter {
  return {
    id: detail.matter.id,
    title: detail.matter.title,
    type: matterType(detail.matter.template),
    risk_level: riskLevel(detail.matter.risk_level),
    status: matterStatus(detail),
    documents: detail.documents.map((document) => ({
      id: document.document_id ?? document.id,
      matter_id: document.matter_id,
      title: document.name,
      filename: document.name,
      document_type: "other",
      status: document.parsed_status === "parsed" ? "indexed" : document.parsed_status,
      uploaded_at: document.created_at,
      source_uri: document.id,
      hash:
        typeof document.metadata.hash === "string"
          ? document.metadata.hash
          : undefined,
    })),
    created_at: detail.matter.created_at,
    updated_at: detail.matter.updated_at,
  };
}

function adaptEvidence(detail: AletheiaMatterDetail): EvidenceItem[] {
  return detail.evidence.map((item) => ({
    id: item.id,
    matter_id: item.matter_id,
    source_document_id: item.document_id ?? item.source_chunk_id ?? item.id,
    source_chunk_id: item.source_chunk_id ?? undefined,
    page: item.page ?? undefined,
    section: item.section ?? undefined,
    quote: item.quote,
    quote_start: item.quote_start ?? undefined,
    quote_end: item.quote_end ?? undefined,
    normalized_fact: normalizedFact(item),
    supports_claim_ids: item.claim_id ? [item.claim_id] : [],
    confidence: confidence(item.confidence),
    original_confidence: item.confidence ?? undefined,
    relevance: item.relevance,
    support_status: item.support_status,
    review_status: item.support_status === "supports" ? "pending" : "needs_revision",
    metadata: {
      ...item.metadata,
      document_name: item.document_name,
    },
  }));
}

function adaptIssues(detail: AletheiaMatterDetail, evidence: EvidenceItem[]): IssueNode[] {
  const issueMap = [...detail.workProducts]
    .reverse()
    .find((item) => item.kind === "issue_map");
  const issueRecords = Array.isArray(issueMap?.content.issues)
    ? issueMap.content.issues
    : [];
  if (issueRecords.length > 0) {
    return issueRecords.map((issue, index) => {
      const record =
        issue && typeof issue === "object" && !Array.isArray(issue)
          ? (issue as Record<string, unknown>)
          : {};
      const supportSummary =
        record.supportSummary &&
        typeof record.supportSummary === "object" &&
        !Array.isArray(record.supportSummary)
          ? (record.supportSummary as Record<string, unknown>)
          : {};
      const evidenceIds = Array.isArray(record.evidenceIds)
        ? record.evidenceIds.filter((value): value is string => typeof value === "string")
        : [];
      const openQuestions = Array.isArray(record.openQuestions)
        ? record.openQuestions.filter((value): value is string => typeof value === "string")
        : [];
      const hasReviewRisk =
        (typeof supportSummary.contradicts === "number" &&
          supportSummary.contradicts > 0) ||
        (typeof supportSummary.insufficient === "number" &&
          supportSummary.insufficient > 0);
      const id = typeof record.id === "string" ? record.id : `issue-${index}`;
      return {
        id,
        matter_id: detail.matter.id,
        title: typeof record.title === "string" ? record.title : "Issue",
        description:
          typeof record.summary === "string"
            ? record.summary
            : `Issue ${id} is derived from persisted issue-map work product.`,
        legal_or_professional_standard:
          "Derived from persisted source-linked issue map.",
        related_evidence_ids: evidenceIds,
        open_questions: openQuestions,
        risk_level: hasReviewRisk ? "high" : riskLevel(detail.matter.risk_level),
        review_status: reviewStatus(
          typeof record.reviewStatus === "string" ? record.reviewStatus : undefined,
        ),
      };
    });
  }

  const byClaim = new Map<string, EvidenceItem[]>();
  for (const item of evidence) {
    const claimId = item.supports_claim_ids[0] ?? "unassigned";
    byClaim.set(claimId, [...(byClaim.get(claimId) ?? []), item]);
  }
  const acceptedClaims = new Set(
    detail.reviews
      .filter((review) => review.target_type === "claim" && review.tag === "accepted")
      .map((review) => review.target_id),
  );
  return [...byClaim.entries()].map(([claimId, items]) => {
    const needsReview = items.some((item) => item.support_status !== "supports");
    return {
      id: claimId,
      matter_id: detail.matter.id,
      title: claimId.replace(/^claim[-_:]/, "").replace(/[-_]+/g, " "),
      description: items.map((item) => item.normalized_fact).join(" "),
      legal_or_professional_standard: "Derived from persisted source-linked evidence.",
      related_evidence_ids: items.map((item) => item.id),
      open_questions: needsReview
        ? ["Resolve contradictory or insufficient evidence before reliance."]
        : [],
      risk_level: needsReview ? "high" : riskLevel(detail.matter.risk_level),
      review_status: acceptedClaims.has(claimId)
        ? "approved"
        : needsReview
          ? "needs_revision"
          : "pending",
    };
  });
}

function adaptDraftMemo(detail: AletheiaMatterDetail, item: AletheiaWorkProductRecord): DraftMemo {
  const sections = Array.isArray(item.content.sections) ? item.content.sections : [];
  const memo = withComputedMemoCoverage({
    id: item.id,
    matter_id: detail.matter.id,
    title: item.title,
    sections: sections.map((section, index) => {
      const record =
        section && typeof section === "object" && !Array.isArray(section)
          ? (section as Record<string, unknown>)
          : {};
      const evidenceIds = Array.isArray(record.evidenceIds)
        ? record.evidenceIds.filter((value): value is string => typeof value === "string")
        : [];
      const issueIds = Array.isArray(record.claimIds)
        ? record.claimIds.filter((value): value is string => typeof value === "string")
        : [];
      const body = Array.isArray(record.body)
        ? record.body.filter((value): value is string => typeof value === "string").join(" ")
        : "";
      return {
        id: typeof record.id === "string" ? record.id : `section-${index}`,
        title: typeof record.title === "string" ? record.title : "Memo Section",
        body,
        evidence_reference_ids: evidenceIds,
        issue_reference_ids: issueIds,
        unsupported_claim_count: evidenceIds.length === 0 ? 1 : 0,
      };
    }),
    citation_coverage_score: 0,
    unsupported_claim_count: 0,
    review_status: reviewStatus(item.status),
    gate_status: item.validation_errors.length > 0 ? "failed" : "warning",
  });
  return {
    ...memo,
    unsupported_claim_count: memo.unsupported_claim_count + item.validation_errors.length,
  };
}

function adaptRuns(detail: AletheiaMatterDetail) {
  return (detail.agentRuns ?? []).map((run) => ({
    id: run.id,
    matter_id: run.matter_id,
    agent_id: runAgentId(run),
    started_at: run.started_at ?? run.created_at,
    ended_at: run.completed_at ?? undefined,
    status: runStatus(run.status),
    input_artifacts: [{ id: run.matter_id, type: "matter" as const }],
    output_artifacts: [],
    tool_calls: (run.tool_calls ?? []).map((call) => ({
      id: call.id,
      name: call.tool_name,
      started_at: call.started_at ?? call.created_at,
      ended_at: call.completed_at ?? undefined,
      status: toolStatus(call.status),
      input: call.input,
      output: call.output,
      error: call.error ?? undefined,
    })),
    trace_events: (run.steps ?? []).map((step) => ({
      id: step.id,
      timestamp: step.completed_at ?? step.started_at ?? step.created_at,
      level: step.status === "failed" ? ("error" as const) : ("info" as const),
      message: step.title,
      metadata: { stepKey: step.step_key, status: step.status },
    })),
    model: run.model_profile ?? undefined,
    errors: (run.steps ?? [])
      .filter((step) => step.status === "failed")
      .map((step) => step.title),
  }));
}

function adaptReviews(detail: AletheiaMatterDetail): ReviewComment[] {
  return detail.reviews.map((review) => ({
    id: review.id,
    matter_id: review.matter_id,
    artifact_id: review.target_id,
    artifact_type: artifactTypeForReview(review),
    target_type: review.target_type,
    target_id: review.target_id,
    tag: review.tag,
    work_product_id: review.work_product_id ?? undefined,
    evidence_item_id: review.evidence_item_id ?? undefined,
    author: review.reviewer_name ?? review.reviewer_user_id ?? "Reviewer",
    comment: review.comment,
    severity:
      review.tag === "accepted" ? "low" : review.tag === "missing_fact" ? "medium" : "high",
    status: review.tag === "accepted" ? "resolved" : "open",
    created_at: review.created_at,
  }));
}

function adaptGateResults(detail: AletheiaMatterDetail): GateResult[] {
  const checkpointGates = (detail.agentRuns ?? []).flatMap((run) =>
    (run.human_checkpoints ?? []).map((checkpoint) => ({
      id: `gate-checkpoint-${checkpoint.id}`,
      matter_id: checkpoint.matter_id,
      gate_type: "human_approval" as const,
      status:
        checkpoint.status === "approved"
          ? ("passed" as const)
          : checkpoint.status === "rejected"
            ? ("failed" as const)
            : checkpoint.status === "cancelled"
              ? ("skipped" as const)
              : ("failed" as const),
      reason: checkpoint.prompt,
      affected_artifact_ids: [
        typeof checkpoint.requested_payload.workProductId === "string"
          ? checkpoint.requested_payload.workProductId
          : checkpoint.run_id,
      ],
      required_action:
        checkpoint.status === "open" ? "Human approval required." : undefined,
      created_at: checkpoint.created_at,
    })),
  );
  const validationGates = detail.workProducts.flatMap((item) =>
    item.validation_errors.map((error, index) => ({
      id: `gate-validation-${item.id}-${index}`,
      matter_id: item.matter_id,
      gate_type: "citation" as const,
      status: "failed" as const,
      reason: String(error),
      affected_artifact_ids: [item.id],
      required_action: "Resolve validation error before export.",
      created_at: item.created_at,
    })),
  );
  return [...checkpointGates, ...validationGates];
}

function adaptAuditEvents(detail: AletheiaMatterDetail): AuditEvent[] {
  return detail.auditEvents.map((event) => {
    const artifactId =
      typeof event.details.workProductId === "string"
        ? event.details.workProductId
        : typeof event.details.artifactId === "string"
          ? event.details.artifactId
          : undefined;
    const artifactType =
      typeof event.details.artifactType === "string"
        ? (event.details.artifactType as ArtifactType)
        : undefined;
    return {
      id: event.id,
      matter_id: event.matter_id,
      actor_type: event.actor,
      actor_id: event.user_id ?? event.actor,
      action: event.action,
      artifact_id: artifactId,
      artifact_type: artifactType,
      after_hash:
        typeof event.details.afterHash === "string"
          ? event.details.afterHash
          : artifactId
            ? computeArtifactId(artifactType ?? "audit_event", event.matter_id, artifactId)
            : undefined,
      timestamp: event.created_at,
    };
  });
}

function sourceRunIdForWorkProduct(
  detail: AletheiaMatterDetail,
  workProductId: string | null,
) {
  if (!workProductId) {
    return detail.agentRuns?.[0]?.id ?? detail.matter.id;
  }

  const matchingRun = detail.agentRuns?.find((run) =>
    (run.tool_calls ?? []).some((call) => {
      const output = call.output;
      return output && output.workProductId === workProductId;
    }),
  );

  return matchingRun?.id ?? detail.agentRuns?.[0]?.id ?? detail.matter.id;
}

function adaptEvalCases(detail: AletheiaMatterDetail): EvalCase[] {
  return detail.reviews
    .filter((review) => review.tag !== "accepted")
    .map((review) => ({
      id: `eval-${review.id}`,
      matter_id: review.matter_id,
      source_run_id: sourceRunIdForWorkProduct(detail, review.work_product_id),
      failure_type:
        review.tag === "conflicting_evidence"
          ? "contradiction_missed"
          : review.tag === "missing_fact"
            ? "missing_citation"
            : "unsupported_claim",
      input_snapshot: review,
      expected_behavior: "Future runs should preserve this expert review signal.",
      expert_feedback: review.comment,
      status: "open",
    }));
}

function adaptSkills(detail: AletheiaMatterDetail): ProfessionalSkill[] {
  return (detail.playbooks ?? []).map((playbook) => ({
    id: playbook.id,
    name: playbook.name,
    description: playbook.description ?? "Matter-scoped playbook.",
    trigger_conditions: [detail.matter.template],
    required_inputs: ["matter", "document", "evidence_item"],
    expected_outputs: ["draft_memo", "review_comment"],
    evidence_requirements: [
      "Every material conclusion must preserve source evidence references.",
    ],
    approval_status: playbook.status === "approved" ? "approved" : "candidate",
    created_from_eval_case_ids: Array.isArray(playbook.content.evalCaseIds)
      ? playbook.content.evalCaseIds.filter(
          (value): value is string => typeof value === "string",
        )
      : [],
    version: playbook.version,
  }));
}

export function adaptAletheiaMatterDetailToAgentOpsWorkspace(
  detail: AletheiaMatterDetail,
): AgentOpsMatterWorkspace {
  const evidence = adaptEvidence(detail);
  const issues = adaptIssues(detail, evidence);
  return {
    matter: adaptMatter(detail),
    agents: ["intake", "evidence", "issue", "research", "risk", "memo", "review", "audit", "eval"].map(
      (role) => ({
        id: `agent-${role}`,
        name: `${role[0].toUpperCase()}${role.slice(1)} Agent`,
        role: role as ProfessionalAgent["role"],
        status: agentStatus(detail, role as ProfessionalAgent["role"]),
      }),
    ),
    runs: adaptRuns(detail),
    evidence,
    issues,
    risks: issues.map((issue): RiskItem => ({
      id: `risk-${issue.id}`,
      matter_id: issue.matter_id,
      title: issue.title,
      description: issue.description,
      severity: issue.risk_level,
      likelihood: issue.risk_level,
      related_issue_ids: [issue.id],
      related_evidence_ids: issue.related_evidence_ids,
      recommendation: issue.open_questions[0] ?? "Maintain source-linked review.",
      status: issue.review_status === "approved" ? "mitigating" : "open",
    })),
    draft_memos: detail.workProducts
      .filter((item) =>
        ["draft_memo", "red_flag_memo", "compliance_register"].includes(item.kind),
      )
      .map((item) => adaptDraftMemo(detail, item)),
    review_comments: adaptReviews(detail),
    gate_results: adaptGateResults(detail),
    audit_events: adaptAuditEvents(detail),
    eval_cases: adaptEvalCases(detail),
    skills: adaptSkills(detail),
  };
}

export function summarizeAdapterProvenance(workspace: AgentOpsMatterWorkspace) {
  return {
    matter_id: workspace.matter.id,
    evidence_items: workspace.evidence.length,
    evidence_with_source_chunks: workspace.evidence.filter(
      (item) => item.source_chunk_id,
    ).length,
    evidence_with_quote_offsets: workspace.evidence.filter(
      (item) =>
        typeof item.quote_start === "number" && typeof item.quote_end === "number",
    ).length,
    review_tags: workspace.review_comments
      .map((comment) => comment.tag)
      .filter((tag): tag is string => Boolean(tag)),
    open_gate_results: workspace.gate_results.filter(
      (gate) => gate.status === "failed" || gate.status === "warning",
    ).length,
    eval_cases: workspace.eval_cases.length,
  };
}
