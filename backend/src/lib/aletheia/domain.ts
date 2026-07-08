export const TEMPLATES = new Set([
  "legal_matter_review",
  "compliance_impact_review",
  "deal_due_diligence",
]);

export const MATTER_STATUSES = new Set([
  "draft",
  "in_progress",
  "needs_review",
  "completed",
  "archived",
]);

export const RISK_LEVELS = new Set(["low", "medium", "high"]);

export const REVIEW_TARGET_TYPES = new Set([
  "claim",
  "evidence",
  "memo_section",
  "work_product",
  "matter",
]);

export const REVIEW_TAGS = new Set([
  "unsupported_claim",
  "citation_not_supporting",
  "missing_fact",
  "overclaim",
  "outdated_authority",
  "conflicting_evidence",
  "needs_human_judgment",
  "accepted",
  "rejected",
]);

export const WORK_PRODUCT_KINDS = new Set([
  "agent_plan",
  "chronology",
  "issue_map",
  "evidence_matrix",
  "draft_memo",
  "compliance_register",
  "red_flag_memo",
  "audit_pack",
  "feedback_export",
]);

export const WORK_PRODUCT_STATUSES = new Set([
  "draft",
  "generated",
  "needs_review",
  "accepted",
  "superseded",
]);

export const GENERATED_BY = new Set(["system", "agent", "human"]);
export const ACTORS = new Set(["system", "agent", "human"]);

export type Actor = "system" | "agent" | "human";

export function text(value: unknown, max = 400) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, max);
}

export function nullableText(value: unknown, max = 400) {
  const cleaned = text(value, max);
  return cleaned || null;
}

export function objectPayload(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

export function arrayPayload(value: unknown) {
  return Array.isArray(value) ? value : [];
}

export function cleanSharedEmails(value: unknown, ownerEmail?: string) {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const emails: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") continue;
    const email = raw.trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    if (ownerEmail && email === ownerEmail) continue;
    seen.add(email);
    emails.push(email);
  }
  return emails;
}

export function auditActionForWorkProduct(kind: string) {
  if (kind === "audit_pack") return "audit_pack_exported";
  if (kind === "feedback_export") return "feedback_dataset_exported";
  return "work_product_saved";
}

export function buildInitialAgentPlan(args: {
  matterId: string;
  template: string;
  objective: string;
  riskLevel: string | null;
}) {
  const shared = {
    matterId: args.matterId,
    template: args.template,
    objective: args.objective,
    riskLevel: args.riskLevel,
    assumptions: [
      "Inputs are incomplete until source documents are uploaded and parsed.",
      "The agent must expose missing materials before drafting conclusions.",
      "Human review is required before any professional work product is relied on.",
    ],
  };

  if (args.template === "compliance_impact_review") {
    return {
      ...shared,
      requiredDocuments: [
        "Regulation or policy source text",
        "Current controls and policies",
        "Business process map",
        "Data flow or system inventory",
        "Prior audit findings",
      ],
      missingMaterials: [
        "Authoritative regulatory source",
        "Control evidence",
        "Named business owners",
      ],
      steps: [
        "Regulation intake",
        "Obligation extraction",
        "Business mapping",
        "Gap assessment",
        "Risk scoring",
        "Remediation planning",
        "Human approval",
      ],
    };
  }

  if (args.template === "deal_due_diligence") {
    return {
      ...shared,
      requiredDocuments: [
        "VDR index",
        "Material contracts",
        "Cap table",
        "Litigation and dispute schedule",
        "Employment and IP materials",
      ],
      missingMaterials: [
        "Complete VDR export",
        "Disclosure schedules",
        "Management Q&A log",
      ],
      steps: [
        "Deal intake",
        "VDR indexing",
        "Red flag screening",
        "Contract matrix",
        "Evidence mapping",
        "Draft diligence memo",
        "Human review",
      ],
    };
  }

  return {
    ...shared,
    requiredDocuments: [
      "Operative agreements and amendments",
      "Correspondence",
      "Payment or performance records",
      "Demand or notice letters",
      "Procedural documents",
    ],
    missingMaterials: [
      "Executed source documents",
      "Known factual chronology",
      "Jurisdiction and governing-law assumptions",
    ],
    steps: [
      "Matter intake",
      "Chronology builder",
      "Issue spotting",
      "Evidence matrix",
      "Risk analysis",
      "Draft memo",
      "Human review",
    ],
  };
}
