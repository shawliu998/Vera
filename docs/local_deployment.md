# Local Deployment

Aletheia can run in a local-first mode for private professional workflows. In
this mode, Aletheia routes do not require Supabase auth and Aletheia data is
stored under a local data directory.

For packaging and single-tenant notes, see `docs/private_deployment.md`.

## Environment

```bash
ALETHEIA_STORAGE_DRIVER=local
ALETHEIA_AUTH_MODE=single_user
ALETHEIA_DATA_DIR=.data/aletheia
ALETHEIA_LOCAL_USER_ID=local-user
ALETHEIA_LOCAL_USER_EMAIL=local@aletheia.internal
```

For a private single-tenant local deployment that should require a bearer token
on Aletheia routes, use:

```bash
ALETHEIA_AUTH_MODE=private_token
ALETHEIA_PRIVATE_AUTH_TOKEN=replace-with-a-random-local-private-token
NEXT_PUBLIC_ALETHEIA_PRIVATE_AUTH_TOKEN=replace-with-the-same-token-for-local-browser-only
```

`NEXT_PUBLIC_ALETHEIA_PRIVATE_AUTH_TOKEN` is visible to browser clients. Use it
only for local workstation or trusted private-network deployments; for broader
server deployments, prefer a reverse proxy or server-side session layer that
injects the backend bearer token.

The backend also accepts these aliases:

```bash
ALET_HEIA_STORAGE_MODE=local
ALET_HEIA_AUTH_MODE=single_user
ALET_HEIA_DATA_DIR=.data/aletheia
```

## Data Layout

```text
.data/aletheia/
  aletheia.db
  documents/
  exports/
  index/
```

- `aletheia.db` stores matters, work products, reviews, audit events, agent
  runs, steps, tool calls, and human checkpoints.
- `documents/` stores uploaded source files in local mode.
- `exports/` stores approval-gated audit packs, feedback datasets, and final
  memos as local JSON artifacts.
- `index/` is reserved for retrieval indexes beyond SQLite FTS5.

## Run

Before starting a private local pilot, run the runtime doctor:

```bash
cd backend
npm run check:aletheia:doctor
```

The doctor checks Node, `node:sqlite`, local storage/auth settings, writable
data directories, retrieval defaults, and semantic-index boundaries. It reports
cloud/external model keys as warnings so an operator can confirm whether any
fallbacks were intentionally enabled.

Before packaging or handing off a private workstation build, run the operational
readiness audit:

```bash
cd backend
npm run check:aletheia:ops-readiness
```

The audit verifies doctor coverage, the local launcher, `/health`, private-token
auth boundaries, package metadata, backup/restore/audit integrity, and runbook
coverage.

Before changing document parsing or evidence mapping, run the source provenance
audit:

```bash
cd backend
npm run check:aletheia:source-provenance
```

The audit verifies document IDs, source chunk IDs, quote offsets, support
status, SQLite FTS5 matter filters, source-linked work products, UI registry
fields, and exportable provenance.

One-command local launcher:

```bash
cd backend
npm run dev:aletheia:local
```

Manual backend:

```bash
cd backend
ALETHEIA_STORAGE_DRIVER=local \
ALETHEIA_AUTH_MODE=single_user \
ALETHEIA_DATA_DIR=.data/aletheia \
npm run dev
```

Manual frontend in another shell:

```bash
cd frontend
npm run dev
```

Open:

```text
http://localhost:3000/aletheia
```

## Local Privacy Mode

- Documents stay on local filesystem paths.
- SQLite stores structured metadata and audit records.
- Retrieval indexes stay under `.data/aletheia/index`.
- The frontend uses local system font stacks and does not require Google Fonts
  requests during production builds.
- External model and web calls should remain disabled by default.
- Cloud model fallback should require explicit user configuration.

## Current Limitations

- Local Aletheia CRUD is implemented for matters, work products, source-linked
  evidence items, reviews, audit events, and agent runs.
- Source document upload, parsing, chunking, and FTS5 keyword search are
  implemented for Aletheia routes.
- Search results can be mapped into `aletheia_evidence_items` with source chunk
  IDs, quote offsets, support status, relevance, and an audit event.
- Source-linked evidence items can be compiled into an `evidence_matrix` work
  product from the Aletheia API.
- Evidence matrices can be compiled into deterministic `draft_memo` work
  products for human review.
- Agent runs create local trace records for steps, least-privilege tool calls,
  and open human checkpoints.
- Audit Pack work products require an approved human checkpoint before they can
  be created.
- Feedback Export work products require the same approval gate before review
  tags or badcases become eval assets.
- Final Memo work products require the same explicit human approval gate.
- Matter Memory records are matter-scoped and audited; no global memory is
  injected across matters.
- Matter Playbooks are persisted as draft or approved workflow manuals, with
  approval recorded in the audit log.
- Audit Pack, Feedback Export, and Final Memo work products are persisted to
  `.data/aletheia/exports/<matterId>/` in local mode, with file paths recorded
  in audit event details.
- The broader inherited app still has Supabase-dependent routes. Local mode
  currently applies to Aletheia routes.
