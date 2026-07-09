# Aletheia Integration Plan

Last updated: 2026-07-09

This plan coordinates feature agents around the complete product loop:

```text
Evidence -> Issue/Risk -> Draft -> Review -> Gate -> Audit -> Eval
```

## Current Stack

- Frontend: Next.js 16 App Router, React 19, TypeScript, Tailwind CSS 4, Playwright.
- Backend: Node.js 22+, Express, TypeScript, `tsx`, Supabase/Postgres adapter plus local SQLite/filesystem adapter.
- Package manager: npm, with lockfiles in `frontend/package-lock.json` and `backend/package-lock.json`.
- Main frontend entry points: `frontend/src/app/page.tsx`, `frontend/src/app/aletheia/page.tsx`, and `frontend/src/app/aletheia/matters/[matterId]/page.tsx`.
- Main backend entry point: `backend/src/index.ts`; Aletheia API is mounted at `/aletheia`.
- Deterministic Aletheia UI/domain layer: `frontend/src/aletheia/`.

## Shared Data Models

The shared model vocabulary should stay aligned across backend domain constants, frontend types, API client types, database migrations, and export schemas.

Authoritative convergence points:

- Backend domain constants and sanitizers: `backend/src/lib/aletheia/domain.ts`
- Backend repository contract: `backend/src/lib/aletheia/repository.ts`
- Frontend workspace types: `frontend/src/aletheia/types.ts`
- Frontend API client records: `frontend/src/app/lib/aletheiaApi.ts`
- New/untracked frontend AgentOps proposal: `frontend/src/aletheia/agentops/`
- Aletheia schema migrations: `backend/migrations/20260708_*.sql`, `backend/migrations/20260709_*.sql`

High-risk model drift to avoid:

- Work product kind/status differences between frontend, backend, migrations, and exports.
- Review target/tag differences that break feedback eval datasets.
- Evidence provenance fields losing `document_id`, `source_chunk_id`, quote offsets, support status, or matter ID.
- Agent run traces diverging from budget/checkpoint/tool-call persistence.
- Gate and audit events represented only in UI state rather than persisted work products/audit rows.
- Parallel AgentOps vocabularies such as `legal_review` versus `legal_matter_review`, `active` versus `in_progress`, `review_needed` versus `needs_review`, or `gate_result` versus persisted approval/audit concepts.
- Parallel demo fixtures that create a second Matter Workspace narrative instead of deriving AgentOps views from existing matters, work products, evidence, reviews, audit events, and run traces.

## File Ownership Boundaries

Feature agents should avoid broad edits outside their lane. Prefer additive changes, narrow patches, and explicit status JSON updates in `.agentops/status/`.

Recommended lanes:

- Workspace/UI agent: `frontend/src/aletheia/`, `frontend/src/app/aletheia/`, `frontend/tests/aletheia-ui-smoke.spec.ts`
- Backend/domain agent: `backend/src/routes/aletheia.ts`, `backend/src/lib/aletheia/`, Aletheia migrations
- AgentOps/runtime agent: agent run tables, `RemoteMatterRunTrace`, runtime audits, budget/checkpoint scripts
- AgentOps/frontend schema agent: `frontend/src/aletheia/agentops/`, but only after aligning vocabulary with backend and existing frontend contracts
- Trust/gates agent: approval policy, tool policy, source provenance, matter isolation, audit integrity, export gates
- Eval/retrieval agent: retrieval eval docs/scripts, source chunking/search, feedback export shape
- Packaging/operator agent: local deployment docs, private preflight, doctor, backup/restore/package scripts
- Supervisor agent: `.agentops/`, coordination docs, integration contracts, status summaries

Files all feature agents should avoid touching without coordination:

- `frontend/src/app/lib/aletheiaApi.ts`
- `frontend/src/aletheia/types.ts`
- `frontend/src/aletheia/schemas.ts`
- `frontend/src/aletheia/agentops/`
- `backend/src/lib/aletheia/domain.ts`
- `backend/src/lib/aletheia/repository.ts`
- `backend/src/routes/aletheia.ts`
- Aletheia migrations under `backend/migrations/20260708_*.sql` and `backend/migrations/20260709_*.sql`
- `backend/package.json` and `frontend/package.json`
- `frontend/tsconfig.json`
- `README.md`, `docs/status.md`, and release/deployment docs

If a feature requires changing one of these files, the agent should record the intent and affected contract in `.agentops/status/<agent-name>.json` before or with the change.

## API Boundaries

Keep Aletheia API work under `/aletheia` unless integrating with existing base app primitives by deliberate adapter.

Current API boundary from docs:

```text
GET  /aletheia/matters
POST /aletheia/matters
GET  /aletheia/matters/:matterId
POST /aletheia/matters/:matterId/work-products
POST /aletheia/matters/:matterId/reviews
POST /aletheia/matters/:matterId/audit-events
POST /aletheia/matters/:matterId/memory
POST /aletheia/matters/:matterId/playbooks
POST /aletheia/matters/:matterId/playbooks/:playbookId/approve
POST /aletheia/matters/:matterId/agent-runs
GET  /aletheia/tool-adapter/tools
POST /aletheia/tool-adapter/tools/:toolName/call
```

