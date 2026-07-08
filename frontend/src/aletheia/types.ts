export type AletheiaTemplate =
    | "legal_matter_review"
    | "compliance_impact_review"
    | "deal_due_diligence";

export type RiskLevel = "low" | "medium" | "high";
export type ConfidenceLevel = "low" | "medium" | "high";

export type Matter = {
    id: string;
    title: string;
    template: AletheiaTemplate;
    status: "draft" | "in_progress" | "needs_review" | "completed";
    createdAt: string;
    updatedAt: string;
    clientOrProject?: string;
    objective: string;
    riskLevel?: RiskLevel;
};

export type MatterDocument = {
    id: string;
    matterId: string;
    name: string;
    type:
        | "contract"
        | "email"
        | "payment_record"
        | "complaint"
        | "regulation"
        | "policy"
        | "financial"
        | "corporate"
        | "other";
    uploadedAt: string;
    parsedStatus: "pending" | "parsed" | "failed";
    summary?: string;
};

export type AgentPlan = {
    matterId: string;
    template: AletheiaTemplate;
    objective: string;
    assumptions: string[];
    requiredDocuments: string[];
    missingMaterials: string[];
    steps: {
        id: string;
        name: string;
        description: string;
        status: "pending" | "running" | "completed" | "needs_review";
        riskLevel?: RiskLevel;
    }[];
};

export type TimelineItem = {
    id: string;
    date: string;
    title: string;
    description: string;
    evidenceIds: string[];
};

export type LegalIssue = {
    id: string;
    title: string;
    category:
        | "contract_validity"
        | "performance"
        | "breach"
        | "damages"
        | "limitation_period"
        | "evidence"
        | "procedure"
        | "other";
    summary: string;
    riskLevel: RiskLevel;
    confidence: ConfidenceLevel;
    evidenceIds: string[];
    missingFacts: string[];
    humanJudgmentRequired: boolean;
};

export type EvidenceItem = {
    id: string;
    claimId: string;
    documentId: string;
    documentName: string;
    page?: number;
    section?: string;
    quote: string;
    relevance: "direct" | "indirect" | "weak";
    supportStatus: "supports" | "contradicts" | "insufficient";
};

export type DraftMemoSection = {
    id: string;
    title: string;
    body: string[];
    evidenceIds?: string[];
    reviewStatus?: "unreviewed" | "accepted" | "needs_revision";
};

export type DraftMemo = {
    id: string;
    matterId: string;
    title: string;
    generatedAt: string;
    sections: DraftMemoSection[];
};

export type ReviewTag =
    | "unsupported_claim"
    | "citation_not_supporting"
    | "missing_fact"
    | "overclaim"
    | "outdated_authority"
    | "conflicting_evidence"
    | "needs_human_judgment"
    | "accepted"
    | "rejected";

export type ReviewItem = {
    id: string;
    matterId: string;
    targetType: "claim" | "evidence" | "memo_section";
    targetId: string;
    tag: ReviewTag;
    comment: string;
    reviewer: string;
    createdAt: string;
};

export type AuditEvent = {
    id: string;
    matterId: string;
    actor: "system" | "agent" | "human";
    action:
        | "matter_created"
        | "document_uploaded"
        | "agent_plan_generated"
        | "evidence_mapped"
        | "memo_generated"
        | "review_added"
        | "memo_updated"
        | "feedback_exported"
        | "audit_pack_exported"
        | "feedback_dataset_exported";
    timestamp: string;
    model?: string;
    workflowVersion?: string;
    details: Record<string, unknown>;
};

export type ComplianceObligation = {
    id: string;
    source: string;
    obligation: string;
    appliesTo: string[];
    businessFunction:
        | "data_collection"
        | "model_training"
        | "user_profiling"
        | "content_generation"
        | "third_party_sharing"
        | "security"
        | "audit"
        | "other";
    currentState?: string;
    gap?: string;
    riskLevel: RiskLevel;
    owner?: string;
    remediation?: string;
};

export type RedFlag = {
    id: string;
    category:
        | "corporate"
        | "contract"
        | "litigation"
        | "ip"
        | "employment"
        | "data_compliance"
        | "financial"
        | "regulatory"
        | "other";
    title: string;
    summary: string;
    severity: RiskLevel;
    dealImpact:
        | "valuation"
        | "closing_condition"
        | "representation_warranty"
        | "indemnity"
        | "further_diligence"
        | "no_material_impact";
    evidenceIds: string[];
    recommendedAction: string;
};

export type TemplateDefinition = {
    id: AletheiaTemplate;
    name: string;
    description: string;
    inputs: string[];
    workflow: string[];
    outputs: string[];
    maturity: "complete_demo" | "mock_workflow";
};

export type MatterWorkspace = {
    matter: Matter;
    documents: MatterDocument[];
    plan: AgentPlan;
    timeline: TimelineItem[];
    issues: LegalIssue[];
    evidence: EvidenceItem[];
    memo: DraftMemo;
    reviews: ReviewItem[];
    auditEvents: AuditEvent[];
};
