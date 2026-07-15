# Vera Legal Workspace Roadmap

Date: 2026-07-16

Status: canonical forward plan

Code baseline: `origin/main` at `12af6fc5` (Workspace schema v14)

Feature-branch baseline: `feat/legal-matter-agent-convergence` at `408333d7`
(Workspace schema v15)

## 1. Delivery objective

Vera Individual evolves in bounded, reversible vertical slices from the
Mike-derived local Workspace into a Matter-centric legal workspace. The active
product continues to use one Electron lifecycle, one Next.js renderer, one
loopback Express backend, one SQLCipher Workspace database, one encrypted blob
store, one durable Job Runtime, and one model gateway.

The sequence deliberately puts a truthful, source-backed human review boundary
before broader automation. It does not make Case Map, autonomous litigation,
multi-user SaaS, real-time voice, or a second document/model runtime a
prerequisite for useful legal work.

The canonical architecture decision is
[`docs/adr/vera-product-convergence.md`](adr/vera-product-convergence.md). The
gap and reuse evidence live in
[`docs/vera_legora_harvey_gap_analysis.md`](vera_legora_harvey_gap_analysis.md)
and [`docs/reuse_decisions.md`](reuse_decisions.md).

## 2. Current branch disposition

Three commits predate this revised roadmap:

| Commit     | Disposition                                                                                                                                            |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `eb9e75e0` | Retain its source-backed audit as historical evidence. New canonical Gate 0 documents supersede its forward IA and phase ordering.                     |
| `edf26827` | Retain unchanged. It provides the required default-off Legacy route/runtime flags and lazy loading.                                                    |
| `408333d7` | Retain as an additive, already-committed v15 foundation. Its narrow `matter_type` is transitional and must not become the new public product taxonomy. |

Migration v15 is treated as immutable. Gate 1's schema slice adds v16 rather
than changing the v15 checksum. The Matter API/UI work was adapted to this
contract, independently security-reviewed, and accepted only with its focused
and retained-product regression evidence.

## 3. Gate sequence

### Gate 0 — Audit and convergence baseline

Deliverables:

- the four canonical documents required by this roadmap;
- an inventory of active routes, tables, runtimes, jobs, source/citation
  ownership, frontend navigation, packaging gates, and Legacy side effects;
- a capability-family comparison using public product information only;
- fixed reuse decisions and explicit no-copy boundaries;
- this executable roadmap and the convergence ADR;
- supersession notices on older forward-looking convergence documents.

Exit criteria:

- every current-state claim is backed by code, test, migration, or fixed-source
  evidence;
- `origin/main` v14 and feature-branch v15 are not conflated;
- no uncommitted implementation is described as delivered;
- no new product feature is added in the Gate 0 commit.

### Gate 1 — Product convergence and Matter Profile

Gate 1 is delivered as separate schema, API, UI, and release-evidence commits.

#### 1A. Legacy isolation

Already implemented by `edf26827`:

- `VERA_ENABLE_LEGACY_ROUTES` and `VERA_ENABLE_LEGACY_RUNTIME` require the exact
  string `true`;
- official desktop and Compose defaults keep both off;
- Legacy modules are loaded only inside the enabled boundary;
- the Workspace product remains functional without Legacy routes, seed, or
  runtime.

#### 1B. Matter classification migration

Migration v16 adds the following without editing v15:

- `workspace_type`: `general_legal`, `transaction`, `dispute`,
  `investigation`, `compliance`, or `research`;
- bounded optional `jurisdiction`;
- existing v15 rows remain readable with an explicit
  `classification_required` capability until the user selects a value;
- new Matter creation requires `workspace_type` at the database boundary;
- a classified row cannot be changed back to an unclassified row;
- no automatic mapping guesses from the older v15 `matter_type` values.

Because v15 made `matter_type` required, the v16 compatibility writer stores
the fixed non-semantic sentinel `general` in that legacy column for every new
row. It never derives a v15 value from `workspace_type`, never returns the
legacy field as public classification, and never backfills an existing v15 row
by guess. `workspace_type` stays nullable only so a pre-v16 row can surface as
`classification_required`; the v16 service requires it for every new Matter.

