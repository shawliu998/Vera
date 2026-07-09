# AgentOps UI And Eval Review

Last updated: 2026-07-09

Purpose: record the supervisor read on newly observed AgentOps UI and professional skills/eval work so the product remains connected to persisted Aletheia evidence, review, gate, audit, and run-trace records.

## Observed Files

New or modified files observed in this cycle:

- `frontend/src/app/aletheia/agentops/page.tsx`
- `frontend/src/components/agentops/AgentStatusCard.tsx`
- `frontend/src/components/agentops/MatterCommandCenter.tsx`
- `frontend/src/lib/agentops/eval.ts`
- `frontend/src/lib/agentops/skills.ts`
- `frontend/src/lib/agentops/index.ts`
- `frontend/src/app/aletheia/docs/page.tsx`
- `frontend/src/aletheia/AletheiaShell.tsx`
- `docs/agentops/matter-command-center.md`
- `docs/agentops/professional-skills-loop.md`
- `.agentops/status/skills-eval-loop.json`

## Status Reports

`skills-eval-loop` reports done in legacy status shape. It adds deterministic professional eval metrics, candidate skill suggestion helpers, sample eval cases/skills, and docs. Reported validations are:

```bash
cd frontend && npm run lint
cd frontend && npx tsc --noEmit
```

Canonical `agentops-adapter` status is now present. `matter-command-center` status now covers shared filters that apply to both fixture-backed and adapter-backed routes, while the matter-scoped adapter-backed route is accepted for browser rendering in `.agentops/LIVE_COMMAND_CENTER_ROUTE_REVIEW.md`.

## Supervisor Read

`MatterCommandCenter` still defaults to `sampleAgentOpsWorkspace` for the generic `/aletheia/agentops` route. A separate matter-scoped route now passes adapter-derived workspace state from `AletheiaMatterDetail` and is browser-validated in `.agentops/UI_SMOKE_ACCEPTANCE.md`.

The current safe classification is:

- Generic AgentOps Command Center UI: prototype/demo surface only.
- Matter-scoped Command Center UI: accepted for local-first adapter-backed browser rendering.
- Eval metrics and skill suggestions: view/helper layer only until derived from persisted Aletheia review, gate, audit, feedback export, and run-trace records.
- Professional skills: candidates only unless mapped to human-approved matter playbooks.
- Route-aware `#artifact-*` links: accepted as in-page Command Center artifact queue anchors, not first-class artifact routes. See `.agentops/ROUTE_ARTIFACT_ANCHOR_ACCEPTANCE.md`.

## Required Before Product Truth

Before this work is treated as product truth or used in demo claims:

1. Preserve the accepted adapter direction from `.agentops/UI_SMOKE_ACCEPTANCE.md`.
2. Replace direct `sampleAgentOpsWorkspace` product rendering with adapter-derived data or clearly label the page as a prototype/demo fixture.
3. Preserve review tags, evidence IDs, claim IDs, source chunk IDs, quote offsets, support status, checkpoint decisions, and audit events through the adapter.
4. Map candidate `ProfessionalSkill` records to draft/playbook proposals, not global autonomous skills.
5. Add canonical status JSON for `workspace-ui`, `skills-eval-loop`, or the owning agent before further handoff.

## Conflict Risk

This work could weaken product coherence if it bypasses:

```text
Evidence -> Issue/Risk -> Draft -> Review -> Gate -> Audit -> Eval
```

The specific risk is UI/eval flow over standalone AgentOps fixtures instead of persisted local matters, reviews, gates, audit records, and run traces.

## Recommended Next Step

The first eval snapshot persistence handoff is specified in `.agentops/EVAL_SNAPSHOT_PERSISTENCE_HANDOFF.md`: create or document a read-only provenance map from eval metrics and candidate skills back to source review comments, review tags, gates, checkpoints, evidence, claims, audit events, feedback exports, and source runs before treating eval output as durable learning state.

Route-aware artifact anchor acceptance is specified in `.agentops/ROUTE_ARTIFACT_ANCHOR_ACCEPTANCE.md`: preserve matter-scoped hrefs and source-reference visibility without representing hash anchors as durable artifact routes.

Use `.agentops/PERSISTENCE_SEMANTICS_PLAN.md` to define the next handoff. For any eval, skills, or UI change that promotes view-layer state toward durable professional state, run:

```bash
cd frontend && npm run lint
cd frontend && npm run test:aletheia:ui
cd backend && npm run check:aletheia:source-provenance
cd backend && npm run check:aletheia:approval-policy
cd backend && npm run check:aletheia:run-trace
```
