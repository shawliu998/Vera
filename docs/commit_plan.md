# Aletheia Commit Plan

This plan splits the current Aletheia changes into reviewable commit groups. It
intentionally does not stage or commit files by itself.

## Review Summary

- The worktree is a large feature migration, not a single patch.
- The backend local runtime is the largest risk surface because
  `backend/src/lib/aletheia/localRepository.ts`, `backend/src/routes/aletheia.ts`,
  and `backend/src/lib/aletheia/domain.ts` carry most of the product behavior.
- The frontend Aletheia workspace depends on the backend API shape and should be
  reviewed after the backend runtime.
- The inherited app changes are useful but separate from the Aletheia workspace;
  keep them in their own commit so accidental behavior changes are easy to
  review.
- Tests, smoke fixtures, screenshots, and documentation should remain separate
  so release evidence does not obscure runtime code review.

## Post-P0 AgentOps Addendum

Updated at `2026-07-09T08:14:32Z`.

This plan predates the final AgentOps P0 closeout. Use
`.agentops/WORKTREE_HANDOFF.md` as the acceptance wrapper and include the
current AgentOps additions below when splitting the remaining review groups. Do
not fold these files silently into older runtime commits. The current path
bucket map lives in `.agentops/WORKTREE_SPLIT_MANIFEST.md`.

Suggested additional grouping:

1. AgentOps Command Center and review surfaces
   - `frontend/src/aletheia/RemoteMatterCommandCenter.tsx`
   - `frontend/src/aletheia/agentops/**`
   - `frontend/src/aletheia/reviewStudio.ts`
   - `frontend/src/app/aletheia/agentops/**`
   - `frontend/src/app/aletheia/matters/[matterId]/agentops/**`
   - `frontend/src/components/agentops/**`
   - `frontend/src/lib/agentops/**`
   - `frontend/tests/agentops/**`
   - `frontend/tests/aletheia-agentops-route.spec.ts`
   - `frontend/tests/review-studio-demo.spec.ts`
   - `frontend/tests/reviewStudio.test.ts`

2. AgentOps coordination and reviewer docs
   - `.agentops/**`
   - `docs/agentops/**`
   - `docs/deepseek_pitch.md`
   - `docs/feature_map.md`
   - `docs/reviewer_walkthrough.md`

Minimum validation for the addendum:

```bash
cd frontend && npm run lint
cd frontend && npx tsc --noEmit
cd frontend && npm run test:aletheia:ui
node .agentops/scripts/check-agentops.mjs
```

Keep the P0 positioning unchanged while packaging: Aletheia supports
professional expert review with evidence, gates, audit, and eval loops. It does
not replace experts or provide autonomous final legal/compliance advice.

## Commit 1: Backend Local-First Agent Runtime

Suggested message:

```text
feat(backend): implement local-first Aletheia runtime
```

Scope:

- SQLite/filesystem local repository.
- Document parsing, chunking, FTS5 retrieval, optional local semantic adapter.
- Source-linked evidence, Issue Map, Evidence Matrix, professional drafts.
- Matter Memory, Matter Playbooks, human approval gates, run trace, Workflow
  Graph metadata, registry snapshots.
- Private token/single-user auth for Aletheia routes.
- Narrow Tool Adapter and stdio MCP wrapper.
- Local launcher, package preflight, regression/eval/completion/operator
  scripts.
- Generated DOCX/XLSX support used by the broader document workflow.

Stage:

```bash
git add -- \
  backend/.env.example \
  backend/package.json \
  backend/package-lock.json \
  backend/src/lib/aletheia/domain.ts \
  backend/src/lib/aletheia/index.ts \
  backend/src/lib/aletheia/localRepository.ts \
  backend/src/lib/aletheia/repository.ts \
  backend/src/lib/aletheia/documentParser.ts \
  backend/src/lib/generatedOffice.ts \
  backend/src/middleware/auth.ts \
  backend/src/routes/aletheia.ts \
  backend/src/routes/documents.ts \
  backend/src/routes/projects.ts \
  backend/src/mcp/aletheiaServer.ts \
  backend/src/scripts/aletheiaCompletionAudit.ts \
  backend/src/scripts/aletheiaLocalLauncher.ts \
  backend/src/scripts/aletheiaLocalRegression.ts \
  backend/src/scripts/aletheiaOperatorHealth.ts \
  backend/src/scripts/aletheiaPackageLocal.ts \
  backend/src/scripts/aletheiaRetrievalEval.ts \
  backend/src/scripts/aletheiaSeedUiSmoke.ts
```

Verify:

```bash
cd backend && npm run build
cd backend && npm run check:aletheia:operator
cd backend && npm run test:aletheia:local
cd backend && npm run test:aletheia:retrieval-eval
cd backend && npm run test:aletheia:completion
```

