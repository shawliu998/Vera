# Aletheia Conflict Watch

Last updated: 2026-07-09

Purpose: give each supervisor cycle a concrete checklist for detecting parallel-agent conflicts before they become product or merge problems.

## Watch Every Cycle

Run or inspect:

```bash
git status --short --untracked-files=all
find .agentops/status -maxdepth 1 -type f -name '*.json' -print
```

Then compare changed files against the high-conflict paths below.

The full recurring supervisor routine lives in `.agentops/SUPERVISOR_CYCLE_CHECKLIST.md`.

## High-Conflict Paths

| Path | Why it is risky | Supervisor response |
| --- | --- | --- |
| `backend/src/routes/aletheia.ts` | Central API behavior for matters, work products, reviews, audit, runs, memory, playbooks, tools, and exports. | Require feature-agent status with endpoint/contract summary and targeted backend checks. |
| `backend/src/lib/aletheia/domain.ts` | Authoritative backend vocabulary for templates, statuses, review tags, evidence support, work product kinds, actors, memory, and playbooks. | Block parallel vocabulary changes unless frontend/API/migration mapping is documented. |
| `backend/src/lib/aletheia/repository.ts` | Persistence boundary for local/Supabase behavior. | Require adapter-specific status and local regression or targeted repository check. |
| `backend/src/lib/aletheia/documentParser.ts` | Source ingestion, text extraction, chunking, quote offsets, and sensitive-material detection. | Require parser/trust status plus source-provenance validation when changed. |
| `backend/migrations/20260708_*.sql`, `backend/migrations/20260709_*.sql` | Persisted schema and status constraints. | Require migration rationale, compatibility note, and backend build/preflight plan. |
| `frontend/src/app/lib/aletheiaApi.ts` | Frontend API record types and request functions. | Require matching backend route/schema status before UI agents depend on changes. |
| `frontend/src/aletheia/types.ts`, `frontend/src/aletheia/schemas.ts` | Current workspace/UI model and validation surface. | Require mapping to backend domain and deterministic demo/local flow. |
| `frontend/src/aletheia/remoteMatterTransforms.ts`, `frontend/src/aletheia/RemoteMatterPage.tsx` | Persisted Matter Workspace selectors and UI. | Require source-provenance, review/gate, and UI validation notes when changed. |
| `frontend/src/aletheia/RemoteMatterCommandCenter.tsx`, `frontend/src/app/aletheia/matters/[matterId]/agentops/page.tsx` | Adapter-backed AgentOps UI over live matter records. | Require status ownership, adapter validation, and browser/UI smoke before product claims. |
| `frontend/src/aletheia/AletheiaWorkspace.tsx`, `frontend/src/aletheia/reviewStudio.ts` | Deterministic workspace review and local gate/eval helper flow. | Require clear prototype/helper classification and frontend validation. |
| `frontend/src/aletheia/exports.ts`, `frontend/tests/review-studio-demo.spec.ts` | Audit/eval export payloads and browser demo validation. | Require explicit status ownership and proof that exports remain gated/audited. |
| `frontend/.next-*`, `frontend/.next-review-studio`, `frontend/.next-ui-smoke` | Generated Next build/test output. | Keep ignored and out of lint/status ownership; do not treat generated chunks as feature work. |
| `frontend/src/aletheia/agentops/` | New AgentOps handoff/view contracts. | Require adapter alignment before UI or persistence use. Do not treat fixtures as source of truth. |
| `frontend/tsconfig.json` | Shared TypeScript/test behavior for all frontend code. | Require status note and frontend typecheck/lint evidence for compiler-option changes. |
| `frontend/src/aletheia/RemoteMatterRunTrace.tsx` | Runtime visibility, checkpoints, budgets, and graph display. | Require run-trace audit if behavior changes. |
| `frontend/src/aletheia/AletheiaAuditWorkbench.tsx` | Audit Pack, registry snapshots, and review readiness visibility. | Require audit workbench/source provenance checks if behavior changes. |
| `docs/status.md`, `README.md`, release/deployment docs | Public product/readiness claims. | Require validation evidence before changing capability claims. |
| `backend/package.json`, `frontend/package.json` | Shared scripts and dependencies. | Require rationale and relevant install/build/lint verification. |

## Product-Loop Conflict Signals

Flag a conflict when a change:

- bypasses `Evidence -> Issue/Risk -> Draft -> Review -> Gate -> Audit -> Eval`;
- represents Aletheia as replacing legal, compliance, audit, or diligence experts;
- makes a final memo, audit pack, feedback export, or high-risk output possible without persisted review/gate/audit state;
- drops evidence provenance such as `document_id`, `source_chunk_id`, quote offsets, support status, or matter ID;
- collapses review tags into generic approved/rejected state and loses eval signal;
- introduces global legal memory or autonomous playbook mutation;
- uses standalone AgentOps fixtures as product truth instead of adapting existing Aletheia records;
- adds external services without a local/private fallback and explicit adapter boundary;
- claims Supabase-backed document upload/search completeness without implementation evidence.

## Response Ladder

1. Record the conflict in `.agentops/SUPERVISOR_STATUS.md`.
2. Ask the owning agent to update `.agentops/status/<agent-name>.json` with canonical fields.
3. Prefer an adapter or compatibility layer over changing shared source-of-truth contracts.
4. Require the smallest relevant validation command from `.agentops/INTEGRATION_PLAN.md`.
5. If two agents need the same high-conflict file, sequence them in `.agentops/HANDOFF_QUEUE.md`.

## Current Watch Item

The active watch item is AgentOps integration:

```text
AletheiaMatterDetail + run trace records -> AgentOpsMatterWorkspace
```

Do not allow UI work to reverse that direction or persist AgentOps view-model statuses without a coordinated backend/API/migration plan.

Newly observed AgentOps helper files are reviewed in `.agentops/AGENTOPS_HELPERS_REVIEW.md`. Treat them as post-adapter view-layer helpers until proven otherwise.

Newly observed AgentOps UI/eval files are reviewed in `.agentops/AGENTOPS_UI_EVAL_REVIEW.md`. Treat direct `sampleAgentOpsWorkspace` rendering as prototype/demo-only until adapter-backed.

Newly observed Big @ Context and Typed Artifact Handoff files are reviewed in `.agentops/AGENTOPS_CONTEXT_HANDOFF_REVIEW.md`. Treat them as local/view-layer helpers until adapter-backed persisted records preserve provenance.

Newly observed Gate Engine files are reviewed in `.agentops/AGENTOPS_GATE_ENGINE_REVIEW.md`. Treat gate helpers as deterministic helper/display code until final decisions are persisted through approval and audit flows.

Newly observed unreported backend parser trust changes are reviewed in `.agentops/BACKEND_PARSER_TRUST_REVIEW.md`. Treat sensitive-material flags as advisory trust signals until persisted and audited.

Late-cycle unreported backend/frontend integration surfaces are reviewed in `.agentops/UNREPORTED_INTEGRATION_SURFACES.md`. Require canonical ownership status before downstream handoff.
