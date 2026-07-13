# Vera document drafts UI audit

Date: 2026-07-11
Surface: Civil litigation / Documents & Hearing / Document drafts
Runtime: Playwright production build against the local Terra backend

## Sol verdict

**APPROVED.** The workspace reads as a professional drafting tool rather than a simulated word processor. The hierarchy remains dense and unframed: draft register, counsel-editable structured text, locked provenance, immutable-version review, and backend-computed diff are distinct without nested cards or decorative effects.

The source projection is visibly read-only. Counsel can edit headings and bodies for legal-work sections, but cannot edit the stable section IDs, source section, source hashes, dependency hash, or version provenance. Approval is presented beside the exact immutable version hash. A stale active draft locks editing and review, preserves read access to its server-computed historical diff, and retains an explicit, reasoned withdrawal remedy. Once withdrawn, all further writes remain locked and the backend independently rejects them with `409 Conflict`.

## Captures

| Evidence | Viewport | Observed layout |
| --- | ---: | --- |
| `01-approved-diff-desktop-1440.png` | 1440 x 1000 | 220 px draft register, fluid editor, 280 px provenance/review rail |
| `02-approved-diff-narrow-900.png` | 900 x 1000 | Register, editor, and provenance stack into one readable flow |
| `03-approved-diff-mobile-393.png` | 393 x 852 | Creation controls remain operable; hashes wrap; editor stays within a 353 px content width |

## Measurements

| Viewport | Visible shell header | Workspace clearance | Horizontal overflow | Header/content overlap |
| ---: | ---: | ---: | ---: | ---: |
| 1440 | 46 px desktop top bar | 12 px before the workspace title | <= 1 px test tolerance | <= 1 px test tolerance |
| 900 | 46 px desktop top bar | 6 px before the workspace title | <= 1 px test tolerance | <= 1 px test tolerance |
| 393 | 48 px brand row + 47 px nav row | 5 px before the workspace title | <= 1 px test tolerance | <= 1 px test tolerance |

Measurements were taken from the current-running PNGs and the capture-time DOM assertions in `aletheia-litigation-workspace.spec.ts`. Each capture asserts `document.documentElement.scrollWidth <= window.innerWidth + 1`; the mobile shell assertion also requires the mobile header bottom and scroll container top to overlap by no more than 1 px.

## Interaction checks

- Created a document from a current `litigation_brief` artifact using a real backend write; initial sections and source text came from the server response.
- Saved v2 with `baseVersion: 1`, a mandatory change summary, preserved stable section IDs, and an unchanged read-only source section.
- Loaded the server diff and verified `material-facts` was `modified` while `sources` remained `unchanged`.
- Approved the latest version by its version ID and confirmed the exact v2 content hash remained visible with the review result.
- Changed confirmed matter state and observed the original draft become stale with editing and review locked. Compared v1 to v2 again, verified the server returned `document.stale: true`, and confirmed both the `modified` counsel section and `unchanged` source section remained visible under “Historical diff · source binding stale.” A direct stale version write still failed with `409`.
- Entered a reason and withdrew that original stale draft through the UI, verified the successful response and the visible `litigation_document_draft_withdrawn` audit event with `stale: true`, then confirmed a further withdrawn write failed with `409`.

No clipping, incoherent overlap, illegible hash treatment, or blocking narrow-width defect was observed in the three captures.

Follow-up review: stale-state withdrawal and historical-diff transparency change controls and status text only after the source becomes stale. The captured approved, active v2 state is unchanged, so the existing 1440, 900, and 393 PNGs remain current and were re-inspected without unnecessary recapture.
