# Product Status

This is Vera's authoritative short status. Code, migrations, and executable
tests take precedence over historical programme text below.

## Current product — local general legal workspace

Status on 2026-07-17: Matter convergence is merged to `main` at
`5611699e46552a20bf42ce84396a8e65aa139d16`; the active feature branch now uses
Workspace schema v23. The active
implementation branch for the next vertical is `feat/local-legal-work-agent`.

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

The active product is a single-user, local-first macOS workspace. Electron
supervises one loopback Next.js renderer and one loopback Express backend. One
SQLCipher database, encrypted Blob store, Keychain credential boundary,
durable Job Runtime, model gateway, Source Snapshot/Citation Anchor foundation,
and Document Studio own the active data and execution paths.

Implemented and wired in source:

- Matter creation, Profile/classification, policy, continuous shell, real
  capability projections, and Project-compatible deep links;
- uploads and parsing for the supported document set, packaged Apple Vision
  OCR, provenance, and exact-page reopening;
- durable Assistant streaming, tool loop, stop/retry/regenerate/recovery, and
  document citations;
- OpenAI, DeepSeek, Anthropic, Gemini, and bounded OpenAI-compatible profiles;
- Workflow and Tabular durable execution using the same local Job Runtime;
- Document Studio CAS save, immutable versions, restore, exact suggestions,
  accept/reject/stale handling, and DOCX import/export;
- encrypted backup/restore, restore fail-closed, sandboxed renderer, loopback
  authentication, and package/security checks.

Current production Assistant tools compose the existing document/Studio tools
with Matter-scoped `create_draft`, `read_draft`, `suggest_draft_edit`,
`list_workflows`, `read_workflow`, `run_workflow`, and `get_workflow_run`.
Agent-created Drafts use current-attempt evidence, server-rebuilt durable
anchors, stable replay identities, an action ledger, and a chat result card
that opens the exact Matter Draft. Workflow runs remain durable and
asynchronous; hidden and cross-Matter workflows fail closed. The trusted
optional registry also has bounded legal research tools for the YuanDian
technical acceptance path, but the default production Assistant does not
register them while the activation gate is closed.

The Matter Drafts route is now a real Document Studio workbench rather than an
empty navigation shell. It lists typed Drafts with current version, citation and
pending-suggestion counts; supports blank creation, exact Studio opening, DOCX
export, and scoped deletion; and records manual/Assistant/Workflow origin in the
same Draft transaction. Existing pre-v20 Draft rows are not backfilled or
guessed and are projected as general documents with unknown origin.

Schema v21 adds eight original built-in legal-document templates and bounded,
persisted DraftPlans. Matter Drafts can load a strict template catalogue,
preview ordered sections and required-source prompts, and create a real Studio
Draft from the selected template. Project-local copies can be edited through
authenticated, Project-scoped APIs; built-ins are immutable, archived Matters
are readable but reject writes, and cross-Matter access is hidden.

Schema v22 adds Matter/job/attempt-owned legal research replay, bounded candidate
metadata, durable read-to-snapshot/anchor capture, and transactional Assistant
authority-message bindings without changing the v5 document-source table.
Assistant and Draft citations accept only authority excerpts actually read and
reverified in the current attempt. The API/UI projection exposes only bounded
title, source type, locator, exact quote, and citation number; internal IDs,
URLs, credentials, provider payloads, and full text stay private.

Schema v23 adds an immutable, source-preserving handoff from a completed,
supported contract Tabular Review to a typed `contract_review_memo` Studio
Draft. The server derives the canonical review state, validates every cell's
Job payload/result lineage and exact document-version citation, and commits the
Draft, v1 version, citation bindings, parse job/blob metadata, and handoff in one
transaction. Replays return the same frozen handoff version even after later
lawyer edits or an application restart. The generated memo is an AI draft that
requires lawyer review; persisted color flags are extraction markers, not risk
ratings, and this slice does not claim Harvey or Legora feature parity.

The deterministic legal-work vertical uses the test-only Provider to verify
search -> durable read -> cited Assistant answer -> cited Studio Draft -> user
accepted suggestion -> DOCX -> reopen. It is test evidence, not live-provider
acceptance or a claim that the production activation gate is open.

The current feature branch also connects active built-in Tabular workflow
presets to Matter contract bulk extraction. The server, not the renderer,
snapshots the preset's complete column definition (including formats and
tags), rejects forged columns, and locks the preset matrix. The Matter UI can
open a preset directly from its Workflow, select ready local documents and a
verified model, run the existing durable Tabular jobs, inspect persisted
flags/sources, and export through the existing path. These outputs are
AI-generated extraction drafts requiring lawyer review; they are not approved
legal conclusions, a risk-scoring rubric, or a unified Review Center.

No production legal provider is claimed ready. The active Workspace now owns a
v18 YuanDian Provider Hub, Keychain-only credential operations, authenticated
configuration/test APIs, and the Settings surface. A separately invoked live
technical acceptance completed bounded search and source read against the fixed
official MCP endpoints. That proves transport compatibility only: results stay
transient and are not durable legal citations. The activation gate remains
closed until retention, export, and model-use rights are documented and the
durable Source Snapshot/Citation path is accepted. Vera does not substitute
scraping, browser cookies, private interfaces, web search, or a fake provider.

Current local packaged acceptance remains **unsigned, unnotarized, and
local-only**. It is not a signed release baseline. Developer ID signing,
notarization, stapling, Gatekeeper verification, and new artifact hashes remain
separate distribution requirements.

See [the vertical plan](local_legal_work_agent_vertical.md),
[provider activation requirements](legal_provider_activation_requirements.md),
[roadmap](roadmap_legal_workspace.md), and [desktop guide](desktop_app.md).

## Legacy historical status — Research Agent convergence

The remainder of this document records the earlier civil-litigation and
Research Agent programme. Statements such as “Current stage”, “Next”, or
“Available now” below apply to that historical track and are superseded for the
primary product by the primary product status above.

Current stage: **Vera Research Agent convergence.** The product is being
reduced to one local-first Chinese civil-commercial litigation workflow:
verified legal research followed by a lawyer-approved legal opinion. It remains
a bounded private-pilot build, not production/SaaS.

## Research Agent Focus

The authoritative scope is [Vera Research Agent](vera_research_agent.md):
local Matter intelligence, lawyer-visible redacted query approval, one controlled
Research Broker, immutable source snapshots, reviewed excerpts, source-bound
research conclusions, deterministic Citation Gate, human approval, and then a
single legal-opinion DOCX path. Contract lifecycle, generic chat, due diligence,
team collaboration, arbitrary browsing, commercial-database scraping, and
additional Agents are frozen.

**Available now:** the backend has source-specific provider workflows for
official public sources, Pkulaw and YuanDian, plus a disabled Wolters enterprise
compatibility slot/provider projection. Wolters China has no public or verified
machine interface in this build and Vera does not scrape it. YuanDian uses its
documented REST API, the audited Pkulaw MCP adapter exposes only a fixed tool,
and the controlled JSON gateway remains an enterprise compatibility mode.
Pkulaw MCP is search-only in this build; it does not claim case coverage or
full-text download. A request stays local unless the production activation gate
is deliberately opened; an exact redacted query requires
a single-use `external_source_use` approval before search; each candidate source
from a full-text-capable adapter requires a separate single-use approval before
download. Provider credentials
are encrypted locally and the Broker accepts only the explicit query or document
ID, never Matter facts or documents. It rejects non-HTTPS/non-allowlisted
endpoints, redirects, invalid provider responses, missing credentials, response
size overruns, and transport failures. Searches and downloaded sources become
matter-owned work products with audit events; downloads are encrypted local
source snapshots containing URL, retrieval time, content hash, version and
effective-date metadata. A lawyer must first save a local issue tree; its
immutable ID and tree hash are bound into the query plan, one-shot approvals,
search results, source snapshots, excerpts, input manifest, and memo. A later
issue-tree revision blocks the old plan and its downstream input chain. A lawyer
must confirm exact source excerpts before an input manifest can bind them to a
research memo. Missing support yields
`依据不足`; unverified case citations and out-of-date authority fail the
deterministic gate; source byte changes mark pending memos stale and block final
research approval. Focused builds and audits pass.

The local provider wire is `vera-legal-research-provider-v2`; the status wire is
`vera-legal-source-provider-status-v2`, using `authorized_provider_adapter`.
Clients reject older or unknown shapes fail-closed.

The Matter `法律研究` workbench and backend now support a strictly local lawyer
manual-source import at
`POST /aletheia/matters/:matterId/research/requests/:requestId/manual-sources`.
It accepts only bounded legal-material fields, derives source identity, URL,
retrieval time, and content hash server-side, and never dispatches Hermes or an
external-source adapter. Imported statutes and judicial
interpretations require valid effective dates; every import remains marked
`captured_unverified`. The snapshot is bound to the current Matter request,
case-context triple, and issue-tree hash, then must pass the existing exact
excerpt, immutable input-manifest, memo Gate, and human-review workflow. The
workbench explicitly labels this path as local-only and not automatically
verified, then moves the lawyer to exact-excerpt confirmation after a successful
snapshot. A later import for the same local source identity invalidates the
former excerpt, manifest, and memo approval path. The targeted broker audit,
frontend lint/typecheck/build, and Sol-reviewed desktop and narrow-window
workflow pass for this path.

New research requests now begin with a server-derived local case context rather
than a free-text fact field: the lawyer selects only confirmed facts with
current evidence excerpts, and may also select confirmed source-bound
procedural events. Vera persists that selection as a separate accepted local
work product, stores only IDs/counts/hashes in the binding audit, and carries
its ID/content hash/item hash through the query plan, source work, input
manifest, and memo. A selected fact, event, evidence quote, source hash, or
verification change blocks later work and marks a pending memo stale before
approval. The Matter research form exposes only eligible local inputs and labels
a v2 request as `案卷输入已绑定`; it never shows the case-context ID or hash.
Sol reviewed its 1200px and 393px states in
`docs/legal_research_case_context_sol_review.md`.

The research request can now carry a lawyer-authored local legal issue tree.
The API permits exactly one bounded acyclic root tree per immutable version,
with editable `open`, `resolved`, and `needs_material` nodes. It is isolated by
matter and request, and its audit event stores only node counts, status counts,
depth, and tree hash rather than research text or facts.

The primary Matter workspace now has a first-level `法律研究` workbench. It
persists the issue tree, shows the internal question next to the exact outbound
redacted text, separates approval from execution, and handles source snapshots,
reviewed excerpts, input manifests, lawyer-authored conclusions, review, and
`依据不足`. Sol reviewed the desktop and 393px states in
`docs/product_convergence_research_sol_review.md`; its screenshots are under
`docs/screenshots/product-convergence-research-*.png`.

**Available with limitations:** API adapters are contracts tested with injected
provider responses; no vendor endpoint, license, local credential, or official
China-law API has been configured on this machine. There is no trusted registered
local model yet, so fact/issue/query/finding generation remains unavailable
rather than using synthetic output. No anonymized real Matter or lawyer study
is present. The current documentation and automated tests are evidence of
failure handling, not proof of legal-source coverage or legal correctness.

