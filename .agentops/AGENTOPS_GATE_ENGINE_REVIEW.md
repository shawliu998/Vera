# AgentOps Gate Engine Review

Last updated: 2026-07-09

Purpose: record the supervisor read on newly observed deterministic Gate Engine work so gates remain a professional trust boundary, not UI-only state.

## Observed Status Report

`gate-engine` reports `working` in legacy status shape. It adds:

- `frontend/src/aletheia/agentops/gates.ts`
- `frontend/src/components/agentops/GateChecklist.tsx`
- `frontend/tests/agentops/gates.test.ts`
- `frontend/tsconfig.json`
- `docs/agentops/gate-engine.md`

Reported tests:

```bash
cd frontend && node --test --experimental-strip-types tests/agentops/gates.test.ts
cd frontend && npx tsc --noEmit
```

The Gate Engine covers citation, human approval, missing material, conflict, jurisdiction/scope, privilege, and export gates.

## Supervisor Classification

The work is directionally aligned with Aletheia Trust Layer. It should remain a deterministic AgentOps helper until adapter-backed records provide persisted evidence, review, checkpoint, audit, and export state:

```text
AletheiaMatterDetail + review/audit/run/export records
-> AgentOps adapter
-> DraftMemo / EvidenceItem / IssueNode / RiskItem / ReviewComment
-> Gate Engine
-> persisted GateResult + audit event
```

## Current Risks

- `frontend/tsconfig.json` now enables `allowImportingTsExtensions`; this is a shared frontend compiler setting and should be treated as a coordinated testing-contract change.
- Gate results are currently computed from AgentOps view artifacts. They must not become the authoritative approval/export record until persisted through existing Aletheia approval, audit, and work-product flows.
- `humanApproved` as an input is acceptable for local helper tests, but product integration must derive approval from persisted review/checkpoint state.
- `GateChecklist` is safe as a display component only when fed by adapter-derived or persisted gate results.
- Status JSON remains legacy shape rather than canonical `.agentops/AGENT_STATUS_SCHEMA.md`.

## Required Before Integration

1. Keep `agentops-adapter` ahead of Gate Engine product wiring.
2. Map Gate Engine inputs from existing Aletheia matter records, evidence items, review items, work products, approval checkpoints, and run traces.
3. Persist final export gate decisions as audit events and/or work-product approval state before enabling final outputs.
4. Preserve source provenance: `document_id`, `source_chunk_id`, quote offsets, support status, review tags, matter ID, checkpoint IDs, and audit event IDs.
5. Add canonical status fields on the next `gate-engine` update.

The first safe post-adapter handoff is specified in `.agentops/TRUST_GATES_PERSISTENCE_HANDOFF.md`: create a read-only map from displayed `GateResult` rows to persisted source records before considering any migration or final export behavior change.

## Suggested Validation

For local helper validation:

```bash
cd frontend && node --test --experimental-strip-types tests/agentops/gates.test.ts
cd frontend && npx tsc --noEmit
```

For product integration:

```bash
cd backend && npm run check:aletheia:source-provenance
cd backend && npm run check:aletheia:approval-policy
cd backend && npm run check:aletheia:audit-workbench
cd backend && npm run check:aletheia:run-trace
cd backend && npm run check:aletheia:operator
```
