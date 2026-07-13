# In-viewer verification visual audit

Date: 2026-07-12

## Evidence

- `in-viewer-verification-desktop-1440x1000.png`: recorded page 2 equals currently displayed page 2; the PDF canvas is nonblank; the failed verification state preserves the entered reason and exposes retry without backend detail leakage.
- `in-viewer-verification-mobile-393x1200.png`: clean narrow composition containing the viewer header, recorded/current page values, exact quote, reason, enabled submit action, and footer with no clipped text.

The focused test also checks the actual 393x852 viewport before the taller capture. The comparison inspector has independent vertical scrolling, a positive scroll range, and a center-point hit-test on the visible submit button. Geometry assertions cover document/viewer/inspector overflow, footer occlusion, control collisions, canvas/inspector overlap, and nonblank canvas pixels. The request fixture confirms no verification call occurs while page 3 is displayed or after saving the original; submission occurs only after returning to recorded page 2.

## Commands and results

Run from `frontend/`:

```sh
npx eslint tests/aletheia-litigation-workspace.spec.ts
```

Result: PASS (exit 0, no output).

```sh
npx tsc --noEmit --pretty false
```

Result: PASS (exit 0, no output).

```sh
npx playwright test tests/aletheia-litigation-workspace.spec.ts --project=desktop-chromium --grep "source citation inspector records an explicit counsel text comparison and preserves retry state"
```

Final result: PASS, 1 passed in 42.0s. An initial audit iteration failed because the scroll-range assertion applied to the intentionally taller 393x1200 evidence viewport; the assertion was narrowed to the required 393x852 operability checkpoint and the same focused command then passed.

No standalone full-build command or broad test suite was run. The focused Playwright harness performed only its configured isolated web-server setup for this test.

## Verdict

FINAL SOL PASS
