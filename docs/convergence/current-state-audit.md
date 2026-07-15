# Vera Legal Matter Agent Convergence — Current-State Audit

> Historical evidence notice (2026-07-16): this audit remains the detailed
> source record for the `12af6fc5` v14 baseline. The canonical forward product
> decisions and Gate sequence now live in
> `docs/adr/vera-product-convergence.md` and
> `docs/roadmap_legal_workspace.md`. Later commits on the feature branch have
> already isolated Legacy and added Workspace migration v15.

Date: 2026-07-16
Audited baseline: `main` / `origin/main` at
`12af6fc53317e96314a980250d3bd12d5bfd3bcb`
Audit method: source, migrations, routes, runtime composition, UI clients,
tests, local Git provenance, and executable baseline gates; README claims were
not accepted without code/test evidence.

Line references in this document refer to the audited baseline above. Phase 1
changes may move the same code.

## 1. Executive finding

The active Mike-derived Workspace is real, local, encrypted, and substantially
more advanced than a static shell: Project/document persistence, durable
Assistant, workflows, tabular execution, immutable source snapshots and
citation anchors, OCR provenance, Document Studio CAS/versioning/suggestions,
model settings, and packaged desktop security all have executable gates.

The repository is not yet one converged product runtime. The principal blocking
fact is that the production desktop backend still loads and mounts Legacy
Aletheia alongside Workspace on every normal start. Router construction opens
Legacy database handles and initializes model/voice control objects; bootstrap
also configures the Legacy durable runtime. Hiding `/aletheia/*` from the main
navigation did not isolate it.

The current Workspace schema is v14, not the older v8 state suggested by parts
of history. The next additive migration must be v15. None of MatterProfile,
Matter Artifact, unified Review Inbox, Work Queue, Conversations, bounded legal
Agent Run, validation/stale, Word bridge state, or Legacy migration ledgers
exists in the active Workspace schema today.

## 2. Classification vocabulary

| Label | Meaning in this audit |
| --- | --- |
| `reuse` | Keep the implementation and its tested contract as an active foundation. |
| `adapt` | Extend or move the implementation while retaining one canonical owner. |
| `migrate` | Transform existing data/contract into the target model with lineage. |
| `isolate` | Keep for compatibility/tests, but remove from default active composition. |
| `delete-later` | Delete only after data, backup, replacement, and regression gates pass. |
| `do-not-use` | Must not become a dependency or state boundary of the converged product. |

## 3. Workspace schema

### Confirmed version

`backend/src/lib/workspace/migrations/index.ts:1-60` registers a strict,
contiguous v1-v14 chain:

```text
v1  initial Workspace
v2  Workspace integrity
v3  Workspace runtime
v4  Project ownership
v5  Assistant runtime
v6  Workflow runtime
v7  Mike tabular semantics
v8  model credential origin
v9  model connection readiness
v10 durable Assistant events
v11 Project source foundation
v12 Document Studio
v13 source retention lifecycle
v14 Document Studio suggestions
```

The executable migration audit reported `current_version: 14`, ordered
SHA-256 checksums, idempotent rerun, transactional rollback, v1/v2/v3/v6
upgrade coverage, SQLite/SQLCipher integrity, and preservation of a Legacy
Aletheia sentinel table and row.

Classification: v1-v14 runner and invariants are `reuse`; new legal domain
tables are `adapt` starting at v15; editing an old migration is `do-not-use`.

### Missing target tables

No active Workspace migration defines any of the following:

```text
matter_profiles, matter_policies
matter_artifacts, artifact_revisions, artifact_source_links, artifact_relations
review_items, review_decisions
work_items, work_item_links
conversation_sessions, conversation_participants, transcript_segments,
speaker_bindings, conversation_extractions, conversation_processing_runs
validation_runs, validation_findings, artifact_dependencies, stale_markers
agent_runs, agent_run_events, agent_tool_calls, agent_approvals,
agent_artifact_proposals
word_document_bindings, word_sync_sessions, word_operations
legacy_migration_runs, legacy_migration_items, legacy_migration_errors
```

