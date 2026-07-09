# Matter Command Center

The Matter Command Center is a read-only product surface for Aletheia's
professional AgentOps workflow. It is intentionally not a chatbot or terminal
multiplexer. It shows which professional agents are active on a matter, what
they produced, where they are blocked, and where human expertise is required.

Current route:

```text
/aletheia/agentops
```

Current implementation:

- `frontend/src/app/aletheia/agentops/page.tsx`
- `frontend/src/components/agentops/MatterCommandCenter.tsx`
- `frontend/src/components/agentops/AgentStatusCard.tsx`
- `frontend/src/aletheia/agentops/agentStatus.ts`
- `frontend/src/aletheia/agentops/fixtures.ts`

## Workflow Shape

The command center presents the product loop as:

```text
Intake -> Evidence -> Issue/Risk -> Memo -> Review -> Gate -> Audit -> Eval
```

Agent cards currently cover:

- Intake Agent: normalizes matter scope, parties, objectives, and inventory.
- Evidence Agent: extracts source-backed facts and routes pending quotes for
  review.
- Issue Agent: maps issues and open questions to evidence.
- Research Agent: checks professional standards, and blocks when required
  material is missing.
- Risk Agent: scores severity, likelihood, owner, and mitigation work.
- Memo Agent: produces the draft work product and holds it behind gates.
- Review Agent: coordinates expert comments and revision needs.
- Audit Agent: records provenance and run trace artifacts.
- Eval Agent: converts expert feedback into badcases and candidate skills.

## Status Semantics

Each card uses `ProfessionalAgent.status` from
`frontend/src/aletheia/agentops/types.ts`:

```text
idle | working | blocked | review_needed | waiting_for_approval | done | failed
```

Blocked agents must show `blocked_reason` and a recovery-oriented `next_action`.
Review-needed agents point to related artifacts such as evidence, memo sections,
review comments, gates, or eval cases. Done agents link to produced artifacts in
the page artifact queue when fixture output artifacts are present.

## Data Source

This cycle uses `sampleAgentOpsWorkspace` fixture data rather than a fake
backend. The UI derives card state with `buildMatterCommandCenterModel`, which
accepts the shared `AgentOpsMatterWorkspace` contract. A persistence adapter can
replace the fixture later without changing the dashboard component contract.

## Next Integration Points

- Adapt live `AletheiaMatterDetail` records into `AgentOpsMatterWorkspace`.
- Replace in-page artifact anchors with matter-specific artifact routes when
  those routes exist.
- Add filters for blocked, review-needed, and completed agents.
- Add visual linkage from gate failures to the exact memo sections or evidence
  items that must be reviewed.
