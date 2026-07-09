# Aletheia AgentOps Contracts

This file is the coordination contract for agents working on the Aletheia
professional AgentOps workspace. Shared TypeScript contracts live in
`frontend/src/aletheia/agentops`.

## Data Model Overview

The core workspace object is `AgentOpsMatterWorkspace`. It groups the matter,
documents, professional agents, agent runs, evidence, issues, risks, memo drafts,
review comments, gates, audit events, eval cases, and approved or candidate
skills.

Primary artifacts:

- `Matter`: professional review container with `type`, `risk_level`, `status`,
  document metadata, and timestamps.
- `ProfessionalAgent`: role-specific worker state for intake, evidence, issue,
  research, risk, memo, review, audit, and eval agents.
- `AgentRun`: traceable execution record with inputs, outputs, tool calls,
  trace events, model metadata, token usage, and errors.
- `EvidenceItem`: source-grounded quote and normalized fact with confidence,
  supported claim IDs, and review state.
- `IssueNode`: professional issue or claim node with standard, linked evidence,
  open questions, risk, and review state.
- `RiskItem`: risk register row linked to issues and evidence with severity,
  likelihood, owner, recommendation, and status.
- `DraftMemo`: structured professional deliverable with citation coverage,
  unsupported claim count, review status, and gate status.
- `ReviewComment`: human or expert feedback against any artifact.
- `GateResult`: deterministic or human approval gate outcome.
- `AuditEvent`: immutable provenance event with actor, action, artifact IDs, and
  before/after hashes.
- `EvalCase`: expert feedback converted into a testable failure case.
- `ProfessionalSkill`: candidate or approved workflow skill derived from eval
  feedback.

## Artifact Lifecycle

Artifacts should move through this general sequence:

1. Created as a draft or generated output.
2. Linked to the responsible `AgentRun.output_artifacts`.
3. Validated with `validateArtifactShape` where practical.
4. Reviewed by a human or specialist agent when risk is medium or high.
5. Checked by relevant gates.
6. Exported only when required gates pass or a human explicitly accepts the
   warning state.
7. Recorded in `AuditEvent` with an `artifact_id`, `artifact_type`, and hash.

Use `computeArtifactId` for deterministic local IDs when the persistence layer
has not assigned one yet.

## Agent Status Lifecycle

Agents should use `ProfessionalAgent.status` consistently:

```text
idle -> working -> review_needed -> waiting_for_approval -> done
                 -> blocked
                 -> failed
```

Use `blocked` only when progress requires missing material, unavailable tools, or
human direction. Put the reason in `blocked_reason` and the proposed recovery in
`next_action`.

Agent runs should use the matching `AgentRun.status` values and preserve
`tool_calls`, `trace_events`, and `errors` instead of overwriting history.

## Gate Lifecycle

Gate records are separate from artifacts so the same memo, issue map, or export
can be rechecked without mutating its source content.

Gate status meanings:

- `passed`: requirement satisfied.
- `warning`: export or review may continue only with visible caveat.
- `failed`: workflow must stop until `required_action` is handled.
- `skipped`: gate is not applicable, and `reason` must say why.

Gate types cover citation, human approval, missing material, conflict,
jurisdiction, privilege, and export checks.

## Eval Lifecycle

Expert feedback becomes an `EvalCase` when it identifies a repeatable failure:
unsupported claim, missing citation, missed issue, wrong risk level, missed
contradiction, bad memo structure, or expert override.

Eval case states:

```text
open -> triaged -> converted_to_skill -> closed
```

Only convert an eval case to a `ProfessionalSkill` when the expected behavior,
trigger conditions, required inputs, expected outputs, and evidence requirements
are specific enough for another agent to implement or test.

## Ownership Guidance

- `frontend/src/aletheia/agentops/types.ts`: shared data contracts. Keep this
  stable and additive unless coordinating a breaking change.
- `frontend/src/aletheia/agentops/schemas.ts`: lightweight serialization and
  validation helpers. Keep dependencies minimal and browser-safe.
- `frontend/src/aletheia/agentops/fixtures.ts`: demo/sample contract fixtures.
  Keep data realistic enough for UI and workflow agents to use.
- Existing `frontend/src/aletheia/types.ts` remains the current UI model. Do not
  rewrite UI imports to the AgentOps contracts unless a feature explicitly needs
  the shared artifact format.
- Backend storage adapters remain authoritative for persistence. These contracts
  define handoff shape; they do not require a new backend.

Other agents should import from `frontend/src/aletheia/agentops` when building
Matter Workspace, Agent Command Center, Typed Artifact Handoff, Gate Engine, Big
@ Context, Skills Loop, Audit Pack, or Eval Workbench features.
