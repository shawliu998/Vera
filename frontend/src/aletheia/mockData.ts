import type {
    ComplianceObligation,
    Matter,
    MatterDocument,
    AletheiaTemplate,
    MatterWorkspace,
    RedFlag,
    TemplateDefinition,
} from "./types";

const now = "2026-07-08T09:00:00.000Z";

export const templates: TemplateDefinition[] = [
    {
        id: "legal_matter_review",
        name: "Legal Matter Review",
        description:
            "Turn pleadings, contracts, letters, payment records, and correspondence into a reviewable legal matter memo.",
        inputs: ["Contracts", "Payment records", "Email chains", "Demand letters"],
        workflow: [
            "Matter intake",
            "Chronology builder",
            "Issue spotting",
            "Evidence matrix",
            "Risk analysis",
            "Draft legal memo",
            "Human review",
            "Audit pack",
        ],
        outputs: [
            "Legal Matter Memo",
            "Issue Map",
            "Evidence Matrix",
            "Missing Materials List",
        ],
        maturity: "complete_demo",
    },
    {
        id: "compliance_impact_review",
        name: "Compliance Impact Review",
        description:
            "Map new regulations or policies to product, data, model, security, and governance obligations.",
        inputs: ["Regulations", "Policies", "Data flow maps", "Control evidence"],
        workflow: [
            "Regulation intake",
            "Obligation extraction",
            "Business mapping",
            "Gap assessment",
            "Risk scoring",
            "Remediation plan",
        ],
        outputs: [
            "Compliance Impact Assessment",
            "Obligation Register",
            "Gap Analysis",
            "Remediation Tracker",
        ],
        maturity: "mock_workflow",
    },
    {
        id: "deal_due_diligence",
        name: "Deal Due Diligence Memo",
        description:
            "Screen VDR materials for red flags, material contracts, missing diligence questions, and evidence-backed deal risks.",
        inputs: ["VDR exports", "Material contracts", "Cap table", "Policies", "Disputes"],
        workflow: [
            "Deal intake",
            "VDR indexing",
            "Red flag screening",
            "Contract matrix",
            "Evidence mapping",
            "Draft DD memo",
        ],
        outputs: [
            "Red Flag Memo",
            "Contract Matrix",
            "Diligence Question List",
            "Evidence Map",
        ],
        maturity: "mock_workflow",
    },
];

export const demoMatter: Matter = {
    id: "matter-demo-legal-001",
    title: "Software Development Agreement Dispute",
    template: "legal_matter_review",
    status: "needs_review",
    createdAt: "2026-07-08T08:15:00.000Z",
    updatedAt: now,
    clientOrProject: "Commercial litigation intake",
    objective:
        "Prepare an evidence-grounded preliminary matter memo for counsel review without stating a final legal conclusion.",
    riskLevel: "high",
};

export const demoDocuments: MatterDocument[] = [
    {
        id: "doc-sda",
        matterId: demoMatter.id,
        name: "Software Development Agreement",
        type: "contract",
        uploadedAt: "2026-07-08T08:17:00.000Z",
        parsedStatus: "parsed",
        summary:
            "Master agreement with delivery milestones, acceptance process, limitation of liability, and liquidated damages clause.",
    },
    {
        id: "doc-payment",
        matterId: demoMatter.id,
        name: "Payment Record",
        type: "payment_record",
        uploadedAt: "2026-07-08T08:19:00.000Z",
        parsedStatus: "parsed",
        summary:
            "Payment ledger showing milestone payments and a disputed final invoice.",
    },
    {
        id: "doc-email",
        matterId: demoMatter.id,
        name: "Email Chain Regarding Delivery Delay",
        type: "email",
        uploadedAt: "2026-07-08T08:20:00.000Z",
        parsedStatus: "parsed",
        summary:
            "Correspondence discussing delayed delivery, partial deployment, and proposed cure steps.",
    },
    {
        id: "doc-demand",
        matterId: demoMatter.id,
        name: "Demand Letter",
        type: "complaint",
        uploadedAt: "2026-07-08T08:22:00.000Z",
        parsedStatus: "parsed",
        summary:
            "Buyer demand letter alleging material breach and requesting liquidated damages.",
    },
];

