# Work Task Version Regression - 2026-07-21

Base commit: `8f131d4908440bbb482c6f87e2b1f4ef392f0e98`.

This QA run uses a no-sensitive synthetic DOCX. It exercises: upload V1, test-generated tracked-change V2, V2 approval, manual accept/reject to V3/V4, review-required derivation, old V2 locked export, V4 reapproval, latest-current export, Assistant tab switching, DocumentSidePanel version selection, version-bound citation location, restart state hydration, and DOCX reopen checks.

## Evidence

- `version-table.md`: exact version table with storage paths and QA hashes.
- `work-task-version-regression.json`: machine-readable run evidence.
- `screenshots/01-version-export-1440x900.png`: version/export evidence screenshot.
- `screenshots/02-ui-state-1440x900.png`: UI state-model evidence screenshot.
- `files/`: generated V1-V4 DOCX files.
- `pdf/`: LibreOffice-opened PDF conversions of V1-V4.

## Result

- PASS: V2 approval remains locked after V3/V4 are created.
- PASS: V3/V4 creation derives `review_required` from version divergence.
- PASS: V4 reapproval updates the latest approved artifact snapshot, so current final export resolves to V4.
- PASS: old V2 approval history remains exportable by its locked snapshot, while current final export uses the latest V4 approval.
- PASS: Assistant document/edit tabs switch to new `current_version_id`; case tabs are untouched.
- PASS: DocumentSidePanel current view selects V4 after reload, while explicit citation links still open cited V2.
- PASS: persisted edit annotations hydrate to accepted/rejected after restart via `document_edits` status.
- PASS: all generated DOCX files reopen with LibreOffice headless and Microsoft Word automation.

## Commands

- PASS: `npx tsx scripts/documentEditResolutionIntegrationSmoke.ts`
- PASS: `npm run test:agent-task-review-version`
- PASS: focused backend `tsc` over document resolution, review versioning, and tab-version helper files.
- PASS: frontend `npx tsc --noEmit --pretty false`
- PASS: `file` identified V1-V4 as Microsoft Word 2007+ DOCX, V1-V4 conversions as PDF, and both screenshots as 1440x900 PNG.
- BLOCKED: backend `npm run build` still fails on pre-existing untracked Aletheia/workspace files with missing modules.
- BLOCKED: frontend `npm run build` compiles and passes TypeScript, then fails prerendering `/account/api-keys` because local `supabaseUrl` is not configured.

No product code changed in this QA pass.
