# Typed Artifact Handoff

Aletheia professional agents exchange typed artifacts instead of loose summaries.
The handoff helpers live in `frontend/src/aletheia/agentops/handoff.ts` and use
the shared contracts in `frontend/src/aletheia/agentops/types.ts`.

## Pipeline

```text
Document -> EvidenceItem -> IssueNode -> RiskItem -> DraftMemo
         -> ReviewComment -> EvalCase
         -> GateResult -> AuditEvent
```

Current local helpers:

- `evidenceToIssueCandidates`: groups evidence by supported claim or issue ID
  and creates evidence-linked `IssueNode` candidates.
- `issuesToRiskRegister`: converts issues into risk register rows while
  preserving issue and evidence references.
- `evidenceAndIssuesToDraftMemo`: builds a cited draft memo whose sections link
  to both `evidence_reference_ids` and `issue_reference_ids`.
- `reviewCommentsToEvalCases`: converts unresolved expert feedback into
  repeatable eval cases traceable to a source agent run.
- `gateResultsToAuditEvents`: emits audit events for every affected artifact
  identified by a gate result.
- `validateDraftMemoDependencies`: checks that memo section evidence and issue
  references resolve against the supplied artifact sets.

## Contract Rules

- Professional claims should flow through `EvidenceItem.supports_claim_ids`.
- Memo sections should cite source evidence and the issue nodes they analyze.
- Gate results should list `affected_artifact_ids`; audit events are emitted per
  affected artifact.
- Expert review comments must identify `artifact_id` and `artifact_type`.
- Eval cases created from review feedback must preserve `source_run_id` and a
  snapshot of the reviewed artifact reference.

The sample fixtures export derived pipeline outputs so UI, gate, audit, and eval
work can validate against realistic local data without external services.
