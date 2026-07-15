# Gate 1 — Matter Workspace UI

Date: 2026-07-16

## Completed

Vera's active renderer now presents one Matter-centric product path while
preserving the existing Project data and compatibility routes.

The top-level information architecture is exactly:

```text
Assistant | Matters | Workflows | Review | Settings
```

`Review` remains visibly unavailable until Gate 2 has a real Proposal service.
Settings keeps its existing runtime capability gate. The exact `/projects`
list route redirects non-permanently to `/matters`; dynamic Project, Assistant,
Workflow, Tabular and Document Studio routes are not redirected or duplicated.

The new renderer surfaces are:

```text
/matters
/matters/:projectId
```

The list consumes the real bounded Matter projection, separates Projects with
a Profile from generic Projects, and offers explicit create, convert and
classify actions only when the backend capability permits them. It never
silently converts a Project. Matter creation calls the atomic `POST /matters`
boundary rather than issuing separate Project and Profile requests.

The detail view presents real Project/Profile metadata and real document,
chat, Workflow and Tabular Review counts. It uses the exact label
`tabular_review_count`; it does not relabel that value as a unified Review
count. It does not invent deadlines, tasks, research results, Drafts or next
actions whose authoritative owner is not yet available.

Matter navigation is exactly:

```text
Overview | Documents | Assistant | Review | Workflows | Drafts
```

Documents and Workflows preserve the existing Project-scoped destinations.
Assistant is enabled only for generic active Projects whose wire capability is
`workspace_compatibility`; a Matter remains visibly policy-gated until Gate 3.
Review is unavailable until Gate 2. A complete Matter-wide Draft list does not
yet exist, so Drafts is unavailable rather than backed by fixture data;
existing document-scoped Studio deep links remain valid.

Archived and deleted projections remain readable but advertise
`matter_profile: unavailable` and `inference: unavailable`. Profile mutations
and Assistant entry points are therefore absent or disabled instead of
offering operations that the active-Project backend gate would reject.

## Reused

- The existing Next.js renderer, Electron layout and Vera design primitives;
- Mike-derived sidebar, page header, table, modal and Project workspace
  components under the repository's existing AGPL/source manifest;
- canonical Project Documents, Assistant and Workflow routes;
- the existing authenticated loopback API client and localized error mapping;
- current Document Studio, Tabular and Project deep links without a second
  frontend or compatibility data model.

No competitor interface, brand asset, prompt, private endpoint or proprietary
workflow was copied.

## Architecture decisions

- `veraMatterApi.ts` is the only renderer wire boundary for the new surface.
  It rejects unknown keys, unbounded text, malformed identifiers/timestamps,
  old v15 litigation fields and inconsistent state/capability combinations.
- The renderer derives no Matter classification. It accepts only the six
  public `workspace_type` values and requires an explicit user selection for
  every create or classify operation.
- Project lifecycle participates in capability validation. Active and
  read-only projections cannot be confused by a stale or malformed response.
- Project owns name, description, Matter number, practice and lifecycle;
  Profile owns only workspace type, client, jurisdiction, represented role
  and objective.
- Navigation preserves compatibility rather than copying Project, Workflow,
  Tabular or Studio implementations into a Matter feature folder.

## Validation

Executed from `frontend/`:

```text
npm run test:p0-client  # PASS, 87/87 including Matter 4/4 and shell 14/14
npm run build           # PASS; /matters and /matters/[id] in production output
npm run test:i18n       # PASS, 6/6
npx playwright test --config=tests/vera-project-source.config.ts
                       # PASS, 22/22
git diff --check -- frontend
                       # PASS
```

The validation uses the production Next configuration and contains no
Keychain mutation or temporary credential fixture.

## Remaining blockers

- Gate 1 backend quiescence, lifecycle and inference-boundary review passed
  with no remaining P0/P1 findings.
- The packaged macOS cross-restart gate remains separate from renderer build
  validation and is the only unfinished Gate 1 acceptance item.
- Unified Review, Matter-wide Draft inventory, open Proposal counts, Work
  Queue, policy configuration and legal research are intentionally absent
  until their owning gates land.

## Next gate

Complete the Gate 1 packaged-runtime evidence. Gate 2's smallest vertical slice
is then one real Document Studio suggestion projected through the Proposal
Contract into the Review Center, with authoritative server-side accept/reject
and stale/source revalidation.
