# Eval Snapshot Persistence Handoff

Last updated: 2026-07-09

Purpose: define the first persistence-safe Eval Lab handoff after deterministic eval metrics, candidate skill suggestions, and export package integrity checks landed. Eval snapshots may summarize review quality and repeated failure patterns, but they must remain traceable to expert feedback, gates, evidence, audit events, and source runs.

## Current Accepted Boundary

Accepted:

```text
AletheiaMatterDetail + run trace records
-> AgentOps adapter
-> Eval metrics / candidate skills / eval case export preview
```

Not accepted:

```text
Eval metrics or candidate skills
-> quality claim, approved skill, playbook mutation, or persisted learning signal
```

Eval helpers are useful reviewer surfaces. They do not approve professional skills, change matter playbooks, or prove product quality without persisted review, gate, audit, and feedback export records.

## First Deliverable

The first Eval Lab persistence deliverable should be a read-only snapshot record, for example:

```ts
type EvalSnapshotProvenance = {
  matterId: string;
  snapshotId: string;
  sourceRunIds: string[];
  sourceReviewCommentIds: string[];
  sourceReviewTagIds: string[];
  sourceGateResultIds: string[];
  sourceCheckpointIds: string[];
  sourceEvidenceItemIds: string[];
  sourceClaimIds: string[];
  sourceAuditEventIds: string[];
  feedbackExportIds: string[];
  candidateSkillIds: string[];
  approvedPlaybookIds: string[];
  metrics: EvalMetrics;
  warnings: string[];
};
```

This snapshot can support review and regression analysis. It is not a claim that Aletheia is legally correct, compliant, or safe for autonomous final advice.

## Required Source Linkage

Every eval snapshot must preserve:

- source run IDs and model/tool-call context;
- review comment IDs, review tags, reviewer identity, severity, status, and target artifact IDs;
- gate result IDs, checkpoint IDs, failed/warning/pass status, and required actions;
- evidence item IDs, document/source chunk IDs, quote offsets, support status, and claim IDs;
- audit event IDs for review, gate, export, candidate skill, and playbook decisions;
- feedback export IDs if the snapshot is exported;
- candidate skill IDs and their source eval case IDs;
- approved playbook IDs only when a human approval record exists, following `.agentops/PROFESSIONAL_SKILL_PLAYBOOK_APPROVAL_HANDOFF.md`.

## Fail-Closed Rules

Eval snapshot work should fail closed or remain preview-only when:

- an eval case lacks a source run;
- a metric cannot point to the reviews, gates, evidence, or issues that produced it;
- a candidate skill lacks source eval case IDs;
- an approved skill cannot map to a human-approved Matter Playbook or playbook proposal with approver identity and timestamp;
- a feedback export omits gate, review, evidence, audit, or source run provenance;
- a Big @ reference used by an eval case is ambiguous or missing;
- a typed handoff artifact used by an eval case lacks provenance from `.agentops/TYPED_HANDOFF_PROVENANCE_HANDOFF.md`.

## Ownership Boundary

The `skills-eval-loop` and future `eval-retrieval` owners may update:

- `frontend/src/lib/agentops/eval.ts`
- `frontend/src/lib/agentops/skills.ts`
- `frontend/tests/agentops/skillsEval.test.ts`
- `docs/agentops/professional-skills-loop.md`
- `.agentops/status/skills-eval-loop.json`
- `.agentops/status/eval-retrieval.json`

Coordinate before editing:

- `frontend/src/aletheia/agentops/types.ts`
- `frontend/src/aletheia/agentops/exportPackage.ts`
- `frontend/src/aletheia/agentops/adapters.ts`
- `backend/src/lib/aletheia/domain.ts`
- `backend/src/lib/aletheia/repository.ts`
- `backend/src/routes/aletheia.ts`
- Aletheia migrations

## Required Status Update

The next eval owner status update should report:

- whether eval snapshots are view-only or persisted;
- which source review, gate, evidence, audit, feedback export, and run IDs are preserved;
- whether candidate skills remain inactive until playbook approval;
- how metrics map back to source records;
- the exact validation commands run.

## Suggested Validation

```bash
cd backend && npm run check:aletheia:source-provenance
cd backend && npm run check:aletheia:approval-policy
cd backend && npm run check:aletheia:audit-workbench
cd backend && npm run check:aletheia:run-trace
cd frontend && npm run lint
cd frontend && npx tsc --noEmit
cd frontend && rm -rf /tmp/aletheia-adapter-tests && npx tsc -p tests/agentops/tsconfig.adapter.json && node --test /tmp/aletheia-adapter-tests/tests/agentops/adapters.test.js /tmp/aletheia-adapter-tests/tests/agentops/skillsEval.test.js
node .agentops/scripts/check-agentops.mjs
```
