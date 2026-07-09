# Live Command Center Route Review

Last updated: 2026-07-09

Purpose: record the supervisor read on the new matter-scoped AgentOps Command Center route before it is treated as accepted product UI.

## Observed Files

- `frontend/src/aletheia/RemoteMatterCommandCenter.tsx`
- `frontend/src/app/aletheia/matters/[matterId]/agentops/page.tsx`
- `frontend/src/components/agentops/MatterCommandCenter.tsx`
- `frontend/src/aletheia/agentops/adapters.ts`

## Current Classification

The route is directionally aligned because it loads an existing `AletheiaMatterDetail`, derives `AgentOpsMatterWorkspace` through the adapter, and labels the view as adapter-backed matter state.

It is accepted for the current local-first adapter-backed browser path after Cycle 20 full UI smoke. It is not a persistence boundary: AgentOps view models remain derived views over Aletheia matter, review, gate, audit, and run-trace records.

## Persistence Requirements

Before downstream demo or release docs describe the live Command Center as durable product state:

1. Confirm the route fails closed when `getAletheiaMatter(matterId)` fails and does not silently fall back to `sampleAgentOpsWorkspace`.
2. Confirm provenance indicators remain visible, including source-linked evidence counts from `summarizeAdapterProvenance`.
3. Confirm the route remains read-only and does not approve/export high-risk outputs outside persisted review, checkpoint, gate, and audit flows.
4. Keep unresolved/ambiguous Big @ references, gate decisions, eval snapshots, and typed handoff records aligned with `.agentops/PERSISTENCE_SEMANTICS_PLAN.md`.
5. Reconcile the changed UI smoke snapshot with a clear owner note before final commit packaging.
6. Keep route-aware `#artifact-*` links scoped as in-page Command Center anchors until first-class artifact detail routes exist; current acceptance details live in `.agentops/ROUTE_ARTIFACT_ANCHOR_ACCEPTANCE.md`.

## Suggested Validation

Minimum code validation:

```bash
cd frontend && npx tsc --noEmit
cd frontend && npm run lint
```

Product UI validation:

```bash
cd frontend && npm run test:aletheia:ui
```

If full UI smoke is too expensive in a feature-agent cycle, the owning agent should record a Playwright/browser check for:

```text
/aletheia/matters/<local-smoke-matter-id>/agentops
```

The check should assert that the page renders `Matter Command Center`, shows `Adapter-backed matter`, and contains source-linked evidence provenance.

## Supervisor Gate

Treat the matter-scoped Command Center as accepted for the current local-first adapter-backed browser path after Cycle 20 full UI smoke. Keep the generic `/aletheia/agentops` fixture route classified as demo/prototype, and do not treat AgentOps view models as persisted source-of-truth records.

## Cycle 17 Notes

The generic repo-level `npm run lint` initially failed because generated `frontend/.next-review-studio` output was present and linted. The directory is now ignored consistently with `frontend/.next-ui-smoke`, and repo-level lint passes again. This did not validate the live Command Center route in a browser.

## Cycle 18 Notes

`frontend/tests/aletheia-ui-smoke.spec.ts` now includes assertions for the matter-scoped Command Center route, including `Adapter-backed matter`, gate checklist, eval signals, and references. The supervisor attempted to run UI smoke:

- default ports failed because `127.0.0.1:3411/health` was already used;
- `3510/3511` also collided with existing local listeners;
- `4510/4511` started web servers but failed frontend startup with missing `.next-ui-smoke/required-server-files.json`.

Current read: test coverage has been added, but browser validation is still not accepted until `npm run test:aletheia:ui` completes successfully.

## Cycle 19 Notes

The supervisor reran UI smoke on clean explicit ports:

```bash
cd frontend && ALETHEIA_UI_SMOKE_FRONTEND_PORT=4610 ALETHEIA_UI_SMOKE_BACKEND_PORT=4611 npm run test:aletheia:ui
```

This got past the earlier occupied-port and missing `.next-ui-smoke/required-server-files.json` startup failures, and the Node-level setup tests began running. Browser acceptance still failed before the Command Center assertions could be trusted:

- terminal output reported a Next invariant: missing client reference manifest for route `/aletheia/matters/[matterId]`;
- retained Playwright artifacts also show a missing `frontend/test-results/aletheia-ui-smoke-state.json` failure from the smoke-state handoff.

Current read: the matter-scoped Command Center route remains an integration candidate. It should not be described as browser-validated until a clean UI smoke run reaches and passes the route assertions for `adapter-backed-command-center`, gate checklist, eval signals, and matter references.

## Cycle 20 Notes

The supervisor reran full UI smoke on clean explicit ports:

```bash
cd frontend && ALETHEIA_UI_SMOKE_FRONTEND_PORT=4910 ALETHEIA_UI_SMOKE_BACKEND_PORT=4911 npm run test:aletheia:ui
```

Result: passed, 6 browser tests. The run covered desktop and mobile `aletheia-agentops-route.spec.ts`, `aletheia-ui-smoke.spec.ts`, and `review-studio-demo.spec.ts`. The matter workspace navigated to `/aletheia/matters/<matterId>/agentops`, direct route load also passed, and the route rendered `adapter-backed-command-center`, gate checklist, eval signals, and matter references before returning to the workspace.

Current read: browser validation is accepted for the matter-scoped local-first route. Remaining integration caution is persistence semantics, not route rendering: AgentOps remains an adapter-backed view over Aletheia matter records and run traces.

## Cycle 27 Notes

Feature statuses now report route-aware artifact anchors, adapter-backed Eval Workbench browser assertions, and richer Evidence Registry provenance display. These are accepted as reviewer navigation and visibility improvements only. Hash anchors remain in-page links, not durable artifact URLs, and Eval Workbench visibility remains view/helper-layer behavior until eval snapshots are persisted through `.agentops/EVAL_SNAPSHOT_PERSISTENCE_HANDOFF.md`.
