# Agent Input Binding UI Audit

Date: 2026-07-11

## Scope

Verified the counsel-reviewed retrieval workflow from retrieval and excerpt confirmation through explicit Agent-run binding. The frontend does not bind from localStorage. A saved manifest ID is recovered through GET for display only, and counsel must check the binding control for each page session.

Binding eligibility comes from `bindingEligibility` on the GET manifest response. Candidate and confirmed counts are informational only. An ineligible response disables and clears the selection and displays the backend reason. The run payload sends `retrievalManifestId` without a separate focus when binding is active.

## Evidence

- `01-binding-active-desktop.png`: 1440 x 1000 desktop viewport with the reviewed input explicitly selected.
- `02-binding-active-mobile-393.png`: Agent-run section captured from the tested 393 x 852 CSS viewport with no clipped preceding content.
- Playwright performed real POST writes for retrieval-manifest creation and excerpt confirmation in both desktop and mobile projects.
- Playwright verified GET refresh recovery, no binding persistence after refresh, authoritative eligible and ineligible states, visible fail-closed run errors, binding reset after rejection, and the submitted run payload.
- The 393px test verifies the mobile header bottom and internal scroll viewport top differ by no more than 1 CSS pixel. This rules out shell-header overlap independently of the document overflow assertion.

## Capture Framing Check

An earlier full-viewport mobile capture showed the trailing word `response.` from matter copy above the litigation subnavigation. Inspection found that Playwright had scrolled the internal content viewport while bringing the checkbox into view. The mobile shell header is outside that scroll container and its bounds do not overlap the scroll viewport, so this was capture framing rather than sticky-header occlusion. The mobile artifact was replaced with a clean section-level capture from the same 393px test state.

## Verification

- `npm run lint`: pass
- `npx tsc --noEmit`: pass
- `npm run build`: pass
- `npx playwright test tests/aletheia-litigation-workspace.spec.ts --grep "counsel explicitly binds" --project=desktop-chromium --project=mobile-chromium`: pass, 2 tests
- Final mobile rerun after capture and geometry hardening: pass, 1 test

## Sol Conclusion

Approved. The workflow makes reviewed-input binding explicit, reports candidate and confirmed counts without treating them as eligibility, admits only backend-eligible confirmed excerpts, excludes withdrawn excerpts in the copy and bound-run status, clears stale selections, surfaces backend failures, and remains readable without target-control occlusion at desktop and 393px.
