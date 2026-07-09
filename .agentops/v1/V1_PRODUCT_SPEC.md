# Aletheia V1 Product Spec

Updated: 2026-07-09

## Positioning

Aletheia V1 is a local-first professional AgentOps + Evidence Workspace for high-stakes legal, compliance, audit, due diligence, and regulatory review.

It is not a legal chatbot and does not replace expert judgment. It helps professionals create evidence-bound, human-reviewed, gate-controlled, audit-ready, and eval-driven work products.

## V0 to V1 Goal

V0 proved the core loop:

```text
Evidence -> Risk -> Memo -> Review -> Gate -> Audit -> Eval
```

V1 must make that loop private-pilot usable with real documents, controlled model use, richer expert review, professional exports, replayable evals, backup/restore, privacy checks, and accurate deployment/demo docs.

## Primary Use Case

Private Due Diligence / Contract Red Flag Review Workspace:

1. Create a matter.
2. Import 20-100 documents.
3. Parse, index, search, and cite source text.
4. Extract evidence, issues, obligations, and risks.
5. Draft red flag memo.
6. Expert reviews evidence, risks, and memo sections.
7. Gate Engine blocks unsafe final export.
8. Export memo, risk register, evidence matrix, audit pack, and eval dataset.
9. Expert feedback becomes eval cases and candidate skills.

## Personas

- Legal reviewer handling contract review or due diligence.
- Compliance reviewer handling regulatory or policy evidence.
- Audit reviewer checking workpapers and control evidence.
- Pilot admin operating a private local or single-tenant deployment.

## Module Map

- Architecture / Contracts
- Document Ingestion + Retrieval
- LLM Runtime + Agent Scheduler
- Review Studio
- Gate Engine 2.0
- Export + Audit Pack
- Eval Lab + Skills Governance
- Deployment + Docs + Demo

## Safety Boundaries

- No autonomous final legal/compliance advice.
- High-risk final exports require human approval and passing gates.
- External model calls are off by default for sensitive/private data.
- External calls must be configurable, logged, and auditable.
- Missing evidence, missing materials, conflicts, and scope uncertainty must be visible.

## Non-Goals for V1

- Multi-tenant SaaS operations.
- Marketplace templates.
- Full production OCR pipeline unless explicitly configured.
- Guaranteed legal correctness.
- Fully autonomous skill self-modification.