The desktop launcher and Docker Compose now forward only the eleven non-secret
legal-source configuration fields (endpoint, allowlisted hosts, and a local
credential reference) through explicit allowlists. They do not forward vendor
API/MCP secrets; Pkulaw, YuanDian, and Wolters credentials remain encrypted in
local storage.
This makes an authorized deployment configuration reachable by the backend, but
does not turn the generic adapter contract into a verified vendor integration.
The required gateway contract and production acceptance steps are documented in
`docs/authorized_legal_source_gateway.md`.

The existing `Tools & Keys` settings group now includes a minimal `法律数据源`
section for Pkulaw, YuanDian, and Wolters. It receives only four fail-closed readiness
booleans from the local backend: encrypted-secret storage, endpoint, host
allowlist, and credential reference. It does not receive or show deployment
values, endpoint URLs, hostnames, credential references, or saved secrets. A
source key can be saved only when all four prerequisites are true, is cleared
from the form immediately after the request, and is stored through the encrypted
local secret API. The server repeats this prerequisite check and returns
`PRECONDITION_REQUIRED` before writing if a caller bypasses the disabled UI. The
settings view never calls the disabled provider-test route.
Sol reviewed both 1200px and 393px states in
`docs/legal_source_settings_sol_review.md`; focused GET/PUT/DELETE/error-state
coverage and backend configuration-projection audit pass.

The backend now has a narrow legal-opinion path: an opinion can only be created
from a current, accepted, hash-verified research memo whose reviews and approval
audit remain valid. The output is a deterministic assembly of accepted findings,
quotes and limitations, followed by a separate opinion review, approval, and
hash-bound protected local DOCX export/download. The repository and HTTP audit
cover stale sources and issue trees, rejected/open reviews, direct-status
bypasses, content-hash tampering, restart persistence, and matter/user
isolation. The Matter `法律研究` workbench now exposes the same persisted flow:
choose an accepted non-stale memo, enter limited cover fields, create, resolve
the independent review, approve, and export/download DOCX. Sol passed desktop
and 393px review for this fifth stage; see
`docs/product_convergence_research_sol_review.md` and
`docs/screenshots/product-convergence-legal-opinion-*.png`.

The legal-opinion export now uses a dedicated Chinese DOCX renderer rather than
the generic litigation-workpaper renderer. It deterministically lays out the
lawyer-provided cover fields, scope, each accepted conclusion, position,
confidence, uncertainty, exact quotation and local snapshot identifier, then
the applicable limitations and compact verification identifier. It contains no
model-composed prose. The DOCX audit asserts the dedicated title, Vera header,
accepted conclusion and exact quote, and rejects the former generic-workspace
header. A representative two-conclusion opinion was rendered page by page with
LibreOffice during QA; its source, limiting conditions and footer remained
legible with no clipping or overlap.

An accepted, current research memo now also has its own protected local DOCX
export/download path. It is intentionally separate from the legal-opinion
builder: no second review is created, but the memo export fails closed unless
the input manifest, source snapshots, issue tree, case context, Gate, review
decision, and approval audit are still current. Each export is stored as a
hash-bound `legal_research_memo_docx` export record and is rechecked on download.
The Matter workbench shows this action only for an accepted non-stale research
memo. Sol passed the desktop and 393px states; see
docs/legal_research_memo_docx_sol_review.md and
docs/screenshots/ui-audit-2026-07-13-research-memo-docx/.

**Next:** configure one authorized legal-source API/MCP and prove live controlled
retrieval against its license; add an offline anonymized demo Matter; then run
a measured evaluation set. The dedicated legal-opinion DOCX has already had
page-by-page render QA, but neither live legal-source coverage nor legal
correctness has been validated on this machine.

The user-facing product name is now **Vera**. The macOS bundle, window titles,
notifications, backup labels, calendar exports, web metadata and shell branding
use Vera and the supplied black/white mark. Internal `/aletheia` routes,
`ALETHEIA_*` environment variables, database/schema identifiers, Keychain
services and the `ai.aletheia.local` application identity remain unchanged for
compatibility. `Vera.app` explicitly reuses the existing
`Application Support/aletheia-desktop` data directory so an upgrade does not
create an empty workspace or orphan encrypted matters. The compatibility
contract is covered by `desktop/scripts/productRenameAudit.js`.

UI acceptance is no longer based on functional availability alone. Visual
audit, design decisions, and frontend visual refactors must be led by
`gpt-5.6-sol` against current running-state screenshots. A UI milestone remains
open until Sol has reviewed desktop and narrow-window captures, overflow and
occlusion checks, core interaction states, and the corresponding lint/build
results. Other models may integrate and regression-test the work, but may not
substitute their own visual approval.

## Product Convergence

Vera entered product convergence on 2026-07-12. Horizontal feature expansion
is frozen unless a gap directly blocks the daily Chinese civil-litigation
workflow, data safety, failure recovery, or release. The baseline audit and
code inventory are recorded in `docs/product_convergence_audit.md` and
`docs/product_convergence_code_inventory.md`.

**Available now:** `/aletheia` and every matter row enter one canonical civil
litigation workflow: Overview, Facts & Evidence, Claims & Defenses, Procedural
Clock, and Documents & Hearing. The main shell exposes only Matters, Work Queue,
and Settings. New Matter creates only `civil_litigation` matters. Matter,
Evidence, Review, and Audit API failures clear prior records, expose Retry, and
do not substitute demo data or permit export/snapshot actions. A legacy
non-litigation matter fails closed instead of reopening the generic workspace.
The case-intake dialog now records the case name, lawyer objective, client,
represented role, opposing party, court, case number, procedure stage, intake
date, and risk level in the real local matter record. The case Overview exposes
those persisted fields and one deterministic next action derived from current
documents, parsing state, fact/position review, and deadline state; it does not
call a model or invent case data.
Global search, the matter dashboard, and Work Queue now preserve object identity
for matters, imported documents, facts, claims/defenses, deadline records,
deadline-backed tasks, and litigation work products. Canonical links open the
correct litigation view, scroll and focus a stable matter-owned container, and
survive browser history. Historical work product hits identify the matched
version while focusing the current version; they are not presented as current
state. Missing, wrong-view, deleted, or foreign IDs produce one non-disclosing
recovery state and never trigger a cross-matter lookup. The command palette now
uses Chinese litigation terminology and exposes only New Matter, Matters, Work
Queue, and Settings as commands; legacy Evidence and AgentOps commands are no
longer on this primary surface.

**Available with limitations:** Agent Run and Eval Lab remain addressable by
their existing deep links for compatibility but are not first-level matter
navigation. Evidence, Review, Audit, Templates, and AgentOps routes still exist
for compatibility and targeted regression; they are no longer primary product
destinations. Existing server-side litigation export approvals continue to be
covered by the dedicated litigation test suite, while the retired generic
contract-review workspace is no longer an accepted route. Object-level search
currently covers matters, documents, facts, claims/defenses, deadline records,
deadline-backed tasks, and persisted work products. Search is owner-scoped and
does not yet include authorized shared matters. Legal authorities, review
records, and document drafts are not yet independently indexed and
deep-linkable.

**Not complete:** the product is not yet converged for daily use. The next
milestones are completing object-level indexing for authorities, reviews, and
drafts; replacement or removal of the remaining global
compatibility registries; complete Chinese shell and module terminology; a real
anonymized Chinese civil case run from bulk PDF/OCR import through approved
export; and decomposition of the oversized litigation workspace. Current
screenshot fixtures still contain English and `Demo` labels and are test
evidence, not approved product copy. Developer ID signing and notarization
remain unavailable without real Apple credentials.

P5 private-pilot inputs are not present on this machine: no Ollama/LM Studio
runtime or registered model was found, and no real anonymized PDF/DOCX/XLSX
case pack is available in the workspace or supplied attachments. Vera therefore
continues to mark trusted-model functions unavailable and does not treat the P4
synthetic fixture as a real-case validation. The privacy-preserving intake gate
is available through `npm run check:vera:pilot-case-pack`; its contract and
required material categories are documented in `docs/private_pilot_case_pack.md`.

The Sol-led P0 evidence is under
`docs/screenshots/product-convergence-p0-2026-07-12/`. Sol passed the desktop
and 393px states for canonical routing, reduced navigation, controlled service
failure, and the five-stage litigation workbench with no observed overflow or
occlusion. Main-thread verification passes lint, standalone TypeScript,
production build, five focused convergence flows, and the updated canonical
desktop smoke flow. The rebuilt local-only `Vera.app` passed packaged runtime
hygiene, isolated startup with demo seeding disabled, frontend/backend health,
clean shutdown and port release, and the original-document save audit. The
normal app was reopened with frontend and backend responses both returning 200;
it remains unsigned and unnotarized.

The Sol-led P1 intake and Overview evidence is under
`docs/screenshots/product-convergence-p1-2026-07-12/`, with the review recorded
in `docs/product_convergence_p1_sol_review.md`. Sol passed the 1440px and 393px
case Overview and New Matter dialog after verifying the unique next action,
responsive five-view navigation, form retention after failed creation, and no
horizontal overflow or control occlusion. The backend matter-intake audit
independently verifies metadata reload, `matter_created` audit persistence, and
cross-user fail-closed access. Main-thread regression passes lint, TypeScript,
production build, the 9-flow convergence suite, canonical smoke, and the
desktop litigation suite: 21 passed with only the real-local-model opt-in flow
skipped because no trusted runtime is configured. The rebuilt local-only
`Vera.app` again passed SQLCipher/package hygiene, isolated packaged smoke with
demo seeding disabled, original-document save checks, and normal frontend and
backend health after reopening; it remains unsigned and unnotarized.

The Sol-led P2 object-focus evidence is under
`docs/screenshots/product-convergence-p2-2026-07-12/`, with the review in
`docs/product_convergence_p2_sol_review.md`. Sol passed the 1440px and 393px
historical-work-product states after verifying restrained focus styling,
keyboard focus, hash truncation, responsive actions, and explicit historical
versus current version language. The frontend strictly accepts only bounded
`document`, `task`, and `artifact` focus keys and never inserts raw query text
into a selector. The backend global-search audit passes authenticated entity
coverage, Chinese names, user isolation, deduplication, path hygiene, and exact
canonical hrefs. Main-thread lint, TypeScript, production build, command-palette,
convergence, task-queue, and litigation regression pass; the real-local-model
opt-in flow remains skipped without a trusted runtime. The rebuilt local-only
`Vera.app` passed the SQLCipher runtime check, package-hygiene audit, isolated
packaged smoke with demo seeding disabled, clean shutdown and port release,
and the original-document save audit. After reopening, its frontend and
backend health endpoints both return 200. This build remains unsigned and
unnotarized and is not a distribution artifact.

