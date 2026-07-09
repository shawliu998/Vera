# Aletheia 明证

Aletheia 明证 is an Agent Workspace for high-stakes professional work.

It turns complex documents into verifiable, reviewable, and auditable expert work products.

This is not a legal chatbot. It demonstrates how agentic systems can support legal matter review, compliance impact assessment, and deal due diligence through evidence-grounded workflows, human review, and audit-ready artifacts.

## Demo Flow

1. Open `/aletheia`.
2. Use the Aletheia nav: Matters, Templates, Evidence, Reviews, and Audit.
3. Open the Legal Matter Review demo matter.
4. Inspect the agent plan, issue map, evidence matrix, draft memo, human review panel, audit log, and feedback summary.
5. Export the Audit Pack JSON and Feedback JSON from the demo workspace.
6. Open the Compliance Impact Review and Deal Due Diligence templates for workflow previews, or create local matters from those templates to generate source-linked Compliance Register and Red Flag Memo work products.

## Workflow Templates

- Legal Matter Review: full MVP demo with matter intake, chronology, issue map, evidence matrix, draft memo, human review, audit trail, and feedback summary.
- Compliance Impact Review: local source-linked workflow with obligation/control evidence, issue map, evidence matrix, Compliance Register, human review, and audit trail.
- Deal Due Diligence Memo: local source-linked workflow with VDR evidence, issue map, evidence matrix, Red Flag Memo, diligence questions, human review, and audit trail.

## Architecture

Aletheia adds a structured workspace layer above the existing project, document, model, and storage foundations:

```text
Matter Workspace
  -> Document Registry
  -> Agent Plan
  -> Document Understanding
  -> Evidence Mapping
  -> Domain Analysis
  -> Draft Work Product
  -> Human Review
  -> Audit Log
  -> Feedback / Eval Export
```

Deterministic fallback fixtures are centralized in `frontend/src/aletheia`.
They keep the workspace usable when a local backend is not running, while the
local-first path supports real document upload, parsing, retrieval, evidence
mapping, review, and audited exports. The demo workspace can also export two
local JSON artifacts:

- Audit Pack: matter profile, document registry, workflow artifacts, review log, audit log, and validation status.
- Feedback Eval Dataset: expert review tags mapped back to their target claim, evidence, memo section, and supporting citations.

The first database migration for the workspace domain is
`backend/migrations/20260708_01_aletheia_workspace.sql`. It adds matters,
matter documents, work products, evidence items, review items, and audit events.
`backend/migrations/20260708_02_aletheia_agent_runtime.sql` adds the agent
runtime skeleton: runs, steps, tool calls, and human checkpoints.

The first API surface is mounted at `/aletheia` on the backend and currently
supports listing matters, creating a matter, loading a matter, adding review
items, saving structured work products, appending audit events, uploading and
searching local documents, mapping source-linked evidence, generating evidence
matrices and draft memos, requesting approval checkpoints, maintaining Matter
Memory, drafting and approving Matter Playbooks, and calling the narrow
Aletheia Tool Adapter.
Newly created matters receive a deterministic initial Agent Plan work product so
the workflow starts from a reviewable scaffold even before model integration.

Backend persistence now goes through an Aletheia repository boundary. The
default adapter remains Supabase/Postgres for compatibility with the base
application. The local adapter now supports SQLite persistence for Aletheia
matters, work products, reviews, audit events, and agent runs. Local mode also
stores uploaded documents on disk, extracts text, chunks documents, and indexes
chunks with SQLite FTS5 keyword search.

The Matter Queue now uses a hybrid data model: it renders deterministic
fallback matters immediately, then attempts to load persisted matters from the
Aletheia API. When the backend or auth is not configured, the UI stays usable in
local fallback mode.

## How To Run

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

Run the Tool Adapter policy audit before enabling agent integrations:

```bash
cd backend
npm run check:aletheia:tool-policy
```

This verifies that the HTTP Tool Adapter and stdio MCP wrapper expose only the
approved narrow allowlist, keep browser/terminal/web/email/destructive tools
disabled, and preserve approval-gate policy signals.

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
drill, and retrieval eval, executes privacy, tool-policy, package, evidence,
integrity, and completion checks, then runs frontend lint and the Aletheia UI
smoke suite.

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
See `docs/status.md` for the current release-readiness snapshot and blockers.

Start local backend and frontend together:

```bash
cd backend
npm run dev:aletheia:local
```

The launcher leaves existing dev servers untouched and prints the MCP command
for clients that should start the stdio wrapper.

## Local Pilot Mode

Current MVP uses deterministic fallback data for stable offline and screenshot
behavior:

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