Canonical ownership avoids duplicate fields:

- Project owns name, description, lifecycle status, `cm_number` (presented as
  Matter number), and `practice` (presented as practice area);
- Matter Profile owns workspace classification, client name, jurisdiction,
  represented role, and objective;
- v15 litigation-oriented fields remain bounded transitional metadata, do not
  drive navigation, and are not silently promoted to sourced facts.

#### 1C. Matter module and API

Add the Matter Profile module beneath the existing `/api/v1` authentication and
audit-mutation boundary:

```text
GET/POST  /api/v1/matters
GET       /api/v1/matters/:projectId
GET/POST/PATCH /api/v1/projects/:projectId/matter-profile
```

Rules:

- a new Matter atomically creates one Project and one Matter Profile in the
  existing Workspace database;
- a generic Project is never silently converted;
- list/read projections expose nullable `workspace_type`, exact
  `profile_state: absent | classification_required | ready`, and truthful
  feature capabilities;
- the compatibility projection may include generic Projects, but the UI must
  put them in a separate “add Matter Profile” section;
- Project APIs and `/projects/:id/**` deep links remain valid;
- `tabular_review_count` keeps its real name; it is not presented as unified
  Review count;
- Profile persistence, Project creation, and Overview aggregation remain
  separate owner ports. One application service/transaction coordinator
  composes Project and Profile writes on the same WorkspaceDatabase
  transaction; owner ports do not begin or commit nested transactions;
- health reports Profile schema readiness separately from the future Inference
  Policy.

#### 1D. Matter UI

Use the current design system and complete Chinese/English i18n:

- top navigation: Assistant, Matters, Workflows, Review, Settings;
- Review is visibly unavailable until Gate 2 has a real backend;
- `/matters` supports list, explicit conversion, and atomic creation;
- `/matters/:id` provides a real Overview and edit capability;
- Matter navigation is Overview, Documents, Assistant, Review, Workflows,
  Drafts;
- Documents, Assistant, and Workflows reuse existing Project-scoped routes;
- Review remains disabled until Gate 2;
- Drafts links only to real Studio-backed content; if a complete Draft list
  cannot be derived, it is marked unavailable rather than populated with fake
  data;
- the exact `/projects` list route can redirect to `/matters`, while every
  dynamic Project, Tabular, and Studio compatibility route remains intact;
- the application landing route stays `/assistant` unless a later ADR changes
  it.

#### 1E. Interim inference safety

The v15 Matter Policy tables are not evidence of an implemented Inference
Policy. Before Gate 1 is declared complete, model calls for a Project with a
Matter Profile must pass a backend-owned interim gate. Missing policy or an
empty allowed execution-location set denies generation. The renderer cannot
bypass this via a Project deep link. Generic Projects and global Assistant keep
their existing P0 model-readiness behavior during this compatibility window;
they cannot use `matter_policies`, whose foreign key deliberately requires a
Matter Profile.

Gate 1 does not add permissive policy defaults. Gate 3 supplies verified model
privacy metadata and the user-facing controls needed to enable Matter
inference safely, plus an explicit Workspace/global inference-policy port and
persistence fallback for generic Projects and global Assistant. That fallback
must not create a Matter Profile or silently convert a Project.

### Gate 2 — Proposal contract and Unified Review Center

Use a new additive migration after v16 for:

```text
workspace_proposals
proposal_source_anchors
proposal_resolution_events
```

The first complete slice is a Document Studio suggestion projected into the
Review Center. Acceptance delegates to the existing authoritative Studio
service, re-reads the current suggestion and base version, validates source,
retention, stale state, and audit health, then records the resolution in the
same database transaction as the formal version change.

Adapters then expand in this order:

1. OCR warning: acknowledge, defer, or reopen through typed resolution events;
   it is not a legal fact and those actions are not Proposal lifecycle states.
