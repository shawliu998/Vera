# Vera P0 Mike Desktop Migration

Date: 2026-07-14  
Status: Phase 0 complete; Phase 1 ready  
Product decision: **Mike is the product and workflow source of truth; Vera is the local desktop, storage, and security source of truth.**

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
- Tabular Review, cell generation, retry, citations, review chat, and export.
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

Existing litigation, audit, governance, and legal-research code remains stored
and testable as Legacy Vera functionality. It is not deleted in P0 and is not a
dependency of the new Mike product path.

## 3. Current architecture

```text
Electron main
  -> starts loopback Express backend and Next.js frontend
  -> provisions local bearer token
  -> provisions application and SQLCipher keys in macOS Keychain
  -> exposes controlled native operations through preload

Next.js renderer
  -> /aletheia/* litigation-first routes
  -> calls /aletheia/* backend routes

Express backend
  -> matter-centric routes and services
  -> LocalAletheiaRepository
  -> SQLite/SQLCipher + FTS5
  -> encrypted local document/export files

Local app-data directory
  -> metadata database
  -> documents / exports / indexes / backups / logs
```

Observed code facts:

- `backend/src/index.ts` mounts only `/aletheia` product routes plus `/health`.
- auth middleware rejects unexpected non-Aletheia API paths.
- the Electron default workspace is `/aletheia/matters`.
- Mike's Assistant, Projects, Workflows, Tabular Review, Account, and Auth
  product routes are no longer present in the active frontend tree.
- the current primary repository interface is matter-centric and the local
  repository combines schema, storage, search, litigation, audit, and runtime
  responsibilities in one large module.

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

### Reuse after abstraction

- Split database access into migration, repository, service, and route layers.
- Split authoritative file paths and encrypted blob access into a
  `WorkspaceBlobStore` interface.
- Split local identity/token parsing into an `AuthProvider` and a single local
  `PrincipalContext`.
- Reuse parsing and FTS through document services rather than calling the
  matter repository from new routes.
- Reuse local-model scheduling only as one model adapter; it cannot replace
  Mike Assistant or the required external providers.
- Generalise the backend's existing macOS Keychain reader pattern into a
  model-provider `CredentialStore`.

### Freeze outside the primary product path

- all current matter/litigation tables and routes;
- litigation work products, issue trees, evidence graph, procedure, approval,
  audit, AgentOps, Eval, skills, and domain packs;
- current legal-source credential flow and external-source approval workflow;
- semantic JSON indexes until their files have the same encryption guarantees
  as SQLCipher/FTS;
- browser/Docker deployment paths as non-desktop developer compatibility only.

### Missing and required

- Mike product routes, pages, components, hooks, and contexts;
- additive, versioned Workspace migrations;
- repositories and services for Projects, Documents/Versions, Chats,
  Workflows, Tabular Reviews, and Jobs;
- model profiles and a Keychain-only model-provider secret store;
- streaming generation and cancellation connected to persisted messages/jobs;
- a resumable SQLite job runtime;
- Project/Assistant/Workflow/Tabular desktop E2E coverage;
- a central Chinese-first i18n layer;
- a Mike-upstream pin and future-drift audit process.

## 5. Confirmed Phase 0 security blocker

`desktop/main.js::ensureMacOsKeychainKey()` currently catches every
`find-generic-password` error and then calls `add-generic-password -U`. A
permission denial, timeout, malformed existing item, or other read failure can
therefore be treated as a missing item and overwrite an existing application
or database key. That can make encrypted workspace data unrecoverable.

The migration must not proceed until the function is fail closed:

- only the explicit macOS item-not-found status may create a key;
- access denial, timeout, invalid stored value, and command failure must stop
  startup;
- a valid existing key must never be updated;
- tests must not touch the user's real Keychain.

The current `aletheia_provider_secrets` path is for legacy legal-source
credentials, not the new model-provider system. It accepts a secret through a
renderer form and stores encrypted ciphertext in SQLite. That legacy path is
frozen. New model API keys must not copy it: model keys live only in Keychain,
the database stores only a credential reference/status, and no full key is
returned to the renderer or written to logs/backups. The exact native entry
mechanism will be fixed before Phase 3; the literal security target is that the
normal renderer never receives a stored full key.

## 6. Target architecture

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

There will be one frontend and one backend. A second nested `mike/` application
will not be added. Upstream product code is restored into the active
`frontend/` and `backend/` trees, with cloud calls replaced at repository,
storage, auth, and secret-store boundaries.

## 7. Target data model

The target preserves Mike's product semantics, adds the local operational
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

## 9. UI route migration

### Canonical P0 routes

```text
/assistant
/assistant/chat/[id]
/projects
/projects/[id]
/projects/[id]/assistant
/projects/[id]/assistant/chat/[chatId]
/projects/[id]/tabular-reviews
/projects/[id]/tabular-reviews/[reviewId]
/tabular-reviews
/tabular-reviews/[id]
/workflows
/workflows/assistant/[id]
/workflows/tabular-review/[id]
/settings
```

Mike `/account` product preferences are reorganised under `/settings`. Login,
signup, MFA, people/share, connector, and legal-research pages are not migrated
into P0. The desktop default route changes from `/aletheia/matters` to
`/assistant` only after Phase 2 acceptance passes.

Old `/aletheia/*` routes remain compiled for regression and legacy data access,
but disappear from Vera's main navigation and are not used by new product
pages. Route switching is kept reversible until packaged E2E passes.

## 10. Local API migration

The local API is canonical under `/api/v1`. Route module/product behaviour
tracks Mike, while cloud persistence calls are replaced by services.

