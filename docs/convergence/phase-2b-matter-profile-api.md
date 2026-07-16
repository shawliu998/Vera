# Gate 1 — Matter Profile API

Date: 2026-07-16

## Completed

Vera exposes Matter as an additive legal projection over the existing Project
ownership boundary. It reuses the canonical `ProjectsRepository`, the existing
Workspace database and the same database transaction boundary; it creates no
second Project, document, chat, workflow, tabular or job implementation.

Persistence ownership is explicit: `MatterProfileRepository` owns only Profile
rows, `ProjectsRepository` remains the canonical Project owner, and
`MatterOverviewRepository` owns only the read projection. `MatterProfileService`
is the sole coordinator that opens Matter write transactions. All three owners
share the exact injected database adapter and never nest a transaction.

Generic Projects remain first-class and are returned explicitly with
`matter_profile: null` and `profile_state: absent`. A preserved v15 profile with
no v16 classification is returned with `workspace_type: null` and
`profile_state: classification_required`; Vera never guesses a classification.

## Authoritative contract

`WorkspaceType` is the only public Matter classification:

```text
general_legal | transaction | dispute | investigation | compliance | research
```

New Matter and Profile creation requires `workspace_type`. A PATCH can classify
a preserved v15 row whose value is null. New writers keep the v15 NOT NULL
`matter_type` column as private compatibility storage and always write the
non-semantic sentinel `general`; v15 litigation-specific fields are never
projected to the public API.

The complete public Profile payload is intentionally narrow:

```text
project_id
workspace_type       # nullable only for a preserved pre-v16 row
client_name
jurisdiction
represented_role
objective
created_at
updated_at
```

Project wire compatibility remains unchanged for `cm_number`, `practice` and
`status`. Matter counts use the unambiguous name `tabular_review_count`, not
`review_count`.

## API

The authenticated `/api/v1` surface is:

```text
GET   /matters
POST  /matters
GET   /matters/:projectId
GET   /projects/:projectId/matter-profile
POST  /projects/:projectId/matter-profile
PATCH /projects/:projectId/matter-profile
```

`GET /matters` performs one bounded SQL statement over a selected Project page,
one `LEFT JOIN` to profiles and grouped document/chat/tabular/workflow counts.
It includes generic Projects and performs no per-row profile or count reads.

Project plus Profile creation and generic-Project conversion each use one
`BEGIN IMMEDIATE` transaction. Project persistence is delegated to the injected
`ProjectsRepository`; Profile and Overview owners contain no copied Project
INSERT/UPDATE SQL and open no transaction or database handle.

## Truthful state and capabilities

Each projection reports derived state and currently available capability modes:

| Profile row                      | `profile_state`           | `matter_profile` | `inference`               |
| -------------------------------- | ------------------------- | ---------------- | ------------------------- |
| absent                           | `absent`                  | `create`         | `workspace_compatibility` |
| v15 row with null classification | `classification_required` | `classify`       | `policy_gate_closed`      |
| classified profile               | `ready`                   | `edit`           | `policy_gate_closed`      |

`profile_state` is derived only from Profile presence and classification. For
an archived or deleted Project it therefore remains `absent`,
`classification_required`, or `ready`, while both operational capabilities are
always truthful and unavailable:

```json
{
  "matter_profile": "unavailable",
  "inference": "unavailable"
}
```

Every row also reports:

```json
{
  "review": "unavailable",
  "drafts": "document_scoped"
}
```

This does not claim a unified Review Center or Matter-wide Draft model. Existing
Document Studio drafts remain document-scoped. Generic Projects keep current
Workspace inference compatibility; any Project with a Matter Profile is stopped
by the Gate 1 policy boundary until Gate 3 installs the Inference Broker.

The provider boundary is independent of renderer state. Assistant checks the
Project before every model round, including chats with no attached documents.
Workflow checks every prompt step while leaving non-model retrieval and output
steps usable. Tabular rechecks the same Project policy with the authoritative
current document snapshot immediately before model use. Injected adapters are
wrapped by the same production policy seam, so an old deep link or alternate
local adapter cannot skip it.