2. Workflow output: create a reviewable Draft, not formal Matter state.
3. Tabular result: create a reviewable Draft/export selection, preserving the
   authoritative Tabular owner.
4. Assistant-to-Draft action: explicit proposal, never direct overwrite.

Proposal lifecycle is exactly `open`, `accepted`, `modified`, `rejected`, or
`superseded`. Type-specific actions are recorded in resolution events and do
not add shadow lifecycle states.

Fact, issue, task, and other structured acceptance are not claimed until their
formal owner and atomic promotion contract exist. Review items reference the
authoritative payload; adapters do not clone entire Studio, OCR, Workflow, or
Tabular records.

Matter Overview gains a real open-Proposal count only after the Review query is
live. Review becomes an enabled top-level and Matter navigation destination at
that point.

#### Gate 2B — Work Queue projection

The new plan names Work Queue as necessary but does not assign it a numbered
Gate. It is therefore an explicit Gate 2 follow-on, not a new top-level product
area. Review can expose Queue as a secondary mode.

- aggregate open Proposals, failed/retryable Jobs, OCR warnings, Studio
  suggestions, and waiting Workflow work by stable references;
- add a formal table only for user-created tasks;
- do not copy source payloads or create a second job state machine;
- define deduplication, completion history, and Project ownership.

### Gate 3 — Inference Policy and Knowledge

Split this Gate into independently migrated and tested slices.

#### 3A. Inference Broker policy

- extend Model Profile with declared execution location, retention, training
  use, sensitive-data permission, and attestation;
- expose Matter Policy API/UI with deny-all defaults;
- enforce Source retention/model-use policy at the last outbound boundary;
- return only `allow`, `allow_after_redaction`, `require_approval`, or `deny`;
- record bounded egress audit metadata answering what, where, model, policy,
  redaction, approval, retention, and training-use questions;
- never infer “local” solely from a URL.

#### 3B. Knowledge Collections

- create Personal and Matter logical collections;
- collection items reference existing Document Versions, Source Snapshots,
  Workflows, or Templates and never duplicate blobs/content;
- use existing FTS5 and source anchors before considering another index;
- require explicit user selection for Personal-to-Matter use;
- reject persistent cross-Project references by default; any explicitly
  authorized Personal-to-Matter use is revalidated on every read/model use,
  follows source retention and deletion, becomes unavailable after tombstone,
  and has focused isolation/backup tests;
- define `FirmKnowledgePort`, but do not emulate multi-user Firm Knowledge in
  the local database.

### Gate 4 — Authorized China legal-source loop

- extract the legal-source broker boundary from Legacy ownership without
  importing Legacy runtime or tables into the active product;
- choose one licensed Provider and document its search/full-text/citation,
  jurisdiction, pagination, retention, export, and model-use capabilities;
- validate real credentials and a real authorized search/full-text/snapshot/
  anchor/user-selection/Draft flow;
- expose `unavailable`, `configured_unverified`, or
  `activation_gate_closed` accurately when the external boundary is absent;
- never use browser cookies, scraping, private endpoints, or fixtures as live
  acceptance evidence.

Provider credentials, contract rights, or network access may be a real external
blocker. Internal ports and truthful unavailable states can land, but Gate 4 is
not complete until one authorized vertical flow passes.

### Gate 5 — Word integration

Migrate the existing `office-addin` proof of concept into the only Office
Add-in package; do not copy the full Vera frontend or add a parallel Add-in.

- official Office.js origin and license/terms review;
- short-lived, origin-bound, Matter- and document-session-scoped capability
  tokens;
- no Keychain or Provider credential access from the Add-in;
- explicit Matter selection and bounded source search;
- insertion of Assistant output and citations;
- selected-text rewrite as a Proposal;
- source check and explicit Draft/version creation;
- no automatic whole-document upload or unreviewed overwrite.

### Gate 6 — Team boundary preparation

Introduce narrow ports and local single-user adapters only:

```text
IdentityPort
MatterAclPort
FirmKnowledgePort
FirmPolicyPort
FirmAuditPort
```

