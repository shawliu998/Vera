# Mike navigation and ordinary UI copy audit

Date: 2026-07-21
Scope: Vera first-level navigation, Assistant, Projects/Matter, Work Tasks, and
Settings. This is a read-only convergence audit. [`PRODUCT.md`](../PRODUCT.md)
remains the sole product direction.

## Verdict

Keep the Mike navigation baseline and the thin Work detail. Do **not** keep
`Work Tasks` as a peer first-level destination: the same task list already
exists inside its Matter, and the current global entry introduces a sixth
navigation concept that Mike does not have. Retain the route and task data for
recovery, but move its ordinary entry point into Matter history and Assistant
context. The saved evidence shows that the task detail itself has already
converged well: goal, current Word/Excel outputs, review when needed, then
folded step details.

## Evidence and limit

- Mike visual/IA truth: [saved Mike reference](screenshots/mike-work-task-alignment-2026-07-21/01-mike-reference-1728x851.png).
  The original saved Mike capture is 1728×851; the accompanying comparison
  normalizes it to the available 1152×768 Vera frame without changing aspect
  ratio: [comparison](screenshots/mike-work-task-alignment-2026-07-21/06-normalized-side-by-side.png).
- Vera task evidence: [completed task](screenshots/work-task-qa/completed-1024.jpg)
  and [background-resume comparison](screenshots/background-work-task-runner-2026-07-21/03-mike-vera-side-by-side-2304x768.png).
- Source evidence: `AppSidebar.tsx`, `InitialView.tsx`, `WorkTasksOverview.tsx`,
  `AgentTaskWorkspace.tsx`, `ProjectWorkspace.tsx`, and account settings pages.
- A current runnable-browser pass was blocked: this worktree has neither
  `frontend/node_modules` nor `frontend/.next`; `npm run dev` stops with
  `next: command not found`, and no installed `Vera.app` was found. The saved
  same-size captures are therefore visual evidence, not a fresh live-session
  acceptance result.

## Navigation recommendations

| Surface | Decision | Files | Product reason |
| --- | --- | --- | --- |
| Assistant, Projects, Library, Tabular Review, Workflows | **Keep.** These are the saved Mike first-level labels and order. Do not rename `Projects` wholesale to `Matters`; use `Matter` where a legal work context must be selected. | `frontend/src/app/components/shared/AppSidebar.tsx`; `frontend/src/app/components/assistant/InitialView.tsx` | Mike remains the IA baseline; the Work input already requires a Matter. |
| `Work Tasks` as first-level navigation | **Hide from ordinary primary navigation; do not delete the route or task data.** Keep `/work-tasks` available as an explicit “all matters” recovery view only if a user has several active or blocked tasks. | `frontend/src/app/components/shared/AppSidebar.tsx`; `frontend/src/app/components/agent/WorkTasksOverview.tsx` | The task is Matter-owned and has a Matter-local table. The saved Mike rail has no peer task destination, while the current Vera rail adds one. A global queue has plausible recovery value, but the evidence does not establish that a permanent peer entry is faster than Matter/Assistant history. |
| Matter task history | **Keep and make the default recovery point.** The existing `Work Tasks` tab within a project is the correct home; surface a quiet “needs your input” count/link from the relevant Matter or Assistant history instead of creating a new primary object. | `frontend/src/app/components/projects/ProjectWorkspace.tsx`; `frontend/src/app/(pages)/projects/[id]/work-tasks/page.tsx`; `frontend/src/app/components/shared/AppSidebar.tsx` | It preserves task context, source files, and outputs in the same Matter and shortens recovery without changing the information architecture. |
| Work task detail | **Keep, with a later breadcrumb adjustment if the primary entry is hidden.** The implementation already orders goal → current work product → review when required → step record and sends source citations back to the Matter. | `frontend/src/app/components/agent/AgentTaskWorkspace.tsx` | This matches the product order and the saved Mike/Vera comparison. Do not reintroduce a runner, audit, or control-panel layout. |
| Global task table columns | **Hide `Model` by default; retain it only for a configuration/error state.** Keep goal, Matter, state, and progress. | `frontend/src/app/components/agent/WorkTasksOverview.tsx` | The execution layer should show objective, steps, outputs, and blockers—not routine implementation detail. |

## Ordinary UI copy recommendations

| Copy or surface | Decision | Files | Product reason |
| --- | --- | --- | --- |
| Cloud-model data notice | **Add/retain (required).** A concise fact should appear where a cloud model is selected: relevant content leaves the device for that model's processing. The audit found DeepSeek selectable but no matching egress notice in the model-preference UI. | `frontend/src/app/(pages)/account/models/page.tsx`; `frontend/src/app/components/assistant/ModelToggle.tsx` | `PRODUCT.md` requires this factual notice at configuration or egress. It is not a security claim. |
| “All API keys are encrypted in storage.” | **Remove from the ordinary API-key introduction.** Keep a focused failure/credential-handling message only when it helps the user resolve a key problem. | `frontend/src/app/(pages)/account/api-keys/page.tsx` | Encryption is an engineering baseline, not normal product copy. |
| “Tokens/Secrets are stored encrypted” and “Saved token encrypted” | **Rename or hide.** Prefer the neutral state “Saved token”; do not repeat storage implementation in the connector form. | `frontend/src/app/components/account/NewMcpModal.tsx`; `frontend/src/app/(pages)/account/connectors/page.tsx` | The form's job is connection configuration, not a security pitch. |
| `Privacy & Data` and `Security` as ordinary Settings tabs | **Hide from the routine Settings rail, not delete.** Keep deep routes and bring them forward only for an export, account-recovery, or explicit request. | `frontend/src/app/(pages)/account/layout.tsx` | A standard settings journey should prioritize models and work-relevant configuration; security/governance must not become a product layer. No permission or authentication behavior changes are implied. |
| Task footer: “Work tasks pause for input and remain subject to lawyer review.” | **Rename.** Use “Tasks pause when they need your input. Final outputs may need your review.” | `frontend/src/app/components/assistant/InitialView.tsx` | It keeps the useful blocker but limits review to consequential output rather than presenting it as a default gate. |
| Hash icon for `CM No.`; internal hashes/audit code | **Keep; no UI action.** The icon represents a matter-number field, and the scan found no hash/audit promotion in ordinary task, project, or assistant UI. | `frontend/src/app/components/shared/RowActions.tsx`; internal helpers only | Do not make an engineering-only search result into a visible problem. |

## Execution order

1. Validate the global-work-task recovery hypothesis with a live session: resume
   a blocked task from its Matter and from Assistant history; only retain a
   compact all-matters shortcut if that materially shortens recovery.
2. Add the required factual cloud-model egress notice at model selection.
3. Remove the routine encryption copy and demote the `Security`/`Privacy & Data`
   settings tabs without changing their routes, permissions, or behavior.
4. Re-capture the same-size Mike/Vera navigation and task states, plus keyboard
   focus, long Chinese text, 125%/150% zoom, and responsive states before any
   UI change is accepted.