## Commit 2: Aletheia Frontend Workspace

Suggested message:

```text
feat(frontend): build local Aletheia workspace
```

Scope:

- Remote matter workspace, Run Trace, sidebar, Matter Memory, Playbooks.
- Evidence, Review, and Audit registry pages.
- Template preview pages and local pilot positioning.
- Frontend API client for local Aletheia routes.
- Deterministic fallback fixtures and type updates.

Stage:

```bash
git add -- \
  frontend/src/aletheia/AletheiaWorkspace.tsx \
  frontend/src/aletheia/RemoteMatterPage.tsx \
  frontend/src/aletheia/TemplateMockPage.tsx \
  frontend/src/aletheia/mockData.ts \
  frontend/src/aletheia/types.ts \
  frontend/src/aletheia/AletheiaAuditWorkbench.tsx \
  frontend/src/aletheia/AletheiaEvidenceRegistry.tsx \
  frontend/src/aletheia/AletheiaReviewRegistry.tsx \
  frontend/src/aletheia/RemoteMatterRunTrace.tsx \
  frontend/src/aletheia/RemoteMatterSidebar.tsx \
  frontend/src/aletheia/TemplatePreviewPage.tsx \
  frontend/src/aletheia/remoteMatterTransforms.ts \
  frontend/src/app/aletheia/audit/page.tsx \
  frontend/src/app/aletheia/evidence/page.tsx \
  frontend/src/app/aletheia/reviews/page.tsx \
  'frontend/src/app/aletheia/templates/[template]/page.tsx' \
  frontend/src/app/aletheia/templates/page.tsx \
  frontend/src/app/lib/aletheiaApi.ts
```

Verify:

```bash
cd frontend && npx tsc --noEmit
cd frontend && npm run lint
cd frontend && npm run build
```

## Commit 3: Inherited Frontend Hardening

Suggested message:

```text
chore(frontend): align inherited app surfaces with Aletheia
```

Scope:

- Base app metadata, font loading, icon rendering, and label typing cleanup.
- Account/security/connectors and project/document UI alignment.
- Assistant, tabular, workflow, and shared component fixes needed to keep the
  inherited app compiling cleanly under the stricter frontend baseline.
- Document upload and generated Office workflow UI adjustments.

Stage:

```bash
git add -- \
  'frontend/src/app/(pages)/account/connectors/page.tsx' \
  'frontend/src/app/(pages)/account/page.tsx' \
  'frontend/src/app/(pages)/account/security/page.tsx' \
  'frontend/src/app/(pages)/layout.tsx' \
  'frontend/src/app/(pages)/projects/[id]/assistant/chat/[chatId]/page.tsx' \
  frontend/src/app/components/assistant/AssistantMessage.tsx \
  frontend/src/app/components/assistant/CaseLawPanel.tsx \
  frontend/src/app/components/assistant/ChatView.tsx \
  frontend/src/app/components/modals/credits-exhausted-modal.tsx \
  frontend/src/app/components/modals/delete-chats-modal.tsx \
  frontend/src/app/components/modals/simple-link-dialog.tsx \
  frontend/src/app/components/projects/DocumentSidePanel.tsx \
  frontend/src/app/components/projects/ProjectDocumentsView.tsx \
  frontend/src/app/components/projects/ProjectExplorer.tsx \
  frontend/src/app/components/projects/ProjectPageParts.tsx \
  frontend/src/app/components/projects/ProjectsOverview.tsx \
  frontend/src/app/components/shared/AddProjectDocsModal.tsx \
  frontend/src/app/components/shared/DocPanel.tsx \
  frontend/src/app/components/shared/DocView.tsx \
  frontend/src/app/components/shared/DocViewModal.tsx \
  frontend/src/app/components/shared/DocumentCard.tsx \
  frontend/src/app/components/shared/DocxView.tsx \
  frontend/src/app/components/shared/FileDirectory.tsx \
  frontend/src/app/components/shared/MfaLoginGate.tsx \
  frontend/src/app/components/shared/MfaVerificationPopup.tsx \
  frontend/src/app/components/shared/PreResponseWrapper.tsx \
  frontend/src/app/components/shared/RelevantQuotes.tsx \
  frontend/src/app/components/shared/types.ts \
  frontend/src/app/components/shared/useDirectoryData.ts \
  frontend/src/app/components/tabular/TRChatPanel.tsx \
  frontend/src/app/components/tabular/TRSidePanel.tsx \
  frontend/src/app/components/tabular/TabularCell.tsx \
  frontend/src/app/components/workflows/DisplayWorkflowModal.tsx \
  frontend/src/app/components/workflows/NewWorkflowModal.tsx \
  frontend/src/app/components/workflows/WFColumnViewModal.tsx \
  frontend/src/app/components/workflows/WorkflowDetailPage.tsx \
  frontend/src/app/components/workflows/WorkflowList.tsx \
  frontend/src/app/components/workflows/WorkflowPickerContent.tsx \
  frontend/src/app/contexts/ChatHistoryContext.tsx \
  frontend/src/app/globals.css \
  frontend/src/app/hooks/useFetchDocxBytes.ts \
  frontend/src/app/hooks/useSelectedModel.ts \
  frontend/src/app/layout.tsx \
  frontend/src/app/lib/documentUploadValidation.ts \
  frontend/src/app/login/page.tsx \
  frontend/src/app/support/page.tsx \
  frontend/src/components/chat/aletheia-icon.tsx \
  frontend/src/components/ui/text-search-widget.tsx \
  frontend/src/lib/label.ts \
  frontend/src/scripts/convert-courts-to-ts.js
```

