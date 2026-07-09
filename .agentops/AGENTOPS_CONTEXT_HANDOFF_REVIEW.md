# AgentOps Context And Handoff Review

Last updated: 2026-07-09

Purpose: record the supervisor read on newly observed Big @ Context and Typed Artifact Handoff work.

## Observed Status Reports

`big-at-context` reports `working` in legacy status shape. It adds:

- `frontend/src/aletheia/agentops/matterMemory.ts`
- `frontend/src/aletheia/agentops/references.ts`
- `frontend/src/components/agentops/ReferencePreview.tsx`
- `frontend/tests/agentops/references.test.ts`
- `docs/agentops/big-at-context.md`

Reported tests: none.

`typed-artifact-handoff` reports `working` in legacy status shape. It adds or changes:

- `frontend/src/aletheia/agentops/types.ts`
- `frontend/src/aletheia/agentops/handoff.ts`
- `frontend/src/aletheia/agentops/fixtures.ts`
- `docs/agentops/typed-artifact-handoff.md`

Reported tests:

```bash
cd frontend && npx tsc --noEmit
cd frontend && npm run lint
```

## Supervisor Classification

Both workstreams are directionally aligned with Aletheia:

- Big @ Context supports addressable matter context and artifact references.
- Typed Artifact Handoff supports structured Evidence -> Issue/Risk -> Draft -> Review -> Gate -> Audit -> Eval movement.

They remain AgentOps/local view-layer work until they are fed by the adapter from persisted Aletheia records:

```text
AletheiaMatterDetail + run trace records
-> AgentOps adapter
-> AgentOpsMatterWorkspace
-> Big @ Context / Typed Handoff helpers
```

## Current Risks

- `big-at-context` has no reported validation command despite adding executable parser/resolver code and a test file.
- Big @ references currently resolve against `AgentOpsMatterWorkspace` fixtures/local state, not persisted Aletheia matter records.
- Typed handoff helpers can create issue, risk, memo, eval, and audit artifacts from AgentOps-native inputs; these should not bypass persisted source-linked workflows, human gates, or audit event creation.
- Both status files are legacy shape rather than canonical `.agentops/AGENT_STATUS_SCHEMA.md`.

## Required Before Integration

1. Keep `agentops-adapter` first in the handoff queue.
2. Require Big @ and typed handoff helpers to preserve `document_id`, `source_chunk_id`, quote offsets, support status, review tags, checkpoint decisions, and audit event IDs when adapter-backed.
3. Do not use Big @ resolution to silently attach ambiguous or missing evidence to professional outputs.
4. Do not use typed handoff helpers to create final memo, audit pack, feedback export, or approved skill state without persisted gate/review/audit support.
5. Ask `big-at-context` and `typed-artifact-handoff` owners to provide canonical status JSON fields on their next update.

The next Big @ handoff is specified in `.agentops/BIG_AT_REFERENCE_SEMANTICS_HANDOFF.md`: create or document a read-only map of resolved, ambiguous, and missing references before using those records as support in drafts, gates, exports, or evals.

The next typed artifact handoff is specified in `.agentops/TYPED_HANDOFF_PROVENANCE_HANDOFF.md`: create or document a read-only provenance map from handoff artifacts back to source documents, evidence, work products, reviews, checkpoints, audit events, run traces, feedback exports, and approved playbooks before treating handoff output as durable professional state.

## Suggested Validation

For Big @ Context:

```bash
cd frontend && npx tsx tests/agentops/references.test.ts
cd frontend && npm run lint
```

For Typed Artifact Handoff after adapter wiring:

```bash
cd backend && npm run check:aletheia:source-provenance
cd backend && npm run check:aletheia:approval-policy
cd backend && npm run check:aletheia:audit-workbench
cd backend && npm run check:aletheia:run-trace
cd frontend && ../backend/node_modules/.bin/tsx --test tests/agentops/handoff.test.ts
```
