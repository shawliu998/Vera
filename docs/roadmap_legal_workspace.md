# Vera Legal Workspace Roadmap

Date: 2026-07-16

Status: canonical forward plan — **implementation and local packaged
acceptance complete; remote final-commit CI pending**

Historical pre-merge baseline: `origin/main` at `12af6fc5` (Workspace schema
v14)

Historical feature-branch baseline: `feat/legal-matter-agent-convergence` at
`408333d7` (Workspace schema v15)

Current merged `main` baseline: `9ba3759c` (Workspace schema v16).

Current stabilization worktree: Matter convergence implementation on top of
that merge at Workspace schema v17. Source, full local CI-equivalent, and
unsigned local packaged acceptance pass; this is not a signed release baseline.

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
- historical v14/v15 baselines, merged `main` v16, and stabilization v17 are
  not conflated;
- no uncommitted implementation is described as delivered;
- no new product feature is added in the Gate 0 commit.

### Gate 1 — Product convergence and Matter Profile

Gate 1 has **implementation and local packaged acceptance complete; remote
final-commit CI pending**. Its implementation is split into 1A–1E so local
acceptance cannot be confused with remote or signed release acceptance.

| Slice | Current state | Exit evidence still required |
| --- | --- | --- |
| 1A Legacy isolation | Implemented; focused audit and packaged default-off startup pass. | Remote final-commit CI. |
| 1B Matter Profile and classification | v16 schema/API/transactions plus packaged encrypted CRUD/restart pass. | Remote final-commit CI. |
| 1C Minimal inference policy | v17 authority plus packaged Global/Project/Matter enforcement and persistence pass. | Remote final-commit CI. |
| 1D Continuous Matter shell | List/route adapter tests plus packaged navigation and cross-restart state pass. | Remote final-commit CI. |
| 1E CI and packaged acceptance | Complete local Actions-equivalent chain and current unsigned macOS package pass. | Remote final-commit CI; signed/notarized artifacts only for distribution. |

#### 1A. Legacy isolation

Implemented and retained from `edf26827`:

- `VERA_ENABLE_LEGACY_ROUTES` and `VERA_ENABLE_LEGACY_RUNTIME` require the exact
  string `true`;
- official desktop and Compose defaults keep both off;
- Legacy modules are loaded only inside the enabled boundary;
- the Workspace product remains functional without Legacy routes, seed, or
  runtime.

#### 1B. Matter Profile and classification

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

The Matter Profile module remains beneath the existing `/api/v1`
authentication and audit-mutation boundary:

```text
GET/POST  /api/v1/matters
GET/PATCH /api/v1/matters/:projectId
GET/PATCH /api/v1/matters/:projectId/policy
GET/POST/PATCH /api/v1/projects/:projectId/matter-profile
```

Rules:

- a new Matter atomically creates one Project and one Matter Profile in the
  existing Workspace database;
- a generic Project is never silently converted;
- list/read projections expose nullable `workspace_type`, exact item state
  `profile_state: absent | classification_required | ready`, and truthful
  feature capabilities;
- list queries accept `profile_state: profiled | ready |
  classification_required | absent | all`; filtering occurs in SQL before
  keyset pagination, and each filtered stream owns its cursor;
- Project General plus Matter Profile combined edits use one
  `BEGIN IMMEDIATE` transaction and one monotonic timestamp;
- the compatibility projection may include generic Projects, but the UI must
  put them in a separate “add Matter Profile” section;
- Project APIs and `/projects/:id/**` deep links remain valid;
- `tabular_review_count` keeps its real name; it is not presented as unified
  Review count;
- Profile persistence, Project creation, and Overview aggregation remain
  separate owner ports. One application service/transaction coordinator
  composes Project and Profile writes on the same WorkspaceDatabase
  transaction; owner ports do not begin or commit nested transactions;
- health reports Profile schema readiness separately from inference-policy
  readiness.

#### 1C. Minimal inference policy

Migration v17 and `WorkspaceInferencePolicy` implement one backend authority
for Global, generic Project, and Matter scope:

- model execution location, retention, training use, and sensitive-data
  permission are explicit declarations and never inferred from a URL;
- Global and generic Project calls use the Workspace model-privacy rule and do
  not manufacture a Matter Profile or Matter Policy;
- Matter calls additionally require a complete Matter Policy and an allowed
  execution location. Missing policy and an empty location set deny;
- `approval` remains `require_approval`; it is not treated as allow;
- capability projection uses side-effect-free `evaluate`; enqueue/final
  enforcement uses `assertAllowed` and records a bounded decision;