Verify:

```bash
cd frontend && npx tsc --noEmit
cd frontend && npm run lint
cd frontend && npm run build
```

## Commit 4: Frontend Smoke Test Harness

Suggested message:

```text
test(frontend): add Aletheia UI smoke coverage
```

Scope:

- Playwright config, scripts, snapshots, and isolated smoke build directory.
- UI smoke coverage for local workspace, approval gates, registries, templates,
  and product-facing local pilot wording.
- Git ignores for local data, test results, reports, and smoke build output.

Stage:

```bash
git add -- \
  .gitignore \
  frontend/eslint.config.mjs \
  frontend/next.config.ts \
  frontend/package.json \
  frontend/package-lock.json \
  frontend/tsconfig.json \
  frontend/playwright.config.ts \
  frontend/tests/aletheia-ui-smoke.global-setup.ts \
  frontend/tests/aletheia-ui-smoke.spec.ts \
  frontend/tests/aletheia-ui-smoke.spec.ts-snapshots/aletheia-workspace-initial-desktop-chromium-darwin.png \
  frontend/tests/aletheia-ui-smoke.spec.ts-snapshots/aletheia-workspace-initial-mobile-chromium-darwin.png
```

Verify:

```bash
cd frontend && npm run test:aletheia:ui
cd frontend && npm run build
```

## Commit 5: Documentation And Release Evidence

Suggested message:

```text
docs: document Aletheia local-first pilot
```

Scope:

- Product README updates in English and Chinese.
- Architecture, runtime, deployment, private packaging, retrieval, MCP/tool
  adapter, Hermes inspiration, attribution, release status, and demo evidence.
- Screenshot evidence for the local-first MVP.
- This commit plan.

Stage:

```bash
git add -- \
  README.md \
  README_CN.md \
  docs/architecture.md \
  docs/license_attribution.md \
  docs/local_first_runtime.md \
  docs/safe-local-testing.md \
  docs/agent_runtime_roadmap.md \
  docs/aletheia_tool_adapter.md \
  docs/demo_evidence.md \
  docs/desktop_packaging_checklist.md \
  docs/hermes_inspiration.md \
  docs/hybrid_retrieval.md \
  docs/local_deployment.md \
  docs/private_deployment.md \
  docs/release_notes_local_first_mvp.md \
  docs/retrieval_eval.md \
  docs/status.md \
  docs/third_party_notices.md \
  docs/ui_smoke.md \
  docs/commit_plan.md \
  docs/screenshots/aletheia-home-desktop.jpg \
  docs/screenshots/aletheia-matter-mobile.jpg \
  docs/screenshots/aletheia-matter-overview-desktop.jpg \
  docs/screenshots/aletheia-run-trace-desktop.jpg
```

Verify:

```bash
git diff --check
cd backend && npm run test:aletheia:completion
```

## Final Full Validation

Run once after all groups are staged or committed:

```bash
cd backend && npm run build
cd backend && npm run check:aletheia:operator
cd backend && npm run test:aletheia:local
cd backend && npm run test:aletheia:retrieval-eval
cd backend && npm run test:aletheia:package
cd backend && npm run test:aletheia:completion
cd frontend && npx tsc --noEmit
cd frontend && npm run lint
cd frontend && npm run build
cd frontend && npm run test:aletheia:ui
git diff --check
```

## Known Review Notes

- `backend/src/lib/aletheia/localRepository.ts` and
  `frontend/src/app/lib/aletheiaApi.ts` are intentionally large and should be
  reviewed carefully before commit. Splitting them hunk-by-hunk is possible but
  would be slower and higher risk at this stage.
- Aletheia uses the local SQLite/filesystem repository unconditionally.
- `node:sqlite` emits an ExperimentalWarning during local tests. This is
  expected with the current Node runtime.
- The remaining changes should not be committed as one patch. Use the groups
  above in order.