The Sol-led P3 search and core-object focus evidence is under
`docs/screenshots/product-convergence-p3-2026-07-12/`, with the review in
`docs/product_convergence_p3_sol_review.md`. Sol passed the 1440px and 393px
command palette and focused-position states after verifying Chinese
civil-litigation grouping, removal of legacy commands, bounded focus parsing,
strict matter ownership, and no observed horizontal overflow or control
occlusion. The backend audit independently covers all seven supported result
kinds, Chinese fact/position/deadline fields, legal-basis and deadline-rule
matching, exact canonical hrefs, user isolation, deduplication, safe FTS, and
path hygiene. Main-thread lint, TypeScript, unit tests, production builds, and
the combined command-palette, convergence, task-queue, and litigation desktop
suite pass: 26 passed and the real-local-model opt-in flow remains skipped
without a trusted runtime. Shared-matter search, authorities, heterogeneous
review records, and document drafts remain outside P3. The rebuilt local-only
`Vera.app` passed SQLCipher and package-hygiene checks, isolated packaged smoke
with demo seeding disabled, clean shutdown and port release, and the
original-document save audit. Its normal frontend and backend health endpoints
both return 200 after reopening. The build remains unsigned and unnotarized.

The P4 same-matter workflow baseline is recorded in
`docs/product_convergence_p4_workflow_baseline.md` and runs through
`npm run test:vera:civil-case-workflow`. One file-backed synthetic anonymized
Chinese civil case now traverses intake, mixed TXT/XLSX/image-only-PDF batch
import, fail-closed OCR and real Apple Vision retry, page-bounded multi-page and
table-layout PDF OCR, two-page reviewed-excerpt binding/withdrawal/recovery,
source-bound fact and position review, verified authority, procedural
correction with deadline/task invalidation, document v1/v2 diff and approval,
hearing-bundle indexing, approval-gated DOCX export/download with stale
approval recovery, and repository restart recovery. Repeated nine-stage runs
complete in about 2-6 seconds, mainly varying with Swift/Apple Vision startup.
Related batch cleanup, parse retry,
reviewed retrieval, event correction, document draft, export approval/download,
backend build, and native OCR audits pass. P4 also fixed an unhandled OCR stdin
`EPIPE` and cross-page chunk merging. All 9 planned core backend stages now
pass, but this remains an integration baseline: it uses synthetic structure
rather than real client material and does not cover a trusted local model or
SQLCipher restart in the backend Node runtime. The rebuilt local-only
`Vera.app` passes SQLCipher runtime and package-hygiene checks, isolated smoke,
original-document save, and packaged native OCR ingestion/search/provenance.
After reopening, frontend and backend health both return 200. It remains
unsigned and unnotarized.

P6 closes the highest-risk restore interruption gap. Before the backup utility
moves the active data directory it now commits an owner-only, fsynced pending
restore record outside the replaceable workspace. Vera validates that record
and its bounded same-parent paths before starting any local service. If a prior
workspace is still present, startup discards the unconfirmed restored directory
and atomically reinstates the prior workspace; unsafe, ambiguous, missing, or
symlinked state blocks startup. The record is cleared only after restored
services are healthy and the authenticated restore journal has been appended,
or after a verified rollback. The packaged audit now exits Vera immediately
after the directory swap, relaunches the same SQLCipher workspace, proves that
the post-backup matter and marker were recovered before service startup, then
performs a normal point-in-time restore and verifies the backed-up matter,
encrypted document, and search chunks. Direct backup and packaged interruption
audits pass. This is recovery hardening only; it does not change the UI and
therefore creates no new visual milestone. The direct transaction audit is now
part of macOS CI, and the packaging script requires legacy migration, isolated
packaged startup, and the post-swap interruption audit to pass before it writes
artifact checksums or performs release verification. Packaged bad cases also
prove that an out-of-bound rollback path, permissive record mode, or a missing
target and rollback keeps both services offline and retains the transaction
record for operator recovery. GitHub Actions now runs the complete unsigned
macOS package and recovery gate in a separate parallel job; it does not publish
that local-only artifact. Packaging removes and rejects stale
`Aletheia-*`-branded files before reporting Vera checksums.

The first Sol-led pass on 2026-07-11 covered the application shell, settings,
and litigation workspace. Before/after evidence is retained under
`docs/screenshots/ui-audit-2026-07-11/`. A second Sol-led pass completed the
high-density Facts & Evidence and Claims & Defenses workspaces; its desktop and
900px evidence is retained under
`docs/screenshots/ui-audit-2026-07-11-facts-claims/`. That pass keeps OCR
confidence, original-scan verification, evidence state, legal uncertainty, and
review actions in the visible workflow while removing nested card layouts. The
integration gate now passes lint, standalone TypeScript checking, production
build, AgentOps work-product contract tests, and desktop/mobile litigation
Playwright coverage.

The Vera brand pass is recorded under
`docs/screenshots/ui-audit-2026-07-11-vera-brand/`. Sol verified standard and
narrow desktop shells plus 393px light/dark settings states. The follow-up
removed a dark-theme settings contrast break and fixed the mobile brand header;
measured primary/secondary content contrast is at least 16.35:1/7.01:1, the
mobile header is about 17:1, body overflow is zero, and the navigation remains
independently scrollable.

The counsel-reviewed retrieval and Agent-input passes are recorded under
`docs/screenshots/ui-audit-2026-07-11-reviewed-excerpts/` and
`docs/screenshots/ui-audit-2026-07-11-agent-input-binding/`. Sol approved the
desktop and 393px states after real manifest/excerpt writes, refresh recovery,
explicit per-session binding, stale-selection clearing, header geometry and
document-overflow checks. The interface does not infer binding from candidate
counts or local storage; eligibility is returned by the server.

The legal-authority version pass is recorded under
`docs/screenshots/ui-audit-2026-07-11-legal-authorities/`. Sol approved the
1440px, 900px and 393px Claims & Defenses workflow after real create, detail
reload, verification, exact-quote rejection, position link, withdrawal and
retirement writes. The interface explicitly distinguishes a source-text hash
from proof of authenticity and records counsel's named-source check.

The verified deadline-rule pass is recorded under
`docs/screenshots/ui-audit-2026-07-11-deadline-rules/`. Sol approved the
1440px, 900px and 393px Procedural Clock states after real authority, event,
rule, verification, calculation, refresh and retirement writes. The interface
shows retired-rule deadlines as stale with actions blocked.

The verified court-calendar pass is recorded under
`docs/screenshots/ui-audit-2026-07-12-court-calendars/`. Sol approved the
1440px source/version workspace, 900px business-day trace and 393px trace state
against the real local backend. The workflow records weekly closures plus
date-specific closed and open make-up exceptions, binds each business-day rule
and deadline to an immutable calendar version/hash, and exposes every counted or
skipped local date. Automated overflow, header-overlap and control-collision
checks passed at all three widths.

The litigation document-version pass is recorded under
`docs/screenshots/ui-audit-2026-07-11-document-drafts/`. Sol approved the
1440px, 900px and 393px Documents & Hearing states after real artifact, draft,
version, diff, review, source-staleness and withdrawal writes. Initial sections
are rendered deterministically by the server from the latest bound artifact;
the source section and provenance remain read-only. Counsel edits append an
immutable hash-linked version with optimistic concurrency. Source changes lock
editing and approval while preserving historical diff access and a reasoned
withdrawal remedy.

The real local-model benchmark pass is recorded under
`docs/screenshots/ui-audit-2026-07-11-model-benchmark/`. Sol approved the
1200px, 900px and 393px Settings states after real loopback model generation,
calibration, four-case benchmark persistence, refresh, failed-case and stale
configuration checks. The result is explicitly diagnostic: it does not replace
counsel review and is not a production execution gate.

The per-finding local semantic-advisory pass is recorded under
`docs/screenshots/ui-audit-2026-07-11-finding-entailment/`. Sol approved the
1440px succeeded, 900px failed-history and 393px stale-history states after
real loopback generation, calibration, benchmark, refresh and fail-closed
review changes. The interface labels the result as model advice rather than
independent verification; it does not select, prefill or satisfy counsel's
separate finding review.

The litigation DOCX round-trip pass is recorded under
`docs/screenshots/ui-audit-2026-07-12-document-roundtrip/`. Sol approved the
1440px accepted-import, 900px rejected-history and 393px stale-lock states
against the real local backend. A bound DOCX can be downloaded, externally
edited and re-imported as a new immutable, unreviewed version; import never
changes counsel's separate approval. The tested workflow has no page overflow
or header occlusion.

The procedural-event correction pass is recorded under
`docs/screenshots/ui-audit-2026-07-12-event-corrections/`. Sol approved the
1440px correction result, 900px lineage/stale-deadline state and 393px immutable
lock state against the real local backend. The workflow exposes both event and
correction hashes, preserves the superseded version and reason, invalidates the
old deadline/task, excludes the old event from calculation, and requires the
replacement event to produce a separately confirmed deadline. Automated width
and mobile-header checks report no overflow or occlusion.

The legal-position authority-readiness pass is recorded under
`docs/screenshots/ui-audit-2026-07-12-position-authority-readiness/`. Sol
approved the 1440px missing-authority state, 900px satisfied state and 393px
withdrawal-recovery state against the real local backend. The UI consumes the
server-derived readiness projection instead of inferring it from client-side
link counts. Automated checks cover page overflow, shell-header overlap,
clipped controls and painted-control intersections at all three widths.

The litigation matter-audit-package pass is recorded under
`docs/screenshots/ui-audit-2026-07-12-litigation-audit-package/`. Sol approved
the 1440px action-required checklist, 900px approved/exported state and 393px
signed and stale-receipt states after real server writes. The package contains
only a white-listed litigation snapshot, per-section hashes, the exact matter
state and checklist hashes, and an approved checkpoint bound to those values.
It is stored as a protected local JSON file and reverified on read. Counsel or
admin can append an immutable application sign-off receipt; changing the matter
preserves the historical receipt but marks it stale and blocks another sign-off
until a current package is approved. This receipt is not a qualified electronic
signature, digital certificate, or proof of independent review.

The external sign-off-anchor pass is recorded under
`docs/screenshots/ui-audit-2026-07-12-signoff-anchor/`. Sol approved the final
900px current receipt and 393px stale historical receipt against a real
temporary Ed25519 operator key. Every new sign-off stores its exact HMAC audit
event ID, sequence and hash. A global administrator can append an external
anchor only while that event is still the exact matter audit head; counsel and
auditors can read the server-verified proof but cannot infer or create it in the
browser. The proof preserves anchor index/hash, key fingerprint and time after
the package later becomes stale. It proves local inclusion in an operator-key
signed audit head, not signer identity, a qualified electronic signature,
trusted timestamp, independent notarization, WORM storage, or independently
retained journal-tail evidence.

The packaged audit-anchor settings pass is recorded under
`docs/screenshots/ui-audit-2026-07-12-anchor-settings/`. Sol approved the final
1200px enabled state and complete 393px environment-managed state after an
initial copy/evidence rejection and remediation. Safety settings now use the
trusted desktop bridge to select an external journal location, provision or
reuse an owner-only Ed25519 key pair, atomically persist configuration, restart
local services and roll back the prior configuration after restart failure.
Desktop-managed anchoring always starts in high-assurance mode, so journal
verification or append failure blocks startup or subsequent state changes
rather than silently degrading. Launch-environment configuration remains
read-only. Canceled and failed operations preserve the prior state, renderer
errors are redacted, disabling preserves existing keys and journal entries, and
the renderer never receives private-key paths or material. The UI states the
operator-key/local assurance boundary and does not claim signer identity,
qualified electronic signature, trusted timestamp, notarization or WORM
storage. Focused and full settings Playwright, lint, typecheck, production
build, desktop configuration audit and the related backend anchor/package/
governance/integrity suites pass. The rebuilt local-only `Vera.app` contains
the configuration module and trusted preload/main bridge; packaged smoke
verified an isolated user-data launch, disabled demo seed, frontend/backend 200
responses, clean exit and released ports. The normal app was then reopened and
its Settings and health endpoints both returned 200. It remains unsigned and
unnotarized.

