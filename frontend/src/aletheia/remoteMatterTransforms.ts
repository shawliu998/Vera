import type {
  AletheiaAgentRunRecord,
  AletheiaMatterDetail,
} from "@/app/lib/aletheiaApi";

export function titleize(value: string) {
  return value.replaceAll("_", " ");
}

export function traceStatusClass(status: string) {
  if (
    status === "completed" ||
    status === "approved" ||
    status === "resolved"
  ) {
    return "border-emerald-200 bg-emerald-50 text-emerald-800";
  }
  if (
    status === "needs_human" ||
    status === "requires_confirmation" ||
    status === "open"
  ) {
    return "border-amber-200 bg-amber-50 text-amber-800";
  }
  if (status === "failed" || status === "rejected") {
    return "border-red-200 bg-red-50 text-red-700";
  }
  return "border-[#e5e7eb] bg-[#f9fafb] text-[#374151]";
}

export function runTraceCounts(run: AletheiaAgentRunRecord | null) {
  return {
    steps: run?.steps?.length ?? 0,
    tools: run?.tool_calls?.length ?? 0,
    checkpoints: run?.human_checkpoints?.length ?? 0,
  };
}

export function highRiskCheckpoints(
  detail: AletheiaMatterDetail | null,
  action: "audit_pack_export" | "feedback_dataset_export" | "final_memo_export",
) {
  return (detail?.agentRuns ?? [])
    .flatMap((run) => run.human_checkpoints ?? [])
    .filter((checkpoint) => checkpoint.checkpoint_type === action);
}

export function buildAuditPack(
  detail: AletheiaMatterDetail,
): Record<string, unknown> {
  return {
    schemaVersion: "aletheia-audit-pack-v0",
    exportedAt: new Date().toISOString(),
    matter: detail.matter,
    documents: detail.documents,
    workProducts: detail.workProducts,
    evidence: detail.evidence,
    reviews: detail.reviews,
    auditEvents: detail.auditEvents,
  };
}

export function buildFeedbackDataset(
  detail: AletheiaMatterDetail,
): Record<string, unknown> {
  return {
    schemaVersion: "aletheia-feedback-eval-v0",
    exportedAt: new Date().toISOString(),
    matterId: detail.matter.id,
    matterTitle: detail.matter.title,
    objective: detail.matter.objective,
    records: detail.reviews.map((review) => ({
      id: review.id,
      createdAt: review.created_at,
      reviewer: review.reviewer_name ?? review.reviewer_user_id,
      tag: review.tag,
      comment: review.comment,
      targetType: review.target_type,
      targetId: review.target_id,
      evidence: detail.evidence.filter(
        (item) =>
          item.id === review.evidence_item_id ||
          item.claim_id === review.target_id,
      ),
    })),
  };
}

export function buildFinalMemo(args: {
  detail: AletheiaMatterDetail;
  draftMemoId: string;
  draftContent: Record<string, unknown>;
  approvalCheckpointId: string;
}): Record<string, unknown> {
  return {
    schemaVersion: "aletheia-final-memo-v0",
    finalizedAt: new Date().toISOString(),
    sourceDraftMemoId: args.draftMemoId,
    approvalCheckpointId: args.approvalCheckpointId,
    matter: args.detail.matter,
    title:
      typeof args.draftContent.title === "string"
        ? args.draftContent.title.replace("Draft Memo", "Final Memo")
        : `${args.detail.matter.title} Final Memo`,
    disclaimer:
      "Finalized by explicit human approval. Source evidence, review notes, and audit events remain attached for verification.",
    sections: recordArray(args.draftContent.sections),
    sourceEvidenceIds: args.detail.evidence.map((item) => item.id),
    reviewCount: args.detail.reviews.length,
    auditEventCount: args.detail.auditEvents.length,
  };
}

export function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function recordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === "object" && !Array.isArray(item),
      )
    : [];
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export type IssueMapIssue = {
  id: string;
  title: string;
  claimId: string;
  reviewStatus: string;
  supportSummary: {
    supports: number;
    contradicts: number;
    insufficient: number;
  };
  sourceDocuments: string[];
  representativeQuotes: Array<{
    evidenceId: string;
    documentName: string | null;
    page: number | null;
    quote: string;
    supportStatus: string;
  }>;
  openQuestions: string[];
};

export function issueMapIssues(
  content: Record<string, unknown>,
): IssueMapIssue[] {
  return recordArray(content.issues).map((issue, index) => {
    const supportSummary =
      issue.supportSummary &&
      typeof issue.supportSummary === "object" &&
      !Array.isArray(issue.supportSummary)
        ? (issue.supportSummary as Record<string, unknown>)
        : {};
    return {
      id: typeof issue.id === "string" ? issue.id : `issue-${index}`,
      title: typeof issue.title === "string" ? issue.title : "Issue",
      claimId:
        typeof issue.claimId === "string"
          ? issue.claimId
          : typeof issue.id === "string"
            ? issue.id
            : "unassigned",
      reviewStatus:
        typeof issue.reviewStatus === "string"
          ? issue.reviewStatus
          : "unreviewed",
      supportSummary: {
        supports: numberValue(supportSummary.supports),
        contradicts: numberValue(supportSummary.contradicts),
        insufficient: numberValue(supportSummary.insufficient),
      },
      sourceDocuments: stringArray(issue.sourceDocuments),
      representativeQuotes: recordArray(issue.representativeQuotes).map(
        (quote, quoteIndex) => ({
          evidenceId:
            typeof quote.evidenceId === "string"
              ? quote.evidenceId
              : `quote-${quoteIndex}`,
          documentName:
            typeof quote.documentName === "string" ? quote.documentName : null,
          page:
            typeof quote.page === "number" && Number.isFinite(quote.page)
              ? quote.page
              : null,
          quote: typeof quote.quote === "string" ? quote.quote : "",
          supportStatus:
            typeof quote.supportStatus === "string"
              ? quote.supportStatus
              : "unreviewed",
        }),
      ),
      openQuestions: stringArray(issue.openQuestions),
    };
  });
}

export function draftMemoSections(content: Record<string, unknown>) {
  return recordArray(content.sections).map((section, index) => ({
    id: typeof section.id === "string" ? section.id : `memo-section-${index}`,
    title: typeof section.title === "string" ? section.title : "Memo Section",
    body: stringArray(section.body),
    reviewStatus:
      typeof section.reviewStatus === "string"
        ? section.reviewStatus
        : "unreviewed",
  }));
}
