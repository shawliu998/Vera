# Agent Status Schema

Last updated: 2026-07-09

Purpose: make feature-agent progress, blockers, tests, and contract changes machine-readable enough for the supervisor to detect conflicts across Codex windows.

Each feature agent should write exactly one status file:

```text
.agentops/status/<agent-name>.json
```

Use a stable, lowercase, hyphenated `<agent-name>` such as `workspace-ui`, `backend-domain`, `agentops-adapter`, `trust-gates`, `eval-retrieval`, or `packaging-operator`.

## Canonical Shape

```json
{
  "agent": "agentops-adapter",
  "updatedAt": "2026-07-09T14:30:00+08:00",
  "status": "progress",
  "scope": [
    "frontend/src/aletheia/agentops/adapters.ts",
    "frontend/src/aletheia/agentops"
  ],
  "summary": "Deriving AgentOpsMatterWorkspace from AletheiaMatterDetail without backend changes.",
  "contractsChanged": [
    "AgentOpsMatterWorkspace view adapter"
  ],
  "testsRun": [
    "cd frontend && npm run lint"
  ],
  "risks": [
    "Must preserve evidence source_chunk_id and review tags."
  ],
  "needs": [
    "None"
  ]
}
```

## Field Rules

- `agent`: stable name matching the filename.
- `updatedAt`: ISO timestamp with timezone.
- `status`: one of `progress`, `blocked`, `conflict`, or `done`.
- `scope`: files or ownership areas touched or expected to be touched.
- `summary`: one or two factual sentences.
- `contractsChanged`: API, schema, model, export, test, or UI contract names changed or proposed.
- `testsRun`: exact commands run. Use an empty array if none were run.
- `risks`: known risks, drift, unresolved validations, or compatibility concerns.
- `needs`: blockers, decisions, or handoff requests. Use `["None"]` only when no action is needed.

## Legacy Compatibility

Several current `.agentops/status/*.json` files use useful legacy shapes. Supervisors should read them as follows until the files are updated:

| Legacy field | Canonical field |
| --- | --- |
| `last_cycle_summary` | `summary` |
| `files_changed` | `scope` |
| `contracts_added`, `features_added`, `gates_added`, `reference_types_added`, `artifacts_supported`, `docs_added`, `eval_features_added`, `skills_features_added` | `contractsChanged` or feature contract notes |
| `tests_run` | `testsRun` |
| `blockers` | `risks` or `needs` when non-empty |
| `next_actions` | `needs` when `blockers` is empty |

That compatibility rule is temporary. The next update from each feature agent should add the canonical fields while preserving any useful detail. The supervisor rollup lives in `.agentops/STATUS_ROLLUP.md`.

## Required Before Handoff

Before a feature agent asks another agent to build on its work, it should:

1. Update its status JSON with canonical fields.
2. List every shared contract file touched or expected to be touched.
3. Record exact validation commands and results.
4. Call out whether its work is source-of-truth persistence, API contract, UI view model, fixture/demo data, or docs only.
5. Identify whether it affects the product loop:

```text
Evidence -> Issue/Risk -> Draft -> Review -> Gate -> Audit -> Eval
```
