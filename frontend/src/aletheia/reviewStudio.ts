import type {
  DraftMemoSection,
  EvidenceItem,
  MatterWorkspace,
  ReviewItem,
  RiskLevel,
} from "./types";

export type EvidenceDecision = "pending" | "approved" | "rejected";

export type ReviewStudioState = {
  evidenceDecisions: Record<string, EvidenceDecision>;
  factOverrides: Record<string, string>;
  riskOverrides: Record<string, RiskLevel>;
  omittedIssueIds: string[];
  supplementalMaterialRequests: string[];
  finalExportApproved: boolean;
};

export type ReviewStudioIssue = {
  id: string;
  title: string;
  riskLevel: RiskLevel;
  evidenceIds: string[];
  missingFacts: string[];
  reviewState: "ready" | "needs_review" | "blocked";
};

export type ReviewStudioRisk = {
  id: string;
  issueId: string;
  title: string;
  severity: RiskLevel;
  likelihood: RiskLevel;
  evidenceIds: string[];
  status: "open" | "mitigating" | "blocked";
  recommendation: string;
};

export type ReviewStudioObligation = {
  id: string;
  source: string;
  obligation: string;
  owner: string;
  riskLevel: RiskLevel;
  status: "satisfied" | "open" | "blocked";
  evidenceIds: string[];
};

export type ReviewStudioRedFlag = {
  id: string;
  title: string;
  severity: RiskLevel;
  reason: string;
  evidenceIds: string[];
  requestedAction: string;
};

export type ReviewStudioMemoLink = {
  sectionId: string;
  title: string;
  evidenceIds: string[];
  issueIds: string[];
  riskIds: string[];
  unsupported: boolean;
};

export type ReviewStudioGate = {
  status: "blocked" | "ready";
  reasons: string[];
};

export type ReviewStudioEvalRecord = {
  id: string;
  sourceReviewId: string;
  failureType: string;
  targetId: string;
  expectedBehavior: string;
};

export type ReviewStudioLogEntry = {
  id: string;
  action: string;
  targetId: string;
  summary: string;
  evalReady: boolean;
};

export type ReviewStudioModel = {
  issues: ReviewStudioIssue[];
  risks: ReviewStudioRisk[];
  obligations: ReviewStudioObligation[];
  redFlags: ReviewStudioRedFlag[];
  openQuestions: string[];
  memoLinks: ReviewStudioMemoLink[];
  reviewLog: ReviewStudioLogEntry[];
  evalRecords: ReviewStudioEvalRecord[];
  gate: ReviewStudioGate;
};

export const defaultReviewStudioState: ReviewStudioState = {
  evidenceDecisions: {},
  factOverrides: {},
  riskOverrides: {},
  omittedIssueIds: [],
  supplementalMaterialRequests: [],
  finalExportApproved: false,
};

function likelihoodFromEvidence(evidence: EvidenceItem[]): RiskLevel {
  if (evidence.some((item) => item.supportStatus === "contradicts")) return "high";
  if (evidence.some((item) => item.supportStatus === "insufficient")) return "medium";
  return "low";
}

function reviewFailureType(review: ReviewItem) {
  if (review.tag === "citation_not_supporting") return "missing_citation";
  if (review.tag === "unsupported_claim" || review.tag === "overclaim") {
    return "unsupported_claim";
  }
  if (review.tag === "conflicting_evidence") return "contradiction_missed";
  if (review.tag === "missing_fact") return "missed_issue";
  return "expert_override";
}