export const legalWorkspace: MatterWorkspace = {
    matter: demoMatter,
    documents: demoDocuments,
    plan: {
        matterId: demoMatter.id,
        template: "legal_matter_review",
        objective: demoMatter.objective,
        assumptions: [
            "The uploaded contract is the operative executed version.",
            "No later waiver or settlement agreement has been provided.",
            "The memo is for expert review and not a final legal opinion.",
        ],
        requiredDocuments: [
            "Executed agreement and amendments",
            "Payment records",
            "Delay correspondence",
            "Demand or notice letters",
            "Actual loss calculation",
            "Cure or acceptance records",
        ],
        missingMaterials: [
            "Actual loss proof",
            "Formal notice and cure records",
            "Acceptance testing results",
        ],
        steps: [
            {
                id: "step-intake",
                name: "Matter Intake",
                description: "Normalize matter profile, objectives, known parties, and document inventory.",
                status: "completed",
                riskLevel: "medium",
            },
            {
                id: "step-chronology",
                name: "Chronology Builder",
                description: "Extract dated events from agreement, payment record, email chain, and demand letter.",
                status: "completed",
                riskLevel: "medium",
            },
            {
                id: "step-issues",
                name: "Issue Spotting",
                description: "Identify breach, damages, notice, cure, and evidence sufficiency issues.",
                status: "completed",
                riskLevel: "high",
            },
            {
                id: "step-evidence",
                name: "Evidence Matrix",
                description: "Map each claim to supporting, contradicting, or insufficient evidence.",
                status: "completed",
                riskLevel: "high",
            },
            {
                id: "step-memo",
                name: "Draft Legal Memo",
                description: "Draft a structured memo with caveats, missing materials, and review notes.",
                status: "needs_review",
                riskLevel: "high",
            },
        ],
    },
    timeline: [
        {
            id: "tl-1",
            date: "2026-03-01",
            title: "Agreement executed",
            description: "Parties signed the software development agreement with milestone delivery dates.",
            evidenceIds: ["ev-1"],
        },
        {
            id: "tl-2",
            date: "2026-04-15",
            title: "Milestone payment made",
            description: "Buyer paid the second milestone while reserving concerns about delivery timing.",
            evidenceIds: ["ev-3"],
        },
        {
            id: "tl-3",
            date: "2026-05-12",
            title: "Delivery delay raised",
            description: "Email chain records a 12-day delay and vendor proposal for phased delivery.",
            evidenceIds: ["ev-2", "ev-4"],
        },
        {
            id: "tl-4",
            date: "2026-06-03",
            title: "Demand letter sent",
            description: "Buyer asserted material breach and requested liquidated damages.",
            evidenceIds: ["ev-6"],
        },
    ],
    issues: [
        {
            id: "claim-breach",
            title: "Whether the vendor materially breached the delivery obligation",
            category: "breach",
            summary:
                "The contract contains dated delivery milestones and the correspondence supports a delay, but materiality depends on cure, acceptance, and business impact evidence.",
            riskLevel: "high",
            confidence: "medium",
            evidenceIds: ["ev-1", "ev-2", "ev-4"],
            missingFacts: ["Acceptance test status", "Cure period communications", "Operational impact records"],
            humanJudgmentRequired: true,
        },
        {
            id: "claim-liquidated-damages",
            title: "Whether the liquidated damages clause may be reduced",
            category: "damages",
            summary:
                "The clause sets liquidated damages at 30 percent of contract value. Enforceability and reduction risk depend on proportionality and actual loss evidence.",
            riskLevel: "high",
            confidence: "medium",
            evidenceIds: ["ev-5", "ev-7"],
            missingFacts: ["Actual loss calculation", "Negotiation record for damages clause"],
            humanJudgmentRequired: true,
        },
        {
            id: "claim-loss-proof",
            title: "Whether the buyer has sufficient evidence of actual loss",
            category: "evidence",
            summary:
                "The uploaded record shows payments and delay correspondence but does not yet establish the buyer's claimed loss amount.",
            riskLevel: "medium",
            confidence: "high",
            evidenceIds: ["ev-3", "ev-7"],
            missingFacts: ["Loss model", "Replacement vendor cost", "Internal downtime records"],
            humanJudgmentRequired: false,
        },
        {
            id: "claim-notice",
            title: "Whether additional notice or cure evidence is missing",
            category: "procedure",
            summary:
                "The demand letter is available, but earlier formal notice and cure evidence has not been provided.",
            riskLevel: "medium",
            confidence: "medium",
            evidenceIds: ["ev-4", "ev-6"],
            missingFacts: ["Formal notice before demand letter", "Vendor cure response"],
            humanJudgmentRequired: true,
        },
    ],
    evidence: [
        {
            id: "ev-1",
            claimId: "claim-breach",
            documentId: "doc-sda",
            documentName: "Software Development Agreement",
            page: 4,
            section: "Section 3.1 Delivery Milestones",
            quote: "Vendor shall deliver the production-ready release no later than May 1, 2026.",
            relevance: "direct",
            supportStatus: "supports",
        },
        {
            id: "ev-2",
            claimId: "claim-breach",
            documentId: "doc-email",
            documentName: "Email Chain Regarding Delivery Delay",
            page: 2,
            section: "May 12 thread",
            quote: "We acknowledge the production release is 12 days behind the agreed delivery date.",
            relevance: "direct",
            supportStatus: "supports",
        },
        {
            id: "ev-3",
            claimId: "claim-loss-proof",
            documentId: "doc-payment",
            documentName: "Payment Record",
            page: 1,
            section: "Milestone Ledger",
            quote: "Milestone 2 payment received on April 15; final invoice remains disputed.",
            relevance: "indirect",
            supportStatus: "supports",
        },
        {
            id: "ev-4",
            claimId: "claim-notice",
            documentId: "doc-email",
            documentName: "Email Chain Regarding Delivery Delay",
            page: 3,
            section: "Vendor response",
            quote: "We can deploy the reporting module first while completing authentication fixes.",
            relevance: "indirect",
            supportStatus: "contradicts",
        },
        {
            id: "ev-5",
            claimId: "claim-liquidated-damages",
            documentId: "doc-sda",
            documentName: "Software Development Agreement",
            page: 9,
            section: "Section 8.2 Liquidated Damages",
            quote: "Liquidated damages shall equal 30% of total contract value for late delivery.",
            relevance: "direct",
            supportStatus: "supports",
        },
        {
            id: "ev-6",
            claimId: "claim-notice",
            documentId: "doc-demand",
            documentName: "Demand Letter",
            page: 1,
            section: "Demand",
            quote: "Buyer demands immediate payment of liquidated damages for material breach.",
            relevance: "direct",
            supportStatus: "supports",
        },
        {
            id: "ev-7",
            claimId: "claim-liquidated-damages",
            documentId: "doc-demand",
            documentName: "Demand Letter",
            page: 2,
            section: "Loss statement",
            quote: "Buyer reserves the right to supplement evidence of business losses.",
            relevance: "weak",
            supportStatus: "insufficient",
        },
    ],
    memo: {
        id: "memo-legal-001",
        matterId: demoMatter.id,
        title: "Draft Legal Matter Memo",
        generatedAt: now,
        sections: [
            {
                id: "memo-exec",
                title: "1. Executive Summary",
                body: [
                    "The current record supports a delivery delay and a plausible breach theory, but the strength of any damages position depends on missing loss, notice, and cure materials.",
                    "The liquidated damages clause presents elevated reduction risk because the current document set does not yet establish proportionality or actual loss.",
                ],
                evidenceIds: ["ev-1", "ev-2", "ev-5", "ev-7"],
                reviewStatus: "needs_revision",
            },
            {
                id: "memo-facts",
                title: "2. Key Facts",
                body: [
                    "The agreement required production delivery by May 1, 2026. A later email acknowledges a 12-day delay and proposes phased deployment.",
                    "The payment record confirms prior milestone payments but does not prove the buyer's claimed business loss.",
                ],
                evidenceIds: ["ev-1", "ev-2", "ev-3"],
                reviewStatus: "unreviewed",
            },
            {
                id: "memo-timeline",
                title: "3. Timeline",
                body: [
                    "The event sequence is agreement execution, milestone payment, delivery delay correspondence, and demand letter.",
                ],
                evidenceIds: ["ev-1", "ev-2", "ev-3", "ev-6"],
                reviewStatus: "accepted",
            },
            {
                id: "memo-issues",
                title: "4. Issues Presented",
                body: [
                    "The review identifies breach, enforceability of liquidated damages, sufficiency of loss proof, and missing notice or cure evidence.",
                ],
                evidenceIds: ["ev-1", "ev-5", "ev-6"],
                reviewStatus: "unreviewed",
            },
            {
                id: "memo-evidence",
                title: "5. Evidence Assessment",
                body: [
                    "The delivery delay evidence is direct. The loss evidence is currently insufficient. The cure evidence is mixed because the vendor proposed partial deployment.",
                ],
                evidenceIds: ["ev-2", "ev-4", "ev-7"],
                reviewStatus: "needs_revision",
            },
            {
                id: "memo-analysis",
                title: "6. Legal / Risk Analysis",
                body: [
                    "Counsel should treat breach as supportable but not final. Damages should be presented as a risk-weighted position until actual loss and notice materials are supplied.",
                ],
                evidenceIds: ["ev-1", "ev-2", "ev-5", "ev-7"],
                reviewStatus: "needs_revision",
            },
            {
                id: "memo-missing",
                title: "7. Missing Materials",
                body: [
                    "Actual loss proof, formal notice and cure records, acceptance testing records, and internal impact evidence remain missing.",
                ],
                reviewStatus: "unreviewed",
            },
            {
                id: "memo-next",
                title: "8. Recommended Next Steps",
                body: [
                    "Request missing materials, confirm whether any waiver or amendment exists, and have counsel review the damages analysis before external use.",
                ],
                reviewStatus: "unreviewed",
            },
            {
                id: "memo-review",
                title: "9. Human Review Notes",
                body: [
                    "Reviewer should verify citations against source pages and confirm whether the memo overstates damages recoverability.",
                ],
                reviewStatus: "needs_revision",
            },
        ],
    },
    reviews: [
        {
            id: "review-1",
            matterId: demoMatter.id,
            targetType: "claim",
            targetId: "claim-liquidated-damages",
            tag: "needs_human_judgment",
            comment: "Damages position should remain framed as risk analysis until actual loss evidence is added.",
            reviewer: "Senior Reviewer",
            createdAt: "2026-07-08T09:05:00.000Z",
        },
        {
            id: "review-2",
            matterId: demoMatter.id,
            targetType: "evidence",
            targetId: "ev-7",
            tag: "citation_not_supporting",
            comment: "The demand letter reserves proof but does not itself prove actual loss.",
            reviewer: "Senior Reviewer",
            createdAt: "2026-07-08T09:07:00.000Z",
        },
    ],
    auditEvents: [
        {
            id: "audit-1",
            matterId: demoMatter.id,
            actor: "human",
            action: "matter_created",
            timestamp: "2026-07-08T08:15:00.000Z",
            workflowVersion: "aletheia-demo-v0",
            details: { template: "legal_matter_review" },
        },
        {
            id: "audit-2",
            matterId: demoMatter.id,
            actor: "human",
            action: "document_uploaded",
            timestamp: "2026-07-08T08:22:00.000Z",
            details: { count: 4 },
        },
        {
            id: "audit-3",
            matterId: demoMatter.id,
            actor: "agent",
            action: "agent_plan_generated",
            timestamp: "2026-07-08T08:31:00.000Z",
            model: "mock-deterministic",
            workflowVersion: "aletheia-demo-v0",
            details: { steps: 5, missingMaterials: 3 },
        },
        {
            id: "audit-4",
            matterId: demoMatter.id,
            actor: "agent",
            action: "evidence_mapped",
            timestamp: "2026-07-08T08:39:00.000Z",
            model: "mock-deterministic",
            workflowVersion: "aletheia-demo-v0",
            details: { claims: 4, evidenceItems: 7 },
        },
        {
            id: "audit-5",
            matterId: demoMatter.id,
            actor: "agent",
            action: "memo_generated",
            timestamp: "2026-07-08T08:46:00.000Z",
            model: "mock-deterministic",
            workflowVersion: "aletheia-demo-v0",
            details: { sections: 9 },
        },
        {
            id: "audit-6",
            matterId: demoMatter.id,
            actor: "human",
            action: "review_added",
            timestamp: "2026-07-08T09:07:00.000Z",
            details: { tags: ["needs_human_judgment", "citation_not_supporting"] },
        },
    ],
};

