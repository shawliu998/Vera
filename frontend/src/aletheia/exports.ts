import {
    validateAgentPlan,
    validateAuditEvents,
    validateDraftMemo,
    validateEvidenceMatrix,
    validateIssueMap,
} from "./schemas";
import type { AuditEvent, MatterWorkspace, ReviewItem } from "./types";

function toFilenamePart(value: string) {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 80);
}

function getTarget(workspace: MatterWorkspace, review: ReviewItem) {
    if (review.targetType === "claim") {
        const issue = workspace.issues.find((item) => item.id === review.targetId);
        return {
            title: issue?.title ?? review.targetId,
            text: issue?.summary ?? "",
            evidenceIds: issue?.evidenceIds ?? [],
            riskLevel: issue?.riskLevel,
            confidence: issue?.confidence,
        };
    }

    if (review.targetType === "evidence") {
        const evidence = workspace.evidence.find((item) => item.id === review.targetId);
        return {
            title: evidence?.documentName ?? review.targetId,
            text: evidence?.quote ?? "",
            evidenceIds: evidence ? [evidence.id] : [],
            supportStatus: evidence?.supportStatus,
            relevance: evidence?.relevance,
        };
    }

    const section = workspace.memo.sections.find((item) => item.id === review.targetId);
    return {
        title: section?.title ?? review.targetId,
        text: section?.body.join("\n\n") ?? "",
        evidenceIds: section?.evidenceIds ?? [],
        reviewStatus: section?.reviewStatus,
    };
}

export function buildAuditPack(
    workspace: MatterWorkspace,
    reviews: ReviewItem[],
    auditEvents: AuditEvent[],
) {
    return {
        schemaVersion: "aletheia-audit-pack-v0",
        exportedAt: new Date().toISOString(),
        matter: workspace.matter,
        documents: workspace.documents,
        workflow: {
            plan: workspace.plan,
            timeline: workspace.timeline,
            issues: workspace.issues,
            evidence: workspace.evidence,
            memo: workspace.memo,
        },
        reviewLog: reviews,
        auditLog: auditEvents,
        validation: {
            agentPlan: validateAgentPlan(workspace.plan),
            issueMap: validateIssueMap(workspace.issues),
            evidenceMatrix: validateEvidenceMatrix(workspace.evidence),
            draftMemo: validateDraftMemo(workspace.memo),
            auditEvents: validateAuditEvents(auditEvents),
        },
    };
}

export function buildFeedbackEvalDataset(workspace: MatterWorkspace, reviews: ReviewItem[]) {
    return {
        schemaVersion: "aletheia-feedback-eval-v0",
        exportedAt: new Date().toISOString(),
        matterId: workspace.matter.id,
        matterTitle: workspace.matter.title,
        objective: workspace.matter.objective,
        records: reviews.map((review) => {
            const target = getTarget(workspace, review);
            return {
                id: review.id,
                createdAt: review.createdAt,
                reviewer: review.reviewer,
                tag: review.tag,
                comment: review.comment,
                targetType: review.targetType,
                targetId: review.targetId,
                targetTitle: target.title,
                targetText: target.text,
                targetMetadata: {
                    riskLevel: target.riskLevel,
                    confidence: target.confidence,
                    supportStatus: target.supportStatus,
                    relevance: target.relevance,
                    reviewStatus: target.reviewStatus,
                },
                supportingEvidence: target.evidenceIds.map((evidenceId) => {
                    const evidence = workspace.evidence.find((item) => item.id === evidenceId);
                    return {
                        evidenceId,
                        documentName: evidence?.documentName,
                        page: evidence?.page,
                        section: evidence?.section,
                        quote: evidence?.quote,
                        supportStatus: evidence?.supportStatus,
                    };
                }),
            };
        }),
    };
}

export function auditExportEvent(
    workspace: MatterWorkspace,
    action: "audit_pack_exported" | "feedback_dataset_exported",
    details: Record<string, unknown>,
): AuditEvent {
    return {
        id: `audit-export-${action}-${Date.now()}`,
        matterId: workspace.matter.id,
        actor: "human",
        action,
        timestamp: new Date().toISOString(),
        workflowVersion: "aletheia-demo-v0",
        details,
    };
}

export function downloadJson(filenameStem: string, payload: unknown) {
    const filename = `${toFilenamePart(filenameStem) || "aletheia-export"}.json`;
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
        type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
}
