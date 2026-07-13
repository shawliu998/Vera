# Private Deployment Notes

Aletheia is intended to run as a local single-workstation professional agent
workspace.

## Local Desktop / Workstation

Use this shape for demos, expert review workflows, and private local pilots.

```text
Frontend: Next.js on localhost
Backend: Express/TypeScript on localhost
Storage: SQLite at .data/aletheia/aletheia.db
Documents: .data/aletheia/documents/
Exports: .data/aletheia/exports/
Index: SQLite FTS5, with .data/aletheia/index reserved
MCP: stdio wrapper via npm run mcp:aletheia
```

Recommended environment:

```bash
ALETHEIA_AUTH_MODE=single_user
ALETHEIA_BACKEND_HOST=127.0.0.1
ALETHEIA_DATA_DIR=.data/aletheia
ALETHEIA_LOCAL_USER_ID=local-user
ALETHEIA_LOCAL_USER_EMAIL=local@aletheia.internal
FRONTEND_URL=http://127.0.0.1:3000
NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:3001
```

For private token mode on Aletheia routes:

```bash
ALETHEIA_AUTH_MODE=private_token
ALETHEIA_PRIVATE_AUTH_TOKEN=replace-with-a-random-local-private-token
NEXT_PUBLIC_ALETHEIA_PRIVATE_AUTH_TOKEN=replace-with-the-same-token-for-local-browser-only
```

This mode applies to the local `/aletheia` API. Because `NEXT_PUBLIC_*`
variables are exposed to browser clients, use that frontend fallback only for
a loopback workstation. The desktop app does not embed the token; it supplies a
fresh per-launch token through the trusted desktop bridge.

## Current Security Hardening

- The local `single_user` backend defaults to the loopback listener
  `127.0.0.1`. Set `ALETHEIA_BACKEND_HOST` explicitly only when the backend is
  deliberately placed behind a private network or reverse proxy.
- Docker containers listen on their internal container interfaces so the
  frontend can reach the backend, but Compose publishes both host ports on
  `127.0.0.1` only. A LAN-accessible deployment requires an intentional proxy
  or port-binding change plus authentication and TLS review.
- The desktop app always uses `private_token` auth. It generates a fresh random
  32-byte token for each app launch and gives it only to the trusted local
  renderer through the desktop bridge; it is not stored in the packaged
  frontend or written to `.env`.
- In local mode, Aletheia sets data directories to owner-only (`0700`) and the
  SQLite database, uploaded documents, exports, local semantic indexes, and
  generated audit HMAC key to owner read/write only (`0600`) on platforms that
  support POSIX permissions.
- Each uploaded file is limited to 100 MB and a batch is limited to 100 files
  (10 GB aggregate ceiling). Uploads stream through an owner-only temporary
  directory, are cleaned on every success/error path, and have a 24-hour stale
  file janitor by default (`ALETHEIA_UPLOAD_TEMP_TTL_MS` can adjust the TTL).
  Accepted document extensions are PDF, DOCX, XLSX, TXT, and MD. PDF headers
  and the ZIP container signatures used by DOCX/XLSX are checked before the
  files enter the matter repository; this is validation, not malware scanning.
- External-source fetches remain allowlisted and opt-in, and now also require
  an approved, matter-scoped `external_source_use` checkpoint. Authorization
  and completion are written to the audit trail with hashes and response size.
- Local audit events are sequenced per matter and linked with HMAC-SHA256. Set
  `ALETHEIA_AUDIT_HMAC_SECRET` to an operator-managed secret, or local mode
  creates `.data/aletheia/.audit-hmac-key` with mode `0600`. Run the audit
  integrity check after real workflows and before restore or handoff. This
  chain is tamper-evident; it does not prevent an attacker who controls both the
  data and HMAC key from rewriting history.
- Public note-only audit append APIs accept only `human_note.*` or
  `agent_note.*` actions. Lifecycle, approval, export, and security events are
  emitted only by the backend operation that actually performed them.
- Archiving changes the matter status and records an audit event. Permanent
  purge requires the matter ID to be re-entered and an approved
  `matter_purge` checkpoint. Purge removes matter records and local document,
  export, and semantic-index files, then preserves a signed tombstone with a
  hashed title, last audit hash, approval ID, deletion counts, and timestamp.
  Purge does not erase copies already present in backups or filesystem
  snapshots.
- Aletheia supports authenticated AES-256-GCM envelopes for uploaded source
  files and persisted local exports. The desktop app stores its independent
  master key in macOS Keychain; backend-only operators can use an environment
  or owner-only key file. See [application encryption](application_encryption.md)
  for migration, recovery, and key-loss constraints.
