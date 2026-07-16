# Sol visual review: Vera legal research

Date: 2026-07-12

## Scope reviewed

The Matter workspace now exposes `法律研究` as a first-level litigation view. The surface is a local, persisted research workbench rather than a chat interface. It covers:

- local research requests;
- a lawyer-editable local issue tree with one root and direct child issues;
- side-by-side internal legal question and exact redacted outbound query;
- separate request, decision, and execution controls for query search and source fetch;
- selectable Pkulaw, Wolters, and official legal-source APIs; the official provider remains gated by environment configuration and an allowlist;
- candidates, immutable local source snapshots, and exact lawyer-confirmed excerpts;
- excerpt-bound input manifests;
- lawyer-authored conclusions, human review, acceptance, and `依据不足` as a normal result.
- a final legal-opinion step that selects only a current accepted `legal_qa_answer`, records limited cover fields, completes an independent review, approves the opinion, and exports/downloads DOCX.

The issue tree uses `POST/GET /aletheia/matters/:matterId/research/requests/:requestId/issues`. It is saved independently and does not generate, prefill, dispatch, or approve a query. Query preview is fail-closed until that endpoint has returned a persisted issue-tree work product; the UI then sends its exact `issueTreeId` with the preview request.

The legal-opinion step uses the persisted fail-closed routes directly: `POST /legal-opinions`, the existing review-resolution route, `POST /legal-opinions/:opinionId/approve`, `POST /legal-opinions/:opinionId/docx`, and `GET /legal-opinion-exports/:exportId/download`. Matter detail remains the source of truth after every mutation. The UI does not synthesize opinion content or retain a client-only approval state.

## Visual findings

- **Hierarchy:** Pass. The four stages read in legal-work order: local issues, outbound query approval, source capture, then excerpt-bound conclusion.
- **Density:** Pass. Desktop uses a narrow request index and a dense work surface without nested decorative cards. Metadata, hashes, states, and actions remain scannable.
- **Action semantics:** Pass. Approval and network execution are visibly separate. A successful approval still leaves an explicit `执行一次检索` or `下载并保存快照` action.
- **Issue-tree binding:** Pass. An unsaved editor state cannot produce a query preview. The disabled action is paired with `请先保存当前争点树，脱敏预览将绑定该持久化版本。`; after save, only the returned work-product ID enables preview and enters the API payload.
- **Local/network boundary:** Pass. Internal facts and questions are visually separated from the exact outbound text. No credential or raw secret is rendered.
- **Provider choice:** Pass. `官方来源（仅明确授权的来源专属接口）` is available in the existing restrained native selector without changing the workbench layout. Selecting it sends the typed `official` provider; availability still fails closed when environment configuration or allowlisting is absent.
- **Conclusion integrity:** Pass. The interface provides no generated answer. Counsel must write the conclusion; only excerpts in the current manifest enable submission. `依据不足` is displayed as an ordinary amber status, not an error or marketing empty state.
- **Opinion integrity:** Pass. The selector contains only current, non-stale accepted research answers. Creation exposes only title, addressee, lawyer reference, and limitation; opinion sections come from the persisted accepted answer binding.
- **Independent review and export:** Pass. The opinion starts at `待复核`, uses the existing recorded review-resolution flow, requires a separate approval, and exposes DOCX export only after approval. Empty, missing-review, stale/superseded, and request-failure states are explicit; stale versions cannot be approved or exported.
- **Responsive behavior:** Pass at a 393 CSS-pixel viewport. Navigation, issue controls, comparison fields, hashes, and conclusion rows produce no document-level horizontal overflow or text occlusion. The PNG is 1081 physical pixels wide because the Playwright mobile device scale factor is 2.75.
- **Style:** Pass. No gradients, glows, glass, decorative pills, sparkle/AI symbols, or marketing empty states were introduced. Borders, typography, icons, and restrained gray/amber/green status color follow the existing Vera/macOS tool language.

## Screenshots

- `docs/screenshots/product-convergence-research-desktop.png` - desktop persisted workflow with the editable issue tree.
- `docs/screenshots/product-convergence-research-narrow-393.png` - 393px main research view.
- `docs/screenshots/product-convergence-research-issue-required-desktop.png` - desktop unsaved-tree block with disabled preview action.
- `docs/screenshots/product-convergence-research-issue-required-narrow-393.png` - 393px unsaved-tree block with adjacent recovery guidance.
- `docs/screenshots/product-convergence-research-unavailable-desktop.png` - desktop fail-closed data-source state.
- `docs/screenshots/product-convergence-research-unavailable-narrow-393.png` - 393px fail-closed data-source state.
- `docs/screenshots/product-convergence-legal-opinion-desktop.png` - desktop approved legal opinion with the persisted DOCX action.
- `docs/screenshots/product-convergence-legal-opinion-narrow-393.png` - 393px approved legal opinion flow without horizontal overflow.

## Verification

Run from `frontend/` unless noted:

| Command | Result |
| --- | --- |
| `npm run lint` | Passed, no warnings or errors. |
| `npx tsc --noEmit` | Passed. |
| `npm run build` | Passed; Next.js 16.2.6 production build compiled, typechecked, generated 17 static pages, and completed route optimization. |
| `npx playwright test tests/vera-legal-research.spec.ts --project=desktop-chromium --project=mobile-chromium` | Passed: 4 tests in 40.1s. Desktop and 393px covered the existing research gates plus accepted-answer selection, limited cover payload, persisted opinion creation, independent review resolution, approval, DOCX export, download, and no horizontal overflow. |

The Playwright unavailable test uses the real local backend and verifies that no preview request can occur before issue-tree persistence, the saved issue-tree response ID and selected `official` provider are sent with the preview request, and request, issue tree, and query-plan work products survive reload. The mature-state visual test uses a controlled Matter projection because the backend correctly rejects generic creation of broker-owned research work products. Its opinion sequence intercepts the production endpoint paths with deterministic persisted responses and asserts each payload and transition; it does not simulate a model or bypass a UI gate. Backend audit suites were not rerun in this frontend-only pass, and no backend file was modified.

## Remaining limitations

- No authorized Pkulaw, Wolters, or configured and allowlisted official-source credential was available in the test environment, so no live source search or download was performed. The UI correctly shows `legal_source_unavailable` and does not fall back.
- Query and source approvals are intentionally single-use. The current Matter detail response does not expose a reusable approval projection, so a page reload does not reconstruct an unconsumed in-session approval button state; persisted plans, candidates, snapshots, excerpts, manifests, and memos do reconstruct.
- The issue editor intentionally supports one root and direct children only. The backend supports deeper trees, but deeper editing is deferred to avoid adding hierarchy management beyond the requested minimum.
- Legal correctness, source completeness, and semantic support remain lawyer-review responsibilities. Deterministic gates prove binding and required metadata, not the correctness of a legal opinion.
