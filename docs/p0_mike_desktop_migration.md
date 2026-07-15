# Vera P0 Mike Desktop Migration

Date: 2026-07-15

Status: Phases 0-7 complete; fresh packaged verification passed

Product decision: **Mike is the product and workflow source of truth; Vera is the local desktop, storage, and security source of truth.**

The four core P0 workspaces are Assistant, Projects, Workflows, and Tabular
Review. Settings is the fifth first-level surface and the local desktop control
plane; `Project` remains the generic container and context boundary.

Verification truth on 2026-07-15:

- the active source tree contains the five-destination Vera shell, generic
  Project workspace, Settings/model gateway, durable Assistant, Workflow, and
  Tabular Review verticals;
- the local Workspace schema is additive through v10
  (`v10AssistantDurableEvents`), and `/api/v1` is mounted once beside retained
  Legacy `/aletheia/*` routes;
- source builds and the focused backend, frontend, security, credential,
  diagnostics, workflow, and Tabular audits have passed during implementation;
- one full `./scripts/package-desktop-mac.sh` invocation exited `0` against the
  integrated source and produced the fresh arm64 Vera artifacts recorded below;
- package hygiene, SQLCipher, legacy migration, packaged startup/port release,
  workspace cross-restart E2E, backup bridge, and restore fail-closed all passed;
- packaged smoke rejected real launches with application encryption `disabled`
  and database encryption `metadata_plaintext`; restore fail-closed working logs
  contained `startup_failed` and no `renderer_window_creating` event;
- DMG/ZIP checksum acceptance and Phase 7 are complete. The artifacts remain
  unsigned, unnotarized, and local-only, so public distribution is not claimed.

## 1. Scope and upstream baseline

This is not a visual imitation of Mike and it is not an extension of the
current litigation-first Vera navigation. The P0 product is a Vera-branded,
single-user, local-first desktop edition of the open-source Mike product.

The audited upstream baseline is:

```text
repository: https://github.com/Open-Legal-Products/mike
commit:     e32daad5a4c64a5561e04c53ee12411e3c5e7238
date:       2026-07-08
subject:    Merge pull request #206 from Open-Legal-Products/workflows-ui-excel-ppt-updates
license:    AGPL-3.0-only
```

Mike UI use has been authorised. The port still preserves the pinned source,
AGPL-3.0-only licence, attribution, and per-file provenance; the authorisation
does not remove the upstream licence obligations.

The current Vera history and the upstream Mike history have no merge base.
The current comparison is therefore a controlled product-port exercise, not a
normal branch merge. Directly merging `upstream-mike/main` is prohibited for
this migration.

The legal-research and legal-opinion work that was uncommitted when the audit
started predates this migration. It was completed, validated, and recorded as
the separate `d350a69` checkpoint. It is not migration scaffolding and must not
be mixed into a Mike-port change.

## 2. Product boundary

### Included in P0

- Vera-branded Mike shell and desktop information architecture.
- Assistant and project-scoped Assistant conversations.
- Projects, project folders, documents, document versions, document edits,
  and local previews.
- Workflows for Assistant and Tabular Review.
- Tabular Review, cell generation, retry, citations, and CSV/XLSX export.
- Local model settings and user-supplied external model providers.
- Local SQLCipher persistence, encrypted local files, local search, backup,
  restore, and packaged macOS operation.

### Explicitly excluded from P0

- Mike login, signup, password reset, MFA, organisations, people, sharing, and
  multi-user RLS flows.
- Supabase Auth, Supabase Postgres, R2/S3, Resend, Cloudflare deployment, and
  server-wide environment API keys.
- Mike MCP OAuth/connectors and open-source workflow submission.
- CourtListener and other legal-research databases.
- Vera litigation workbench, AgentOps, gate UI, Eval Lab, audit pack UI,
  domain packs, and legal-source approval flows as primary navigation.
- Cloud sync, team collaboration, Word Add-in, OCR API, and unrestricted agent
  execution.
- Tabular Review chat. The API advertises `chat: false` and the UI does not
  simulate a review-chat runtime that is not included in P0.

Existing litigation, audit, governance, and legal-research code remains stored
and testable as Legacy Vera functionality. It is not deleted in P0 and is not a
dependency of the new Mike product path.

