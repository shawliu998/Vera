# AgentOps Helpers Review

Last updated: 2026-07-09

Purpose: record the supervisor read on newly observed AgentOps helper files so they are not confused with the queued Aletheia-to-AgentOps adapter.

## Observed Files

New untracked files appeared under `frontend/src/aletheia/agentops/`:

- `agentStatus.ts`
- `handoff.ts`

They are not currently represented in `.agentops/status/architecture-contracts.json`, which still lists only `types.ts`, `schemas.ts`, `fixtures.ts`, and `index.ts`.

## Supervisor Classification

`frontend/src/aletheia/agentops/agentStatus.ts`:

- Builds command-center display models from an existing `AgentOpsMatterWorkspace`.
- Uses AgentOps-native roles, statuses, artifacts, gate results, review state, and eval cases.
- Useful for future Agent Command Center UI after an adapter exists.
- Not a source-of-truth persistence layer.
- Not the adapter from existing Aletheia records.

`frontend/src/aletheia/agentops/handoff.ts`:

- Creates AgentOps-native issue candidates, risk register rows, draft memos, eval cases, and audit events from AgentOps-native inputs.
- Useful as deterministic handoff helpers inside the AgentOps view layer.
- Potentially risky if used as the primary Evidence -> Issue/Risk -> Draft generator instead of existing source-linked Aletheia workflows.
- Not the adapter from `AletheiaMatterDetail` / run trace records.

## Integration Boundary

These helpers sit after the adapter boundary:

```text
AletheiaMatterDetail + run trace records
-> AgentOps adapter
-> AgentOpsMatterWorkspace
-> agentStatus / handoff helpers
-> optional UI view models
```

They should not be wired directly to persisted backend routes, final export paths, approval gates, or Eval Lab outputs until the adapter proves that source IDs, review tags, checkpoint decisions, audit events, and run trace data are preserved.

## Required Follow-Up

1. The owning feature agent should update `.agentops/status/architecture-contracts.json` or create a new canonical status file that includes `agentStatus.ts` and `handoff.ts`.
2. The handoff queue should keep `agentops-adapter` as the next unblocker.
3. Future UI work can use `agentStatus.ts` only after adapter output exists.
4. Future generation or Eval Lab work should treat `handoff.ts` as a view-layer helper unless backend/domain owners explicitly adopt its outputs into persisted workflows.

## Suggested Validation If These Helpers Are Wired

```bash
cd frontend && npm run lint
cd backend && npm run check:aletheia:source-provenance
cd backend && npm run check:aletheia:approval-policy
cd backend && npm run check:aletheia:run-trace
```
