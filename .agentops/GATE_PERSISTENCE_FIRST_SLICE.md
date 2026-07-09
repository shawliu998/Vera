# Gate Persistence First Slice

Last updated: 2026-07-09

Purpose: define the first backend/audit persistence slice for Gate Engine without inventing a parallel AgentOps storage model. This is a handoff contract, not an implementation in this supervisor cycle.

## Preferred First Shape

Use existing Aletheia audit and approval surfaces before adding a new table:

```text
GateResult[] + GatePersistenceProvenance[]
-> aletheia_audit_events.details
-> approval checkpoint requested_payload / decided_payload
-> final memo work product content
-> audit-integrity verification
```

The first slice should prove whether existing `aletheia_audit_events`, `aletheia_human_checkpoints`, and `aletheia_work_products` can carry durable gate evidence with local/Supabase parity. Add a migration-backed gate snapshot table only if this shape cannot preserve the required source IDs or integrity checks.

## Canonical Audit Actions

Proposed backend-owned action names:

- `gate_snapshot_recorded`: persisted gate results and provenance before a high-risk approval request.
- `final_export_gate_checked`: final export gate evaluation immediately before final memo export.
- `final_export_gate_blocked`: attempted final export blocked by one or more critical failed gates.

These are proposed names for backend/audit owner review. They should not be treated as final until implemented in repository/API validation and audit-integrity checks.

## Required Payload Fields

Each persisted gate event should preserve:

- `matterId`
- `workProductId`
- `approvalCheckpointId` when available
- `gateResults`
- `gateProvenance`
- `criticalGateStatus`: `"passed" | "failed" | "blocked"`
- `failedCriticalGateIds`
- `unresolvedSourceRequirements`
- `sourceRecordRefs`
- `computedAt`
- `computedBy`: `"system" | "agent" | "human"`
- `workflowVersion`

The `gateResults` and `gateProvenance` payloads must preserve:

- gate ID, gate type, status, reason, severity, affected artifact IDs;
- source record type, source record ID, source role;
- related checkpoint IDs, review IDs, work product IDs, audit event IDs, document IDs, evidence item IDs, and source chunk IDs when available;
- unresolved requirements for missing persisted sources.

## Required Repository Behavior

Local and Supabase repositories should either both support the slice or fail closed with explicit unsupported behavior.

Minimum behavior:

- final memo export cannot rely on UI-only `humanApproved`, component state, or fixture-derived `GateResult` objects;
- approval request payload may include gate results, but final export authorization must resolve to an approved checkpoint and persisted passing gate evidence;
- blocked final export attempts should be auditable with the critical gate IDs and unresolved requirements that caused the block;
- final memo work product content may include gate summary/provenance for reviewer inspection, but audit events remain the durable authorization evidence.

## Required Integrity Checks

Extend audit integrity so populated local workflows prove:

- high-risk final memo exports resolve to approved `final_memo_export` checkpoints;
- final memo exports also resolve to a persisted passing `final_export_gate_checked` or equivalent gate snapshot;
- blocked final export attempts have a `final_export_gate_blocked` or equivalent audit event;
- persisted gate source refs resolve to existing matter-scoped records or appear in unresolved source requirements;
- package/export previews are not counted as approved exports unless the approval and gate evidence exists.

## Acceptance Boundary

Accepted after implementation:

```text
approved checkpoint + persisted passing gate evidence
-> final memo export authorization
```

Not accepted:

```text
frontend GateResult[] only
-> final memo export authorization
```

This first slice should keep the product invariant intact:

```text
Evidence -> Issue/Risk -> Draft -> Review -> Gate -> Audit -> Eval
```

## Suggested Validation

```bash
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
