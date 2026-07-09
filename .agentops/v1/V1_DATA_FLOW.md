# Aletheia V1 Data Flow

Updated: 2026-07-09

## Product Chain

```text
Document -> Evidence -> Issue/Risk/Obligation -> Draft -> Review -> Gate -> Audit -> Eval -> Skill Candidate
```

## Contracted Flow

1. `DocumentRecord` captures imported file metadata, parse status, hash, and parser outcome.
2. `DocumentChunk` stores matter-scoped source text with page, section, offsets, and optional hash.
3. `RetrievalResult` links a query result to document and chunk IDs with score, preview, method, and ranking basis.
4. `EvidenceItem` records the source quote, normalized fact, chunk/document link, support status, and review state.
5. `Claim`, `IssueNode`, `RiskItem`, and `ObligationItem` map source-backed facts into professional analysis surfaces.
6. `DraftMemo` sections must cite evidence IDs and track unsupported claim counts.
7. `ReviewComment` attaches expert feedback to an artifact and can be converted into an `EvalCase`.
8. `GateResult` blocks or warns on citation, human approval, missing material, conflict, scope, privilege, external-source, and export readiness.
9. `AuditEvent`, `AgentRun`, and `ToolCall` preserve provenance, tool usage, and model/runtime traces.
10. `EvalCase` and `ProfessionalSkill` turn expert feedback and failures into human-approved skill candidates.

## Export Rule

Final export must call `summarizeGateResults` or `canExportFinal` and fail closed when any gate has `status: "failed"` or the export gate is not passed.

Draft exports may proceed with warnings, but the warnings must remain visible in the work product or export manifest.
