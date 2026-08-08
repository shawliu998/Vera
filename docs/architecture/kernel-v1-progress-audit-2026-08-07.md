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

| Batch                                 | Current result                                                             | Decisive evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Remaining gate                                                                                                                                                                                                                                          |
| ------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Immutable Task contract            | Implemented                                                                | `agent-kernel/contracts/taskContract.ts`; contract tests; route preflight before execution                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Fresh representative UI Task creation remains part of each gold workflow.                                                                                                                                                                               |
| 2. Structured outcomes/provider pause | Implemented                                                                | `outcomes/executionOutcome.ts`; retry policy and runner regressions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Re-run live provider capacity/protocol recovery in each gold workflow.                                                                                                                                                                                  |
| 3. Fixed Matter/source context        | Implemented                                                                | `context/matterContext.ts`; current-Version and cross-Matter tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Patent provider import reconciliation belongs to Batch 8.                                                                                                                                                                                               |
| 4. Step contract/capability grant     | Implemented                                                                | `contracts/stepContract.ts`; `capability/stepCapability.ts`; recovery preflight                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | No Pack-specific tool grant may be added.                                                                                                                                                                                                               |
| 5. Effect boundary/lease/transitions  | Implemented                                                                | effect, lease and atomic transition modules; SQL smoke and real Task recovery                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Direct database coupling remains frozen migration debt in five adapter files.                                                                                                                                                                           |
| 6. Verifier/repair                    | Implemented                                                                | verifier core, marker repair, repair eligibility, Artifact re-verification                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Gold-workflow semantic verifier acceptance remains pending.                                                                                                                                                                                             |
| 7. Shared Word/Tabular                | Partially implemented                                                      | exact Task Artifact Version binding; external-edit preservation; partial Tabular cell recovery; Word and Tabular tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Mac Word manifest is parsed but absent from AppCommands. Clear the complete cache only after Word closes, then perform real Host and Mike/Vera acceptance.                                                                                              |
| 8. Research connector                 | Explicit patent acquisition workflow and product recovery path implemented | provider-neutral connector contract/execution; distinct server-only `source.acquire` Step operation; pin-bound acquisition specification and request compilers; Task-checkpoint search pagination, deduplicated discoveries, coverage/issues, exact lawyer selection, ordered selected reads, validated import receipts and idempotent replay; server-owned Step dispatch with no LLM tool sequence; lease- and attempt-fenced atomic progress checkpoints; bounded source-selection endpoint reusing the existing atomic input transition; non-citable discovery versus import-only snapshot separation; CourtListener and EPO OPS Pack adapters; body-consuming central pipeline; idempotent Matter `Document`/`DocumentVersion` importer; generic provenance migration and service-only atomic commit; encrypted current-user EPO OPS credential pair; exact runtime registry with current-user authorization and credential-free receipts; Task-aware current-user acquisition bridge; explicit `builtin-patent-prior-art-acquisition` manifest and Task compiler; Mike-derived Work Task selection UI; structured missing-credential recovery action; real paused-Task/database idempotency evidence; backend 196-test and frontend 190-test regression gates | Run one current-user EPO OPS success product gate from search through selected import and downstream Word verification; then decide whether PatSnap adds material licensed coverage and run the legal-research product gate before claiming completion. |

The new `dependencyBoundary.test.ts` prevents Kernel production code from
importing routes, frontend code, or domain Packs. It also freezes the five
current direct Supabase adapter dependencies so the migration debt cannot grow
silently. The intended cleanup is to replace those concrete database types with
repository interfaces batch by batch, not to rewrite the execution system.

## Representative domain workflows

