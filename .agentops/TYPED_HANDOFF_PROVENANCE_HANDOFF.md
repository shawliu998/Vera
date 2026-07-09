# Typed Artifact Handoff Provenance Handoff

Last updated: 2026-07-09

Purpose: define the first persistence-safe typed handoff deliverable after adapter-backed workspace reference validation. Typed handoff helpers may validate and preview the Evidence -> Issue/Risk -> Draft -> Review -> Gate -> Audit -> Eval flow, but they must not become a second source of professional truth.

## Current Accepted Boundary

Accepted:

```text
AletheiaMatterDetail + run trace records
-> AgentOps adapter
-> AgentOpsMatterWorkspace
-> validateWorkspaceReferences
-> handoff preview / broken-reference report
```

Not accepted:

```text
AgentOpsMatterWorkspace
-> new final memo, audit pack, feedback export, approved skill, or gate authorization
```

Durable state must continue to come from existing Aletheia matter, document, evidence, work product, review, checkpoint, audit, run trace, feedback export, and approved playbook records until a coordinated repository/API/migration change explicitly says otherwise.

## First Deliverable

The first typed handoff persistence deliverable should be a read-only provenance map, for example:

```ts
type TypedHandoffProvenance = {
  matterId: string;
  artifactId: string;
  artifactType: ArtifactType;
  sourceRecordIds: {
    documentIds: string[];
    evidenceItemIds: string[];
    workProductIds: string[];
    reviewItemIds: string[];
    checkpointIds: string[];
    auditEventIds: string[];
    agentRunIds: string[];
    feedbackExportIds: string[];
  };
  gateResultIds: string[];
  unresolvedReferenceIds: string[];
  ambiguousReferenceIds: string[];
  warnings: string[];
};
```

This map is evidence for reviewers and export builders. It is not an approval, not a migration, and not a replacement for persisted Aletheia records.

## Required Preservation

Every handoff artifact preview must preserve the source IDs it depends on:

- documents: `document_id`, source URI/hash when available, and matter ID;
- evidence: `evidence_item_id`, `source_document_id`, `source_chunk_id`, page/section, quote offsets, support status, confidence, and reviewer status;
- issue/risk: related evidence IDs, open questions, risk level, and review status;
- draft memo: section IDs, cited evidence IDs, issue IDs, unsupported claim counts, Big @ reference records, and citation coverage;
- review: review item/comment IDs, target artifact IDs, review tags, reviewer identity, and status;
- gates: displayed `GateResult` IDs plus persisted checkpoint/review/work-product/audit IDs from `.agentops/TRUST_GATES_PERSISTENCE_HANDOFF.md`;
- audit: audit event IDs, actor, action, artifact IDs, before/after hashes, timestamp, and referenced artifacts;
- eval: source run IDs, review feedback IDs, failure type, expected behavior, and status;
- skills: candidate/approved state and human-approved playbook linkage before activation.

## Fail-Closed Rules

Typed handoff work should fail closed or remain preview-only when:

- an artifact points to missing evidence, issue, run, review, gate, or audit state;
- a Big @ reference is `ambiguous` or `missing`;
- a draft or export section depends on warning-only claim support;
- a gate is displayed from adapter state without persisted checkpoint/review/audit provenance;
- an eval case lacks a source run or review feedback record;
- a skill is still candidate-only or lacks approved Matter Playbook linkage.

## Ownership Boundary

The `typed-artifact-handoff` agent may update:

- `frontend/src/aletheia/agentops/handoff.ts`
- `frontend/tests/agentops/handoff.test.ts`
- `docs/agentops/typed-artifact-handoff.md`
- `.agentops/status/typed-artifact-handoff.json`

Coordinate before editing:

- `frontend/src/aletheia/agentops/types.ts`
- `frontend/src/aletheia/agentops/adapters.ts`
- `frontend/src/aletheia/types.ts`
- `frontend/src/app/lib/aletheiaApi.ts`
- `backend/src/lib/aletheia/domain.ts`
- `backend/src/lib/aletheia/repository.ts`
- `backend/src/routes/aletheia.ts`
- Aletheia migrations

## Required Status Update

The next `typed-artifact-handoff` status update should report:

- whether `TypedHandoffProvenance` is view-only or persisted;
- which source record IDs are preserved for each artifact type;
- whether ambiguous/missing Big @ references block handoff;
- how gate provenance maps to persisted checkpoint/review/audit state;
- the exact validation commands run.

## Suggested Validation

```bash
cd backend && npm run check:aletheia:source-provenance
cd backend && npm run check:aletheia:approval-policy
cd backend && npm run check:aletheia:audit-workbench
cd backend && npm run check:aletheia:run-trace
cd frontend && npm run lint
cd frontend && npx tsc --noEmit
cd frontend && ../backend/node_modules/.bin/tsx --test tests/agentops/handoff.test.ts
node .agentops/scripts/check-agentops.mjs
```
