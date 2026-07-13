# Vera Court Calendars UI Audit

Date: 2026-07-12

## Sol verdict

**PASS**

The Procedural Clock now provides a restrained, source-bound court-calendar
workspace. Immutable draft versions can be verified or retired; verified
versions can bind business-day deadline rules; calculated deadlines expose the
calendar version, hash, algorithm, and per-day treatment. Calendar retirement
retires dependent rules and leaves persisted stale deadline and invalidated task
recovery states. Existing calendar-day and procedural-event correction flows
remain covered.

## Evidence

- `01-verified-calendar-1440x1000.png`: calendar draft controls, weekly closures,
  dated exceptions, source authority, immutable version detail, and verified
  state at 1440 x 1000.
- `02-business-day-trace-900x1000.png`: business-day metadata and date trace at
  900 x 1000.
- `03-business-day-trace-393x852.png`: mobile trace and adjacent procedural
  controls at 393 x 852.

At all three viewports, Playwright asserted document and main-scroller horizontal
overflow, mobile-header overlap, horizontal control clipping, and pairwise
control overlap. The checks ran in both desktop and mobile projects; screenshots
were emitted from desktop Chromium to avoid concurrent writes.

## Verification

Focused real-backend lifecycle:

```text
ALETHEIA_UI_SMOKE_FRONTEND_PORT=3420 ALETHEIA_UI_SMOKE_BACKEND_PORT=3421 \
ALETHEIA_UI_SMOKE_DATA_DIR=/tmp/aletheia-court-calendar-focused-data \
ALETHEIA_CAPTURE_COURT_CALENDARS=true \
npx playwright test --config=/tmp/aletheia-court-calendar-focused.config.ts \
  aletheia-litigation-workspace.spec.ts --project=desktop-chromium \
  -g "binds business-day deadlines"
```

Result: 1 passed, 0 failed, 14.0 seconds.

Full litigation desktop and mobile suite:

```text
ALETHEIA_CAPTURE_COURT_CALENDARS=true npx playwright test \
  --config=playwright.config.ts tests/aletheia-litigation-workspace.spec.ts
```

Result: 20 discovered, 18 passed, 2 skipped, 0 failed, 1.0 minute. The two
skips are the existing semantic-advice cases gated by
`ALETHEIA_FINDING_ENTAILMENT_FIXTURE=1`.

Static and production checks:

```text
npx eslint src/app/lib/aletheiaApi.ts \
  src/aletheia/litigation/LitigationWorkspace.tsx \
  tests/aletheia-litigation-workspace.spec.ts
npx tsc --noEmit
npm run build
```

Result: ESLint passed with 0 errors; TypeScript passed with 0 errors; production
build passed, including 17/17 static pages and the litigation dynamic route.

## Covered behavior

- Verified legal authority creation and source binding.
- Calendar draft creation with Saturday/Sunday closures, a dated closure, and
  an open make-up day.
- Draft calendar rejection for business-day rule creation.
- Calendar verification, business-day rule creation and verification, confirmed
  event calculation, exact due date, confirmation, and work-queue task creation.
- Trace labels for regular working day, weekly closure, dated closure, and open
  make-up day.
- Calendar retirement cascade across rule, deadline, and task, including refresh
  persistence and exclusion of the retired version from new rules.
- Malformed duplicate overrides, cross-matter access, short retirement reason,
  and repeated retirement rejection.
- Existing calendar-day rule and immutable event-correction workflows.

## Residual risks

- Browser evidence is Chromium-only; native date and select rendering can differ
  in WebKit and Firefox.
- E2E uses local single-user authentication and Asia/Shanghai, matching the
  current backend contract; multi-user hosted auth and other timezones are not
  exercised here.
- The optional semantic-advice fixture remains outside this court-calendar audit
  and accounts for the two intentional skips.
