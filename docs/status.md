# Product Status

This document is the authoritative short status for Aletheia 明证. Keep broader
design notes in the existing architecture and deployment documents.

## Current Stage

Current stage: local-first MVP / private pilot candidate.

It is not production-ready for the default Supabase path yet.

## Continuous Engineering Loop

A Codex heartbeat automation named
`aletheia-continuous-professional-local-agent-loop` is active for this
thread on a five-minute cadence. Each wakeup should run the operator health
check first, inspect the current worktree and docs, then choose the smallest
useful implementation or documentation improvement before running the relevant
validation commands.

The fast operator health entrypoint is:

```bash
cd backend && npm run check:aletheia:operator
```

The local deployment doctor entrypoint is:

```bash
cd backend && npm run check:aletheia:doctor
```

The local backup manifest entrypoint is:

```bash
cd backend && npm run check:aletheia:backup
```

The restore preflight entrypoint is:

```bash
cd backend && npm run check:aletheia:restore
```

The tracked-file privacy preflight entrypoint is:

```bash
cd backend && npm run check:aletheia:privacy
```

The release evidence manifest entrypoint is:

```bash
cd backend && npm run check:aletheia:evidence
```

The local audit integrity entrypoint is:

```bash
cd backend && npm run check:aletheia:audit-integrity
```

The real-data restore drill entrypoint is:

```bash
cd backend && npm run test:aletheia:restore-drill
```

Main branch pushes and pull requests are also covered by
`.github/workflows/aletheia-local-ci.yml`, which runs the backend local-first
checks, package preflight, frontend lint/build, and Playwright UI smoke.

## Completed Capabilities

The product can demonstrate a full Legal Matter Review flow in local mode:
matter creation, document upload and parsing, SQLite FTS5 search, evidence
mapping with deterministic claim/issue suggestions and audit-facing retrieval
rank diagnostics, issue map generation with a reviewable Issue Map UI and echoed
claim-level review tags, evidence matrix generation, deterministic draft memo
generation, approval-gated audit pack, feedback dataset, and final memo export.
The same local document/evidence pipeline now generates template-specific
Compliance Register and Red Flag Memo work products for compliance impact review
and deal due diligence matters. The workspace also includes Matter Memory,
Matter Playbooks, draft Playbook Improvement Proposals from reviewer feedback,
run traces with budgets and metrics, expanded human checkpoint decisions,
resumable edited/responded checkpoints, bounded specialist role labels with tool
allowlists, persisted Workflow Graph metadata, filterable/exportable live local
Evidence/Reviews registries, the filterable/exportable live local Audit
Workbench, matter-scoped registry snapshots saved as auditable local work
products, the narrow Aletheia Tool Adapter, and a private local packaging
manifest prototype with strict preflight checks. Aletheia routes also support a
private bearer-token auth mode for controlled single-tenant deployments.

## Current Boundaries

- Automated Playwright UI smoke covers desktop and mobile local workspace
  flows with screenshot baseline assertions for the initial workspace render.
- Full frontend lint exits cleanly with no warnings.
- Supabase-backed Aletheia document upload and search are not implemented; use
  `ALETHEIA_STORAGE_DRIVER=local` for document workflows.
- Several inherited frontend/backend files are too large and should be split
  before major feature work continues.
- Semantic or hybrid retrieval remains disabled by default; the optional
  `local-json` adapter requires explicit feature flags and is intended as a
  local prototype before LanceDB/Qdrant.

## Verification Commands

Run before demos or packaging:

```bash
cd backend && npm run build
cd backend && npm run check:aletheia:doctor
cd backend && npm run check:aletheia:backup
cd backend && npm run check:aletheia:restore
cd backend && npm run check:aletheia:privacy
cd backend && npm run check:aletheia:evidence
cd backend && npm run check:aletheia:audit-integrity
cd backend && npm run check:aletheia:operator
cd backend && npm run test:aletheia:local
cd backend && npm run test:aletheia:restore-drill
cd backend && npm run test:aletheia:retrieval-eval
cd backend && npm run test:aletheia:package
cd backend && npm run test:aletheia:completion
cd frontend && npm run lint
cd frontend && npm run test:aletheia:ui
cd frontend && npm run build
```

Current known result:

- backend TypeScript build passes.
- local deployment doctor passes for local/private runtime readiness.
- local backup manifest check passes and reports the backup scope for
  `aletheia.db`, `documents/`, `exports/`, and `index/`.
- restore preflight passes and validates required backup directories, path
  boundaries, symlink-free backup content, SQLite integrity, and core Aletheia
  schema when a local database is present.
- tracked-file privacy preflight passes and blocks committed local data,
  disallowed `.env` files, private key blocks, high-confidence API key shapes,
  and non-placeholder private deployment secrets.
- release evidence manifest passes and records the current git commit,
  validation commands, screenshot hashes, deployment/attribution docs, privacy
  defaults, and approval posture.
- local audit integrity check passes and verifies export audit events, export
  file paths, local data-directory boundaries, and approved checkpoint links for
  high-risk exports when a local database is present. It also reports local
  export file byte counts and sha256 hashes for review packets.
- real-data restore drill passes by creating an isolated local regression
  matter, writing a backup manifest with a SQLite hash, running restore
  preflight with zero warnings, and running audit integrity with real export
  files and approved high-risk checkpoints.
- fast operator health check passes, with a warning when the worktree contains
  uncommitted local changes that still need review/splitting.
- GitHub Actions local CI is configured for `main` and pull requests.
- frontend production build passes.
- full frontend lint exits cleanly with no warnings.
- automated Playwright UI smoke passes for the local workspace approval flow
  on desktop and mobile Chromium using the default 3410/3411 smoke ports,
  including initial workspace screenshot baselines and the live
  Evidence/Reviews/Audit registry pages with local filters, JSON downloads, and
  persisted matter-scoped registry snapshots, plus Compliance/Diligence
  template pages that present local workflow previews rather than fixture-only
  workflows.
- local Aletheia regression passes for TXT, DOCX, PDF, FTS search, evidence,
  Issue Map, optional local-json semantic/hybrid retrieval, work products,
  approvals, exports, Playbook Improvement Proposals, resumable checkpoints,
  matter-scoped registry snapshots, template-specific Compliance Register and
  Red Flag Memo generation, and MCP smoke coverage, including specialist role
  tool-policy and Workflow Graph assertions.
- local retrieval eval passes for fail-closed semantic policy, keyword search,
  optional local-json semantic search, hybrid search, and cross-matter
  isolation, including retrieval rank and ranking-basis diagnostics.
- strict local package preflight passes after backend and frontend build output
  exists, and its manifest records privacy defaults, backup/restore scope,
  startup commands, source-availability docs, and release evidence checks.
- completion audit passes and checks current-state evidence for local-first
  storage, the real document chain, professional templates, Matter Memory,
  Playbooks, Run Trace, approval gates, Tool Adapter/MCP, retrieval eval,
  private deployment, automated validation, demo evidence, and attribution.
