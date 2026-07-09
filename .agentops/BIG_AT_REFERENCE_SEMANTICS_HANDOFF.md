# Big @ Reference Semantics Handoff

Last updated: 2026-07-09

Purpose: define the next persistence-semantics handoff for Big @ Context after the adapter-backed Command Center became browser-validated. Big @ can render and resolve references now; unresolved and ambiguous outcomes still need explicit review/audit semantics before they influence professional outputs.

## Current State

Current helper path:

```text
AgentOpsMatterWorkspace
-> createMatterMemoryIndex(...)
-> parseBigAtReferences(...)
-> resolveBigAtReferences(...)
-> ReferencePreviewCard / audit helper records
```

Current resolution statuses:

- `resolved`: one or more artifact refs are specific enough to attach as `referenced_artifacts`.
- `ambiguous`: candidate refs exist, but the selector is not specific enough.
- `missing`: no matter-scoped object matches.

`@Clause` is a view-level reference type over source-grounded evidence/document chunks. It must resolve back to `evidence_item` refs with source metadata; it is not a new persisted artifact type.

## Required Semantics

| Status | Allowed behavior now | Required before professional reliance |
| --- | --- | --- |
| `resolved` | Show preview and attach resolved artifact refs to view/helper records | Preserve `document_id`, `source_chunk_id`, quote offsets, support status, evidence ID, claim ID, and matter ID where available |
| `ambiguous` | Show candidate refs and message asking for a selector | Persist or expose the ambiguity as review/audit candidate before using any candidate in a draft, gate, export, or eval record |
| `missing` | Show missing-state preview and do not attach artifact refs | Persist or expose the missing reference as a blocker/open question before final reliance |

## First Acceptable Deliverable

The first Big @ persistence-semantics deliverable should be a read-only reference audit map, not new storage:

```ts
type BigAtReferenceAuditCandidate = {
  raw: string;
  type: string;
  status: "resolved" | "ambiguous" | "missing";
  source_text_owner: {
    artifact_type:
      | "draft_memo"
      | "review_comment"
      | "audit_event"
      | "agent_run"
      | "matter_memory"
      | "work_product";
    id: string;
  };
  resolved_artifact_refs: Array<{ type: string; id: string }>;
  candidate_artifact_refs: Array<{ type: string; id: string }>;
  required_review_action?: string;
};
```

Acceptance rule:

- `resolved` records may contribute `referenced_artifacts` only when the source owner and resolved artifact IDs are matter-scoped.
- `ambiguous` records must not silently choose the first candidate.
- `missing` records must not be dropped from audit/review surfaces.
- Draft, gate, export, or eval helpers must not treat ambiguous/missing references as support.

## Owner Boundaries

The `big-at-context` owner may:

- add read-only mapping helpers and focused tests;
- update `ReferencePreviewCard` labels for ambiguous/missing states;
- add status JSON evidence for exact reference states and commands.

The owner should not:

- add global memory or cross-matter reference search;
- create a new persisted `Clause` artifact type before backend/schema coordination;
- auto-attach ambiguous candidates to professional outputs;
- use missing references as evidence support;
- mutate Matter Playbooks or professional skills from Big @ references.

## Required Validation

Minimum validation for the handoff:

```bash
cd frontend && npm run lint
cd frontend && npx tsc --noEmit
cd frontend && rm -rf /tmp/aletheia-big-at-tests && npx tsc --target ES2020 --module commonjs --moduleResolution node --esModuleInterop --skipLibCheck --jsx react-jsx --outDir /tmp/aletheia-big-at-tests --rootDir . tests/agentops/references.test.ts && node --test /tmp/aletheia-big-at-tests/tests/agentops/references.test.js
cd backend && npm run check:aletheia:source-provenance
cd backend && npm run check:aletheia:audit-workbench
node .agentops/scripts/check-agentops.mjs
```

If `ReferencePreviewCard`, the matter-scoped Command Center, Review Studio, memo UI, or audit trace UI changes, also run:

```bash
cd frontend && npm run test:aletheia:ui
```

## Status JSON Requirement

The owner should update `.agentops/status/big-at-context.json` with:

- `scope` containing helpers, UI, tests, and docs touched;
- `contractsChanged` naming the audit candidate shape or equivalent;
- `testsRun` with exact pass/fail commands;
- `risks` covering ambiguous/missing references and the non-persisted `@Clause` boundary;
- `needs` only for backend persistence gaps proven by the read-only audit map.
