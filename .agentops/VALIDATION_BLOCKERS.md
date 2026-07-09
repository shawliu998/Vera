# Validation Blockers

Last updated: 2026-07-09

Purpose: keep the current failing or unverified validation gates in one place so feature agents can unblock integration without reading every supervisor cycle.

## Blocking Current Handoff

No P0 validation blocker remains.

The final Product Orchestrator validation handoff reports:

- backend operator, source-provenance, approval-policy, run-trace, audit-workbench, and default audit-integrity checks passed;
- frontend lint and TypeScript passed;
- full Aletheia UI smoke passed with 6/6 Playwright tests;
- AgentOps checker passed;
- default audit-integrity may still warn when pointed at an empty local DB, while populated audit-integrity was separately validated by the backend owner;
- the only remaining cleanup item is the dirty worktree from completed parallel feature work.

## Nonblocking Historical Notes

| Blocker | Current evidence | Owner to update | Required next action |
| --- | --- | --- | --- |
| Direct stripped-TypeScript Node commands fail on extensionless imports | `node --test --experimental-strip-types tests/reviewStudio.test.ts` and `tests/agentops/exportPackage.test.ts` fail before assertions with `ERR_MODULE_NOT_FOUND`; equivalent `tsx` or compiled test paths pass. | `issue-risk-review`, `audit-eval-export` | Nonblocking for P0 because the canonical `tsx` or compiled validation paths pass; do not treat the direct stripped-TS commands as authoritative unless imports are intentionally updated. |

## Recently Cleared

| Item | Evidence |
| --- | --- |
| AgentOps status checker | `node .agentops/scripts/check-agentops.mjs` passed in Cycle 18 after `gate-engine` switched to canonical `status: "progress"`. |
| Adapter focused runtime validation | `cd frontend && rm -rf /tmp/aletheia-adapter-tests && npx tsc -p tests/agentops/tsconfig.adapter.json && node --test /tmp/aletheia-adapter-tests/tests/agentops/adapters.test.js` passed in Cycle 17. |
| Export package runtime validation | `cd frontend && rm -rf /tmp/aletheia-adapter-tests && npx tsc -p tests/agentops/tsconfig.adapter.json && node --test /tmp/aletheia-adapter-tests/tests/agentops/exportPackage.test.js` passed in Cycle 30 with 11 tests. |
| Review Studio runtime validation | `cd frontend && ../backend/node_modules/.bin/tsx --test tests/reviewStudio.test.ts` passed in Cycle 18 and is the reliable current command. |
| Generated `.next-review-studio` output polluting lint | `.gitignore` and `frontend/eslint.config.mjs` now ignore `frontend/.next-review-studio`; repo-level `cd frontend && npm run lint` passed after the update. |
| Earlier `.next-ui-smoke` startup artifact blocker | Cycle 19 clean-port rerun got past the previous missing `.next-ui-smoke/required-server-files.json` startup failure, so that issue is no longer the current leading blocker unless it reproduces. |
| Matter Command Center stale status | `.agentops/status/matter-command-center.json` was updated in Cycle 19 and now describes shared filters applying to both fixture-backed and adapter-backed routes; later broad smoke runs, including Cycle 32 on ports `5710/5711`, passed the matter-scoped Command Center route on desktop and mobile. |
| Live Command Center route browser validation | Cycle 20 final full UI smoke passed with `ALETHEIA_UI_SMOKE_FRONTEND_PORT=4910 ALETHEIA_UI_SMOKE_BACKEND_PORT=4911 npm run test:aletheia:ui`; route assertions for `/aletheia/matters/<matterId>/agentops` passed on desktop and mobile in both the main workspace smoke and direct route spec. See `.agentops/UI_SMOKE_ACCEPTANCE.md`. |
| Review Studio browser demo | Cycle 20 full UI smoke ran `tests/review-studio-demo.spec.ts` on desktop and mobile, both passing. |
| Browser validation evidence conflict | Cycle 20 supervisor full UI smoke now matches feature-agent browser claims for the current local-first route path. |
| UI smoke snapshot evidence | The modified desktop snapshot is backed by the passing Cycle 20 full UI smoke run; keep it as a commit-review item rather than a validation blocker. |
| Reported `artifactHref` full typecheck blocker | Cycle 26 inspected current `MatterCommandCenter` and verified it passes `artifactHref` to `AgentStatusCard`; `cd frontend && npx tsc --noEmit --incremental false` passed, then `cd frontend && npx tsc --noEmit` passed on rerun. |
| Full UI smoke recovery | Cycle 31 supervisor rerun passed with `cd frontend && ALETHEIA_UI_SMOKE_FRONTEND_PORT=5610 ALETHEIA_UI_SMOKE_BACKEND_PORT=5611 npm run test:aletheia:ui` across desktop/mobile AgentOps route, local workspace, and Review Studio demo: 6 passed. |
| Mobile Evidence Registry snapshot save | Cycle 32 rerun passed with `cd frontend && ALETHEIA_UI_SMOKE_FRONTEND_PORT=5710 ALETHEIA_UI_SMOKE_BACKEND_PORT=5711 npm run test:aletheia:ui`; mobile workspace completed `save-evidence-snapshot`, showed `matter-scoped evidence snapshot`, and had no console `Failed to fetch`. |
| Mobile Review Studio approval gate | Cycle 32 rerun passed with `cd frontend && ALETHEIA_UI_SMOKE_FRONTEND_PORT=5710 ALETHEIA_UI_SMOKE_BACKEND_PORT=5711 npm run test:aletheia:ui`; mobile Review Studio moved final export gate from `blocked` to `ready` after explicit approval, then correctly returned to `blocked` after later reviewer blocker actions. |
| Backend/audit owner status missing | Cycle 35 status sweep found `.agentops/status/backend-audit-persistence.json` with `status: "done"`. |
| Gate persistence blocker | Backend-audit status and Gate Engine status both report done; backend-audit status records backend build, approval-policy, populated audit-integrity, local regression, and focused gate test evidence. |
| Populated audit-integrity gate evidence | Cycle 35 ran `cd backend && ALETHEIA_AUDIT_SOURCE_DIR=/var/folders/21/lq2y7qwx7nz2czy8zxyyc6480000gn/T/aletheia-local-regression-1783584501904 npm run check:aletheia:audit-integrity`; it returned `ok: true`, `warnings: 0`, 3 high-risk exports, 2 gate snapshots, 1 final export gate authorization, 1 blocked final export attempt, and passing final memo gate snapshot/authorization checks. |