- Assistant and Workflow recheck at the shared Assistant provider boundary;
  Tabular rechecks at its cell provider boundary;
- Studio has no separate provider generator in Gate 1. Assistant-created
  suggestions inherit the Assistant boundary; `studio_suggestion` is reserved
  for a future direct generator.

Gate 1 does not add permissive policy defaults or claim that approval UX is
complete.

#### 1D. Continuous Matter shell

Use the current design system and complete Chinese/English i18n:

- top navigation: Assistant, Matters, Workflows, Review, Settings;
- Review is visibly unavailable until Gate 2 has a real backend;
- `/matters` supports list, explicit conversion, and atomic creation;
- `/matters/:id` provides a real Overview and edit capability;
- Matter navigation is Overview, Documents, Assistant, Review, Workflows,
  Drafts;
- Documents, Assistant, and Workflows reuse existing Project-scoped routes;
- backend Review Center capability remains disabled until Gate 2. The current
  `/matters/:id/review` route is only a compatibility route for the existing
  Tabular Review owner and is controlled by the `tabular` capability;
- Drafts links only to real Studio-backed content; if a complete Draft list
  cannot be derived, it is marked unavailable rather than populated with fake
  data;
- the exact `/projects` list route can redirect to `/matters`, while every
  dynamic Project, Tabular, and Studio compatibility route remains intact;
- the application landing route stays `/assistant` unless a later ADR changes
  it.

#### 1E. CI and packaged acceptance

The two failures in GitHub Actions run 29465212424 have source-level fixes. The
complete backend local-first command block, frontend lint/legal-source/UI smoke,
desktop signing-contract prechecks, and
`VERA_RELEASE_SIGNING=false ./scripts/package-desktop-mac.sh` pass locally.

`packagedWorkspaceE2E.js` now exercises the Gate 1 v3 success chain: classified
Matter creation, explicit model privacy, complete Matter Policy, two source
snapshots, real Matter Assistant provider/tool turns with exact citations, and
offline restart verification of the exact Profile/Policy/default-model/chat/
source/count/capability state. The same package run also passes SQLCipher,
migration, backup/restore, restore-failure, native OCR, hygiene, and CSP gates.

The resulting Vera 1.0.1 arm64 DMG/ZIP are unsigned, unnotarized, local-only
acceptance artifacts. Gate 1 still awaits GitHub Actions on the exact final
commit; a distributable release additionally requires Developer ID signing,
notarization, stapling, and new artifact hashes.

### Gate 2 — Proposal contract and Unified Review Center

Use the planned additive v18 migration after v17 for:

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

Only after that Proposal Contract → Review Center slice is accepted may
adapters be considered in this order:

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

Work Queue, broad adapters, and new formal owners are not Gate 2 entry work and
must not begin before the first vertical slice passes its packaged acceptance.

### Gate 3 — Inference policy controls and Knowledge

Split this Gate into independently migrated and tested slices.

#### 3A. Inference policy controls

- extend the v17 minimal declaration with attestation, administrator/user
  controls, and a complete approval workflow;
- enforce Source retention/model-use policy at the last outbound boundary;
- preserve the existing `allow`, `require_approval`, and `deny` contract unless
  a later ADR introduces a separately reviewed redaction decision;
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

Migrations v15, v16, and v17 are implemented and immutable. Versions v18 and
later remain planning reservations and can be split before their migration
lands:

| Version | Domain                                                                       |
| ------- | ---------------------------------------------------------------------------- |
| v15     | Existing Matter Profile and dormant fail-closed Matter Policy foundation     |
| v16     | Broad workspace classification and jurisdiction                              |
| v17     | Explicit model privacy declarations and inference decision ledger             |
| v18     | Proposal and resolution contract                                             |
| v19     | User-created tasks only after a separately accepted Work Queue contract       |
| v20     | Inference-policy controls/attestation if durable state is required            |
| v21     | Knowledge Collections and reference-only items                               |
| v22+    | Legal-source, Word, or Conversation state only when its contract is approved |

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

Gate 1A–1E source implementation, the complete local CI-equivalent chain, and
the current unsigned macOS cross-restart package acceptance are complete. The
immediate work is to push the reviewed commits and obtain the required GitHub
Actions result for that exact final commit. Developer ID signing and
notarization remain separate distribution requirements.

Only after the remote final-commit evidence is recorded does Gate 2 begin, with one real
Document Studio suggestion projected through the Proposal Contract into the
Review Center, including authoritative accept/reject and stale/source
revalidation. No broader Review adapter, Work Queue, Knowledge, or automation
scope is pulled forward.
