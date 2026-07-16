# Architecture

## Current P0 Workspace architecture

The primary Vera product is a single-user macOS desktop client built from the
Mike product/UI framework at the pinned commit
`e32daad5a4c64a5561e04c53ee12411e3c5e7238`. Mike defines the user-facing
Assistant, Projects, Workflows, and Tabular Review semantics. Vera owns the
local desktop, persistence, credential, recovery, and security boundaries.
Mike UI use is authorised; the port retains its pinned provenance,
attribution, and `AGPL-3.0-only` licence obligations.

Assistant, Projects, Workflows, and Tabular Review are the four core product
workspaces. Settings is the fifth first-level surface and acts as the local
desktop control plane.

```text
Vera.app (Electron main process)
  |- sandboxed Next.js renderer on 127.0.0.1
  |    |- Assistant
  |    |- Projects (generic local containers)
  |    |- Tabular Review
  |    |- Workflows
  |    `- Settings
  |- Express composition root on 127.0.0.1
  |    |- /api/v1 Workspace auth + strict wire adapters
  |    |- repositories/services over one Workspace database
  |    `- one shared durable job pump
  |         |- document_parse
  |         |- assistant_generate
  |         |- workflow_run
  |         `- tabular_cell
  |- isolated credential-worker utility process
  |    `- private MessagePort -> macOS Keychain
  `- controlled native backup/restore/log/diagnostic operations

Local persistence
  |- SQLCipher Workspace metadata (migrations v1-v16)
  |- AES-256-GCM encrypted originals, extracted content, and exports
  |- FTS5 project/document retrieval
  |- authenticated encrypted backups and restore journal
  `- owner-only rotated/redacted desktop and model-call logs
```

There is one frontend, one backend composition root, one Workspace database,
and one shared `WorkspaceJobPump`. Assistant, Workflow, Tabular, and parser work
use different typed handlers and durable records but do not create parallel
servers, databases, queues, or hidden fallback runtimes. The pump uses bounded
concurrency, leases/fences, cancellation, restart reconciliation, and terminal
state persistence.

`Project` is the general-purpose ownership and context boundary. A Project can
own folders, documents and versions, chats/messages, and Tabular Reviews/cells,
and it scopes runs of reusable global workflow definitions. An optional,
one-to-one `MatterProfile` adds legal intake semantics without renaming or
splitting that boundary. Project ownership checks are enforced in the
repository/service layer; UI tabs do not create separate storage silos.

The canonical new product API is mounted once at `/api/v1` by
`backend/src/veraApplication.ts`:

- `projects`, folders, documents, versions, parsing, preview/download
  capabilities;
- chats, messages, durable Assistant jobs/events and generation controls;
- model settings/profiles, Keychain credential mutation, connection tests,
  enable/default actions;
- workflows, strict Assistant definitions, workflow runs/steps, cancel/retry;
- Tabular Reviews, documents/columns/cells, generation, cancel/retry/clear, and
  CSV/XLSX export.

The renderer resolves the Workspace base URL and a per-launch random bearer
token from the trusted preload bridge. The backend binds only to `127.0.0.1`
and authenticates a fixed local principal. The token is not persisted or
embedded in the Next.js build. The Electron renderer is sandboxed and isolated;
navigation, new windows, browser permissions, CSP connections, and native IPC
are explicitly constrained.

Model-provider secrets do not enter normal database rows. The renderer can
submit a replacement secret but cannot read one back. The backend sends
credential operations across a private MessagePort to an isolated utility
process, which binds each item to the model profile, provider, and canonical
origin in the macOS Keychain. Provider adapters perform the only credential
resolution and external network calls.

Legacy `/aletheia/*` source and resources remain available for controlled
compatibility and regression, but the routes and background runtime are both
off by default. Only exact, explicit feature flags mount or start them; they do
not replace the Workspace `/api/v1` product path.

## Packaged P0 acceptance

The architecture was verified end to end on 2026-07-15 by one fresh
`./scripts/package-desktop-mac.sh` run that exited `0`. Package hygiene,
SQLCipher, legacy migration, packaged startup and port release, the Workspace
cross-restart E2E, backup bridge, and restore fail-closed gates passed. The E2E
exercised the shared persistent architecture with a generic Project, two parsed
documents, Assistant citations, a Workflow, a 2×2 Tabular Review, and a second
launch over the same encrypted workspace.

The final packaged security rerun exercised the actual executable. A launch
with application encryption `disabled` and a separate launch with database
encryption `metadata_plaintext` each exited `1` before either local service
bound its port. For invalid pending-restore states, the working desktop log
contained `startup_failed` but no `renderer_window_creating` event; therefore
the renderer boundary was never crossed before recovery validation failed.

```text
relative app:      desktop/dist/mac-arm64/Vera.app
relative DMG:      desktop/dist/Vera-1.0.1-arm64.dmg (198122845 bytes)
relative ZIP:      desktop/dist/Vera-1.0.1-arm64.zip (200992113 bytes)
relative manifest: desktop/dist/Vera-1.0.1-SHA256SUMS.txt
```

```text
fd246214916b3485e25bb16c8e00bcf6e8be471ed95679190e7685a5c1c49ef8  Vera-1.0.1-arm64.dmg
7be4a9504151ddd8518141901e3d2753a1cda2fbe13ac27fa7842a9f3d347f1b  Vera-1.0.1-arm64.zip
```

This proves the local packaged-client boundary described above. It does not
change the release boundary: `signed=false`, `notarized=false`, and
`distribution=local-only`.

## Legacy civil-litigation architecture

The following architecture describes the earlier Aletheia/Vera litigation
domain. It is retained as historical and compatibility documentation; its
“active domain” language is not the current P0 desktop product boundary.

