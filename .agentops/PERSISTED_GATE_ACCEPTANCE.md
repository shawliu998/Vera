# Persisted Gate Acceptance

Last updated: 2026-07-09

Purpose: record the supervisor acceptance boundary after backend-audit persistence landed first-class gate evidence through audit events.

## Accepted Contract

Backend/audit persistence is accepted for the current local-first gate slice:

```text
approved checkpoint
+ server-persisted passing gate snapshot audit event
+ server-persisted gate authorization audit event
-> final memo export authorization
```

Accepted canonical audit actions:

- `gate_results_persisted`
- `final_export_gate_authorized`
- `final_export_gate_blocked`

Accepted schema:

- `aletheia-gate-snapshot-v0` in canonical `aletheia_audit_events.details`

Accepted persisted IDs in final memo/export evidence:

- `approvalCheckpointId`
- `gateSnapshotAuditEventId`
- `gateAuthorizationAuditEventId`

## Not Accepted

Still not accepted:

- final memo export authorization from frontend-only `GateResult[]`;
- final memo export authorization from component state such as `humanApproved`;
- treating preview export package JSON as an approved export;
- treating gate payloads that lack persisted audit event IDs as durable professional authorization.

## Downstream Handoff

Downstream lanes should now consume persisted gate evidence instead of waiting on Gate Engine:

- Audit/Eval export should include `gateSnapshotAuditEventId` and `gateAuthorizationAuditEventId` when representing final memo readiness.
- Typed Artifact Handoff should treat persisted gate IDs as stronger evidence than read-only preview gate provenance.
- Eval snapshots should preserve the persisted gate snapshot/authorization IDs before learning from final memo outcomes.
- Gate Engine may stay done unless UI surfaces change; future gate changes should rerun full UI smoke.

## Remaining Evidence Boundary

The backend-audit owner reports populated audit-integrity validation with `ALETHEIA_AUDIT_SOURCE_DIR=... npm run check:aletheia:audit-integrity`. Cycle 35 supervisor validation also reran populated audit integrity against `/var/folders/21/lq2y7qwx7nz2czy8zxyyc6480000gn/T/aletheia-local-regression-1783584501904` with `warnings: 0`, including final memo gate snapshot and gate authorization checks.

Before private-pilot/release handoff, run a populated local workflow and audit integrity again from a durable local data directory or record the temporary source directory in the handoff status.

## Suggested Validation

```bash
cd backend && npm run build
cd backend && npm run check:aletheia:approval-policy
cd backend && npm run check:aletheia:audit-integrity
cd backend && npm run check:aletheia:source-provenance
cd backend && npm run check:aletheia:run-trace
cd backend && npm run test:aletheia:local
cd frontend && npm run lint
cd frontend && npx tsc --noEmit
cd frontend && npm run test:aletheia:ui
node .agentops/scripts/check-agentops.mjs
```
