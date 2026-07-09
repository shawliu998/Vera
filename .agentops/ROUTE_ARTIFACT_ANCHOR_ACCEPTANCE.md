# Route Artifact Anchor Acceptance

Last updated: 2026-07-09

Purpose: record the current acceptance boundary for Matter Command Center related-artifact anchors and Evidence Registry source-reference display. These links improve reviewer navigation inside the current adapter-backed UI, but they are not first-class artifact detail routes or persisted artifact records.

## Accepted Boundary

Accepted for the current local-first UI path:

```text
AletheiaMatterDetail
-> AgentOps adapter
-> /aletheia/matters/[matterId]/agentops
-> MatterCommandCenter artifact queue anchors
```

Fixture-backed demo route:

```text
/aletheia/agentops#artifact-*
```

Matter-scoped adapter route:

```text
/aletheia/matters/[matterId]/agentops#artifact-*
```

The route-aware hash anchors are accepted as in-page navigation into the Command Center artifact attention queue. They must not be described as durable artifact URLs, export identifiers, or persisted review/gate state.

## Required Behavior

- Generic `/aletheia/agentops` links may point to fixture-backed anchors and must stay classified as demo/prototype behavior.
- Matter-scoped `/aletheia/matters/[matterId]/agentops` links must preserve the matter ID in their href.
- Anchor IDs must be deterministic from AgentOps artifact type and artifact ID.
- Anchor targets should show enough context for expert review: artifact title, type, review/gate status, and related provenance where available.
- Evidence Registry rows must preserve source-reference visibility: normalized fact, source chunk ID, quote offsets, confidence, and sensitive flags when present.
- Eval Workbench and Candidate Skills sections may render in the matter-scoped route, but candidate skills remain inactive unless mapped to human-approved Matter Playbooks.

## Not Yet Accepted

- Hash anchors are not first-class artifact detail routes.
- Anchor navigation does not prove persistence, review approval, gate authorization, or export readiness.
- Sensitive flags remain deterministic keyword indicators, not privilege determinations.
- Eval Workbench route visibility does not make eval snapshots durable learning state.

## Owner Boundaries

`matter-command-center` may update:

- `frontend/src/components/agentops/MatterCommandCenter.tsx`
- `frontend/src/components/agentops/AgentStatusCard.tsx`
- `frontend/src/aletheia/RemoteMatterCommandCenter.tsx`
- `frontend/tests/aletheia-agentops-route.spec.ts`

`matter-document-evidence` may update:

- `frontend/src/aletheia/AletheiaEvidenceRegistry.tsx`
- source-provenance display wiring in existing matter workspace components

Coordinate before editing:

- `frontend/src/aletheia/agentops/types.ts`
- `frontend/src/aletheia/agentops/adapters.ts`
- `frontend/src/aletheia/remoteMatterTransforms.ts`
- backend Aletheia domain/repository/routes
- Aletheia migrations

## Suggested Validation

```bash
cd frontend && npm run lint
cd frontend && npx tsc --noEmit
cd frontend && ALETHEIA_UI_SMOKE_FRONTEND_PORT=5310 ALETHEIA_UI_SMOKE_BACKEND_PORT=5311 npx playwright test tests/aletheia-agentops-route.spec.ts --project=desktop-chromium
cd backend && npm run check:aletheia:source-provenance
node .agentops/scripts/check-agentops.mjs
```
