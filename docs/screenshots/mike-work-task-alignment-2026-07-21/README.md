# Mike-aligned Work Task acceptance

Date: 2026-07-21

The installed desktop session contained Vera only, so the visual truth source is the saved, previously captured Mike application screenshot in `01-mike-reference-1728x851.png`. Vera was captured before and after at the available 1152 × 768 desktop size. `06-normalized-side-by-side.png` places both captures in equal 1152 × 768 comparison frames; it is a visual comparison aid, not a claim that the original Mike window was 1152 × 768.

## Measured baseline

| Property | Mike reference | Vera task after alignment |
| --- | --- | --- |
| Sidebar | about 256 px | existing Vera/Mike sidebar unchanged, about 224 px at 1152 px |
| Primary content width | about 832 px for assistant work area | `max-width: 960px`; about 803 px at the acceptance window |
| Page title | serif, about 24/29 px | existing Mike-style page header retained |
| Task goal | compact working copy | 18/24 px, clamped to three lines |
| Surface radius | about 14 px | 12 px only around the step record; outputs remain flat rows |
| Outer/content gap | about 24 px | 24–32 px depending on available width |
| Step/row height | about 40 px | minimum 48 px for keyboard target size |
| Dividers | subtle 1 px neutral | 1 px neutral at 6–7% opacity |
| Buttons | about 32 px | 32 px pill buttons using existing components/colors |
| Status | one quiet state indicator | one existing page-header status indicator |
| Shadow | subtle surface lift | one small shadow on the run record; no card grid |

## Acceptance notes

- The former Plan / Execution / Artifacts three-column dashboard was removed from the task detail presentation.
- The reading order is goal, current Word/Excel work product, source check within its step, then optional review details.
- Review note input appears only after Approve or Request changes is invoked. Decision history, locked versions, hashes, and supporting artifacts stay folded.
- Risk matrix and review memo use the existing precise artifact links. Citation status and source positioning continue to use the existing deep-link contract.
- Native disclosure controls were verified with Space. Buttons retain visible focus styles, and citation positioning respects reduced-motion preferences.
- `04-vera-zoom-125.png` and `05-vera-zoom-150.png` confirm long copy, file rows, review actions, and the single-column step record remain readable without horizontal overflow.
