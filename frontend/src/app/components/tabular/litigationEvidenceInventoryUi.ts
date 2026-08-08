import type { AgentRequiredInputResponse } from "@/app/types/agent";

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
