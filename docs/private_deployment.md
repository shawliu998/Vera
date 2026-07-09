# Private Deployment Notes

Aletheia is intended to run as a local-first or private single-tenant
professional agent workspace.

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
ALETHEIA_STORAGE_DRIVER=local
ALETHEIA_AUTH_MODE=single_user
ALETHEIA_DATA_DIR=.data/aletheia
ALETHEIA_LOCAL_USER_ID=local-user
ALETHEIA_LOCAL_USER_EMAIL=local@aletheia.internal
FRONTEND_URL=http://localhost:3000
NEXT_PUBLIC_API_BASE_URL=http://localhost:3001
```

For private token mode on Aletheia routes:

```bash
ALETHEIA_AUTH_MODE=private_token
ALETHEIA_PRIVATE_AUTH_TOKEN=replace-with-a-random-local-private-token
NEXT_PUBLIC_ALETHEIA_PRIVATE_AUTH_TOKEN=replace-with-the-same-token-for-local-browser-only
```

This mode applies only to `/aletheia` routes. Inherited routes continue to use
the base app auth path. Because `NEXT_PUBLIC_*` variables are exposed to browser
clients, use that frontend fallback only for local workstation or trusted
private-network deployments; otherwise inject the bearer token at a reverse
proxy or implement an operator-specific server-side session.

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

## Private Single-Tenant Server

Use this shape for a controlled internal server.

```text
Reverse proxy / TLS
-> Frontend
-> Backend
-> SQLite or Postgres
-> Filesystem or private object storage
```

Recommended hardening:

- Serve only over TLS.
- Put the backend behind private network or reverse proxy rules.
- Use `private_token`, single-tenant auth, or SSO before enabling multi-user
  workflows.
- Keep Aletheia Tool Adapter tools on a whitelist.
- Keep terminal, browser automation, external search, email, and destructive
  file operations disabled by default.
- Require human approval for audit packs, feedback datasets, final memos,
  playbook updates, and external calls.
- Log retention should match the client engagement and professional rules.

## MCP Wrapper

For local MCP clients:

```bash
cd backend
ALETHEIA_STORAGE_DRIVER=local \
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
- Supabase V1 document/chunk/source listing is unavailable.
- Supabase V1 runtime persistence is unavailable.
- No public `persistV1RuntimeResult` route or approval retry wiring exists.
- Review-derived eval cases remain local/helper fixture output until durable
  review-resolution API/status semantics exist.
- External model calls remain off by default for sensitive/private data and
  must stay explicit, configurable, logged, and auditable if enabled later.
- Aletheia is a professional expert-support workspace, not legal advice
  generation, production SaaS, or a guarantee of legal correctness.
- Broader inherited app routes may still assume Supabase-backed services.
- Node 22 currently emits an ExperimentalWarning for `node:sqlite`.
- SQLite FTS5 keyword retrieval is the default. The optional local-json
  semantic/hybrid adapter is a deterministic prototype and must be explicitly
  enabled before use.

See also:

- `docs/desktop_packaging_checklist.md`
- `docs/hybrid_retrieval.md`