export const complianceMatter: Matter = {
    id: "matter-demo-compliance-001",
    title: "AI Product Data Compliance Impact Review",
    template: "compliance_impact_review",
    status: "in_progress",
    createdAt: now,
    updatedAt: now,
    objective:
        "Translate a new AI governance policy into product obligations, gaps, owners, and remediation actions.",
    riskLevel: "high",
};

export const complianceObligations: ComplianceObligation[] = [
    {
        id: "obl-1",
        source: "New AI Governance Policy Section 4",
        obligation: "Maintain audit records for model output review.",
        appliesTo: ["AI assistant", "human review queue"],
        businessFunction: "audit",
        currentState: "Review notes exist but are not exportable as audit packs.",
        gap: "No standardized retention and export workflow.",
        riskLevel: "high",
        owner: "Legal Ops",
        remediation: "Create audit event schema and retention policy.",
    },
    {
        id: "obl-2",
        source: "Privacy Policy",
        obligation: "Provide user-facing notice for personal data processing.",
        appliesTo: ["document upload", "workspace creation"],
        businessFunction: "data_collection",
        currentState: "Notice is general and not workflow-specific.",
        gap: "No matter-level processing notice.",
        riskLevel: "medium",
        owner: "Privacy",
        remediation: "Add matter intake disclosure and consent capture.",
    },
    {
        id: "obl-3",
        source: "Model Training Data SOP",
        obligation: "Establish deletion request propagation across training data pipeline.",
        appliesTo: ["model training", "feedback export"],
        businessFunction: "model_training",
        currentState: "Feedback export is manual.",
        gap: "No deletion propagation evidence.",
        riskLevel: "high",
        owner: "ML Platform",
        remediation: "Attach data lineage metadata to feedback records.",
    },
];

