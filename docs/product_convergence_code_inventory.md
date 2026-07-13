# Vera Product Convergence Code Inventory

Date: 2026-07-12

This inventory supports the product-convergence stage. It records current code
facts, not a proposal to add more product surfaces.

## Primary product path

The real civil-litigation path is:

1. `/aletheia/matters`
2. create a `civil_litigation` matter through the local API
3. `/aletheia/matters/:matterId/litigation`
4. `Overview` -> `Facts & Evidence` -> `Claims & Defenses` ->
   `Procedural Clock` -> `Documents & Hearing`

Those views use persisted backend records. This path should become the only
primary matter workflow.

## Competing paths

- `/aletheia/matters/:matterId` opens `RemoteMatterPage` for non-demo matters,
  while civil-litigation rows open `/litigation`. The litigation breadcrumb
  still links back to the competing generic workspace.
- `AletheiaWorkspace`, `RemoteMatterPage`, `RemoteMatterSidebar`,
  `RemoteMatterCommandCenter` and the matter-scoped `/agentops` route preserve
  an older generic AgentOps product alongside the litigation product.
- `/aletheia/templates` and three non-litigation templates remain primary
  creation choices even though the current target is Chinese civil/commercial
  litigation.
- `Agent Studio` is primary global navigation, while `Agent Run` and `Eval Lab`
  also appear as first-level matter views. These are operator/developer tools,
  not the lawyer's core case path.

## Duplicate registries

The shell exposes global `Evidence`, `Reviews` and `Audit` destinations while
the litigation workspace already exposes source evidence, review decisions and
matter audit/export functions. The matter dashboard repeats `Review Queue` and
`Evidence` as a second row of navigation. These entrances need one ownership
model: matter work stays in the matter; only genuine cross-matter queues remain
global.

## Demo and fail-open risk

- `AletheiaMatterDashboard`, `AletheiaEvidenceRegistry`,
  `AletheiaReviewRegistry` and `AletheiaAuditWorkbench` retain imports from
  `mockData`/`workflow`.
- When local API reads fail, registry pages switch to a `fallback` state and can
  render or export demo records. This is unsafe for daily legal work because a
  connectivity failure can look like valid case data.
- The matter list labels an unavailable local service as `Demo data`, even when
  demo records are disabled. The correct production behavior is an explicit
  unavailable state with retry and no substituted records.
- `/aletheia` still contains a marketing/demo landing page and
  `/aletheia/matters/matter-demo-legal-001` opens a fully separate demo
  workspace. Neither belongs in the normal desktop journey.

Demo fixtures may remain for automated tests, but production UI must not fall
back to them and must not export them after a failed local read.

## Language and information architecture

Primary navigation, matter creation, matter views, field labels, statuses and
error states are predominantly English. The target users are Chinese
litigation teams; terminology needs one Chinese vocabulary and should not mix
product-development concepts such as `V1 local`, `Agent Studio`, `Eval Lab`,
`Evidence-bound` or `Gate-controlled` into ordinary case work.

The existing overview reports counts and deadlines but does not provide one
clear server-backed next action or link each blocker to the exact work surface.

## Engineering concentration

Current component sizes include:

- `LitigationWorkspace.tsx`: over 9,400 lines
- `AletheiaSettings.tsx`: over 2,300 lines
- `RemoteMatterPage.tsx`: over 1,600 lines
- `AletheiaWorkspace.tsx`: over 1,000 lines

The litigation workspace should be split by the five retained case stages and
shared source/review controls. The split must preserve behavior and tests; it
is not a visual rewrite.

## First implementation slice

1. Remove production demo fallback from matters, evidence, reviews and audit.
   API failure must show unavailable/retry and zero substituted/exportable
   records.
2. Route civil-litigation matter identity and breadcrumbs only through the
   litigation workbench.
3. Reduce first-level matter navigation to the five case stages. Move Agent Run
   and Eval Lab out of the lawyer's primary path without deleting their real
   backend functionality.
4. Reduce global navigation to cross-matter work and settings. Hide legacy
   Agent Studio and template/demo entrances from the normal desktop path.
5. Add a real next-action block to the matter overview using existing persisted
   blockers and direct links, rather than another dashboard card.

Visual and information-architecture decisions require Sol screenshot review
before implementation is accepted.
