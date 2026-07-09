# Backend Parser Trust Review

Last updated: 2026-07-09

Purpose: record the supervisor read on an unreported backend parser change observed during Cycle 15.

## Observed Change

`backend/src/lib/aletheia/documentParser.ts` is modified without a matching `.agentops/status/<agent>.json`.

Observed diff:

- adds `sensitiveMaterialFlagsForText({ filename, text })`;
- detects text/filename patterns for `privileged`, `confidential`, `personal_data`, `financial`, `health`, and `minor`.

No feature-agent status file currently claims ownership of this backend parser/trust-layer change.

## Supervisor Classification

Directionally aligned with Aletheia Trust Layer: sensitive-material flags can support privilege, confidentiality, privacy, and export gate review.

Current classification: unreported backend trust/parser helper. It is not yet integrated product behavior unless a repository, route, audit, gate, or UI path consumes it and preserves source provenance.

## Integration Risks

- `documentParser.ts` is part of source ingestion and chunking, so changes can affect source provenance, quote offsets, document search, and evidence mapping expectations.
- Sensitive-material flags must remain advisory review/gate signals, not automatic legal conclusions.
- If these flags are persisted later, they should be matter-scoped and auditable.
- If these flags influence export gating, the decision must be backed by persisted review/checkpoint/audit state.
- No status JSON currently records tests, intended consumers, or whether this is a helper-only change.

## Required Follow-Up

Ask the owning feature agent to add a canonical status file, likely:

```text
.agentops/status/backend-parser-trust.json
```

That status should include:

- whether the helper is currently used anywhere;
- whether parser chunk offsets and source provenance are unchanged;
- validation results, at minimum source provenance and operator checks;
- whether any route, repository, gate, audit, or UI integration is planned.

## Suggested Validation

```bash
cd backend && npm run check:aletheia:source-provenance
cd backend && npm run test:aletheia:local
cd backend && npm run check:aletheia:operator
```

Only require broader validation if the helper is wired into persistence, gates, exports, or UI.
