# ADR — Vera Product Convergence

Date: 2026-07-16

Status: Accepted — Gate 0

Decision scope: Product, domain ownership, runtime, API, data, deployment,
information architecture, compatibility, migration, rollback, and security

Recorded baseline: `feat/legal-matter-agent-convergence` at `408333d7`

## 1. Authority and supersession

This document is the sole forward architecture decision record for the Vera
product convergence. Later implementation plans must conform to it or replace
it through a new, explicitly accepted ADR.

Earlier documents under `docs/convergence/` are retained as historical audit
evidence, design exploration, migration notes, and provenance records. A short
status notice may identify their historical role, but their original decisions
are not deleted or rewritten to make history look current. Their factual
evidence and license obligations remain useful, but any prescriptive decision
that conflicts with this ADR is superseded.

In particular, this ADR supersedes the earlier primary navigation proposal:

```text
Matters | Work Queue | Workflows | Assistant | Settings
```

and the earlier Matter navigation proposal:

```text
Overview | Sources | Case Map | Work | Activity
```

`Work Queue`, `Case Map`, `Work`, and `Activity` are not primary navigation
destinations in the accepted information architecture. Their underlying domain
concepts may still exist or be introduced behind the accepted surfaces, but an
implementation must not restore those former navigation labels without a new
ADR.

This ADR also supersedes the former Artifact-first delivery order. Vera ships a
small Proposal-and-Review contract first, beginning with adapters to existing
authoritative owners such as Document Studio. A formal Fact, Issue, Task, or
other legal-state type is introduced only with its own schema, source,
promotion, and rollback contract; a generic Artifact graph is not a prerequisite
for the first useful reviewed workflow.

## 2. Context

The repository currently combines a secure local Vera Workspace product,
controlled Mike-derived UI and compatibility surfaces, and an isolated Legacy
Aletheia system. Convergence must produce one coherent legal product without a
second frontend, database, document store, model configuration system, job
scheduler, or active Legacy application.

The product loop is:

```text
Source
  -> immutable Source Snapshot and Citation Anchor
  -> bounded Assistant, Workflow, OCR, Tabular, or other processor output
  -> candidate or proposal
  -> unified Review
  -> lawyer decision
  -> authoritative owner mutation, Draft revision, or later formal Matter state
  -> audit and evaluation
```

Chat history and model output are not authoritative legal memory. The durable
legal record consists of source-linked, reviewed state and immutable revisions.

## 3. Singular product decisions

Vera has exactly one entry for each foundational concern:

| Concern     | Accepted decision                                                                    | Consequence                                                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product     | One Vera desktop product and one shared shell                                        | Legacy is not a second user-facing application and no parallel Matter app is introduced.                                                          |
| Container   | One technical ownership container: `projects.id`                                     | A Matter is a Project with an explicit one-to-zero-or-one MatterProfile. Existing Project foreign keys remain authoritative.                      |
| Source      | One source, snapshot, anchor, and encrypted-blob model                               | Documents, later email/notes/conversations, and controlled legal sources extend the same provenance model rather than creating source silos.      |
| Review      | One unified Proposal, Review, and resolution service                                 | AI and automation create candidates. Only an explicit lawyer decision can resolve a Proposal or authorize its authoritative owner mutation.       |
| Job         | One durable SQLite job store and pump                                                | Assistant, Workflow, parsing, OCR, future agents, and integrations reuse the existing recoverable job control plane and domain-specific handlers. |
| Model entry | One model-profile registry, Settings surface, inference gateway, and credential path | A run pins one profile and policy. Features cannot embed their own provider clients, credentials, model settings, or shadow gateways.             |

These are invariants, not temporary implementation preferences.

## 4. Canonical container and state rules

1. `Project` remains the technical boundary for ownership, backup, documents,
   Assistant scope, Workflow runs, and isolation checks.
2. `MatterProfile` adds legal semantics without renaming or duplicating the
   Project graph. A generic Project remains valid.
3. Creating a Matter atomically creates its Project and MatterProfile. Adding a
   profile to an existing Project always requires an explicit user action.
4. No UI label, migration, or background job may silently infer a MatterProfile
   from a Project name, document, chat, or Legacy record.
5. A legal fact, issue, evidence item, position, decision, instruction, or task
   becomes durable Matter state only after that type has a formal owner and a
   reviewed promotion contract. It is never made authoritative by a chat
   message or a generic JSON label.