## 3. Current architecture

```text
Electron main
  -> owns one loopback Express backend and one Next.js frontend
  -> creates a random per-launch bearer token
  -> provisions application/SQLCipher keys in macOS Keychain
  -> starts an isolated model-credential utility worker
  -> exposes an allowlisted native bridge for settings/backup/recovery

Next.js renderer
  -> /assistant, /projects, /tabular-review, /workflows, /settings
  -> Project tabs: Documents, Assistant, Workflows, Tabular Reviews
  -> strict typed clients for /api/v1

Express backend
  -> one Vera application composition root
  -> Workspace repositories/services and Legacy compatibility routers
  -> one shared durable job pump for parse/Assistant/Workflow/Tabular jobs
  -> SQLCipher + FTS5 + encrypted Workspace blobs

Local app-data directory
  -> Workspace/Legacy metadata database
  -> encrypted documents / exports / indexes / backups
  -> owner-only rotated desktop and model-call logs

macOS Keychain
  -> independent application and SQLCipher keys
  -> origin/profile-bound model-provider credentials
```

Observed code facts:

- `backend/src/index.ts` is a thin process entry and
  `backend/src/veraApplication.ts` mounts authenticated `/api/v1` Workspace
  routers once, while retaining `/aletheia/*` for Legacy regression.
- Workspace migrations v1-v10 cover the initial schema, integrity and runtime
  constraints, Project ownership, Assistant runtime/durable events, Workflow
  runtime, Mike Tabular semantics, and model credential/readiness revisions.
- `desktop/main.js` binds both services to `127.0.0.1`, opens `/assistant`,
  passes child processes an explicit environment allowlist, and stops the
  frontend, backend, and credential worker in bounded order.
- the active renderer route tree contains Assistant, Projects, project-scoped
  Assistant/Workflow/Tabular routes, global Workflows/Tabular Review, and
  Settings/Models/Local Data.
- the new path contains no Supabase, PostgreSQL, R2/S3, organisation, sharing,
  login, OAuth/MCP, or server-wide provider-secret dependency.

## 4. Reuse, adapt, freeze, and add

### Directly reuse

| Area | Existing implementation | P0 use |
|---|---|---|
| Electron lifecycle | `desktop/main.js` | process ownership, loopback ports, health wait, shutdown, single-instance behaviour |
| Renderer security | `desktop/main.js`, `desktop/preload.js` | sandbox, context isolation, navigation/window restrictions, IPC allowlist |
| Local auth | Electron bootstrap token and backend middleware | single-user local process authentication |
| SQLCipher | `localDatabase.ts`, `localDatabaseKey.ts` | encrypted metadata database and startup integrity checks |
| File encryption | `localEnvelopeCrypto.ts` | encrypted originals, extracted data, and exports |
| Document safety | upload, MIME/signature validation, hashes, parser, CDR | Mike document and version ingestion |
| Retrieval | SQLite FTS5 and document chunks | default P0 project retrieval; no external vector database |
| Backup/restore | `desktopBackup.ts`, desktop bridges and audits | consistent local workspace backup and recovery |
| Packaging | `scripts/package-desktop-mac.sh`, Electron Builder config | DMG/ZIP, manifest, optional signing/notarization |
| Safe errors | `safeError.ts` and privacy audits | API/provider error redaction |

### Reused after abstraction

- Database access is split into migration, repository, service, and route layers.
- Authoritative file paths and encrypted blob access are split behind a
  `WorkspaceBlobStore` interface.
- Local identity/token parsing is contained by an `AuthProvider` and a single local
  `PrincipalContext`.
- Parsing and FTS are reused through document services rather than calling the
  matter repository from new routes.
- Provider scheduling is exposed through one model gateway; it does not replace
  Mike Assistant or the required external providers.
- The macOS Keychain pattern is generalised into a model-provider
  `CredentialStore` backed by an isolated credential worker.

### Freeze outside the primary product path

- all current matter/litigation tables and routes;
- litigation work products, issue trees, evidence graph, procedure, approval,
  audit, AgentOps, Eval, skills, and domain packs;
