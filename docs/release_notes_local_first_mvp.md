# Local-First MVP Release Notes

This note summarizes the current Aletheia local-first MVP.

## V1 Private-Pilot Update

The V1 private-pilot path is launchable for local operator review with explicit
caveats. The local Remote Matter Command Center export path now fetches
`GET /aletheia/matters/:matterId/v1/source-index` and passes the returned source
index into the export package builder. Downloaded local AgentOps export packages
can include `audit_pack.source_index_manifest` with document, chunk, and
source-link manifest counts.

This does not mean V1 is production SaaS or Supabase-ready. Supabase V1
document/chunk/source listing is unavailable, Supabase V1 runtime persistence
is unavailable, and there is no public `persistV1RuntimeResult` route or
approval retry wiring. Review-derived eval cases remain local/helper fixture
output until durable review-resolution API/status semantics exist. External
model calls remain off by default for sensitive/private data and must stay
explicit, configurable, logged, and auditable.

## Product Positioning

Aletheia 明证 is a private, auditable professional agent workspace for legal,
compliance, and diligence workflows. The product emphasis is not automatic
answers; it is verifiable work products, source-linked evidence, human review,
and replayable audit records.

## Included

- Aletheia-branded workspace under `/aletheia`.
- Matter Queue, templates, evidence, reviews, and audit surfaces.
- Local SQLite repository for Aletheia routes.
- Aletheia-only `private_token` auth mode for controlled single-tenant local or
  private-network deployments.
- Local filesystem document store under `.data/aletheia/documents`.
- Local export store under `.data/aletheia/exports`.
- TXT, DOCX, and PDF text extraction in local regression.
- SQLite FTS5 document chunk search.
- Source-linked Evidence Items with chunk IDs, quote offsets, document names,
  support status, and relevance.
- Deterministic claim/issue suggestions for local document search results and
  evidence mapping fallback.
- Deterministic Issue Map generation with a reviewable workspace panel and
  claim-level review tags.
- Deterministic Evidence Matrix generation.
- Deterministic Legal Draft Memo, Compliance Register, and Red Flag Memo
  generation from the same source-linked evidence matrix.
- Agent Run Trace with steps, tool calls, human checkpoints, and linked
  artifacts.
- Bounded specialist role labels and allowed tool lists in Run Trace.
- Template-aware Run Trace drafting steps for Legal, Compliance, and Diligence
  matters.
- Resumable edited/responded checkpoints that append a run step, generate a
  revised Draft Memo, and audit `agent_run_resumed`.
- Human approval gate for Audit Pack export.
- Human approval gate for Feedback Dataset export.
- Human approval gate for Final Memo export.
- Matter-scoped Matter Memory.
- Draft/approved Matter Playbooks.
- Draft Playbook Improvement Proposals generated from reviewer feedback and
  review tags without mutating approved playbooks.
- Aletheia Tool Adapter over HTTP.
- stdio MCP wrapper exposing the same narrow tool surface.
- Matter-scoped registry snapshots for filtered Evidence, Human Review, and
  Audit Workbench views, persisted as local export-store work products with
  audit events.
- One-command local launcher.
- Strict local packaging preflight that generates a private deployment manifest
  and fails on missing build output, deployment docs, attribution notices, or
  demo evidence docs.
- Release evidence manifest command that records the current git commit,
  validation commands, deployment/attribution docs, screenshot hashes, privacy
  defaults, and high-risk approval posture.
- Tracked-file privacy preflight that blocks committed local data, disallowed
  `.env` files, private key blocks, high-confidence API key shapes, and
  non-placeholder private deployment secrets before handoff or packaging.
- Operational readiness audit that verifies local doctor coverage, the local
  launcher, `/health`, private-token auth boundaries, package metadata,
  backup/restore/audit integrity, and private deployment runbook coverage.
- Source provenance audit that verifies parser chunk offsets, document IDs,
  source chunk IDs, quote offsets, support status, SQLite FTS5 matter filters,
  source-linked work products, UI registry fields, and exportable provenance.
- Knowledge governance audit that verifies matter-scoped Matter Memory,
  human-approved Matter Playbooks, draft-only improvement proposals, no global
  legal memory, and no default Tool Adapter mutation path for knowledge
  artifacts.
- Tool Adapter policy audit that verifies the HTTP Tool Adapter and stdio MCP
  wrapper expose only the approved allowlist and keep browser, terminal,
  external web, email, and destructive file operations disabled.
