# UI Smoke Recovery Plan

Last updated: 2026-07-09

Purpose: keep full UI smoke failures separate from focused feature validation. Focused route/gate/eval/export tests can prove a narrow handoff, but `npm run test:aletheia:ui` remains the supervisor acceptance command for the end-to-end local workspace, matter-scoped Command Center, and Review Studio demo.

## Current State

Cycle 32 recovery-owner rerun on explicit fresh ports passed:

```bash
cd frontend && ALETHEIA_UI_SMOKE_FRONTEND_PORT=5710 ALETHEIA_UI_SMOKE_BACKEND_PORT=5711 npm run test:aletheia:ui
```

Result: 6 passed across desktop/mobile `tests/aletheia-agentops-route.spec.ts`, `tests/aletheia-ui-smoke.spec.ts`, and `tests/review-studio-demo.spec.ts`. Global setup wrote `frontend/test-results/aletheia-ui-smoke-state.json` with `frontendPort: 5710`, `backendPort: 5711`, and separate desktop/mobile seeded matter IDs.

The prior mobile blockers are cleared in the current checkout:

- Mobile Evidence Registry completed `save-evidence-snapshot`, displayed `matter-scoped evidence snapshot`, and did not emit `Failed to fetch`.
- Mobile Review Studio moved the final export gate from `blocked` to `ready` after explicit approval, then returned to `blocked` only after later reviewer actions introduced valid blockers.

Cycle 31 supervisor rerun on explicit fresh ports passed:

```bash
cd frontend && ALETHEIA_UI_SMOKE_FRONTEND_PORT=5610 ALETHEIA_UI_SMOKE_BACKEND_PORT=5611 npm run test:aletheia:ui
```

Result: 6 passed across desktop/mobile `tests/aletheia-agentops-route.spec.ts`, `tests/aletheia-ui-smoke.spec.ts`, and `tests/review-studio-demo.spec.ts`.

The failure shape below is retained as recovery history in case it reappears.

## Recovered Failure Shape

`gate-engine` reported a full UI smoke attempt failed outside the gate slice:

- missing `test-results/aletheia-ui-smoke-state.json` in UI smoke or AgentOps mobile setup;
- Review Studio mobile expected final export gate `ready` but received `blocked`.

Cycle 28 supervisor rerun on explicit ports reached the tests and wrote `test-results/aletheia-ui-smoke-state.json`. The remaining reproduced failures were:

- mobile `aletheia-ui-smoke.spec.ts` failed after `save-evidence-snapshot`; the Evidence Registry showed `Failed to fetch` and did not show `matter-scoped evidence snapshot`;
- mobile `review-studio-demo.spec.ts` still expected final export gate `ready` after approval but received `blocked`.

These failures should not be used to reject focused gate, route, or export work by themselves. They no longer block current broad smoke acceptance unless they reproduce on a clean explicit-port rerun. Cycle 32 explicitly reran the broad smoke and confirmed both failure modes remain cleared.

## Recovery Order

1. Use explicit unused ports for every full-smoke rerun and confirm no leftover listeners remain afterward:

   ```bash
   cd frontend && ALETHEIA_UI_SMOKE_FRONTEND_PORT=5410 ALETHEIA_UI_SMOKE_BACKEND_PORT=5411 npm run test:aletheia:ui
   ```

2. If the smoke state file is missing or records unexpected ports, inspect global setup before changing route tests:

   - `frontend/tests/aletheia-ui-smoke.global-setup.ts`
   - `frontend/playwright.config.ts`
   - `frontend/test-results/aletheia-ui-smoke-state.json`

3. If Evidence Registry snapshot save shows `Failed to fetch`, inspect the snapshot API path and local repository snapshot persistence before changing UI assertions:

   - `frontend/src/aletheia/AletheiaEvidenceRegistry.tsx`
   - `frontend/src/app/lib/aletheiaApi.ts`
   - `backend/src/routes/aletheia.ts`
   - `backend/src/lib/aletheia/localRepository.ts`

4. If Review Studio mobile stays blocked after clicking approve, inspect the demo model/gate path before changing assertions:

   - `frontend/tests/review-studio-demo.spec.ts`
   - `frontend/src/aletheia/reviewStudio.ts`
   - `frontend/src/aletheia/AletheiaWorkspace.tsx`

5. If only one feature route is under review, run its focused test and record that it is narrow evidence:

   ```bash
   cd frontend && ALETHEIA_UI_SMOKE_FRONTEND_PORT=5310 ALETHEIA_UI_SMOKE_BACKEND_PORT=5311 npx playwright test tests/aletheia-agentops-route.spec.ts --project=desktop-chromium
   ```

## Acceptance Rules

- Full smoke passing supersedes older full-smoke blocker reports.
- Focused route tests do not supersede full-smoke failures for release/private-pilot readiness.
- Generated Next output under `.next-ui-smoke`, `.next-review-studio`, and `.next-agentops-route` should be treated as disposable test output.
- Port collisions should be recorded as environment blockers, not product regressions, unless they reproduce on clean explicit ports.

## Required Status Notes

When a feature agent reports full UI smoke status, include:

- exact command and ports;
- whether global setup wrote `test-results/aletheia-ui-smoke-state.json`;
- desktop/mobile project results;
- first failing assertion and owning surface;
- whether focused tests still pass.

## Suggested Validation

```bash
cd frontend && npm run lint
cd frontend && npx tsc --noEmit
cd frontend && ALETHEIA_UI_SMOKE_FRONTEND_PORT=5410 ALETHEIA_UI_SMOKE_BACKEND_PORT=5411 npm run test:aletheia:ui
node .agentops/scripts/check-agentops.mjs
```
