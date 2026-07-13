# Legal Authority Versions UI Audit

Date: 2026-07-11

## Flow

1. Draft creation - healthy. Counsel records the authority identity, named source
   reference, full source text, and an exact effective interval. The created row
   is visibly Draft.
2. Refresh and inspection - healthy. The list response remains metadata-only;
   selecting the restored version performs the detail GET and displays the full
   stored text.
3. Source check and verification - healthy. A written reason is required, and
   the UI says counsel checked the text against the named source reference. The
   SHA-256 is described only as an integrity fingerprint, not authenticity proof.
4. Position link - healthy. Only confirmed positions are offered. Applicability
   date, provision reference, exact stored quote, and rationale are required.
   Backend exact-quote errors are displayed in the workspace.
5. Withdrawal and retirement - healthy. Active/Withdrawn link state and
   Draft/Verified/Retired version state use explicit text and separate lifecycle
   reasons; they do not rely on color alone.

## Evidence

- `01-active-link-desktop-1440.png`: active position-authority link and verified
  source-check context at the 1440 x 1000 viewport.
- `02-retired-withdrawn-900.png`: retired version with its exact interval, named
  source, integrity hash, source-check reason, and stored source text at 900 x
  1000. The withdrawn link remains recorded below the captured fold.
- `03-retired-mobile-393.png`: retired version list and detail at the 393 x 852
  CSS-pixel viewport (1081 x 2343 device-pixel PNG).

Playwright measured no document-level horizontal overflow at 1440px, 900px, or
393px. It also compared the visible shell-header bottom with the internal scroll
viewport top at each size and found no overlap.

## Accessibility Limits

The tested controls have programmatic labels, status is not color-only, and the
backend validation message uses `role="alert"`. Screenshots cannot establish
full keyboard order, screen-reader announcement quality, or contrast compliance;
those remain runtime accessibility checks outside this visual audit.

## Verification

- `npm run lint`: pass.
- `npx tsc --noEmit`: pass when run serially after the production build.
- `npm run build`: pass.
- Full `aletheia-litigation-workspace.spec.ts` on desktop and mobile Chromium:
  12 passed.
- The authority test performs real local-backend POST/GET writes for create,
  refresh detail, verify, link, withdraw, and retire; it also asserts submitted
  bodies and the backend exact-quote rejection.

## Sol Conclusion

Approved for the legal-authority version workflow. The interface stays within
Claims & Defenses and uses compact rows, borders, and stable form controls rather
than nested cards or decorative status pills. Version and link lifecycles are
unambiguous, full text survives refresh through the detail endpoint, and the copy
does not overstate what verification or hashing proves. The 900px and 393px
layouts reflow without clipped controls, document overflow, or header occlusion.
