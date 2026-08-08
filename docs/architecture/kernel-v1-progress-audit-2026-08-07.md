# Kernel v1 progress and domain acceptance audit — 2026-08-07

Last updated: 2026-08-08

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
| 8. Research connector | Explicit patent acquisition workflow and product recovery path implemented | provider-neutral connector contract/execution; distinct server-only `source.acquire` Step operation; pin-bound acquisition specification and request compilers; Task-checkpoint search pagination, deduplicated discoveries, coverage/issues, exact lawyer selection, ordered selected reads, validated import receipts and idempotent replay; server-owned Step dispatch with no LLM tool sequence; lease- and attempt-fenced atomic progress checkpoints; bounded source-selection endpoint reusing the existing atomic input transition; non-citable discovery versus import-only snapshot separation; CourtListener and EPO OPS Pack adapters; body-consuming central pipeline; idempotent Matter `Document`/`DocumentVersion` importer; generic provenance migration and service-only atomic commit; encrypted current-user EPO OPS credential pair; exact runtime registry with current-user authorization and credential-free receipts; Task-aware current-user acquisition bridge; explicit `builtin-patent-prior-art-acquisition` manifest and Task compiler; Mike-derived Work Task selection UI; structured missing-credential recovery action; real paused-Task/database idempotency evidence; backend 196-test and frontend 190-test regression gates | Run one current-user EPO OPS success product gate from search through selected import and downstream Word verification; then decide whether PatSnap adds material licensed coverage and run the legal-research product gate before claiming completion. |

The new `dependencyBoundary.test.ts` prevents Kernel production code from
importing routes, frontend code, or domain Packs. It also freezes the five
current direct Supabase adapter dependencies so the migration debt cannot grow
silently. The intended cleanup is to replace those concrete database types with
repository interfaces batch by batch, not to rewrite the execution system.

## Representative domain workflows

| Domain | Gold workflow | Canonical outputs | Current evidence | Missing acceptance evidence |
| --- | --- | --- | --- | --- |
| Contract | `builtin-contract-playbook-review` | revision DOCX, clean DOCX, review opinion DOCX | Pinned first-party manifest and fixture digest; pure Contract Pack context and receipt schemas; exact contract/reference Version binding; stable server-derived finding ids; fixed `accept`/`comment`/`skip` semantics; deterministic current-opinion/disposition alignment; manifest-selected Pack verifier; structured `pack_check_gap` routed through existing lawyer review; server-issued structured Required Input with display labels and stable machine values; no model call before explicit contract/reference/mode/side/posture/jurisdiction/language/facts; fixed reference bytes hashed server-side; mechanically parsed base-plus-overlay count for checklist mode; bounded Contract analysis JSON with one correction attempt; exact finding citation-to-Document/Version/quote checks; durable checkpoint receipt consumed by final verification; material findings batched through exact `accept`/`comment`/`skip` decisions where free text is always a comment direction; one pure receipt-to-materialization plan for revision actions, unresolved findings and review-opinion sections; unique/non-overlapping exact-span preflight; native Word comments and tracked changes; clean copy derived by accepting the revision; accepted-view equality and no-markup checks; existing source review markup preserved and routed to review; 237-test backend regression, Workflow sync and backend build gates | Publish the server-materialized bytes through the existing Step effect, fixed Document/Version and ArtifactLink boundary; then run a fresh ordinary-user Task through UI, browser review/optional Word handoff, final verification and download without database or OOXML repair. |
| Patent | `builtin-patentability-assessment` | feature-chart Tabular Review/XLSX and cited memo DOCX | Pinned first-party manifest and fixed two-artifact contract; deterministic synthetic target-claim and prior-art DOCX sources with continuous-quote expectations and explicit coverage gaps | Run the fixture as a fresh Task, then prove both outputs, source navigation and unresolved-gap preservation. |
| Litigation | `builtin-litigation-hearing-preparation` | evidence inventory, objection opinion, hearing outline | Pinned first-party manifest, locked synthetic litigation DOCX, partial-cell recovery regression | Fresh first-instance, represented-side fixture import; all three outputs in one Task; direct source/page checks; exhausted-cell recovery; lawyer review and download. |

All three must execute through the same Matter, AgentTask/Step, ArtifactLink,
Citation, Tabular Review, Review Decision, Word and export contracts. Passing a
manifest build or a model call alone is not an end-to-end pass.

## Contract and litigation Pack convergence audit

Before this convergence slice, the clean integration branch contained provider
Packs only. Contract and litigation manifests described strong domain rules,
but those rules were not represented as server-owned Pack schemas and
validators. The Contract gap is now partially closed below; Litigation remains
prompt-only. A prompt can ask a model to preserve a disposition or evidence
axis, but cannot prove that the persisted work product did so.

A read-only inventory of the preserved dirty worktree found useful, untracked
domain experiments. They are source evidence, not accepted implementation:

