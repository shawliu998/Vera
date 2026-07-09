# Aletheia Worktree Handoff

Updated: 2026-07-09T08:15:21Z

## Current State

Final validation for the P0 Aletheia loop has passed. The remaining dirty worktree is expected output from parallel owner windows and should be split deliberately rather than squashed blindly.

High-frequency supervisor, orchestrator, backend-audit, and UI-smoke heartbeats may remain paused. Resume coordination only when a new feature lane starts, a validation command regresses, the dirty worktree split reveals a conflict, or post-P0 persistence hardening begins.

Detailed staging groups live in `docs/commit_plan.md`. Use that plan as the source for file-level staging commands; use this handoff as the AgentOps acceptance wrapper for whether each group is safe to package. The plan now includes a Post-P0 AgentOps addendum for the untracked Command Center, AgentOps helper, `.agentops`, and reviewer-doc files that were not covered by the older commit groups. The currently observed dirty-path bucket map lives in `.agentops/WORKTREE_SPLIT_MANIFEST.md`.

## Suggested Commit Split

1. Backend audit/gate persistence
   - `backend/src/lib/aletheia/domain.ts`
   - `backend/src/lib/aletheia/repository.ts`
   - `backend/src/lib/aletheia/localRepository.ts`
   - `backend/src/lib/aletheia/supabaseRepository.ts`
   - `backend/src/routes/aletheia.ts`
   - `backend/src/scripts/aletheiaApprovalPolicyAudit.ts`
   - `backend/src/scripts/aletheiaAuditIntegrity.ts`
   - `backend/src/scripts/aletheiaLocalRegression.ts`

2. Frontend AgentOps and trusted workspace surfaces
   - `frontend/src/aletheia/**`
   - `frontend/src/components/agentops/**`
   - `frontend/src/lib/agentops/**`
   - `frontend/src/app/aletheia/**`

3. UI smoke and frontend validation
   - `frontend/playwright.config.ts`
   - `frontend/eslint.config.mjs`
   - `frontend/tsconfig.json`
   - `frontend/tests/**`

4. Product, demo, and coordination docs
   - `.agentops/**`
   - `docs/**`
   - `README.md`
   - `.gitignore`

## Commit Split Acceptance Checklist

Before committing any group:

- inspect `git diff --stat` and `git diff --check` for that group;
- confirm the group does not silently include files from a different ownership lane;
- preserve the P0 product claim as local-first and expert-review assisted, not autonomous legal/compliance advice;
- keep preview exports, AgentOps view helpers, and local JSON downloads distinct from approved professional exports unless persisted approval/gate/audit evidence backs them.

Minimum validation by group:

| Group | Required evidence before commit |
| --- | --- |
| Backend audit/gate persistence | `cd backend && npm run build`; `cd backend && npm run check:aletheia:approval-policy`; `cd backend && npm run check:aletheia:audit-integrity`; populated audit-integrity evidence if final memo export behavior changed. |
| Frontend AgentOps and trusted workspace surfaces | `cd frontend && npm run lint`; `cd frontend && npx tsc --noEmit`; route or UI smoke evidence if visible matter, AgentOps, gate, export, or eval UI changed. |
| UI smoke and frontend validation | `cd frontend && npm run test:aletheia:ui`; confirm intentional snapshot changes are reviewed rather than accepted incidentally. |
| Product, demo, and coordination docs | `node .agentops/scripts/check-agentops.mjs`; `git diff --check`; verify docs do not claim autonomous advice, release readiness, or approved exports beyond recorded validation. |

After all groups are staged or committed, rerun the final validation block below or record any skipped command with an explicit reason in the handoff.

## Final Validation Evidence

- `cd backend && npm run check:aletheia:operator`
- `cd backend && npm run check:aletheia:source-provenance`
- `cd backend && npm run check:aletheia:approval-policy`
- `cd backend && npm run check:aletheia:run-trace`
- `cd backend && npm run check:aletheia:audit-workbench`
- `cd backend && npm run check:aletheia:audit-integrity`
- `cd frontend && npm run lint`
- `cd frontend && npx tsc --noEmit`
- `cd frontend && npm run test:aletheia:ui`
- `node .agentops/scripts/check-agentops.mjs`

Only residual warning: the default local audit-integrity DB is empty. The backend owner separately validated audit integrity against a populated local-regression data directory.

## Pause And Resume Protocol

Keep paused:

- while all `.agentops/status/*.json` lanes continue to report `done`;
- while work is limited to reviewing and splitting the current dirty worktree;
- while no new code, schema, UI route, validation gate, or export behavior is being introduced.

Resume supervisor cycles before changing:

- backend Aletheia domain, repository, routes, migrations, or audit scripts;
- frontend AgentOps adapters, exported package shape, typed handoff provenance, Gate Engine behavior, Eval Lab behavior, or matter-scoped routes;
- approval, gate, audit, export, or eval validation commands;
- release/private-pilot documentation that makes stronger product readiness claims.

On resume, start with `.agentops/SUPERVISOR_CYCLE_CHECKLIST.md`, then re-read `.agentops/STATUS_ROLLUP.md`, `.agentops/VALIDATION_BLOCKERS.md`, and this handoff before editing implementation files.
