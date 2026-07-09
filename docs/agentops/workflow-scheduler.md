# Workflow Scheduler

This document defines the local-first AgentOps orchestration contract for the
P0 `red_flag_memo` path. It does not introduce an external scheduler, daemon, or
second persistence model.

## 5-Minute Agent Cycle

The conceptual scheduler cycle is:

```text
Observe -> Plan -> Act -> Persist -> Gate -> Report
```

For the current repo-local implementation, the cycle is represented as a manual
tick contract in `.agentops/orchestration/scheduler.json` with
`intervalSeconds: 300` and `startsBackgroundProcess: false`.

Every cycle must first read:

- `.agentops/PRODUCT_SHAPE.md`
- `.agentops/INTEGRATION_PLAN.md`
- `.agentops/HANDOFF_QUEUE.md`
- `.agentops/CONFLICT_WATCH.md`
- `.agentops/status/*.json`

Then it may update deterministic contracts, simulated trace files, and
`.agentops/status/workflow-scheduler.json`.

## Red Flag Memo MVP

The executable workflow contract lives at
`.agentops/workflows/red_flag_memo.v1.json`.

The ordered workflow is:

```text
extract_evidence
-> map_risks
-> draft_memo
-> review
-> gates
-> audit
-> eval
```

This maps directly to the product loop:

```text
Evidence -> Issue/Risk -> Draft -> Review -> Gate -> Audit -> Eval
```

## Runtime Contracts

- Agent Registry: `.agentops/orchestration/agent-registry.json`
- Scheduler: `.agentops/orchestration/scheduler.json`
- Run Manager: `.agentops/orchestration/run-manager-contract.json`
- Demo Run Trace: `.agentops/runs/red_flag_memo.demo.trace.json`
- Validation: `.agentops/scripts/check-agentops.mjs`

The demo run intentionally ends in `waiting_for_approval`. That is the correct
P0 posture for a high-risk red flag memo: the product can show evidence,
issue/risk mapping, draft, review requirement, gate warning, audit trace, and
eval handoff without pretending the final memo is approved.

## Validation

Run:

```bash
node .agentops/scripts/check-agentops.mjs
```

The check validates:

- canonical status shape for new status files;
- legacy status compatibility warnings for existing feature-agent files;
- red flag memo workflow node order and handoffs;
- agent registry references and high-risk disallowed tools;
- scheduler interval and no-background-process posture;
- run-manager terminal state and zero external tool-call contract;
- simulated run trace coverage, warning gate required actions, audit hashes, and
  eval handoff.

This check is intentionally dependency-free so every agent can run it before
handoff.
