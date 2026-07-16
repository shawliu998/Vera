# Vera Legal Matter Agent Convergence — Target Architecture

> Superseded forward-design notice (2026-07-16): retained as the historical
> architecture explored during the first convergence pass. Its Case Map,
> top-level Work Queue, Artifact-first phase order, and old Matter navigation
> are not the active product plan. The canonical decision is now
> `docs/adr/vera-product-convergence.md`.

Date: 2026-07-16
Baseline: `main` at `12af6fc53317e96314a980250d3bd12d5bfd3bcb`
Status: Historical / superseded architecture decision record

## 1. Outcome

Vera converges on one local desktop product and one canonical work loop:

```text
Source Snapshot
  -> bounded AI Proposal
  -> Review Item
  -> lawyer decision
  -> Matter Artifact revision
  -> Draft / Task / Decision
  -> Audit / Evaluation
```

The product is Matter-centric in the user interface while retaining `Project`
as the technical ownership, backup, permission, document, workflow, and
Assistant boundary. Chat and model output are not system memory. Durable legal
state lives in immutable, source-linked Artifact revisions.

## 2. Architecture decisions

| Decision | Classification | Consequence |
| --- | --- | --- |
| Keep Electron + Next.js + Express/TypeScript + SQLCipher + encrypted blobs + Keychain + durable SQLite jobs | `reuse` | No Tauri rewrite and no second application runtime. |
| Keep `projects.id` as the ownership key | `reuse` | UI may say Matter; existing tables and foreign keys are not destructively renamed. |
| Add `matter_profiles` one-to-zero-or-one with Project | `adapt` | A generic Project remains valid; a legal Matter is Project plus MatterProfile. |
| Extend Source Snapshot and Citation Anchor | `adapt` | Documents, conversations, email, authority, and notes share one provenance model. |
| Add immutable Artifact revisions and typed relations | `adapt` | Current state is projected from revision history; no in-place legal-state overwrite. |
| Make Review Inbox the only promotion boundary | `adapt` | AI, workflows, OCR, conversations, and Studio produce candidates or suggestions only. |
| Reuse the durable job pump and model gateway | `adapt` | Agent runs and legal workflow steps do not create another scheduler or model setting store. |
| Put all model tools behind a typed local Tool Broker | `adapt` | No arbitrary shell, path, URL, HTTP, MCP, or unapproved external action. |
| Disable Legacy routes/runtime by default, then extract stable capabilities | `isolate` | The active product never depends on a Legacy route or Legacy table. |
| Migrate Legacy records with reports and immutable legacy IDs | `migrate` | Migration is repeatable, conflict-preserving, and never deletes source data. |
| Remove unreachable Legacy UI/runtime only after release gates | `delete-later` | Legacy tables and files are not deleted in early phases. |
| Graph database, second frontend/database/document store, arbitrary agent execution | `do-not-use` | Temporal state stays in SQLCipher and bounded application services. |

## 3. Runtime topology

There remains one composition root and one loopback HTTP server. The current
large Workspace runtime is split behind module factories without changing the
desktop process topology:

```text
Electron main
  |-- credential utility process <-> macOS Keychain
  |-- Vera Express backend (127.0.0.1 only)
  |     |-- core
  |     |-- workspace
  |     |-- matter
  |     |-- conversations
  |     `-- brokers
  `-- Next.js renderer (sandboxed)

Optional later process:
  capture-runtime Rust sidecar
    - audio devices, durable WAV capture, VAD, recovery, ASR adapter events
    - no Matter, credential, Artifact, Review, or document knowledge
```

The target composition shape is:

```ts
const core = createCoreModule();
const workspace = createWorkspaceModule(core);
const matter = createMatterModule(core, workspace);
const conversations = createConversationModule(core, workspace, matter);
const brokers = createBrokerModule(core, workspace, matter, conversations);

return createVeraRuntime({
  core,
  workspace,
  matter,
  conversations,
  brokers,
});
```

Module factories own construction and lifecycle. Routes depend on narrow ports;
repositories do not call routes; new modules never import from
`lib/aletheia`, `/aletheia/*`, or Legacy database tables.

## 4. Module ownership

### Core — `reuse` then `adapt`

Owns loopback authentication, SQLCipher connection and migrations, encrypted
blob storage, Keychain credential ports, durable jobs, audit protection, safe
errors, backup/restore, and lifecycle. Existing fail-closed behavior remains a
startup and mutation precondition.

