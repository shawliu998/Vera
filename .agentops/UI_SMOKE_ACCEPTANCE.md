# UI Smoke Acceptance

Last updated: 2026-07-09

Purpose: record the supervisor-verified browser evidence for the Aletheia local workspace, Review Studio demo, and matter-scoped AgentOps Command Center route.

## Accepted Command

Cycle 20 final supervisor validation:

```bash
cd frontend && ALETHEIA_UI_SMOKE_FRONTEND_PORT=4910 ALETHEIA_UI_SMOKE_BACKEND_PORT=4911 npm run test:aletheia:ui
```

Result: passed, 6 browser tests.

Coverage observed in this run:

- desktop and mobile `tests/aletheia-ui-smoke.spec.ts`;
- desktop and mobile `tests/aletheia-agentops-route.spec.ts`;
- desktop and mobile `tests/review-studio-demo.spec.ts`;
- seeded local matter workspace;
- evidence search, issue review, feedback dataset approval/export, and final memo approval/export;
- navigation from matter workspace to `/aletheia/matters/<matterId>/agentops`;
- direct load of `/aletheia/matters/<matterId>/agentops`;
- `adapter-backed-command-center`;
- adapter-backed gate checklist, eval signals, and Big @ matter references;
- navigation back from Command Center to the matter workspace.

Related owner follow-up: `.agentops/status/agentops-adapter.json` now reports focused route-level Playwright coverage for direct desktop and mobile `/aletheia/matters/<matterId>/agentops` navigation. The supervisor full smoke remains the acceptance command of record.

Cycle 27 route-anchor follow-up: route-aware artifact anchors and adapter-backed Eval Workbench assertions are tracked in `.agentops/ROUTE_ARTIFACT_ANCHOR_ACCEPTANCE.md`. They extend the accepted browser surface for in-page reviewer navigation, but they do not create first-class artifact routes or persisted AgentOps source-of-truth records.

## Acceptance Scope

The matter-scoped AgentOps Command Center is accepted as browser-validated for the current local-first adapter-backed UI path.

This does not make AgentOps artifacts a new source of persisted truth. The accepted direction remains:

```text
AletheiaMatterDetail + run trace records
-> AgentOps adapter
-> Command Center / Big @ Context / Typed Handoff / Gate Engine / Eval helpers
```

## Remaining Notes

- The generic `/aletheia/agentops` route remains fixture-backed and should be treated as a demo/prototype surface.
- The modified desktop snapshot is now backed by a passing full UI smoke run, but the UI owner should still review it before final commit packaging.
- Direct stripped-TypeScript Node commands for files with extensionless source imports remain unreliable; use the recorded `tsx` or compiled commands for those focused tests.
- Route-aware `#artifact-*` links are accepted only as in-page Command Center anchors until first-class artifact detail routes exist.
