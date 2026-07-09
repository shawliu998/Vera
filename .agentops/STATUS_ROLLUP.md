# Aletheia Agent Status Rollup

Last updated: 2026-07-09

Purpose: normalize the currently reported `.agentops/status/*.json` files without editing feature-agent-owned status files.

## Supervisor Read

Final P0 supervisor read: all feature-agent status files report `done`, including `backend-audit-persistence`, `gate-engine`, and `ui-smoke-recovery`. The P0 professional loop is complete for the current local-first slice:

```text
Evidence -> Issue/Risk -> Memo -> Review -> Gate -> Audit -> Eval
```

High-frequency supervisor heartbeats can remain paused unless new feature work resumes. The only remaining cleanup item is the dirty worktree from completed parallel feature work.

Several feature-agent status files now use the canonical shape from `.agentops/AGENT_STATUS_SCHEMA.md`; several older files still use a useful legacy shape.

The status files are still readable through this temporary mapping:

| Legacy field | Canonical field |
| --- | --- |
| `last_cycle_summary` | `summary` |
| `files_changed` | `scope` |
| `contracts_added`, `features_added`, `gates_added`, `reference_types_added`, `artifacts_supported`, `docs_added`, `eval_features_added`, `skills_features_added` | `contractsChanged` or feature contract notes |
| `tests_run` | `testsRun` |
| `blockers` | `risks` or `needs` when non-empty |
| `next_actions` | `needs` |

## Current Agents

| Agent | Reported status | Supervisor classification | Validation reported | Handoff note |
| --- | --- | --- | --- | --- |
| `architecture-contracts` | done | Shared AgentOps view contracts; not source-of-truth persistence. Canonical fields are now present while legacy detail remains for compatibility. | `tsc --noEmit`, `lint` | Future persistence work should map these contracts to existing backend records without creating a second product source of truth. |
| `demo-readme-pitch` | done | Reviewer-facing docs and positioning. | `jq` only | Keep professional-positioning guardrails; operator health currently passes after README wording fix. |
| `matter-command-center` | done | Shared Command Center filters and route-aware artifact anchors apply to fixture-backed and adapter-backed routes; hash links are accepted as in-page artifact queue navigation only. | lint, typecheck, build, fixture-route browser navigation/filter checks reported; Cycle 20 supervisor full UI smoke passed for the live matter route. | Keep the local demo route and adapter-backed matter route clearly distinguished; do not treat hash anchors as durable artifact routes. |
| `skills-eval-loop` | done | Eval/skills helper layer plus Eval Workbench UI; latest status adds deterministic playbook approval mapping that keeps candidate skills inactive and activates skills only when backed by approved playbook identity/timestamp. | targeted lint, typecheck, compiled adapter+skillsEval test and focused desktop route Playwright reported; supervisor repo lint/typecheck still pass. | Next persistence step is feeding persisted Aletheia playbook records into `.agentops/PROFESSIONAL_SKILL_PLAYBOOK_APPROVAL_HANDOFF.md` before eval snapshots treat skill state as durable. |
| `big-at-context` | done | P0 adapter-backed Big @ path: parser/resolver/memory helpers, `@Clause` references over source-grounded evidence/document chunks, resolved/ambiguous/missing audit candidates, ReferencePreview rendering, and read-only autocomplete suggestions. | typecheck, `tsx` references test, focused desktop/mobile route tests reported; Cycle 31 full UI smoke passed. | Post-P0 handoff is persistence through the approved audit/reference contract or owned editor insertion workflow; `@Clause` remains a view-level reference to evidence items. |
| `typed-artifact-handoff` | done | Current view-layer typed handoff scope: cross-artifact validation, read-only provenance, gate provenance folding, readiness summaries, and blockers for missing/ambiguous references or unbacked gates. | typecheck, lint, `tsx --test tests/agentops/handoff.test.ts`, AgentOps checker reported; supervisor compiled bundle rerun passed. | Future persistence work should go through `.agentops/BACKEND_AUDIT_PERSISTENCE_INTAKE.md`; provenance may inform gate/eval/export owners but is not durable audit state by itself. |
| `gate-engine` | done | Frontend Gate Engine lane is complete for final export fail-closed behavior and read-only `GatePersistenceProvenance`; backend-audit persistence now clears the first-class persisted gate evidence blocker. | Focused gate tests, backend build, approval-policy, populated audit-integrity, local regression, frontend typecheck/lint reported across gate/backend statuses; Cycle 31/32 full UI smoke passed. | Future work should consume persisted `gateSnapshotAuditEventId` and `gateAuthorizationAuditEventId`; do not reopen Gate Engine unless the persisted contract regresses. |
| `backend-audit-persistence` | done | Dedicated owner thread implemented first-class persisted gate evidence through canonical `aletheia_audit_events` actions without adding a new table. | backend build, approval-policy, audit-integrity including populated `ALETHEIA_AUDIT_SOURCE_DIR`, source-provenance, run-trace, operator, audit-workbench, local regression, and focused gate test reported. | Accepted contract is tracked in `.agentops/PERSISTED_GATE_ACCEPTANCE.md`; downstream export/eval/typed handoff should preserve persisted gate evidence IDs. |
| `workflow-scheduler` | done | Canonical local-first AgentOps orchestration contracts and deterministic red flag memo trace. | `node .agentops/scripts/check-agentops.mjs` | Useful orchestration contract; still must be adapter-backed before UI treats the trace as product truth. |
| `agentops-adapter` | done | Adapter from `AletheiaMatterDetail` to `AgentOpsMatterWorkspace`; matter-scoped route, direct route Playwright coverage, export package preview, typed handoff preview, and local preview JSON download exist. | Typecheck pass; compiled adapter/export/handoff/skills tests via `tests/agentops/tsconfig.adapter.json` pass; focused desktop/mobile route tests reported. | Accepted for adapter-backed view rendering; not a new persistence source of truth. Export package preview/download visibility follows `.agentops/EXPORT_PACKAGE_VISIBILITY_BOUNDARY.md`. |
| `matter-document-evidence` | done | Local-first Matter/Document/Evidence lane: matter profile, material checklist, document registry/source map, searchable source corpus, sensitive flags, enriched Evidence Matrix, and stable EvidenceItem anchors. | Frontend typecheck/lint, backend source-provenance, AgentOps checker, and full desktop/mobile Aletheia UI smoke with 6 passing tests reported. | Keep sensitive flags advisory and do not represent them as privilege determinations; stable evidence anchors remain in-page DOM anchors, not first-class artifact detail routes. |
| `audit-eval-export` | done | Local-first MVP export package and remote audit/feedback export payload enrichment; latest status adds AuditPack, EvalCaseExport, stable hashes, typed handoff provenance, approval/tool-call logs, AgentRun/ToolCall/ReviewComment/GateResult-derived audit events, manifest counts, and integrity validation. | Typecheck, lint, compiled export package test with 11 passing tests, and AgentOps checker reported. | Done for the local view/helper boundary only. Must remain behind persisted approval gates and `.agentops/EXPORT_PACKAGE_VISIBILITY_BOUNDARY.md` before visible export actions or backend schema parity. |
| `issue-risk-review` | done | Deterministic local P0 Review Studio path for Issue/Risk/Review/Eval handoff. | `tsx --test tests/reviewStudio.test.ts`, lint, typecheck, desktop Playwright demo, AgentOps checker reported; direct stripped-TS Node command remains unreliable on extensionless imports. | Local/demo view-model only until review/audit persistence is coordinated. |

