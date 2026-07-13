# Original evidence UI audit

Date: 2026-07-12

Scope: imported-document and low-confidence citation access to stored originals.

## Evidence

- `original-evidence-desktop-1440x1000.png`: desktop Facts & Evidence view.
- `original-evidence-narrow-393x2400.png`: the same view at a 393 px viewport.

Both captures are produced by the focused Playwright layout test. The test checks
page width, command bounds, and center-point hit testing for occlusion.

## Commands and results

From `frontend/`:

```text
npx eslint src/app/lib/aletheiaApi.ts src/aletheia/originalDocumentAccess.ts src/aletheia/MatterDocumentStatusList.tsx src/aletheia/litigation/LitigationWorkspace.tsx tests/aletheia-document-import.spec.ts tests/aletheia-litigation-workspace.spec.ts
PASS (0 errors, 0 warnings)

npx tsc --noEmit
PASS

npx playwright test --config=playwright.config.ts tests/aletheia-document-import.spec.ts tests/aletheia-litigation-workspace.spec.ts --grep "(case file importer|case file status|owner can download|desktop original command|original evidence commands|civil litigation workspace keeps proposals)"
PASS: 11 passed, 1 skipped (desktop-only screenshot producer skipped in the mobile project)

npx playwright test --config=playwright.config.ts tests/aletheia-document-import.spec.ts --project=desktop-chromium --grep "original evidence commands remain clear"
PASS: 1 passed
```

The first focused Playwright attempt exposed that the cross-origin browser client
could not read non-exposed integrity response headers. It ended with 7 passed,
1 failed, 1 interrupted, and 3 not run. Main then exposed
`Content-Disposition`, `Content-Length`, and `X-Aletheia-Content-SHA256` through
`Access-Control-Expose-Headers`. The browser fallback now fails closed unless an
exact non-negative size and 64-hex SHA-256 are readable, and it creates the
short-lived object URL only after both values match the downloaded Blob.

Main integration reverification reported:

- Backend original-download audit: PASS.
- Backend build: PASS.
- Targeted frontend ESLint and `tsc --noEmit`: PASS.
- Focused Playwright: PASS, 11 passed and 1 intentional skip.
- Desktop original-save audit: PASS.

No full frontend suite or standalone frontend build was run or claimed here.

## Residual limitations

- A browser download can report that transfer started, but cannot confirm that
  the user opened the file. Desktop states can distinguish saved, opened,
  canceled, viewer-open failure, and access/integrity failure.
- External viewers control their opening position. Recorded page context is
  shown in Vera, but no page deep-link is claimed.

## Review conclusion

FINAL Sol: PASS - fail-closed browser integrity revalidation confirmed.
