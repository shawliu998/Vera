# AgentOps Adapter Acceptance Checklist

Last updated: 2026-07-09

Purpose: define concrete evidence required before any fixture-backed AgentOps surface is treated as integrated product behavior.

The adapter must preserve this direction:

```text
frontend/src/app/lib/aletheiaApi.ts AletheiaMatterDetail
+ AletheiaAgentRunRecord[]
-> frontend/src/aletheia/agentops AgentOpsMatterWorkspace
```

Do not persist `AgentOpsMatterWorkspace` or use it to replace existing Aletheia API, repository, migration, or export contracts in the first adapter slice.

## Required Source Records

The adapter should consume only existing frontend API records:

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

## Minimum Field Mapping

| Source | Target | Required preservation |
| --- | --- | --- |
| `matter.id`, `title`, `template`, `status`, `risk_level`, `created_at`, `updated_at` | `matter` | Keep original matter ID. Template/status mappings are display-only. Default missing risk conservatively to `medium`. |
| `documents[].id`, `document_id`, `name`, `document_type`, `parsed_status`, `created_at` | `matter.documents[]` | Keep both Aletheia document row ID and source `document_id` in metadata or stable refs when available. Only map parsed documents to `indexed`. |
| `evidence[].id`, `document_id`, `source_chunk_id`, `claim_id`, `quote`, `quote_start`, `quote_end`, `relevance`, `support_status`, `confidence`, `metadata` | `evidence[]` | Do not drop source chunk IDs, quote offsets, support status, or claim IDs. Preserve original low/medium/high confidence if numeric display confidence is used. |
| `workProducts[].kind`, `content`, `status`, `validation_errors`, `id` | `issues`, `risks`, `draft_memos`, `gate_results` as applicable | Parse only known content shapes. Preserve work product IDs and validation errors. Unknown content must remain unresolved metadata, not invented artifacts. |
| `reviews[].id`, `target_type`, `target_id`, `tag`, `comment`, `reviewer_*`, `created_at` | `review_comments[]`, `eval_cases[]` candidates | Preserve review tags and targets. Do not collapse tags into generic approved/rejected state. |
| `auditEvents[].id`, `actor`, `action`, `details`, `created_at` | `audit_events[]` | Preserve IDs, actions, timestamps, actor, and details. Gate/export decisions must remain traceable to audit events. |
| `agentRuns[].id`, `status`, `workflow`, `goal`, `model_profile`, `budget`, `metadata.workflowGraph`, `steps`, `tool_calls`, `human_checkpoints` | `agents[]`, `runs[]`, `gate_results[]` helpers | Preserve run IDs, checkpoint IDs, tool-call risk/status, budget fields, specialist role labels, and errors. |
| `matterMemory[]` | Big @ / matter memory helpers | Preserve category, source, title/body, and metadata. Matter-scoped only. |
| `playbooks[]` | `skills[]` | `approved` playbooks may map to approved skills; `draft` playbooks map to candidates only. |

## Required Acceptance Evidence

Before `workspace-ui`, `gate-engine`, `big-at-context`, `typed-artifact-handoff`, or `skills-eval-loop` consume adapter output as product truth, the adapter agent must provide:

1. A canonical `.agentops/status/agentops-adapter.json`.
2. The adapter file path, expected to be `frontend/src/aletheia/agentops/adapters.ts`.
3. A fixture or test showing a real `AletheiaMatterDetail`-shaped object produces `AgentOpsMatterWorkspace`.
4. Evidence that source provenance survives: `document_id`, `source_chunk_id`, `quote_start`, `quote_end`, `support_status`, and `claim_id`.
5. Evidence that review tags survive into review/eval surfaces.
6. Evidence that human checkpoints or approval records, not UI-only booleans, control high-risk final export gates.
7. A statement that no backend migrations, API routes, or repository source-of-truth contracts changed in the first slice.

## Minimum Validation

Run the narrowest useful checks:

```bash
cd frontend && npm run lint
cd backend && npm run check:aletheia:source-provenance
cd backend && npm run check:aletheia:approval-policy
cd backend && npm run check:aletheia:run-trace
cd backend && npm run check:aletheia:operator
```

If a user-facing page consumes the adapter, also run:

```bash
cd frontend && npm run test:aletheia:ui
```

## Do Not Accept

- Direct rendering of `sampleAgentOpsWorkspace` as final product state.
- New backend persistence for AgentOps view-model statuses without a coordinated migration/API plan.
- Gate results that approve final export from `humanApproved` or local UI state alone.
- Big @ references that attach ambiguous or missing evidence without unresolved audit trace.
- Eval or skill records that drop review tags, source evidence, or human approval state.
- Global legal memory or autonomous playbook mutation.
