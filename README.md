# Vera

> Desktop baseline: Vera 1.1 now uses the connected Electron client described in [`docs/connected_desktop.md`](docs/connected_desktop.md). The older bundled SQLCipher/local-service packaging notes below are historical and do not describe the `1d72e005` Mike/Vera runtime.

Vera is a single-user, local-first macOS legal AI desktop client. Its P0
product structure, interaction model, and UI are a controlled port of the
open-source [Mike](https://github.com/Open-Legal-Products/mike) project at the
pinned commit `e32daad5a4c64a5561e04c53ee12411e3c5e7238`. The UI use has been
authorised; Mike and this repository are distributed under
`AGPL-3.0-only`. Vera supplies the local desktop lifecycle, security boundary,
encrypted persistence, model credentials, backup, and recovery layer.

> **Connected desktop status (2026-07-20):** the macOS client now has two
> explicit packaging modes. The default remains local-only and truthfully
> reports `signed=false notarized=false`; `VERA_RELEASE_SIGNING=true` enables a
> fail-closed Developer ID and Apple notarization pipeline once real program
> credentials exist. See [`docs/connected_desktop.md`](docs/connected_desktop.md).
>
> **Historical P0 status (2026-07-15):** Phases 0-7 are complete. One fresh invocation of
> `./scripts/package-desktop-mac.sh` exited successfully after the packaged
> workspace restart E2E, backup bridge, and restore fail-closed gates passed.
> This closes the local-client P0; it does not make the unsigned, unnotarized
> artifacts a public release.

The final packaged smoke also proved that the real app exits before starting
local services when `ALETHEIA_APPLICATION_ENCRYPTION=disabled` or
`ALETHEIA_DATABASE_ENCRYPTION=metadata_plaintext` is injected. In the packaged
restore fail-closed cases, the working desktop log recorded `startup_failed`
and contained no `renderer_window_creating` event, proving that no renderer was
created before pending-restore validation failed.

## Current P0 product

The P0 product has four core Mike-derived workspaces—Assistant, Projects,
Workflows, and Tabular Review—plus Settings as the fifth local control surface.
The desktop opens `/assistant` and exposes exactly these five first-level
destinations:

| Navigation     | Route             | Local capability                                                                                         |
| -------------- | ----------------- | -------------------------------------------------------------------------------------------------------- |
| Assistant      | `/assistant`      | Durable streaming chat, stop, retry, regenerate, Project documents, and citations                        |
| Projects       | `/projects`       | Generic containers for documents, conversations, workflows, and Tabular Reviews                          |
| Tabular Review | `/tabular-review` | Multi-document, multi-column generation, cell retry/cancel, citations, CSV, and XLSX export              |
| Workflows      | `/workflows`      | Mike-derived local workflow templates, editing, bounded execution, cancellation, retry, and run history  |
| Settings       | `/settings`       | Language/theme, model profiles, Keychain credentials, local data, backup, restore, logs, and diagnostics |

Inside a Project, the active tabs are Documents, Assistant, Workflows, and
Tabular Reviews. `Project` is the general-purpose container; the new product
path does not reinterpret every Project as a litigation matter.

The packaged P0 runtime does **not** require or start Docker, Supabase,
PostgreSQL, R2/S3, Cloudflare, a login service, or a manually operated backend.
Electron owns one loopback-only Express backend and one loopback-only Next.js
frontend. Workspace metadata is stored in SQLCipher, document/blob content is
encrypted locally, and provider API keys are stored in the macOS Keychain
through an isolated credential worker. Demo seeding is off by default.

Supported external model profile types are OpenAI, DeepSeek, Anthropic,
Gemini, and OpenAI-compatible endpoints. A profile cannot become the active
default until its credential is present and its real connection test passes.
The exact-loopback HTTP provider exception exists only for explicit local
test/development use; normal custom providers require the hardened transport.

## Build the macOS client

Use macOS with Node.js/npm and the Xcode command-line tools. From the repository
root:

```bash
npm ci --prefix backend
npm ci --prefix frontend
./scripts/package-desktop-mac.sh
```

The script builds the backend and frontend, prepares the traced runtime,
packages `Vera.app`, audits the packaged resources, runs packaged startup,
workspace-restart, backup, and restore checks, and generates:

```text
desktop/dist/Vera-<version>-<arch>.dmg
desktop/dist/Vera-<version>-<arch>.zip
desktop/dist/Vera-<version>-SHA256SUMS.txt
```

The accepted fresh arm64 package from 2026-07-15 is recorded using
repository-relative locations:

```text
app:      desktop/dist/mac-arm64/Vera.app
dmg:      desktop/dist/Vera-1.0.1-arm64.dmg (198122845 bytes)
zip:      desktop/dist/Vera-1.0.1-arm64.zip (200992113 bytes)
manifest: desktop/dist/Vera-1.0.1-SHA256SUMS.txt
```

The verified manifest entries are:

```text
fd246214916b3485e25bb16c8e00bcf6e8be471ed95679190e7685a5c1c49ef8  Vera-1.0.1-arm64.dmg
7be4a9504151ddd8518141901e3d2753a1cda2fbe13ac27fa7842a9f3d347f1b  Vera-1.0.1-arm64.zip
```

The default build is intentionally unsigned and unnotarized. It is
`local-only`, must remain on the Mac that built it, and must not be presented as
a public release. A distributable build requires real Developer ID and Apple
notarization credentials with `VERA_RELEASE_SIGNING=true`; see
[the desktop guide](docs/desktop_app.md).

Useful source-level gates before packaging:

```bash
npm run build --prefix backend
npm run lint --prefix frontend
npm run build --prefix frontend
npm run test:assistant --prefix frontend
npm run test:workflows --prefix frontend
npm run test:tabular --prefix frontend
npm run test:product-rename --prefix desktop
npm run test:runtime-security --prefix desktop
git diff --check
```

The authoritative migration status and Mike provenance are recorded in
[the P0 migration plan](docs/p0_mike_desktop_migration.md) and
[the controlled port manifest](docs/mike_port_manifest.md). Packaged OCR,
legal-source retention controls, and Document Studio suggestions are recorded
in [the P1 implementation record](docs/p1_ocr_legal_document_studio.md).

## Legacy Vera history

The material below documents the earlier civil-litigation, research,
governance, and private-pilot work. That code remains in the repository for
compatibility and regression coverage, but `/aletheia/*` is not the P0 primary
navigation, and the historical Docker/demo workflow is not the current desktop
quick start.

**Vera is not a legal chatbot.** It is a local-first civil-litigation workspace
for lawyer-led matter work, from intake and evidence review through procedure,
legal research, drafting, approval, and audited export.

Vera turns confidential case files and bounded agent runs into typed,
evidence-linked, reviewed, gated, audited, and eval-ready litigation work
products. V1 exposes only the **Civil Litigation** domain. Earlier contract,
compliance, diligence, and generic Agent Workspace experiments remain isolated
from navigation, settings, demo seeding, and matter routing until they are
reintroduced as separately validated products.

In V1, the user-facing shape is a civil-litigation matter workbench, not a
chat-first, template-marketplace, or mock-first product surface.

Core analogy:

```text
Codex: repo -> agent edits code -> tests run -> diff opens -> human reviews -> merge
Vera: local matter vault -> agent creates professional artifacts -> gates run -> diff/review packet opens -> expert reviews -> final export
```

The core product loop is:

```text
Evidence -> Issue/Risk -> Draft -> Review -> Gate -> Audit -> Eval
```

The repository demonstrates a professional agent-system pattern inspired by
Herdr-style multi-agent observability, Tutti-style shared context and handoff,
and Hermes-style skills/memory loops, rebuilt around local-first operation,
evidence binding, expert control, audit readiness, and eval-driven improvement.

Current stage: **V1 local/private-pilot candidate completed; production/SaaS
not claimed.** Vera is not positioned as production SaaS, legal advice
software, or a replacement for qualified professionals.

## Docker Quick Start

```bash
git clone https://github.com/shawliu998/Aletheia.git
cd Aletheia
cp .env.example .env
docker compose up --build
```

Open:

```text
http://localhost:3000/aletheia
```

When no civil-litigation matter exists, Docker seeds a local-only **Civil
Litigation Demo** matter so reviewers can inspect the V1 loop immediately:

```text
intake -> documents -> facts/evidence -> claims/defenses -> procedure/deadlines -> drafting -> review -> audit/export
```

Set `ALETHEIA_DEMO_SEED_ENABLED=false` in `.env` before starting Docker for a
blank workspace. See `docs/install_local.md` for data reset, private-token
mode, and validation details.

## Desktop App

Vera also ships as an unsigned macOS local desktop app. It bundles the
local backend and frontend and stores data on the local machine.

Download the latest desktop release asset from GitHub, then verify the
published SHA256 checksum before opening it. Because the project does not yet
have an Apple Developer ID, macOS may show an unidentified developer warning on
first launch.

To build the desktop app locally:

```bash
./scripts/package-desktop-mac.sh
```

See `docs/desktop_app.md` for unsigned install steps, ports, validation, and
the future Developer ID signing/notarization path.

## V1 Private Pilot Snapshot

As of 2026-07-09, the V1 local/private-pilot candidate is completed for
bounded reviewer evaluation with explicit caveats. It should be presented as an
expert-support workspace, not production SaaS and not legal advice.

Working local/private-pilot scope:

- Local matters can ingest source documents, preserve document/chunk metadata,
  search matter-scoped source chunks, and map retrieved chunks into
  source-linked evidence.
- The V1 source-index API is available in local mode at
  `GET /aletheia/matters/:matterId/v1/source-index` for documents, chunks, and
  evidence source links.
- The Remote Matter Command Center export path fetches that local source index
  and can include `audit_pack.source_index_manifest` plus source-index manifest
  counts in downloaded local AgentOps export packages.
- Deterministic runtime, gate summaries, review visibility, local
  review-resolution persistence, export/audit routes, durable eval exports, and
  approved skill activation are available for focused private-pilot validation
  without external model keys.

Unavailable or partial V1 scope:

- Local runtime approval retry records authorization and trace state only; it
  does not dispatch a real external provider.
- Review-derived eval, export persistence, and approved skill activation are
  local-only; do not describe them as production SaaS or automatic production
  learning.
- External model calls remain off by default for sensitive/private data and
  must be explicitly configured, logged, and auditable if enabled later.
- Full Playwright UI smoke passed 6/6 on explicit local backend/frontend ports
  for the local/private-pilot validation path; focused mobile smoke passed 2/2,
  and frontend typecheck/lint passed.

## What A Reviewer Should Notice

- Aletheia makes matter files, source documents, agent traces, work products,
  review decisions, gates, audit events, and eval exports visible in one
  workspace.
- Claims are expected to remain bound to source evidence, support status, and
  human review decisions.
- High-risk exports are blocked until citation and human approval gates pass.
- Expert review feedback becomes structured eval material instead of getting
  lost in comments.
- The reusable Kernel remains available for future domains, but V1 product
  navigation and routing are restricted to civil-litigation matters.

## Demo Flow

1. Open `/aletheia`.
2. Open the seeded **Civil Litigation Demo** matter from the Matter
   Queue, or create a local matter with uploaded source files.
3. Import pleadings, contracts, payment records, correspondence, and court
   notices into the matter-local source index.
4. Confirm source-bound facts and map them to claims, defenses, and elements.
5. Review legal authorities and research conclusions with exact excerpts.
6. Confirm procedural events and calculated deadlines before task projection.
7. Generate pleadings, evidence catalogs, hearing plans, or hearing bundles.
8. Complete human review and approval gates, then export the work product and
   audit package.

See `docs/product_kernel.md`,
`docs/domain_packs/private_contract_due_diligence_review.md`,
`docs/v1_private_pilot_status.md`, `docs/v1_acceptance_matrix.md`,
`docs/reviewer_walkthrough.md`, `docs/demo_script.md`, `docs/feature_map.md`,
and `docs/deepseek_pitch.md` for reviewer-facing walkthrough and positioning
material.

## Aletheia Kernel And Domain Packs

Aletheia should be read as a Kernel plus Domain Packs.

Kernel capabilities:

- Local Vault;
- Agent Loop Runtime;
- Typed Artifact Graph;
- Permission + Tool Policy;
- Review + Gate Console;
- Audit Trace;
- Eval Replay;
- Human-approved Skills.

The only active V1 domain is Civil Litigation. It configures intake, source
documents, facts and evidence, claims and defenses, legal research, procedure
and deadlines, drafting, hearing preparation, review, and audit export. Other
domain implementations are retained as legacy code only and are not product
entry points.

## Architecture

Aletheia adds a Kernel layer above the existing project, document, model, and
storage foundations:

```text
Local Matter Vault
  -> Document Registry
  -> Bounded Agent Plan
  -> Document Understanding
  -> Evidence Mapping
  -> Domain Analysis
  -> Draft Work Product
  -> Human Review
  -> Gate Decision
  -> Audit Log
  -> Feedback / Eval Export
```

The installed product does not substitute fallback matters when the local
backend is unavailable. Its matter list is API-backed and restricted to
`civil_litigation`; older non-litigation records remain stored but isolated.
The demo workspace can export two local JSON artifacts:

- Audit Pack: matter profile, document registry, workflow artifacts, review log, audit log, and validation status.
- Feedback Eval Dataset: expert review tags mapped back to their target claim, evidence, memo section, and supporting citations.

The first API surface is mounted at `/aletheia` on the backend and currently
supports listing matters, creating a matter, loading a matter, adding review
items, saving structured work products, appending audit events, uploading and
searching local documents, mapping source-linked evidence, generating evidence
matrices and draft memos, requesting approval checkpoints, maintaining Matter
Memory, drafting and approving Matter Playbooks, and calling the narrow
Aletheia Tool Adapter.
Newly created matters receive a deterministic initial Agent Plan work product so
the workflow starts from a reviewable scaffold even before model integration.

Backend persistence goes through the local Aletheia repository boundary. It
uses SQLite persistence for Aletheia matters, work products, reviews, audit
events, and agent runs. Local mode also
stores uploaded documents on disk, extracts text, chunks documents, and indexes
chunks with SQLite FTS5 keyword search.

The Matter Queue reads persisted local records from the Aletheia API. When the
backend or auth is unavailable, it fails explicitly and does not inject demo or
fallback records.

## How To Run

### Docker local install

For a reviewer or private-pilot user, the fastest local install path is Docker:

```bash
cp .env.example .env
docker compose up --build
```

Then open:

```text
http://localhost:3000/aletheia
```

This starts the frontend, backend, and a persistent local Docker volume for
Aletheia data. See `docs/install_local.md` for details, private-token mode,
health checks, and data reset commands.

### Manual development

```bash
cd frontend
npm install
npm run dev
```

Then open:

```text
http://localhost:3000/aletheia
```

The demo workspace is deterministic and does not require an external model API key.

Run the local-first regression:

```bash
cd backend
npm run test:aletheia:local
```

This uses an isolated temporary data directory and verifies source upload,
local search, evidence mapping, evidence matrix, draft memo, Matter Memory,
Matter Playbooks, run trace, approval gates, local export files, and the stdio
MCP wrapper. The synthetic document fixtures cover TXT, DOCX, and PDF parsing.

Run the restore drill when validating private-deployment readiness:

```bash
cd backend
npm run test:aletheia:restore-drill
```

This creates a real temporary local matter through the regression workflow, then
runs backup manifest, restore preflight, and audit integrity against that same
non-empty data directory.

Run the local retrieval eval:

```bash
cd backend
npm run test:aletheia:retrieval-eval
```

This checks keyword, optional local-json semantic, hybrid retrieval,
fail-closed policy, and matter isolation before retrieval ranking changes.

Run the private preflight before a handoff or local package:

```bash
cd backend
npm run check:aletheia:preflight
```

This runs the backend build, local-first audits, local regression, restore
drill, retrieval eval, package preflight, completion audit, and frontend
lint/build in deployment order. Set `ALETHEIA_PREFLIGHT_INCLUDE_UI=true` to add
the Playwright UI smoke suite.

Run the fast operator health check before a scheduled engineering loop decides
which heavier validations to run:

```bash
cd backend
npm run check:aletheia:operator
```

This checks local privacy defaults, least-privilege tool boundaries,
professional positioning copy, validation entrypoints, and reports the current
worktree size without failing solely because changes are uncommitted.

Run the local deployment doctor before giving an operator a private pilot build:

```bash
cd backend
npm run check:aletheia:doctor
```

This verifies the runtime environment for local/private use: Node 22+,
`node:sqlite`, local storage/auth defaults, writable `.data/aletheia`
directories, retrieval settings, and semantic-index boundaries.

Run the backup manifest check before handoff or migration:

```bash
cd backend
npm run check:aletheia:backup
```

This emits a machine-readable backup scope for `aletheia.db`, `documents/`,
`exports/`, and `index/`, including directory sizes and a SQLite sha256 when a
local database exists.

Run the restore preflight before pointing a new local/private deployment at a
restored data directory:

```bash
cd backend
ALETHEIA_RESTORE_SOURCE_DIR=.data/aletheia npm run check:aletheia:restore
```

This validates the restore source without copying or deleting data. It checks
the local data boundary, required backup directories, symlink-free content,
SQLite `quick_check`, core Aletheia tables, and an optional backup manifest.

Run the privacy preflight before committing, handoff, or packaging:

```bash
cd backend
npm run check:aletheia:privacy
```

This scans tracked repository files for accidental `.data` artifacts,
disallowed `.env` files, high-confidence secret patterns, and non-placeholder
private deployment tokens without reading untracked client documents.

Run the operational readiness audit before private deployment or packaging:

```bash
cd backend
npm run check:aletheia:ops-readiness
```

This verifies the local doctor, local launcher, `/health` endpoint, private
token auth boundary, package manifest, backup/restore/audit integrity chain,
and private deployment runbook coverage.

Run the source provenance audit before changing document parsing, evidence
mapping, or work product generation:

```bash
cd backend
npm run check:aletheia:source-provenance
```

This verifies that source-linked evidence keeps document IDs, source chunk IDs,
quotes, quote offsets, support status, FTS5 matter filters, UI registry fields,
and exportable provenance.

Run the knowledge governance audit before changing Matter Memory or Playbooks:

```bash
cd backend
npm run check:aletheia:knowledge-governance
```

This verifies matter-scoped memory, human-approved playbooks, draft-only
improvement proposals, no global legal memory, and no default Tool Adapter
mutation path for knowledge artifacts.

Run the Audit Workbench audit before changing registry pages, export packets,
or local audit review UI:

```bash
cd backend
npm run check:aletheia:audit-workbench
```

This verifies Evidence, Reviews, and Audit registry filters, filtered JSON
exports, matter-scoped `registry_snapshot` saves, UI smoke coverage, and local
snapshot audit events.

Run the Tool Adapter policy audit before enabling agent integrations:

```bash
cd backend
npm run check:aletheia:tool-policy
```

This verifies that the HTTP Tool Adapter and stdio MCP wrapper expose only the
approved narrow allowlist, keep browser/terminal/web/email/destructive tools
disabled, and preserve approval-gate policy signals.

Run the approval policy audit before private handoff:

```bash
cd backend
npm run check:aletheia:approval-policy
```

This verifies that high-risk exports require approved human checkpoints,
playbook updates stay human-approved, external-source use remains controlled,
and regression/audit checks still cover those gates.

Run the matter isolation audit before changing retrieval or memory behavior:

```bash
cd backend
npm run check:aletheia:matter-isolation
```

This verifies matter/user-scoped repository access, SQLite FTS5 matter filters,
per-matter semantic index files, matter-scoped memory/playbooks, cross-matter
retrieval eval coverage, and documentation against cross-matter contamination.

Run the Run Trace audit before changing agent runtime or review UI behavior:

```bash
cd backend
npm run check:aletheia:run-trace
```

This verifies the AgentRun/AgentStep/ToolCall/HumanCheckpoint contract,
Workflow Graph controls, specialist role tool allowlists, approval gates,
resume behavior, and Run Trace UI/docs coverage.

Generate the release evidence manifest before handoff:

```bash
cd backend
ALETHEIA_RELEASE_EVIDENCE_OUT=../release-evidence.json npm run check:aletheia:evidence
```

This emits a reviewable JSON manifest for the current git commit, validation
commands, demo screenshots with hashes, deployment/attribution documents,
privacy defaults, and approval posture.

Run the audit integrity check after a real local matter workflow or before
handoff:

```bash
cd backend
ALETHEIA_AUDIT_SOURCE_DIR=.data/aletheia npm run check:aletheia:audit-integrity
```

This validates the local audit chain without mutating data: export work products
must have matching audit events, export files must exist under the local data
directory, high-risk exports must resolve to approved human checkpoints, and
local export files are reported with byte counts and sha256 hashes.

The same validation posture is enforced on `main` and pull requests through
`.github/workflows/aletheia-local-ci.yml`. The CI workflow installs backend and
frontend dependencies, builds both apps, runs the local regression, restore
drill, and retrieval eval, executes privacy, tool-policy, approval-policy,
matter-isolation, package, evidence, integrity, and completion checks, then runs
frontend lint and the Aletheia UI smoke suite.

Create a screenshot-ready local UI smoke matter:

```bash
cd backend
npm run seed:aletheia:ui-smoke
```

See `docs/ui_smoke.md` for the full browser verification flow.
Run the automated UI smoke:

```bash
cd frontend
npm run test:aletheia:ui
```

The smoke runs against isolated local backend/frontend services and covers both
desktop Chromium and a mobile Chromium viewport, including screenshot baseline
assertions for the initial workspace render.

See `docs/private_deployment.md` for local desktop and private single-tenant
deployment notes.
See `docs/hybrid_retrieval.md`, `docs/retrieval_eval.md`, and
`docs/desktop_packaging_checklist.md` for retrieval, eval, and packaging
follow-up plans.
See `docs/release_notes_local_first_mvp.md` for the current local-first MVP
summary.
See `docs/status.md` for the current release-readiness snapshot.

Start local backend and frontend together:

```bash
cd backend
npm run dev:aletheia:local
```

The launcher leaves existing dev servers untouched and prints the MCP command
for clients that should start the stdio wrapper.

## Local Pilot Mode

The current pilot is API-backed and limited to `civil_litigation`. It does not
inject fallback matters when the local service is unavailable. The following
modules are retained only as implementation utilities or isolated compatibility
code; they are not alternate product domains:

- `frontend/src/aletheia/mockData.ts`
- `frontend/src/aletheia/workflow.ts`
- `frontend/src/aletheia/schemas.ts`
- `frontend/src/aletheia/exports.ts`

The local-first path now supports source document upload, text extraction,
SQLite FTS5 search, mapping retrieved chunks into persisted Evidence Items, and
generating source-linked Issue Map, Evidence Matrix, and Draft Memo work
products. Local search results include deterministic claim/issue suggestions so
source chunks can be mapped without manually typing a claim ID, while still
remaining reviewable and overrideable. Search results now expose rank, score
direction, retrieval layers, and a plain-language ranking basis so evidence
selection is auditable. The workspace renders Issue Map groups with support
counts, open questions, source documents, and representative quotes for expert
review, and reviewers can tag mapped claims directly from the Issue Map panel
with saved review tags echoed back on the mapped issue. Agent runs now expose a
reviewable trace with bounded specialist role labels, allowed tool lists, steps,
tool calls, human checkpoints, and persisted Workflow Graph metadata. Audit
Pack, Feedback Dataset, and Final Memo exports
are blocked by executable human approval gates. Run Trace entries now surface
linked work products, audit events, and directed graph transitions. Matter
Memory and Matter Playbooks are now matter-scoped, persisted locally, and
audited; playbooks must be explicitly approved before use as a professional
workflow manual. Reviewer feedback and review tags can generate draft Playbook
Improvement Proposals without mutating approved playbooks. The Aletheia Tool
Adapter now exposes a narrow least-privilege tool surface for
external agents without enabling terminal, browser, web search, email, or
destructive file operations. Export-class work products are also written to the
local export store under `.data/aletheia/exports`. The Audit page now works as
a live local Audit Workbench: it aggregates persisted matter audit events,
review tags, work products, approval gates, and matter readiness packets instead
of relying only on demo data. Evidence and Reviews pages also read persisted
local matters, so source-backed evidence and human review tags can be inspected
across the workspace. Evidence, Reviews, and Audit views include local filters
for matter, claim, support status, review tag, and audit action to make audit
material easy to locate during expert review, and each view can export the
filtered result set as local JSON for a review packet or demo evidence. The same
filtered views can also be saved back into each affected matter as
`registry_snapshot` work products, persisted under the local export store with
an audit event and matter-scoped provenance.

## Screenshots

Matter Queue:

![Aletheia matter queue](docs/screenshots/aletheia-home-desktop.jpg)

Local Matter Workspace:

![Aletheia local matter workspace](docs/screenshots/aletheia-matter-overview-desktop.jpg)

Agent Run Trace:

![Aletheia run trace](docs/screenshots/aletheia-run-trace-desktop.jpg)

Mobile Workspace:

![Aletheia mobile matter workspace](docs/screenshots/aletheia-matter-mobile.jpg)

## License And Attribution

This repository retains the original open-source license file and attribution notes. See `docs/license_attribution.md`.

## Roadmap

1. Replace or augment the local-json semantic prototype with a LanceDB-backed
   local semantic index adapter behind `ALETHEIA_SEMANTIC_INDEX_ENABLED=true`.
2. Harden the private desktop packaging prototype into a signed installer or
   operator-managed bundle.
3. Split inherited oversized frontend/backend files before major feature work.
