# Litigation Evidence Inventory gold-flow acceptance

Status: implementation and real-client visual acceptance in progress. Do not call this flow final or implementation-ready until every required check below is recorded.

## Visual truth and product mapping

- Mike source: [`../background-work-task-runner-2026-07-21/01-mike-reference-1152x768.png`](../background-work-task-runner-2026-07-21/01-mike-reference-1152x768.png), the nearest saved Mike Assistant shell at 1152 × 768.
- Existing Vera comparison: [`../background-work-task-runner-2026-07-21/03-mike-vera-side-by-side-2304x768.png`](../background-work-task-runner-2026-07-21/03-mike-vera-side-by-side-2304x768.png).
- Recorded gap: Mike has no saved Task-owned Tabular Review approval screen. Vera therefore keeps the Mike shell, density, typography, single primary work-product region, row actions, and existing Work Task review vocabulary; the legal increment is limited to source-bound cell review and export of one approved fixed XLSX Version.
- Lawyer role: claimant/plaintiff counsel.
- Procedural stage: first instance.
- Primary decisions: verify each generated finding against its fixed source or keep it unresolved; then approve the fixed deliverables for export.
- Input scope: the eight fixed Bluewater split-evidence DocumentVersions selected by the Task.
- Final editable Artifacts: one Matter-owned Evidence Inventory Tabular Review, one objection opinion DOCX, and one hearing outline DOCX.
- Canonical objects: Matter → Document/Version pins → AgentTask/Step receipts → one Tabular Review/cells/Citations → ArtifactLinks → final verifier identities → Review Decision → fixed export DocumentVersion.
- Conclusion-to-source path: select a finding, then use `Open cited page` to inspect the exact fixed DocumentVersion locator without leaving the review context.
- Demo fixture: `bluewater-split-evidence-2026-08-03`; synthetic/anonymized demo data, with unresolved findings preserved rather than fabricated.

## Current gold run

- Task: `5edab756-76f4-499f-b306-b2ecab29b7d7`.
- Task-owned Review: `95be626b-f007-45fe-863d-be96ae4e88da`.
- Fixed scope: eight selected current Matter DocumentVersions, first instance,
  claimant/plaintiff, Chinese output.
- Durable progress at the latest checkpoint: 36 of 40 cells are `done`; four
  source-bound cells remain `pending`. A provider pause preserved the same Task,
  Step, Review, receipt, and every completed cell.
- The pause occurred before lawyer disposition. It is recovery evidence, not an
  end-to-end acceptance result. Resume this same Task; do not replace it with a
  new Review merely to obtain a clean demo.

## Acceptance record

| Check | State | Evidence |
| --- | --- | --- |
| Domain-model realism | Passed | One Task-owned Review maps eight fixed source Versions to 40 source-bound cells; partial work is preserved without a parallel evidence object |
| Coherent end-to-end lawyer workflow | Pending | Current Task is paused at 36/40 before lawyer review and downstream deliverables |
| Stage and represented-side validity | Passed | Fixed Task context records first instance, claimant/plaintiff, and Chinese output |
| Semantic-axis separation | Pending | Real Review inspection required |
| Selected-object synchronization | Pending | Real Review inspection required |
| Direct source and locator verification | Pending | Real Review inspection required |
| Same-size Mike/Vera comparison | Pending | Capture Vera at 1152 × 768 |
| Long Chinese text | Pending | Real Review inspection required |
| Keyboard and visible focus | Pending | Browser/client acceptance required |
| 125% and 150% zoom | Pending | Browser/client acceptance required |
| Narrow-window behavior | Pending | Capture at 393 px or equivalent |
| Approved fixed XLSX download | Pending | Approve, mutate live Review, and download locked Version |

Task-owned Review pages must continue to hide the ordinary client `Export`, `Save Excel`, and draft Word Memo actions. The Work Task may show `Export approved Evidence inventory` only for the strict server-owned approved Tabular snapshot; a historical identity-only snapshot or a later `changes_requested` decision must not expose a download action.