6. Proposal disposition is exactly `open`, `accepted`, `modified`, `rejected`,
   or `superseded`, is recorded explicitly, and is never inferred from model
   confidence. Type-specific resolution actions do not become extra lifecycle
   states.
7. Source content is immutable at the snapshot boundary. Corrections append a
   new source version or state revision; they do not overwrite the original.
8. Source links bind an exact snapshot and, when available, a validated anchor
   with a content hash and typed locator.

## 5. Module ownership

Module boundaries are logical ownership boundaries even while extraction from
the current large Workspace runtime is incremental. A module may be composed
inside the existing runtime before it has its own top-level directory, but it
must not open another database or reverse dependency direction.

| Owner                     | Owns                                                                                                                                                                                                        | Must not own                                                                                               |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Desktop host              | Electron lifecycle, process supervision, renderer sandbox, CSP/connect policy, per-launch bearer delivery, Keychain utility process, packaged backup/restore orchestration                                  | Legal state, model provider logic, or a second API/data plane                                              |
| Core                      | SQLCipher connection and migration ledger, encrypted blob store, durable jobs, audit health, safe errors, lifecycle/draining, backup primitives                                                             | Product navigation or domain-specific legal decisions                                                      |
| Workspace                 | Projects, folders, documents and versions, source records, Source Snapshots, Citation Anchors, Assistant chats, Workflow definitions/runs, Tabular processing, Document Studio, model-profile configuration | Accepted Matter semantics or a competing Review boundary                                                   |
| Matter                    | MatterProfile, the unified Proposal/Review/Resolution contract, later explicitly owned formal legal-state types, derived work items, stale/validation state, and Matter projections                         | Raw source copies, provider credentials, a speculative generic Artifact graph, or an independent scheduler |
| Conversations             | Imported/captured sessions, participants, immutable machine transcript layers, reviewed transcript layers, speaker binding, extraction candidates                                                           | A separate source/anchor model or direct accepted Matter writes                                            |
| Inference and Tool Broker | Model invocation policy, typed tool registry, egress decisions, legal-source adapters, later Word bridge policy, approval enforcement                                                                       | Model profiles, raw provider secrets, arbitrary shell/path/URL tools, or authoritative Matter state        |
| Presentation              | The accepted shell, routes, accessibility, i18n, truthful capability states, and API clients                                                                                                                | Persistence, authorization, promotion decisions, or fabricated availability                                |
| Legacy adapters           | Read-only compatibility and bounded migration into active owners                                                                                                                                            | Calls from active modules, active product state, default startup, or new feature development               |

Review may be implemented as a bounded package inside the Matter module, but it
remains one service and one resolution boundary. A global Review view and a
Matter-scoped Review view are projections over the same Proposal and resolution
records, not separate review systems. Review references authoritative Studio,
OCR, Workflow, Tabular, Assistant, or later Matter payloads; it does not clone
those payloads into a second owner.

## 6. One runtime, API, and database

### 6.1 Runtime

Vera keeps one supervised desktop runtime graph:

```text
Electron main
  |-- sandboxed Next.js renderer
  |-- one loopback Express/TypeScript backend
  |     `-- one composed Core + Workspace + Matter + broker graph
  `-- isolated Keychain credential utility process
```

The current Workspace runtime may host newly extracted modules during
convergence. Module factories receive narrow ports and the already-open
database adapter. They do not create another application runtime or database
connection owner.

Legacy routes and runtime are disabled by default and independently gated.
Active modules never import a Legacy router, repository, scheduler, or table.
Legacy may run only for an explicitly authorized compatibility test or
migration operation.

### 6.2 API

There is one authenticated, audit-guarded active API root:

```text
/api/v1
```

All active modules mount additive routers under that single composition root
and inherit the same loopback authentication, mutation guard, limits, draining
behavior, cache policy, and safe error envelope. There is no parallel `/api/v2`
or module-specific server.

Existing Project, document, Assistant, Workflow, Tabular, source, Studio,
settings, and model-profile contracts remain compatible. Matter and later
resource families are additive, including:

```text
/api/v1/matters
/api/v1/projects/:projectId/matter-profile
```

Gate 2 introduces one Proposal/Review resource family beneath `/api/v1`; its
global and Project-scoped projections use the same owner and records. Exact
route names land with that schema and contract rather than being guessed in
Gate 0. Public contracts are strict, bounded, versioned by additive evolution,
and free of credentials, absolute paths, raw internal errors, and unbounded
source content.