- current legal-source credential flow and external-source approval workflow;
- semantic JSON indexes until their files have the same encryption guarantees
  as SQLCipher/FTS;
- browser/Docker deployment paths as non-desktop developer compatibility only.

### Required convergence now implemented

- Mike-derived product routes, pages, components, hooks, contexts, and central
  i18n/brand gates;
- additive Workspace migrations v1-v10;
- repositories and services for Projects, Documents/Versions, Chats,
  Workflows, Tabular Reviews, Models/Settings, and Jobs;
- model profiles with Keychain-only model-provider secrets;
- durable streaming generation, cancellation, retry, and restart recovery;
- one resumable SQLite job runtime shared by parsing, Assistant, Workflow, and
  Tabular execution;
- source-level Project/Assistant/Workflow/Tabular coverage and a packaged
  cross-restart E2E script;
- pinned Mike provenance and source-lock audits.

The fresh packaged Phase 7 execution evidence is recorded in Sections 11 and
15. No P0 product implementation or packaged-acceptance item remains open;
Developer ID signing and Apple notarization are a separate release track.

## 5. Resolved Phase 0 security blocker

The Phase 0 baseline found that the old
`desktop/main.js::ensureMacOsKeychainKey()` caught every
`find-generic-password` error and then called `add-generic-password -U`. A
permission denial, timeout, malformed existing item, or other read failure can
therefore be treated as a missing item and overwrite an existing application
or database key. That can make encrypted workspace data unrecoverable.

The current implementation is fail closed:

- only the explicit macOS item-not-found status may create a key;
- access denial, timeout, invalid stored value, and command failure must stop
  startup;
- a valid existing key must never be updated;
- tests must not touch the user's real Keychain.

The `aletheia_provider_secrets` path remains a frozen Legacy legal-source
credential path, not the new model-provider system. It accepts a secret through a
renderer form and stores encrypted ciphertext in SQLite. That legacy path is
not reused. New model API keys live only in Keychain,
the database stores only a credential reference/status, and no full key is
returned to the renderer or written to logs/backups. The renderer submits a new
secret once; the backend passes it through a private MessagePort to the isolated
credential worker. Stored credential readback is available only to the backend
model adapter.

## 6. Converged architecture

```text
Vera Electron Desktop
  |- lifecycle, loopback services, native dialogs, Keychain, safe IPC
  |
  |- Mike-derived Vera renderer
  |    |- Assistant
  |    |- Projects
  |    |- Tabular Review
  |    |- Workflows
  |    `- Settings
  |
  `- Local Express backend (/api/v1)
       |- Mike product route contracts
       |- Workspace services
       |- model gateway
       |- persisted job runtime
       |- repositories
       |- encrypted blob store
       `- SQLCipher + FTS5

External network: only an explicit user-configured model request.
```

There is one frontend and one backend. A second nested `mike/` application was
not added. Upstream product code is restored into the active
`frontend/` and `backend/` trees, with cloud calls replaced at repository,
storage, auth, and secret-store boundaries.

## 7. Current P0 data model

The implemented model preserves Mike's product semantics, adds the local operational
entities required by Vera, and does not reuse `matter` as a generic name.

### Mike product entities retained

- `projects`
- `project_subfolders`
- `documents`
- `document_versions`
- `document_edits`
- `chats`
- `chat_messages`
- `workflows`
- `hidden_workflows`
- `tabular_reviews`
- `tabular_cells`
- `tabular_review_chats`
- `tabular_review_chat_messages`

### Vera local operational entities added

- `workspace_schema_migrations`
- `document_chunks` and FTS5 virtual tables
- `message_sources`
- `model_profiles` containing non-secret configuration and a credential ref
- `workflow_runs` and `workflow_step_runs`
- `tabular_review_columns`
- `jobs`
- `workspace_settings`
- `legacy_import_records`

P0 does not create active sharing, organisation, OAuth, MCP, CourtListener, or
workflow-share tables unless a Mike foreign-key relationship requires a
read-only compatibility placeholder. No secret column is permitted in
`model_profiles` or `workspace_settings`.

### Deletion policy

- Project archive is the normal reversible action.
- Permanent Project deletion is explicit and transactional; child chats,
  reviews, folders, and document records cascade, while encrypted blobs are
  staged for deletion only after the database transaction commits.
- Document deletion removes versions, edits, chunks, FTS rows, and original
  blobs through the storage service; failures leave a retryable cleanup job.
- Chat deletion cascades messages and sources.
- Completed runs/results are not silently overwritten by retry.

## 8. Data migration and legacy compatibility

1. Take and verify a normal encrypted workspace backup before the first
   Workspace migration.
2. Run additive SQLCipher migrations inside transactions and record each
   version/checksum in `workspace_schema_migrations`.
3. Do not rename, delete, or rewrite current `aletheia_*` tables.
4. Do not move existing encrypted document files during schema creation.
5. New Mike/Vera features write only to the new Workspace tables and new
   document directory layout.
6. Legacy matters remain reachable only through hidden compatibility routes
   during regression testing.
7. A later Legacy Import surface may read a matter and copy selected documents
   into a new Project. Import is explicit, idempotent, records source IDs, and
   never mutates the old matter.
8. On migration/integrity failure, do not start the new Workspace APIs and do
   not fall back to an empty database.

Recommended new-file layout:

```text
<app-data>/
  database/
  documents/<document-id>/
    versions/<version-id>/original
    extracted.json
    preview/
  exports/
  cache/
  logs/
  backups/