| Candidate slice | Current classification | Migration rule |
| --- | --- | --- |
| `contractPlaybookDecisionReceipt.ts` | Extract, do not copy whole | Preserve its strict rule identity, version, outcome, citation and `accept`/`comment`/`skip` schemas. Separate pure Pack contracts from legacy Task checkpoint readers and compatibility parsing. |
| `contractPlaybookOpinion.ts` | Extract deterministic validator | Preserve opinion-to-disposition alignment. Keep DOCX rendering in the shared Artifact materializer rather than the Pack contract. |
| `contractPlaybookWordTask.ts` | Adapter evidence only | Reuse exact source-span, current-Version, Matter, idempotency and external-edit invariants through shared Word/effect interfaces. Do not import its database/storage orchestration into the Pack. |
| `litigationEvidenceInventoryFields.ts` | Extract and normalize | Preserve single-axis field boundaries and exact citation validation. Replace prompt-only prohibitions with typed output schemas and deterministic issue codes. |
| `litigationEvidenceInventory.ts` | Split Pack from adapter | Preserve one Task-owned Tabular Review, deterministic row identity, source pins and partial-cell recovery. Move persistence behind the existing Tabular/effect boundary. |
| `litigationEvidenceInventoryGeneration.ts` | Bounded model adapter evidence | Preserve per-cell source-bound generation and reviewable gap outcome. Replace direct settings/provider/database coupling with Kernel execution inputs and structured outcomes. |
| legacy litigation routes/pages/stores | Quarantine | Do not migrate. Shared Mike shell, Matter, Work Task, Tabular Review, Word and Artifact surfaces remain authoritative. |

The first implementation slice is therefore a pure Contract Pack contract and
deterministic disposition/opinion validator. It must import Kernel contracts or
pure utilities only, create no route/table/page, and carry no provider or
database dependency. The second slice applies the same boundary to Litigation.

That first pure slice is now implemented under `agent-packs/contract`. The
manifest verifier profile is resolved by a provider-neutral registry and the
current verification packet receives one structured `pack_check_gap` when the
receipt, lawyer disposition or opinion alignment is missing or invalid. The
generic verifier cannot clear that gap; the existing Artifact remains current
and the Task completes into the lawyer-review path. The explicit context
compiler also proves the contract/reference roles and exact Versions without
guessing from filenames.

Task submission now carries server-validated structured responses rather than
trusting the concatenated human-readable message. Before the first Contract
model call, the existing Required Input surface collects the fixed contract,
reference, review mode, contract family, represented side, negotiation posture,
jurisdiction, output language and bounded background facts. The server reads
the exact reference Version, persists its SHA-256 digest, and in checklist mode
accepts only a mechanically parsed base-plus-overlay rule count. The database
and storage adapter lives outside `agent-packs/contract`; the Pack boundary test
continues to forbid provider, route, storage and persistence dependencies.
Shared Word materialization and the live gold flow remain pending before the
Contract workflow can be claimed complete.

The structured analysis and disposition portions are now connected. The
bounded analysis Step emits one versioned JSON object and receives one bounded
correction attempt for mechanically provable schema or citation drift before
raw JSON can be persisted; the ordinary UI receives only a concise finding
summary. The server then requires
contiguous citation refs, the exact fixed contract/reference Document and
Version identities, one continuous exact contract quote, and no unused
citations before compiling the receipt. Material findings pause the first draft
Step in batches of eight. `accept` is offered only for a complete fixed source
span plus fixed proposed text; `comment` and free-text Other preserve operative
text and record direction; `skip` preserves text without a document action.
The verifier reads the durable receipt from the existing Task checkpoint, with
legacy Step `result_data` retained only as a compatible source. Shared Word
materialization is the remaining Contract implementation boundary.

The pure Word materialization boundary is now implemented and regression
tested, but is not yet published by the Task executor. One receipt compiles a
stable fingerprint, exact replacement/comment actions, unresolved items, and
deterministic opinion sections. The DOCX layer writes native pending tracked
changes and classic Word comments only for unique, continuous, non-overlapping
main-story spans; ambiguous spans, hidden-story markup, pre-existing source
review markup, no-op replacements, and conflicting actions fail closed with
server-owned issue codes before derived bytes are returned. `contract-clean`
is generated by accepting the revision and removing comments, then proving
accepted-view text equality and absence of review markup. The lawyer decision
surface now displays both the fixed source span and the exact proposed text,
so `accept` binds a visible source/replacement pair rather than an identifier
alone. No provider, database, route, new table, or new UI surface was added.

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

1. Publish the already-tested revision and clean-copy bytes plus deterministic
   opinion through the existing Step effect, fixed Document/Version,
   ArtifactLink and Task Word receipt boundary; do not add a second effect
   system or bypass current-Version recovery.
2. Run the contract gold workflow through browser review and optional Word
   handoff, then repair only gaps demonstrated by that run.
3. Extract the Litigation Pack field/row contracts and per-cell reviewable-gap
   outcome; integrate one Task-owned Evidence Inventory through the existing
   Tabular Review surface.
4. Run the litigation gold workflow, including direct source navigation and an
   exhausted-cell recovery, before removing any legacy litigation slice.
5. Run the current-user EPO OPS success gate when credentials are available,
   from search through selected import and downstream Word verification.
6. When Word is closed, complete Batch 7 Host activation and visual acceptance.
7. Reconcile the preserved dirty worktree only after each replacement slice has
   passed its gold workflow; preserve browser Word, the Word add-in, Matter,
   Artifact, Citation, Tabular Review and review/export capabilities.