Document a Firm Hub topology separately. Do not create tenants, simulated team
members, shared spaces, or an in-process multi-user SaaS in Electron.

### Gate 7 — Optional Conversation Source

Only after the core review, inference, source, and drafting loops are stable:

- import approved audio formats into the existing encrypted blob store;
- use an optional local transcription adapter;
- persist machine and reviewed transcript layers separately;
- create transcript snapshots and timestamp anchors;
- make speaker correction explicit;
- send extracted candidates to Review;
- update a Matter only after an accepted Proposal.

Real-time capture remains a later sidecar and must pass separate provenance,
license, native packaging, saved-audio recovery, and model-weight reviews.

## 4. Provisional migration order

Migrations v15 and v16 are committed. Versions v17 and later remain planning
reservations and can be split before their migration lands:

| Version | Domain                                                                       |
| ------- | ---------------------------------------------------------------------------- |
| v15     | Existing Matter Profile and dormant fail-closed Matter Policy foundation     |
| v16     | Broad workspace classification and jurisdiction                              |
| v17     | Proposal and resolution contract                                             |
| v18     | User-created tasks for the Work Queue                                        |
| v19     | Model privacy metadata and source/inference policy evolution                 |
| v20     | Knowledge Collections and reference-only items                               |
| v21+    | Legal-source, Word, or Conversation state only when its contract is approved |

Released migration files and checksums are immutable. Every new migration is
additive, transactional, contiguous, bounded, and preserves Project ownership,
existing Workspace data, and Legacy tables. A documented additive
rollback/recovery path means a schema-aware compatibility binary may leave new
tables unused, while an older binary fails closed and restores the verified
pre-migration encrypted backup; it never means a destructive down migration.

## 5. Validation matrix

Every Gate executes and reports the complete baseline required by the product
plan: backend build, frontend lint/build, P0/P1 regression, focused tests,
migration fresh/current/Legacy upgrade, restart persistence, Job lifecycle,
encrypted Blob, plaintext-secret checks, safe errors, cross-Matter source and
citation isolation, stale/tombstone enforcement, truthful provider state,
Legacy default-off, and a current packaged macOS cross-restart E2E. A check
that the Gate does not exercise is still run against the retained
implementation where an existing suite exists; otherwise it is recorded as
not applicable and does not count as passed evidence for a new capability.

| Change class                 | Mandatory evidence                                                                                                                                          |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Documentation                | Links, filenames, baseline SHAs, source/provenance consistency, no unsupported completion claims, plus the complete retained-product baseline above         |
| Every code Gate              | Backend build; frontend lint/build; existing P0/P1 suites; focused tests; Legacy default-off; authentication/audit order; safe-error and secret/path checks |
| Schema                       | Fresh DB; v14/current-prefix upgrade; Legacy-table sentinel; SQLCipher; checksum; idempotence; injected rollback; ownership and backup/restore preservation |
| Job                          | Durable status, cancellation, retry, interrupted restart recovery, bounded input/output, safe errors                                                        |
| Proposal                     | Cross-Matter isolation; stale target; tombstoned/expired source; authoritative reread; atomic resolution/formal change; restart persistence                 |
| Provider                     | Truthful unavailable/configured states plus at least one authorized non-fixture vertical test before completion                                             |
| Every Gate packaged baseline | Build or verify a `Vera.app` from the current commit and run the macOS cross-restart E2E; Word/Conversation add capability/origin/encrypted-blob cases      |

Every Gate keeps older routes and data usable, documents its additive
rollback/recovery path, and ends with an accurate blocker list. README product
claims change only after the corresponding real vertical acceptance passes.

## 6. Immediate next slice

Gate 1's v16 schema, corrected Matter API, interim inference boundary, and
Matter UI slices are implemented and have passed the backend/security review.
The remaining Gate 1 acceptance item is a current packaged macOS cross-restart
run. After that release evidence is recorded, Gate 2 begins with one real
Document Studio suggestion projected through the Proposal Contract into the
Review Center, including authoritative accept/reject and stale/source
revalidation.
