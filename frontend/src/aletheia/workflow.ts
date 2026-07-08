import { complianceMatter, dealMatter, legalWorkspace, templates } from "./mockData";
import type { AuditEvent, Matter, ReviewItem, ReviewTag } from "./types";
import {
    validateAgentPlan,
    validateAuditEvents,
    validateDraftMemo,
    validateEvidenceMatrix,
    validateIssueMap,
} from "./schemas";

export function getDemoWorkspace() {
    return legalWorkspace;
}

export function getMatterSummaries() {
    const demoMatters: Matter[] = [
        legalWorkspace.matter,
        complianceMatter,
        dealMatter,
    ];

    return demoMatters.map((matter) => {
        const isLegal = matter.id === legalWorkspace.matter.id;
        const template = templates.find((item) => item.id === matter.template);
        return {
            ...matter,
            templateName: template?.name ?? matter.template,
            documentCount: isLegal ? legalWorkspace.documents.length : matter.template === "deal_due_diligence" ? 18 : 7,
            evidenceCount: isLegal ? legalWorkspace.evidence.length : matter.template === "deal_due_diligence" ? 24 : 13,
            reviewCount: isLegal ? legalWorkspace.reviews.length : matter.template === "deal_due_diligence" ? 5 : 3,
            auditEventCount: isLegal ? legalWorkspace.auditEvents.length : 4,
        };
    });
}

export function getEvidenceQueue() {
    return legalWorkspace.evidence.map((item) => {
        const issue = legalWorkspace.issues.find((candidate) => candidate.id === item.claimId);
        return {
            ...item,
            issueTitle: issue?.title ?? item.claimId,
            matterTitle: legalWorkspace.matter.title,
            riskLevel: issue?.riskLevel ?? "medium",
        };
    });
}

export function getReviewQueue() {
    const issueReviews = legalWorkspace.issues
        .filter((issue) => issue.humanJudgmentRequired)
        .map((issue) => ({
            id: `queue-${issue.id}`,
            matterId: legalWorkspace.matter.id,
            matterTitle: legalWorkspace.matter.title,
            targetType: "claim",
            targetId: issue.id,
            title: issue.title,
            tag: "needs_human_judgment" as ReviewTag,
            comment: issue.missingFacts.join(", "),
            reviewer: "Unassigned",
            createdAt: legalWorkspace.matter.updatedAt,
            riskLevel: issue.riskLevel,
            status: "queued",
        }));

    const reviewItems = legalWorkspace.reviews.map((review) => ({
        ...review,
        matterTitle: legalWorkspace.matter.title,
        title: review.targetId,
        riskLevel: "high" as const,
        status: "recorded",
    }));

    return [...issueReviews, ...reviewItems];
}

export function getAuditQueue() {
    return legalWorkspace.auditEvents.map((event) => ({
        ...event,
        matterTitle: legalWorkspace.matter.title,
    }));
}

export function getWorkProductSummaries() {
    return [
        {
            id: legalWorkspace.plan.matterId,
            matterTitle: legalWorkspace.matter.title,
            kind: "Agent Plan",
            title: "Plan before Answer",
            status: "generated",
            count: legalWorkspace.plan.steps.length,
        },
        {
            id: "issue-map",
            matterTitle: legalWorkspace.matter.title,
            kind: "Issue Map",
            title: "Risk-weighted legal issue map",
            status: "generated",
            count: legalWorkspace.issues.length,
        },
        {
            id: "evidence-matrix",
            matterTitle: legalWorkspace.matter.title,
            kind: "Evidence Matrix",
            title: "Claim-linked evidence matrix",
            status: "generated",
            count: legalWorkspace.evidence.length,
        },
        {
            id: legalWorkspace.memo.id,
            matterTitle: legalWorkspace.matter.title,
            kind: "Draft Memo",
            title: legalWorkspace.memo.title,
            status: "needs_review",
            count: legalWorkspace.memo.sections.length,
        },
    ];
}

export function getFeedbackSummary(reviews: ReviewItem[]) {
    const counts = reviews.reduce(
        (acc, review) => {
            acc[review.tag] = (acc[review.tag] ?? 0) + 1;
            return acc;
        },
        {} as Partial<Record<ReviewTag, number>>,
    );
    return {
        total: reviews.length,
        highValueBadcases: reviews.filter((review) =>
            [
                "unsupported_claim",
                "citation_not_supporting",
                "missing_fact",
                "overclaim",
                "conflicting_evidence",
            ].includes(review.tag),
        ),
        counts,
    };
}

export function createReviewAuditEvent(review: ReviewItem): AuditEvent {
    return {
        id: `audit-review-${review.id}`,
        matterId: review.matterId,
        actor: "human",
        action: "review_added",
        timestamp: review.createdAt,
        workflowVersion: "aletheia-demo-v0",
        details: {
            targetType: review.targetType,
            targetId: review.targetId,
            tag: review.tag,
        },
    };
}

export function validateWorkspace() {
    const workspace = getDemoWorkspace();
    return [
        validateAgentPlan(workspace.plan),
        validateIssueMap(workspace.issues),
        validateEvidenceMatrix(workspace.evidence),
        validateDraftMemo(workspace.memo),
        validateAuditEvents(workspace.auditEvents),
    ];
}