The original-evidence access pass is recorded under
`docs/screenshots/ui-audit-2026-07-12-original-evidence/`. Sol approved the
1440px and complete 393px Facts & Evidence states. Imported-file rows and exact
source citations now provide a restrained **Save & open original** command;
OCR-derived citations keep their recorded page context visible, while opening
the file remains separate from the lawyer's append-only comparison decision.
The authenticated backend requires `matter.read`, selects only the owner's
document row, derives and confines the authoritative flat storage path, rejects
links and metadata/path disagreement, decrypts through the protected reader,
and rechecks the stored original SHA-256 before bytes are returned. Successful
access must append a path-free HMAC-chained audit event before delivery; audit
failure returns no document. Public document and source-index projections no
longer expose original or CDR-derived storage paths. The desktop bridge then
rechecks MIME, container signature, size and SHA-256 before an atomic `0600`
save and native open warning. Browser fallback requires CORS-exposed length and
SHA-256 headers, recomputes both, and fails closed before creating a short-lived
object URL. Owner, ACL reader, cross-user, cross-matter, plaintext/ciphertext
tamper, hash/MIME/path/symlink and audit-failure bad cases pass. This proves
stored-import byte integrity, not authenticity, admissibility or file safety;
external viewers control page navigation and browser downloads cannot confirm
that the user opened the file.

The inline PDF evidence-viewer pass is recorded under
`docs/screenshots/ui-audit-2026-07-12-pdf-evidence-viewer/`. Sol approved a
real nonblank PDF.js canvas at 1440px and 393px after page navigation, bounded
zoom, keyboard close, focus containment, malformed-PDF rejection and recorded
page-bound checks. PDF file rows can start at page 1; an exact citation can
start at its recorded page only when that page exists in the protected original.
The viewer consumes the already authenticated, exact-size and SHA-256-verified
blob, uses the bundled PDF.js worker with evaluation disabled, loads no remote
fonts or resources, and destroys render tasks, document state, canvas and byte
references on close. An invalid recorded page or render/load failure clears the
canvas and displays no document. Viewing, navigating and saving remain separate
from the append-only lawyer comparison action and cannot satisfy it. Full
frontend lint, typecheck and production build pass; focused desktop/mobile
viewer regression passes 7 flows with one intentional project skip. The rebuilt
local-only `Vera.app` passed SQLCipher/runtime package hygiene and isolated
packaged smoke, then reopened with frontend and backend health both returning 200. It remains unsigned and unnotarized.

The in-viewer counsel-comparison pass is recorded under
`docs/screenshots/ui-audit-2026-07-12-in-viewer-verification/`. Sol approved the
final 1440px retry state and complete 393px comparison work surface after an
initial screenshot exposed that a lawyer could navigate away from the recorded
page and still submit. Submission is now enabled only while the currently
rendered page exactly equals the immutable recorded OCR/citation page; leaving
that page preserves the reason, disables submission and offers an explicit
return action. The viewer keeps the exact quote, recorded/current page and OCR
confidence beside the protected original. A lawyer must enter a 10-2000
character reason and issue **Record text comparison**; viewing, navigation,
zoom and Save & open never invoke verification. Failed writes retain the reason
without exposing backend details; a successful refresh shows the persisted
verification. In multi-principal mode, `matter.write` is required, the row and
HMAC audit event remain owner-scoped, and `verified_by`/audit actor provenance
come only from the authenticated counsel principal. Reviewer/auditor-only,
unshared, revoked-ACL, cross-matter, stale-source, short-reason and audit-write
failure cases leave no verification. The final 393x852 operability check proves
independent panel scrolling and submit hit-testing; the 393x1200 evidence shows
the complete unclipped composition. Backend ACL/domain/shared-document audits,
frontend lint/typecheck/build and the focused persistence/retry UI flow pass.
The rebuilt local-only `Vera.app` then passed packaged startup/port-release and
original-save bridge audits and reopened with frontend/backend health at 200;
it remains unsigned and unnotarized.

The source-comparison withdrawal and correction pass is recorded under
`docs/screenshots/ui-audit-2026-07-12-source-verification-withdrawal/`. A
verification and its later withdrawal are separate append-only records; SQLite
triggers reject direct update or deletion of either history. Withdrawal binds
the original verification ID, source-span ID, source-chunk hash and quote hash,
and remains available when the source later becomes stale so counsel is not
locked out of correcting the record. It removes only the current-verification
projection, reopening the low-confidence OCR comparison gate without erasing
history. `matter.write` is required, owner/counsel actor provenance is retained,
and reviewer, auditor, unshared, revoked, cross-matter, wrong-source, duplicate,
short-reason and missing-verification cases fail closed. The withdrawal and its
owner-scoped HMAC audit event commit atomically; a forced audit failure rolls
back the withdrawal. Sol approved the restrained confirmation/retry flow at
1440x1000 and 393x1200 with no overflow or occlusion. Passive viewing,
navigation and Save & open do not withdraw anything; a failed request preserves
the 10-2000 character reason, and a successful refresh restores the
comparison-required state. Backend ACL audits/build and frontend
lint/typecheck/build/focused Playwright pass. The rebuilt local-only `Vera.app`
also passes SQLCipher runtime and package-hygiene checks, isolated packaged
startup with frontend/backend 200, clean port release, and the protected
original-save bridge audit. It remains unsigned and unnotarized.

The source-comparison history pass is recorded under
`docs/screenshots/ui-audit-2026-07-12-source-verification-history/`. The
protected original viewer now retrieves the complete matter-scoped chain for
the cited source span, showing the authenticated actor, time, reason, bound
source/quote hashes, current state and any later withdrawal. A withdrawn entry
remains visible after the current-verification projection becomes null and the
comparison gate reopens. History loading, empty, unavailable and retry states
are distinct; a failed audited read is never presented as an empty history.
The endpoint requires `matter.read`, appends an owner-scoped HMAC audit event,
returns no history when that audit write fails, and rejects unshared, revoked
and cross-matter access. Owner, counsel, reviewer and auditor reads retain the
authenticated actor while rows remain owner-scoped. Direct child-record update
or deletion remains blocked, while the delete trigger permits the existing
approved whole-matter purge to cascade and preserve its deletion tombstone.
Sol approved the withdrawn-history state at 1440x1000 and 393x1200 with no
overflow or occlusion. Backend history/verification/withdrawal ACL audits and
build, plus frontend lint/typecheck/build and focused Playwright, pass.
The rebuilt local-only `Vera.app` passes package hygiene, SQLCipher runtime,
isolated startup, frontend/backend health, clean port release and the protected
original-save bridge audit; it remains unsigned and unnotarized.

Vera is ready for bounded local reviewer evaluation. It is not presented as
production SaaS, legal advice software, or a replacement for qualified
professionals.

Reviewer-facing orientation starts in `README.md`, then continues through
`docs/v1_private_pilot_status.md`, `docs/v1_acceptance_matrix.md`,
`docs/reviewer_walkthrough.md`, `docs/demo_script.md`,
`docs/deepseek_pitch.md`, and `docs/feature_map.md`.

## Validation Entry Points

The fast operator health entrypoint is:

```bash
cd backend && npm run check:aletheia:operator
```

The private deployment preflight entrypoint is:

```bash
cd backend && npm run check:aletheia:preflight
```

The local deployment doctor entrypoint is:

```bash
cd backend && npm run check:aletheia:doctor
```

The local backup manifest entrypoint is:

```bash
cd backend && npm run check:aletheia:backup
```

The restore preflight entrypoint is:

```bash
cd backend && npm run check:aletheia:restore
```

The tracked-file privacy preflight entrypoint is:

```bash
cd backend && npm run check:aletheia:privacy
```

The private deployment operational readiness audit entrypoint is:

```bash
cd backend && npm run check:aletheia:ops-readiness
```

The source provenance audit entrypoint is:

```bash
cd backend && npm run check:aletheia:source-provenance
```

The Matter Memory / Playbook knowledge governance audit entrypoint is:

```bash
cd backend && npm run check:aletheia:knowledge-governance
```

The Audit Workbench / registry snapshot audit entrypoint is:

```bash
cd backend && npm run check:aletheia:audit-workbench
```

The least-privilege Tool Adapter policy audit entrypoint is:

```bash
cd backend && npm run check:aletheia:tool-policy
```

The high-risk approval policy audit entrypoint is:

```bash
cd backend && npm run check:aletheia:approval-policy
cd backend && npm run check:aletheia:external-source-connector
cd backend && npm run check:aletheia:word-addin-manifest
```

The matter isolation audit entrypoint is:

```bash
cd backend && npm run check:aletheia:matter-isolation
```

The Run Trace runtime contract audit entrypoint is:

```bash
cd backend && npm run check:aletheia:run-trace
```

The per-finding local semantic-advisory audit entrypoint is:

```bash
cd backend && npm run test:aletheia:finding-entailment
```

The litigation DOCX round-trip audit entrypoint is:

```bash
cd backend && npm run test:aletheia:document-roundtrip
```

The litigation matter audit package and counsel sign-off audit entrypoint is:

```bash
cd backend && npm run test:aletheia:litigation-audit-package
```

The release evidence manifest entrypoint is:

```bash
cd backend && npm run check:aletheia:evidence
```

The local audit integrity entrypoint is:

```bash
cd backend && npm run check:aletheia:audit-integrity
```

The real-data restore drill entrypoint is:

```bash
cd backend && npm run test:aletheia:restore-drill
```

Main branch pushes and pull requests are also covered by
`.github/workflows/aletheia-local-ci.yml`, which runs the backend local-first
checks, package preflight, frontend lint/build, and Playwright UI smoke.

## Completed Capabilities

The product can demonstrate the first Private Contract / Due Diligence Review
pack in local mode:
matter creation, document upload and parsing, SQLite FTS5 search, evidence
mapping with deterministic claim/issue suggestions and audit-facing retrieval
rank diagnostics, issue map generation with a reviewable Issue Map UI and echoed
claim-level review tags, evidence matrix generation, deterministic draft memo
generation, approval-gated audit pack, feedback dataset, and final memo export.
The same local document/evidence pipeline now generates template-specific
Compliance Register and Red Flag Memo work products for compliance impact review
and deal due diligence matters. The workspace also includes Matter Memory,
Matter Playbooks, draft Playbook Improvement Proposals from reviewer feedback,
run traces with budgets and metrics, expanded human checkpoint decisions,
resumable edited/responded checkpoints, bounded specialist role labels with tool
allowlists, persisted Workflow Graph metadata, filterable/exportable live local
Evidence/Reviews registries, the filterable/exportable live local Audit
Workbench, matter-scoped registry snapshots saved as auditable local work
products, the narrow Aletheia Tool Adapter, and a private local packaging
manifest prototype with strict preflight checks. Aletheia routes also support a
private bearer-token auth mode for controlled single-tenant deployments.

