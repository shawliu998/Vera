# AgentOps Adapter Review

Last updated: 2026-07-09

Purpose: record the supervisor read on the newly observed AgentOps adapter slice before downstream UI, gate, handoff, context, export, and eval helpers treat it as accepted product truth.

## Observed Files

- `frontend/src/aletheia/agentops/adapters.ts`
- `frontend/tests/agentops/adapters.test.ts`

`.agentops/status/agentops-adapter.json` now exists and reports `status: "progress"`.

## Current Classification

The adapter is directionally aligned with the required integration direction:

```text
AletheiaMatterDetail + run/checkpoint/tool/audit/review records
-> AgentOpsMatterWorkspace
```

It maps existing Aletheia API records into the AgentOps view model and includes a focused test fixture shaped as `AletheiaMatterDetail`.

The adapter is accepted for local-first browser rendering through the matter-scoped Command Center route. It is not accepted as a persistence boundary or new source-of-truth model.

## Positive Signals

- Preserves matter ID, template/status mapping, document parsing status, evidence IDs, source chunk IDs, quote offsets, support status, claim IDs, review tags, audit event IDs, run IDs, tool calls, human checkpoints, and approved playbooks.
- Derives failed human-approval gates from open checkpoints rather than a UI-only approval boolean.
- Adds `summarizeAdapterProvenance` so later integration can cheaply inspect source-provenance coverage.
- Keeps `AgentOpsMatterWorkspace` as a frontend view/handoff model rather than changing backend persistence.

## Current Risks

- The adapter status reports direct Node execution of `tests/agentops/adapters.test.ts` is blocked by extensionless internal imports under Node's stripped TypeScript runner.
- `matter-document-evidence` reports the direct adapter Node test in `testsRun`, but the current supervisor run failed that command before assertions with `ERR_MODULE_NOT_FOUND` for `frontend/src/aletheia/agentops/adapters`.
- `gate-engine` still reports typecheck blocked by adapter issues, but the current supervisor run of `cd frontend && npx tsc --noEmit` passed.
- The adapter and `frontend/src/aletheia/agentops/index.ts` affect all AgentOps helpers because `index.ts` re-exports the adapter and extensionless local modules.
- AgentOps export package direct Node test still fails before assertions with an extensionless import resolution error.

## Acceptance Requirements

Before post-adapter UI/gate/eval/context work consumes this adapter as product truth, the owning agent status must include:

- exact files touched;
- contracts changed;
- test commands and pass/fail results, including blocked runtime commands;
- known typecheck issues;
- confirmation that no backend migration/API/repository source of truth was changed for the first slice;
- confirmation that evidence provenance, review tags, checkpoint IDs, audit event IDs, and playbook approval state survive mapping.

## Required Validation

Minimum focused checks:

```bash
cd frontend && node --test --experimental-strip-types tests/agentops/adapters.test.ts
cd frontend && npx tsc --noEmit
cd frontend && npm run lint
cd backend && npm run check:aletheia:source-provenance
cd backend && npm run check:aletheia:approval-policy
cd backend && npm run check:aletheia:run-trace
```

Related regression checks before downstream handoff:

```bash
cd frontend && node --test --experimental-strip-types tests/reviewStudio.test.ts
cd frontend && node --test --experimental-strip-types tests/agentops/exportPackage.test.ts
node .agentops/scripts/check-agentops.mjs
```

## Supervisor Gate

Treat this as an accepted adapter-backed view path after Cycle 20 browser validation. Do not treat `AgentOpsMatterWorkspace` as persisted professional state unless a coordinated backend repository, migration, API, export, audit, and test update explicitly changes that contract. The next gate is `.agentops/PERSISTENCE_SEMANTICS_PLAN.md`.

## Cycle 16 Supervisor Validation

Current supervisor validation:

- `cd frontend && npx tsc --noEmit`: passed.
- `cd frontend && npm run lint`: passed cleanly on the final rerun after late UI/export changes.
- `cd frontend && node --test --experimental-strip-types tests/agentops/adapters.test.ts`: failed before assertions with `ERR_MODULE_NOT_FOUND` resolving `frontend/src/aletheia/agentops/adapters`.
- `cd frontend && node --test --experimental-strip-types tests/reviewStudio.test.ts`: passed.
- `cd frontend && node --test --experimental-strip-types tests/agentops/exportPackage.test.ts`: failed before assertions with `ERR_MODULE_NOT_FOUND` resolving `frontend/src/aletheia/agentops/exportPackage`.
- Backend source-provenance, approval-policy, run-trace, and operator checks passed.

## Cycle 17 Supervisor Validation

Current supervisor validation:

- `cd frontend && npx tsc --noEmit`: passed.
- `cd frontend && npm run lint`: passed after generated `.next-review-studio` output was ignored consistently with other Next build directories.
- `cd frontend && rm -rf /tmp/aletheia-adapter-tests && npx tsc -p tests/agentops/tsconfig.adapter.json && node --test /tmp/aletheia-adapter-tests/tests/agentops/adapters.test.js`: passed.
- `cd frontend && node --test --experimental-strip-types tests/agentops/adapters.test.ts`: still fails before assertions with `ERR_MODULE_NOT_FOUND`.
- `cd frontend && node --test --experimental-strip-types tests/agentops/exportPackage.test.ts`: still fails before assertions with `ERR_MODULE_NOT_FOUND`.

Supervisor read: the adapter now has an executable compiled validation path, but the direct stripped-TypeScript Node runner remains unsuitable for extensionless imports.

## Cycle 18 Supervisor Validation

Current supervisor validation:

- `node .agentops/scripts/check-agentops.mjs`: passed with only the legacy `architecture-contracts` warning.
- `cd frontend && rm -rf /tmp/aletheia-adapter-tests && npx tsc -p tests/agentops/tsconfig.adapter.json && node --test /tmp/aletheia-adapter-tests/tests/agentops/adapters.test.js`: passed.

Supervisor read: adapter validation is no longer blocked by status schema or lack of an executable test path. Browser validation through the live matter-scoped Command Center route remains pending.

## Cycle 20 Supervisor Validation

Current supervisor validation:

- `cd frontend && ALETHEIA_UI_SMOKE_FRONTEND_PORT=4910 ALETHEIA_UI_SMOKE_BACKEND_PORT=4911 npm run test:aletheia:ui`: passed, 6 browser tests across desktop and mobile.
- `tests/aletheia-agentops-route.spec.ts` passed for direct `/aletheia/matters/<matterId>/agentops` route load.
- `tests/aletheia-ui-smoke.spec.ts` passed for workspace-to-Command-Center navigation and back navigation.
- `tests/review-studio-demo.spec.ts` passed on desktop and mobile.

Supervisor read: route rendering is accepted for the local-first adapter-backed path. Remaining risk is persistence semantics for gate decisions, unresolved references, typed handoff records, eval snapshots, audit events, and AgentOps-derived export sections.
