import type { AgentPlan, AuditEvent, DraftMemo, EvidenceItem, LegalIssue } from "./types";

type ValidationResult = { ok: true } | { ok: false; errors: string[] };

function hasString(value: unknown, field: string, errors: string[]) {
    if (typeof value !== "string" || value.length === 0) {
        errors.push(`${field} must be a non-empty string`);
    }
}

export function validateAgentPlan(plan: AgentPlan): ValidationResult {
    const errors: string[] = [];
    hasString(plan.matterId, "matterId", errors);
    hasString(plan.objective, "objective", errors);
    if (!Array.isArray(plan.steps) || plan.steps.length === 0) {
        errors.push("steps must contain at least one workflow step");
    }
    return errors.length ? { ok: false, errors } : { ok: true };
}

export function validateIssueMap(issues: LegalIssue[]): ValidationResult {
    const errors: string[] = [];
    if (!Array.isArray(issues) || issues.length === 0) {
        errors.push("issue map must contain at least one issue");
    }
    for (const issue of issues) {
        hasString(issue.id, "issue.id", errors);
        hasString(issue.title, "issue.title", errors);
        if (!Array.isArray(issue.evidenceIds)) {
            errors.push(`${issue.id} evidenceIds must be an array`);
        }
    }
    return errors.length ? { ok: false, errors } : { ok: true };
}

export function validateEvidenceMatrix(evidence: EvidenceItem[]): ValidationResult {
    const errors: string[] = [];
    for (const item of evidence) {
        hasString(item.id, "evidence.id", errors);
        hasString(item.claimId, "evidence.claimId", errors);
        hasString(item.quote, "evidence.quote", errors);
    }
    return errors.length ? { ok: false, errors } : { ok: true };
}

export function validateDraftMemo(memo: DraftMemo): ValidationResult {
    const errors: string[] = [];
    hasString(memo.id, "memo.id", errors);
    if (!Array.isArray(memo.sections) || memo.sections.length < 5) {
        errors.push("memo must contain structured memo sections");
    }
    return errors.length ? { ok: false, errors } : { ok: true };
}

export function validateAuditEvents(events: AuditEvent[]): ValidationResult {
    const errors: string[] = [];
    for (const event of events) {
        hasString(event.id, "audit.id", errors);
        hasString(event.action, "audit.action", errors);
        hasString(event.timestamp, "audit.timestamp", errors);
    }
    return errors.length ? { ok: false, errors } : { ok: true };
}
