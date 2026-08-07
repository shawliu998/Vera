# Agent Task structured required-input acceptance — 2026-08-08

## Scope

- Work Task: `b0ebb71d-0fdb-489b-a044-8f19ee572bea`
- Matter: `E2E 高频服务合同普通用户验收 2026-07-31`
- Workflow: `Contract Playbook Review`
- Blocking step: `Create Contract Revision`
- Mike visual source: `../mike-v040-baseline/agent-task-waiting-input.png`
- Viewport: `1280 × 720` for both Mike and Vera

## Product decision

The existing Matter, AgentTask, Step, checkpoint, and document-selector objects
carry this requirement. No new page, route, persistence table, or parallel
reliability state was added.

The exact Mike screen establishes the shared shell, task hierarchy, waiting
status, neutral surfaces, compact density, and one dominant recovery action.
Vera adapts the middle recovery region because the real contract task requires
four lawyer decisions rather than a single missing-document action.

| Region | Mike source | Decision | Vera purpose |
| --- | --- | --- | --- |
| Application shell and sidebar | Agent Task waiting-input screen | Keep | Preserve Mike navigation and density |
| Task header and status | Agent Task waiting-input screen | Keep | Preserve Matter, goal, progress, model, and waiting state |
| Input-required region | Mike recovery card | Adapt | Render the server-owned choice items as keyboard-operable radio groups |
| Document action | `Open Matter documents` | Adapt | Reuse the existing Matter document selector and distinguish required from optional evidence |
| Recovery action | Mike single recovery action | Keep | `Apply decisions and retry step` retries only the blocked Step |
| Technical execution detail | Not present in Mike | Remove | Do not expose tool calls or provider protocol state |

## Acceptance evidence

- `01-vera-structured-input-1280x720.jpg` — four long-Chinese decision groups,
  visible selected state, optional supporting documents, and enabled recovery
  action.
- `02-mike-vera-waiting-input-comparison-2560x720.jpg` — same-size Mike/Vera
  comparison.
- Native radio inputs provide keyboard operation and visible focus.
- The server still blocks unanswered choice items and required document items.
- A document item marked `required: false` does not force a fake upload; the
  generated response explicitly preserves unknown facts as unresolved.
- Submission resumed the existing Task at the same blocked Step while the first
  two completed Steps and their citation snapshots remained intact.

Zoom and narrow-window evidence will be added with the final cross-module UI
regression pass; this screen remains an acceptance candidate until those checks
are recorded.
