# Gate 1 Stabilization Audit

Date: 2026-07-16

Status: **implementation and local packaged acceptance complete; remote
final-commit CI pending**

This audit describes the shared stabilization worktree. It does not declare
Gate 1 complete until the final pushed commit receives the required GitHub
Actions result. The current worktree has passed the complete local Actions
command chain and a current packaged `Vera.app` cross-restart acceptance run.

## Historical GitHub Actions failure

[Run 29465212424](https://github.com/shawliu998/Vera/actions/runs/29465212424)
executed on `main` at `9ba3759c3587ddfeffcf5ae3c0fd21c2e942e59a` and
completed with two failed jobs.

| Job | Failing step | Actual root cause | Current local evidence |
| --- | --- | --- | --- |
| Vera macOS package validation | Build and validate local-only Vera package | `vera-shell-foundation.spec.ts` used `git show e32daad…:<path>` against the Vera repository. The locked Mike commit did not contain the Vera-side paths `frontend/src/app/contexts/PageChromeContext.tsx` or `frontend/src/app/components/shared/PageHeader.tsx`, so two tests failed before packaged-runtime checks. | The test now verifies a checked-in Mike source-lock manifest and reconstructed byte hashes. `cd frontend && npm run test:shell-source` passes 14/14. |
| Local-first validation | Run backend local-first checks | `aletheiaOpsReadinessAudit.ts` encoded the pre-convergence bootstrap shape. Its exact-string checks did not recognize lazy, default-off Legacy router loading or the composed authenticated `/api/v1` router, producing false failures for `local-only-product-boundary` and `http-health-and-private-auth`. | The audit now checks ordering and invariants of the current bootstrap. `cd backend && npm run check:aletheia:ops-readiness` passes all critical checks. |

Warnings about absent signing credentials, plaintext development SQLite, and
an absent backup manifest in that run were truthful local/development warnings;
they were not the two step-failing root causes above. The old run remains
failed and is not rewritten as passing evidence.

## Current implementation evidence

The following source and focused commands passed in the stabilization
worktree:

```text
cd backend && npm run build
cd backend && npm run test:vera:matter:module
cd backend && npm run test:vera:matter:migration
cd backend && npm run test:vera:matter:inference
cd backend && npm run test:workspace:migrations
cd backend && npm run check:aletheia:ops-readiness
cd frontend && npm run test:shell-source
```

The complete backend command block from `Vera Local CI`, frontend lint,
legal-source contracts, and the desktop/mobile Playwright UI smoke also passed
from start to finish. Strict local packaging now validates the real
`.next-build/standalone` production runtime rather than accepting an empty or
stale `.next` directory.

The focused Matter module audit covers policy GET/PATCH, atomic Project/Profile
PATCH, filtered cursor pagination, archived/deleted write rejection, capability
projection without decision-ledger writes, 100 generic Projects plus two
Matters, and absence of public `matter_type`.

## Stabilized product boundaries

- Legacy routes and runtime remain exact-opt-in and lazy-loaded.
- Matter Profile is optional on a Project; generic Projects remain generic.
- `/api/v1/matters` is a Project projection with explicit Profile state, not a
  second Project store.
- Migration v15 remains immutable. Migration v16 adds `workspace_type`; v17
  adds explicit model-privacy declarations and the inference decision ledger.
- Matter Policy is a complete replacement subresource. Missing policy or an
  empty execution-location set fails closed.
- Capability reads call the side-effect-free policy evaluator. Enforcement at
  an enqueue or final provider boundary records a decision.
- Full Gate 2 Review Center capability remains unavailable. The current Matter
  `/review` route is a compatibility presentation of the existing Tabular
  Review owner, not the Proposal Contract.

## Inference-path audit

| Scope | Current decision path |
| --- | --- |
| Global | `projectId=null`; enabled Model Profile and complete explicit privacy declaration use the Workspace rule. |
| Generic Project | Active Project without Profile; same Workspace rule, with no Matter Policy and no implicit conversion. |
| Matter | Active Project with Profile; Workspace model privacy plus an existing Matter Policy containing the declared execution location. Missing/empty denies; external `approval` stays approval. |

Capability reads use side-effect-free `evaluate`. Assistant and Workflow check
at enqueue and recheck in the shared Assistant adapter immediately before the
provider call. Tabular checks preparation and rechecks each cell immediately
before its provider call. Gate 1 has no standalone Studio provider generator:
Assistant-created Studio suggestions inherit the Assistant boundary, while
`studio_suggestion` remains a reserved v17 operation for a future direct
generator.

## List, route, and taxonomy audit

`/api/v1/matters` filters `profiled`, `ready`,
`classification_required`, `absent`, or `all` in SQL before keyset pagination.
Each filter owns its opaque cursor; the response has no total. The renderer
loads `profiled` and `absent` independently and labels section numbers as rows
loaded.

The current Matter shell routes Overview, Documents, Studio, Assistant,
Workflows, Tabular compatibility Review, Drafts, and Settings under
`/matters/:id/**`; the route adapter keeps reused Project components in that
family. Dynamic `/projects/:id/**` deep links remain valid. `/review` currently
means the Tabular owner and is gated by `tabular`; `review` itself remains
unavailable until Gate 2.

The runtime Profile/overview/API/UI read path uses v16 `workspace_type`. It does
not read v15 `matter_type` as classification. The production Profile writer
mentions `matter_type` only to satisfy the immutable v15 `NOT NULL` column and
writes the fixed private sentinel `general`. Other allowed references are
migrations, audits/fixtures, and the unrelated default-off Legacy AgentOps DTO;
the field is absent from public Matter responses.

## Packaged acceptance evidence

`VERA_RELEASE_SIGNING=false ./scripts/package-desktop-mac.sh` passed on macOS
arm64. The script built a fresh backend, `.next-build/standalone` frontend, and
Electron application; then passed package hygiene, SQLCipher, startup,
migration, interrupted-restore fail-closed, backup/restore, native OCR, CSP,
and packaged Workspace E2E gates before atomically publishing artifacts to
`desktop/dist`.

The packaged Gate 1 v3 chain created a classified Matter, declared an explicit
`confidential_remote`/zero-retention/no-training model privacy profile,
installed an `allowed_by_policy` Matter Policy, captured two document source
snapshots, completed a real Matter Assistant tool/final turn with exact
citations, and verified the exact Profile/Policy/default-model/chat/source/
capability/count state after an offline restart. The redacted second-launch
evidence is
[`docs/evidence/vera-gate1-matter-packaged-restart.png`](../evidence/vera-gate1-matter-packaged-restart.png).

Local-only artifact identity:

| Artifact | SHA-256 |
| --- | --- |
| `Vera-1.0.1-arm64.dmg` | `62cad49197eda2caaae026c2d8b2476a719b67c9e2602792caf8bde17a109b74` |
| `Vera-1.0.1-arm64.zip` | `acdcbdfb8002a3e6b48b31db40a51b56b9b0813f5beccf43f6013aa409aefd6d` |

These artifacts are intentionally unsigned, unnotarized, and local-only; they
must not be represented as distributable release artifacts.

## Remaining release evidence

- push the reviewed commits and obtain the required GitHub Actions result for
  the exact final commit;
- for a distributable release, rerun with release signing enabled and valid
  Developer ID/notarization credentials, then record the signed artifact
  hashes and stapled-ticket verification.

Until the remote final-commit result exists, the accurate status is
**implementation and local packaged acceptance complete; remote final-commit
CI pending**.