### Workspace — `reuse`

Owns Projects, documents and immutable versions, imported email/manual-note
source records and versions, source snapshots, citation anchors, Assistant
messages and durable generation, workflows, tabular review, Document Studio,
and model settings. It remains usable for a Project without a MatterProfile.

### Matter — new bounded module, `adapt`

Owns MatterProfile, Artifact identities and revisions, relations, Review Inbox,
Work Queue, validation/stale state, and activity projections. It references
Workspace source/document identities; it does not copy source content.

### Evaluation — new bounded service under Matter, `adapt`

Owns `eval_cases`, `eval_runs`, and lawyer annotations derived from reviewed
outcomes. It measures extraction, grounding, speaker attribution, dates/amounts,
unsupported claims, review acceptance/modification, stale detection, workflow
completion, and Word operation failures by Matter type, model, and execution
location. Corrections become reviewable evaluation data, never automatic model
learning or silent policy changes.

### Conversations — new bounded module, `adapt`

Owns imported or captured conversation sessions, participants, machine and
reviewed transcript layers, speaker binding, processing runs, and candidate
extractions. An extraction always references transcript segments and creates a
Review Item before it can become a Matter Artifact.

### Brokers — extracted boundary, `adapt`

Owns inference policy, typed tools, legal-source adapters, Word Local Bridge,
and approval checks. The broker calculates egress from Matter Policy, Source
Policy, Model Privacy Profile, and current approval state at the last possible
boundary.

### Legacy Aletheia — `isolate`, then `migrate`, then `delete-later`

Legacy can be explicitly enabled for tests and migration tools. Active modules
may reuse an extracted core capability, but may not call Legacy routes,
repositories, global schedulers, or tables. Legacy adapters may call new core
modules during the compatibility window; dependency direction never reverses.

## 5. Canonical domain rules

1. Every legal Artifact has a stable Project-scoped identity and immutable
   revisions.
2. `candidate`, `accepted`, `superseded`, and `rejected` describe legal-state
   disposition; they are not inferred from model confidence.
3. AI-created revisions use `createdByType` and lineage. Acceptance or lawyer
   modification creates a new revision in the same transaction as the Review
   decision.
4. Source links attach to a specific Artifact revision, not merely the Artifact
   identity.
5. A Source Snapshot is immutable. A Citation Anchor is validated against the
   exact snapshot content, quote/segment hash, and locator revision.
6. Source changes invalidate anchors and can mark dependent outputs stale; they
   never mutate the original snapshot.
7. Customer instructions require confirmed speaker identity, an explicit
   Review Item, and a single-item decision. They are never bulk accepted.
8. Completed Work Items, superseded positions, prior drafts, rejected
   proposals, and migration errors remain queryable.

## 6. API boundaries

All active APIs remain under the sole authenticated `/api/v1` composition
root. Additive resource families are introduced in this order:

```text
/api/v1/matters
/api/v1/projects/:projectId/matter-profile
/api/v1/projects/:projectId/artifacts
/api/v1/projects/:projectId/reviews
/api/v1/work-items
/api/v1/projects/:projectId/conversations
/api/v1/projects/:projectId/source-records
/api/v1/agent-runs
/api/v1/word-bridge
/api/v1/evaluations
```

Compatibility requirements:

- existing `/api/v1/projects`, document, Assistant, workflow, tabular, source,
  and Studio contracts remain valid;
- new Matter creation atomically creates a Project and MatterProfile;
- a generic Project is not silently converted into a Matter;
- `/aletheia/*` is not mounted unless `VERA_ENABLE_LEGACY_ROUTES=true`;
- Legacy runtime startup is independent and requires
  `VERA_ENABLE_LEGACY_RUNTIME=true`;
- health reports Workspace, Matter, Conversation, and Legacy lifecycle states
  separately without paths, secrets, raw errors, or source content.

## 7. Review and transaction boundaries

Proposal creation and acceptance are separate operations:

```text
proposal transaction:
  candidate Artifact / external target reference
  + Review Item
  + audit event

accept transaction:
  Review Decision
  + accepted or lawyer-modified Artifact revision
  + current revision pointer update
  + relation/source links
  + optional deduplicated Work Item
  + audit event
```

Studio acceptance continues to use current base-version compare-and-swap,
exact-splice validation, and immutable versions. Review Inbox stores a target
reference and review metadata; it does not duplicate Studio, OCR, workflow,
tabular, or transcript payloads.

## 8. Agent and workflow boundary