Legacy has similarly named capabilities, but those are not acceptable as new
Workspace storage. New modules writing Legacy tables are `do-not-use`.

## 4. Current `/api/v1` surface

`backend/src/veraApplication.ts:451-499` builds one authenticated Router,
applies the audit mutation guard, and mounts it exactly once at `/api/v1`.
Ordering deliberately keeps workflow routes ahead of generic `:id` routes.

The confirmed route families are:

| Family | Current routes | Evidence / classification |
| --- | --- | --- |
| Projects | `GET/POST /projects`; `GET/PATCH/DELETE /projects/:projectId`; archive/unarchive | `workspaceV1.ts:921-1004`; `reuse` technical boundary, `adapt` product naming. |
| Project documents/folders | list/upload/update/version/retry/delete documents; CRUD folders | `workspaceV1.ts:1008-1197`; `reuse`. |
| Global documents | `/documents/**`, `/single-documents/**`, read/display/url/download/retry/version/delete | `workspaceV1.ts:684-919,1199-1200`; `reuse` compatibility. |
| Download capability | `GET /downloads/:token` | `workspaceV1.ts:1201-1213`; `reuse`. |
| Chats/Assistant | `/chat`, Project chats, create/detail/update/delete; generation submit; durable job list/detail/events/cancel/retry/regenerate | `workspaceChatsV1.ts:348-632`; `reuse` runtime, `adapt` outputs to Proposal/Review. |
| Workflows | CRUD, capabilities, hidden state, definition, runs; run detail/cancel/retry | `workspaceWorkflowsV1.ts:410-631`; `reuse` runtime, `adapt` legal steps/review outputs. |
| Tabular | list/create/detail/update/delete, clear/generate/regenerate/cancel, optional chat routes, export | `workspaceTabularV1.ts:403-611`; `reuse` as Matter Work; global UI becomes compatibility. |
| Settings/models | settings status/read/update; model profiles; write-only credential; test/activate/deactivate; delete | `workspaceSettingsV1.ts:534-671`; `reuse`, then `adapt` privacy profile. |
| Sources | capture document snapshot; list/detail/content; create anchor | `workspaceProjectSourcesV1.ts:435-528`; strong `reuse`, then `adapt` source kinds/locators. |
| Studio | create, Assistant/Workflow handoff, get/CAS save, DOCX import/export, versions, suggestions, accept/reject/restore | `workspaceDocumentStudioV1.ts:817-1071`; strong `reuse`, then unified Review adapter. |

All Workspace routes are loopback/auth protected in production. The API has no
Matter/Profile/Artifact/Review/Work Queue/Conversation/Agent/Word Bridge route
family yet.

## 5. Current `/aletheia/*` surface

`backend/src/veraApplication.ts:439-449` unconditionally mounts the mutation
guard and ten Legacy router groups:

```text
aletheiaRouter
legalResearchRouter
legalResearchIssuesRouter
legalOpinionsRouter
litigationRouter
durableAgentRunsRouter
localGovernanceRouter
localModelsRouter
createLocalVoiceRouter()
createAletheiaLocalControlRouter()
```

The base router alone exposes security policy, tool-adapter tools, matters,
search, work products, review/approval, memory/playbooks/skills, agent runs,
evidence/issue/draft operations, source index, export/eval, and Legacy document
operations (`backend/src/routes/aletheia.ts:504-2059`). Litigation, legal
research/opinions, tasks/deadlines, document drafts, authority versions, and
voice add further route families.

Classification: the whole public surface is `isolate`; selected stable
algorithms are candidates to `adapt` only after extraction; active modules
calling a Legacy route/table are `do-not-use`; unreachable routes are
`delete-later`.

## 6. Composition root, WorkspaceRuntime, and Electron lifecycle

### Active desktop lifecycle

- Electron creates a per-launch random bearer and binds both services to
  `127.0.0.1` (`desktop/main.js:96-105`).
