import type {
  DraftMemo,
  DraftMemoSection,
  EvidenceItem,
  GateResult,
  GateStatus,
  GateType,
  IssueNode,
  Matter,
  ReviewComment,
  RiskItem,
} from "./types";

export type ExportIntent = "draft" | "final";

export type UnsupportedClaim = {
  section_id: string;
  section_title: string;
  reason: string;
  unsupported_claim_count: number;
};

export type CitationCoverage = {
  citation_coverage_score: number;
  unsupported_claim_count: number;
  cited_section_count: number;
  total_section_count: number;
  unsupported_claims: UnsupportedClaim[];
};

export type GateEngineInput = {
  matter: Matter;
  draftMemo: DraftMemo;
  evidence: EvidenceItem[];
  issues: IssueNode[];
  risks: RiskItem[];
  reviewComments: ReviewComment[];
  exportIntent?: ExportIntent;
  humanApproved?: boolean;
  now?: string;
};

const conflictPattern = /\b(conflict|conflicting|contradict|contradiction|inconsistent|dispute|disputed)\b/i;
const uncertaintyPattern = /\b(unclear|unknown|tbd|to be determined|unspecified|not provided|unresolved)\b/i;
const privilegePattern = /\b(privileged|attorney[- ]client|legal advice|work product|confidential|sensitive|secret|non[- ]public)\b/i;

function gateId(matterId: string, gateType: GateType) {
  return `gate-${matterId}-${gateType}`;
}

function makeGate(params: {
  matterId: string;
  gateType: GateType;
  status: GateStatus;
  reason: string;
  affectedArtifactIds: string[];
  requiredAction?: string;
  now: string;
}): GateResult {
  return {
    id: gateId(params.matterId, params.gateType),
    matter_id: params.matterId,
    gate_type: params.gateType,
    status: params.status,
    reason: params.reason,
    affected_artifact_ids: params.affectedArtifactIds,
    required_action: params.requiredAction,
    created_at: params.now,
  };
}

function nonEmpty(value: string | undefined) {
  return Boolean(value?.trim());
}

function evidenceIds(evidence: EvidenceItem[]) {
  return new Set(evidence.map((item) => item.id));
}

function validEvidenceReferences(
  section: DraftMemoSection,
  knownEvidenceIds: Set<string>,
) {
  return section.evidence_reference_ids.filter((id) => knownEvidenceIds.has(id));
}

function textIncludes(pattern: RegExp, values: Array<string | undefined>) {
  return values.some((value) => Boolean(value && pattern.test(value)));
}

export function findUnsupportedClaims(
  memo: DraftMemo,
  evidence: EvidenceItem[] = [],
): UnsupportedClaim[] {
  const knownEvidenceIds = evidenceIds(evidence);

  return memo.sections.flatMap((section) => {
    const explicitUnsupportedCount = section.unsupported_claim_count ?? 0;
    const hasKnownEvidence =
      evidence.length === 0
        ? section.evidence_reference_ids.length > 0
        : validEvidenceReferences(section, knownEvidenceIds).length > 0;
    const reasons: string[] = [];

    if (!hasKnownEvidence) {
      reasons.push("No valid EvidenceItem citation is attached.");
    }
    if (explicitUnsupportedCount > 0) {
      reasons.push(
        `${explicitUnsupportedCount} unsupported claim${explicitUnsupportedCount === 1 ? "" : "s"} already marked on the section.`,
      );
    }

    if (reasons.length === 0) return [];
    return [
      {
        section_id: section.id,
        section_title: section.title,
        reason: reasons.join(" "),
        unsupported_claim_count: Math.max(1, explicitUnsupportedCount),
      },
    ];
  });
}

