# Audit Export Provenance Handoff

Last updated: 2026-07-09

Purpose: define the first persistence-safe export handoff after AgentOps AuditPack and ExportPackage helpers gained integrity checks, eval exports, generated run audit events, and adapter-backed Command Center visibility. Export packages may assemble reviewable evidence, but they must not become a source of professional truth independent of persisted Aletheia records.

## Current Accepted Boundary

Accepted:

```text
AletheiaMatterDetail + run trace records
-> AgentOps adapter
-> AuditPack / EvalCaseExport / ExportPackage preview
-> integrity validation
```

Not accepted:

```text
ExportPackage preview
-> approved audit pack, final memo, feedback export, or product quality claim
```

Audit/eval export helpers are packaging views. They do not replace approval gates, repository records, audit events, feedback exports, or expert review.

The UI visibility boundary for the adapter-backed export package summary and local preview JSON download lives in `.agentops/EXPORT_PACKAGE_VISIBILITY_BOUNDARY.md`. That boundary permits package hashes, manifest counts, and a preview inspection download in the matter-scoped Command Center, but it does not permit approved export actions, backend parity claims, or approved audit-pack claims.

## First Deliverable

The first audit/eval export persistence deliverable should be a read-only export provenance map, for example:

```ts
type AuditExportProvenance = {
  matterId: string;
  exportPackageId: string;
  packageHash: string;
  auditPackHash: string;
  sourceRecordIds: {
    documentIds: string[];
    evidenceItemIds: string[];
    workProductIds: string[];
    reviewItemIds: string[];
    checkpointIds: string[];
    gateResultIds: string[];
    auditEventIds: string[];
    agentRunIds: string[];
    toolCallIds: string[];
    feedbackExportIds: string[];
    evalCaseIds: string[];
    approvedPlaybookIds: string[];
  };
  provenanceInputs: {
    gateProvenanceIds: string[];
    bigAtReferenceAuditCandidateIds: string[];
    typedHandoffProvenanceIds: string[];
    evalSnapshotIds: string[];
  };
  approvalState: "preview" | "approval_required" | "approved" | "blocked";
  warnings: string[];
};
```

This map is evidence for reviewers and export builders. It is not an approval, not a migration, and not a backend persistence contract by itself.

## Required Inputs Before Product Claims

Before an export package is described as complete, approved, or audit-ready, it must include or point to:

- persisted matter, document, evidence, work product, review, checkpoint, audit, run, and tool-call records;
- high-risk export approval state from existing approval policy checks;
- gate provenance from `.agentops/TRUST_GATES_PERSISTENCE_HANDOFF.md`;
- Big @ resolved/ambiguous/missing audit candidates from `.agentops/BIG_AT_REFERENCE_SEMANTICS_HANDOFF.md`;
- typed handoff provenance from `.agentops/TYPED_HANDOFF_PROVENANCE_HANDOFF.md`;
- eval snapshot provenance from `.agentops/EVAL_SNAPSHOT_PERSISTENCE_HANDOFF.md`;
- package hash and nested audit pack hash validation;
- manifest counts that agree with nested audit/eval sections.

## Fail-Closed Rules

Audit/eval export work should fail closed or remain preview-only when:

- export approval is missing for `audit_pack_export`, `feedback_dataset_export`, or `final_memo_export`;
- package, nested audit pack, or manifest integrity checks fail;
- generated run audit events are not linked back to source run IDs;
- gate provenance has unresolved source requirements;
- Big @ references are ambiguous or missing and are used as support;
- typed handoff provenance reports blockers for exported artifacts;
- eval snapshots lack source review, gate, evidence, audit, feedback export, or run IDs;
- candidate skills are exported as approved skills without human-approved playbook linkage.
- professional skill/playbook activation state is exported without the provenance required by `.agentops/PROFESSIONAL_SKILL_PLAYBOOK_APPROVAL_HANDOFF.md`.

## Ownership Boundary

The `audit-eval-export` owner may update:

- `frontend/src/aletheia/agentops/exportPackage.ts`
- `frontend/tests/agentops/exportPackage.test.ts`
- `docs/agentops/` export documentation
- `.agentops/status/audit-eval-export.json`

Coordinate before editing:

- `frontend/src/aletheia/agentops/types.ts`
- `frontend/src/aletheia/agentops/adapters.ts`
- `frontend/src/aletheia/remoteMatterTransforms.ts`
- `frontend/src/aletheia/exports.ts`
- `backend/src/lib/aletheia/domain.ts`
- `backend/src/lib/aletheia/repository.ts`
- `backend/src/routes/aletheia.ts`
- Aletheia migrations

## Required Status Update

The next `audit-eval-export` status update should report:

- whether export provenance is view-only or persisted;
- whether gate, Big @, typed handoff, and eval snapshot provenance are included;
- whether generated run audit events preserve source run IDs and stable hashes;
- whether high-risk export approval state is present;
- exact integrity and validation commands run.

## Suggested Validation

```bash
cd backend && npm run check:aletheia:source-provenance
cd backend && npm run check:aletheia:approval-policy
cd backend && npm run check:aletheia:audit-workbench
cd backend && npm run check:aletheia:run-trace
cd frontend && npm run lint
cd frontend && npx tsc --noEmit
cd frontend && rm -rf /tmp/aletheia-adapter-tests && npx tsc -p tests/agentops/tsconfig.adapter.json && node --test /tmp/aletheia-adapter-tests/tests/agentops/exportPackage.test.js
node .agentops/scripts/check-agentops.mjs
```