An Agent Run pins its model profile and allowed tool set when planned. Model
changes apply only to a later run. Events and tool calls are append-only and
recoverable after restart.

The Tool Broker accepts strict typed identifiers, never raw paths or arbitrary
URLs. Mutating tools create proposals. External reads pass allowlist,
credential, retention, and egress checks. The model cannot manufacture an
approval or accepted state.

Legal workflow definitions declare input/output types, allowed tools, required
capabilities, remote-inference policy, human-review requirement, stale
conditions, and recovery behavior. Workflow execution continues through the
existing durable job system.

## 9. Information architecture

Top-level active navigation converges to:

```text
Matters | Work Queue | Workflows | Assistant | Settings
```

Matter navigation is:

```text
Overview | Sources | Case Map | Work | Activity
```

Tabular Review remains reachable by compatible deep links but is presented as a
Matter Work capability. Global Assistant is for unassigned work; Matter
Assistant binds the current Project by default. Existing source viewers,
citation controls, document preview, rich-text editor, and Studio are reused.
All new strings enter the existing i18n mechanism; conflict, confidence, and
review state are conveyed by text/icon as well as color.

## 10. Conversation architecture

Phase 5 starts with imported WAV, MP3, M4A, and MP4. The invariant is:

```text
saved audio = source of truth
live transcript = ephemeral preview
batch transcript = persisted machine layer
reviewed transcript = separate human layer
```

Audio becomes an encrypted blob governed by Matter retention policy. Machine
text is never overwritten by reviewed text. Conversation snapshots and anchors
use segment/time locators and bind the transcript revision. Extraction produces
candidates only.

Real-time capture is a later, independently packaged sidecar. `.partial` files,
atomic rename, bytes-on-disk recovery, explicit deletion audit, and
re-transcription from saved audio are release gates.

## 10.1 Email and manual-note sources

Email and notes are owned by Workspace Sources, not Conversations and not a new
document repository. A Project-scoped source record has immutable versions;
original message bytes or versioned note text use the existing encrypted blob
store. Snapshot capture binds one exact version, and anchors use message/thread
body ranges or note character ranges plus hashes. The first delivery is bounded
local import/manual editing. Provider mailbox access remains unavailable until
an allowlisted adapter passes credential, retention and egress review.

## 11. Word architecture

The existing `office-addin/` and `/office/word` proof-of-concept are
`migrate` assets, not the target security boundary. They are replaced or moved
to `word-addin/` only in the dedicated Word phase.

Document Studio remains canonical. Word is an external editing surface paired
through a loopback Vera Word Local Bridge using one-time pairing codes and
short-lived, Project-and-document-session scoped tokens. The bridge accepts no
provider credential, arbitrary path, or arbitrary URL. Conflicts preserve both
versions and create a new Studio version; whole-document model overwrite is not
allowed.

## 12. Security invariants

- backend and Word Bridge bind validated loopback literals only;
- renderer stays sandboxed and receives neither provider secrets nor local
  absolute paths;
- SQLCipher, encrypted blobs, Keychain, per-launch bearer, and backup/restore
  fail-closed behavior remain mandatory;
- audit-health failure blocks mutations;
- Matter isolation is checked in repositories and services, not only routes;
- source retention/egress policy is re-evaluated at model, export, Word, and
  external-source boundaries;
- logs and audit events exclude secrets, raw audio, unlimited full text,
  absolute paths, and unredacted provider failures;
- high-risk external actions require a recorded approval; court filing, final
  email sending, and automatic client-instruction acceptance remain unavailable.

## 13. Delivery order and commit boundaries

Each phase must leave the desktop startable. Within a phase, schema, backend,
UI, voice, Word, and Legacy deletion are separate commits when more than one is
present. The ordered delivery is:

1. audit/design documentation;
2. Legacy route/runtime isolation;
3. MatterProfile persistence/API, then Matters naming/navigation;
4. Artifact/revision graph, then Case Map and Assistant proposal entry;
5. Review Inbox, then Work Queue and integrations;
6. imported Conversations;
7. real-time capture sidecar;
8. inference/tool brokers and legal workflow steps;
9. email/manual-note source records and capture APIs in a separate schema/backend commit;
10. Word Local Bridge and Add-in;
11. Legacy data migration and code isolation;
12. evaluation storage/readouts and packaged release/security gates.

No phase claims completion with static UI, TODO handlers, fixtures standing in
for providers, or a success response that did not perform the bounded action.
