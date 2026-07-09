# AgentOps Model Alignment

Last updated: 2026-07-09

Purpose: keep the new AgentOps frontend model aligned with the existing Aletheia matter, evidence, work product, review, gate, audit, and eval contracts.

The current source of risk is the untracked `frontend/src/aletheia/agentops/` proposal. It is directionally useful for Agent Command Center, typed artifact handoff, gate results, eval cases, and professional skills, but it should be treated as a view-model layer until mapped to existing persisted contracts.

## Existing Contract Anchors

- Backend domain vocabulary: `backend/src/lib/aletheia/domain.ts`
- Backend repository contract: `backend/src/lib/aletheia/repository.ts`
- Frontend workspace types: `frontend/src/aletheia/types.ts`
- Frontend API client records: `frontend/src/app/lib/aletheiaApi.ts`
- Aletheia migrations: `backend/migrations/20260708_*.sql`, `backend/migrations/20260709_*.sql`

## Alignment Map

| AgentOps proposal | Existing Aletheia concept | Integration guidance |
| --- | --- | --- |
| `MatterType` | `AletheiaTemplate` / `Matter.template` | Map to `legal_matter_review`, `compliance_impact_review`, and `deal_due_diligence`; add new templates only through backend/domain/migration review. |
| `MatterStatus` | `MATTER_STATUSES`, `AletheiaMatterStatus` | Avoid new status names unless the backend and UI both adopt them. `review_needed` should map to `needs_review`; `active` should map to `in_progress`. |
| `DocumentStatus` | matter document `parsed_status` | Map `indexed` to `parsed` or introduce an explicit search-index status as a separate field. |
| `ArtifactType` | `WORK_PRODUCT_KINDS` plus evidence/review/audit/run records | Keep persisted work products limited to known work product kinds; use view-only artifact refs for evidence, review, audit, and run records. |
| `AgentRun` | `aletheia_agent_runs`, run trace UI | Preserve budgets, checkpoint decisions, role tool allowlists, metrics, and audit links from existing runtime records. |
| `EvidenceItem` | source-linked evidence records | Preserve `document_id`, `source_chunk_id`, quote offsets, support status, matter ID, and review tags. |
| `IssueNode` / `RiskItem` | issue map and risk/work product payloads | Keep issue/risk nodes linked to evidence IDs and review items; do not create uncited risk statements. |
| `DraftMemo` | `draft_memo` / `final_memo` work products | Gate final/exported memo state through persisted approval policy, not only `gate_status` in UI. |
| `GateResult` | approval checkpoints, audit events, validation scripts | Persist gate failures or approvals as audit/checkpoint/work-product state before showing them as final. |
| `EvalCase` | feedback export and eval scripts | Preserve review tags, target IDs, evidence IDs, and expected behavior so cases can become regression tests. |
| `ProfessionalSkill` | Matter Playbooks / improvement proposals | Keep skills matter-scoped or human-approved. Do not introduce global autonomous legal memory. |

## Cycle 4 Vocabulary Findings

The current AgentOps handoff contracts are useful for view composition, but they should be normalized through an adapter before any UI or API route treats them as authoritative state.

| Area | AgentOps values | Existing persisted/API values | Required adapter behavior |
| --- | --- | --- | --- |
| Matter type/template | `legal_review`, `compliance_review`, `audit_review`, `due_diligence`, `regulatory_response`, `other` | `legal_matter_review`, `compliance_impact_review`, `deal_due_diligence` | Map supported values explicitly. Treat unsupported values as view-only labels or require a backend template change. |
| Matter status | `active`, `review_needed`, `waiting_for_approval`, `approved`, `closed` | `in_progress`, `needs_review`, `completed` plus `draft`, `archived` | Map `active -> in_progress`, `review_needed -> needs_review`, `approved/closed -> completed` only when gate and audit state prove completion. Keep `waiting_for_approval` as checkpoint/gate state, not matter status. |
| Document status | `indexed`, `excluded` | `parsed_status`: `pending`, `parsed`, `failed` | Map `indexed -> parsed` only after parse/search index success. Keep `excluded` in metadata or a future explicit field, not `parsed_status`. |
| Agent run status | `working`, `review_needed`, `waiting_for_approval`, `done` | `running`, `needs_human`, `completed` plus `queued`, `blocked`, `failed`, `cancelled` | Map `working -> running`, `review_needed/waiting_for_approval -> needs_human`, `done -> completed`. |
| Tool call status | `started`, `succeeded`, `skipped` | `pending`, `running`, `completed`, `failed`, `requires_confirmation` | Map `started -> running`, `succeeded -> completed`; preserve `skipped` as trace metadata unless the backend status set expands. |
| Evidence confidence | numeric `confidence` | `low`, `medium`, `high` | Convert numeric scores by explicit thresholds and preserve the raw score in metadata. |
| Evidence support | `supports_claim_ids` only | `claim_id`, `support_status`, `relevance`, quote offsets, source chunk IDs | Split multi-claim support into multiple evidence records or artifact refs; do not lose support status, quote offsets, or source chunk IDs. |
| Review state | generic `ReviewStatus` | review items with target type, target ID, and review tag | Do not collapse review tags into one status. Preserve `unsupported_claim`, `citation_not_supporting`, `missing_fact`, and other tags for Eval Lab. |
| Gate state | `GateResult` with `passed/failed/warning/skipped` | approval checkpoints, work product status, audit events, validation scripts | Store gate outcomes as checkpoint/audit/work-product state before export. UI gate status is derived, not authoritative. |
| Skills | `ProfessionalSkill` candidate/approved | matter playbooks and improvement proposals | Candidate skills should map to draft playbooks or proposals; approved skills require human approval and matter scope. |

## Adapter Boundary

Until these mappings are implemented, use this boundary:

```text
Existing Aletheia persisted/API records
-> adapter/selector
-> AgentOps view model
-> UI only
```

Do not send `AgentOpsMatterWorkspace` directly to the backend as a replacement for `AletheiaMatterDetail`, and do not store AgentOps `MatterStatus`, `ArtifactType`, `GateResult`, or `ProfessionalSkill` values as persisted source of truth without a coordinated schema/API migration.

## Integration Rule

AgentOps UI should derive from existing Aletheia records:

```text
Matter + Documents + Evidence + Work Products + Reviews + Gates + Audit Events + Run Trace
-> AgentOps view model
```

It should not create a separate persisted matter universe unless the backend repository, migrations, API client, UI types, tests, and audit exports are migrated together.

## Minimum Checks Before Wiring UI

1. Add or update `.agentops/status/<agent-name>.json` for the AgentOps frontend work.
2. Identify each new status or artifact name and map it to an existing contract.
3. Add adapter tests or deterministic assertions that prove AgentOps fixtures preserve evidence and audit provenance.
4. Run:

```bash
cd backend && npm run check:aletheia:operator
cd backend && npm run check:aletheia:run-trace
cd backend && npm run check:aletheia:approval-policy
cd frontend && npm run lint
```
