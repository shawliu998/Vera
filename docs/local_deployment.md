# Local Deployment

Aletheia runs locally for private professional workflows. Its routes, SQLite
database, documents, exports, and indexes remain under a local data directory.

For packaging and single-tenant notes, see `docs/private_deployment.md`.

## Environment

```bash
ALETHEIA_AUTH_MODE=single_user
ALETHEIA_BACKEND_HOST=127.0.0.1
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
ALET_HEIA_AUTH_MODE=single_user
ALET_HEIA_DATA_DIR=.data/aletheia
```

## Data Layout

```text
.data/aletheia/
  .audit-hmac-key
  aletheia.db
  documents/
  exports/
  index/
```

- `aletheia.db` stores matters, work products, reviews, audit events, agent
  runs, steps, tool calls, human checkpoints, and purge tombstones.
- `.audit-hmac-key` is generated only when
  `ALETHEIA_AUDIT_HMAC_SECRET` is not configured and is needed to verify the
  local audit chains.
- `documents/` stores uploaded source files in local mode.
- `exports/` stores approval-gated audit packs, feedback datasets, and final
  memos as local JSON artifacts.
- `index/` is reserved for retrieval indexes beyond SQLite FTS5.

## Run

Docker compliance deployment:

```bash
cp .env.example .env
${EDITOR:-vi} .env
docker compose config
docker compose up --build
```

This is deliberately not a one-command quick start. The default Compose preset
is `compliance`, and it refuses startup until application encryption, SQLCipher,
an operator-attested encrypted data volume, a live high-assurance audit anchor,
and a local ClamAV scanner are configured. Provision the four owner-controlled
host directories and keys described in [compliance deployment](compliance_deployment.md)
before setting the encrypted-volume attestation to true. Desktop and direct
backend development remain `standard` by default; they do not inherit Docker's
compliance preset.

Compose publishes the frontend and backend on `127.0.0.1` only. The backend
uses `0.0.0.0` inside its container solely for container-to-container traffic;
that does not make the published host port LAN-accessible. Review auth, TLS,
proxy rules, and network policy before intentionally changing either published
binding.

Open:

```text
http://localhost:3000/aletheia
```

See [compliance deployment](compliance_deployment.md) for Docker custody layout
and health checks.

Before packaging or handing off a private local pilot, run the full private
preflight:

```bash
cd backend
npm run check:aletheia:preflight
```

Set `ALETHEIA_PREFLIGHT_INCLUDE_UI=true` when the operator also wants the
Playwright UI smoke suite in the same pass.

Before starting a private local pilot, run the runtime doctor:

```bash
cd backend
npm run check:aletheia:doctor
```

The doctor checks Node, `node:sqlite`, local storage/auth settings, writable
data directories, retrieval defaults, and semantic-index boundaries.

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

Before changing Evidence, Reviews, or Audit registry pages, run the Audit
Workbench audit:

```bash
cd backend
npm run check:aletheia:audit-workbench
```

The audit verifies registry filters, filtered JSON exports, matter readiness
packets, matter-scoped `registry_snapshot` saves, UI smoke coverage, and local
snapshot audit events.

One-command local launcher:

```bash
cd backend
npm run dev:aletheia:local
```

Manual backend:

```bash
cd backend
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

- Local `single_user` runs default the backend listener to `127.0.0.1` unless
  `ALETHEIA_BACKEND_HOST` or `HOST` is explicitly set.
- Documents stay on local filesystem paths.
- SQLite stores structured metadata and audit records.
- Retrieval indexes stay under `.data/aletheia/index`.
- Local directories are restricted to the owner (`0700`); the database,
  uploaded files, exports, semantic indexes, and generated audit HMAC key use
  owner-only file permissions (`0600`) where POSIX permissions are supported.
- Uploads allow at most 100 MB per file and 100 files per batch (10 GB
  aggregate). Aletheia streams them through an owner-only temporary directory,
  cleans all success/error paths, and removes stale temporary files after 24
  hours by default. It accepts PDF, DOCX, XLSX, TXT, and MD and validates
  PDF/Office container signatures.
  Direct-development mode may intentionally leave scanning disabled. The
  compliance Docker preset requires its local ClamAV scanner and blocks uploads
  when the executable or its definitions are unavailable.
- External-source access requires an HTTPS domain allowlist, explicit opt-in,
  and an approved matter-scoped `external_source_use` checkpoint. Authorization
  and capture metadata are audited.
- Audit events are sequenced and HMAC-SHA256 chained per matter. Configure
  `ALETHEIA_AUDIT_HMAC_SECRET` for an operator-managed key, or preserve the
  generated `.audit-hmac-key` with backups. The chain detects unexpected
  changes when the verification key remains trustworthy; it is not an
  append-only external ledger.
- Archive is a status transition with an audit event. Purge additionally
  requires exact matter-ID confirmation and an approved `matter_purge`
  checkpoint, deletes the local matter artifacts, and leaves a signed deletion
  tombstone. Backup and filesystem snapshot copies remain subject to the
  operator's retention process.
- The frontend uses local system font stacks and does not require Google Fonts
  requests during production builds.
- External model and web calls should remain disabled by default.
- Cloud model fallback should require explicit user configuration.
- Source documents and persisted local exports support versioned AES-256-GCM
  envelope encryption. Set `ALETHEIA_APPLICATION_ENCRYPTION=required` and use
  an independent operator key; see [application encryption](application_encryption.md).
  SQLite defaults to the compatible plaintext `node:sqlite` driver. Operators
  may migrate offline and explicitly require the verified SQLCipher driver;
  see [SQLCipher integration](sqlcipher_integration.md). The optional semantic
  JSON index remains outside SQLCipher and still requires an encrypted volume
  and encrypted backups when enabled.

## Current Limitations

- Local Aletheia CRUD is implemented for matters, work products, source-linked
  evidence items, reviews, audit events, and agent runs.
- The V1 local source-index API is available at
  `GET /aletheia/matters/:matterId/v1/source-index` and can feed the Remote
  Matter Command Center export path so local AgentOps export packages include
  `audit_pack.source_index_manifest` with source-index counts.
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
- Local export package and durable eval export routes write JSON export files,
  SQLite export metadata, source-index manifests, export hashes, and audit
  events.
- Local audit events use a per-matter HMAC hash chain, and the audit-integrity
  command verifies chain sequence, links, and signatures.
- Matter archive and approval-gated purge are available in local mode. Purge
  retains a signed tombstone in SQLite and does not delete backup copies.
- Review-derived eval cases are persisted for the local review-resolution
  workflow.
- The local runtime-result route can record approval retry/resume state, but it
  does not dispatch a real external provider.
- Approved skill activation is implemented for the local workflow and requires
  explicit human approval before candidate skill suggestions become approved
  matter playbooks.
- Agent inference uses an explicitly configured loopback local-model endpoint;
  no cloud-model fallback is part of the product runtime.
