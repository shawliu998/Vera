# Aletheia V1 Contracts

Updated: 2026-07-09

## Contract Source

The shared V1 contract layer is `frontend/src/aletheia/agentops/v1Contracts.ts`.

Feature windows must import V1 model types and helpers from this layer when they touch the V1 product chain. Existing P0 modules remain valid and are re-used by the V1 facade where their shapes already match V1 needs.

## Compatibility Rule

V1 is additive. Do not rename or narrow existing P0 fields in `frontend/src/aletheia/agentops/types.ts`, `schemas.ts`, `gates.ts`, `references.ts`, or `exportPackage.ts` unless Architecture explicitly coordinates the migration.

If a feature needs a new V1 field, add it to the V1 facade first or report schema drift in that feature's status file.

## Core Models

- P0-compatible models re-exported for V1 use: `Matter`, `EvidenceItem`, `IssueNode`, `RiskItem`, `DraftMemo`, `ReviewComment`, `GateResult`, `AuditEvent`, `AgentRun`, `ToolCall`, `EvalCase`, `ProfessionalSkill`.
- V1-only additions: `DocumentRecord`, `DocumentChunk`, `RetrievalResult`, `Claim`, `ObligationItem`, `GateSummary`, `V1WorkspaceFixture`, `V1BigAtReference`, `V1BigAtReferenceResolution`.
- Existing export package contracts remain in `frontend/src/aletheia/agentops/exportPackage.ts`.

## Shared Helpers

Use the shared helpers instead of local duplicates:

- `createDefaultMatter`
- `createDefaultAgentRun`
- `createAuditEvent`
- `calculateCitationCoverage`
- `countUnsupportedClaims`
- `summarizeGateResults`
- `canExportFinal`
- `parseBigAtReferences`
- `resolveBigAtReference`
- `createEvalCaseFromReviewComment`
- `createEvalCaseFromGateFailure`
- `createV1EvalCaseFixture`
- `createSkillCandidateFromEvalCases`
- `hashArtifact`
- `validateV1ArtifactShape`
- `createV1CompactFixture`

## Schema Guards

`validateV1ArtifactShape` covers V1-only models and delegates to the existing P0 guard for P0 artifact types. It is intentionally lightweight and dependency-free. Feature agents may add stricter module-specific validation, but must not replace these baseline shapes with incompatible local models.

## Fixture

`createV1CompactFixture` provides a compact private-pilot fixture that exercises:

`Matter -> DocumentRecord -> DocumentChunk -> RetrievalResult -> EvidenceItem -> Claim -> IssueNode -> ObligationItem -> RiskItem -> DraftMemo -> GateResult`

Use it for deterministic API-key-free checks and as the canonical minimal object graph.
