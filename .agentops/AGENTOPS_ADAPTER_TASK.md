# AgentOps Adapter Task

Last updated: 2026-07-09

Purpose: define the next integration slice for connecting the AgentOps handoff contracts to the existing Aletheia workspace without creating a second persisted model.

## Task

Create a frontend adapter/selector that derives an `AgentOpsMatterWorkspace` view model from existing Aletheia records.

Required direction:

```text
AletheiaMatterDetail + AletheiaAgentRunRecord[]
-> AgentOpsMatterWorkspace
```

Do not reverse this direction. `AgentOpsMatterWorkspace` is a UI and handoff view model until a coordinated backend schema/API migration says otherwise.

## Candidate Location

Preferred file:

```text
frontend/src/aletheia/agentops/adapters.ts
```

Optional focused tests can live next to the adapter if the frontend test setup supports it, or be covered through an existing deterministic UI/contract check.

Field-level acceptance evidence for this slice is defined in `.agentops/ADAPTER_ACCEPTANCE_CHECKLIST.md`.

## Inputs

Use existing API/client types:

- `AletheiaMatterDetail`
- `AletheiaMatterRecord`
- `AletheiaMatterDocumentRecord`
- `AletheiaWorkProductRecord`
- `AletheiaEvidenceRecord`
- `AletheiaReviewRecord`
- `AletheiaAuditEventRecord`
- `AletheiaAgentRunRecord`
- `AletheiaAgentStepRecord`
- `AletheiaToolCallRecord`
- `AletheiaHumanCheckpointRecord`
- `AletheiaMatterMemoryRecord`
- `AletheiaPlaybookRecord`

These currently live in `frontend/src/app/lib/aletheiaApi.ts`.

## Output

Return `AgentOpsMatterWorkspace` from `frontend/src/aletheia/agentops`.

The adapter should preserve source IDs and professional-review signals:

- matter ID and template;
- document IDs and parsed/index status;
- work product IDs and kinds;
- evidence IDs, `document_id`, `source_chunk_id`, quote offsets, relevance, support status, and claim IDs;
- review target IDs and review tags;
- audit event IDs/actions/timestamps;
- run IDs, step/tool/checkpoint statuses, budgets, metrics, and specialist role labels when available;
- playbook approval state and matter memory provenance.

## Normalization Rules

- Map `legal_matter_review -> legal_review`, `compliance_impact_review -> compliance_review`, and `deal_due_diligence -> due_diligence` only for view display.
- Map `in_progress -> active`, `needs_review -> review_needed`, and `completed -> closed` only for view display. Keep `waiting_for_approval` derived from open human checkpoints or failed approval gates, not from matter status.
- Map parsed documents to `indexed` only when parsing/search indexing is known to be complete; otherwise use `pending` or `failed`.
- Map run `running -> working`, `needs_human -> waiting_for_approval` or `review_needed` based on checkpoint state, and `completed -> done`.
- Convert persisted evidence confidence `low|medium|high` to display confidence conservatively, and preserve the original value in metadata if numeric confidence is introduced later.
- Preserve review tags as review comments/eval candidates; do not collapse them into a single approved/rejected status.
- Derive gate results from human checkpoints, work product status, validation errors, and audit events. Do not treat UI-only gate state as approval.
- Map approved Matter Playbooks to approved professional skills. Map draft/proposed playbooks to candidate skills.

## Acceptance Criteria

1. No backend files or migrations are required for the first adapter slice.
2. Existing `AletheiaMatterDetail` remains the source of truth.
3. The adapter preserves evidence provenance fields required by source provenance checks.
4. The adapter preserves review tags required by feedback/eval exports.
5. The adapter preserves approval/checkpoint state required by high-risk export gates.
6. The adapter can run against deterministic demo/local matter data without introducing a second demo matter universe.
7. The owning feature agent updates `.agentops/status/<agent-name>.json` with canonical fields and test results.

## Suggested Verification

```bash
cd frontend && npm run lint
cd backend && npm run check:aletheia:source-provenance
cd backend && npm run check:aletheia:approval-policy
cd backend && npm run check:aletheia:run-trace
```

Use the full UI smoke only when the adapter is rendered in a user-facing page:

```bash
cd frontend && npm run test:aletheia:ui
```