- It starts a Keychain credential utility, backend utility, and frontend utility
  in an ordered, supervised lifecycle (`desktop/main.js:1128-1224`).
- Renderer start route is `/assistant`; the frontend root also redirects there.
- The renderer is sandboxed, context-isolated, without Node integration; browser
  permissions, navigation, and unexpected windows are denied
  (`desktop/main.js:614-705`).
- Pending restore reconciliation happens before renderer creation.

Classification: Electron process supervision, bearer, loopback and renderer
security are `reuse`; Aletheia-named environment/config paths are `adapt` over
time, not destructive rename in Phase 1.

### WorkspaceRuntime

`WorkspaceRuntime` is one large constructor/composition object
(`backend/src/lib/workspace/runtime.ts:392-831`). It constructs database,
repositories, services, model gateway, Assistant, workflow, tabular, Studio,
source-retention, recovery, and one job pump. The pump handles
`document_parse`, `assistant_generate`, `workflow_run`, and `tabular_cell`
(`runtime.ts:752-791`). Startup runs migrations, retention sweep, credential
reconciliation, pinned workflow seeding, recovery, pump start, and job
reconciliation (`runtime.ts:833-858`).

Classification: the single database/pump/runtime behavior is `reuse`; the
constructor is `adapt` into module factories. Adding more unrelated services
directly to this constructor is `do-not-use`.

### Legacy initialization on normal start

The current normal backend sequence is Workspace start, unconditional Legacy
durable configuration, Express construction, optional demo seed, then listen
(`backend/src/veraApplication.ts:731-756`). This has material side effects even
when the Legacy UI is hidden:

- `createLocalVoiceRouter()` constructs a Legacy repository and voice runtime at
  route composition (`routes/localVoice.ts:108-115`).
- Legacy repository construction opens the shared SQLCipher database and runs
  the large Legacy schema (`lib/aletheia/localRepository.ts:906-924,1424-1442`).
- local-control router construction opens another Legacy handle and creates
  provider/MCP/calibration state (`localControlRepository.ts:271-320`).
- local model scheduler objects are initialized; with configured models the
  durable runtime can call `startModel()` and start its worker even when the
  older autostart setting is false (`durableAgentRuntime.ts:81-99,282-299`).
- voice Python sidecar is request-lazy, but its runtime and temp-directory state
  are constructed (`localVoiceRuntime.ts:240-309`).
- production demo seed happens to stay off because bootstrap requires
  `ALETHEIA_ENABLE_DEMO_SEED=true` plus non-production, while desktop passes a
  differently named variable and forces production
  (`veraApplication.ts:663-666`, `desktop/main.js:1154-1185`).

This is `isolate` and is the Phase 1 blocker. Merely returning 404 inside a
handler would be insufficient because constructors/imports already cause work.

## 7. Active product navigation and UI

### Top level

The actual primary navigation is:

```text
Assistant -> Projects -> Tabular Review -> Workflows -> Settings
```

Evidence: `frontend/src/app/components/vera-shell/VeraSidebar.tsx:24-38`.
There is no global Work Queue. The target `Matters / Work Queue / Workflows /
Assistant / Settings` therefore needs route composition, not a cosmetic rename.

### Project

The actual Project navigation is:

```text
Documents | Assistant | Workflows | Tabular Review
```

Evidence: `ProjectWorkspace.tsx:456-506`. There is no current Matter Overview,
Sources page, Case Map, Work composition page, or Activity page.

The Project Provider uses real APIs and polls parse state
(`ProjectWorkspace.tsx:229+`). Project-scoped Assistant rejects cross-Project
chat binding. Workflow and Tabular operations use durable APIs/SSE, not browser
mocks. Studio is a real document route with offline/conflict/save states.

Classification: shell and product components are `reuse`; navigation and
Projects-to-Matters presentation are `adapt`; old global Tabular remains
`isolate` as a deep link.

### Legacy UI

Legacy pages remain directly reachable under `/aletheia` for matters,
litigation, AgentOps, tasks, reviews, evidence, audit, settings, and other
compatibility routes. Its shell exposes Matters and Work Queue, while litigation
has Overview, Facts/Evidence, Positions, Research, Procedure, and Artifacts.
These views are not integrated with Workspace Project/source/Studio state.

