# Litigation audit signoff anchor UI audit

Date: 2026-07-12

## Formal Sol verdict

**PASS.** The final desktop and mobile evidence presents the server-derived anchor result clearly, preserves historical audit-head coverage after the package becomes stale, and maintains the legal assurance boundary without visual ambiguity.

## Final evidence

- `01-anchored-receipt-900x1100.png`: current package receipt with exact audit-head coverage verified, anchor index, Ed25519 `key_id`, anchored time, and full anchor hash.
- `02-stale-anchored-receipt-393x852.png`: stale package receipt retaining the previously verified exact audit-head coverage and complete assurance statement.

Focused real-backend Playwright validation passed on desktop and mobile: **2 passed in 37.7 seconds**. The temporary Ed25519 keypair is generated once by the backend webServer fixture.

## Visual review

- No horizontal page overflow, clipped receipt metadata, incoherent overlap, or control occlusion is visible at either 900 px or 393 px.
- Long receipt and anchor hashes remain inside the receipt geometry: they fit the desktop content column and wrap cleanly on mobile.
- Desktop metadata uses balanced columns with stable label/value alignment. Mobile metadata collapses into a readable single-column sequence without crowding.
- Integrity, package currency, and independent-review values remain distinct. The stale package is red while verified historical anchor coverage remains green, so historical proof is not mistaken for current package status.
- The anchored proof shows no Anchor action, consistent with the server returning `can_anchor=false`. Action visibility is governed by the server-provided `can_anchor` value rather than client-side role inference.
- Exact historical coverage remains visible after the matter audit head advances: anchor index, anchor hash, Ed25519 `key_id`, and anchored time are all retained.
- The assurance boundary is prominent and terse: this is not a qualified electronic signature, trusted timestamp, or independent notarization.
- The interface uses restrained rules and unframed rows, with no gradients, glow, glass, decorative cards, pills, or promotional treatment.

## Signoff

Formal Sol visual review: **PASS** for the litigation audit signoff anchor receipt at the audited desktop and mobile viewports.