The macOS package now starts the bundled Next.js and SQLCipher-backed local
backend from a real `.app`, resolves the backend URL and launch token through a
trusted runtime bridge, defaults to an empty non-demo workspace, survives
close/reopen without duplicate services, and has an automated packaged-app
smoke test. The civil-litigation pack also includes a persistent Work Queue:
lawyer-confirmed deadlines can become idempotent tasks, then be grouped by due
state, completed, reopened, and audited. Matter files can be selected in batches
or by folder, show per-file processing state, and retain failed parse records for
integrity-checked retry. `Cmd/Ctrl+K` searches matters, document names and indexed
text, tasks, and work products across the current user's local workspace.

The packaged macOS client includes an arm64 native OCR helper built on Apple
Vision and PDFKit. PDF.js retains existing text-layer pages; only pages without
text are rendered in memory and sent to the helper over stdin. Recognized text
is merged under its original page number, chunked into the matter-scoped FTS
index, and persisted with engine, OCR page count, text-layer page count and
average confidence. The same provenance is written to the upload or retry audit
event, and each OCR-derived search chunk carries its page-level engine and
confidence so a SourceSpan can be traced back to OCR provenance. The case-file
UI identifies OCR-derived text and warns below 70% average
confidence. Invalid helper output, helper symlinks, malformed PDFs and
unavailable runtimes fail closed without inventing searchable text. OCR is not
evidence authentication or semantic verification; counsel must compare
material quotations with the original scan.

SourceSpan creation now copies OCR provenance from the server-owned document
chunk and binds it to a provenance hash; the client cannot submit its own OCR
confidence. A fact or legal position citing a page below 70% confidence cannot
be confirmed until a lawyer records a meaningful comparison with the original
scan. That append-only verification binds the current chunk and quote hashes,
reviewer, reason and timestamp. Changed text or OCR provenance invalidates the
old verification and blocks confirmation and artifact generation. The UI shows
page-level confidence and the verification state beside the citation, while
stating that text comparison does not establish authenticity or admissibility.

Approval-bound litigation DOCX exports are revalidated, decrypted only at
download time, and handed to the macOS native Save/Save and Open flow without
exposing the encrypted store path to the renderer. The Work Queue exports
owner-scoped RFC 5545 calendars with stable task identifiers and 7-day, 1-day,
and 2-hour reminders. While the app is running, open tasks due within 24 hours
or already overdue enter a SQLCipher-backed notification delivery ledger. The
client claims at most three reminders with a 10-minute lease, acknowledges only
after macOS reports that the notification was shown, and retries failed display
up to five times per task/category/day. Delivered reminders are deduplicated by
task, due-soon/overdue category and local date. Completing a task or changing
its due-time snapshot withdraws the old delivery and asks the main process to
close the matching notification. Failed, delivered and withdrawn transitions
are written to the matter audit chain. This monitor runs while Aletheia is open;
it is not a system launch agent or a source of court deadline calculations.

The claim and defense matrix now treats a legal position as reviewable case
state rather than plain text. Positions can carry a qualitative confidence,
material uncertainty, and an exact hash-verified source span. A lawyer may
request an objection, reconsideration, or withdrawal; only one request may be
open for a position, and a reviewer can uphold, dismiss, or grant the requested
outcome. Open review excludes the affected confirmed position from newly
generated legal artifacts and marks prior artifacts stale. Final export of a
claim matrix, litigation brief, or hearing plan fails closed when a position
review is open, a confirmed legal position lacks an exact citation, or
structured validation errors remain. Approval cannot bypass these gates.

Each legal element now exposes a server-derived evidence state: supported,
contradicted, both sides, pending fact review, source missing, or evidence gap.
Only confirmed facts with an exact source span count as support or
contradiction. Proposed facts remain visible as pending; confirmed but uncited
facts remain visible as source-missing; rejected facts cannot receive new
links. The API no longer accepts `gap` as a fact relation because absence of
evidence is derived rather than stored as evidence. Element-fact links are
owner-scoped and commit atomically with their audit event. Polluted user rows,
failed audit callbacks, and uncited or pending links fail closed and cannot
satisfy artifact or Agent Eval coverage.

Every decided legal position now points to an immutable, sequential assessment
snapshot. The snapshot records the status, legal basis, confidence,
uncertainty, decision reason, exact evidence-source metadata, and any active
verified legal-authority links and hashes as they stood at that decision. New
snapshots use separate `evidenceSources` and `legalAuthorities` collections;
legacy array snapshots remain readable without being silently rewritten. A
granted internal review appends a new version linked to both the prior version
and the review; it does not erase the challenged assessment. Reviews bind to
the current version at submission and fail closed if that target becomes stale.
Artifact generation verifies the version chain, current pointer and payload
SHA-256 before using a decided position. Existing decided positions receive an
explicit migration snapshot on first schema initialization.

A resolved first-level review may now be escalated once as a level-2 internal
appeal. The server derives the level and target version, permits only one child
appeal, rejects branching and third-level requests, and keeps the claim under
the same open-review export gate. In the current single-user desktop mode this
is explicitly recorded and displayed as non-independent review; it does not
claim reviewer separation.

When private-token multi-principal mode is enabled, litigation review now
separates the matter owner from the authenticated actor. ACL-scoped principals
see only matters for which they have `matter.read`; counsel needs
`matter.write` to submit or withdraw a request, and a reviewer needs
`matter.review` to resolve it. A requester cannot resolve their own request,
and a level-2 resolver must differ from the level-1 resolver. Review and legal
assessment rows remain owner-scoped while `created_by`, `resolved_by`, decision
provenance and audit details record the authenticated principal. Successful
cross-principal resolution is marked independent; single-user resolution is
not.

The matter document lifecycle now applies the same owner/actor separation to
uploads, batch imports, and parse retries. An ACL-scoped counsel principal with
`matter.write` can add or retry documents in a shared matter, while document,
chunk, FTS, matter-update, and audit-chain ownership remains bound to the matter
owner. Upload and retry audit details record the authenticated actor and whether
the action was cross-principal. Batch authorization runs before malware scan,
materialization, validation, or CDR processing, so denied access returns a
single `403` rather than a per-file `207`. Reviewer-only, revoked ACL, and
evidence-lock cases fail closed; cross-matter document IDs remain unavailable.
Multi-principal artifact export approval is now closed for litigation
artifacts. In multi-principal mode, an export request
binds an owner-scoped human checkpoint to a governance request carrying the
matter, work-product ID, version, and content hash. The configured policy
controls eligible roles, distinct-role requirements, and approval count; the
requester cannot vote. The first vote can leave the checkpoint open, and export
becomes available only after the policy threshold is met. Export and download
revalidate the current ACL, checkpoint, governance request, artifact binding,
dependency hash, and the existing legal/source gates. Restricted-matter export
approval remains a separate overlay rather than being conflated with artifact
approval.

The Documents & Hearing UI consumes a server-computed approval projection for
every generated artifact. It displays requester, governance request, vote
progress, role-aware vote restrictions, independent-review status, and the
eventual exporter without inferring permissions in the browser. Single-user
mode retains its local checkpoint but labels it non-independent. Sol reviewed
the desktop and 900px states for both modes; evidence is retained under
`docs/screenshots/ui-audit-2026-07-11-export-approval/`.

The litigation workspace now generates a hearing bundle index as a separate
approval-bound work product. It assigns stable-in-version Exhibit numbers to
the source documents actually relied upon, records each original file SHA-256,
parse status, page/section location, exact quote and reference count, and states
that it is an index rather than a merged court bundle. Missing confirmed
hearing events, original hashes, completed parsing, or resolved evidence gaps
produce validation errors and block final export. Confirmed-state changes make
the index stale and require regeneration.

After approval, a ready hearing bundle index can now be delivered as a ZIP
package. The backend reopens every owner-scoped encrypted source through the
trusted document reader, confines each path to the flat local evidence store,
rejects symlinks and path escape, recomputes the plaintext original SHA-256,
and aborts the export on any mismatch. The ZIP contains the index DOCX,
original exhibits under their Exhibit numbers, and a path-free JSON manifest
with document IDs and hashes. Desktop and browser delivery preserve the ZIP
filename and MIME type; internal encrypted storage paths are not exposed.

Bundle pagination is evidence-based rather than synthetic. When every included
source has a trustworthy parsed page count, the index and manifest record a
continuous source-sequence page range for each Exhibit and the total mapped
pages. If any source lacks a stable page count, the package switches to
`source_native_only`, leaves bundle ranges null, and displays that limitation
in the workspace. Original files are never rewritten merely to invent page
numbers.

Litigation work products now bind an approved document-template registry entry
instead of exporting an unversioned generic layout. Each built-in template has
an immutable ID, version and SHA-256 definition hash. The selected template is
persisted in the matter profile, participates in every artifact dependency
hash, and is copied into generated content; changing it makes prior artifacts
stale. DOCX export resolves the binding again, rejects an unknown or changed
hash, and applies the approved Chinese section labels and font profile. The
workspace exposes the two approved local templates on desktop and mobile.
Matter-scoped firm DOCX templates can now be imported as encrypted drafts. The
importer rejects macros, ActiveX, embedded objects, custom XML, external OOXML
relationships, zip expansion over 40 MB, files over 10 MB and any field outside
the fixed allowlist; `{aletheia_body}` is mandatory. Drafts are not selectable.
Publishing requires a human checkpoint bound to template ID and plaintext file
SHA-256 plus a recorded reason. Export reopens the encrypted approved template,
revalidates its OOXML and hash, and renders the bounded fields through
Docxtemplater. An approved custom template can be retired only through a second
hash-bound human checkpoint. The active template cannot be retired; counsel
must first switch the matter to another approved version. Retirement preserves
the encrypted source and audit history but removes the version from future
selection, providing an explicit rollback path without deleting evidence.
Templates remain matter-scoped; firm-wide sharing, signature workflows and
arbitrary executable template logic are not claimed. The template registry
records whether publishing was independently reviewed; the packaged single-user
client labels its own approvals non-independent.

Each civil-litigation matter now persists a bundle profile with organization,
court, case number, Exhibit prefix, starting number and pagination policy.
Prefixes are restricted to a short path-safe ASCII token and start numbers to
1-9999. The profile participates in the artifact dependency hash, so any
change marks prior hearing bundle outputs stale. Profile state and its
hash-chained audit event commit atomically, and `matter.write` controls updates
in multi-principal mode. Desktop/mobile coverage verifies custom `DEF-012`
entries, forced source-native pagination, and staleness after a profile change.