Classification: `isolate`, then selected data/algorithms `migrate`/`adapt`, UI
`delete-later`.

## 8. Real active data structures

### Project, Document, Chat, Workflow, Tabular

`backend/src/lib/workspace/types.ts` is the active typed domain contract:

- Project has stable ID, name/description, optional case-management/practice
  metadata, active/archive/delete state, default model profile, and timestamps
  (`types.ts:107-118`). It is a general technical container, not a legal Matter.
- Document belongs optionally to Project/folder and points to an immutable
  current version; versions carry content SHA-256 and page count
  (`types.ts:129-154`). Chunks carry version, offsets, pages and OCR metadata.
- Chat is global or Project-scoped; messages are durable and may bind generation
  jobs (`types.ts:190-220`). Message sources carry document/version/chunk/quote
  data but are not the full Snapshot/Anchor contract.
- Workflow is assistant/tabular with bounded prompt/document-context/tabular
  column/output steps. The type explicitly excludes arbitrary code, shell,
  network, and dynamic tools (`types.ts:246-331`). Runs pin Project/model/job and
  persist steps/output/error (`types.ts:333-359`).
- Tabular Review may be Project-scoped and persists documents, columns, cells,
  status, model, jobs and source references (`types.ts:361-415`).

Classification: these are `reuse`; Assistant/Tabular source references must
`migrate` through a shared Snapshot/Anchor adapter before becoming formal legal
provenance; chat/tabular cells as Matter memory are `do-not-use`.

### Source Snapshot and Citation Anchor

v11 currently supports only `project_document` and `legal_authority`
(`sourceFoundationContractsV11.ts:10-24`). Snapshot fields include Project,
source/version IDs, frozen title, content SHA-256, strict path/secret-free
locator, retrieval time, data-use/license policy, retention, expiry, retrieval
metadata, and creation time (`sourceFoundationContractsV11.ts:232-287`).
Anchors bind Project, snapshot, ordinal, exact quote, strict locator, timestamp,
and derived quote SHA-256 (`sourceFoundationContractsV11.ts:292-307`). SQL
triggers make snapshots/anchors immutable and repository/service reads recheck
hash/ownership.

Classification: strong `reuse`; new conversation/email/note locators are
`adapt`. Creating a second voice/email provenance model is `do-not-use`.

### Document Studio

v12 distinguishes `source`, `draft`, and `template`; Studio versions are
`user_upload`, `assistant_edit`, or `user_accept`
(`documentStudioContractsV12.ts:10-22`). Drafts are Project-scoped Markdown with
immutable versions, content hashes, blob locator, operation ID and citation
anchor bindings (`documentStudioContractsV12.ts:185-269`). Saves and restores
use strong current-version CAS; restore appends a version. v14 suggestions are
pending-only, exact-range, source-linked proposals; accept uses exact splice and
creates one immutable `user_accept` version atomically.

Classification: strong `reuse`; unified Review stores references to Studio
suggestions and delegates acceptance to existing CAS/exact-splice logic.

### Citation split that must be resolved

Studio citations revalidate snapshot/version/chunk/offset/quote/hash/page via the
shared source API. Assistant citation wire lacks snapshot and quote hash;
Tabular source refs have version/chunk/offset/page/quote but no snapshot/quote
hash. Existing records need compatibility projection; neither weaker wire can
be copied directly into a formal Artifact source link.

## 9. Legacy domain inventory

The Legacy tree contains substantial real implementations, not placeholders:

