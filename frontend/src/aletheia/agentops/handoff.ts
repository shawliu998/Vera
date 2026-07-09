import {
  computeArtifactId,
  withComputedMemoCoverage,
} from "./schemas";
import type { GateProvenance } from "./gateProvenance";
import type {
  ArtifactType,
  AgentOpsMatterWorkspace,
  ArtifactRef,
  AuditEvent,
  DraftMemo,
  DraftMemoSection,
  EvalCase,
  EvalFailureType,
  EvidenceItem,
  GateResult,
  IssueNode,
  ReviewComment,
  RiskItem,
  RiskLevel,
} from "./types";

type HandoffClock = {
  now?: string;
};

export type WorkspaceReferenceValidation = {
  ok: boolean;
  errors: string[];
  warnings: string[];
};

export type TypedHandoffSourceRecordIds = {
  documentIds: string[];
  evidenceItemIds: string[];
  issueNodeIds: string[];
  riskItemIds: string[];
  workProductIds: string[];
  reviewItemIds: string[];
  checkpointIds: string[];
  auditEventIds: string[];
  agentRunIds: string[];
  feedbackExportIds: string[];
  evalCaseIds: string[];
  playbookIds: string[];
};

export type TypedHandoffProvenance = {
  matterId: string;
  artifactId: string;
  artifactType: ArtifactType;
  sourceRecordIds: TypedHandoffSourceRecordIds;
  gateResultIds: string[];
  unresolvedReferenceIds: string[];
  ambiguousReferenceIds: string[];
  warnings: string[];
};

export type TypedHandoffProvenanceOptions = {
  gateProvenance?: GateProvenance[];
};

export type TypedHandoffReadiness = {
  status: "ready" | "blocked";
  artifactCounts: {
    documents: number;
    evidenceItems: number;
    issues: number;
    risks: number;
    draftMemoSections: number;
    reviewComments: number;
    gateResults: number;
    auditEvents: number;
    evalCases: number;
    provenanceItems: number;
  };
  blockers: string[];
  warnings: string[];
};

