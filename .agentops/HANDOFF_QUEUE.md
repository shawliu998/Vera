# Aletheia Handoff Queue

Last updated: 2026-07-09

Purpose: make the next feature-agent handoffs explicit so parallel Codex windows do not compete for the same files or introduce a second product model.

## Queue Policy

- Feature agents must create or update `.agentops/status/<agent-name>.json` using `.agentops/AGENT_STATUS_SCHEMA.md` before handoff.
- Agents should prefer additive changes and narrow adapters over broad refactors.
- Shared contract files require explicit status notes before edits:
  - `frontend/src/app/lib/aletheiaApi.ts`
  - `frontend/src/aletheia/types.ts`
  - `frontend/src/aletheia/schemas.ts`
  - `frontend/src/aletheia/agentops/`
  - `backend/src/lib/aletheia/domain.ts`
  - `backend/src/lib/aletheia/repository.ts`
  - `backend/src/routes/aletheia.ts`
  - `backend/migrations/20260708_*.sql`
  - `backend/migrations/20260709_*.sql`

## Active Queue

Final P0 queue read: all lanes report `done` for the current local-first product slice. High-frequency handoff heartbeats can remain paused until new feature work resumes. The remaining operational task is dirty-worktree cleanup and intentional commit grouping.

| Order | Agent | Status | Task | Prerequisites | Avoid |
| --- | --- | --- | --- | --- | --- |
| 1 | `agentops-adapter` | done for local-first view path | Adapter-backed Command Center path now maps persisted Aletheia matter/work-product data into AgentOps artifacts, typed handoff provenance, export package preview, and local preview JSON download. Typecheck, compiled adapter/export/handoff/skills tests, and focused desktop/mobile route tests are reported. | Preserve adapter direction from `AletheiaMatterDetail` to `AgentOpsMatterWorkspace`. See `.agentops/UI_SMOKE_ACCEPTANCE.md`, `.agentops/ADAPTER_ACCEPTANCE_CHECKLIST.md`, `.agentops/AGENTOPS_ADAPTER_REVIEW.md`, and `.agentops/EXPORT_PACKAGE_VISIBILITY_BOUNDARY.md`. | Backend migrations, replacing existing Aletheia workspace types, treating AgentOps view models as persisted source-of-truth records, or presenting preview JSON as an approved export/audit pack. |
| 2 | `workspace-ui` | adapter-backed route accepted for local browser path | Fixture Command Center exists, matter-scoped route files load live matter detail through the adapter, and route-aware artifact anchors now preserve fixture versus matter-scoped hrefs. | Keep route rendering tied to existing matter evidence, review, gate, audit, and run-trace records. See `.agentops/ROUTE_ARTIFACT_ANCHOR_ACCEPTANCE.md`, `.agentops/AGENTOPS_UI_EVAL_REVIEW.md`, `.agentops/LIVE_COMMAND_CENTER_ROUTE_REVIEW.md`, and `.agentops/UI_SMOKE_ACCEPTANCE.md`. | Directly rendering standalone AgentOps fixtures as product truth, treating hash anchors as durable artifact routes, or shipping unreviewed visual baseline changes. |
| 3 | `trust-gates` | done for current persisted gate slice | Gate Engine and backend-audit persistence now report done. Final memo export authorization requires an approved checkpoint plus server-persisted `gate_results_persisted` and `final_export_gate_authorized` audit evidence. | See `.agentops/TRUST_GATES_PERSISTENCE_HANDOFF.md`, `.agentops/GATE_PERSISTENCE_FIRST_SLICE.md`, `.agentops/PERSISTED_GATE_ACCEPTANCE.md`, `.agentops/BACKEND_AUDIT_OWNER_SYNC.md`, and `.agentops/AGENTOPS_GATE_ENGINE_REVIEW.md`. | Reverting to UI-only approval state, treating `humanApproved` input as product authorization, or dropping `gateSnapshotAuditEventId` / `gateAuthorizationAuditEventId` from final memo/export evidence. |
| 4 | `big-at-context` | done for P0 adapter-backed demo path | Big @ parser/resolver/matter-memory helpers produce read-only resolved/ambiguous/missing reference audit candidates, display ReferencePreview cards and autocomplete suggestions on the matter-scoped Command Center route, and have desktop/mobile route coverage. Future work is post-P0 persistence through the approved audit/reference contract or owned editor insertion workflow. | Preserve adapter-backed matter memory and read-only audit candidate semantics. See `.agentops/BIG_AT_REFERENCE_SEMANTICS_HANDOFF.md`, `.agentops/PERSISTENCE_SEMANTICS_PLAN.md`, and `.agentops/AGENTOPS_CONTEXT_HANDOFF_REVIEW.md`. | Resolving ambiguous/missing references into final professional outputs, writing autocomplete selections into memos without editor ownership, or creating a persisted `Clause` type without schema coordination. |
| 5 | `typed-artifact-handoff` | done for view-layer scope | Typed handoff helpers now validate cross-artifact references, produce read-only provenance/readiness summaries, consume gate provenance, and surface missing/ambiguous references and unbacked gates as blockers. Future work is backend/audit persistence intake only. | Adapter output available. See `.agentops/TYPED_HANDOFF_PROVENANCE_HANDOFF.md`, `.agentops/BACKEND_AUDIT_PERSISTENCE_INTAKE.md`, `.agentops/PERSISTENCE_SEMANTICS_PLAN.md`, and `.agentops/AGENTOPS_CONTEXT_HANDOFF_REVIEW.md`. | Creating final/gated/audited outputs without persisted review/gate/audit state. |
| 6 | `eval-retrieval` | persistence semantics needed | Skills/eval helpers exist on adapter-backed UI, and professional skill activation now has a deterministic playbook approval mapper. Next handoff is a read-only eval snapshot provenance map that includes candidate skill IDs and approved playbook IDs. | Adapter output available. See `.agentops/EVAL_SNAPSHOT_PERSISTENCE_HANDOFF.md`, `.agentops/PROFESSIONAL_SKILL_PLAYBOOK_APPROVAL_HANDOFF.md`, `.agentops/PERSISTENCE_SEMANTICS_PLAN.md`, and `.agentops/AGENTOPS_UI_EVAL_REVIEW.md`. | Collapsing review tags into generic statuses or promoting candidate skills without human-approved playbook provenance. |
| 7 | `audit-eval-export` | done for local-first MVP; next consume persisted gates | Export package helpers include AuditPack, EvalCaseExport, stable hashes, typed handoff provenance, approval/tool-call logs, AgentRun/ToolCall/ReviewComment/GateResult-derived audit events, manifest counts, and integrity validation. Next handoff is consuming persisted gate snapshot/authorization IDs in final memo/export readiness. | Existing compiled export validation path, approval-policy checks, and persisted gate acceptance. See `.agentops/AUDIT_EXPORT_PROVENANCE_HANDOFF.md`, `.agentops/EXPORT_PACKAGE_VISIBILITY_BOUNDARY.md`, `.agentops/PERSISTED_GATE_ACCEPTANCE.md`, `.agentops/PERSISTENCE_SEMANTICS_PLAN.md`, and `.agentops/EVAL_SNAPSHOT_PERSISTENCE_HANDOFF.md`. | Creating a parallel export persistence contract, adding approved export actions before approval/gate provenance, or exporting view-only gate/eval claims as audited truth. |
| 8 | `architecture-contracts` | done, canonical | Shared AgentOps contracts are canonical and still view/handoff contracts, not source-of-truth persistence. | Preserve existing useful details. See `.agentops/AGENTOPS_HELPERS_REVIEW.md`. | Changing contract vocabulary without adapter alignment. |

