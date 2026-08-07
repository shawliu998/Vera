# Kernel v1 progress and domain acceptance audit — 2026-08-07

Product authority: [`PRODUCT.md`](../../PRODUCT.md)

Architecture authority: [`vera-kernel-v1.md`](./vera-kernel-v1.md)

Implementation order: [`kernel-v1-extraction-sequence.md`](./kernel-v1-extraction-sequence.md)

This is an evidence ledger, not a release claim. `Implemented` means the current
integration branch contains the boundary and focused regression evidence.
`Pending` means the named real workflow or host acceptance has not yet been
repeated on the current branch.

## Extraction status

| Batch | Current result | Decisive evidence | Remaining gate |
| --- | --- | --- | --- |
| 1. Immutable Task contract | Implemented | `agent-kernel/contracts/taskContract.ts`; contract tests; route preflight before execution | Fresh representative UI Task creation remains part of each gold workflow. |
| 2. Structured outcomes/provider pause | Implemented | `outcomes/executionOutcome.ts`; retry policy and runner regressions | Re-run live provider capacity/protocol recovery in each gold workflow. |
| 3. Fixed Matter/source context | Implemented | `context/matterContext.ts`; current-Version and cross-Matter tests | Patent provider import reconciliation belongs to Batch 8. |
| 4. Step contract/capability grant | Implemented | `contracts/stepContract.ts`; `capability/stepCapability.ts`; recovery preflight | No Pack-specific tool grant may be added. |
| 5. Effect boundary/lease/transitions | Implemented | effect, lease and atomic transition modules; SQL smoke and real Task recovery | Direct database coupling remains frozen migration debt in five adapter files. |
| 6. Verifier/repair | Implemented | verifier core, marker repair, repair eligibility, Artifact re-verification | Gold-workflow semantic verifier acceptance remains pending. |
| 7. Shared Word/Tabular | Partially implemented | exact Task Artifact Version binding; external-edit preservation; partial Tabular cell recovery; Word and Tabular tests | Mac Word manifest is parsed but absent from AppCommands. Clear the complete cache only after Word closes, then perform real Host and Mike/Vera acceptance. |
| 8. Research connector | Pending extraction | existing citation-research manifest and legal-source implementations remain available | Introduce the provider-neutral read-only connector boundary, reconcile the patent import migration, and run focused research gates before claiming completion. |

The new `dependencyBoundary.test.ts` prevents Kernel production code from
importing routes, frontend code, or domain Packs. It also freezes the five
current direct Supabase adapter dependencies so the migration debt cannot grow
silently. The intended cleanup is to replace those concrete database types with
repository interfaces batch by batch, not to rewrite the execution system.

## Representative domain workflows

| Domain | Gold workflow | Canonical outputs | Current evidence | Missing acceptance evidence |
| --- | --- | --- | --- | --- |
| Contract | `builtin-contract-playbook-review` | revision DOCX, clean DOCX, review opinion DOCX | Pinned first-party manifest, fixed fixture digest, contract verifier profile, Word revision/clean/opinion regressions | Fresh ordinary-user Task through UI; lawyer dispositions; browser review/optional Word handoff; final verification and download without database or OOXML repair. |
| Patent | `builtin-patentability-assessment` | feature-chart Tabular Review/XLSX and cited memo DOCX | Pinned first-party manifest and fixed two-artifact contract | No workflow-specific acceptance fixture is pinned. Add a coherent synthetic invention/claim plus prior-art fixture with locator gaps before running the Task. Then prove both outputs, source navigation and unresolved-gap preservation. |
| Litigation | `builtin-litigation-hearing-preparation` | evidence inventory, objection opinion, hearing outline | Pinned first-party manifest, locked synthetic litigation DOCX, partial-cell recovery regression | Fresh first-instance, represented-side fixture import; all three outputs in one Task; direct source/page checks; exhausted-cell recovery; lawyer review and download. |

All three must execute through the same Matter, AgentTask/Step, ArtifactLink,
Citation, Tabular Review, Review Decision, Word and export contracts. Passing a
manifest build or a model call alone is not an end-to-end pass.

## Legacy cleanup rule

The earlier Aletheia civil-litigation workbench, dedicated routes and local
stores are not the target architecture. They remain quarantined source evidence
until the litigation gold workflow proves that the shared surfaces retain the
needed case semantics and deliverables. Cleanup then proceeds by dependency
slice:

1. identify callers and data still used by the shared Mike shell;
2. move reusable pure domain semantics into a Litigation Pack profile;
3. replace callers with existing Matter/Task/Artifact/Tabular/Word surfaces;
4. run the litigation gold workflow and shared regressions;
5. remove only the now-unreachable route, component and store slice.

Do not bulk-delete the legacy stack and do not build a second clean-room
application. Browser Word, the Word add-in, Mike-derived shared surfaces,
document/version storage, citations, and existing review/export controls are
preserved release capabilities.

## Next execution order

1. When Word is closed, complete Batch 7 Host activation and visual acceptance.
2. Pin a workflow-specific patentability fixture and extend manifest validation.
3. Run fresh contract, patentability and litigation Tasks through the product UI.
4. Extract the Batch 8 connector boundary and reconcile patent source import.
5. Use the gold-flow evidence to remove legacy Aletheia slices incrementally.