## Missing Or Not Yet Canonical

- `agentops-adapter` is reported in canonical status shape, has a passing compiled test path, and is browser-validated through Cycle 20 UI smoke; direct stripped-TypeScript Node commands remain unreliable for files with extensionless imports.
- Backend/audit persistence owner status exists and reports done. Persisted gate acceptance is defined in `.agentops/PERSISTED_GATE_ACCEPTANCE.md`.
- Current failing or unverified validation gates are tracked in `.agentops/VALIDATION_BLOCKERS.md`.
- Existing reports do not include explicit `updatedAt` timestamps, so recency is inferred from current worktree inspection rather than machine-readable status metadata.

## Current Conflict Read

No P0 integration blocker remains and no direct file conflict requires reverting work. The residual operational task is dirty-worktree cleanup: review, group, and commit completed parallel feature work intentionally. Post-P0 integration risk is downstream consumption of persisted gate evidence: multiple helpful AgentOps surfaces now render through the adapter, and final memo gate authorization has a first-class audit-event persistence path. Route-aware artifact anchors and EvidenceItem anchors remain in-page reviewer navigation only. Big @ audit candidates, Big @ autocomplete suggestions, typed handoff provenance, export package previews, and local preview JSON downloads are still helper surfaces unless they preserve persisted Aletheia IDs. The next concrete order is export/eval/typed handoff consumption of persisted gate snapshot/authorization IDs, then reference/eval/export persistence. The first deliverables are specified in `.agentops/PERSISTED_GATE_ACCEPTANCE.md`, `.agentops/BIG_AT_REFERENCE_SEMANTICS_HANDOFF.md`, `.agentops/TYPED_HANDOFF_PROVENANCE_HANDOFF.md`, `.agentops/EVAL_SNAPSHOT_PERSISTENCE_HANDOFF.md`, `.agentops/AUDIT_EXPORT_PROVENANCE_HANDOFF.md`, and `.agentops/EXPORT_PACKAGE_VISIBILITY_BOUNDARY.md`.

Full UI smoke recovery history lives in `.agentops/UI_SMOKE_RECOVERY_PLAN.md`. Cycle 31 supervisor reran full smoke on explicit ports `5610/5611` and passed all 6 desktop/mobile tests, so the older missing smoke state, Evidence Registry snapshot, and Review Studio mobile gate blockers are currently cleared. Focused feature tests remain useful narrow evidence but do not replace the full-smoke acceptance command after relevant UI changes.

Professional skill activation is now governed in `.agentops/PROFESSIONAL_SKILL_PLAYBOOK_APPROVAL_HANDOFF.md`: candidate skills remain inactive, and approved skills require human-approved playbook provenance before they can affect future runs.

The next coordination gate remains:

```text
AletheiaMatterDetail + run trace records
-> AgentOps adapter
-> Command Center / Big @ Context / Typed Handoff / Gate Engine / Eval helpers
```

## Requested Agent Follow-Up

On the next update, each feature agent should add canonical fields while preserving its existing useful detail:

```json
{
  "updatedAt": "2026-07-09T00:00:00+08:00",
  "scope": [],
  "summary": "",
  "contractsChanged": [],
  "testsRun": [],
  "risks": [],
  "needs": []
}
```