Litigation Eval Lab v6 now grades 16 invariants against the persisted matter
rather than fixed synthetic rows. It covers exact fact and position citations,
claim-element-fact coverage, deadline provenance, source hash integrity,
approval binding, exclusion of unconfirmed elements and open reviews, stale
artifact export, immutable legal-assessment lineage, independent-review actor
separation, and hearing-bundle pagination. A malformed bundle or tampered
source records a failed case instead of aborting the run. The UI test
deliberately leaves one confirmed position uncited and verifies an honest
`15/16` result with that case marked `FAIL`. v6 also checks every persisted
succeeded litigation run for the grounded handler, exact-quote verification
and step/snapshot binding, and recomputes every Agent output review hash while
validating decision reasons and reviewer provenance. Every finding in an
adopted run must have a latest, hash-matching assessment marked supported;
missing, partial, unsupported or stale assessments fail the suite. It also requires
each succeeded litigation run to bind a persisted, passed calibration record
for the same user and model, with matching protocol and configuration
fingerprint valid at run creation time.

The server-owned litigation Agent now compiles a hash-bound input snapshot
before enqueueing either model step. Only confirmed facts and positions with
exact verified citations enter the snapshot; positions under open review and
uncited records are excluded and counted. The durable run records the snapshot
schema, SHA-256, byte size, artifact dependency hashes and exclusion counts,
and the workspace displays this provenance. Source or legal-assessment chain
tampering blocks snapshot creation. A snapshot over 750,000 UTF-8 bytes returns
422 before enqueueing, so the executor never silently truncates a legal record;
deterministic source partitioning handles larger matters without omission;
semantic relevance retrieval remains an optional future enhancement.

Litigation model steps now use the dedicated
`local_model.litigation_grounded` handler rather than accepting unconstrained
text as a successful analysis. The local model must return JSON whose summary
and every finding cite one or more source-span IDs from the bound snapshot,
copy the complete source quote, and carry confidence plus uncertainty. The
server hashes each returned quote and compares it with the snapshot's
`quoteSha256`. Missing, empty or unknown citations, modified or truncated
quotes, malformed output, and invalid snapshot hashes fail the attempt and
follow the existing bounded retry policy. A succeeded step persists the
structured output, exact quotes and verified citation set; the workspace shows
the finding and source counts next to the result. Legacy runs that validated
IDs only are labelled separately. Exact quote binding still does not establish
semantic entailment. Counsel can request a bounded local semantic-support
check for each finding, but the result remains model advice and may be produced
by the same model that wrote the finding. Counsel must independently inspect
whether each quote supports the finding and record the human assessment.

The litigation workspace now restores the latest durable run after refresh or
application restart. Lookup is constrained by authenticated user, matter ID,
the fixed litigation workflow and durable executor version; cross-user and
wrong-workflow queries return no result. After restoration the client reruns
the HMAC event-chain check before presenting integrity as verified. Desktop and
mobile tests start a run, reload the page and verify the same snapshot and
event-chain evidence remain visible.

A succeeded litigation Agent run is now explicitly an unadopted draft until a
persisted legal output review is decided. Review creation rechecks the HMAC
event chain and binds the run ID, snapshot SHA-256 and canonical hashes of both
grounded step outputs. Adoption or return requires a 10-2000 character reason;
the server recomputes the binding at decision time and fails closed if any
step output, grounding field or snapshot link changed. The decision and audit
event commit together. Team mode requires `matter.review` and prevents the
requester from self-approving; single-user desktop review remains possible but
is permanently labelled non-independent. Desktop/mobile tests cover request,
reason, adoption, disclosure and reload persistence.

Adoption is now finding-granular rather than a single unchecked approval. An
open output review exposes each structured finding and its citation count;
counsel records supported, partially supported or unsupported with a mandatory
reason. Reassessment appends a version linked to the prior assessment. Each
assessment binds the run step, finding index and canonical finding SHA-256, so
changed model output invalidates it. Whole-run adoption fails closed unless the
latest assessment for every current finding is hash-matching and supported;
returning the run remains available without forcing false support findings.

Large verified snapshots now use deterministic source partitioning instead of
silent truncation or lossy compression. The server derives a conservative byte
budget from the active local model context window, groups source-bound facts,
positions, events and deadlines into at most 24 partitions, and includes only
the source spans each partition actually references. Every partition has its
own SHA-256 and exact-quote grounding step while retaining the parent snapshot
hash. A single oversized object, too many partitions or no source-bound item
returns 422 before enqueue. Unbound items are counted as excluded. Partitioned
results are not automatically presented as a whole-matter synthesis; the UI
states the partition count and limitation. Relevance-ranked retrieval remains
unfinished; cross-partition synthesis is available only through the separately
reviewed workflow described below.

Counsel can optionally provide a bounded analysis focus for large-matter
ordering. It is used only by a deterministic lexical scorer over every
source-bound unit; it is not inserted as a client-controlled system prompt and
never changes the inclusion set. The score, original index, tokenization
strategy, focus and `omissionPolicy: none` are persisted with the partitions
and run. Empty focus preserves source order. The UI states that all units are
retained and that the score is an ordering heuristic, not evidence weight or a
legal relevance finding.

Cross-partition synthesis is now available only after counsel adopts the entire
partition run. The server rechecks the parent HMAC event chain, approved review
binding and current output hash, then extracts structured findings and exact
quotes from all adopted steps. The synthesis input binds parent run, review,
output and snapshot hashes and rejects conflicting quotes, changed output,
duplicate active synthesis, or context overflow without truncation. The new
`reviewed_synthesis` run has one grounded step, may not introduce new evidence
or law, and remains an unreviewed draft until it receives its own legal output
review.

Litigation Agent execution now has a model-calibration gate in addition to
endpoint health. Settings run a real fixed probe through the selected loopback
model; the response must satisfy the production structured JSON schema and
reproduce a Chinese source quote byte-for-byte. Passed and failed attempts are
appended to the SQLCipher workspace with protocol, configuration fingerprint,
response hash, timestamps and bounded failure detail. The latest attempt is
authoritative. Missing, failed, expired or configuration-stale calibration
returns 412 before snapshot compilation or enqueue, and the worker checks it
again immediately before every litigation model step. Durable run metadata
binds the calibration ID, fingerprint and protocol. Model name, endpoint,
Reasoning or Fast mode changes invalidate the result, and it expires after 30
days. Ollama calibration fingerprints bind the exact digest returned by
`/api/tags`; OpenAI-compatible runtimes must supply an explicit immutable
revision before calibration can pass.

The local runtime now supports server-owned task routing across configured
loopback models. Settings persist separate `Litigation analysis` and `Routine
analysis` model roles, with the existing compression role kept separate. A
grounded litigation step always resolves to the litigation model and requires
its current exact-quote calibration; bounded non-final local analysis resolves
to the routine model. The renderer cannot choose a model for a step. Each
step records its resolved model and routing role, while litigation run metadata
records the selected legal model and the configured routine fallback. An
unregistered or unavailable routed model fails closed.

Workspace settings now create a real encrypted desktop backup through the
trusted preload bridge. The desktop app stops both local services before
snapshotting, rejects links and special files, records per-file SHA-256 hashes,
streams the workspace through an authenticated AES-256-GCM envelope, commits
the owner-only output atomically, and restarts the services on both success and
failure paths. Restore preflight authenticates the envelope and validates safe
archive paths, required workspace content, file sizes, and hashes without
overwriting current data. A backup that just passed preflight can now be
restored from Workspace settings after a native destructive-action
confirmation. The restore utility decrypts into an owner-only staging
directory on the same filesystem, repeats archive and manifest validation,
verifies every extracted file hash, and atomically exchanges the workspace
while services are stopped. The prior workspace remains available for rollback
until the restored frontend and backend start successfully; startup failure
reinstates and restarts it. The renderer never receives encryption keys,
rollback paths or plaintext staging paths. Successful restore appends an
owner-only HMAC-chained journal entry outside the replaceable workspace with
the backup SHA-256, backup timestamp and restored size; journal validation or
write failure triggers the same rollback path. A durable owner-only pending
transaction record is fsynced before the first directory move. On relaunch,
Vera reconciles that record before starting services, automatically reinstates
the prior workspace after an interrupted swap, and fails closed if the record
or filesystem state is unsafe or ambiguous.
Backups are tied to the application key on the originating Mac, while the
contained SQLCipher database still requires its independent database key;
cross-Mac recovery therefore requires separately escrowed application and
database keys.

## Current Boundaries

- Automated Playwright UI smoke covers desktop and mobile local workspace
  flows with screenshot baseline assertions for the initial workspace render.
- Full frontend lint exits cleanly with no warnings.
- Aletheia document upload and search use only the local SQLite/filesystem
  repository.
- Several inherited frontend/backend files are too large and should be split
  before major feature work continues.
- Semantic or hybrid retrieval remains disabled by default; the optional
  `local-json` adapter requires explicit feature flags and is intended as a
  local prototype before LanceDB/Qdrant.
- Position review supports a bounded two-level internal matter workflow. It is
  not a court appeal. ACL-backed independent multi-user resolution is available
  only when private-token multi-principal mode is explicitly configured; the
  packaged single-user desktop does not claim independent review. Review state,
  any granted claim-state change,
  and the authoritative hash-chained audit event now commit in one database
  transaction; derived artifact-staleness refresh and matter timestamps run
  after that commit.

## Verification Commands

Run before demos or packaging:

```bash
cd backend && npm run build
cd backend && npm run check:aletheia:preflight
cd backend && npm run check:aletheia:doctor
cd backend && npm run check:aletheia:backup
cd backend && npm run check:aletheia:restore
cd backend && npm run check:aletheia:privacy
cd backend && npm run check:aletheia:ops-readiness
cd backend && npm run check:aletheia:source-provenance
cd backend && npm run check:aletheia:knowledge-governance
cd backend && npm run check:aletheia:audit-workbench
cd backend && npm run check:aletheia:tool-policy
cd backend && npm run check:aletheia:approval-policy
cd backend && npm run check:aletheia:external-source-connector
cd backend && npm run check:aletheia:word-addin-manifest
cd backend && npm run check:aletheia:matter-isolation
cd backend && npm run check:aletheia:run-trace
cd backend && npm run check:aletheia:evidence
cd backend && npm run check:aletheia:audit-integrity
cd backend && npm run check:aletheia:operator
cd backend && npm run test:aletheia:local
cd backend && npm run test:aletheia:restore-drill
cd backend && npm run test:aletheia:retrieval-eval
cd backend && npm run test:aletheia:package
cd backend && npm run test:aletheia:completion
cd backend && npm run test:aletheia:litigation-tasks
cd backend && npm run test:aletheia:event-corrections
cd backend && npm run test:aletheia:court-calendar-calculation
cd backend && npm run test:aletheia:deadline-rules
cd backend && npm run test:aletheia:document-parse-retry
cd backend && npm run test:aletheia:litigation-artifact-download
cd backend && npm run test:aletheia:global-search
cd backend && npm run test:aletheia:task-calendar
cd backend && npm run test:aletheia:position-reviews
cd frontend && npm run lint
cd frontend && npm run test:aletheia:ui
cd frontend && npm run build
cd desktop && npm run test:sqlcipher-runtime
cd desktop && npm run test:legacy-migration
cd desktop && npm run test:packaged-app
cd desktop && npm run test:packaged-backup
cd desktop && npm run test:packaged-restore-fail-closed
cd desktop && npm run test:native-ocr
cd desktop && npm run test:packaged-ocr
cd desktop && npm run test:packaged-notifications
```