export const dealMatter: Matter = {
    id: "matter-demo-dd-001",
    title: "Series B Investment Legal and Commercial Diligence",
    template: "deal_due_diligence",
    status: "needs_review",
    createdAt: now,
    updatedAt: now,
    objective:
        "Screen VDR materials for red flags, contract risks, open diligence questions, and memo-ready evidence.",
    riskLevel: "high",
};

export const dealRedFlags: RedFlag[] = [
    {
        id: "rf-1",
        category: "contract",
        title: "Change-of-control termination right in key customer contract",
        summary:
            "The largest customer may terminate on a change of control, creating closing and valuation risk.",
        severity: "high",
        dealImpact: "closing_condition",
        evidenceIds: ["dd-ev-1"],
        recommendedAction: "Request revenue concentration analysis and consent plan.",
    },
    {
        id: "rf-2",
        category: "ip",
        title: "Incomplete IP assignment from early contractor",
        summary:
            "One early contractor file does not include an executed IP assignment.",
        severity: "high",
        dealImpact: "representation_warranty",
        evidenceIds: ["dd-ev-2"],
        recommendedAction: "Add closing deliverable for confirmatory IP assignment.",
    },
    {
        id: "rf-3",
        category: "employment",
        title: "Pending employment claim",
        summary:
            "Pending claim may require indemnity or disclosure schedule treatment.",
        severity: "medium",
        dealImpact: "indemnity",
        evidenceIds: ["dd-ev-3"],
        recommendedAction: "Request pleadings, settlement posture, and reserve estimate.",
    },
];

export function templateById(id: AletheiaTemplate) {
    return templates.find((template) => template.id === id) ?? templates[0];
}
