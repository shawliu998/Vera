# Aletheia Worktree Split Manifest

Updated: 2026-07-09T08:15:21Z

Purpose: map the currently observed dirty worktree into reviewable packaging buckets. This is a supervisor coordination artifact only; it does not stage or commit files.

Use with:

- `docs/commit_plan.md` for staging commands and commit messages;
- `.agentops/WORKTREE_HANDOFF.md` for acceptance checks and pause/resume rules.

## Current Supervisor Read

All `.agentops/status/*.json` lanes still report `done`. P0 remains complete for:

```text
Evidence -> Issue/Risk -> Memo -> Review -> Gate -> Audit -> Eval
```

The only active operational task is dirty-worktree review, split, and commit packaging.

## Packaging Buckets

| Bucket | Current dirty paths | Review focus |
| --- | --- | --- |
| Backend audit/gate persistence | `backend/src/lib/aletheia/documentParser.ts`; `backend/src/lib/aletheia/domain.ts`; `backend/src/lib/aletheia/localRepository.ts`; `backend/src/lib/aletheia/repository.ts`; `backend/src/lib/aletheia/supabaseRepository.ts`; `backend/src/routes/aletheia.ts`; `backend/src/scripts/aletheiaApprovalPolicyAudit.ts`; `backend/src/scripts/aletheiaAuditIntegrity.ts`; `backend/src/scripts/aletheiaLocalRegression.ts` | Persisted gate evidence, final memo authorization, source provenance, local regression, audit-integrity behavior. |
| Frontend workspace shell | `frontend/src/aletheia/AletheiaEvidenceRegistry.tsx`; `frontend/src/aletheia/AletheiaShell.tsx`; `frontend/src/aletheia/AletheiaWorkspace.tsx`; `frontend/src/aletheia/RemoteMatterPage.tsx`; `frontend/src/aletheia/RemoteMatterSidebar.tsx`; `frontend/src/aletheia/exports.ts`; `frontend/src/aletheia/remoteMatterTransforms.ts`; `frontend/src/app/aletheia/docs/page.tsx` | Matter workspace flow, evidence/source display, remote matter transforms, citation gate source provenance, export preview boundaries. |
| AgentOps Command Center and review surfaces | `frontend/src/aletheia/RemoteMatterCommandCenter.tsx`; `frontend/src/aletheia/agentops/**`; `frontend/src/aletheia/reviewStudio.ts`; `frontend/src/app/aletheia/agentops/**`; `frontend/src/app/aletheia/matters/[matterId]/agentops/**`; `frontend/src/components/agentops/**`; `frontend/src/lib/agentops/**`; `frontend/tests/agentops/**`; `frontend/tests/aletheia-agentops-route.spec.ts`; `frontend/tests/review-studio-demo.spec.ts`; `frontend/tests/reviewStudio.test.ts` | Adapter-backed AgentOps view state, typed handoff, gate provenance, eval helpers, Review Studio, route-visible helper surfaces. |
| UI smoke and frontend validation | `frontend/eslint.config.mjs`; `frontend/playwright.config.ts`; `frontend/tests/aletheia-ui-smoke.global-setup.ts`; `frontend/tests/aletheia-ui-smoke.spec.ts`; `frontend/tests/aletheia-ui-smoke.spec.ts-snapshots/aletheia-workspace-initial-desktop-chromium-darwin.png`; `frontend/tsconfig.json` | Smoke harness, snapshot intentionality, TypeScript/lint configuration, full UI smoke reproducibility. |
| Product, demo, and coordination docs | `.agentops/**`; `.gitignore`; `README.md`; `docs/agentops/**`; `docs/commit_plan.md`; `docs/deepseek_pitch.md`; `docs/demo_script.md`; `docs/feature_map.md`; `docs/reviewer_walkthrough.md`; `docs/status.md` | Professional positioning, P0 closeout evidence, handoff accuracy, no autonomous-advice or overbroad release claims. |

## Split Rules

- Do not stage all buckets together.
- Do not move a file across buckets without recording the reason in the commit message or handoff.
- If one file contains unrelated changes that cross buckets, either split hunks deliberately or document why the file stays with the higher-risk bucket.
- Treat backend gate/audit files and frontend export/gate/eval files as high-risk; rerun the relevant validation before packaging them.
- If packaging reveals a conflict or changes implementation behavior, resume supervisor cycles before committing.

## Minimum Final Check

After buckets are staged or committed:

```bash
git diff --check
node .agentops/scripts/check-agentops.mjs
```

Then run the full final validation block in `.agentops/WORKTREE_HANDOFF.md` or record any skipped command with an explicit reason.
