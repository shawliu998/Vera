# Vera DOCX round-trip UI audit

**Sol verdict: PASS**

Reviewed on 2026-07-12 against the real local backend. The document round-trip requirements are present, the requested checks pass, and the final screenshots match the tested code.

## Scope reviewed

- `frontend/src/app/lib/aletheiaApi.ts`
- `frontend/src/aletheia/litigation/LitigationWorkspace.tsx`
- `frontend/tests/aletheia-litigation-workspace.spec.ts`
- This screenshot directory

Existing changes outside that scope were not modified. The three implementation/test files already contained the prior Sol work; this review preserved it and refreshed only the screenshot evidence plus this README.

## Functional findings

- PASS: A real backend-generated DOCX is downloaded, opened with JSZip, and edited in `word/document.xml` before upload.
- PASS: A successful import creates immutable v2 with `external_docx_import` provenance and remains `unreviewed`; it does not trigger counsel approval or populate an approval reason.
- PASS: Export/import controls are in the separate **Edit in Word** workflow; counsel approval/rejection remains in **Review this hash**.
- PASS: unchanged, unresolved tracked-change, and malformed DOCX attempts fail closed as `DOCX_NO_CHANGES`, `DOCX_TRACKED_CHANGES`, and `DOCX_INVALID` and remain legible in immutable import history after refresh.
- PASS: accepted version content, provenance, import history, export selection, and server section diff survive refresh.
- PASS: stale and withdrawn drafts disable section edits, new versions, review, file selection, summary input, and import.
- PASS: historical v1 DOCX remains selectable and downloadable after v2, after staleness, and after withdrawal.
- PASS: direct stale and withdrawn version writes return HTTP 409.

## Visual review and measurements

The UI is a restrained Vera/macOS/Codex-style work surface: neutral gray shell, thin dividers, compact controls, restrained status color, and no decorative cards or gradients. Failed attempts use persistent inline text rather than transient-only feedback.

The screenshot helper checks every capture for `documentElement.scrollWidth <= innerWidth + 1` and mobile-header/scroller overlap `<= 1px`. All three checks passed. No document-workflow control text, hashes, filenames, or status text visibly overlap or clip. The accepted screenshot is intentionally centered on the scrolled Word workflow; content above the scroll viewport is not header overlap. At 393 px, the shell's top navigation intentionally scrolls horizontally and leaves a partial next-item affordance at the right edge; it remains reachable and does not create page-level overflow.

| Screenshot | Viewport | State | Result |
| --- | ---: | --- | --- |
| `01-accepted-roundtrip-1440.png` | 1440 x 1000 | Imported v2 is unreviewed; Word controls and separate counsel review are visible | PASS |
| `02-rejected-import-history-900.png` | 900 x 1000 | Three immutable rejected attempts with actionable failure details | PASS |
| `03-stale-locked-mobile-393.png` | 393 x 852 | Stale lock at mobile width with disabled import and enabled historical v1 download | PASS |

Final PNG SHA-256 values:

- `01-accepted-roundtrip-1440.png`: `4da2ac877eb99f5c712dfdc9f2ab07cbafa23d0628b4438e077ed36df85e4ab5`
- `02-rejected-import-history-900.png`: `4a0ccdf1bf781272058409469268f8fc39c26efef8d280f504652f6efb8de8f4`
- `03-stale-locked-mobile-393.png`: `9d8972ec6442af02d11c37f47f9334c43f483d1f5974d36af427d97ecefffcf8`

## Commands and results

Run from `frontend/`:

| Command | Result |
| --- | --- |
| `npm run lint` | PASS, exit 0, no diagnostics |
| `npx tsc --noEmit --pretty false` | PASS, exit 0, no diagnostics |
| `npm run build` | PASS, 17 routes built |
| `npx playwright test tests/aletheia-litigation-workspace.spec.ts --project=desktop-chromium --grep "counsel round-trips DOCX revisions, diffs, and locks document drafts"` | PASS, 1 passed, 0 failed, 38.5 s |
| `npx playwright test tests/aletheia-litigation-workspace.spec.ts --project=desktop-chromium --project=mobile-chromium` | PASS, 16 passed, 2 skipped, 0 failed, 55.6 s |
| `ALETHEIA_CAPTURE_DOCUMENT_DRAFTS=true npx playwright test tests/aletheia-litigation-workspace.spec.ts --project=desktop-chromium --grep "counsel round-trips DOCX revisions, diffs, and locks document drafts"` | PASS, 1 passed, 0 failed, 34.6 s; refreshed all three PNGs |

The two full-suite skips are the opt-in local semantic-runtime case, skipped once per project because `ALETHEIA_FINDING_ENTAILMENT_FIXTURE=1` was not enabled. They do not cover the DOCX round-trip.

## Residual risks

- The automated edit uses JSZip to make a standards-valid DOCX change; it does not launch Microsoft Word. Word-specific rendering or save-time normalization remains a manual interoperability check.
- The test exercises Chromium download/upload behavior on macOS. Native desktop bridge behavior and other operating systems are outside this UI audit.
- Playwright reports the existing Next.js warning that `next start` is used with `output: standalone`; the server starts and all requested tests pass, but deployment startup configuration should be tracked separately.