Module health is equally explicit:

```json
{
  "status": "ready",
  "schemaVersion": 16,
  "inferencePolicy": "gate_closed"
}
```

`ready` means the Profile schema and module are usable. It does not mean Matter
inference policy is configured.

## Security and lifecycle

- Every router call requires an authenticated Workspace principal; the service
  independently enforces the local single-principal boundary.
- Lifecycle acceptance is checked below HTTP so a direct adapter cannot bypass
  startup/drain/close state.
- Profile creation and mutation require an active Project; archived Projects
  remain readable, and archived/deleted detail and archived-list responses
  report unavailable Profile/inference capabilities without erasing the
  derived Profile state.
- Generic-to-Matter conversion first acquires `BEGIN IMMEDIATE`, rechecks the
  active Project and absent Profile, then checks the complete canonical Project
  job graph for queued/running Assistant, Workflow and Tabular inference. It
  returns a safe `409` and never cancels or mutates that work.
- Each claimed inference handler synchronously freezes a narrow Project/global
  scope from its verified durable execution contract before registration.
  Invalid or missing provenance is `unresolved` and fails closed. The copied
  scope stays registered until the handler's controller-identity `finally`
  unregister, so cancellation, terminal persistence, or deletion of a chat,
  run, review, cell, or document cannot open a conversion race.
- A recovered lease retry never overwrites an older provider call with the
  same job id. The registry retains every controller/scope instance, aborts all
  attempts for that job, and releases conversion only after every instance has
  independently unregistered.
- Enqueue/claim writers serialize with the same SQLite writer lock. A job that
  retries after conversion commits sees the new Profile at the final model
  policy gate and makes no provider call.
- Profile and Project timestamps move monotonically, including when historical
  Project timestamps use an explicit UTC offset.
- Strict bounded contracts reject unknown and former v15 fields. Public errors
  redact rejected values, SQL errors, credentials, paths and stacks.
- Profile ownership remains the Project foreign key. Project deletion cascades;
  restart needs no repair or inferred backfill.
- Matter/Profile code does not access Keychain and does not import Legacy
  Aletheia modules.

## Migrations

This API consumes the independently audited v15 Matter foundation and additive
v16 classification migration. It does not edit v1-v15 and performs no silent
v15 backfill.

## Validation

Focused coverage includes:

```text
v15 null classification and private litigation-field compatibility
required WorkspaceType and fixed general sentinel for every new writer
generic Project empty optional fields and explicit absent state
single-query pagination/counts/left join with no N+1
injected ProjectsRepository and atomic rollback
separate Profile/Project/Overview owners with one non-nested transaction
queued/running Assistant, Workflow and Tabular conversion conflicts
registered terminal handler scope retained across owner deletion and unwind
overlapping fenced attempts retained and cancelled by controller identity
document_parse exclusion, terminal history compatibility and unresolved fail-close
same-connection query ordering and concurrent enqueue retry at final policy gate
archived create/update gates and monotonic timestamps
archived list/detail and deleted detail capability truthfulness
strict authentication, local principal, lifecycle and error redaction
v15-not-ready / v16-ready health contract
restart persistence and Project-delete cascade
all six Matter/Profile routes and narrow production exports
Gate 1 inference policy compatibility/closed behavior
real Assistant runtime: generic Project succeeds; Matter makes zero provider calls
backend TypeScript build
```

## Rollback

Reverting the module and route composition removes the API without deleting
Project or Profile data. The additive v15/v16 tables and migration records must
remain immutable; an older binary still needs the compatibility-build or
verified encrypted-backup rollback path.

## Remaining blockers

- The current unsigned local-only packaged macOS cross-restart run now passes;
  the exact pushed final commit still requires its remote CI result.
- Unified Proposal/Review remains Gate 2 and is accurately `unavailable` here.
- The minimal v17 unified inference policy is now implemented; approval UX,
  policy administration/attestation, and Knowledge remain Gate 3 work.
- A real authorized Chinese legal source and Office Add-in remain later gates.