```

Paths are generated by the backend. API responses expose opaque IDs and
authenticated download/preview endpoints, never absolute paths.

## 9. Active UI routes

### Canonical P0 routes

```text
/assistant
/assistant/chat/[id]
/projects
/projects/[id]
/projects/[id]/assistant
/projects/[id]/assistant/chat/[chatId]
/projects/[id]/workflows
/projects/[id]/tabular-reviews
/projects/[id]/tabular-reviews/[reviewId]
/tabular-review
/tabular-review/[reviewId]
/workflows
/workflows/[workflowId]
/settings
/settings/models
/settings/data
```

Mike `/account` product preferences are reorganised under `/settings`. Login,
signup, MFA, people/share, connector, and legal-research pages are not migrated
into P0. The source default route changed from `/aletheia/matters` to
`/assistant`; the completed fresh package verified that route and its runtime.

Old `/aletheia/*` routes remain compiled for regression and legacy data access,
but disappear from Vera's main navigation and are not used by new product
pages. Route switching is kept reversible until packaged E2E passes.

## 10. Local API migration

The local API is canonical under `/api/v1`. Route module/product behaviour
tracks Mike, while cloud persistence calls are replaced by services.

```text
/api/v1/projects
/api/v1/projects/:projectId/documents
/api/v1/chat
/api/v1/projects/:projectId/chats
/api/v1/assistant/jobs
/api/v1/model-profiles
/api/v1/workflows
/api/v1/workflow-runs
/api/v1/tabular-review
/api/v1/settings
```

The singular global UI/API route `/tabular-review` and the unified local
`/workflows/[workflowId]` page are deliberate Vera route adaptations. Mike's
Project-scoped `/projects/[id]/tabular-reviews/*` structure is retained. These
differences remove cloud-only route dispatch without changing the review or
workflow wire semantics and are recorded in the port manifest.

Mike-specific subresources for document versions/edits, project chat,
generation, cell retry, and capability-gated review chat remain part of those
resource trees. Review-chat endpoints fail closed while the advertised P0
capability is `false`.
All routes use server-generated IDs, schema validation, pagination, a common
error envelope, service/repository boundaries, local bearer auth, and path-free
file responses. Streaming uses SSE with a persisted job/message lifecycle.

## 11. Implementation phases

### Phase 0 - audit and safety baseline

Deliverables:

- complete and validate the existing legal-research work;
- pin Mike upstream and record the port matrix;
- fix the confirmed Keychain overwrite risk;
- this migration document;
- recorded baseline builds/tests and known failures.

Completion record (2026-07-15): Mike is pinned to the exact SHA above; the
repository has no nested Mike application or merge-base assumption; the
pre-existing legal-research work is separated from the port; Keychain
provisioning is fail-closed and cannot overwrite an unreadable existing item;
the source/build baseline and rollback rules are recorded.

### Phase 1 - Workspace data and API foundation

Completion record and principal code areas:

```text
backend/src/lib/workspace/types.ts
backend/src/lib/workspace/migrations/*
backend/src/lib/workspace/database.ts
backend/src/lib/workspace/repositories/*
backend/src/lib/workspace/services/*
backend/src/lib/workspace/blobStore.ts
backend/src/lib/workspace/jobs/*
backend/src/lib/workspace/providers/*
backend/src/routes/workspaceV1.ts
backend/src/routes/workspaceChatsV1.ts
backend/src/routes/workspaceSettingsV1.ts
backend/src/routes/workspaceWorkflowsV1.ts
backend/src/routes/workspaceTabularV1.ts
backend/src/veraApplication.ts
backend/src/index.ts
backend/package.json
```

Completed responsibilities:

1. additive migration registry through v10, including durable Assistant events;
2. local identity/principal and `/api/v1` auth boundary;
3. repository interfaces and SQLCipher implementations;
4. encrypted hierarchical blob store;
5. document ingestion/chunk/FTS job;
6. Project, Document/Version, Chat/Message, Workflow, Tabular, and Job APIs;
7. restart recovery (`running` to `interrupted`);
8. backend contract, migration, path, persistence, and legacy-preservation tests.

The production composition uses one `WorkspaceRuntime`, one Workspace database,
one encrypted blob store, and one shared job pump. It does not introduce a
second backend, database, scheduler, or fixture fallback.

### Phase 2 - Mike shell, Projects, and documents

- restore Mike shell/components into the active frontend;
- Vera branding and central `zh-CN` messages;
- restore canonical routes and Project tabs;
- connect Project/folder/document/version/upload/preview UI to real local APIs;
- retain explicit empty/error/retry states; no production fixtures;
- hide Legacy Vera navigation without deleting it.

Completion record (2026-07-15):

- the Vera shell, PageHeader, Project overview, Project workspace, document
  table/explorer, side panel, preview surfaces, and responsive structure are
  locked to the pinned Mike source with audited local-only adaptations;
- Project/folder/document/version create, update, archive/delete, upload,
  authenticated preview/download, parse retry, and status refresh use the real
  `/api/v1` Workspace composition root;
- parse polling is serial, mutation-aware, abortable, bounded on failure, and
  stops at terminal state rather than overwriting concurrent document actions;
- upload selection and drag/drop share the backend-supported
  PDF/DOCX/XLSX/TXT/MD contract and localized fail-closed errors;
- the web shell and macOS native menu no longer expose Legacy Vera product
  routes; the Phase 2 compatibility audits observed the then-current real
  `/projects` landing page while retaining legacy-data assertions;
- after the durable Assistant vertical was mounted, the root redirect and
  Electron startup path changed to `/assistant`; `/projects` remains directly
  reachable from the five-item navigation.

Executed acceptance evidence:

```text
frontend Mike Shell/i18n source suite: 13 passed
frontend Mike Projects + polling source/behavior suite: 22 passed
frontend upload/transport suite: 12 passed
frontend TypeScript, ESLint, diff check, production build: passed
backend Workspace Application/API/Runtime audits and production build: passed
desktop product rename, menu/landing source, legacy migration, syntax: passed
```

The pre-existing packaged `.app` was not counted as Phase 2 evidence: it still
contained the prior `/aletheia/matters` landing bundle and was deliberately
rejected by the updated packaged audits. The later fresh package and full
packaged bridge E2E passed as the Phase 7 acceptance evidence below.

### Phase 3 - model gateway and Settings

- restore Mike model selection/provider semantics;
- implement OpenAI, DeepSeek, Anthropic, Gemini, and OpenAI-compatible adapters;
- implement Keychain-only provider credentials and real connection tests;
- keep only non-secret model profile data in SQLCipher;
- add cancellation, usage, structured errors, and contract tests;
- expose local data, model, backup, and diagnostics settings under `/settings`.

Completion record (2026-07-15): official OpenAI, DeepSeek, Anthropic, and
Gemini adapters and the hardened OpenAI-compatible transport share one provider
registry; non-secret profile configuration is stored in SQLCipher; secrets are
origin/profile-bound Keychain items handled by an isolated utility process;
connection-test revisions gate enable/default actions; Settings exposes Models
and Local Data, encrypted backup inspection/restore, service restart, log/data
actions, and a redacted diagnostic export. Rotated model-call diagnostics are
enabled in the packaged backend without logging prompts, document text, or
credentials.

### Phase 4 - Assistant

- restore Mike global and project Assistant UI;
- persist conversations/messages before generation;
- streaming, stop, retry, regenerate, and interrupted recovery;
- project document selection, FTS retrieval, context budgets, and citations;
- local preview deep links and model/provider status;
- no hidden fallback response and no simulated generation.

Completion record (2026-07-15): global and Project-scoped Mike-derived pages
use the durable local chat/message/job APIs. The runtime persists the user and
output message before provider execution, streams validated SSE events, supports
stop/retry/regenerate and replay after refresh, converts an interrupted lease to
an observable recoverable state, retrieves only ready Project documents under
bounded context/tool limits, and persists exact citations. Provider errors are
structured and visible; there is no production mock or canned-answer fallback.

### Phase 5 - Workflows

- restore Mike workflow list/detail/editor semantics;
- bounded local execution, step/call caps, cancellation, history, and resume;
- no shell, Python, arbitrary network, dynamic tools, or multi-agent loops;
- persist step input/output/error through the job runtime.

Completion record (2026-07-15): the Mike-derived list, template, editor, prompt
editor, Project entry, and run panel use real local APIs. Assistant definitions
have stable step IDs and strict document-retrieval, prompt, and output schemas.
Runs snapshot the workflow, Project, model revision, limits, and input; each step
persists its input/output/error; execution is bounded by step/model-call/context
limits and supports cancellation, retry lineage, history, and restart
reconciliation. Tabular workflow templates deliberately hand off to the shared
Tabular Review runtime instead of duplicating a second cell executor.

### Phase 6 - Tabular Review

- restore multi-document/multi-column Mike review UI;
- cell-level idempotent jobs, conservative concurrency, cancellation, retry;
- text/boolean/enum/number outputs and source references;
- capability-gate review chat and leave it disabled unless a complete local
  runtime is implemented;
- CSV/XLSX export and pagination/virtualisation.

Completion record (2026-07-15): global and Project-scoped Mike-derived pages
support review CRUD, document and column configuration, a paged matrix, bounded
generation, per-cell cancellation/retry/clear, exact source quotes, and CSV/XLSX
export. Each document-column pair owns an idempotent durable `tabular_cell` job;
authoritative extracted text and version/hash checks prevent stale or tampered
input; restart reconciliation and the shared job pump preserve terminal results.
Review chat remains capability-disabled because no complete local runtime is
claimed for it in P0.

### Phase 7 - packaged desktop acceptance and convergence

- verify the packaged default route already set to `/assistant` in source;
- complete Chinese UI and Vera branding audit;
- backup/restore and legacy migration compatibility;
- renderer/security/env/package hygiene audits;
- packaged restart persistence E2E;
- DMG/ZIP/SHA-256 output and signing/notarization truthfulness;
- remove only first-layer dead navigation after reference and package checks.

Current record (2026-07-15): the source switches the desktop and root route to
`/assistant`, packages the credential worker/diagnostics/logger, enforces the
renderer and environment boundary, produces Vera-named artifacts, and includes
`packagedWorkspaceE2E.js` in `package-desktop-mac.sh`. That E2E is designed to
exercise a Project, two parsed TXT documents, Assistant tool retrieval and two
citations, a two-step Workflow, a 2x2 Tabular Review with CSV/XLSX export, a
clean close, and a second offline launch over the same encrypted workspace.

**Phase 7 completed on 2026-07-15 when one fresh package from this source
completed the entire script with exit code `0`.** The accepted app is
`desktop/dist/mac-arm64/Vera.app`; older app bundles remain excluded from
evidence. The accepted artifacts correctly report
`signed=false notarized=false distribution=local-only`.

## 12. Acceptance commands

Only commands that exist in the current tree are listed here. A source-level
pass is necessary but cannot replace Phase 7 packaged evidence; the final
package command below has now supplied that evidence.

### Phase 0

```bash
git diff --check
npm run build --prefix backend
npm run test:vera:legal-research-broker --prefix backend
npm run test:vera:legal-opinion --prefix backend
npm run test:keychain-provisioning --prefix desktop
git diff --check
```

### Phase 1

```bash
npm run build --prefix backend
npm run test:workspace:migrations --prefix backend
(
  cd backend
  npx tsx src/scripts/veraWorkspaceCoreRepositoriesAudit.ts
  npx tsx src/scripts/veraWorkspaceRuntimeAudit.ts
  npx tsx src/scripts/veraWorkspaceApplicationAudit.ts
  npx tsx src/scripts/veraWorkspaceAuthAudit.ts
  npx tsx src/scripts/veraWorkspaceContractAudit.ts
)
```

### Phase 2

```bash
npm run lint --prefix frontend
npm run build --prefix frontend
npm run test:i18n --prefix frontend
(
  cd frontend
  npx playwright test --config=tests/vera-shell-source.config.ts
  npx playwright test --config=tests/vera-project-source.config.ts
)
npm run test:product-rename --prefix desktop
```

### Phase 3

```bash
npm run test:workspace:credential-worker-client --prefix backend
npm run test:workspace:async-credential-service --prefix backend
npm run test:workspace:model-connection-readiness --prefix backend
npm run test:workspace:model-settings-runtime --prefix backend
npm run test:workspace:generic-transport --prefix backend
npm run test:workspace:model-call-diagnostics --prefix backend
npm run test:keychain-credential-store --prefix desktop
npm run test:credential-worker --prefix desktop
npm run test:credential-bridge --prefix desktop
npm run test:diagnostic-bundle --prefix desktop
npm run test:desktop-logger --prefix desktop
```

### Phase 4

```bash
npm run test:workspace:assistant --prefix backend
npm run test:workspace:assistant-durable --prefix backend
npm run test:workspace:assistant-execution --prefix backend
npm run test:assistant --prefix frontend
```

### Phase 5

```bash
npm run test:workspace:workflow-runtime --prefix backend
npm run test:workspace:workflow-execution --prefix backend
npm run test:workflows --prefix frontend
```

### Phase 6

```bash
npm run test:workspace:tabular-execution --prefix backend
npm run test:tabular --prefix frontend
```

### Phase 7

```bash
./scripts/package-desktop-mac.sh
```

That entry point creates the fresh artifact and invokes the runtime-security,
SQLCipher, legacy-migration, package-hygiene, packaged-app,
`test:packaged-workspace-e2e`, packaged-backup, and
packaged-restore-fail-closed gates in the required order. Running an individual
packaged command against the stale existing `desktop/dist/` is not acceptance.

The final packaged E2E must create a Project, upload and parse at least two
documents, persist an Assistant stream and exact citations, run a two-step
Workflow, run and export a two-document by two-column Tabular Review, close the
app, reopen it with the same encrypted data and keys, and verify every object
and result. Record the fresh artifact path, checksum manifest, command result,
and screenshot evidence only after the run passes.

## 13. Risks and rollback

| Risk | Control | Rollback |
|---|---|---|
| Existing dirty work overwritten | separate file ownership and checkpoint before migration | stop migration; preserve current working tree |
| No Mike merge base | pinned upstream SHA and explicit port matrix | discard only the isolated port commit, never reset user work |
| SQLCipher migration failure | additive transactions, backup, integrity checks | keep old tables and block new Workspace APIs |
| Keychain key overwritten | fail-closed provisioning test gate | do not launch or migrate until operator resolves Keychain access |
| Model key leakage | Keychain-only secret, status projection, log/bundle scans | disable provider and delete credential reference |
| File/database divergence | authoritative blob service, atomic writes, cleanup jobs | retain orphan quarantine and retry; never silently delete original |
| Mike UI restored over fake backend | route-level integration tests and no fixtures in production | keep new navigation disabled and Legacy route available |
| Large repository refactor breaks package | incremental route slices and package-hygiene gate | revert the current phase only; prior schema remains additive |
| Backup cannot move Keychain secrets | document separate key escrow/re-entry; provider keys excluded from backup | restore workspace keys separately and require provider re-entry |
| Unsigned artifact presented as release | existing signing preflight and manifest wording | local-only package; no public distribution claim |
| Stale `desktop/dist` artifact mistaken for Phase 7 | require a fresh build timestamp, packaged E2E result, and checksum manifest tied to current source | delete/rebuild only generated artifacts; never cite the older app |
| Packaged test leaves a model credential | use an isolated profile and guaranteed Keychain cleanup on success/failure | fail the gate, remove the exact test item, and do not publish its evidence |
| Vera route adaptation drifts from Mike links | record `/tabular-review` and unified Workflow detail routing in the port manifest and cover navigation/deep links | add compatibility redirect or revert only the route adapter, not persistence |

## 14. Phase 0 baseline record

The baseline table is updated only with commands actually executed in this
working tree.

| Command | Result | Evidence/notes |
|---|---|---|
| `npm run build --prefix backend` | passed | Phase 0 existing-work validation |
| `npm run test:vera:legal-research-broker --prefix backend` | passed | real repository/broker route audit |
| `npm run test:vera:legal-opinion --prefix backend` | passed | rerun after exact review-resolution binding and export-integrity hardening |
| `npm run lint --prefix frontend` | passed | full frontend lint |
| `npm run build --prefix frontend` | passed | production Next.js build |
| focused Playwright legal-research test | passed, 2 tests | desktop and mobile legal-research/DOCX flow |
| `npm run test:keychain-provisioning --prefix desktop` | passed | missing/create, reuse, denial, timeout, invalid value, command error, and verify-failure branches; no real Keychain access |

Phase 0 acceptance is complete. The Keychain overwrite fix is recorded in
`79c184f`; this historical checkpoint authorised Phase 1. The completion
records above supersede its then-future wording.

## 15. Completed integration and packaged acceptance evidence

During the 2026-07-15 integration, the backend production build and focused
model Settings, diagnostics, Assistant execution, Workflow execution, and
Tabular execution audits passed. Frontend lint/build and the focused Assistant,
Workflow, and Tabular contract/source suites passed after their respective
integration updates. Desktop product-name, credential-worker/bridge,
runtime-security, diagnostic-bundle, and logger audits also passed.

Those commands are the source-level evidence for the integrated slices. The
packaging entry point reran the relevant build and source guards against the
final shared tree, so intermediate counts were not substituted for its log.
One full `./scripts/package-desktop-mac.sh` invocation then exited `0`, including
the packaged Workspace E2E, backup bridge, and restore fail-closed gates.
The final security rerun exercised the real packaged executable: application
encryption `disabled` and database encryption `metadata_plaintext` each failed
with exit code `1` before either local service bound its port. For invalid
pending-restore states, the isolated working desktop log recorded
`startup_failed` and did not record `renderer_window_creating`; the backend and
frontend remained offline and the pending record remained available for safe
recovery.

Accepted artifact paths:

```text
relative app:      desktop/dist/mac-arm64/Vera.app
absolute app:      /Users/a1-6/Documents/new agent/desktop/dist/mac-arm64/Vera.app
relative DMG:      desktop/dist/Vera-1.0.1-arm64.dmg
absolute DMG:      /Users/a1-6/Documents/new agent/desktop/dist/Vera-1.0.1-arm64.dmg
relative ZIP:      desktop/dist/Vera-1.0.1-arm64.zip
absolute ZIP:      /Users/a1-6/Documents/new agent/desktop/dist/Vera-1.0.1-arm64.zip
relative manifest: desktop/dist/Vera-1.0.1-SHA256SUMS.txt
absolute manifest: /Users/a1-6/Documents/new agent/desktop/dist/Vera-1.0.1-SHA256SUMS.txt
```

Verified manifest content:

```text
69a2ee56379a7cf6cb7fe441685fb59c846e77512928704955e774f3d8d42dd7  Vera-1.0.1-arm64.dmg
47fcd64f214bf9b28e6982953043c76dba68ff0f2a933107ff6ec07eb704e648  Vera-1.0.1-arm64.zip
```

Final P0 status:

```text
Phases 0-7 complete
fresh packaged verification passed
signed=false
notarized=false
distribution=local-only
```
