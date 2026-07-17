# Vera Legal Workspace Roadmap

Date: 2026-07-17

Status: canonical forward plan

Current merged `main`: `5611699e46552a20bf42ce84396a8e65aa139d16`

Current feature-branch Workspace schema: v23

## 1. Product truth source

```text
Current product:
Vera local general legal workspace

Current primary navigation:
Assistant / Matters / Workflows / Review / Settings

Current core:
Mike-derived local workspace + Vera encrypted desktop runtime

Legacy:
default-disabled compatibility and reusable implementation source only

Next milestone:
Agent Tool Expansion
+ One Authorized Legal Research Provider
+ Agent-to-Draft End-to-End Vertical
```

The next milestone is not a redesign and does not introduce a second database,
document system, job runtime, model gateway, editor, or active Legacy product.
It composes the existing Matter, document/OCR, Assistant, Workflow, source,
Studio, DOCX, security, and recovery owners into one useful legal-work path.

## 2. Completed merged baseline

The following capability families are merged and available in the active
Workspace runtime:

- one Electron-managed loopback Next.js/Express lifecycle;
- one SQLCipher Workspace database with additive migrations through v23;
- encrypted local Blob storage and isolated Keychain credential handling;
- Project-owned Matter Profile, explicit workspace classification, capability
  projections, continuous Matter shell, and unified inference policy;
- durable Assistant streaming, bounded tool calls, stop, retry, regenerate,
  recovery, and document citations;
- OpenAI, DeepSeek, Anthropic, Gemini, and hardened OpenAI-compatible adapters;
- Project/Matter documents, parsing, OCR, provenance, source snapshots, and
  citation anchors;
- durable Workflow and Tabular execution on the same Job Runtime;
- Document Studio versions, source-aware suggestions, accept/reject/stale
  checks, and DOCX import/export;
- composed Document/Draft/Workflow Assistant tools, a real Matter Drafts
  workbench, and eight local legal-document templates with bounded DraftPlans;
- encrypted backup/restore, security gates, and local packaged restart tests.

The primary navigation is already `Assistant / Matters / Workflows / Review /
Settings`. Already merged Matter work must not be described as an unmerged
feature branch or as still awaiting a `main` merge.

Local package evidence is unsigned, unnotarized, and local-only. It proves a
local packaged runtime, not Developer ID signing, Apple notarization, public
distribution readiness, or remote CI for a different commit.

## 3. Immediate vertical sequence

### Stage 1 — Documentation and Tool Registry

Status: implemented and covered by retained Assistant registry audits.

Objective: establish a truthful baseline and replace the one-file Assistant
tool composition with one registry while preserving behavior.

Deliverables:

- canonical product/status/roadmap/gap documents;
- `AssistantToolModule` and one composed `AssistantToolPort`;
- initial DocumentTools wrapper preserving current tool names, schemas,
  adapter identity, results, ownership rechecks, and cancellation;
- duplicate module/tool rejection, attempt isolation, bounded registration
  state, unregistered-call rejection, and focused regression tests.

Migration/API/UI: none.

Exit: backend build, migration and Assistant suites pass with no behavior
change.

### Stage 2 — Active Legal Provider Hub and research contracts

Status: Provider Hub, Settings, fixed YuanDian technical PoC, and test-only
provider contracts are implemented. Durable production research ownership and
legal-authority Assistant citations remain incomplete.

Objective: add `search_legal_sources` and `read_legal_source` behind an active
Workspace provider boundary, without enabling an unverified vendor.

Deliverables:

- truthful provider states: `unavailable`, `not_configured`,
  `configured_unverified`, `ready`, `authentication_failed`,
  `license_restricted`, `activation_gate_closed`, and
  `temporarily_unavailable`;
- backend-only HTTPS/allowlist/redirect/timeout/cancellation/size/redaction
  controls;
- Matter-owned research session/query/candidate identity and Source
  Snapshot/Citation Anchor reuse;
- active `/api/v1` Settings and status contracts that never expose credentials;
- deterministic fake provider registered only in tests;
- contract tests for unavailable and security/failure states.

The production state stays unavailable until one vendor supplies the official
contract, licensed credential, rights matrix, and live acceptance evidence
listed in [legal provider activation requirements](legal_provider_activation_requirements.md).
No endpoint or response shape may be guessed.

### Stage 3 — One authorized provider

Status: externally blocked. The YuanDian technical PoC proves transport only;
the activation gate remains closed pending documented rights and live acceptance.

Objective: activate exactly one licensed PKULaw or YuanDian vertical.

Entry criteria:

- archived official endpoint, authentication, search, pagination, and source
  retrieval documentation;
- lawful licensed test account and credential;
- explicit display, retention, export, model-use, and onward-distribution
  rights;
- DPA, SLA, data-region and incident/support requirements resolved;
- representative acceptance queries and known sources.

Exit requires a live, non-fixture search -> source read -> snapshot -> Agent
evidence -> Draft path. A fake provider, Legacy contract test, configured
endpoint, or successful connection probe cannot satisfy this stage.

### Stage 4 — Draft and Workflow tools

Status: implemented, including durable action budgets and the Draft result card.

Objective: compose `DraftTools` and `WorkflowTools` using the existing Studio
and Workflow owners.

Required tools:

```text
create_draft
read_draft
suggest_draft_edit
list_workflows
read_workflow
run_workflow
get_workflow_run
```

Rules:

- `create_draft` always creates a new Studio Draft and durable artifact link;
- renderer paths or arbitrary version IDs are never trusted;
- suggestions require an exact read/base revision and remain user accepted or
  rejected; the Agent cannot overwrite a Draft;