export function calculateCitationCoverage(
  memo: DraftMemo,
  evidence: EvidenceItem[] = [],
): CitationCoverage {
  const unsupportedClaims = findUnsupportedClaims(memo, evidence);
  const knownEvidenceIds = evidenceIds(evidence);
  const totalSectionCount = memo.sections.length;
  const citedSectionCount = memo.sections.filter((section) =>
    evidence.length === 0
      ? section.evidence_reference_ids.length > 0
      : validEvidenceReferences(section, knownEvidenceIds).length > 0,
  ).length;
  const unsupportedClaimCount = unsupportedClaims.reduce(
    (total, item) => total + item.unsupported_claim_count,
    0,
  );

  return {
    citation_coverage_score:
      totalSectionCount === 0
        ? 0
        : Number((citedSectionCount / totalSectionCount).toFixed(2)),
    unsupported_claim_count: unsupportedClaimCount,
    cited_section_count: citedSectionCount,
    total_section_count: totalSectionCount,
    unsupported_claims: unsupportedClaims,
  };
}

export function hasUnresolvedReviewComments(
  reviewComments: ReviewComment[],
  artifactIds?: string[],
) {
  const filterIds = artifactIds ? new Set(artifactIds) : null;
  return reviewComments.some(
    (comment) =>
      comment.status === "open" &&
      (!filterIds || filterIds.has(comment.artifact_id)),
  );
}

export function hasMissingMaterials(args: {
  matter: Matter;
  issues: IssueNode[];
  risks: RiskItem[];
}) {
  const pendingDocuments = args.matter.documents.filter(
    (document) => document.status === "pending" || document.status === "failed",
  );
  const openQuestionIssues = args.issues.filter(
    (issue) => issue.open_questions.length > 0,
  );
  const missingRiskItems = args.risks.filter((risk) =>
    textIncludes(uncertaintyPattern, [
      risk.title,
      risk.description,
      risk.recommendation,
    ]),
  );

  return {
    hasMissingMaterials:
      pendingDocuments.length > 0 ||
      openQuestionIssues.length > 0 ||
      missingRiskItems.length > 0,
    pending_document_ids: pendingDocuments.map((document) => document.id),
    open_question_issue_ids: openQuestionIssues.map((issue) => issue.id),
    missing_risk_ids: missingRiskItems.map((risk) => risk.id),
  };
}

export function canExportFinal(gateResults: GateResult[]) {
  const exportGate = gateResults.find((gate) => gate.gate_type === "export");
  return (
    exportGate?.status === "passed" &&
    gateResults.every((gate) => gate.status !== "failed")
  );
}

function conflictArtifactIds(args: {
  evidence: EvidenceItem[];
  issues: IssueNode[];
  risks: RiskItem[];
  reviewComments: ReviewComment[];
}) {
  const ids = new Set<string>();
  for (const item of args.evidence) {
    if (textIncludes(conflictPattern, [item.quote, item.normalized_fact])) {
      ids.add(item.id);
    }
  }
  for (const issue of args.issues) {
    if (
      textIncludes(conflictPattern, [
        issue.title,
        issue.description,
        issue.legal_or_professional_standard,
        ...issue.open_questions,
      ])
    ) {
      ids.add(issue.id);
    }
  }
  for (const risk of args.risks) {
    if (
      textIncludes(conflictPattern, [
        risk.title,
        risk.description,
        risk.recommendation,
      ])
    ) {
      ids.add(risk.id);
    }
  }
  for (const comment of args.reviewComments) {
    if (comment.status === "open" && textIncludes(conflictPattern, [comment.comment])) {
      ids.add(comment.artifact_id);
    }
  }
  return [...ids];
}

function scopeArtifactIds(args: { matter: Matter; issues: IssueNode[] }) {
  const ids = new Set<string>();
  if (args.matter.type === "other") ids.add(args.matter.id);

  for (const issue of args.issues) {
    if (
      !nonEmpty(issue.legal_or_professional_standard) ||
      textIncludes(uncertaintyPattern, [issue.legal_or_professional_standard])
    ) {
      ids.add(issue.id);
    }
  }
  return [...ids];
}