```text
/api/v1/projects
/api/v1/documents
/api/v1/chats
/api/v1/messages
/api/v1/model-profiles
/api/v1/workflows
/api/v1/workflow-runs
/api/v1/tabular-reviews
/api/v1/jobs
/api/v1/settings
```

Mike-specific subresources for document versions/edits, project chat,
generation, cell retry, and review chat remain part of those resource trees.
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

### Phase 1 - Workspace data and API foundation

Planned code areas:

```text
backend/src/lib/workspace/types.ts
backend/src/lib/workspace/migrations/*
backend/src/lib/workspace/database.ts
backend/src/lib/workspace/repositories/*
backend/src/lib/workspace/services/*
backend/src/lib/workspace/blobStore.ts
backend/src/lib/workspace/jobs/*
backend/src/lib/modelGateway/*
backend/src/routes/projects.ts
backend/src/routes/documents.ts
backend/src/routes/chat.ts
backend/src/routes/workflows.ts
backend/src/routes/tabular.ts
backend/src/routes/jobs.ts
backend/src/index.ts
backend/package.json
```

Tasks:

1. migration registry and first additive schema;
2. local identity/principal and `/api/v1` auth boundary;
3. repository interfaces and SQLCipher implementations;
4. encrypted hierarchical blob store;
5. document ingestion/chunk/FTS job;
6. Project, Document/Version, Chat/Message, Workflow, Tabular, and Job APIs;
7. restart recovery (`running` to `interrupted`);
8. backend contract, migration, path, persistence, and legacy-preservation tests.

### Phase 2 - Mike shell, Projects, and documents

- restore Mike shell/components into the active frontend;
- Vera branding and central `zh-CN` messages;
- restore canonical routes and Project tabs;
- connect Project/folder/document/version/upload/preview UI to real local APIs;
- retain explicit empty/error/retry states; no production fixtures;
- hide Legacy Vera navigation without deleting it.

### Phase 3 - model gateway and Settings

- restore Mike model selection/provider semantics;
- implement OpenAI, DeepSeek, Anthropic, Gemini, and OpenAI-compatible adapters;
- implement Keychain-only provider credentials and real connection tests;
- keep only non-secret model profile data in SQLCipher;
- add cancellation, usage, structured errors, and contract tests;
- expose local data, model, backup, and diagnostics settings under `/settings`.

### Phase 4 - Assistant

- restore Mike global and project Assistant UI;
- persist conversations/messages before generation;
- streaming, stop, retry, regenerate, and interrupted recovery;
- project document selection, FTS retrieval, context budgets, and citations;
- local preview deep links and model/provider status;
- no hidden fallback response and no simulated generation.

### Phase 5 - Workflows

- restore Mike workflow list/detail/editor semantics;
- bounded local execution, step/call caps, cancellation, history, and resume;
- no shell, Python, arbitrary network, dynamic tools, or multi-agent loops;
- persist step input/output/error through the job runtime.

### Phase 6 - Tabular Review

- restore multi-document/multi-column Mike review UI;
- cell-level idempotent jobs, conservative concurrency, cancellation, retry;
- text/boolean/enum/number outputs and source references;
- review chat where required by Mike's product flow;
- CSV/XLSX export and pagination/virtualisation.

### Phase 7 - packaged desktop acceptance and convergence

- switch packaged default route to `/assistant`;
- complete Chinese UI and Vera branding audit;
- backup/restore and legacy migration compatibility;
- renderer/security/env/package hygiene audits;
- packaged restart persistence E2E;
- DMG/ZIP/SHA-256 output and signing/notarization truthfulness;
- remove only first-layer dead navigation after reference and package checks.

## 12. Acceptance commands

Phase-specific scripts will be added with their implementation. The minimum
acceptance gates are:

### Phase 0

```bash
git diff --check
npm run build --prefix backend
npm run test:vera:legal-research-broker --prefix backend
npm run test:vera:legal-opinion --prefix backend
npm run lint --prefix frontend
npm run build --prefix frontend
npm --prefix frontend run test:aletheia:ui -- tests/vera-legal-research.spec.ts
npm --prefix desktop run test:keychain-provisioning
```

### Phase 1

```bash
npm run build --prefix backend
npm run test:workspace:migrations --prefix backend
npm run test:workspace:repositories --prefix backend
npm run test:workspace:api --prefix backend
npm run test:workspace:jobs --prefix backend
npm run test:workspace:legacy-preservation --prefix backend
```

### Phase 2-6

```bash
npm run lint --prefix frontend
npm run build --prefix frontend
npm --prefix frontend run test:aletheia:ui -- tests/vera-shell.spec.ts
npm --prefix frontend run test:aletheia:ui -- tests/vera-projects.spec.ts
npm --prefix frontend run test:aletheia:ui -- tests/vera-assistant.spec.ts
npm --prefix frontend run test:aletheia:ui -- tests/vera-workflows.spec.ts
npm --prefix frontend run test:aletheia:ui -- tests/vera-tabular-review.spec.ts
```

### Phase 7

```bash
npm --prefix desktop run test:sqlcipher-runtime
npm --prefix desktop run test:legacy-migration
npm --prefix desktop run check:package-hygiene
npm --prefix desktop run test:packaged-app
npm --prefix desktop run test:packaged-backup
npm --prefix desktop run test:packaged-restore-fail-closed
./scripts/package-desktop-mac.sh
```

The final packaged E2E must create a Project, upload and parse at least two
documents, persist an Assistant stream, run a Workflow, run a two-document by
two-column Tabular Review, close the app, reopen it, and verify that every
object and result remains available.

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
`79c184f`; Phase 1 may start from these additive, independently reviewable
checkpoints.