- Approval policy audit that verifies high-risk exports require approved human
  checkpoints, playbook updates remain human-approved, external-source use stays
  controlled, and regression/audit checks cover those gates.
- Matter isolation audit that verifies matter/user scoped access, matter-scoped
  memory/playbooks, per-matter retrieval indexes, and cross-matter retrieval
  eval coverage.
- Run Trace audit that verifies AgentRun, AgentStep, ToolCall, and
  HumanCheckpoint persistence, Workflow Graph controls, approval gates, resume
  behavior, specialist role tool allowlists, and UI/docs coverage.
- Local audit integrity command that verifies export work products have matching
  audit events, local export files, data-directory bounded paths, and approved
  checkpoint links for high-risk exports, with byte counts and sha256 hashes for
  exported JSON files.
- Real-data restore drill that creates a temporary local matter, writes a backup
  manifest, validates restore preflight, and runs audit integrity on the same
  non-empty SQLite/filesystem state.
- Completion audit command that verifies the repository still contains evidence
  for local-first storage, real document workflows, Matter Memory, Playbooks,
  Run Trace, approval gates, Tool Adapter/MCP, retrieval eval, private
  deployment, automated validation, demo assets, and attribution.
- Local regression command covering documents, retrieval, work products,
  approvals, exports, and MCP.
- Local retrieval eval covering fail-closed semantic policy, keyword retrieval,
  optional local-json semantic/hybrid retrieval, and cross-matter isolation.
- UI smoke seed command, screenshot evidence, and committed Playwright browser
  smoke across desktop and mobile Chromium with screenshot baselines.
- Local V1 source-index export manifest support for the Remote Matter Command
  Center export path.

## Commands

```bash
cd backend
npm run check:aletheia:preflight
npm run test:aletheia:local
npm run test:aletheia:restore-drill
npm run test:aletheia:retrieval-eval
npm run check:aletheia:privacy
npm run check:aletheia:ops-readiness
npm run check:aletheia:source-provenance
npm run check:aletheia:knowledge-governance
npm run check:aletheia:audit-workbench
npm run check:aletheia:tool-policy
npm run check:aletheia:approval-policy
npm run check:aletheia:matter-isolation
npm run check:aletheia:run-trace
npm run check:aletheia:evidence
npm run check:aletheia:audit-integrity
npm run test:aletheia:completion
npm run seed:aletheia:ui-smoke
npm run dev:aletheia:local
npm run mcp:aletheia
```

```bash
cd frontend
npm run build
```

## Trust Boundaries

- Matter Memory is matter-scoped only.
- Playbooks require explicit human approval.
- High-risk exports require approval checkpoints.
- External web search, browser automation, terminal execution, email, and
  destructive file operations are not exposed through the Aletheia Tool Adapter.
- Local mode applies to Aletheia routes; inherited application routes may still
  require Supabase-backed services.

## Evidence

- `docs/screenshots/aletheia-home-desktop.jpg`
- `docs/screenshots/aletheia-matter-overview-desktop.jpg`
- `docs/screenshots/aletheia-run-trace-desktop.jpg`
- `docs/screenshots/aletheia-matter-mobile.jpg`
- `docs/demo_evidence.md`

## Known Limitations

- Node 22 emits an ExperimentalWarning for `node:sqlite`.
- SQLite FTS5 is the default retrieval layer; optional semantic or hybrid
  retrieval requires explicit enablement of the local-json prototype adapter.
- V1 source-index export manifest support is local-only. Supabase V1
  document/chunk/source listing is not implemented.
- Supabase V1 runtime persistence is not implemented.
- `persistV1RuntimeResult` is not exposed through a public route, and blocked
  external-provider approval retry wiring is not implemented.
- Review-derived eval cases are not yet a persisted review-to-eval workflow.
- Browser UI smoke is committed as a Playwright test across desktop and mobile
  with screenshot baseline assertions for the initial workspace render.
- The updated V1 route/export Playwright spec still needs final UI smoke
  validation before handoff.
- Signed installer distribution and production SSO/session policy are still
  outside the prototype package.

## Future Hardening

- Replace or augment the local-json prototype with the LanceDB semantic index
  adapter behind
  `ALETHEIA_SEMANTIC_INDEX_ENABLED=true`.
- Harden the private desktop packaging prototype into an operator-specific
  signed installer or managed bundle when a deployment target is selected.
