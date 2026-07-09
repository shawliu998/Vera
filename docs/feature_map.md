# Feature Map

Current stage: **local-first MVP / private pilot candidate**. This repository
shows a professional prototype and validation posture; it should not be
overclaimed as production-ready legal advice software.

## Aletheia Core

Purpose: matter-centered professional workspace.

Key surfaces:

- Matter Queue and matter profile.
- Document Registry for uploaded or sample source documents.
- Matter Command Center for plan, documents, evidence, issues, work products,
  review, gates, audit, and feedback.
- Workflow templates for Legal Matter Review, Compliance Impact Review, and
  Deal Due Diligence Memo.
- Local-first repository path with SQLite, filesystem documents, local exports,
  deterministic fallback data, and private pilot defaults.

Representative artifacts:

- `agent_plan`
- `chronology`
- `issue_map`
- `evidence_matrix`
- `draft_memo`
- `compliance_register`
- `red_flag_memo`
- `final_memo`

Status: MVP path exists for local demos and private pilot evaluation. Supabase
document upload/search remains a documented boundary.

## Aletheia AgentOps

Purpose: make professional agent runs inspectable.

Key surfaces:

- Agent run traces with steps, specialist role labels, budgets, tool calls, and
  human checkpoints.
- Workflow Graph metadata for run progression.
- Agent Command Center concept connected to matters, evidence, gates, and audit
  events.
- Narrow Tool Adapter for approved external-agent access.

Agent roles demonstrated or implied:

- Evidence Agent: maps source chunks into evidence items.
- Issue/Risk Agent: creates Issue Map and Red Flag Register.
- Memo Agent: drafts structured professional work products.
- Review Agent: identifies unsupported claims, missing facts, contradictions,
  and overclaims.
- Gate Engine: blocks high-risk exports until required checks pass.

Status: runtime skeleton, run trace UI, Tool Adapter policy, and audits exist.
The next safe direction is adapter-driven UI integration rather than a second
persisted AgentOps model.

## Aletheia Trust Layer

Purpose: enforce professional boundaries for high-risk work.

Key capabilities:

- Source-linked evidence with document IDs, source chunk IDs, quotes, offsets,
  support status, and provenance.
- Human review tags for unsupported claims, missing facts, overclaims, accepted
  analysis, and related review states.
- Approval gates for high-risk exports.
- Matter isolation for retrieval, memory, playbooks, and local indexes.
- Audit Workbench with reviewable events, registry snapshots, and JSON exports.
- Least-privilege Tool Adapter policy that avoids browser, terminal, email,
  broad web, and destructive operations by default.

Status: local-first trust checks and audit scripts exist. Production deployment
would still require deeper security, compliance, and operational review.

## Aletheia Eval Lab

Purpose: turn expert review into measurable improvement.

Key capabilities:

- Feedback Eval Dataset export from review tags and work-product targets.
- Retrieval eval for keyword, optional semantic, and hybrid retrieval behavior.
- Completion and source-provenance audits for regression protection.
- Playbook Improvement Proposals generated from review feedback without
  mutating approved playbooks automatically.

Status: eval-oriented exports and validation scripts exist for the local MVP.
Future work should deepen benchmark coverage, adversarial cases, and
domain-specific evaluation sets.

## Reviewer Takeaway

Aletheia demonstrates a product thesis for professional agents:

```text
Documents + Agent Runs
-> Evidence
-> Issues/Risks
-> Draft Work Products
-> Expert Review
-> Approval Gates
-> Audit Pack
-> Eval Cases
```

The meaningful innovation is not "AI answers legal questions." The meaningful
innovation is a governed workspace where high-risk professional outputs are
evidence-bound, human-approved, audit-ready, and eval-driven.
