# Aletheia Gate Engine

The Gate Engine is a local-first, deterministic review layer for professional
outputs. It evaluates shared AgentOps artifacts and returns `GateResult[]`
records that can be shown in UI, persisted in audit history, or checked before
export.

## Current Surface

`frontend/src/aletheia/agentops/gates.ts` exports:

- `runGates(input): GateResult[]`
- `calculateCitationCoverage(memo, evidence)`
- `findUnsupportedClaims(memo, evidence)`
- `hasUnresolvedReviewComments(reviewComments, artifactIds?)`
- `hasMissingMaterials({ matter, issues, risks })`
- `canExportFinal(gateResults)`

The engine accepts `Matter`, `DraftMemo`, `EvidenceItem`, `IssueNode`,
`RiskItem`, and `ReviewComment` records. It does not call a model or remote
service.

## Gate Behavior

- Citation: fails when memo sections lack valid `EvidenceItem` references or
  carry explicit unsupported-claim counts.
- Human approval: high-risk final export fails unless the memo is approved or
  `humanApproved` is supplied.
- Missing material: fails high-risk or final export when pending documents,
  failed documents, issue open questions, or missing-material risk markers
  remain.
- Conflict: fails when conflict markers are present in evidence, issues, risks,
  or open review comments.
- Jurisdiction / scope: fails final or high-risk export when standards are blank
  or explicitly unclear.
- Privilege / confidentiality: warns when privileged, confidential, or sensitive
  markers are detected.
- Export: draft export is allowed with visible gate status; final export passes
  only when critical gates have no failures.

## UI

`frontend/src/components/agentops/GateChecklist.tsx` renders a compact checklist
from `GateResult[]` and labels whether final export is ready or blocked.

## Tests

Run the focused tests with:

```bash
cd frontend && node --test --experimental-strip-types tests/agentops/gates.test.ts
```