| Domain     | Gold workflow                            | Canonical outputs                                      | Current evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Missing acceptance evidence                                                                                                                                                                                                                                          |
| ---------- | ---------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contract   | `builtin-contract-playbook-review`       | revision DOCX, clean DOCX, review opinion DOCX         | Pinned first-party manifest and fixture digest; pure Contract Pack context and receipt schemas; exact contract/reference Version binding; stable server-derived finding ids; fixed `accept`/`comment`/`skip` semantics; deterministic current-opinion/disposition alignment; manifest-selected Pack verifier; structured `pack_check_gap` routed through existing lawyer review; server-issued structured Required Input with display labels and stable machine values; fixed reference bytes and exact base-plus-overlay rule identities bound server-side; fixed Contract and Playbook text preloaded by the server; provider output limited to legal findings while the server binds exact citations and stable issue codes; one bounded correction driven by structured mechanical diagnostics; exact finding citation-to-Document/Version/quote checks; material findings batched through exact `accept`/`comment`/`skip` decisions; one pure receipt-to-materialization plan for revision actions, unresolved findings and review-opinion sections; native Word comments and tracked changes; co-anchored and overlapping comments merged without weakening replacement-span uniqueness; clean copy derived by accepting the revision; accepted-view equality and no-markup checks; three creation Steps bypass drafting models and publish through existing Step effect, fixed Document/Version, Task Word receipt and ArtifactLink boundaries; fresh ordinary-user UI Task reached 6/6 and `review_required` with three current V1 DOCX Artifacts; browser preview opened all three; real revision contained six native comments, clean and opinion contained no markup, and revision/clean accepted-view SHA-256 matched; 257-test backend regression, 37-Workflow sync, dependency-boundary and backend-build gates | Resolve or deliberately skip the one remaining no-anchor finding through the product review/revision path, then perform approval, download and optional real Word handoff. The completed Task correctly remains `review_required`; it is not yet a release approval. |
| Patent     | `builtin-patentability-assessment`       | feature-chart Tabular Review/XLSX and cited memo DOCX  | Pinned first-party manifest and fixed two-artifact contract; deterministic synthetic target-claim and prior-art DOCX sources with continuous-quote expectations and explicit coverage gaps                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Run the fixture as a fresh Task, then prove both outputs, source navigation and unresolved-gap preservation.                                                                                                                                                         |
| Litigation | `builtin-litigation-hearing-preparation` | evidence inventory, objection opinion, hearing outline | Pinned first-party manifest, locked synthetic litigation DOCX, partial-cell recovery regression                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Fresh first-instance, represented-side fixture import; all three outputs in one Task; direct source/page checks; exhausted-cell recovery; lawyer review and download.                                                                                                |

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