function privilegedArtifactIds(args: {
  matter: Matter;
  memo: DraftMemo;
  evidence: EvidenceItem[];
  risks: RiskItem[];
  reviewComments: ReviewComment[];
}) {
  const ids = new Set<string>();
  for (const document of args.matter.documents) {
    if (textIncludes(privilegePattern, [document.title, document.filename])) {
      ids.add(document.id);
    }
  }
  for (const section of args.memo.sections) {
    if (textIncludes(privilegePattern, [section.title, section.body])) {
      ids.add(section.id);
    }
  }
  for (const item of args.evidence) {
    if (textIncludes(privilegePattern, [item.quote, item.normalized_fact])) {
      ids.add(item.id);
    }
  }
  for (const risk of args.risks) {
    if (
      textIncludes(privilegePattern, [
        risk.title,
        risk.description,
        risk.recommendation,
      ])
    ) {
      ids.add(risk.id);
    }
  }
  for (const comment of args.reviewComments) {
    if (textIncludes(privilegePattern, [comment.comment])) {
      ids.add(comment.artifact_id);
    }
  }
  return [...ids];
}

export function runGates(input: GateEngineInput): GateResult[] {
  const now = input.now ?? new Date().toISOString();
  const exportIntent = input.exportIntent ?? "draft";
  const memoArtifactIds = [
    input.draftMemo.id,
    ...input.draftMemo.sections.map((section) => section.id),
  ];
  const coverage = calculateCitationCoverage(input.draftMemo, input.evidence);
  const unresolvedReviews = hasUnresolvedReviewComments(
    input.reviewComments,
    memoArtifactIds,
  );
  const missingMaterials = hasMissingMaterials({
    matter: input.matter,
    issues: input.issues,
    risks: input.risks,
  });
  const conflicts = conflictArtifactIds(input);
  const scopeIssues = scopeArtifactIds({
    matter: input.matter,
    issues: input.issues,
  });
  const privilegedArtifacts = privilegedArtifactIds({
    matter: input.matter,
    memo: input.draftMemo,
    evidence: input.evidence,
    risks: input.risks,
    reviewComments: input.reviewComments,
  });
  const humanApproved =
    input.humanApproved || input.draftMemo.review_status === "approved";
  const isHighRisk = input.matter.risk_level === "high";

  const gates: GateResult[] = [
    makeGate({
      matterId: input.matter.id,
      gateType: "citation",
      status: coverage.unsupported_claim_count === 0 ? "passed" : "failed",
      reason:
        coverage.unsupported_claim_count === 0
          ? `All ${coverage.total_section_count} memo sections cite valid evidence.`
          : `${coverage.unsupported_claim_count} unsupported memo claim group${coverage.unsupported_claim_count === 1 ? "" : "s"} found across ${coverage.total_section_count} section${coverage.total_section_count === 1 ? "" : "s"}.`,
      affectedArtifactIds:
        coverage.unsupported_claims.length === 0
          ? [input.draftMemo.id]
          : coverage.unsupported_claims.map((claim) => claim.section_id),
      requiredAction:
        coverage.unsupported_claim_count === 0
          ? undefined
          : "Attach EvidenceItem citations or mark unsupported content as an open question.",
      now,
    }),
    makeGate({
      matterId: input.matter.id,
      gateType: "human_approval",
      status:
        exportIntent === "draft" ||
        ((!isHighRisk || humanApproved) && !unresolvedReviews)
          ? "passed"
          : "failed",
      reason:
        exportIntent === "draft"
          ? "Draft export does not require final expert approval."
          : unresolvedReviews
            ? "Open review comments remain on the memo or memo sections."
          : !isHighRisk
            ? "Matter is not high risk, so final export does not require expert approval."
            : humanApproved
              ? "High-risk final export has expert approval."
              : "High-risk final export requires expert approval.",
      affectedArtifactIds: [input.draftMemo.id],
      requiredAction:
        exportIntent === "final" && unresolvedReviews
          ? "Resolve or reject review comments before final export."
          : exportIntent === "final" && isHighRisk && !humanApproved
            ? "Route the draft memo to an expert reviewer and record approval."
            : undefined,
      now,
    }),
    makeGate({
      matterId: input.matter.id,
      gateType: "missing_material",
      status: missingMaterials.hasMissingMaterials
        ? isHighRisk || exportIntent === "final"
          ? "failed"
          : "warning"
        : "passed",
      reason: missingMaterials.hasMissingMaterials
        ? `Missing material remains: ${missingMaterials.open_question_issue_ids.length} issue${missingMaterials.open_question_issue_ids.length === 1 ? "" : "s"} with open questions, ${missingMaterials.pending_document_ids.length} pending or failed document${missingMaterials.pending_document_ids.length === 1 ? "" : "s"}.`
        : "No open questions, failed documents, or missing-material risk flags were found.",
      affectedArtifactIds: [
        ...missingMaterials.open_question_issue_ids,
        ...missingMaterials.pending_document_ids,
        ...missingMaterials.missing_risk_ids,
      ],
      requiredAction: missingMaterials.hasMissingMaterials
        ? "Resolve open questions, obtain missing documents, or explicitly accept the caveat."
        : undefined,
      now,
    }),
    makeGate({
      matterId: input.matter.id,
      gateType: "conflict",
      status: conflicts.length > 0 ? "failed" : "passed",
      reason:
        conflicts.length > 0
          ? `${conflicts.length} conflict marker${conflicts.length === 1 ? "" : "s"} found in evidence, issues, risks, or open review comments.`
          : "No conflict markers were found.",
      affectedArtifactIds: conflicts,
      requiredAction:
        conflicts.length > 0
          ? "Resolve or document the conflict before final conclusions are exported."
          : undefined,
      now,
    }),
    makeGate({
      matterId: input.matter.id,
      gateType: "jurisdiction",
      status:
        scopeIssues.length === 0
          ? "passed"
          : isHighRisk || exportIntent === "final"
            ? "failed"
            : "warning",
      reason:
        scopeIssues.length === 0
          ? "Professional scope and standards are stated on all issue nodes."
          : "Professional scope, jurisdiction, or applicable standard is unclear.",
      affectedArtifactIds: scopeIssues,
      requiredAction:
        scopeIssues.length > 0
          ? "Clarify professional scope, jurisdiction, or governing standard before final conclusions."
          : undefined,
      now,
    }),
    makeGate({
      matterId: input.matter.id,
      gateType: "privilege",
      status: privilegedArtifacts.length > 0 ? "warning" : "passed",
      reason:
        privilegedArtifacts.length > 0
          ? `${privilegedArtifacts.length} potentially privileged or confidential artifact${privilegedArtifacts.length === 1 ? "" : "s"} found.`
          : "No privilege or confidentiality markers were found.",
      affectedArtifactIds: privilegedArtifacts,
      requiredAction:
        privilegedArtifacts.length > 0
          ? "Confirm export audience, redactions, and confidentiality handling."
          : undefined,
      now,
    }),
  ];

  const blockingGates = gates.filter((gate) => gate.status === "failed");
  const warningGates = gates.filter((gate) => gate.status === "warning");
  gates.push(
    makeGate({
      matterId: input.matter.id,
      gateType: "export",
      status:
        exportIntent === "draft"
          ? warningGates.length > 0
            ? "warning"
            : "passed"
          : blockingGates.length > 0
            ? "failed"
            : "passed",
      reason:
        exportIntent === "draft"
          ? "Draft export is allowed with visible gate status."
          : blockingGates.length > 0
            ? `Final export blocked by ${blockingGates.length} failed gate${blockingGates.length === 1 ? "" : "s"}.`
            : "Final export may proceed; critical gates passed.",
      affectedArtifactIds:
        blockingGates.length > 0
          ? blockingGates.flatMap((gate) => gate.affected_artifact_ids)
          : [input.draftMemo.id],
      requiredAction:
        exportIntent === "final" && blockingGates.length > 0
          ? "Clear failed gates before creating a final deliverable."
          : undefined,
      now,
    }),
  );

  return gates;
}
