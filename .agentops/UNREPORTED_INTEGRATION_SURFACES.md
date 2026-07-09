# Unreported Integration Surfaces

Last updated: 2026-07-09

Purpose: record late-cycle feature work that appeared without matching canonical status JSON ownership.

## Observed During Cycle 15

New or modified paths observed after initial Cycle 15 validation:

- `backend/src/lib/aletheia/domain.ts`
- `backend/src/lib/aletheia/localRepository.ts`
- `backend/src/lib/aletheia/supabaseRepository.ts`
- `backend/src/lib/aletheia/documentParser.ts`
- `frontend/src/aletheia/RemoteMatterPage.tsx`
- `frontend/src/aletheia/remoteMatterTransforms.ts`
- `frontend/src/aletheia/AletheiaWorkspace.tsx`
- `frontend/src/aletheia/reviewStudio.ts`
- `frontend/tests/reviewStudio.test.ts`
- `frontend/src/aletheia/agentops/exportPackage.ts`
- `frontend/src/aletheia/agentops/index.ts`
- `frontend/src/aletheia/agentops/adapters.ts`
- `frontend/tests/agentops/adapters.test.ts`

New `.agentops/status/matter-document-evidence.json` and `.agentops/status/agentops-adapter.json` now claim much of the backend parser/trust, remote matter transform, and adapter work.

New `.agentops/status/audit-eval-export.json` now claims the AgentOps export-package work.

New `.agentops/status/issue-risk-review.json` now claims the Review Studio work.

Cycle 17 observed additional Review Studio/export surfaces:

- `frontend/src/aletheia/exports.ts`
- `frontend/tests/review-studio-demo.spec.ts`

These are aligned with audit/eval export and Review Studio validation, but the Playwright demo spec was not executed in the current supervisor cycle.

## Supervisor Classification

These changes are directionally aligned with the product shape:

- backend parser/repository changes preserve normalized facts and sensitive-material flags;
- remote matter transforms add material checklist, source map, evidence matrix rows, and open questions from persisted `AletheiaMatterDetail`;
- review studio derives issue/risk/red-flag/gate/eval-review structures from the existing deterministic `MatterWorkspace`;
- AgentOps export package builds audit/eval export structures from `AgentOpsMatterWorkspace`.

But they touch high-risk boundaries and must stay clearly classified:

- Backend parser/repository/domain work is source-provenance and trust-layer work.
- `RemoteMatterPage` and `remoteMatterTransforms` are persisted Aletheia workspace UI selectors.
- `reviewStudio` is deterministic frontend workspace helper logic.
- `exportPackage` is AgentOps export helper logic and should not become final export authority before adapter-backed gates/audit.

## Risks

- Backend domain/repository changes can affect source provenance, evidence metadata, and Supabase/local parity.
- Sensitive-material flags must remain advisory review/gate signals unless persisted and audited.
- Review Studio state is local UI/helper state; it must not approve high-risk exports without persisted checkpoint/audit support.
- AgentOps export packages are useful helper exports, but final Audit Pack product claims require adapter-backed evidence, gates, audit events, and run traces.
- The observed adapter candidate is the correct integration shape, but downstream agents must not treat it as accepted until status ownership and validation are recorded.
- New frontend tests use `.ts` imports and depend on the current `allowImportingTsExtensions` compiler/test setup.
- Current status ownership is missing, so validation and handoff responsibilities are unclear.

## Required Follow-Up Status Files

No mandatory ownership file is missing for the originally listed late-cycle surfaces. Remaining follow-up is validation drift, route-specific UI evidence, and explicit ownership for the Review Studio export/playwright additions if they are not folded into `issue-risk-review`.

Optional split-out status files may still be useful later if `matter-document-evidence` becomes too broad:

```text
.agentops/status/backend-parser-trust.json
.agentops/status/remote-workspace-selectors.json
```

## Suggested Validation

For backend parser/repository/domain changes:

```bash
cd backend && npm run check:aletheia:source-provenance
cd backend && npm run check:aletheia:approval-policy
cd backend && npm run test:aletheia:local
```

For frontend review/export helpers:

```bash
cd frontend && npm run lint
cd frontend && npx tsc --noEmit
cd frontend && node --test --experimental-strip-types tests/reviewStudio.test.ts
```

For any visible route changes:

```bash
cd frontend && npm run test:aletheia:ui
```

## Current Supervisor Gate

Do not treat these late-cycle helpers as final product truth until:

1. ownership status JSON exists;
2. relevant validation is recorded;
3. source provenance and review tags are shown to survive;
4. final export behavior is backed by persisted review, gate, checkpoint, and audit state;
5. AgentOps export helpers are fed by the accepted adapter rather than standalone fixtures.

## Cycle 15 Validation Findings

Observed validation after this review was created:

```bash
cd backend && npm run check:aletheia:operator
cd backend && npm run check:aletheia:source-provenance
cd frontend && npm run lint
cd frontend && node --test --experimental-strip-types tests/reviewStudio.test.ts
```

Results:

- operator health passed with dirty-worktree warning;
- source provenance audit passed with 0 warnings;
- frontend lint exited successfully but reported warnings for unused Review Studio/export/remote transform imports and helpers;
- `tests/reviewStudio.test.ts` failed because `model.openQuestions` did not include `"Actual loss proof"` in the first test.

Current supervisor read: Review Studio is not validated for downstream handoff until the failing assertion or model behavior is resolved and the owning agent records status.

Additional workflow/export validation:

```bash
node .agentops/scripts/check-agentops.mjs
cd frontend && node --test --experimental-strip-types tests/agentops/exportPackage.test.ts
```

Results:

- AgentOps orchestration checker passed and warned that legacy feature-agent statuses still need canonical fields.
- `tests/agentops/exportPackage.test.ts` failed before assertions with `ERR_MODULE_NOT_FOUND` resolving `frontend/src/aletheia/agentops/types` from `agentops/index.ts`.

Current supervisor read: AgentOps export package helpers are not validated for handoff until the Node test import/runtime issue is resolved or an equivalent frontend test command is recorded by the owning agent.
