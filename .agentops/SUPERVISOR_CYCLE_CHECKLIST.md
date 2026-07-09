# Supervisor Cycle Checklist

Last updated: 2026-07-09

Purpose: keep each Aletheia supervisor cycle consistent while parallel feature agents are active.

## Required Inspection

Every cycle should inspect:

```bash
git status --short --untracked-files=all
find .agentops/status -maxdepth 1 -type f -name '*.json' -print
```

Then read:

- `.agentops/status/*.json`
- `.agentops/SUPERVISOR_STATUS.md`
- `.agentops/PRODUCT_SHAPE.md`
- `.agentops/INTEGRATION_PLAN.md`
- `.agentops/HANDOFF_QUEUE.md`
- `.agentops/CONFLICT_WATCH.md`
- `.agentops/VALIDATION_BLOCKERS.md`
- `README.md`
- `backend/package.json`
- `frontend/package.json`

Read additional docs or source files when a status report names them or a high-conflict path changed.

## Required Classification

Classify each feature-agent lane as one of:

- `done`: reported complete with useful validation.
- `working`: active or partially integrated.
- `blocked`: explicitly blocked by missing input, failed validation, or unresolved decision.
- `conflict`: changed direction threatens product loop, source-of-truth contracts, or professional trust boundaries.
- `unreported`: files changed without a matching `.agentops/status/<agent>.json`.

## Product Invariants

Every cycle should re-check:

- Aletheia is not positioned as a legal chatbot or replacement for experts.
- Product loop remains `Evidence -> Issue/Risk -> Draft -> Review -> Gate -> Audit -> Eval`.
- Source provenance keeps matter ID, document ID, source chunk ID, quote offsets, support status, and claim IDs.
- Human review and approval gates are persisted or explicitly marked prototype/helper only.
- Audit events remain the proof surface for gates, exports, and agent actions.
- Eval and skills loops preserve review tags and require human-approved playbooks.
- AgentOps view models remain derived from existing Aletheia records until a coordinated backend/API/migration plan exists.

## One Useful Improvement

Each cycle should make exactly one small additive improvement, preferably in:

- `.agentops/` coordination files
- docs that clarify current product boundaries
- narrow integration contracts
- focused test or validation planning

Avoid broad feature implementation unless required to unblock integration.

## Required Validation

Run the fast operator check every cycle:

```bash
cd backend && npm run check:aletheia:operator
```

If source, gate, audit, run-trace, or UI wiring changed, add the smallest relevant check from `.agentops/INTEGRATION_PLAN.md`.

## Required Cycle Close

Update `.agentops/SUPERVISOR_STATUS.md` with:

- what was inspected;
- feature-agent progress, blockers, or conflicts;
- the one small coordination improvement;
- validation command and result;
- current risks;
- next recommended actions.

End the user-facing report with:

```text
Done
Current risks
Next recommended actions
```
