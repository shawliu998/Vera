# Local-First Runtime Plan

Aletheia should run as a local-first, privately deployable, auditable agent
workspace. Supabase is the current compatibility adapter, not the product
boundary.

## Storage Target

```text
.data/aletheia/aletheia.db
.data/aletheia/documents/
.data/aletheia/exports/
.data/aletheia/index/
```

- SQLite stores matters, work products, reviews, audit events, agent runs, tool
  calls, and human checkpoints.
- Filesystem storage keeps source documents, rendered exports, parsed text, and
  retrieval indexes.
- A later private deployment can swap SQLite for Postgres and filesystem for
  MinIO/S3 without changing the Aletheia API.

## Runtime Model

```text
AgentRun
-> AgentStep
-> ToolCall
-> HumanCheckpoint
-> WorkProduct
-> AuditEvent
```

The runtime must not hide behind a final answer. It records plan state, source
evidence, tool I/O, validation errors, model profile, human approvals, and
structured artifacts.

## Current State

- `AletheiaRepository` now defines the backend persistence boundary.
- `SupabaseAletheiaRepository` is the default implementation.
- `LocalAletheiaRepository` is scaffolded and fails closed.
- `20260708_02_aletheia_agent_runtime.sql` adds runtime tables for private or
  Supabase-backed deployments.

## Next Implementation Step

Implement `LocalAletheiaRepository` with SQLite and filesystem paths, then add a
local auth context for single-user and private network deployments.