API rules:

- Persist professional state before exposing it as completed UI state.
- Return typed artifacts with source/evidence IDs intact.
- Treat Supabase gaps as fail-closed unless the storage adapter explicitly supports the workflow.
- Do not add external services without an explicit adapter boundary and local/private fallback story.
- Treat AgentOps frontend models as view models until they are explicitly backed by the established repository/API contracts.

## AgentOps Model Alignment

The untracked `frontend/src/aletheia/agentops/` work should align before integration:

- Map `MatterType` to existing `AletheiaTemplate` rather than creating a replacement taxonomy.
- Map AgentOps statuses to existing matter, work product, review, checkpoint, and run statuses.
- Map `ArtifactType` to existing work product kinds plus evidence/review/audit/run records.
- Map `GateResult` to persisted approval/checkpoint/audit/work-product state.
- Map `EvalCase` to feedback export/retrieval eval records without losing review tag IDs or evidence IDs.
- Keep `ProfessionalSkill` tied to human-approved Matter Playbooks or proposals; do not introduce autonomous global skills.
- Prefer fixture adapters over independent sample matter data once a UI surface is added.

Detailed mapping notes live in `.agentops/AGENTOPS_MODEL_ALIGNMENT.md`.

Required adapter direction:

```text
AletheiaMatterDetail + run trace records
-> AgentOps view model
```

Do not reverse this direction without a coordinated backend repository, migration, API client, UI type, audit export, and test update.

The next adapter slice is specified in `.agentops/AGENTOPS_ADAPTER_TASK.md`.
Adapter acceptance evidence lives in `.agentops/ADAPTER_ACCEPTANCE_CHECKLIST.md`.
The accepted adapter-backed view path and remaining persistence boundary are reviewed in `.agentops/AGENTOPS_ADAPTER_REVIEW.md`.

Current handoff order and ownership notes live in `.agentops/HANDOFF_QUEUE.md`.
Post-P0 dirty-worktree split and pause/resume protocol live in `.agentops/WORKTREE_HANDOFF.md`.
Conflict detection checklist lives in `.agentops/CONFLICT_WATCH.md`.
Post-adapter wiring order lives in `.agentops/POST_ADAPTER_WIRING_PLAN.md`.
Recurring supervisor cycle checklist lives in `.agentops/SUPERVISOR_CYCLE_CHECKLIST.md`.
Live matter-scoped Command Center acceptance lives in `.agentops/LIVE_COMMAND_CENTER_ROUTE_REVIEW.md`.
Current failing or unverified validation gates live in `.agentops/VALIDATION_BLOCKERS.md`.
Full UI smoke recovery sequencing lives in `.agentops/UI_SMOKE_RECOVERY_PLAN.md`.
Cycle 20 UI smoke acceptance evidence lives in `.agentops/UI_SMOKE_ACCEPTANCE.md`.
Post-browser-validation persistence semantics live in `.agentops/PERSISTENCE_SEMANTICS_PLAN.md`.
The first trust-gates persistence handoff lives in `.agentops/TRUST_GATES_PERSISTENCE_HANDOFF.md`.
The gate persistence first slice lives in `.agentops/GATE_PERSISTENCE_FIRST_SLICE.md`.
The backend/audit persistence intake order lives in `.agentops/BACKEND_AUDIT_PERSISTENCE_INTAKE.md`.
The active backend/audit owner sync lives in `.agentops/BACKEND_AUDIT_OWNER_SYNC.md`.
Persisted gate acceptance lives in `.agentops/PERSISTED_GATE_ACCEPTANCE.md`.
The Big @ reference semantics handoff lives in `.agentops/BIG_AT_REFERENCE_SEMANTICS_HANDOFF.md`.
The typed artifact provenance handoff lives in `.agentops/TYPED_HANDOFF_PROVENANCE_HANDOFF.md`.
The eval snapshot persistence handoff lives in `.agentops/EVAL_SNAPSHOT_PERSISTENCE_HANDOFF.md`.
The audit/eval export provenance handoff lives in `.agentops/AUDIT_EXPORT_PROVENANCE_HANDOFF.md`.
The export package Command Center visibility boundary lives in `.agentops/EXPORT_PACKAGE_VISIBILITY_BOUNDARY.md`.
The professional skill playbook approval handoff lives in `.agentops/PROFESSIONAL_SKILL_PLAYBOOK_APPROVAL_HANDOFF.md`.

## UI Integration Order

1. Matter Queue and Template Registry stay stable.
2. Matter Workspace remains the primary flow.
3. Evidence Registry and Issue/Risk surfaces converge on shared evidence IDs.
4. Draft work product surfaces show citation support and missing-material state.
5. Review Queue writes review items that feed gates and Eval Lab.
6. Gate Engine state becomes visible before final exports.
7. Audit Workbench and Audit Pack consume persisted events and registry snapshots.
8. Agent Command Center overlays run trace and budgets without replacing matter review.
9. Eval Lab exposes feedback datasets and regression outcomes after review/gate state is reliable.

