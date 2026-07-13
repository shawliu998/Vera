# Vera Position Authority Readiness UI Audit

Date: 2026-07-12

## Sol Verdict

**PASS**

The reviewed frontend uses the backend `position_authority_statuses` projection as the authority for every proposed and confirmed legal position. Missing and invalid authority remain separate from the lawyer's position decision: counsel can preserve a confirmation history, while Agent input, approval-ready documents, and export remain fail closed until a verified exact-quote authority is active.

## Verified Behavior

- Claims & Defenses renders `satisfied`, `missing`, or `invalid` for each proposed or confirmed position without pills or AI styling.
- The authority selector includes proposed and confirmed positions and shows both decision state and current authority readiness.
- A verified exact quote can be linked while a position is still proposed. Confirmation then records the authority in the structured legal-assessment snapshot.
- A confirmed position without qualifying authority produces `verified_legal_authority_missing` and is excluded from the Agent snapshot.
- A satisfied confirmed position is present in the legal-position artifact and Agent snapshot after refresh.
- Withdrawing the final qualifying link changes readiness to `missing`, marks the existing artifact stale, and removes that position from the Agent snapshot.
- Draft, retired, tampered-quote, out-of-period, cross-matter, short verification reason, and short applicability rationale writes are rejected by the real backend.
- Legacy array and current `{ evidenceSources, legalAuthorities }` assessment snapshots are both rendered safely.

## Commands And Counts

```text
npx playwright test --config=playwright.config.ts tests/aletheia-litigation-workspace.spec.ts --grep "position authority readiness" --project=desktop-chromium
1 passed

npx playwright test --config=playwright.config.ts tests/aletheia-litigation-workspace.spec.ts --grep "position authority readiness" --project=mobile-chromium
1 passed

npx playwright test --config=playwright.config.ts tests/aletheia-litigation-workspace.spec.ts
20 collected: 18 passed, 2 skipped, 0 failed

npm run lint
PASS, 0 errors

npx tsc --noEmit
PASS, 0 errors

npm run build
PASS, 17 application routes generated
```

The two skipped full-suite cases are the existing local semantic-model advice test on desktop and mobile; they require the opt-in `ALETHEIA_FINDING_ENTAILMENT_FIXTURE=1` model fixture and are outside this authority-readiness flow. The real backend authority test ran on both projects.

## Screenshots

1. `01-missing-gate-proposed-selector-1440x1000.png` - proposed position, missing authority gate, proposed selector option.
2. `02-satisfied-authority-artifact-agent-eligible-900x1000.png` - confirmed position, satisfied authority, Agent/document/export eligibility copy.
3. `03-withdrawn-missing-recovery-393x852.png` - withdrawn final link, confirmed position returned to missing readiness, withdrawal reason and quote hash retained.

For every capture, the Playwright audit required document overflow `<= 1px`, shell-header overlap `<= 1px`, no horizontally clipped visible controls, and no painted control intersections after scroll-container clipping.

## Residual Risk

- Packaged macOS rendering was not exercised; screenshots use production-built Next.js in Chromium against the local real backend.
- The semantic local-model advice test remains opt-in as noted above. Authority inclusion/exclusion was verified directly against the persisted server-built Agent snapshot, without requiring a model run.
- Readiness deliberately depends on the backend projection. If a future backend omits the field, the UI fails closed to `missing` rather than inferring satisfaction from client-side link data.
