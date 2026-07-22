# Word Playbook review acceptance — 2026-07-22

This record covers the Word task pane's Matter-standard review flow. It reuses
Mike's compact desktop density and does not add a separate Vera workspace or
authentication path.

## Visual baseline

- Mike reference: `../word-addin-mvp-2026-07-21/01-mike-assistant-reference-340x851.png`
- Same-size comparison: `27-mike-vera-playbook-strict-source-comparison-680x851.png`

Both source canvases are 340 × 851. The comparison is a visual-density check,
not a claim that the Word task pane is the Mike desktop sidebar.

## Final browser evidence

The following use the existing static browser fixture
`/office/word?preview=ready&scenario=…`. The fixture supplies mock Matter data,
does not call Matter APIs, and cannot write to Word.

- `23-vera-playbook-strict-source-production-340x851.png` — standard,
  deviation, exact version-pinned source link, and source list in the review
  pane.
- `24-vera-playbook-missing-strict-source-production-340x851.png` — a missing
  or unlocatable playbook citation keeps tracked change and comment unavailable
  while Copy remains available and gives immediate local feedback.
- `25-vera-playbook-chinese-strict-source-production-227x567.png` — long
  Chinese clauses at
  the 150% equivalent narrow-window check. The browser enforces a 240 px
  minimum content width; no horizontal overflow was reported.
- `26-vera-playbook-keyboard-focus-production-272x681.png` — ArrowRight moves
  focus from Assistant to Review and retains a visible focus ring.
- `27-mike-vera-playbook-strict-source-comparison-680x851.png` — same-size
  Mike baseline on the left and current Vera review pane on the right.

## Checks

- 340 × 851 success and missing-source states: passed.
- 272 × 681 (125% equivalent): passed with no horizontal overflow.
- 227 × 567 request (150% equivalent; 240 px browser minimum): passed with no
  horizontal overflow and intact Chinese wrapping.
- Keyboard: Assistant → ArrowRight → Review: passed; active tab and focus ring
  are visible.
- Non-empty but unlocatable Matter citation at 340 × 851: passed. The preview
  has no horizontal overflow; the restriction is visible in the pane and is
  associated with both disabled write actions via `aria-describedby`.
- Regenerating an unlocatable Playbook preview: passed. The review remains
  blocked after the new result returns; it never flips to a writable state.
- Source text semantics: passed. Before a Word write, Vera reads the cited
  Matter document version through the existing authenticated endpoint and
  locates the quote in the DOCX accepted view (insertions visible, deletions
  hidden), with the same empty-body Mammoth fallback as the existing Matter
  reader. A missing, ambiguous, wrong-document, or unlocatable quote blocks
  write/comment actions.
- Browser preview: Copy provides local feedback; Word write, comment, and
  locate are unavailable because there is no Word host.

Real-host acceptance remains a separate manual step on the synthetic `/tmp`
document described in `office-addin/host-e2e/README.md`; no user document was
opened, modified, saved, or closed for this browser evidence.
