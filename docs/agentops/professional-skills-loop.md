# Professional Skills Loop

Aletheia's skills loop is a governed improvement workflow for high-risk
professional work. It is not autonomous legal advice, and it must not silently
rewrite professional rules.

```text
Expert Review
-> Feedback Tags
-> Eval Cases
-> Candidate Skill
-> Human Approval
-> Approved Playbook Skill
-> Future Runs
-> Eval Metrics
```

## Core Rule

Expert feedback can create eval cases and candidate skill suggestions. A
candidate skill is inactive until a human explicitly approves it. Approved
skills should remain evidence-bound, auditable, versioned, and matter-scoped
unless a future governance process approves broader use.

## Eval Cases

An eval case records a repeatable failure pattern:

- `unsupported_claim`
- `missing_citation`
- `missed_issue`
- `wrong_risk_level`
- `contradiction_missed`
- `bad_memo_structure`
- `expert_override`

Each case should preserve the source run, affected artifact snapshot, expected
behavior, expert feedback, and status.

## Professional Skills

A professional skill suggestion must include:

- name and description
- trigger conditions
- required inputs
- expected outputs
- evidence requirements
- approval status
- source eval case IDs
- version

The default status for generated suggestions is `candidate`. Approved skills
must be explicit human decisions.

## Deterministic Metrics

The first local metrics are intentionally simple:

- citation coverage
- unsupported claim count
- unresolved review comments
- human override count
- gate failure count
- issue coverage when issue fixtures are available

These metrics make the loop auditable before any model-based evaluation is
introduced.

## Current Local Implementation

The local helpers live under `frontend/src/lib/agentops/`:

- `eval.ts` computes deterministic professional eval metrics.
- `skills.ts` groups repeated eval, review, and gate feedback into candidate
  skill suggestions without approving them.

The local backend completes the approval workflow:

- review resolution persists review-derived eval cases in local storage;
- `POST /aletheia/matters/:matterId/skills/approve-candidate` accepts only
  candidate skills linked to persisted eval case IDs for that matter;
- approval creates an approved, matter-scoped playbook with an active
  `professionalSkill` payload;
- the approval writes an `approved_skill_activated` audit event.

Sample eval cases and skills live in `frontend/src/aletheia/agentops/fixtures.ts`.
They demonstrate a candidate missing-citation skill and an explicitly approved
high-risk human approval export gate.

Production/global skill registry behavior is intentionally outside the V1
local-only workflow.
