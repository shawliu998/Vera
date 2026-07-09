# AgentOps Persistence Semantics Plan

Last updated: 2026-07-09

Purpose: define the next integration boundary after the matter-scoped AgentOps Command Center became browser-validated. The route can render adapter-backed state, but durable professional state must still come from Aletheia persistence, review, gate, audit, and eval records.

## Current Accepted Boundary

Accepted for local-first browser rendering:

```text
AletheiaMatterDetail + run trace records
-> AgentOps adapter
-> Command Center / Big @ Context / Typed Handoff / Gate Engine / Eval helpers
```

Not accepted as a persistence boundary:

```text
AgentOpsMatterWorkspace
-> source-of-truth persisted professional state
```

`AgentOpsMatterWorkspace` remains a frontend view/handoff model unless a coordinated backend repository, migration, API, export, audit, and test update explicitly changes that contract.

## Required Persistence Semantics

| Surface | Durable source of truth | May render from adapter now | Must not claim until persisted/audited |
| --- | --- | --- | --- |
| Gate decisions | Human checkpoints, review items, work product status, audit events, approval policy checks | Gate checklist, failed/warning/pass summaries | Final export authorization from UI-only booleans or view-only `GateResult` objects |
| Big @ references | Matter-scoped documents, source chunks, evidence items, work products, reviews, audit events, run traces | Resolved/unresolved reference previews | Silent attachment of ambiguous or missing evidence to professional outputs |
| Typed handoff records | Existing work products, evidence, review items, checkpoints, audit events, feedback exports | Cross-artifact link validation and handoff previews | New final/audit/eval artifacts without persisted provenance and gate state |
| Eval snapshots | Review tags, feedback export records, gate outcomes, evidence IDs, claim IDs, audit events | Eval metrics and candidate skill suggestions | Quality claims or skill promotion without review/gate/audit linkage |
| Professional skills | Human-approved Matter Playbooks or approved playbook proposals | Candidate skills and approved playbook display | Autonomous global skills, memory, or playbook mutation |
| Audit pack additions | Audit events, work products, registry snapshots, run/tool/checkpoint records | Export package preview/integrity helpers | Audit pack claims that omit approval, source, review, or run-trace IDs |

## First Safe Handoff Order

1. `trust-gates`: map displayed `GateResult` rows back to persisted checkpoint, review, work product, and audit records. The first acceptable output is a read-only provenance map, not a new migration. Details live in `.agentops/TRUST_GATES_PERSISTENCE_HANDOFF.md`.
2. `big-at-context`: record unresolved and ambiguous reference outcomes as explicit view/audit candidates; do not auto-resolve missing evidence. Details live in `.agentops/BIG_AT_REFERENCE_SEMANTICS_HANDOFF.md`.
3. `typed-artifact-handoff`: verify each handoff artifact can point to source work product IDs, evidence IDs, review IDs, checkpoint IDs, and audit event IDs. The first acceptable output is a read-only typed handoff provenance map, not a new persisted artifact store. Details live in `.agentops/TYPED_HANDOFF_PROVENANCE_HANDOFF.md`.
4. `eval-retrieval`: define the persisted eval snapshot shape using feedback exports and review tags before adding new metrics. The first acceptable output is a read-only eval snapshot provenance map with source review, gate, evidence, audit, feedback export, and run IDs. Details live in `.agentops/EVAL_SNAPSHOT_PERSISTENCE_HANDOFF.md`.
5. `audit-eval-export`: keep export packages behind existing high-risk approval gates and include persistence provenance for every AgentOps-derived section. The first acceptable output is a read-only export provenance map tying package hashes, generated run audit events, gate provenance, Big @ reference audit candidates, typed handoff provenance, and eval snapshot provenance back to persisted Aletheia records. Details live in `.agentops/AUDIT_EXPORT_PROVENANCE_HANDOFF.md`.

## Stop Conditions

Pause and record a conflict if any agent:

- adds backend migrations for AgentOps-native state before mapping to existing Aletheia records;
- treats `/aletheia/agentops` fixture data as product truth;
- approves final exports from UI-only state;
- drops `document_id`, `source_chunk_id`, quote offsets, support status, review tag IDs, checkpoint IDs, audit event IDs, or run IDs;
- promotes candidate skills without human-approved Matter Playbooks;
- broadens README/demo claims beyond local-first MVP/private pilot evidence.

## Required Validation

For any persistence-semantics handoff:

```bash
cd backend && npm run check:aletheia:source-provenance
cd backend && npm run check:aletheia:approval-policy
cd backend && npm run check:aletheia:audit-workbench
cd backend && npm run check:aletheia:run-trace
cd frontend && npm run lint
cd frontend && npx tsc --noEmit
node .agentops/scripts/check-agentops.mjs
```

If the change affects visible Command Center, Review Studio, GateChecklist, ReferencePreview, or Eval Workbench behavior, also run:

```bash
cd frontend && npm run test:aletheia:ui
```
