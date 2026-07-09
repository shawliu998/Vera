# Aletheia V1 Private Pilot Status

Current stage: **V1 local/private-pilot candidate completed; production/SaaS
not claimed.**

Aletheia V1 is completed for bounded local reviewer evaluation. The validated
path shows a local-first sensitive-work agent harness with the first
public/private-pilot Domain Pack: Private Contract / Due Diligence Review. It
is not legal advice software, not production SaaS, and not a replacement for
qualified professional judgment.

## What Is Validated

- Local/private startup for the Aletheia workspace.
- Local batch document import, parsing, chunking, and source indexing.
- Matter-scoped retrieval with source provenance and retrieval diagnostics.
- Source-linked evidence, issue/risk, review, gate, and export surfaces.
- Fail-closed gates for high-risk export flows.
- Local AgentOps export package and durable eval export routes with
  source-index manifests, SQLite export metadata, export hashes, and audit
  events.
- Local review-resolution persistence and review-derived eval cases for
  accepted/rejected/needs-material/resolved review paths.
- Local approved skill activation from review-derived eval candidate to
  human-approved matter playbook and `approved_skill_activated` audit event.
- Local runtime-result persistence with approval retry/resume recording for
  authorized external-model-call retries, without dispatching an external
  provider.
- Full local Playwright UI smoke passed 6/6 on explicit backend/frontend ports;
  focused mobile smoke passed 2/2, and frontend typecheck/lint passed.
- Reviewer-facing documentation and release notes that preserve the
  local/private-pilot boundary.

## Validation Evidence

Backend validation passed:

```bash
cd backend && npm run build
cd backend && npm run check:aletheia:operator
cd backend && npm run check:aletheia:source-provenance
cd backend && npm run check:aletheia:approval-policy
cd backend && npm run check:aletheia:run-trace
cd backend && npm run check:aletheia:audit-integrity
cd backend && npm run check:aletheia:approved-skill-activation
cd backend && node --import tsx src/scripts/aletheiaBackendApiScopingAudit.ts
cd backend && node --import tsx src/scripts/aletheiaV1RuntimePersistenceAudit.ts
```

Frontend and AgentOps validation passed:

```bash
cd frontend && npm run lint
cd frontend && npx tsc --noEmit --pretty false
cd frontend && ../backend/node_modules/.bin/tsx --test tests/agentops/exportPackage.test.ts tests/agentops/v1Contracts.test.ts tests/reviewStudio.test.ts tests/agentops/gates.test.ts tests/agentops/v1Runtime.test.ts tests/agentops/v1DocumentRetrievalAdapters.test.ts
cd frontend && ALETHEIA_UI_SMOKE_FRONTEND_PORT=5310 ALETHEIA_UI_SMOKE_BACKEND_PORT=5311 npx playwright test --config=playwright.config.ts
node .agentops/scripts/check-agentops.mjs
git diff --check
```

## Caveats

- Local/private-pilot only.
- No legal advice generation and no replacement for expert judgment.
- No production SaaS readiness is claimed.
- Supabase V1 document/chunk/source listing is unavailable.
- Supabase V1 runtime persistence is unavailable.
- Local runtime approval retry records authorization and trace state only; it
  does not dispatch a real external provider.
- Supabase review-derived eval, export persistence, and skill activation are
  unavailable.
- External model calls remain off by default for sensitive/private data and
  must be explicit, configurable, logged, and auditable if enabled later.

## Reviewer Path

Start with:

- `README.md`
- `docs/status.md`
- `docs/v1_acceptance_matrix.md`
- `docs/demo_script.md`
- `docs/release_notes_local_first_mvp.md`
