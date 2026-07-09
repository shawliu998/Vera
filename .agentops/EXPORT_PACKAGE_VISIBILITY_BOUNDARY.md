# Export Package Visibility Boundary

Last updated: 2026-07-09

Purpose: record the boundary for adapter-backed export package visibility and local JSON preview downloads in the matter-scoped Command Center. Visible package metadata and preview downloads are useful reviewer evidence, but they are not final professional exports, approved audit packs, or backend persistence contracts.

## Accepted Local-First Preview Boundary

Accepted:

```text
AletheiaMatterDetail + run trace records
-> AgentOps adapter
-> buildExportPackage(workspace, updated_at, { gateProvenance })
-> matter-scoped Command Center export summary / preview JSON download
```

The matter-scoped Command Center may show:

- export package hash;
- nested audit pack hash;
- manifest counts for evidence, artifacts, gates, audit events, eval cases, tool calls, and typed handoff provenance;
- linked gate/audit/eval counts derived from adapter-backed matter records;
- typed handoff provenance count;
- warnings that keep preview or blocked state visible.

The matter-scoped Command Center may offer a local browser JSON download only when it is treated as a preview inspection package. The preview package can help reviewers inspect schema shape, hashes, manifest counts, typed handoff provenance, and gate source IDs before backend export persistence exists.

## Not Accepted Yet

The visible export package summary or preview JSON download must not be treated as:

- a submitted final professional export;
- an approved audit pack;
- an approved final memo;
- a feedback dataset export ready for external use;
- a product quality claim;
- backend schema parity;
- first-class persisted export audit rows.

Those claims require repository/API persistence, approval state, and audit export provenance beyond the local view/helper layer.

## Required Before Approved Export Actions

Before adding an approved/export-submission action or backend parity, the export path must include:

- high-risk approval state for `audit_pack_export`, `feedback_dataset_export`, or `final_memo_export`;
- source IDs for matter, document, evidence, work product, review, checkpoint, audit, run, tool call, feedback export, eval case, and approved playbook records;
- `AuditExportProvenance` from `.agentops/AUDIT_EXPORT_PROVENANCE_HANDOFF.md`;
- gate provenance from `.agentops/TRUST_GATES_PERSISTENCE_HANDOFF.md`;
- Big @ reference audit candidates from `.agentops/BIG_AT_REFERENCE_SEMANTICS_HANDOFF.md`;
- typed handoff provenance from `.agentops/TYPED_HANDOFF_PROVENANCE_HANDOFF.md`;
- eval snapshot provenance from `.agentops/EVAL_SNAPSHOT_PERSISTENCE_HANDOFF.md`;
- professional skill/playbook approval provenance from `.agentops/PROFESSIONAL_SKILL_PLAYBOOK_APPROVAL_HANDOFF.md`;
- package hash, nested audit pack hash, and manifest count validation.

## Fail-Closed Conditions

Export package UI must stay preview-only or blocked, and must not present the preview JSON as an approved export, when:

- a critical gate fails, even if a human has approved a draft workflow step;
- export approval is missing;
- package integrity checks fail;
- gate provenance has unresolved source requirements;
- a Big @ reference is ambiguous or missing and is used as support;
- typed handoff provenance reports blockers;
- eval snapshots lack source review, gate, evidence, audit, feedback export, or run IDs;
- a candidate professional skill lacks human-approved playbook linkage;
- review comments or gate results are only export-scoped derived audit events and have not been persisted as backend audit rows.

## Ownership Boundary

`agentops-adapter` may keep rendering the export summary and preview JSON download in:

- `frontend/src/aletheia/RemoteMatterCommandCenter.tsx`
- `frontend/src/app/aletheia/matters/[matterId]/agentops/page.tsx`
- focused route tests

`audit-eval-export` owns local export package schema and integrity helpers in:

- `frontend/src/aletheia/agentops/exportPackage.ts`
- `frontend/tests/agentops/exportPackage.test.ts`

Coordinate before adding:

- approved export/download actions beyond local preview inspection;
- backend routes or migrations for export persistence;
- repository/API changes for export package records;
- claims that export package summaries are approved audit packs.

## UI Copy Requirement

The product copy around this surface should communicate preview status. Acceptable labels include "Preview export package", "Download preview JSON", or equivalent language. Avoid labels that imply the downloaded JSON is an approved audit pack, final memo export, feedback dataset export, or externally submitted deliverable.

## Suggested Validation

```bash
cd backend && npm run check:aletheia:operator
cd backend && npm run check:aletheia:source-provenance
cd backend && npm run check:aletheia:approval-policy
cd backend && npm run check:aletheia:audit-workbench
cd backend && npm run check:aletheia:run-trace
cd frontend && npm run lint
cd frontend && npx tsc --noEmit
cd frontend && rm -rf /tmp/aletheia-adapter-tests && npx tsc -p tests/agentops/tsconfig.adapter.json && node --test /tmp/aletheia-adapter-tests/tests/agentops/exportPackage.test.js
node .agentops/scripts/check-agentops.mjs
```
