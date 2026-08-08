import type { AgentRequiredInputResponse } from "@/app/types/agent";

export const SOURCE_BOUND_CORRECTION_REASONS = [
    {
        code: "citation_not_exact",
        label: "Citation does not match the exact source",
    },
    {
        code: "source_conflict",
        label: "Source record conflicts with this finding",
    },
    {
        code: "material_omission",
        label: "Finding omits a material source fact",
    },
] as const;

export type SourceBoundCorrectionReasonCode =
    (typeof SOURCE_BOUND_CORRECTION_REASONS)[number]["code"];

export const DEFAULT_SOURCE_BOUND_CORRECTION_REASON: SourceBoundCorrectionReasonCode =
    "citation_not_exact";

/**
 * A correction is an explicit, recoverable choice while the Task is waiting
 * for this lawyer review. Completed dispositions remain terminal unless a
 * later Task creates a new Review version.
 */
export function canRequestSourceBoundCorrection(input: {
    taskWaitingForReview: boolean;
    cellStatus: "pending" | "generating" | "done" | "error";
    reviewStatus?: "verified" | "unresolved" | "needs_correction" | null;
    reviewRevision?: number;
}) {
    return (
        input.taskWaitingForReview &&
        (input.cellStatus === "pending" || input.cellStatus === "done") &&
        input.reviewRevision !== undefined &&
        input.reviewStatus !== "verified" &&
        input.reviewStatus !== "unresolved"
    );
}

export function sourceBoundCorrectionRequestBody(input: {
    expectedReviewRevision: number;
    reasonCode: SourceBoundCorrectionReasonCode;
}) {
    return {
        expected_review_revision: input.expectedReviewRevision,
        reason_code: input.reasonCode,
    };
}

type LitigationEvidenceContext = {
    procedural_stage: "first_instance";
    represented_side:
        | "claimant_plaintiff"
        | "defendant_respondent"
        | "appellant"
        | "appellee"
        | "applicant"
        | "respondent";
};

export function litigationEvidenceStageLabel(
    context: LitigationEvidenceContext | null,
) {
    return context?.procedural_stage === "first_instance"
        ? "First instance"
        : "Litigation";
}

export function litigationEvidenceSideLabel(
    context: LitigationEvidenceContext | null,
) {
    const side = context?.represented_side;
    if (side === "claimant_plaintiff") return "Claimant / plaintiff";
    if (side === "defendant_respondent") return "Defendant / respondent";
    if (side === "appellant") return "Appellant";
    if (side === "appellee") return "Appellee";
    if (side === "applicant") return "Applicant";
    if (side === "respondent") return "Respondent";
    return "Represented side not recorded";
}

export function evidenceInventoryReviewCompleteResponse(): AgentRequiredInputResponse[] {
    return [
        {
            id: "evidence-inventory-reviewed",
            kind: "choice",
            answer: "review_complete",
        },
    ];
}