- Direct backend development uses the compatible `node:sqlite` database by
  default and is therefore plaintext. Parsed chunks,
  FTS terms, work-product content, audit details, and metadata remain readable
  until an operator completes the offline migration and explicitly sets
  `ALETHEIA_DATABASE_ENCRYPTION=sqlcipher_required`. Required mode uses the
  verified `@signalapp/sqlcipher` adapter and fails closed on a missing/wrong
  key or failed cipher/integrity verification; see
  [SQLCipher integration](sqlcipher_integration.md). The optional semantic JSON
  index is outside SQLite and remains plaintext when enabled.
- The supplied Docker Compose configuration instead defaults to the
  admission-controlled `compliance` preset: AES-GCM file envelopes, SQLCipher,
  encrypted-volume attestation, required ClamAV scanning, and an independent
  high-assurance Ed25519 anchor must all be live before it listens. See
  [compliance deployment](compliance_deployment.md). Do not copy its
  attestation into an unverified environment.
- For stronger tamper evidence, configure the independent Ed25519 anchor journal
  described in [audit anchoring](audit_anchoring.md). Keep its private key and
  journal outside the vault. Ordinary external storage is not automatically
  WORM; retain signed heads or bundles with a separate custodian.
- Cloud model, web, connector, and other external calls remain disabled unless
  an operator explicitly configures the capability and its approval policy.

Operational notes:

- Keep `.data/aletheia` outside synced public folders.
- Back up `.data/aletheia/aletheia.db`, `documents/`, and `exports/` together.
- Run `npm run check:aletheia:preflight` before handoff or packaging. It runs
  the backend build, local-first audits, local regression, restore drill,
  retrieval eval, package preflight, completion audit, and frontend lint/build
  in deployment order. Set `ALETHEIA_PREFLIGHT_INCLUDE_UI=true` when the
  operator also wants the Playwright UI smoke suite.
- Run `npm run check:aletheia:backup` to produce a machine-readable backup
  manifest before handoff or migration.
- Run `ALETHEIA_RESTORE_SOURCE_DIR=.data/aletheia npm run check:aletheia:restore`
  before pointing a new deployment at a restored data directory.
- Run `ALETHEIA_AUDIT_SOURCE_DIR=.data/aletheia npm run check:aletheia:audit-integrity`
  after a real workflow to verify export events, local export files, and
  approved checkpoint links. The JSON output includes byte counts and sha256
  hashes for local export files.
- Run `npm run check:aletheia:privacy` before committing, packaging, or
  handoff. It scans only tracked repository files for accidental `.data`
  artifacts, disallowed `.env` files, high-confidence API key shapes, private
  key blocks, and non-placeholder private deployment secrets.
- Run `npm run check:aletheia:ops-readiness` before private deployment or
  packaging. It verifies local doctor coverage, the local launcher, `/health`,
  private-token auth boundaries, package metadata, backup/restore/audit
  integrity, and runbook coverage.
- Run `npm run check:aletheia:source-provenance` before changing document
  parsing, evidence mapping, or work product generation. It verifies source
  chunk IDs, document IDs, quote offsets, support status, FTS5 matter filters,
  UI registry fields, and exportable provenance.
- Run `npm run check:aletheia:knowledge-governance` before changing Matter
  Memory or Playbooks. It verifies matter-scoped memory, human-approved
  playbooks, draft-only improvement proposals, no global legal memory, and no
  default Tool Adapter mutation path for knowledge artifacts.
- Run `npm run check:aletheia:audit-workbench` before changing Evidence,
  Reviews, or Audit registry pages. It verifies registry filters, filtered JSON
  exports, matter readiness packets, matter-scoped `registry_snapshot` saves,
  UI smoke coverage, and local snapshot audit events.
- Run `npm run check:aletheia:tool-policy` before enabling agent integrations.
  It verifies the HTTP Tool Adapter and stdio MCP wrapper expose only the
  approved narrow allowlist and keep browser, terminal, external web, email, and
  destructive file operations disabled.
- Run `npm run check:aletheia:approval-policy` before private handoff. It
  verifies high-risk exports require approved checkpoints, playbook updates
  remain human-approved, and external-source use stays controlled.
- Run `npm run check:aletheia:matter-isolation` before changing retrieval,
  memory, or playbook behavior. It verifies matter/user scoped access, per-matter
  indexes, and cross-matter retrieval isolation.
- Run `npm run check:aletheia:run-trace` before changing agent runtime or review
  UI behavior. It verifies AgentRun, AgentStep, ToolCall, and HumanCheckpoint
  persistence, Workflow Graph controls, approval gates, and resume behavior.