`/aletheia/*` is not an active API namespace. It remains unavailable unless an
explicit Legacy route flag is enabled for a bounded compatibility or migration
purpose. New UI must never depend on it.

### 6.3 Database and blobs

There is one Workspace SQLCipher database, one ordered checksum-recorded
migration ledger, and one transaction coordinator. Domain modules own their
tables but share that connection and Project ownership key.

There is one encrypted blob store for original files, source bodies, audio,
previews, and derived file payloads that require blob storage. Metadata does
not contain local absolute paths. Provider credentials and database encryption
keys remain outside the database in the macOS Keychain path owned by the
desktop credential process.

No graph database, vector database, second SQLite file, browser persistence,
or external service becomes an authoritative Vera state store without a new
ADR.

## 7. Deployment boundaries

The supported product boundary is the packaged local desktop application. It
contains the renderer, loopback backend, Core/Workspace/Matter modules, and
supervised utility processes. It must remain useful for local data operations
without a hosted Vera control plane.

External model providers are optional execution dependencies reached only
through the approved inference gateway after model readiness, credential,
source policy, retention, and egress checks. A provider is never a persistence
or authorization authority.

Additional processes are permitted only when the boundary is narrower than the
main backend:

- a capture sidecar may own audio devices, durable partial-file recovery, VAD,
  and ASR adapter events, but no Matter state, credentials, Review decision, or
  database;
- a Word Add-in may pair with a separately approved loopback bridge using
  short-lived, document-scoped authority, but receives no provider credential,
  database access, arbitrary path, or arbitrary URL;
- the existing Keychain utility process may perform bounded secret operations
  and returns only the minimum status or secret channel required by its host.

Docker, test servers, or developer launchers may package the same backend for
testing, but they do not define another production topology. Relaxing
loopback-only binding or introducing a hosted authoritative service requires a
new security ADR.

## 8. Accepted information architecture

### 8.1 Top level

The primary navigation, in order, is:

```text
Assistant | Matters | Workflows | Review | Settings
```

- **Assistant** is the entry for unassigned work and existing global
  conversations. A Matter Assistant binds its Project context by default.
- **Matters** is the legal workspace index. It presents explicit MatterProfile
  state while retaining truthful handling of generic Projects.
- **Workflows** contains reusable definitions; a Matter-scoped view supplies
  the Project run context.
- **Review** is the unified cross-Matter Proposal and Review Center. It is not
  Tabular Review and is interactive only after the real Proposal persistence,
  Review API, and resolution boundary exist.
- **Settings** remains capability-gated by the local settings runtime.

Until another accepted decision changes the home behavior, `/` and the Vera
product mark continue to land on `/assistant`. Navigation order does not
silently change desktop startup behavior.

The top-level Projects and Tabular entries are removed when Matters ships, but
their compatible routes are retained. An unavailable Review capability is
shown as disabled with explicit text; Vera does not mount a static page that
pretends Review data exists.

### 8.2 Matter

The Matter navigation, in order, is:

```text
Overview | Documents | Assistant | Review | Workflows | Drafts
```

- **Overview** presents real MatterProfile and Project summaries only.
- **Documents** reuses the Project document/version/source-viewer capability.
  Broader source kinds extend the shared source model rather than restoring a
  generic `Sources` primary tab without an implemented surface.
- **Assistant** is Project-scoped and uses the same chat and job services as
  the global Assistant.
- **Review** is the Matter-filtered projection of the one unified Review
  service.
- **Workflows** reuses global Workflow definitions with the Matter's Project
  as an explicit run container.
- **Drafts** presents Document Studio work product and immutable versions. It
  does not create a second editor or document repository.

Tabular Review remains a real processing capability and compatible deep link.
It is not renamed to unified Review, and its current `review_count` is never
displayed as a Review Inbox count. Tabular output may create Review candidates
only after the unified Review adapter exists.

Work items remain a Matter-owned domain concept but do not justify a top-level
Work Queue. Artifact graphs, work summaries, and activity projections may be
presented within Overview, Review, Workflows, or contextual detail views. They
do not revive the superseded `Case Map | Work | Activity` primary tabs.
If a queue projection is introduced, it is a secondary mode within Review and
reuses Proposal, durable Job, OCR, Workflow, and explicitly user-created task
state rather than creating another state machine.

All new copy uses the existing Chinese-first i18n system. Status, conflict,
staleness, confidence, and review disposition are conveyed through text or
icons in addition to color.