- Workflow ownership and state are rechecked server-side; runs return durable
  IDs and do not block one tool call indefinitely.

### Stage 5 — Legal research loop and UI

Status: implemented for deterministic test-only research. The bounded
prompt/tool loop, Provider status, legal-authority citation projection, Draft
result, Matter Drafts workbench, templates, and DraftPlan preview are wired.
Production provider activation remains closed.

Objective: let one Matter Assistant distinguish local facts from legal
authorities, search only when authorized, read selected sources, cite evidence,
and create a Studio Draft.

Deliverables:

- bounded research, read, Draft, suggestion, and Workflow budgets within the
  existing ten-round/sixteen-call tool loop;
- legal-authority citation projection backed only by actually read snapshots;
- localized tool activity and truthful model/provider unavailable states;
- durable Create Draft result card with Matter-safe routing;
- real Matter Draft list and shared source viewer integration;
- no raw tool IDs, internal leases, raw JSON, or credentials in normal UI.

### Stage 6 — Deterministic packaged end-to-end acceptance

Status: implemented for the test-only Provider; live-provider acceptance is
not asserted.

Objective: prove the complete local vertical without confusing test-provider
and live-provider evidence.

The deterministic test path creates a Matter, uploads and parses documents,
uses document tools and a test-only provider, reads legal evidence, returns both
source kinds, creates and edits a Studio Draft via suggestion, exports DOCX,
restarts the app, and verifies Matter/chat/sources/Draft/version persistence.

Live-provider acceptance is a separate run using the licensed account and its
retention rules. If no credential is available, the packaged test may pass
while the live stage remains explicitly blocked.

### Stage 7 — Matter contract bulk extraction preset

Status: implemented on the current feature branch through Workspace schema v23.

One active built-in Tabular workflow can open the current Matter Review with a
server-managed column preset. Creation omits renderer-owned columns; the
backend validates an active global built-in workflow and snapshots the full
column definition, including format and tags. Preset columns and document
scope are immutable after creation, while custom Tabular reviews remain
editable. The UI groups only persisted cell status/flags, preserves the matrix
and exact-source views, and states that every output requires lawyer review.

The source-preserving Tabular-to-`contract_review_memo` Studio handoff is now
implemented. Only completed reviews bound to the two supported global built-in
contract presets qualify. The server revalidates the unchanged preset snapshot,
every cell's generation Job payload/result lineage, and every exact
document/version/chunk/quote/offset source before atomically creating the typed
Draft, immutable source bindings, and v23 handoff record. Server-derived replay
returns the original handoff version after later edits and restart.

The result remains an AI-generated draft requiring lawyer review. Persisted
color flags are extraction markers, not legal risk ratings, approval states, or
proof that unflagged clauses are safe. This stage does not claim Harvey or
Legora feature parity.

## 4. Migration order

Migrations v1-v23 are published and immutable. The Tool Registry needed no
migration. v18 owns Provider configuration, v19 owns the Assistant action
ledger, v20 owns Draft type/origin metadata, v21 owns the local template
catalogue plus bounded DraftPlans, v22 owns bounded durable legal-research
replay/read/message-source bindings, and v23 owns immutable Tabular Review to
Studio Draft evidence handoffs:

```text
legal_research_sessions
legal_search_queries
legal_search_candidates
legal_research_reads
legal_research_read_anchors
assistant_legal_authority_message_sources
tabular_review_studio_handoffs
```

Before v18 lands, the design must prove that existing documents, source
snapshots, anchors, Studio documents/versions/suggestions, chats, jobs,
workflows, profiles, and policies cannot own the state. Every migration remains
transactional, contiguous, checksum-recorded, Project-owned, backup-aware, and
tested from fresh/current/older encrypted databases with injected rollback.
There are no destructive down migrations.

## 5. Required validation

Each implementation stage reports the exact commit, code/API/migration/UI/tool
changes, commands run, pass counts, failures/fixes, current limits, external
blockers, and next stage.

The retained baseline includes:

- backend build, migration, Assistant, Workflow, Tabular, OCR and Studio tests;
- frontend lint/build and focused Assistant/Matter/Studio tests;
- desktop security, SQLCipher, Blob, backup/restore, restore fail-closed,
  package hygiene, port release and restart persistence;
- source ownership, retention/model-use, cancellation, size, secret/path
  redaction and Legacy default-off checks;
- an SHA-256 manifest generated for the exact local package under test.

README/status claims change only after the matching code and acceptance pass.
Provider contract tests never become live-provider evidence, and local
packaged acceptance never becomes a signed-release claim.

## 6. Explicit non-goals

This milestone does not implement multi-Agent conversation, autonomous
litigation, Case Map, a new evidence graph or artifact ontology, Firm Hub,
multi-user ACL/SSO, DMS/cloud sync, Outlook/email, live meeting capture, a
second commercial legal database, or unreviewed whole-document overwrite.

It uses only public capability categories for comparison with other products;
it does not copy Harvey/Legora branding, private code, prompts, or interfaces.

## 7. Rollback and blockers

Documentation and Tool Registry commits are independently revertible and do
not mutate data. Later provider activation defaults off; rollback disables the
provider, removes its credential reference, cancels in-flight calls, and keeps
permitted snapshots under their recorded retention policy. Schema rollback
uses a verified pre-upgrade backup when binary compatibility requires it.

Current external blockers are the missing authorized Provider material and
licensed live acceptance account. Developer ID signing/notarization credentials
are a separate distribution blocker, not a blocker for local implementation.
