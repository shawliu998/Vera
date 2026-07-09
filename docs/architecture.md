# Architecture

Aletheia 明证 is an incremental workspace layer on top of the existing document, model, storage, and auth foundations.

```text
+--------------------------------------------------------------+
| Aletheia Workspace Layer                                    |
| Matter profile | Templates | Work products | Review states   |
+-----------------------------+--------------------------------+
| Agent Workflow Layer        | Trust & Governance Layer        |
| plan -> issues -> evidence  | audit log -> review -> eval     |
| -> memo -> feedback         | attribution -> retention        |
+-----------------------------+--------------------------------+
| Knowledge & Document Layer                                   |
| project documents | versions | parsed text | citations        |
+--------------------------------------------------------------+
| Base Application Layer                                       |
| auth | projects | storage | LLM providers | API routes       |
+--------------------------------------------------------------+
```

## Layers

### Base Application Layer

Provides authentication, project containers, document storage, model provider adapters, and existing API structure.

### Aletheia Workspace Layer

Adds matter-oriented surfaces:

- Matter Queue;
- Template Registry;
- Evidence Registry;
- Human Review Queue;
- Audit Timeline;
- Matter-level workspace with Agent Plan, Issue Map, Evidence Matrix, Draft Memo, Review, and Feedback Summary.

### Agent Workflow Layer

MVP functions are deterministic:

```text
generateAgentPlan(matter, documents)
generateIssueMap(matter, documents)
generateEvidenceMatrix(matter, documents, issues)
generateDraftMemo(matter, issues, evidence)
runReviewer(memo, evidence)
createAuditEvent(...)
```

The current demo uses seed data and validation helpers in `frontend/src/aletheia`.

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

`/aletheia` uses a hybrid queue: deterministic demo matters render immediately,
and API-backed matters are merged into the queue when `GET /aletheia/matters`
succeeds. This keeps local demos stable while making the persistence boundary
visible and testable.

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

The Aletheia backend route now talks to a repository contract instead of calling
Supabase directly:

```text
Aletheia Route
-> AletheiaRepository
-> SupabaseAletheiaRepository
-> LocalAletheiaRepository
```

The current default is Supabase/Postgres because it matches the base
application. The intended local-first deployment replaces that adapter with:

```text
.data/aletheia/aletheia.db
.data/aletheia/documents/
.data/aletheia/exports/
.data/aletheia/index/
```

The local adapter now supports Aletheia routes in single-user local mode with
SQLite persistence, filesystem document storage, parsed source chunks, FTS5
search, matter-scoped memory, draft/approved playbooks, agent run traces, and
approval-gated high-risk exports.

### Trust & Governance Layer

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
legal, compliance, and diligence context does not leak across unrelated work.