Current known result:

- backend TypeScript build passes.
- litigation deadline-task persistence, isolation, idempotency, audit, and
  completion/reopen checks pass.
- procedural-event correction passes immutable version supersession, exact
  source revalidation, lineage and correction hashes, atomic audit rollback,
  cross-user and no-op rejection, derived deadline/task invalidation,
  notification withdrawal, calendar exclusion, replacement recalculation and
  tampered-source fail-closed checks.
- verified court calendars pass stable Asia/Shanghai local-date calculation,
  weekend and dated closure skipping, open make-up days, cross-month/year and
  insufficient-range cases, immutable version/override hashes, verified-source
  dependency, rule/deadline binding, post-verification rule-tamper rejection,
  matter/user isolation and atomic create/audit rollback. Calendar or source
  authority retirement retires bound rules, marks deadlines stale, invalidates
  tasks, withdraws notifications and excludes them from calendar export.
- batch document import and parse-retry audits pass, including encrypted source
  reads, original-file hash verification, atomic index replacement, retry
  metadata, and fail-closed tamper handling.
- shared-document ACL coverage passes counsel upload/batch/retry with owner-held
  records and actor-aware audit details, plus reviewer, revoked-ACL,
  evidence-lock, missing-matter, and cross-matter denial cases. The batch route
  performs authorization preflight before file inspection.
- multi-principal litigation export approval passes missing-policy fail-closed,
  two-vote and distinct-role policies, requester self-vote rejection, pending
  first vote, rejection, owner-scoped persistence, counsel export/download,
  reviewer denial, ACL revocation, stale version/hash/dependency rejection,
  restricted-export policy overlay, and explicit single-user non-independent
  compatibility. Desktop/mobile UI coverage passes the corresponding server
  projection states 6/6.
- approved litigation artifact download passes ownership, approval/version,
  audit, encrypted-envelope, OOXML signature, and ciphertext-tamper checks; no
  internal export path is returned by the download or export HTTP responses.
- litigation matter audit packaging passes the server-derived 8-item readiness
  checklist, exact state/checklist approval binding, protected package reload,
  per-section and package hashes, transactional orphan-file cleanup, immutable
  counsel sign-off, cross-user and duplicate rejection, package/sign-off
  tamper rejection, HMAC audit linkage, and automatic package/receipt staleness
  after matter changes. `matter.signoff` is restricted to counsel/admin. The
  application receipt does not claim a qualified signature or non-repudiation.
- litigation sign-off anchoring passes exact receipt-to-HMAC-event binding,
  admin-only anchor authorization, Ed25519 journal verification, disabled
  runtime and advanced-head rejection, tampered-chain rejection, and preserved
  historical coverage after the matter changes. Desktop/mobile real-backend
  coverage passes 2/2; the full litigation workspace remains 20 passed with 2
  local-model opt-in flows skipped.
- authenticated global search passes all four entity kinds, Chinese names,
  safe FTS handling, deduplication, limits, user isolation, bounded snippets,
  and storage-path hygiene.
- task calendar export passes authentication, status filtering, UTF-8 RFC 5545
  folding, UTC conversion, reminders, cross-user isolation, safe headers and
  path-free audit events. Deadline notification tests verify the desktop bridge
  and local once-per-day deduplication.
- legal-position review passes persistent restart, exact citation hashes,
  matter/user isolation, pollution-row filtering, unique-open-review and
  state-transition checks, transactional audit-failure rollback across create,
  resolve and withdraw, immutable version lineage, stale-target rejection,
  assessment-hash tamper rejection, bounded level-2 escalation without
  branching, authenticated owner/actor provenance, ACL-scoped matter discovery,
  self-review rejection, distinct level-2 reviewer enforcement, explicit
  independent/non-independent disclosure, open-review artifact exclusion, granted
  change/withdrawal, request withdrawal, uncited-position warning, and source
  tamper rejection. Export integrity separately proves that approval cannot
  bypass open-review, missing-citation, or validation-error gates.
- hearing bundle index generation passes ready and missing-original-hash bad
  cases, source/exhibit projection, final-export validation gating, and
  desktop/mobile generation with zero open validation items on the seeded
  complete matter. It is intentionally not a merged court filing bundle.
  The approved package test additionally opens the downloaded ZIP and verifies
  the manifest, index DOCX, and numbered exhibit entries.
- deterministic litigation eval v6 passes 16/16 on a fully cited audit matter;
  after source tampering it persists failed source-integrity and bundle checks
  without crashing. Desktop/mobile UI coverage passes with the intentional
  uncited-position failure visible as 15/16.
- litigation Agent snapshot audits pass for exact-source inclusion, open-review
  exclusion, uncited-position exclusion, snapshot hashing, and fail-closed
  source tamper handling. Verified snapshots larger than the former 750 KB
  ceiling now enter deterministic source partitioning without dropping grounded
  units; a single oversized unit or a matter requiring more than 24 partitions
  is still rejected before a run is created. Counsel-reviewed retrieval excerpts
  are retained as grounded units during partitioning and cannot be silently
  omitted.
- litigation Agent snapshots now carry both an instance `snapshotHash` and a
  deterministic `stateHash` that excludes generation time. Repeated compilation
  of unchanged confirmed cited state preserves `stateHash`; changing that state
  changes the hash. Server-owned runs persist the binding, and output-review
  request/decision recomputes it and fails closed when the matter changed after
  enqueue, requiring counsel to start a fresh run.
- grounded litigation output audits pass for structured JSON parsing, snapshot
  hash binding, exact-quote SHA-256 checks, citation-set persistence and
  rejection of missing, unknown, modified or truncated citations.
  Desktop/mobile UI coverage verifies the visible citation-verification state.
- civil-litigation domain audit passes low-confidence OCR gates for facts and
  legal positions, short-reason rejection, matter isolation, server-derived
  provenance hashing, successful original-scan comparison, and invalidation
  after provenance tampering.
- latest litigation run recovery passes user/matter/workflow isolation and
  desktop/mobile reload coverage with event-chain reverification.
- Agent output legal review passes idempotent request, event-chain gate,
  canonical output/snapshot binding, tamper rejection, immutable decision,
  mandatory reason, audit persistence and non-independent disclosure.
- bounded source partitioning passes deterministic grouping, per-partition
  byte/hash constraints, source minimization and oversized-item fail-closed
  checks, including a greater-than-750-KB snapshot with complete grounded-unit
  retention. The output review binding accepts and hashes all grounded partitions.
- focus ordering passes stable lexical ranking, original-index tie breaking,
  complete-unit retention and explicit no-omission diagnostics.
- a focus-bearing litigation run now persists a hash-bound keyword retrieval
  manifest inside durable run metadata. It records the complete matter-scoped
  candidate set, BM25 rank/score direction, document/chunk coordinates, text
  hashes, an all-chunk index fingerprint and an explicit `inputBinding: false`
  diagnostic scope. The server counts candidates before retrieval and rejects
  more than 25 with no run created instead of silently applying top-N. Eval
  coverage proves 26-candidate rejection, cross-user isolation, manifest/index
  hashes and survival across durable queue reopen. The diagnostic path remains
  explicitly non-binding unless counsel selects an eligible reviewed manifest.
- retrieval manifests are also first-class matter records with owner-scoped GET,
  creation audit events and stable IDs. Counsel can confirm a complete candidate
  chunk as an immutable excerpt with exact quote/chunk hashes and a mandatory
  reason, or later withdraw it with another reason. Confirmation recomputes the
  all-chunk index fingerprint and rejects stale manifests after any document
  change; withdrawn excerpts cannot be reconfirmed from the same manifest.
  Repository and HTTP surfaces are implemented and the retrieval eval covers
  persistence, projection, audit, withdrawal, stale-index rejection and
  withdrawn-state rejection. A server-derived eligibility projection prevents
  the client from treating counts as authority to bind.
- eligible reviewed excerpts can now be explicitly bound to a litigation Agent
  run by manifest ID. The server recompiles the confirmed excerpts into
  synthetic exact-quote sources, hashes the binding, adds them to the immutable
  run snapshot and citation allowlist, and preserves them across bounded source
  partitions. It revalidates the current all-chunk index and excerpt hashes
  before enqueue, immediately before model execution, and again before legal
  output review. Withdrawal, source-index change, malformed metadata or hash
  mismatch fails closed. The UI never silently restores consent to bind after a
  refresh and clears the selection when the server rejects or invalidates it.
- legal-authority version governance now has a backend foundation. Matter-owned
  authority versions persist jurisdiction, type, issuer, official identifier,
  version label, source reference, full source text SHA-256 and effective date
  interval. A draft cannot support a legal position; counsel must record a
  source-check reason before verification. Position links require a proposed or
  confirmed position, a version effective on the stated
  applicability date, an exact substring quote and a rationale. The version and
  quote hashes plus the human actions enter the matter audit chain, and
  cross-user access fails closed.
  Route-level bad cases cover invalid intervals, draft use, short verification,
  out-of-period use, altered quotations and overlapping verified versions.
  Authority links can be immutably withdrawn and verified versions retired with
  reasons; a replacement cannot be verified until an overlapping prior version
  is retired. Active verified links enter the claim/defense artifact and cited
  Agent snapshot as exact-quote legal sources. Retired versions, source/hash
  tampering and invalid applicability dates fail artifact generation closed.
  The Sol-reviewed Claims & Defenses UI supports draft creation, refresh-safe
  full-text inspection, verification, linking, withdrawal and retirement at
  desktop and mobile widths. A server-derived authority-readiness policy is now
  enforced for every proposed or confirmed legal position. Counsel may preserve
  a confirmed position while its authority is missing or invalid, but that
  position cannot enter an Agent snapshot, approval-ready artifact or export.
  A verified exact-quote link satisfies the gate; withdrawal, retirement,
  changed source text, quote-hash mismatch or out-of-period applicability makes
  the state missing or invalid, marks dependent artifacts stale and excludes the
  position again. The backend Eval suite includes the missing-authority bad case,
  and route/UI coverage includes proposed linking, confirmation, withdrawal,
  tampering, retirement, cross-matter isolation and refresh recovery.
- reviewed synthesis passes unapproved-parent rejection, parent event/output
  binding, exact-citation extraction, synthesis hashing and context-budget
  fail-closed handling; its result re-enters the human review lifecycle.