| Capability | Current implementation | Decision |
| --- | --- | --- |
| Matter/work products/review/audit/approval | `lib/aletheia/localRepository.ts`, `repository.ts`, `domain.ts`, base routes | `migrate` data; `adapt` only extracted audit/approval patterns. |
| Facts/evidence/issues/claims/positions/decisions | `litigationStore.ts`, `litigationDomain.ts`, `routes/litigation.ts` and large typed frontend client | `migrate`; never make new Workspace depend on Legacy tables. |
| Tasks/deadlines/calendars | litigation task/deadline/rule/court-calendar modules and routes | extract bounded calculation as `adapt`; task data `migrate`. |
| Review/finding validation | position/finding/output review, entailment and approval code | evaluate and extract stable algorithms; Legacy review store `migrate`. |
| Legal research | provider/adapters, issue tree, broker/gate, opinions, authority versions | controlled adapters/policy may `adapt`; Legacy routes `isolate`. |
| Durable agents/models | durable executor/runtime, local model scheduler/calibration | `isolate`; new bounded Agent Run uses Workspace jobs/model gateway instead. |
| Voice | local voice route/runtime/protocol and Python faster-whisper adapter | `isolate`; imported Conversations are new; optional algorithms require license/security review. |
| Drafts/export/Word POC | litigation drafts/roundtrip/export plus `/office/word` and `office-addin/` | bounded export can `adapt`; data `migrate`; Word POC `isolate` until dedicated bridge. |
| Eval replay | Legacy eval cases/runs/annotations and audits | schema/data `migrate` or extract after definition review. |

Legacy contains parallel source/evidence concepts. They must be mapped into the
active Source Snapshot/Citation Anchor model rather than copied.

## 10. Security, encryption, backup, and audit

### Confirmed reusable controls

- Packaged desktop requires application file encryption and SQLCipher and
  rejects downgrade (`desktop/encryptionPolicy.js:23-57`).
- SQLCipher connection verifies cipher version, readable schema and
  `cipher_integrity_check`; the integration audit also proves plaintext cannot
  read the migrated database, wrong keys fail, and the native addon hash is
  pinned (`lib/aletheia/localDatabase.ts:95-245`).
- Workspace blobs require encrypted codec, UUID locator, no-follow/exclusive
  writes, fsync/no-clobber publish, and plaintext hash/size verification
  (`localWorkspaceBlobStore.ts:154-297`).
- Model-profile secrets go through an isolated credential utility and macOS
  Keychain; renderer cannot read them and secrets do not enter argv
  (`desktop/macOsKeychain.js:216-260`, `credentialWorker.js:186-199`).
- Workspace authentication checks the exact `/api/v1` boundary, socket-level
  loopback and constant-time bearer comparison
  (`middleware/workspaceAuth.ts:257-285`).
- Backup rejects symlink/hardlink/special-file/path traversal and read-time
  changes, authenticates AES-GCM before manifest use, and restores through a
  staged rollback/pending-record exchange (`desktopBackup.ts:176-250,
  1051-1188`; `desktop/main.js:299-363`).
- Source retention rechecks around final DOCX conversion, and `local_only`
  cannot pass an unknown model context (`runtime.ts:615-627,1734-1756`).

These controls are `reuse`.

### Confirmed gaps

1. Pre-Phase-1 health only reports Workspace pump and audit; it does not
   distinguish Matter, Conversation, Legacy routes/runtime, model, voice,
   credential worker, storage or retention (`veraApplication.ts:501-544`).
2. Audit anchoring is default-off and high-assurance-only fail-closed. HTTP
   mutation guard exists, but Workspace background pump/final commits do not
   receive that gate; anchor snapshots cover Legacy audit tables rather than a
   canonical Workspace mutation ledger. This is `adapt`, not a completed
   all-write fail-closed claim.
3. Legacy provider secrets can still exist AES-GCM encrypted inside Legacy
   SQLite and therefore backups (`localControlRepository.ts:900-977`). These
   must `migrate` to Keychain before claiming no provider secret in SQLite or
   backup for migrated users.
4. The v13 retention activation gate reports `activation_gate_closed`; current
   legal-source retention cannot be promoted as fully active until physical
   cleanup and every model/export boundary is complete.

## 11. P0/P1 and packaging gates

Current scripts provide:

- backend build and `test:workspace:p0-client` (migrations, application/auth,
  runtime, source/OCR/Studio, legal sources, credentials/model, Assistant,
  workflows and tabular);