P0 integration status: complete for the current local-first slice. The implemented and validated loop is:

```text
Evidence -> Issue/Risk -> Memo -> Review -> Gate -> Audit -> Eval
```

Immediate operational task: review and commit the dirty worktree from completed parallel feature work. Use `docs/commit_plan.md` for file-level staging groups and `.agentops/WORKTREE_HANDOFF.md` for AgentOps acceptance checks. High-frequency supervisor heartbeats can remain paused until new feature work resumes.

Resume supervisor cycles before post-P0 implementation changes that touch backend persistence, frontend AgentOps adapters, export package shape, typed handoff provenance, Gate Engine behavior, Eval Lab behavior, matter-scoped routes, validation commands, or release/private-pilot readiness claims.

Post-P0 integration task: preserve the completed adapter direction and harden downstream consumption of persisted gate evidence in export/eval/typed handoff surfaces. Gate persistence is accepted for the current slice; unresolved references, durable typed handoff records, eval snapshots, preview export packages, and approved export actions still need persistence-aware consumption before they become release-grade durable records. The current handoff order for that work is defined in `.agentops/PERSISTED_GATE_ACCEPTANCE.md`, `.agentops/BACKEND_AUDIT_PERSISTENCE_INTAKE.md`, and `.agentops/PERSISTENCE_SEMANTICS_PLAN.md`.

Do not start new Agent Command Center UI, gate UI, or Eval Lab UI on top of standalone AgentOps fixtures. Newly observed Command Center and Gate Engine surfaces should stay view/helper layers unless they consume adapter-derived or persisted Aletheia state and preserve approval/audit semantics.

## Test Strategy

Fast checks for most integration cycles:

```bash
cd backend && npm run check:aletheia:operator
cd backend && npm run build
cd frontend && npm run lint
```

Targeted Aletheia checks:

```bash
cd backend && npm run test:aletheia:local
cd backend && npm run test:aletheia:retrieval-eval
cd backend && npm run check:aletheia:source-provenance
cd backend && npm run check:aletheia:approval-policy
cd backend && npm run check:aletheia:audit-workbench
cd backend && npm run check:aletheia:run-trace
cd frontend && npm run test:aletheia:ui
```

Release/private-pilot checks:

```bash
cd backend && npm run check:aletheia:preflight
cd backend && npm run check:aletheia:doctor
cd backend && npm run check:aletheia:ops-readiness
cd backend && npm run check:aletheia:evidence
```

Feature agents should run the smallest relevant check for their change and record results in their status JSON.

## Demo Path

1. Open `/aletheia`.
2. Show the Matter Queue and workflow templates.
3. Open Legal Matter Review.
4. Inspect Document Registry and Agent Plan.
5. Show Issue/Risk Map and Evidence Matrix.
6. Show Draft Memo or template-specific Compliance Register / Red Flag Memo.
7. Add or inspect Human Review tags.
8. Show Gate/approval state before final output.
9. Export or inspect Audit Pack and Feedback JSON.
10. Open Audit Workbench and Run Trace.
11. Explain Eval Lab feedback loop from review tags to future regression checks.

## Conflict Risks

- Multiple agents editing `backend/src/routes/aletheia.ts` can silently break API contracts.
- Backend/audit persistence files are currently owned by active thread `019f45e3-31ff-7232-81c8-8d94ed3a7e7b`; uncoordinated edits can corrupt the gate persistence handoff.
- Frontend and backend type drift can break persisted matters while fallback demo data still appears healthy.
- Adding autonomy without tool allowlists, checkpoints, and audit events weakens the professional positioning.
- UI-only gates or export buttons can bypass persisted approval policy; local preview JSON downloads must remain clearly distinct from approved/export-submission actions.
- Broad README/status rewrites can hide actual limitations and make private pilot readiness unclear.
- Retrieval changes can improve ranking while losing quote offsets or matter isolation.

## Required Agent Status JSON

Each feature agent should write `.agentops/status/<agent-name>.json` with this shape:

```json
{
  "agent": "short-name",
  "updatedAt": "2026-07-09T00:00:00+08:00",
  "status": "progress|blocked|conflict|done",
  "scope": ["files or areas touched"],
  "summary": "one or two sentences",
  "contractsChanged": ["API/model/schema/test contract names"],
  "testsRun": ["commands"],
  "risks": ["known risks"],
  "needs": ["what would unblock this agent"]
}
```

Compatibility note: `.agentops/status/architecture-contracts.json` currently uses a useful but noncanonical shape from the first reported feature-agent update. Supervisors can read it as legacy status, but the next update from that agent should add the canonical fields above so status parsing and conflict detection stay consistent.

Detailed status schema and legacy-field mapping live in `.agentops/AGENT_STATUS_SCHEMA.md`.
Current normalized supervisor read of all feature-agent status files lives in `.agentops/STATUS_ROLLUP.md`.
