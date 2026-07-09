# Backend Audit Persistence Intake

Last updated: 2026-07-09

Purpose: define the next backend/audit intake after the local-first AgentOps view lanes reached P0. This is not a migration proposal by itself. It is the ordered contract checklist for any backend/audit owner who starts turning view-layer provenance into first-class persisted Aletheia state.

## Current Read

The following lanes are complete for their local-first view/helper scope:

- AgentOps adapter path from `AletheiaMatterDetail` to `AgentOpsMatterWorkspace`;
- Matter/Document/Evidence workspace and evidence registry source displays;
- Big @ reference previews, audit candidates, and read-only autocomplete;
- Typed Artifact Handoff provenance and readiness summaries;
- Audit/Eval export package preview and local JSON inspection download.

The current blocker is first-class persisted gate/audit state:

```text
GateResult[] + GatePersistenceProvenance[]
-> backend/audit owner accepts schema/API/repository contract
-> persisted audit evidence for final export authorization
```

Until that contract exists, final professional authorization must remain tied to existing approval checkpoints, work products, audit events, and fail-closed policy checks. View-layer gate payloads and preview export packages are reviewer evidence only.

## Intake Order

1. Gate persistence
   - Accept or revise `.agentops/TRUST_GATES_PERSISTENCE_HANDOFF.md`.
   - Start with `.agentops/GATE_PERSISTENCE_FIRST_SLICE.md`, which prefers existing audit events, approval checkpoint payloads, and final memo work product content before adding a new table.
   - Decide whether first-class gate state lives as canonical `aletheia_audit_events` actions/details or a migration-backed gate snapshot table.
   - Preserve `GateResult[]`, `GatePersistenceProvenance[]`, critical gate status, source record refs, unresolved source requirements, checkpoint IDs, work product IDs, review IDs, and audit event IDs.

2. Reference persistence
   - Accept or revise `.agentops/BIG_AT_REFERENCE_SEMANTICS_HANDOFF.md`.
   - Persist or expose ambiguous/missing Big @ references as review/audit blockers before they can affect drafts, gates, exports, or evals.
   - Keep `@Clause` mapped to source-grounded evidence/document chunk metadata; do not create a persisted `Clause` artifact type without schema coordination.

3. Typed handoff persistence
   - Accept or revise `.agentops/TYPED_HANDOFF_PROVENANCE_HANDOFF.md`.
   - Map `TypedHandoffProvenance` and `TypedHandoffReadiness` to existing matter, document, evidence, work product, review, checkpoint, audit, run, feedback, and playbook records.
   - Keep readiness summaries read-only until source records and gate provenance are durable.

4. Eval snapshot persistence
   - Accept or revise `.agentops/EVAL_SNAPSHOT_PERSISTENCE_HANDOFF.md`.
   - Preserve review feedback IDs, review tags, gate IDs, evidence IDs, source run IDs, audit event IDs, feedback export IDs, and approved playbook IDs.
   - Candidate skills remain inactive unless `.agentops/PROFESSIONAL_SKILL_PLAYBOOK_APPROVAL_HANDOFF.md` is satisfied.

5. Approved export persistence
   - Accept or revise `.agentops/AUDIT_EXPORT_PROVENANCE_HANDOFF.md` and `.agentops/EXPORT_PACKAGE_VISIBILITY_BOUNDARY.md`.
   - Keep local JSON downloads as preview inspection packages until high-risk export approval, package integrity, gate provenance, and audit export provenance are persisted.
   - Approved audit pack, feedback dataset, and final memo exports must use existing approval-policy actions: `audit_pack_export`, `feedback_dataset_export`, and `final_memo_export`.

## Backend Files Requiring Coordination

Coordinate before editing:

- `backend/src/lib/aletheia/domain.ts`
- `backend/src/lib/aletheia/repository.ts`
- `backend/src/lib/aletheia/localRepository.ts`
- `backend/src/lib/aletheia/supabaseRepository.ts`
- `backend/src/routes/aletheia.ts`
- `backend/src/scripts/aletheiaAuditIntegrity.ts`
- `backend/migrations/20260709_*.sql`
- `frontend/src/app/lib/aletheiaApi.ts`
- `frontend/src/aletheia/types.ts`
- `frontend/src/aletheia/remoteMatterTransforms.ts`
- `frontend/src/aletheia/agentops/`

## Acceptance Criteria

A backend/audit persistence slice is acceptable only when:

- local and Supabase repositories have parity or fail closed with explicit unsupported behavior;
- validation has been run against a populated local matter workflow, not only an empty local data directory;
- route validation rejects UI-only or fixture-derived authorization for high-risk final exports;
- audit integrity proves final exports resolve to approved checkpoints and persisted passing gate snapshots;
- source record IDs remain traceable through Evidence -> Issue/Risk -> Draft -> Review -> Gate -> Audit -> Eval;
- preview downloads remain distinguishable from approved exports;
- validation commands and any migration boundaries are recorded in the responsible agent status JSON.

## Suggested Validation

```bash
cd backend && npm run check:aletheia:operator
cd backend && npm run check:aletheia:source-provenance
cd backend && npm run check:aletheia:approval-policy
cd backend && npm run check:aletheia:audit-workbench
cd backend && npm run check:aletheia:audit-integrity
cd backend && npm run check:aletheia:run-trace
cd frontend && npm run lint
cd frontend && npx tsc --noEmit
cd frontend && npm run test:aletheia:ui
node .agentops/scripts/check-agentops.mjs
```
