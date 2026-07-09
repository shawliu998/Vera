# Post-Adapter Wiring Plan

Last updated: 2026-07-09

Purpose: define the first safe integration order after `agentops-adapter` satisfies `.agentops/ADAPTER_ACCEPTANCE_CHECKLIST.md`.

This plan starts only after:

```text
AletheiaMatterDetail + AletheiaAgentRunRecord[]
-> AgentOpsMatterWorkspace
```

is implemented as a frontend adapter and validated against source provenance, approval policy, and run trace checks.

## Wiring Order

| Order | Surface | First safe change | Required evidence |
| --- | --- | --- | --- |
| 1 | Matter Command Center | Replace direct `sampleAgentOpsWorkspace` rendering with adapter-derived workspace for existing matter routes or clearly label the standalone route as fixture-backed. | Adapter output preserves matter ID, document IDs, evidence IDs, review tags, audit events, and run IDs. |
| 2 | Big @ Context | Feed `createMatterMemoryIndex` and reference resolution from adapter-derived workspace. | Unresolved and ambiguous references remain visible and auditable; no silent evidence attachment. |
| 3 | Typed Artifact Handoff | Use adapter-derived evidence/issues/reviews/gates as inputs to handoff helpers. | Generated handoff artifacts retain source work product IDs, evidence provenance, and review/gate state. |
| 4 | Gate Engine | Run deterministic gates against adapter-derived draft memo, evidence, issue, risk, review, and checkpoint state. | Human approval comes from persisted checkpoints/reviews; final gate decisions create or point to audit events. |
| 5 | Skills/Eval Loop | Build eval metrics and candidate skills from adapter-derived reviews, gates, audit events, and eval cases. | Candidate skills remain candidates until mapped to human-approved matter playbooks. |

## Do Not Wire Yet

Do not wire any downstream surface if the adapter cannot prove:

- `source_chunk_id`, quote offsets, support status, and claim IDs survive mapping.
- Review tags survive without collapsing into generic statuses.
- Open checkpoints and approval decisions are preserved.
- Audit event IDs/actions/timestamps remain traceable.
- Agent run step/tool/checkpoint status remains matter-scoped.

## Validation Sequence

After each wiring step, run the smallest relevant validation:

```bash
cd frontend && npm run lint
cd backend && npm run check:aletheia:operator
```

For gate, audit, and high-risk export wiring, also run:

```bash
cd backend && npm run check:aletheia:source-provenance
cd backend && npm run check:aletheia:approval-policy
cd backend && npm run check:aletheia:audit-workbench
cd backend && npm run check:aletheia:run-trace
```

For user-facing route changes, also run:

```bash
cd frontend && npm run test:aletheia:ui
```

## Supervisor Stop Conditions

Pause downstream wiring and record a conflict if any agent:

- changes backend persistence or migrations to fit AgentOps view models before adapter proof;
- removes deterministic local fallback or private-pilot guardrails;
- claims final export readiness from UI-only state;
- introduces global professional memory or self-approving playbook changes;
- broadens public docs beyond local-first MVP/private pilot evidence.