## 9. Compatibility and migration

### 9.1 Active compatibility

- Existing `/api/v1/projects` and Project-owned resource contracts remain
  valid.
- Exact `/projects` UI navigation may redirect to `/matters` after the Matters
  list is available; `/projects/:id/**` deep links remain valid during the
  compatibility window.
- Existing Assistant, Workflow, Tabular Review, document viewer, citation
  viewer, and Document Studio routes remain usable.
- Mike-derived controlled files retain their fixed provenance comments,
  reviewed source pin, license obligations, and source-level tests.
- A generic Project with `matter_profile: null` remains visible and usable. It
  is never silently upgraded to a Matter.
- Old persisted chats, jobs, Workflow runs, Tabular results, Studio versions,
  snapshots, and anchors remain readable through additive migrations.

Compatibility does not permit two meanings for one label. `Review` always
means unified human review; `Tabular Review` keeps its explicit name until its
output enters unified Review through a real adapter.

### 9.2 Schema and Legacy migration

All active migrations are additive, ordered, checksum-recorded,
transactional, and tested on SQLite development fixtures and packaged SQLCipher
paths. Existing migration files and checksums are immutable. Destructive table
renames, bulk inferred profile creation, and in-place deletion are prohibited.

Committed migration v15 remains immutable. Its litigation-oriented
`matter_type` and dormant Matter Policy foundation are transitional storage,
not the final public workspace taxonomy and not proof that inference is
permitted. Additive migration v16 introduces the broader user-selected
workspace classification and jurisdiction without guessing from v15 values.
Missing classification remains an explicit capability state.

Legacy migration is a bounded import, not runtime convergence:

1. create and verify an encrypted pre-migration backup;
2. run a read-only preflight and deterministic mapping report;
3. preserve each Legacy type and ID in a migration ledger;
4. migrate in bounded, restartable transactions;
5. record conflicts and unmigratable objects without guessing;
6. verify target ownership, source links, revisions, and Review disposition;
7. leave Legacy source data intact and read-only until later deletion gates.

Active modules may expose narrow migration ports. They may not call Legacy
repositories or reuse Legacy tables as live state. Legacy adapters depend on
active module ports; dependency direction never reverses.

## 10. Rollback and recovery

Each schema, backend, frontend, desktop, native sidecar, Word, and Legacy
migration change lands as a separate, runnable, reversible commit when more
than one boundary is involved.

Rollback follows these rules:

- a frontend IA commit can be reverted while compatible Project routes remain;
- an additive API module can be unmounted without deleting its persisted
  tables;
- a compatibility binary that recognizes the installed migration ledger may
  run with unused additive tables;
- a binary that does not recognize the database's migration ledger must fail
  closed and requires the verified pre-migration encrypted backup;
- no rollback drops selected tables, rewrites the migration ledger, deletes
  successful migrated records, or overwrites the current workspace in place;
- new job producers are disabled and the durable pump is drained before a
  runtime rollback;
- partial Legacy imports resume from their migration-item ledger or restore the
  whole verified backup. They are not repaired by deleting successful target
  objects.

Legacy routes, runtime, tables, blobs, and source files are deleted only after
compatibility, migration, restore, security, and packaged-release gates pass
and a separate deletion decision is accepted.

## 11. Security decisions

1. The backend binds validated loopback literals only. Production trust-proxy
   behavior cannot widen the client boundary.
2. Every `/api/v1` request crosses the same per-launch bearer authentication.
   Project ownership is rechecked in services and repositories, not only in
   middleware or UI routes.
3. The renderer remains sandboxed and receives no database key, provider
   secret, unrestricted filesystem access, or local absolute path.
4. Packaged storage requires SQLCipher, encrypted blobs, macOS Keychain, and
   verified backup/restore. A plaintext downgrade fails closed.
5. Audit-health failure blocks mutations. A service cannot report success
   before its bounded transaction and audit event complete.
6. Public inputs and outputs are exact, bounded, and validated. Logs, health,
   errors, diagnostics, and migration reports redact secrets, raw provider
   failures, absolute paths, unbounded source text, and raw audio.
7. AI, OCR, Assistant, Workflow, Tabular, transcript, and external-source
   output is candidate state by default. The model cannot manufacture a human
   decision or accepted disposition.
8. Review resolution re-reads the authoritative target and verifies ownership,
   current version, source/retention state, staleness, and audit health. The
   target owner's formal mutation and the Proposal resolution/audit event
   commit atomically or neither commits. A Proposal is never treated as the
   authoritative payload.