## Validation Commands To Keep Running

```bash
cd backend && npm run check:aletheia:operator
cd backend && npm run check:aletheia:source-provenance
cd backend && npm run check:aletheia:approval-policy
cd backend && npm run check:aletheia:run-trace
cd frontend && npm run lint
cd frontend && npx tsc --noEmit
node .agentops/scripts/check-agentops.mjs
```

Focused checks:

```bash
cd frontend && node --test --experimental-strip-types tests/reviewStudio.test.ts
cd frontend && node --test --experimental-strip-types tests/agentops/gates.test.ts
cd frontend && ../backend/node_modules/.bin/tsx --test tests/agentops/handoff.test.ts
cd frontend && rm -rf /tmp/aletheia-adapter-tests && npx tsc -p tests/agentops/tsconfig.adapter.json && node --test /tmp/aletheia-adapter-tests/tests/agentops/exportPackage.test.js
cd frontend && rm -rf /tmp/aletheia-adapter-tests && npx tsc -p tests/agentops/tsconfig.adapter.json && node --test /tmp/aletheia-adapter-tests/tests/agentops/adapters.test.js
cd frontend && rm -rf /tmp/aletheia-adapter-tests && npx tsc -p tests/agentops/tsconfig.adapter.json && node --test /tmp/aletheia-adapter-tests/tests/agentops/adapters.test.js /tmp/aletheia-adapter-tests/tests/agentops/skillsEval.test.js
cd frontend && rm -rf /tmp/aletheia-big-at-tests && npx tsc --target ES2020 --module commonjs --moduleResolution node --esModuleInterop --skipLibCheck --jsx react-jsx --outDir /tmp/aletheia-big-at-tests --rootDir . tests/agentops/references.test.ts && node --test /tmp/aletheia-big-at-tests/tests/agentops/references.test.js
```

Typed handoff persistence semantics are specified in `.agentops/TYPED_HANDOFF_PROVENANCE_HANDOFF.md`; use the `tsx` handoff test command above unless the direct Node import-resolution issue is intentionally fixed.

Eval snapshot persistence semantics are specified in `.agentops/EVAL_SNAPSHOT_PERSISTENCE_HANDOFF.md`; use the compiled adapter plus `skillsEval.test.js` command above to validate deterministic eval metrics and candidate skill behavior until a dedicated persisted snapshot test exists.

Audit/eval export provenance semantics are specified in `.agentops/AUDIT_EXPORT_PROVENANCE_HANDOFF.md`; use the compiled export package command above until export provenance has a dedicated persistence test.

Export package visibility semantics are specified in `.agentops/EXPORT_PACKAGE_VISIBILITY_BOUNDARY.md`; route-visible package hashes, manifest counts, and local preview JSON downloads are narrow UI evidence only and do not clear backend persistence parity or approved export readiness.

Full UI smoke recovery history is specified in `.agentops/UI_SMOKE_RECOVERY_PLAN.md`; final Product Orchestrator validation reports `cd frontend && npm run test:aletheia:ui` passing with 6/6 Playwright tests. Focused route tests still should not be used as substitutes for future broad smoke acceptance after relevant UI changes.

Cycle 32 refreshed full-smoke evidence on explicit ports `5710/5711` and confirmed the previously reported mobile Evidence Registry and Review Studio blockers remain cleared.