- Treat `exports/` as client-sensitive output.
- Do not enable external web/model tools unless the deployment owner explicitly
  configures them.
- Use `npm run check:aletheia:doctor` and `npm run test:aletheia:local`
  before demos or packaging.
- Use `npm run test:aletheia:restore-drill` before private handoff. It creates
  a temporary real local matter and proves backup manifest, restore preflight,
  and audit integrity on non-empty SQLite/filesystem state.
- Use `npm run package:aletheia:local` after backend/frontend builds to create
  a local private package manifest, env template, and startup scripts.
- Use `npm run test:aletheia:package` after backend/frontend builds when a
  packaging run must fail on missing release evidence or deployment documents.
- Use `npm run dev:aletheia:local` from `backend/` for local development. It
  starts backend and frontend when ports are free, leaves existing dev servers
  untouched, and prints the MCP command.

## Deployment Boundary

The supported package is local SQLite plus an owner-only filesystem on one
workstation. Remote SaaS, Postgres, object storage, shared multi-user hosting,
and public service bindings are outside this product boundary. Reconsidering
that boundary requires a separate threat model, authentication design, tenant
isolation review, encryption/key-management plan, and deployment approval.

## MCP Wrapper

For local MCP clients:

```bash
cd backend
ALETHEIA_AUTH_MODE=single_user \
ALETHEIA_DATA_DIR=.data/aletheia \
npm run mcp:aletheia
```

The MCP wrapper talks directly to the Aletheia repository. It does not require
the HTTP backend in local SQLite mode.

## Upgrade / Migration

Before upgrading:

- stop backend, frontend, and MCP processes;
- back up `.data/aletheia`;
- run `npm run build`;
- run `npm run check:aletheia:preflight`;
- run `npm run check:aletheia:doctor`;
- run `npm run check:aletheia:backup`;
- run `ALETHEIA_RESTORE_SOURCE_DIR=.data/aletheia npm run check:aletheia:restore`;
- run `npm run check:aletheia:privacy`;
- run `npm run check:aletheia:ops-readiness`;
- run `npm run check:aletheia:source-provenance`;
- run `npm run check:aletheia:knowledge-governance`;
- run `npm run check:aletheia:audit-workbench`;
- run `npm run check:aletheia:tool-policy`;
- run `npm run check:aletheia:approval-policy`;
- run `npm run check:aletheia:matter-isolation`;
- run `npm run check:aletheia:run-trace`;
- run `ALETHEIA_AUDIT_SOURCE_DIR=.data/aletheia npm run check:aletheia:audit-integrity`;
- run `npm run test:aletheia:local`;
- run `npm run test:aletheia:restore-drill`;
- run `npm run test:aletheia:package` after frontend build output exists;
- start the backend and inspect `/health`;
- open a seeded UI smoke matter from `docs/ui_smoke.md`.

## Current Boundaries

- Local-first support is implemented for Aletheia routes.
- Aletheia routes support local `single_user` mode and private bearer-token mode
  for controlled single-tenant deployments.
- V1 source-index listing is available for local Aletheia storage and can be
  included in local AgentOps export packages as
  `audit_pack.source_index_manifest`.
- Local export package and durable eval export routes write JSON export files,
  SQLite export metadata, source-index manifests, export hashes, and audit
  events.
- Local audit events form a per-matter HMAC-SHA256 chain. The integrity audit
  validates event order, previous-hash links, and event hashes when the HMAC key
  is available.
- Local matter archive and approval-gated purge are implemented. Purge retains
  a signed deletion tombstone but does not reach backup or snapshot copies.
- Local runtime approval retry records authorization and trace state only; it
  does not dispatch a real external provider.
- Review-derived eval cases are persisted for the local review-resolution
  workflow.
- Approved skill activation is implemented for the local workflow and requires
  explicit human approval before candidate skill suggestions become approved
  matter playbooks.
- Agent inference is restricted to explicitly configured loopback local-model
  endpoints. No cloud-model fallback is part of the product runtime.
- Aletheia is a professional expert-support workspace, not legal advice
  generation, production SaaS, or a guarantee of legal correctness.
- The compiled backend and packaged desktop expose only the local Aletheia
  product surface; see `docs/local_only_dependency_boundary.md`.
- Node 22 currently emits an ExperimentalWarning for `node:sqlite`.
- SQLite FTS5 keyword retrieval is the default. The optional local-json
  semantic/hybrid adapter is a deterministic prototype and must be explicitly
  enabled before use.

See also:

- `docs/desktop_packaging_checklist.md`
- `docs/hybrid_retrieval.md`