9. The durable job system retains append-only recovery events, immutable input
   snapshots, bounded retry/cancel behavior, and the model/tool policy pinned at
   planning time.
10. The inference and Tool Broker accepts typed IDs and approved operations,
    never arbitrary shell commands, local paths, URLs, HTTP calls, or
    unapproved external connectors.
11. Source retention and egress policy is re-evaluated at model invocation,
    export, external retrieval, capture, and Word boundaries. API
    accessibility alone never establishes content rights.
12. Court filing, final email sending, automatic client-instruction acceptance,
    and other high-risk external actions remain unavailable without a separate
    reviewed capability and recorded human approval.
13. New copied source, assets, dependencies, models, weights, and datasets keep
    the repository's fixed-pin provenance, license, notice, and security review
    gates.
14. The dormant v15 Matter Policy tables do not create an allow policy. Matter
    inference fails closed while required policy or allowed execution locations
    are absent, and a renderer or compatibility deep link cannot bypass that
    backend decision. A later policy gate supplies verified model privacy
    metadata and user controls; it does not retrofit permissive defaults.

## 12. Delivery gates and truthful UI

Gate 0 is complete only when this ADR is accepted as the forward decision. A
roadmap may sequence delivery and evidence, but it cannot redefine these
product, ownership, runtime, IA, migration, or security decisions.

The first UI vertical slice may add the accepted top navigation, Matter list,
atomic create/profile forms, and a real Overview while linking Documents,
Assistant, and Workflows through compatible Project routes. Review remains
disabled until unified Review persistence and API transactions exist. Drafts
may continue to open through Documents until a complete, bounded Studio
collection contract supports the dedicated tab.

Later capabilities become interactive only when their real storage, API,
authorization, recovery, error, and test contracts exist. Static cards, TODO
handlers, fixtures, guessed counts, fake success, and relabeled compatibility
features do not satisfy a gate.

Every gate leaves the packaged desktop startable and runs its focused tests
plus affected P0/P1, encryption, backup/restore, shell, and packaging
regressions.

## 13. Consequences and rejected alternatives

Accepted consequences:

- Product language becomes Matter-centric while Project remains visible in
  technical routes and compatibility contracts.
- Review and Drafts navigation may initially be disabled or bridged to existing
  surfaces rather than represented by placeholder data.
- Existing Workspace services are adapted behind clearer owners instead of
  rewritten.
- Proposal-first Review can deliver useful, source-backed human decisions
  before Vera defines every future formal legal-state type.
- Some Legacy capabilities arrive later because they must be migrated into the
  shared source, Review, job, and security boundaries.
- Historical convergence documents can disagree with current direction; this
  ADR resolves the disagreement without deleting the record.

Rejected alternatives:

| Alternative                                                                                 | Decision                                                                                                                      |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| A second Matter application, frontend, API server, or database                              | Rejected: it splits ownership, security, backup, and product behavior.                                                        |
| Destructive Project-to-Matter table and route rename                                        | Rejected: Project remains the stable technical container.                                                                     |
| Chat history or model output as authoritative legal memory                                  | Rejected: durable accepted state requires source-linked Review.                                                               |
| A generic Artifact graph as a prerequisite for the first reviewed workflow                  | Rejected: ship bounded Proposals and authoritative-owner adapters first; add formal state types only with complete contracts. |
| Tabular Review or Studio suggestion acceptance as a separately branded unified Review Inbox | Rejected: adapters must converge on one Review service without lying about current semantics.                                 |
| Separate agent scheduler, queue, or event store                                             | Rejected: reuse the durable Workspace job control plane.                                                                      |
| Feature-specific provider SDKs, credentials, or model selectors                             | Rejected: use the one model entry and broker policy.                                                                          |
| Top-level Work Queue or Matter Case Map/Work/Activity navigation                            | Rejected and superseded by this ADR.                                                                                          |
| Default-on Legacy routes/runtime or active-module imports from Legacy                       | Rejected: Legacy is isolated, migration-only, and delete-later.                                                               |
| Graph database, browser local state, or hosted service as authoritative state               | Rejected absent a new ADR and migration/security design.                                                                      |
| Tauri or another full desktop-stack rewrite                                                 | Rejected: retain Electron, Next.js, Express/TypeScript, SQLCipher, encrypted blobs, Keychain, and durable SQLite jobs.        |