| Candidate slice                            | Current classification          | Migration rule                                                                                                                                                                                    |
| ------------------------------------------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contractPlaybookDecisionReceipt.ts`       | Extract, do not copy whole      | Preserve its strict rule identity, version, outcome, citation and `accept`/`comment`/`skip` schemas. Separate pure Pack contracts from legacy Task checkpoint readers and compatibility parsing.  |
| `contractPlaybookOpinion.ts`               | Extract deterministic validator | Preserve opinion-to-disposition alignment. Keep DOCX rendering in the shared Artifact materializer rather than the Pack contract.                                                                 |
| `contractPlaybookWordTask.ts`              | Adapter evidence only           | Reuse exact source-span, current-Version, Matter, idempotency and external-edit invariants through shared Word/effect interfaces. Do not import its database/storage orchestration into the Pack. |
| `litigationEvidenceInventoryFields.ts`     | Extract and normalize           | Preserve single-axis field boundaries and exact citation validation. Replace prompt-only prohibitions with typed output schemas and deterministic issue codes.                                    |
| `litigationEvidenceInventory.ts`           | Split Pack from adapter         | Preserve one Task-owned Tabular Review, deterministic row identity, source pins and partial-cell recovery. Move persistence behind the existing Tabular/effect boundary.                          |
| `litigationEvidenceInventoryGeneration.ts` | Bounded model adapter evidence  | Preserve per-cell source-bound generation and reviewable gap outcome. Replace direct settings/provider/database coupling with Kernel execution inputs and structured outcomes.                    |
| legacy litigation routes/pages/stores      | Quarantine                      | Do not migrate. Shared Mike shell, Matter, Work Task, Tabular Review, Word and Artifact surfaces remain authoritative.                                                                            |

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
The live gold flow now proves ordinary-user creation through browser review, but
final approval/download and optional Word handoff remain pending before the
Contract workflow can be claimed release-complete.

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
legacy Step `result_data` retained only as a compatible source. The Task
executor now selects server-owned materialization for the three output Steps.

The pure Word materialization boundary is now implemented, regression tested,
and selected by the Task executor for exactly the three Contract creation
Steps. One receipt compiles a
stable fingerprint, exact replacement/comment actions, unresolved items, and
deterministic opinion sections. The DOCX layer writes native pending tracked
changes and classic Word comments only for unique, continuous, non-overlapping
main-story spans; ambiguous spans, hidden-story markup, no-op replacements,
and conflicting actions fail closed with
server-owned issue codes before derived bytes are returned. Main-story markup
already present in the fixed source is kept in that immutable Version; derived
outputs use its accepted view and the review opinion discloses this condition.
`contract-clean` is generated by accepting the revision and removing comments,
then proving accepted-view text equality and absence of review markup. The lawyer decision
surface now displays both the fixed source span and the exact proposed text,
so `accept` binds a visible source/replacement pair rather than an identifier
alone.

Each server-materialized Step reserves the ordinary `generate_docx` effect
identity using the fixed receipt fingerprint, source Document/Version and one
deliverable key, writes the Task Word identity into the DOCX, publishes the
reserved current Version, commits the existing effect receipt, and returns the
ordinary draft ArtifactLink. No named model tool call or separate effect state
is involved. Unsafe or unprovable materialization pauses the existing Task with
a structured issue code instead of being reported as a failed legal result. No
provider, route, new table, or new UI surface was added.

## Contract ordinary-user gold run — 2026-08-08

The fresh UI Task `d26f02d2-8c2a-4f05-bb10-56a32dff0f81` used GLM-5.2,
`01-nda-recipient.docx`, and `prc-confidentiality-v1.0.0.docx` in checklist
mode. It completed all six Steps and entered the existing lawyer-review state
with three current V1 Word Artifacts. No database edit, storage repair, manual
OOXML repair, or model-authored document mutation was used.

The run exposed and fixed five orchestration defects rather than a single
provider outage:

1. the fixed Playbook UI input was DOCX while the server accepted only a JSON
   Pack; the repository now parses the exact visible `rule_id@version` lines
   and binds every expected rule identity;
2. the analysis Step disabled tools without preloading source text, yet still
   demanded model citations; the server now preloads the exact fixed Versions
   and mechanically binds continuous contract quotes and unique Playbook rule
   blocks to citations after the model returns findings;
3. a 70-second request timeout was multiplied by same-model queue retries and
   unnecessary provider reasoning; bounded Contract extraction disables
   thinking, a server deadline stops once, and timeout preserves a resumable
   Step instead of silently repeating the expensive request;
4. harmless protocol drift consumed the only correction before substantive
   validation. The server now selects the unique typed analysis object from
   provider prose, normalizes only provable boolean/decimal drift, treats
   uncalibrated confidence as nullable observation, binds the redundant issue
   code to the fixed rule id, and sends the precise mechanical issue into the
   one allowed correction. Legal outcomes, recommendations and source quotes
   are not invented or changed;
5. two Playbook rules may properly comment on one exact or partially
   overlapping immutable contract span. Replacement spans remain unique and
   fail closed, while comment-only collisions are merged into one native Word
   comment retaining every rule id and direction.

Real Artifact inspection recorded:

- `Contract Revision.docx` V1: 839,637 bytes, 1,344 accepted-view characters,
  six native comments and no automatic replacement selected by the lawyer;
- `Contract Clean Copy.docx` V1: 835,617 bytes, zero review-markup items, and
  accepted-view SHA-256
  `4dddb8c82ffed2310aa9221ae2225ce81dcc164d76cf4665173b9591ae6c0a11`,
  exactly matching the revision accepted view;
- review opinion V1: 5,639 characters, zero review-markup items, all fixed rule
  outcomes and source markers visible in the browser, with the remaining
  no-anchor item explicitly listed for lawyer action.

The run deliberately did not click `Approve`: one `comment` disposition had no
provable exact contract anchor, so the opinion correctly retained it as an
unresolved item. A localized in-document opinion title had also produced the
generic filename `document.docx`; future materializations now preserve the
localized title while using the stable filename `Contract Review Opinion.docx`.

## Contract revision and release-gate gold run — 2026-08-08

The same ordinary-user Task `d26f02d2-8c2a-4f05-bb10-56a32dff0f81` then
completed the real lawyer revision, re-verification, approval, download, and
browser Word handoff path. The run exposed six additional orchestration defects:

1. `Request changes` collected prose but did not encode the lawyer's fixed
   `accept`/`comment`/`skip` decisions. The UI now submits one complete decision
   set, and the server binds it to the fixed Contract receipt and Versions before
   recording one existing Review Decision revision intent.
2. A disposition-only revision restarted model analysis. The server now resumes
   at the first deterministic materialization Step and skips analysis only after
   proving that the revised receipt exactly matches the bound revision intent.
3. Revision materialization created duplicate Documents. A reserved Step effect
   may now append one deterministic current Version to the same fixed deliverable
   Document with Matter, owner, compare-and-swap, and idempotency checks.
4. The generic verifier counted an unrelated earlier citation snapshot and
   permanently blocked the Contract result. A valid Contract receipt now scopes
   citation verification to its named authoritative snapshot; a missing or
   inconsistent binding still fails closed.
5. Re-verification selected a verifier from a nullable legacy database column.
   It now resolves the authoritative capability from the immutable Step Contract
   checkpoint, preserves the current Artifacts, and resumes only the existing
   verifier Step.
6. Both UI and approval code parsed the word `GAP` from a success summary and
   treated “no deterministic gap” as failure. They now use the structured Step
   receipt outcome and consult guarded text only for legacy rows where the
   structured receipt is absent.

The final canonical deliverables remained the same three Documents and advanced
from V1 to V2:

- Contract Revision V2 `7f5d5934-9775-94f4-a3b8-b46fdd5cc891` — 839,192 bytes,
  five native review-markup items;
- Contract Clean Copy V2 `234b05ba-4927-4232-449f-e2005c610bb7` — 835,596 bytes,
  zero review markup;
- Contract Review Opinion V2 `3b356943-89fd-d5f7-9360-bffcf8b65cde` — 85,076
  bytes, zero review markup.

Revision accepted view and Clean Copy body both produced SHA-256
`4dddb8c82ffed2310aa9221ae2225ce81dcc164d76cf4665173b9591ae6c0a11`.
The current approval Review Decision locked all three exact V2 ids and hashes.
All three downloads were initiated from the ordinary UI, and the revision opened
in browser Word with the exact Document and V2 in the handoff URL. One earlier
defective revision had already created a second historical group of Documents;
it is preserved rather than destructively deleted, is not the canonical current
group, and is governed by the legacy cleanup rule below.

This closes the Contract gold workflow. It does not prove the Litigation or
Patent Packs, and no Contract-specific relaxation of Matter ownership, fixed
Version, idempotency, review, approval, or export boundaries was introduced.

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

1. Extract the Litigation Pack field/row contracts and per-cell reviewable-gap
   outcome; integrate one Task-owned Evidence Inventory through the existing
   Tabular Review surface.
2. Run the litigation gold workflow, including direct source navigation and an
   exhausted-cell recovery, before removing any legacy litigation slice.
3. Run the current-user EPO OPS success gate when credentials are available,
   from search through selected import and downstream Word verification.
4. When Word is closed, complete Batch 7 Host activation and visual acceptance.
5. Reconcile the preserved dirty worktree only after each replacement slice has
   passed its gold workflow; preserve browser Word, the Word add-in, Matter,
   Artifact, Citation, Tabular Review and review/export capabilities.