- backend `test:workspace:p1-convergence`, SQLCipher, encryption and backup;
- frontend lint/build and `test:p0-client` (Assistant, workflows, tabular,
  settings, legal sources, Studio, OCR, shell/i18n/source provenance);
- desktop `test:p0-source`, SQLCipher runtime, desktop migration, packaged
  workspace/backup/restore/OCR/smoke and signing readiness;
- full mac packaging orchestration in `scripts/package-desktop-mac.sh`.

Audit caveats:

- `desktop test:packaged-p1-convergence` is currently only an alias for native
  OCR; it is not a complete P1 aggregate.
- Packaged evidence recorded on 2026-07-15 is historical evidence, not a fresh
  run on this branch.
- Desktop credential-backend integration requires a completed backend build.
  Running it concurrently while build deletes/recreates `dist` will fail its
  preflight; ordered execution is mandatory.

### Baseline commands run for this audit

The following passed on the audited baseline after installing locked
dependencies:

```text
backend:  npm run build
backend:  npm run test:workspace:p0-client
backend:  npm run test:workspace:p1-convergence
backend:  npm run test:aletheia:sqlcipher
backend:  npm run test:aletheia:encryption
backend:  npm run test:desktop-backup
frontend: npm run lint
frontend: npm run build
frontend: npm run test:p0-client
desktop:  npm run test:p0-source
```

The first desktop aggregate attempt overlapped the backend build's deliberate
`dist` cleanup and failed only the “build backend/dist first” preflight. The
ordered rerun passed, including real macOS Keychain and Electron credential
worker/backend integration. This is a test orchestration dependency, not a
product regression.

## 12. Mike provenance and license

Confirmed locally:

```text
remote:  upstream-mike https://github.com/Open-Legal-Products/mike.git
commit:  e32daad5a4c64a5561e04c53ee12411e3c5e7238
license: AGPL-3.0-only
```

The fixed commit exists in the Git object database. There is no nested Mike
application. `docs/mike_port_manifest.md:13-36` records the only approved
source, fixed-SHA rule, direct/adapt/rewrite/exclude policy, attribution, brand
boundary, and Legacy-retention rule. Activity files contain per-file SHA/path
comments and source tests compare selected ports to that exact commit.

Classification: existing controlled ports are `reuse`; a floating upstream
copy, a second Mike frontend, removal of headers/notice, or cloud Supabase/R2/
organization/share/OAuth/MCP paths are `do-not-use`.

At baseline, the root had no `THIRD_PARTY_NOTICES.md`; only
`docs/third_party_notices.md`, whose wording was still Aletheia-centric. Phase 0
adds the root notice and a convergence inventory without removing the existing
attribution.

## 13. Paths and names that differ from the proposed plan

| Planned/assumed item | Actual baseline | Decision |
| --- | --- | --- |
| Workspace may still be near v8 | Workspace is v14 | next migration v15; never alter v1-v14. |
| `word-addin/` to be created later | `office-addin/word-manifest.xml` and `/office/word` already exist as Legacy/Hermes POC | `isolate`, then `migrate` in the Word phase; do not create a second simultaneous add-in. |
| Voice might be absent | Python `backend/voice_sidecar/aletheia_voice_sidecar.py` and full Legacy voice runtime exist | `isolate`; no claim of target Conversations/capture runtime. |
| Legacy runtime hidden by product rename | UI hidden from main nav, but routes/runtime/DB side effects remain active | Phase 1 double gate. |
| Source model may need creation | v11 immutable Snapshot/Anchor and v13 retention already exist | `reuse` and extend. |
| Studio may be basic import/export | v12/v14 CAS versions, citations, DOCX and exact-splice suggestions are implemented | `reuse`; unified Review delegates. |
| Origin repository named Vera | configured `origin` URL is still `shawliu998/Aletheia.git`; Git remote main resolves to audited SHA | naming/remote cleanup is separate governance work, not silently changed here. |
| Backend already modular | one large `WorkspaceRuntime` and `veraApplication.ts` composition remain | incremental `adapt`, no stack rewrite. |
| README describes only the active product | README begins with the Mike-derived Vera client but later restores the old Aletheia product claim and Docker `/aletheia` quick start | `adapt` in the final documentation phase; current Docker path is Legacy, not an active-product quick start. |

