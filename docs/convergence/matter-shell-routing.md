# Matter Shell Routing

Date: 2026-07-16

Status: **implementation and local packaged acceptance complete; remote
final-commit CI pending**

## Canonical entry points

The application landing route remains `/assistant`. The Vera sidebar exposes
`/matters` as the Matter collection. `/projects` and every dynamic Project deep
link remain compatibility routes; no redirect may erase a Project identifier
or manufacture a Matter Profile.

`/matters` loads two independent API streams: `profile_state=profiled` for
Matters and `profile_state=absent` for generic Projects that can be explicitly
given a Profile. Selecting either row opens `/matters/:projectId`; conversion
is always an explicit POST to the Profile subresource.

## Workspace route adapter

The Matter shell reuses Project-owned Documents, Assistant, Workflows, Tabular,
and Studio components through a route adapter.

| Matter destination | Current route | Current owner/meaning |
| --- | --- | --- |
| Overview | `/matters/:id` | Matter projection and combined General/Profile edit. |
| Documents | `/matters/:id/documents` | Existing Project Documents owner. |
| Studio | `/matters/:id/documents/:documentId/studio` | Existing Project Document Studio owner. |
| Assistant | `/matters/:id/assistant` and `/matters/:id/assistant/chat/:chatId` | Existing Project-scoped Assistant, with Matter policy resolved server-side. |
| Workflows | `/matters/:id/workflows` and `/matters/:id/workflows/:workflowId` | Existing Workflow owner with Matter-aware route generation. |
| Review compatibility surface | `/matters/:id/review` and `/matters/:id/review/:reviewId` | Existing Tabular Review pages. This is not the Gate 2 Review Center. |
| Drafts | `/matters/:id/drafts` | Document-scoped entry to real Studio content; no synthetic Matter-wide Draft store. |
| Settings | `/matters/:id/settings` | General, Matter Profile, and Matter Policy controls. |

The adapter prevents reused Project components from jumping back to
`/projects/**`: a Matter-origin document, chat, workflow, review, or Studio
action stays under the Matter URL family. Direct `/projects/:id/**` links use
the Project adapter and remain valid.

## Capability routing

- Overview and Documents remain available for an active Project.
- Assistant requires `capabilities.assistant === available`.
- Workflows allow both `available` and `non_inference_only`; prompt steps are
  still denied when inference is closed.
- The current `/review` compatibility surface is enabled by `tabular`, because
  it renders Tabular Reviews. Backend `capabilities.review` stays
  `unavailable` until Gate 2.
- Drafts accepts `document_scoped` and links to authoritative Studio content.
- Archived/deleted Projects project all Matter capabilities as unavailable.

The word “Review” in the current navigation is therefore presentation debt,
not evidence that a unified review backend exists. Gate 2 must introduce the
Proposal Contract and then enable `capabilities.review`; it must not reinterpret
Tabular rows as already unified Proposals.

## Verification boundary

Source and focused shell tests cover adapter paths, capability-disabled states,
Mike source locks, and canonical IA. The current local-only packaged app also
passed the Matter Overview/Documents/Assistant/Review/Workflows/Drafts/Settings
navigation and offline restart chain. Gate 1 still awaits remote CI for the
exact final commit.
