# Minimal Unified Inference Policy

Date: 2026-07-16

Status: **implementation and local packaged acceptance complete; remote
final-commit CI pending**

## One policy, three scopes

`WorkspaceInferencePolicy` is the single decision authority for Global,
generic Project, and Matter inference. Callers supply a Project identifier or
`null`; the policy re-resolves durable scope and rejects a caller that attempts
to downgrade a Matter to a generic Project.

| Resolved scope | Durable condition | Additional rule |
| --- | --- | --- |
| Global | `projectId` is `null` | Enabled Model Profile plus complete, acceptable model-privacy declaration. |
| Project | Project exists, is active, and has no Matter Profile | Same Workspace-level model privacy rule. It does not create or consult a Matter Policy. |
| Matter | Project exists, is active, and has a Matter Profile | Workspace model privacy plus an existing Matter Policy whose allowed execution locations contain the declared model location. |

Unknown or missing model privacy fails closed. Execution location is an
explicit declaration (`local`, `firm_private`, `confidential_remote`, or
`standard_remote`); it is never inferred from provider, model name, or URL.
For Matter scope, a missing policy and an empty location list both deny.
External locations then follow the exact egress mode: `disabled` denies,
`approval` returns `require_approval`, and `allowed_by_policy` allows. A listed
`local` model may run even when external egress is disabled.

## Preview versus enforcement

`evaluate` is side-effect-free and is used to project UI capabilities.
`assertAllowed` re-evaluates durable state, writes a bounded
`inference_policy_decisions` row, and either returns `allow` or fails with a
safe approval/denial error. Capability list/read operations must never grow the
decision ledger.

The Matter projection additionally requires an active Project, an enabled
default Model Profile, and a current passed connection test before displaying
Assistant, Workflow, or Tabular inference as available. `review` remains
`unavailable`; `drafts` remains `document_scoped` while the Project is active.

## Enforced model boundaries

| Surface | Early check | Last provider-visible boundary |
| --- | --- | --- |
| Assistant | Chat generation enqueue resolves the scope and calls policy with `assistant`. | `WorkspaceAssistantModelAdapter.runTurn` rechecks immediately before `provider.generate`, including immutable source snapshot IDs. |
| Workflow | Workflow enqueue checks `workflow_prompt` when executable steps contain model calls. | Each prompt step reaches the shared Assistant model adapter, which rechecks before the provider call with the Workflow operation. |
| Tabular | Review generation preparation checks `tabular_generation` against current source snapshots. | `WorkspaceTabularModelAdapter.generateCell` rechecks current snapshot/retention and policy immediately before `provider.generate`. |
| Studio suggestion | There is no standalone Studio provider call in Gate 1. Suggestions are created by the already-guarded Assistant tool path after an Assistant model turn. | `studio_suggestion` is reserved in the v17 operation contract/ledger, but no independent Studio model boundary currently invokes it. A future direct generator must enforce it before its provider call. |

Queue-time checks are preflight only. They do not replace the final check,
because Project lifecycle, Matter Policy, model privacy, source retention, or
execution revision can change while work is queued.

## Matter Policy API

```text
GET   /api/v1/matters/:projectId/policy
PATCH /api/v1/matters/:projectId/policy
```

PATCH requires all four policy fields and atomically replaces the normalized
execution-location set. Empty is valid storage but fail-closed behavior.
Archived/deleted Projects are readable through their normal detail boundary
but policy mutation is rejected.

## Explicit non-claims

- This is not the Gate 2 Proposal Contract or Review Center.
- It does not provide approval UI or silently convert `require_approval` into
  `allow`.
- It does not add permissive Matter defaults.
- It does not provide distributable release evidence. The current local-only
  packaged run proves Matter policy enforcement and exact cross-restart state;
  remote final-commit CI and, for distribution, signed/notarized artifacts are
  still separate requirements.
