# Vera Word Add-in MVP acceptance

## Visual truth

- Primary Mike Assistant truth: `../mike-work-task-alignment-2026-07-21/01-mike-reference-1728x851.png` (1728 × 851). `01-mike-assistant-reference-340x851.png` is the exact leftmost 340 × 851 crop, retaining the Mike navigation, gray selected state, compact labels, and restrained spacing without rescaling.
- Mike v0.4-derived Document side-panel density reference: `../mike-v040-baseline/project-document-preview-qa.png` (1585 × 851). That repository image already carries a Vera brand overlay, so it is a structural reference rather than pure Mike visual truth; `08-mike-derived-document-rail-reference-340x851.png` records its rightmost 340 × 851 rail.
- Vera task pane: `02-vera-browser-taskpane-340x851.png` (340 × 851).
- Same-size comparison: `03-mike-vera-side-by-side-680x851.png`, with the unscaled 340 × 851 pure Mike crop on the left and the 340 × 851 Vera pane on the right.

The Vera pane keeps Mike's restrained single-column composer language: quiet gray surfaces, compact labels, rounded controls, serif document text, a single suggestion surface, and one consequential action group. It does not copy the whole document editor or introduce a separate design system.

## Browser acceptance completed

- Production build route `/office/word?preview=ready` rendered at 340 × 851 with no console warnings or errors.
- Matter selection, suggestion generation fixture, pending-review diff, citations, disabled Office-only actions, and copy fallback are visible in the structured selection → suggestion → action path.
- Keyboard focus was visible on the native Matter selector; interactive controls are native `select`, `button`, `textarea`, and links with `focus-visible` treatment.
- `06-vera-long-chinese-340x851.png` verifies long Chinese selection and instruction text at 340 × 851. Measured document and body `scrollWidth` both remained 340 px.
- `04-vera-browser-zoom-125.png` uses a 272 × 681 CSS viewport to apply 125%-equivalent reflow pressure. `05-vera-browser-zoom-150.png` uses 227 × 567 for 150%-equivalent pressure. The 150% run measured `scrollWidth === clientWidth` (227 px).
- `07-vera-suggestion-actions-340x851.png` records the pending-review diff, source, disabled tracked-change/comment actions in browser preview, copy fallback, and the no-auto-accept notice.

These are browser tests, not Office Host tests. Preview fixtures never call the Matter chat API or mutate a document.

## Mac Word sideload acceptance still required

1. Serve the existing frontend over trusted HTTPS at the manifest origin and sideload `office-addin/word-manifest.xml` in Mac Word.
2. Confirm the ribbon command opens `/office/word` at the real task-pane width and the Vera icons render at 16, 32, and 80 px.
3. Select text and verify refresh reads the exact current selection. Change the selection after generating a suggestion and confirm both write actions reject the stale selection.
4. On a WordApi 1.4 host, apply a tracked replacement and verify it remains pending in Word, Vera does not accept it, and an initially disabled tracking mode is restored after insertion.
5. Insert the suggestion as a comment and verify the selected document text remains unchanged.
6. On WordApi below 1.4 or a restricted/read-only document, verify both Office write actions are disabled or fail clearly while copy remains available.
7. Repeat keyboard navigation, long Chinese text, 125% and 150% Word zoom, narrow/wide task-pane resizing, and visible-focus checks inside the Office Host.

## Dependency and boundary record

- No npm or backend dependency was added; the existing lockfile and build configuration are unchanged.
- Office.js is loaded from Microsoft's hosted `https://appsforoffice.microsoft.com/lib/1/hosted/office.js` endpoint, so there is no vendored library, package-size increment, or third-party license addition.
- The implementation reuses the existing Matter list, selected-model state, and project Assistant Chat stream. It adds no table, API route, permission framework, document accept/reject route, or editor integration.
