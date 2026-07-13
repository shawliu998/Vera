# Vera procedural-event corrections UI audit

## Sol verdict

**PASS.** The correction workflow is fit for the restrained Vera litigation workspace. It records an immutable replacement instead of editing a confirmed event in place, exposes event and correction hashes, locks superseded versions, invalidates dependent work, and selects only the current confirmed replacement for a separate deadline recalculation.

## Evidence

- `01-correction-result-1440.png` — 1440 x 1000: correction result, invalidation counts, separate-confirmation notice, and replacement selected in the verified-rule control.
- `02-lineage-stale-deadline-900.png` — 900 x 1000: superseded v1 lineage, correction reason/hash, current confirmed v2, correction lock, and stale old deadline.
- `03-mobile-correction-lock-393.png` — 393 x 852: mobile lineage and immutable superseded-event lock state.

All three viewports passed automated document-overflow and mobile-header overlap measurements.

## Verification

- Full `aletheia-litigation-workspace.spec.ts`, desktop + mobile: **16 passed, 2 skipped, 0 failed**. The two skips are the existing opt-in local semantic-model fixture test, not correction coverage.
- Focused real-backend correction flow: **2 passed, 0 failed** across desktop and mobile.
- ESLint: passed with 0 errors and 0 warnings.
- TypeScript `tsc --noEmit`: passed.
- Next.js production build: passed.

The real-backend flow imports source text, creates and confirms a source-bound event, verifies a rule, calculates and confirms the first deadline, creates its task, corrects the event through the UI, verifies stale/invalidated dependents, blocks the old event from UI and direct calculation, recalculates the changed due date from v2, reloads persisted lineage, and checks malformed, no-op, superseded, and cross-matter writes fail closed.

## Residual risks

- The implementation supports selecting a new chunk and exact quote during correction, and the backend supports source override. The current E2E covers only reuse of the existing exact source, so the new-source override path remains an explicit test gap.
- The success summary is session feedback; after reload, durable evidence remains in the event lineage, correction hash/reason, stale deadline, and invalidated task rows.
- Business-day rules remain intentionally unavailable until a trusted court calendar is verified; this is unchanged and outside event correction scope.