- verified procedural deadline rules now have a backend foundation. A rule binds
  a named trigger event type to an exact quote in a verified, effective legal
  authority version, a 0-3650 day offset, counting basis, start policy,
  Asia/Shanghai timezone and immutable rule hash. Only a confirmed matching
  event can produce a proposed deadline. The candidate stores the rule,
  authority, quote, trigger date and transparent calculation trace, while the
  lawyer still must confirm the resulting deadline before it can become a task.
  Calendar-day calculation is covered by route-level bad cases and an exact
  local-day-end result. Court business-day rules require a separately verified,
  matter-owned court-calendar version sourced from a verified authority. The
  version hashes its court identity, effective interval, weekly closures,
  source snapshot and every dated open/closed exception. Calculation uses a
  timezone-independent local-date algorithm, records every counted or skipped
  day, supports open make-up weekends, and fails closed outside the verified
  interval or after any rule/source/hash change. Deadline creation and its audit
  event commit in one transaction. Retiring a rule, calendar version or source
  legal-authority version
  marks derived deadlines stale, invalidates existing tasks, blocks further task
  transitions and removes those tasks from calendar export and notifications.
  The Sol-reviewed Procedural Clock supports the complete calendar-day rule
  lifecycle and visible stale recovery at desktop and mobile widths.
  A confirmed event cannot be edited in place. Counsel can instead record a
  reasoned, source-bound correction that creates the next immutable event
  version, preserves the prior event and lineage hashes, and records an
  immutable correction row in the same transaction as the audit event. The old
  event can no longer drive calculations; its derived deadlines become stale,
  linked tasks are invalidated and removed from calendar/notification delivery,
  and the replacement event must be calculated and confirmed separately. A
  missing, changed or hash-invalid source makes the correction fail closed.
- litigation briefs and hearing plans can now enter a persistent document-draft
  lifecycle from only the latest current source artifact. The server converts
  confirmed structured matter state into bounded lawyer-readable text, locks
  source content/dependency hashes and the source section, and records every
  edit as a new immutable version with a parent hash and mandatory change
  summary. Base-version conflicts fail closed instead of overwriting another
  edit. The server computes section-level added, removed, modified and unchanged
  diffs; a human decision binds to the latest exact version hash and cannot be
  rewritten. Approval is blocked when the source artifact has validation errors.
  A later matter-state change marks the draft stale and blocks editing/review,
  but historical diffs remain inspectable and counsel can still withdraw the
  stale draft with an audited reason. Cross-user access, superseded artifacts,
  source-section edits and withdrawn writes fail closed. The Sol-reviewed
  document workspace and 16 desktop/mobile litigation flows pass. A selected
  version can now be exported as a DOCX carrying non-visible matter, version,
  content, source and section bindings plus stable section bookmarks. Import
  structurally parses the OOXML, rejects macros, external relationships,
  embedded or custom XML content, unsafe package paths and unresolved tracked
  changes, then appends accepted visible edits as a new immutable unreviewed
  version. Accepted originals are retained with envelope encryption; accepted
  and authorized rejected attempts are immutable and audited without exposing
  storage paths. Base conflicts, source-section edits, no-op files, stale or
  withdrawn drafts and cross-user writes fail closed. Microsoft Word save-time
  interoperability remains a manual check, and unresolved Word tracked changes
  must be accepted or rejected before import rather than being interpreted by
  Vera.
- local model calibration passes the real scheduler generation path with a
  fixed exact-quote probe, persists pass/fail attempts, isolates users, makes a
  later failure override an earlier pass, and invalidates on model or execution
  setting changes. Settings expose required/passed/failed state on desktop and
  mobile; without a ready model the calibration command remains disabled.
- real local litigation-model benchmarking now runs four fixed synthetic cases
  through the selected loopback runtime at temperature zero: exact citation,
  conflicting evidence, insufficient-evidence abstention and distractor-source
  exclusion. The strict grader requires one finding, complete exact quotes,
  case-specific source sets, confidence, uncertainty and counsel questions, and
  rejects extra findings, unexpected uncertainty/questions and provider-model
  mismatch. SQLCipher stores immutable user-scoped runs, per-case response and
  result hashes, model revision/fingerprint, case-set/grader versions, expiry
  and an append-only event hash chain. The latest failed run is authoritative;
  fingerprint, protocol, case-set, expiry, user isolation and tamper bad cases
  fail closed. This benchmark remains diagnostic and does not establish legal
  correctness or semantic entailment beyond its bounded fixed cases.
- per-finding local semantic-support checks now send only the current finding
  and its exact citations to the selected loopback model at temperature zero.
  A strict parser requires exactly one assessment for every cited source and
  derives the overall supported, partial or unsupported verdict on the server.
  SQLCipher stores every successful and failed attempt as an immutable,
  versioned row bound to the finding, citation set, Agent snapshot, open output
  review, immutable model revision, current calibration and accepted benchmark;
  source, run, review or model changes mark prior advice stale. Malformed JSON,
  missing/extra/duplicate citations, scheduler failure, cross-user access and
  direct row mutation fail closed and remain auditable. This advisory never
  writes a human finding review or satisfies adoption, and is not independent
  verification when the same local model grades its own output. Sol approved
  the 1440px, 900px and 393px states; the full desktop/mobile litigation suite
  passes 20 flows with 2 local-model opt-in flows skipped when no runtime is
  configured.
- task-model routing passes persisted, versioned settings, registered-model
  validation, user isolation, server-owned litigation-versus-routine selection,
  and desktop/mobile settings layout checks. The standard deployment supports
  a stronger calibrated litigation model such as `sol` and a faster routine
  model such as `terra` when operators register those local runtimes.
- packaged macOS frontend/backend startup and clean port release pass.
- the macOS release pipeline now has a fail-closed Developer ID signing and
  notarization mode. Release preflight requires an exact non-ad-hoc Developer ID
  identity and one complete team-matched Apple credential method; keychain
  identities are checked before build. After signing, Apple notarization and
  stapling, release verification requires strict `codesign`, Developer ID/team,
  Gatekeeper, stapler and artifact-checksum success. The ordinary local build
  clears signing credentials and reports `signed=false notarized=false`.
  No real Apple credentials were available in this workspace, so the current
  Vera artifacts remain unsigned, unnotarized and local-only; no release claim
  is made.
- packaged backup bridge audit passes renderer-to-preload-to-main IPC,
  consistent service stop/restart, authenticated owner-only archive creation,
  non-destructive preflight, and tampered-ciphertext rejection in an isolated
  temporary workspace.
- legacy plaintext SQLite/document migration to SQLCipher/envelope encryption
  passes, including idempotency and temporary plaintext-backup removal.
- private deployment preflight passes and runs the backend build,
  local-first audits, local regression, restore drill, retrieval eval, package
  preflight, completion audit, and frontend lint/build in deployment order.
- local deployment doctor passes for local/private runtime readiness.
- local backup manifest check passes and reports the backup scope for
  `aletheia.db`, `documents/`, `exports/`, and `index/`.
- restore preflight passes and validates required backup directories, path
  boundaries, symlink-free backup content, SQLite integrity, and core Aletheia
  schema when a local database is present.
- tracked-file privacy preflight passes and blocks committed local data,
  disallowed `.env` files, private key blocks, high-confidence API key shapes,
  and non-placeholder private deployment secrets.
- operational readiness audit passes and verifies the local doctor, local
  launcher, `/health` endpoint, private-token Aletheia auth boundary, package
  manifest, backup/restore/audit integrity chain, and private deployment
  runbook coverage.
- source provenance audit passes and verifies parser chunk offsets, source
  chunk IDs, document IDs, quote offsets, support status, SQLite FTS5 matter
  filters, source-linked work products, UI registry fields, and exportable
  provenance.
- litigation-domain and UI audits pass source-aware element evidence states,
  proposed/uncited/rejected fact handling, invalid gap-relation rejection,
  cross-user row exclusion, atomic link/audit rollback, and desktop/mobile
  rendering of the resulting matrix status.
- knowledge governance audit passes and verifies matter-scoped Matter Memory,
  human-approved Matter Playbooks, draft-only improvement proposals, no global
  legal memory, no mutation tools in the default Tool Adapter, and regression
  coverage for non-mutating proposals.
- Audit Workbench audit passes and verifies Evidence, Reviews, and Audit
  registry filters, filtered JSON exports, matter-scoped `registry_snapshot`
  saves, UI smoke coverage, and local snapshot audit events.
- Tool Adapter policy audit passes and verifies the HTTP adapter and MCP
  wrapper expose only the approved narrow allowlist while browser, terminal,
  external web, email, and destructive file operations stay disabled.
- approval policy audit passes and verifies high-risk exports require approved
  human checkpoints, playbook updates stay human-approved, external-source use
  remains controlled, and regression/audit checks cover those gates.
- matter isolation audit passes and verifies matter/user-scoped repository
  access, SQLite FTS5 matter filters, per-matter semantic index files,
  matter-scoped memory/playbooks, cross-matter retrieval eval coverage, and
  documentation against cross-matter contamination.
- release evidence manifest passes and records the current git commit,
  validation commands, screenshot hashes, deployment/attribution docs, privacy
  defaults, and approval posture.
- local audit integrity check passes and verifies export audit events, export
  file paths, local data-directory boundaries, and approved checkpoint links for
  high-risk exports when a local database is present. It also reports local
  export file byte counts and sha256 hashes for review packets.
- local export package and durable eval export routes pass and verify JSON
  export files, SQLite export metadata, source-index manifests, export hashes,
  and audit events.
- local runtime-result route audit passes and verifies runtime persistence plus
  approval retry/resume recording without external provider dispatch.
- local review-resolution persistence passes and produces review-derived eval
  cases for accepted/rejected/needs-material/resolved review paths.
- local approved skill activation audit passes and verifies review-derived eval
  candidate skills can become approved matter-scoped playbook skills only after
  explicit human approval, with an `approved_skill_activated` audit event.
- real-data restore drill passes by creating an isolated local regression
  matter, writing a backup manifest with a SQLite hash, running restore
  preflight with zero warnings, and running audit integrity with real export
  files and approved high-risk checkpoints.
- fast operator health check passes.
- GitHub Actions local CI is configured for `main` and pull requests.
- frontend production build passes.
- full frontend lint exits cleanly with no warnings.
- canonical desktop smoke passes for the civil-litigation workspace. It verifies
  that legacy non-litigation matters fail closed, civil-litigation matters enter
  the unified five-stage workbench, and Agent Run/Eval Lab no longer appear as
  first-level views. The focused product-convergence suite passes 5/5; older
  generic-workspace screenshot baselines and compatibility-registry workflows
  are historical evidence, not current acceptance criteria.
- local Aletheia regression passes for TXT, DOCX, PDF, FTS search, evidence,
  Issue Map, optional local-json semantic/hybrid retrieval, work products,
  approvals, exports, Playbook Improvement Proposals, resumable checkpoints,
  matter-scoped registry snapshots, template-specific Compliance Register and
  Red Flag Memo generation, and MCP smoke coverage, including specialist role
  tool-policy and Workflow Graph assertions.
- Run Trace audit passes and verifies AgentRun, AgentStep, ToolCall, and
  HumanCheckpoint persistence, Workflow Graph approval controls, specialist
  tool allowlists, resume behavior, and UI/docs coverage.
- local retrieval eval passes for fail-closed semantic policy, keyword search,
  optional local-json semantic search, hybrid search, and cross-matter
  isolation, including retrieval rank and ranking-basis diagnostics.
- strict local package preflight passes after backend and frontend build output
  exists, and its manifest records privacy defaults, backup/restore scope,
  startup commands, source-availability docs, and release evidence checks.
- completion audit passes and checks current-state evidence for local-first
  storage, the real document chain, professional templates, Matter Memory,
  Playbooks, Run Trace, approval gates, Tool Adapter/MCP, retrieval eval,
  private deployment, automated validation, demo evidence, and attribution.
