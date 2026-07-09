# Professional Skill Playbook Approval Handoff

Last updated: 2026-07-09

Purpose: define the persistence-safe boundary for turning eval-derived `ProfessionalSkill` records into active professional behavior. Aletheia may suggest skills from repeated expert feedback, but a skill is inactive until it maps to a human-approved Matter Playbook or approved playbook proposal.

## Current Accepted Boundary

Accepted as view/helper behavior:

```text
Review comments + gate results + eval cases
-> candidate ProfessionalSkill suggestions
-> mapSkillsToPlaybookApprovalState(...)
-> active/inactive display state
```

Not accepted:

```text
candidate ProfessionalSkill
-> active skill, global memory, playbook mutation, or future-run behavior
```

The current helper is deterministic and read-only. It does not persist playbooks, approve skills, or mutate professional rules.

## Activation Rule

A `ProfessionalSkill` may be treated as active only when all are true:

- `ProfessionalSkill.approval_status` is `approved`;
- a persisted playbook or playbook proposal maps to that skill ID;
- the playbook status is `approved`;
- the playbook has `approved_by`;
- the playbook has `approved_at`;
- the approval record is matter-scoped or otherwise explicitly governed.

All other states are inactive and require human approval.

## Required Provenance

Any eval snapshot, export package, or future run that references a professional skill must preserve:

- skill ID, name, version, and approval status;
- source eval case IDs;
- source review comment IDs or gate result IDs where available;
- mapped playbook ID;
- playbook status;
- approver identity;
- approval timestamp;
- audit event ID for the approval decision when persisted;
- matter ID or governance scope.

## Fail-Closed Rules

Skill/playbook work should fail closed or remain display-only when:

- a skill is `candidate`;
- an approved skill lacks a matching approved playbook;
- an approved playbook lacks approver identity or timestamp;
- source eval case IDs are missing;
- approval provenance cannot be linked to an audit event once persistence exists;
- the skill is presented as global professional memory without explicit governance.

## Owner Boundary

The `skills-eval-loop` owner may update:

- `frontend/src/lib/agentops/skills.ts`
- `frontend/tests/agentops/skillsEval.test.ts`
- `docs/agentops/professional-skills-loop.md`
- `.agentops/status/skills-eval-loop.json`

Coordinate before editing:

- `frontend/src/aletheia/agentops/types.ts`
- `frontend/src/aletheia/agentops/adapters.ts`
- `frontend/src/aletheia/agentops/exportPackage.ts`
- backend playbook/repository/domain/routes
- Aletheia migrations

## Required Status Update

The next skill/eval owner update should report:

- whether playbook approval state is view-only or persisted;
- which persisted playbook record shape is used;
- whether candidate skills remain inactive;
- whether approved skills preserve approval identity, timestamp, and source eval case IDs;
- the exact validation commands run.

## Suggested Validation

```bash
cd backend && npm run check:aletheia:approval-policy
cd backend && npm run check:aletheia:run-trace
cd frontend && npm run lint
cd frontend && npx tsc --noEmit
cd frontend && rm -rf /tmp/aletheia-adapter-tests && npx tsc -p tests/agentops/tsconfig.adapter.json && node --test /tmp/aletheia-adapter-tests/tests/agentops/skillsEval.test.js
node .agentops/scripts/check-agentops.mjs
```