Vera is a local-first civil-litigation workspace. Architecturally, a reusable
Kernel provides document, model, storage, permission, review, and audit
foundations, while V1 exposes only the Civil Litigation domain.

```text
+--------------------------------------------------------------+
| Active Domain: Civil Litigation                              |
| Intake | Evidence | Claims | Research | Procedure | Drafting |
+-----------------------------+--------------------------------+
| Aletheia Kernel                                             |
| Local Vault | Agent Loop | Typed Artifacts | Review Gates     |
+-----------------------------+--------------------------------+
| Kernel Internals                                             |
| documents | indexes | permissions | audit | eval | skills     |
+--------------------------------------------------------------+
| Base Application Layer                                       |
| auth | projects | storage | LLM providers | API routes       |
+--------------------------------------------------------------+
```

## Layers

### Base Application Layer

Provides authentication, project containers, document storage, model provider adapters, and existing API structure.

### Aletheia Kernel

Adds the reusable local-first harness:

- Local Vault;
- Agent Loop Runtime;
- Typed Artifact Graph;
- Permission + Tool Policy;
- Review + Gate Console;
- Audit Trace;
- Eval Replay;
- Human-approved Skills.

The Matter Queue, Template Registry, Evidence Registry, Human Review Queue,
Audit Timeline, and matter-level workspace are current UI surfaces for the
Kernel.

### Active Domain

V1 configures the Kernel only for Civil Litigation. Earlier contract,
compliance, diligence, and generic workspace implementations are compatibility
code, not active product surfaces.

### Agent Loop Runtime

MVP functions are deterministic:

```text
generateAgentPlan(matter, documents)
generateIssueMap(matter, documents)
generateEvidenceMatrix(matter, documents, issues)
generateDraftMemo(matter, issues, evidence)
runReviewer(memo, evidence)
createAuditEvent(...)
```

The current demo is a persisted `civil_litigation` matter created by the local
backend. Frontend fallback matters are not used in the installed product.

The backend now has an agent runtime skeleton:

```text
Agent Run
-> Agent Steps
-> Tool Calls
-> Human Checkpoints
-> Work Products
-> Audit Events
```

This follows the Hermes-style runtime idea without coupling Aletheia to any
specific runtime implementation. The runtime records are meant to capture plan
state, tool inputs and outputs, required human approvals, validation errors, and
final structured artifacts.

### API Boundary

The first API surface is mounted under `/aletheia`:

```text
GET  /aletheia/matters
POST /aletheia/matters
GET  /aletheia/matters/:matterId
POST /aletheia/matters/:matterId/work-products
POST /aletheia/matters/:matterId/reviews
POST /aletheia/matters/:matterId/audit-events
POST /aletheia/matters/:matterId/memory
POST /aletheia/matters/:matterId/playbooks
POST /aletheia/matters/:matterId/playbooks/:playbookId/approve
POST /aletheia/matters/:matterId/agent-runs
GET  /aletheia/tool-adapter/tools
POST /aletheia/tool-adapter/tools/:toolName/call
```

The frontend client lives in `frontend/src/app/lib/aletheiaApi.ts`. The demo
matter remains deterministic, while newly created matters use the API-backed
route and database schema.

`/aletheia` redirects to an API-backed matter queue. The queue shows only
`civil_litigation` records and explicitly reports backend unavailability;
non-litigation and fallback matters are not merged into the active product.

`POST /aletheia/matters/:matterId/work-products` is the persistence boundary for
structured artifacts. It accepts agent plans, issue maps, evidence matrices,
draft memos, audit packs, and feedback exports, then records a matching audit
event. This keeps generation, human review, and export history replayable from
the database.

Matter creation also writes a deterministic `agent_plan` work product and an
`agent_plan_generated` audit event. This gives every persisted matter an initial
reviewable scaffold before retrieval, parsing, and model orchestration are
connected.

### Storage Boundary

The Aletheia backend route talks to a repository contract backed by the local
repository only:

```text
Aletheia Route
-> AletheiaRepository
-> LocalAletheiaRepository
```

The repository persists to:

```text
.data/aletheia/aletheia.db
.data/aletheia/documents/
.data/aletheia/exports/
.data/aletheia/index/
```

The local repository supports Aletheia routes in single-user local mode with
SQLite persistence, filesystem document storage, parsed source chunks, FTS5
search, matter-scoped memory, draft/approved playbooks, agent run traces, and
approval-gated high-risk exports.

### Review, Gates, Audit, Eval, And Skills

Every meaningful event should become an audit event:

- matter created;
- document uploaded;
- agent plan generated;
- evidence mapped;
- memo generated;
- review added;
- audit pack exported;
- feedback dataset exported.

### Database Schema

```text
aletheia_matters
aletheia_matter_documents
aletheia_work_products
aletheia_evidence_items
aletheia_review_items
aletheia_audit_events
aletheia_agent_runs
aletheia_agent_steps
aletheia_tool_calls
aletheia_human_checkpoints
aletheia_matter_memory_items
aletheia_playbooks
```

`aletheia_work_products` stores structured JSON payloads for the agent plan,
chronology, issue map, evidence matrix, draft memo, compliance register, red flag
memo, audit pack, and feedback export. `aletheia_evidence_items`,
`aletheia_review_items`, and `aletheia_audit_events` keep source grounding,
expert judgment, and provenance separate so each workflow can be reviewed and
replayed.

`aletheia_agent_runs`, `aletheia_agent_steps`, `aletheia_tool_calls`, and
`aletheia_human_checkpoints` capture workflow execution state. They are the
database shape for plan-before-answer runs, tool registry calls, and human
approval gates.

`aletheia_matter_memory_items` and `aletheia_playbooks` capture matter-scoped
procedural and factual context. They are deliberately attached to a matter so
sensitive professional context does not leak across unrelated work.