The Legacy Docker configuration also passes `ALETHEIA_BACKEND_HOST=0.0.0.0`,
while the current Vera backend rejects every non-`127.0.0.1` bind. It must not
be presented as a verified current desktop or convergence startup path. Docker
compatibility, if retained, needs a separately reviewed loopback/container
network design; weakening the backend loopback rule is `do-not-use`.

The latest commits also added controlled legal-source adapters and expanded P1
Studio/source gates. Their closed activation state and credential boundaries
must be preserved; fixtures are not live provider success.

## 14. Consolidated disposition

### `reuse`

- Electron/Next/Express/TypeScript/SQLCipher/encrypted blobs/Keychain stack;
- Project technical ownership and existing typed `/api/v1` clients;
- durable jobs/SSE and bounded workflow step model;
- source snapshots, citation anchors, source viewer/resolver;
- Studio versions/CAS/suggestions/DOCX;
- Assistant, workflow and tabular execution;
- backup/restore, loopback, bearer, renderer sandbox and secret redaction;
- Mike fixed-SHA ports and provenance tests.

### `adapt`

- application composition into core/workspace/matter/conversation/broker modules;
- Projects presentation and navigation into Matters while retaining Project IDs;
- sources for conversation/email/note locators;
- model profiles with execution/privacy policy;
- Assistant/workflow/tabular output into Proposal and Review;
- health, audit ledger/background fail-closed, retention activation;
- shared modal/source-viewer accessibility and i18n coverage.

### `migrate`

- Assistant/Tabular citations into verified Snapshot/Anchor lineage;
- Legacy Matter/Fact/Evidence/Issue/Position/Decision/Review/Task/Voice/Draft;
- Legacy provider secrets from SQLite to Keychain;
- useful Legacy eval history into the converged eval schema.

### `isolate`

- all `/aletheia/*` routes and Legacy durable/model/voice/local-control runtime;
- Legacy frontend deep links;
- old global Tabular primary-nav role;
- existing Office/Hermes Add-in proof-of-concept;
- Legacy voice sidecar until the Conversations/capture phases.

### `delete-later`

- unreachable Legacy UI, routers, global runtime objects, sidecar/package
  requirements, demo scripts and old product docs, only after migration,
  backup/restore and replacement fixtures pass.

### `do-not-use`

- Legacy tables/routes as a new-module dependency;
- Chat history, summaries, or Tabular cells as formal Matter memory;
- weak citation wires as accepted Artifact provenance;
- arbitrary shell/code/path/URL/network/MCP tools;
- a second frontend, database, document store, settings store, Matter app, or
  Word repository;
- graph database migration, Tauri rewrite, production demo seed, or provider
  fixtures presented as live integrations;
- unused hard-coded `RelevantQuotes` UI as the new citation system.

## 15. Immediate Phase 1 acceptance boundary

Before any Matter migration or UI work:

1. add strict `VERA_ENABLE_LEGACY_ROUTES` and
   `VERA_ENABLE_LEGACY_RUNTIME` flags, default false;
2. avoid loading/constructing Legacy routers and model/voice/durable/demo modules
   when disabled, not merely reject inside handlers;
3. make the production desktop pass both flags explicitly as false by default;
4. report Workspace, Matter, Conversation, and Legacy status separately in
   health while preserving the existing Workspace health contract;
5. prove default `/aletheia/*` 404, explicit test opt-in, no Legacy durable start,
   no demo seed, and correct shutdown;
6. keep all Legacy files/tables/resources intact for migration and regression.

Audit/background mutation and Legacy-secret migration are recorded security
work for later bounded commits; they must not be falsely declared complete by
the Phase 1 route/runtime gate.
