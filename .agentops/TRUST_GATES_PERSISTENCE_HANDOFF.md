# Trust Gates Persistence Handoff

Last updated: 2026-07-09

Purpose: define the first persistence-semantics handoff after the adapter-backed Command Center route became browser-validated. This is a coordination contract for the `trust-gates` / `gate-engine` owner, not an implementation mandate.

## Current State

The UI can render gate information from adapter-derived `GateResult[]`.

Current helper path:

```text
AletheiaMatterDetail
-> adaptAletheiaMatterDetailToAgentOpsWorkspace(...)
-> AgentOpsMatterWorkspace.gate_results
-> GateChecklist / Command Center display
```

This is acceptable for read-only display. It is not enough for final export authorization, audit pack claims, or professional reliance.

## Required Source Mapping

Every displayed high-risk gate should be explainable through existing persisted Aletheia records:

| Displayed gate concept | Required persisted source | Required IDs to preserve |
| --- | --- | --- |
| `citation` | Evidence items, draft/final work product content, validation errors | `work_product_id`, `evidence_item_id`, `document_id`, `source_chunk_id`, `quote_start`, `quote_end`, `claim_id` |
| `human_approval` | Human checkpoints and review items; existing export approval policy | `checkpoint_id`, `review_id`, `work_product_id`, `audit_event_id` |
| `missing_material` | Open questions, missing-material memory, pending/failed documents, review tags | `matter_memory_id`, `document_id`, `review_id`, `issue_id` |
| `conflict` | Contradictory/insufficient evidence, review tags, issue/risk records | `evidence_item_id`, `review_id`, `claim_id`, `risk_id` |
| `jurisdiction` / scope | Matter template/profile, work product checklist, review comments | `matter_id`, `work_product_id`, `review_id` |
| `privilege` / sensitivity | Sensitive-material flags, document/evidence metadata, review comments | `document_id`, `evidence_item_id`, `review_id`, `source_chunk_id` |
| `export` | Work product status, approval checkpoints, audit events, approval-policy audit | `work_product_id`, `checkpoint_id`, `audit_event_id` |

## First Acceptable Deliverable

The first trust-gates persistence deliverable should be a read-only provenance map, not a migration:

```ts
type GatePersistenceProvenance = {
  gate_id: string;
  gate_type: string;
  status: "passed" | "failed" | "warning" | "skipped";
  displayed_reason: string;
  source_record_refs: Array<{
    type:
      | "work_product"
      | "evidence_item"
      | "review_item"
      | "human_checkpoint"
      | "audit_event"
      | "agent_run"
      | "matter_memory"
      | "document";
    id: string;
    role: "input" | "approval" | "blocker" | "audit" | "provenance";
  }>;
  unresolved_source_requirements: string[];
};
```

Acceptance rule:

- `passed` export and human-approval gates must have persisted approval/checkpoint and audit/work-product references.
- `failed` gates must point to persisted blockers or explicitly list unresolved source requirements.
- `warning` gates must point to the evidence/review/material that creates the warning.
- No gate may become final-export authorization solely from `humanApproved`, local component state, or fixture data.

## Owner Boundaries

The `trust-gates` owner may:

- add read-only mapping helpers and focused tests;
- update status JSON with exact source fields preserved;
- improve UI labels that distinguish display gates from persisted approval.

The owner should not:

- add AgentOps-native backend migrations before mapping to existing records;
- bypass `check:aletheia:approval-policy`;
- change high-risk export behavior from the frontend only;
- treat sensitive-material keyword flags as legal privilege determinations;
- widen product docs beyond local-first/private-pilot evidence.

## Backend / Audit Persistence Blocker

Status as of 2026-07-09: the read-only provenance handoff is complete for the
Gate Engine lane, but first-class persisted `GateResult` / `AuditEvent`
storage is blocked on backend/audit schema ownership.

Existing backend surfaces:

- `aletheia_work_products` persists export work products and enforces
  `approvalCheckpointId` for high-risk exports.
- `aletheia_human_checkpoints` persists explicit human approval decisions.
- `aletheia_audit_events` persists generic audit events through
  `appendAuditEvent`.

Missing backend-owned contract:

- canonical audit action names for gate evaluation, final export gate checks,
  and blocked final export attempts;
- a stable persisted payload shape for `GateResult[]`,
  `GatePersistenceProvenance[]`, critical-gate status, source refs, and source
  gaps;
- local repository and Supabase parity for writing those records during final
  memo approval/export;
- audit-integrity checks proving high-risk final memo exports resolve to an
  approved checkpoint and a persisted passing gate snapshot;
- route/repository validation that prevents final memo export from relying on
  UI-only `humanApproved`, component state, or fixture-derived `GateResult`
  objects.

Required owner: backend/audit persistence owner for
`backend/src/lib/aletheia/repository.ts`,
`backend/src/lib/aletheia/localRepository.ts`,
`backend/src/lib/aletheia/supabaseRepository.ts`,
`backend/src/routes/aletheia.ts`, audit-integrity scripts, and any
`backend/migrations/20260709_*.sql` changes.

Gate Engine should remain read-only at this boundary until that owner accepts
the schema/API/repository contract. The Gate Engine lane can supply the
deterministic `GateResult[]` and `GatePersistenceProvenance[]` payloads, but it
must not unilaterally add a backend persistence contract or claim final export
authorization from frontend state.

The ordered backend/audit intake for this blocker lives in `.agentops/BACKEND_AUDIT_PERSISTENCE_INTAKE.md`. Gate persistence is first in that intake because approved export persistence depends on durable gate evidence.

The concrete first slice lives in `.agentops/GATE_PERSISTENCE_FIRST_SLICE.md`. That slice prefers existing `aletheia_audit_events`, approval checkpoint payloads, and final memo work product content before adding a new gate snapshot table.

## Required Validation

Minimum validation for the first handoff:

```bash
cd frontend && npm run lint
cd frontend && npx tsc --noEmit
cd frontend && node --test --experimental-strip-types tests/agentops/gates.test.ts
cd backend && npm run check:aletheia:source-provenance
cd backend && npm run check:aletheia:approval-policy
cd backend && npm run check:aletheia:audit-workbench
cd backend && npm run check:aletheia:run-trace
node .agentops/scripts/check-agentops.mjs
```

If the Command Center, GateChecklist, Review Studio, or export UI changes, also run:

```bash
cd frontend && npm run test:aletheia:ui
```

## Status JSON Requirement

The owner should create or update `.agentops/status/trust-gates.json` or `.agentops/status/gate-engine.json` with:

- `scope` containing every helper, UI, and test file touched;
- `contractsChanged` naming `GatePersistenceProvenance` or equivalent;
- `testsRun` with exact pass/fail commands;
- `risks` that distinguish display gates from persisted export authorization;
- `needs` for backend persistence only if the read-only provenance map proves a real contract gap.