function unique(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

function titleFromId(id: string) {
  return id
    .replace(/^(issue|claim|risk|evidence)-/, "")
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

function riskFromEvidence(evidenceItems: EvidenceItem[]): RiskLevel {
  const hasLowConfidence = evidenceItems.some((item) => item.confidence < 0.75);
  const hasPendingReview = evidenceItems.some(
    (item) => item.review_status !== "approved",
  );

  if (hasLowConfidence) {
    return "high";
  }

  if (hasPendingReview) {
    return "medium";
  }

  return "low";
}

function failureTypeForReviewComment(comment: ReviewComment): EvalFailureType {
  const text = comment.comment.toLowerCase();

  if (text.includes("citation") || text.includes("source")) {
    return "missing_citation";
  }

  if (text.includes("unsupported")) {
    return "unsupported_claim";
  }

  if (text.includes("risk")) {
    return "wrong_risk_level";
  }

  if (text.includes("structure") || text.includes("section")) {
    return "bad_memo_structure";
  }

  return "expert_override";
}

export function evidenceToIssueCandidates(
  evidenceItems: EvidenceItem[],
): IssueNode[] {
  const evidenceByClaimId = new Map<string, EvidenceItem[]>();

  evidenceItems.forEach((item) => {
    const claimIds =
      item.supports_claim_ids.length > 0
        ? item.supports_claim_ids
        : [`claim-from-${item.id}`];

    claimIds.forEach((claimId) => {
      evidenceByClaimId.set(claimId, [
        ...(evidenceByClaimId.get(claimId) ?? []),
        item,
      ]);
    });
  });

  return Array.from(evidenceByClaimId.entries()).map(([claimId, items]) => {
    const matterId = items[0]?.matter_id ?? "matter";
    const relatedEvidenceIds = items.map((item) => item.id);
    const facts = items.map((item) => item.normalized_fact);
    const riskLevel = riskFromEvidence(items);

    return {
      id:
        claimId.startsWith("issue-")
          ? claimId
          : computeArtifactId("issue_node", matterId, claimId),
      matter_id: matterId,
      title: titleFromId(claimId) || "Evidence-backed issue candidate",
      description: facts.join(" "),
      legal_or_professional_standard:
        "Professional review issue derived from linked source evidence.",
      related_evidence_ids: unique(relatedEvidenceIds),
      open_questions:
        riskLevel === "high"
          ? ["Confirm low-confidence or incomplete source support."]
          : [],
      risk_level: riskLevel,
      review_status: items.some((item) => item.review_status === "rejected")
        ? "needs_revision"
        : "pending",
    };
  });
}

export function issuesToRiskRegister(issues: IssueNode[]): RiskItem[] {
  return issues.map((issue) => ({
    id: computeArtifactId("risk_item", issue.matter_id, issue.id),
    matter_id: issue.matter_id,
    title: `Risk: ${issue.title}`,
    description: issue.description,
    severity: issue.risk_level,
    likelihood: issue.open_questions.length > 0 ? "medium" : issue.risk_level,
    related_issue_ids: [issue.id],
    related_evidence_ids: [...issue.related_evidence_ids],
    recommendation:
      issue.open_questions.length > 0
        ? `Resolve open questions before relying on ${issue.title}.`
        : `Preserve cited evidence and route ${issue.title} for review.`,
    status: issue.review_status === "approved" ? "mitigating" : "open",
  }));
}

export function evidenceAndIssuesToDraftMemo(params: {
  matter_id: string;
  title: string;
  evidence: EvidenceItem[];
  issues: IssueNode[];
}): DraftMemo {
  const evidenceById = new Map(
    params.evidence.map((item) => [item.id, item] as const),
  );

  const issueSections: DraftMemoSection[] = params.issues.map((issue) => {
    const citedEvidenceIds = issue.related_evidence_ids.filter((id) =>
      evidenceById.has(id),
    );

    return {
      id: computeArtifactId("draft_memo", params.matter_id, issue.id),
      title: issue.title,
      body:
        `${issue.description} Standard: ${issue.legal_or_professional_standard}`,
      evidence_reference_ids: citedEvidenceIds,
      issue_reference_ids: [issue.id],
      unsupported_claim_count: citedEvidenceIds.length === 0 ? 1 : 0,
    };
  });

  const openQuestionCount = params.issues.reduce(
    (total, issue) => total + issue.open_questions.length,
    0,
  );

  const sections: DraftMemoSection[] = [
    {
      id: computeArtifactId("draft_memo", params.matter_id, "summary"),
      title: "Summary",
      body:
        params.issues.length > 0
          ? `This memo covers ${params.issues.length} issue(s) supported by ${params.evidence.length} evidence item(s).`
          : "No issue candidates have been generated from the evidence record yet.",
      evidence_reference_ids: unique(params.evidence.map((item) => item.id)),
      issue_reference_ids: params.issues.map((issue) => issue.id),
      unsupported_claim_count: params.issues.length === 0 ? 1 : 0,
    },
    ...issueSections,
  ];

  if (openQuestionCount > 0) {
    sections.push({
      id: computeArtifactId("draft_memo", params.matter_id, "open-questions"),
      title: "Open Questions",
      body: params.issues
        .flatMap((issue) =>
          issue.open_questions.map((question) => `${issue.title}: ${question}`),
        )
        .join(" "),
      evidence_reference_ids: [],
      issue_reference_ids: params.issues
        .filter((issue) => issue.open_questions.length > 0)
        .map((issue) => issue.id),
      unsupported_claim_count: openQuestionCount,
    });
  }

  return withComputedMemoCoverage({
    id: computeArtifactId("draft_memo", params.matter_id, params.title),
    matter_id: params.matter_id,
    title: params.title,
    sections,
    citation_coverage_score: 0,
    unsupported_claim_count: 0,
    review_status: "pending",
    gate_status: "warning",
  });
}

export function reviewCommentsToEvalCases(
  comments: ReviewComment[],
  params: { source_run_id: string },
): EvalCase[] {
  return comments
    .filter((comment) => comment.status !== "resolved")
    .map((comment) => ({
      id: computeArtifactId(
        "eval_case",
        comment.matter_id,
        `${comment.id}:${comment.created_at}`,
      ),
      matter_id: comment.matter_id,
      source_run_id: params.source_run_id,
      failure_type: failureTypeForReviewComment(comment),
      input_snapshot: {
        artifact_id: comment.artifact_id,
        artifact_type: comment.artifact_type,
        review_comment_id: comment.id,
        severity: comment.severity,
      },
      expected_behavior:
        "Future agent runs should satisfy expert feedback before gate approval.",
      expert_feedback: comment.comment,
      status: "open",
    }));
}

export function gateResultsToAuditEvents(
  gateResults: GateResult[],
  params: HandoffClock & {
    actor_id: string;
    artifact_types_by_id?: Record<string, ArtifactType>;
  },
): AuditEvent[] {
  return gateResults.flatMap((gate) => {
    const timestamp = params.now ?? gate.created_at;
    const affectedArtifactIds =
      gate.affected_artifact_ids.length > 0
        ? gate.affected_artifact_ids
        : [gate.id];

    return affectedArtifactIds.map((artifactId) => ({
      id: computeArtifactId(
        "audit_event",
        gate.matter_id,
        `${gate.id}:${artifactId}:${timestamp}`,
      ),
      matter_id: gate.matter_id,
      actor_type: "system",
      actor_id: params.actor_id,
      action: `gate_${gate.gate_type}_${gate.status}`,
      artifact_id: artifactId,
      artifact_type:
        params.artifact_types_by_id?.[artifactId] ??
        (artifactId === gate.id ? "gate_result" : undefined),
      after_hash: computeArtifactId("gate_result", gate.matter_id, gate.reason),
      timestamp,
    }));
  });
}

export function validateDraftMemoDependencies(params: {
  memo: DraftMemo;
  evidence: EvidenceItem[];
  issues: IssueNode[];
}) {
  const evidenceIds = new Set(params.evidence.map((item) => item.id));
  const issueIds = new Set(params.issues.map((issue) => issue.id));
  const errors: string[] = [];

  params.memo.sections.forEach((section) => {
    section.evidence_reference_ids.forEach((evidenceId) => {
      if (!evidenceIds.has(evidenceId)) {
        errors.push(`${section.id} references missing evidence ${evidenceId}`);
      }
    });

    (section.issue_reference_ids ?? []).forEach((issueId) => {
      if (!issueIds.has(issueId)) {
        errors.push(`${section.id} references missing issue ${issueId}`);
      }
    });
  });

  return errors.length ? { ok: false as const, errors } : { ok: true as const };
}

function addArtifact(
  index: Map<string, Set<ArtifactType>>,
  id: string | undefined,
  type: ArtifactType,
) {
  if (!id) return;
  const types = index.get(id) ?? new Set<ArtifactType>();
  types.add(type);
  index.set(id, types);
}

function buildArtifactIndex(workspace: AgentOpsMatterWorkspace) {
  const index = new Map<string, Set<ArtifactType>>();

  addArtifact(index, workspace.matter.id, "matter");
  workspace.matter.documents.forEach((document) =>
    addArtifact(index, document.id, "document"),
  );
  workspace.runs.forEach((run) => addArtifact(index, run.id, "agent_run"));
  workspace.evidence.forEach((item) => addArtifact(index, item.id, "evidence_item"));
  workspace.issues.forEach((item) => addArtifact(index, item.id, "issue_node"));
  workspace.risks.forEach((item) => addArtifact(index, item.id, "risk_item"));
  workspace.draft_memos.forEach((memo) => {
    addArtifact(index, memo.id, "draft_memo");
    memo.sections.forEach((section) => addArtifact(index, section.id, "draft_memo"));
  });
  workspace.review_comments.forEach((comment) =>
    addArtifact(index, comment.id, "review_comment"),
  );
  workspace.gate_results.forEach((gate) => addArtifact(index, gate.id, "gate_result"));
  workspace.audit_events.forEach((event) => addArtifact(index, event.id, "audit_event"));
  workspace.eval_cases.forEach((item) => addArtifact(index, item.id, "eval_case"));
  workspace.skills.forEach((item) => addArtifact(index, item.id, "professional_skill"));

  return index;
}

function hasArtifact(
  index: Map<string, Set<ArtifactType>>,
  id: string,
  type?: ArtifactType,
) {
  const types = index.get(id);
  if (!types) return false;
  return type ? types.has(type) : true;
}

function checkArtifactRef(
  ref: ArtifactRef,
  index: Map<string, Set<ArtifactType>>,
  errors: string[],
  context: string,
) {
  if (!hasArtifact(index, ref.id, ref.type)) {
    errors.push(`${context} references missing ${ref.type} ${ref.id}`);
  }
}

export function validateWorkspaceReferences(
  workspace: AgentOpsMatterWorkspace,
): WorkspaceReferenceValidation {
  const artifactIndex = buildArtifactIndex(workspace);
  const documentIds = new Set(workspace.matter.documents.map((document) => document.id));
  const evidenceIds = new Set(workspace.evidence.map((item) => item.id));
  const issueIds = new Set(workspace.issues.map((item) => item.id));
  const runIds = new Set(workspace.runs.map((run) => run.id));
  const evalCaseIds = new Set(workspace.eval_cases.map((item) => item.id));
  const errors: string[] = [];
  const warnings: string[] = [];

  workspace.matter.documents.forEach((document) => {
    if (document.matter_id !== workspace.matter.id) {
      errors.push(`${document.id} belongs to matter ${document.matter_id}`);
    }
  });

  workspace.evidence.forEach((item) => {
    if (!documentIds.has(item.source_document_id)) {
      errors.push(`${item.id} references missing document ${item.source_document_id}`);
    }
    if (item.created_by_run_id && !runIds.has(item.created_by_run_id)) {
      errors.push(`${item.id} references missing run ${item.created_by_run_id}`);
    }
    item.supports_claim_ids.forEach((claimId) => {
      if (!issueIds.has(claimId)) {
        warnings.push(`${item.id} supports claim without issue node ${claimId}`);
      }
    });
  });

  workspace.issues.forEach((issue) => {
    issue.related_evidence_ids.forEach((evidenceId) => {
      if (!evidenceIds.has(evidenceId)) {
        errors.push(`${issue.id} references missing evidence ${evidenceId}`);
      }
    });
  });

  workspace.risks.forEach((risk) => {
    risk.related_issue_ids.forEach((issueId) => {
      if (!issueIds.has(issueId)) {
        errors.push(`${risk.id} references missing issue ${issueId}`);
      }
    });
    risk.related_evidence_ids.forEach((evidenceId) => {
      if (!evidenceIds.has(evidenceId)) {
        errors.push(`${risk.id} references missing evidence ${evidenceId}`);
      }
    });
  });

  workspace.draft_memos.forEach((memo) => {
    const result = validateDraftMemoDependencies({
      memo,
      evidence: workspace.evidence,
      issues: workspace.issues,
    });
    if (!result.ok) {
      errors.push(...result.errors);
    }
  });

  workspace.review_comments.forEach((comment) => {
    if (!hasArtifact(artifactIndex, comment.artifact_id, comment.artifact_type)) {
      errors.push(
        `${comment.id} references missing ${comment.artifact_type} ${comment.artifact_id}`,
      );
    }
    comment.referenced_artifacts?.forEach((ref) =>
      checkArtifactRef(ref, artifactIndex, errors, comment.id),
    );
  });

  workspace.gate_results.forEach((gate) => {
    gate.affected_artifact_ids.forEach((artifactId) => {
      if (!hasArtifact(artifactIndex, artifactId)) {
        errors.push(`${gate.id} affects missing artifact ${artifactId}`);
      }
    });
  });

  workspace.audit_events.forEach((event) => {
    if (event.artifact_id && !hasArtifact(artifactIndex, event.artifact_id, event.artifact_type)) {
      errors.push(`${event.id} references missing artifact ${event.artifact_id}`);
    }
    event.referenced_artifacts?.forEach((ref) =>
      checkArtifactRef(ref, artifactIndex, errors, event.id),
    );
  });

  workspace.eval_cases.forEach((item) => {
    if (!runIds.has(item.source_run_id)) {
      errors.push(`${item.id} references missing source run ${item.source_run_id}`);
    }
  });

  workspace.skills.forEach((skill) => {
    skill.created_from_eval_case_ids.forEach((evalCaseId) => {
      if (!evalCaseIds.has(evalCaseId)) {
        errors.push(`${skill.id} references missing eval case ${evalCaseId}`);
      }
    });
  });

  workspace.runs.forEach((run) => {
    [...run.input_artifacts, ...run.output_artifacts].forEach((ref) =>
      checkArtifactRef(ref, artifactIndex, errors, run.id),
    );
  });

  return {
    ok: errors.length === 0,
    errors,
    warnings,
  };
}

function emptySourceRecordIds(): TypedHandoffSourceRecordIds {
  return {
    documentIds: [],
    evidenceItemIds: [],
    issueNodeIds: [],
    riskItemIds: [],
    workProductIds: [],
    reviewItemIds: [],
    checkpointIds: [],
    auditEventIds: [],
    agentRunIds: [],
    feedbackExportIds: [],
    evalCaseIds: [],
    playbookIds: [],
  };
}

function appendUnique(target: string[], values: (string | undefined)[]) {
  values.forEach((value) => {
    if (value && !target.includes(value)) {
      target.push(value);
    }
  });
}

function checkpointIdFromGate(gate: GateResult) {
  return gate.id.startsWith("gate-checkpoint-")
    ? gate.id.replace(/^gate-checkpoint-/, "")
    : undefined;
}

function reviewIdFromEvalCase(item: EvalCase) {
  const snapshot = item.input_snapshot;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return undefined;
  }

  const record = snapshot as Record<string, unknown>;
  if (typeof record.review_comment_id === "string") {
    return record.review_comment_id;
  }
  if (typeof record.id === "string" && record.id.startsWith("review-")) {
    return record.id;
  }
  return undefined;
}

function addBigAtReferenceState(
  records:
    | {
        raw: string;
        status: "resolved" | "ambiguous" | "missing";
      }[]
    | undefined,
  provenance: TypedHandoffProvenance,
) {
  records?.forEach((record) => {
    if (record.status === "missing") {
      appendUnique(provenance.unresolvedReferenceIds, [record.raw]);
    }
    if (record.status === "ambiguous") {
      appendUnique(provenance.ambiguousReferenceIds, [record.raw]);
    }
  });
}

function createProvenance(
  workspace: AgentOpsMatterWorkspace,
  artifactId: string,
  artifactType: ArtifactType,
): TypedHandoffProvenance {
  return {
    matterId: workspace.matter.id,
    artifactId,
    artifactType,
    sourceRecordIds: emptySourceRecordIds(),
    gateResultIds: [],
    unresolvedReferenceIds: [],
    ambiguousReferenceIds: [],
    warnings: [],
  };
}

function includesAny(values: string[], candidates: string[]) {
  return candidates.some((candidate) => values.includes(candidate));
}

function itemMatchesGateProvenance(
  item: TypedHandoffProvenance,
  gateProvenance: GateProvenance,
) {
  if (
    item.artifactId === gateProvenance.gateId ||
    item.artifactId === gateProvenance.sourceId ||
    item.gateResultIds.includes(gateProvenance.gateId) ||
    gateProvenance.relatedWorkProductIds.includes(item.artifactId) ||
    gateProvenance.relatedReviewIds.includes(item.artifactId) ||
    gateProvenance.relatedAuditEventIds.includes(item.artifactId)
  ) {
    return true;
  }

  return (
    includesAny(item.sourceRecordIds.workProductIds, gateProvenance.relatedWorkProductIds) ||
    includesAny(item.sourceRecordIds.reviewItemIds, gateProvenance.relatedReviewIds) ||
    includesAny(item.sourceRecordIds.auditEventIds, gateProvenance.relatedAuditEventIds)
  );
}

function applyGateProvenance(
  provenanceItems: TypedHandoffProvenance[],
  gateProvenanceRecords: GateProvenance[] | undefined,
) {
  gateProvenanceRecords?.forEach((gateProvenance) => {
    const matchingItems = provenanceItems.filter((item) =>
      itemMatchesGateProvenance(item, gateProvenance),
    );

    matchingItems.forEach((item) => {
      appendUnique(item.gateResultIds, [gateProvenance.gateId]);
      appendUnique(
        item.sourceRecordIds.workProductIds,
        gateProvenance.relatedWorkProductIds,
      );
      appendUnique(
        item.sourceRecordIds.reviewItemIds,
        gateProvenance.relatedReviewIds,
      );
      appendUnique(
        item.sourceRecordIds.auditEventIds,
        gateProvenance.relatedAuditEventIds,
      );

      if (gateProvenance.sourceType === "human_checkpoint") {
        appendUnique(item.sourceRecordIds.checkpointIds, [
          gateProvenance.sourceId ?? undefined,
        ]);
      }

      if (gateProvenance.sourceType === "work_product_validation") {
        appendUnique(item.sourceRecordIds.workProductIds, [
          gateProvenance.sourceId ?? undefined,
        ]);
      }

      if (
        gateProvenance.sourceType === "unknown" ||
        !gateProvenance.sourceId ||
        gateProvenance.sourceStatus === "missing"
      ) {
        item.warnings.push(
          `${gateProvenance.gateId} lacks persisted gate provenance source`,
        );
      }
    });
  });
}

export function buildTypedHandoffProvenance(
  workspace: AgentOpsMatterWorkspace,
  options: TypedHandoffProvenanceOptions = {},
): TypedHandoffProvenance[] {
  const referenceValidation = validateWorkspaceReferences(workspace);
  const provenanceItems: TypedHandoffProvenance[] = [];
  const gatesByArtifactId = new Map<string, GateResult[]>();
  const reviewsByArtifactId = new Map<string, ReviewComment[]>();
  const auditsByArtifactId = new Map<string, AuditEvent[]>();

  workspace.gate_results.forEach((gate) => {
    gate.affected_artifact_ids.forEach((artifactId) => {
      gatesByArtifactId.set(artifactId, [
        ...(gatesByArtifactId.get(artifactId) ?? []),
        gate,
      ]);
    });
  });

  workspace.review_comments.forEach((comment) => {
    reviewsByArtifactId.set(comment.artifact_id, [
      ...(reviewsByArtifactId.get(comment.artifact_id) ?? []),
      comment,
    ]);
  });

  workspace.audit_events.forEach((event) => {
    if (!event.artifact_id) return;
    auditsByArtifactId.set(event.artifact_id, [
      ...(auditsByArtifactId.get(event.artifact_id) ?? []),
      event,
    ]);
  });

  const applySharedProvenance = (item: TypedHandoffProvenance) => {
    const gates = gatesByArtifactId.get(item.artifactId) ?? [];
    const reviews = reviewsByArtifactId.get(item.artifactId) ?? [];
    const audits = auditsByArtifactId.get(item.artifactId) ?? [];

    appendUnique(item.gateResultIds, gates.map((gate) => gate.id));
    appendUnique(item.sourceRecordIds.checkpointIds, gates.map(checkpointIdFromGate));
    appendUnique(item.sourceRecordIds.reviewItemIds, reviews.map((review) => review.id));
    appendUnique(item.sourceRecordIds.auditEventIds, audits.map((event) => event.id));
    reviews.forEach((review) => addBigAtReferenceState(review.big_at_resolution_records, item));
    audits.forEach((event) => addBigAtReferenceState(event.big_at_resolution_records, item));
  };

  workspace.matter.documents.forEach((document) => {
    const item = createProvenance(workspace, document.id, "document");
    appendUnique(item.sourceRecordIds.documentIds, [document.id, document.source_uri]);
    applySharedProvenance(item);
    provenanceItems.push(item);
  });

  workspace.evidence.forEach((evidence) => {
    const item = createProvenance(workspace, evidence.id, "evidence_item");
    appendUnique(item.sourceRecordIds.evidenceItemIds, [evidence.id]);
    appendUnique(item.sourceRecordIds.documentIds, [evidence.source_document_id]);
    appendUnique(item.sourceRecordIds.agentRunIds, [evidence.created_by_run_id]);
    applySharedProvenance(item);
    provenanceItems.push(item);
  });

  workspace.issues.forEach((issue) => {
    const item = createProvenance(workspace, issue.id, "issue_node");
    appendUnique(item.sourceRecordIds.issueNodeIds, [issue.id]);
    appendUnique(item.sourceRecordIds.evidenceItemIds, issue.related_evidence_ids);
    applySharedProvenance(item);
    provenanceItems.push(item);
  });

  workspace.risks.forEach((risk) => {
    const item = createProvenance(workspace, risk.id, "risk_item");
    appendUnique(item.sourceRecordIds.riskItemIds, [risk.id]);
    appendUnique(item.sourceRecordIds.issueNodeIds, risk.related_issue_ids);
    appendUnique(item.sourceRecordIds.evidenceItemIds, risk.related_evidence_ids);
    applySharedProvenance(item);
    provenanceItems.push(item);
  });

  workspace.draft_memos.forEach((memo) => {
    const memoItem = createProvenance(workspace, memo.id, "draft_memo");
    appendUnique(memoItem.sourceRecordIds.workProductIds, [memo.id]);
    appendUnique(
      memoItem.sourceRecordIds.evidenceItemIds,
      memo.sections.flatMap((section) => section.evidence_reference_ids),
    );
    appendUnique(
      memoItem.sourceRecordIds.issueNodeIds,
      memo.sections.flatMap((section) => section.issue_reference_ids ?? []),
    );
    memo.sections.forEach((section) =>
      addBigAtReferenceState(section.big_at_resolution_records, memoItem),
    );
    applySharedProvenance(memoItem);
    provenanceItems.push(memoItem);

    memo.sections.forEach((section) => {
      const sectionItem = createProvenance(workspace, section.id, "draft_memo");
      appendUnique(sectionItem.sourceRecordIds.workProductIds, [memo.id, section.id]);
      appendUnique(sectionItem.sourceRecordIds.evidenceItemIds, section.evidence_reference_ids);
      appendUnique(sectionItem.sourceRecordIds.issueNodeIds, section.issue_reference_ids ?? []);
      addBigAtReferenceState(section.big_at_resolution_records, sectionItem);
      applySharedProvenance(sectionItem);
      provenanceItems.push(sectionItem);
    });
  });

  workspace.review_comments.forEach((comment) => {
    const item = createProvenance(workspace, comment.id, "review_comment");
    appendUnique(item.sourceRecordIds.reviewItemIds, [comment.id]);
    appendUnique(item.sourceRecordIds.workProductIds, [comment.work_product_id]);
    appendUnique(item.sourceRecordIds.evidenceItemIds, [comment.evidence_item_id]);
    addBigAtReferenceState(comment.big_at_resolution_records, item);
    applySharedProvenance(item);
    provenanceItems.push(item);
  });

  workspace.gate_results.forEach((gate) => {
    const item = createProvenance(workspace, gate.id, "gate_result");
    appendUnique(item.gateResultIds, [gate.id]);
    appendUnique(item.sourceRecordIds.checkpointIds, [checkpointIdFromGate(gate)]);
    appendUnique(item.sourceRecordIds.workProductIds, gate.affected_artifact_ids);
    applySharedProvenance(item);
    provenanceItems.push(item);
  });

  workspace.audit_events.forEach((event) => {
    const item = createProvenance(workspace, event.id, "audit_event");
    appendUnique(item.sourceRecordIds.auditEventIds, [event.id]);
    appendUnique(
      item.sourceRecordIds.workProductIds,
      event.artifact_type === "draft_memo" ? [event.artifact_id] : [],
    );
    addBigAtReferenceState(event.big_at_resolution_records, item);
    applySharedProvenance(item);
    provenanceItems.push(item);
  });

  workspace.eval_cases.forEach((evalCase) => {
    const item = createProvenance(workspace, evalCase.id, "eval_case");
    appendUnique(item.sourceRecordIds.evalCaseIds, [evalCase.id]);
    appendUnique(item.sourceRecordIds.agentRunIds, [evalCase.source_run_id]);
    appendUnique(item.sourceRecordIds.reviewItemIds, [reviewIdFromEvalCase(evalCase)]);
    applySharedProvenance(item);
    provenanceItems.push(item);
  });

  workspace.skills.forEach((skill) => {
    const item = createProvenance(workspace, skill.id, "professional_skill");
    appendUnique(item.sourceRecordIds.playbookIds, [skill.id]);
    appendUnique(item.sourceRecordIds.evalCaseIds, skill.created_from_eval_case_ids);
    if (skill.approval_status !== "approved") {
      item.warnings.push(`${skill.id} is not backed by an approved playbook state`);
    }
    applySharedProvenance(item);
    provenanceItems.push(item);
  });

  if (!referenceValidation.ok || referenceValidation.warnings.length > 0) {
    provenanceItems.forEach((item) => {
      appendUnique(item.warnings, referenceValidation.errors);
      appendUnique(item.warnings, referenceValidation.warnings);
    });
  }

  applyGateProvenance(provenanceItems, options.gateProvenance);

  return provenanceItems;
}

export function evaluateTypedHandoffReadiness(
  workspace: AgentOpsMatterWorkspace,
  options: TypedHandoffProvenanceOptions = {},
): TypedHandoffReadiness {
  const validation = validateWorkspaceReferences(workspace);
  const provenance = buildTypedHandoffProvenance(workspace, options);
  const blockers = [...validation.errors];
  const warnings = [...validation.warnings];

  provenance.forEach((item) => {
    item.unresolvedReferenceIds.forEach((referenceId) => {
      blockers.push(`${item.artifactId} has unresolved reference ${referenceId}`);
    });
    item.ambiguousReferenceIds.forEach((referenceId) => {
      blockers.push(`${item.artifactId} has ambiguous reference ${referenceId}`);
    });
    item.warnings.forEach((warning) => {
      if (warning.includes("lacks persisted gate provenance source")) {
        blockers.push(`${item.artifactId}: ${warning}`);
      } else {
        warnings.push(`${item.artifactId}: ${warning}`);
      }
    });
  });

  return {
    status: blockers.length > 0 ? "blocked" : "ready",
    artifactCounts: {
      documents: workspace.matter.documents.length,
      evidenceItems: workspace.evidence.length,
      issues: workspace.issues.length,
      risks: workspace.risks.length,
      draftMemoSections: workspace.draft_memos.reduce(
        (total, memo) => total + memo.sections.length,
        0,
      ),
      reviewComments: workspace.review_comments.length,
      gateResults: workspace.gate_results.length,
      auditEvents: workspace.audit_events.length,
      evalCases: workspace.eval_cases.length,
      provenanceItems: provenance.length,
    },
    blockers: unique(blockers),
    warnings: unique(warnings),
  };
}