function memoIssueIds(section: DraftMemoSection, workspace: MatterWorkspace) {
  const evidenceIds = new Set(section.evidenceIds ?? []);
  const directIssueIds = workspace.issues
    .filter(
      (issue) =>
        issue.evidenceIds.some((id) => evidenceIds.has(id)) ||
        section.body.some((paragraph) =>
          paragraph.toLowerCase().includes(issue.title.toLowerCase().slice(0, 24)),
        ),
    )
    .map((issue) => issue.id);

  if (directIssueIds.length > 0) return directIssueIds;

  const title = section.title.toLowerCase();
  const isReviewControlSection =
    title.includes("missing") ||
    title.includes("recommended") ||
    title.includes("review");

  if (!isReviewControlSection) return [];

  return workspace.issues
    .filter(
      (issue) => issue.missingFacts.length > 0 || issue.humanJudgmentRequired,
    )
    .map((issue) => issue.id);
}

export function deriveReviewStudioModel(
  workspace: MatterWorkspace,
  state: ReviewStudioState,
): ReviewStudioModel {
  const evidenceById = new Map(workspace.evidence.map((item) => [item.id, item]));
  const issues: ReviewStudioIssue[] = workspace.issues.map((issue) => {
    const decisionValues = issue.evidenceIds.map(
      (id) => state.evidenceDecisions[id] ?? "pending",
    );
    const blocked =
      state.omittedIssueIds.includes(issue.id) ||
      decisionValues.includes("rejected");
    return {
      id: issue.id,
      title: issue.title,
      riskLevel: state.riskOverrides[issue.id] ?? issue.riskLevel,
      evidenceIds: issue.evidenceIds,
      missingFacts: issue.missingFacts,
      reviewState: blocked
        ? "blocked"
        : issue.humanJudgmentRequired || decisionValues.includes("pending")
          ? "needs_review"
          : "ready",
    };
  });

  const risks: ReviewStudioRisk[] = issues.map((issue) => {
    const evidence = issue.evidenceIds
      .map((id) => evidenceById.get(id))
      .filter((item): item is EvidenceItem => Boolean(item));
    const likelihood = likelihoodFromEvidence(evidence);
    return {
      id: `risk-${issue.id}`,
      issueId: issue.id,
      title: `Risk: ${issue.title}`,
      severity: issue.riskLevel,
      likelihood,
      evidenceIds: issue.evidenceIds,
      status: issue.reviewState === "blocked" ? "blocked" : "open",
      recommendation:
        issue.missingFacts.length > 0
          ? `Request ${issue.missingFacts[0]} before final export.`
          : "Keep cited evidence attached and route to expert review.",
    };
  });

  const obligations: ReviewStudioObligation[] = [
    ...workspace.plan.requiredDocuments.slice(0, 4).map((name, index) => {
      const satisfied = workspace.documents.some((doc) =>
        name.toLowerCase().includes(doc.name.toLowerCase().slice(0, 8)),
      );
      return {
        id: `obligation-required-${index}`,
        source: "Matter intake required documents",
        obligation: `Confirm ${name}.`,
        owner: "Matter lead",
        riskLevel: satisfied ? "low" : "medium",
        status: satisfied ? "satisfied" : "open",
        evidenceIds: [],
      } satisfies ReviewStudioObligation;
    }),
    ...workspace.plan.missingMaterials.map((name, index) => ({
      id: `obligation-missing-${index}`,
      source: "Agent plan missing materials",
      obligation: `Request and review ${name}.`,
      owner: "Human reviewer",
      riskLevel: "high" as const,
      status: "blocked" as const,
      evidenceIds: [],
    })),
  ];

  const redFlags: ReviewStudioRedFlag[] = risks
    .filter((risk) => risk.severity === "high" || risk.status === "blocked")
    .map((risk) => ({
      id: `red-flag-${risk.issueId}`,
      title: risk.title.replace(/^Risk: /, ""),
      severity: risk.severity,
      reason:
        risk.status === "blocked"
          ? "Expert review blocked at least one linked evidence or issue."
          : "High-severity issue remains open before final export.",
      evidenceIds: risk.evidenceIds,
      requestedAction: risk.recommendation,
    }));

  const openQuestions = Array.from(
    new Set([
      ...workspace.plan.missingMaterials,
      ...issues.flatMap((issue) => issue.missingFacts),
      ...state.supplementalMaterialRequests,
    ]),
  );

  const memoLinks: ReviewStudioMemoLink[] = workspace.memo.sections.map((section) => {
    const issueIds = memoIssueIds(section, workspace);
    return {
      sectionId: section.id,
      title: section.title,
      evidenceIds: section.evidenceIds ?? [],
      issueIds,
      riskIds: issueIds.map((id) => `risk-${id}`),
      unsupported: (section.evidenceIds ?? []).length === 0,
    };
  });

  const reviewLog: ReviewStudioLogEntry[] = [
    ...workspace.reviews.map((review) => ({
      id: review.id,
      action: review.tag,
      targetId: review.targetId,
      summary: review.comment,
      evalReady: review.tag !== "accepted",
    })),
    ...Object.entries(state.evidenceDecisions)
      .filter(([, decision]) => decision !== "pending")
      .map(([evidenceId, decision]) => ({
        id: `review-decision-${evidenceId}`,
        action: `evidence_${decision}`,
        targetId: evidenceId,
        summary: `Human reviewer ${decision} evidence ${evidenceId}.`,
        evalReady: decision === "rejected",
      })),
    ...Object.entries(state.factOverrides).map(([evidenceId, fact]) => ({
      id: `review-fact-${evidenceId}`,
      action: "fact_modified",
      targetId: evidenceId,
      summary: fact,
      evalReady: true,
    })),
    ...Object.entries(state.riskOverrides).map(([issueId, risk]) => ({
      id: `review-risk-${issueId}`,
      action: "risk_level_changed",
      targetId: issueId,
      summary: `Human reviewer set risk level to ${risk}.`,
      evalReady: true,
    })),
    ...state.omittedIssueIds.map((issueId) => ({
      id: `review-omission-${issueId}`,
      action: "omission_flagged",
      targetId: issueId,
      summary: "Human reviewer marked this issue as omitted or incomplete.",
      evalReady: true,
    })),
    ...state.supplementalMaterialRequests.map((request, index) => ({
      id: `review-material-${index}`,
      action: "supplemental_material_requested",
      targetId: workspace.matter.id,
      summary: request,
      evalReady: true,
    })),
  ];

  const blockedIssues = issues.filter((issue) => issue.reviewState === "blocked");
  const gateReasons = [
    ...blockedIssues.map((issue) => `Review blocker on issue: ${issue.title}`),
    ...memoLinks
      .filter(
        (link) =>
          link.unsupported &&
          link.issueIds.length === 0 &&
          link.riskIds.length === 0,
      )
      .map((link) => `Memo section lacks evidence, issue, or risk link: ${link.title}`),
  ];
  if (!state.finalExportApproved) {
    gateReasons.push("Final export requires explicit expert approval.");
  }

  const evalRecords = [
    ...workspace.reviews
      .filter((review) => review.tag !== "accepted")
      .map((review) => ({
        id: `eval-${review.id}`,
        sourceReviewId: review.id,
        failureType: reviewFailureType(review),
        targetId: review.targetId,
        expectedBehavior:
          "Future draft runs should satisfy the expert review note before gate approval.",
      })),
    ...reviewLog
      .filter((entry) => entry.evalReady && entry.id.startsWith("review-"))
      .map((entry) => ({
        id: `eval-${entry.id}`,
        sourceReviewId: entry.id,
        failureType:
          entry.action === "risk_level_changed"
            ? "wrong_risk_level"
            : entry.action === "omission_flagged"
              ? "missed_issue"
              : "expert_override",
        targetId: entry.targetId,
        expectedBehavior:
          "Future bounded runs should preserve this reviewer correction as an eval badcase.",
      })),
  ];

  return {
    issues,
    risks,
    obligations,
    redFlags,
    openQuestions,
    memoLinks,
    reviewLog,
    evalRecords,
    gate: {
      status: gateReasons.length === 0 ? "ready" : "blocked",
      reasons: gateReasons,
    },
  };
}