## Recommended Validation By Handoff

For `agentops-adapter`:

```bash
cd frontend && npm run lint
cd backend && npm run check:aletheia:source-provenance
cd backend && npm run check:aletheia:approval-policy
cd backend && npm run check:aletheia:run-trace
```

For UI wiring after adapter:

```bash
cd frontend && npm run lint
cd frontend && npm run test:aletheia:ui
```

Post-adapter sequencing lives in `.agentops/POST_ADAPTER_WIRING_PLAN.md`.
Persistence-semantics handoff order lives in `.agentops/PERSISTENCE_SEMANTICS_PLAN.md`.

For private-pilot readiness after multiple handoffs:

```bash
cd backend && npm run check:aletheia:operator
cd backend && npm run check:aletheia:preflight
```

## Current Supervisor Read

- P0 loop is complete for the current local-first slice: `Evidence -> Issue/Risk -> Memo -> Review -> Gate -> Audit -> Eval`.
- All feature/status lanes report `done`, including backend-audit persistence, Gate Engine, and UI smoke recovery.
- High-frequency supervisor heartbeats can remain paused unless new feature work resumes.
- The only remaining cleanup item is the dirty worktree from completed parallel feature work.
- `architecture-contracts` is done and now has canonical status fields while preserving legacy detail for compatibility.
- `frontend/src/aletheia/agentops/agentStatus.ts` and `handoff.ts` are observed but not yet reflected in the status JSON.
- Command Center UI and skills/eval helpers now have adapter-backed browser coverage for the matter-scoped route; keep them classified as view/helper layers until persistence wiring is explicit.
- Big @ Context and Typed Artifact Handoff helpers are observed around the adapter; keep them local/view-layer unless unresolved references and handoff records are persisted/audited.
- Gate Engine helpers and checklist render through the adapter-backed route; keep final authorization tied to persisted checkpoint/review/audit state.
- Most feature-agent status JSON files are now canonical.
- The post-P0 hardening area is persistence semantics for gates/references/typed handoff/eval snapshots/audit exports, tracked in `.agentops/PERSISTENCE_SEMANTICS_PLAN.md`, `.agentops/TRUST_GATES_PERSISTENCE_HANDOFF.md`, `.agentops/BIG_AT_REFERENCE_SEMANTICS_HANDOFF.md`, `.agentops/TYPED_HANDOFF_PROVENANCE_HANDOFF.md`, `.agentops/EVAL_SNAPSHOT_PERSISTENCE_HANDOFF.md`, and `.agentops/AUDIT_EXPORT_PROVENANCE_HANDOFF.md`, not route rendering.
- The matter-scoped Command Center route is browser-accepted in `.agentops/LIVE_COMMAND_CENTER_ROUTE_REVIEW.md` and `.agentops/UI_SMOKE_ACCEPTANCE.md`.
- Route-aware artifact anchors are accepted as in-page reviewer navigation in `.agentops/ROUTE_ARTIFACT_ANCHOR_ACCEPTANCE.md`.
- Professional skill activation must follow `.agentops/PROFESSIONAL_SKILL_PLAYBOOK_APPROVAL_HANDOFF.md`.
- Export package metadata and local preview JSON downloads may render in the matter-scoped Command Center, but only under `.agentops/EXPORT_PACKAGE_VISIBILITY_BOUNDARY.md`; approved export actions and backend parity remain future coordinated work.
- Backend/audit persistence intake order lives in `.agentops/BACKEND_AUDIT_PERSISTENCE_INTAKE.md`.
- Persisted gate acceptance lives in `.agentops/PERSISTED_GATE_ACCEPTANCE.md`; Gate Engine is done for current scope after backend-audit status landed.
- Full UI smoke recovery history is tracked in `.agentops/UI_SMOKE_RECOVERY_PLAN.md`; Cycle 31 broad smoke currently passes.
- Current validation state is tracked in `.agentops/VALIDATION_BLOCKERS.md`; no P0 validation blocker remains.
