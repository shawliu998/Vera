# `matter_type` Deprecation Plan

Date: 2026-07-16

Status: **implementation and local packaged acceptance complete; remote
final-commit CI pending**

## Current truth

Migration v15 is immutable and its `matter_profiles.matter_type` column is
`NOT NULL`. Migration v16 adds the broader, public `workspace_type` taxonomy
without mapping or backfilling old values.

Runtime reads use `workspace_type`:

- the Matter Profile repository selects `workspace_type` for public Profile
  reads and updates;
- the overview query reads `profile_workspace_type` to derive `ready` versus
  `classification_required`;
- API wire schemas and the renderer expose only `workspace_type`;
- the `/matters` SQL filters use Profile existence and `workspace_type` nullness.

The production Profile writer mentions `matter_type` only because the v15
column is still required. It inserts the fixed, non-semantic sentinel
`general`; it never derives a v15 value from `workspace_type`. Public API
responses do not contain `matter_type`.

## Allowed reference boundary

Until a table rebuild removes the column, references are allowed only in:

1. the immutable v15 migration and its checksum evidence;
2. later migration/table-rebuild code that must preserve or remove the legacy
   column safely;
3. the single Matter Profile compatibility INSERT that writes `general`;
4. migration/module audits and frozen fixtures that prove old values survive,
   no guessed mapping occurs, and the public response omits the field;
5. documentation explaining this boundary.

The separate Legacy AgentOps `matter_type` DTO under `frontend/src/aletheia`
belongs to the default-off Legacy product model, not the Workspace
`matter_profiles` classification. It may remain only inside that isolated
Legacy boundary and must not feed `/api/v1/matters`, Matter navigation, policy,
or capability decisions.

New runtime reads, API fields, filters, UI copy, analytics, policy rules, or
route decisions based on v15 `matter_type` are prohibited.

## Removal prerequisites

SQLite removal requires a new additive migration version that rebuilds
`matter_profiles`; the frozen v15/v16 files must never be edited. Before that
migration can land:

- define the exact new table, indexes, triggers, foreign keys, and copy query;
- prove all pre-v16 unclassified rows retain `workspace_type = NULL` and all
  classified rows retain their exact value;
- preserve Profile ownership, Matter Policy cascades, timestamps, bounded text,
  and Project delete behavior;
- run fresh install, every supported upgrade prefix, SQLCipher, checksum,
  idempotence, injected rollback, restart, backup, and restore tests;
- fail closed when an older executable opens the newer schema;
- remove the compatibility INSERT and add a source audit that rejects new
  non-allowlisted references.

## Packaged-upgrade prerequisite

Column removal is not accepted from source tests alone. Build the final
`Vera.app`, open a real encrypted pre-removal Workspace, upgrade in place,
restart twice, and verify Matter list/detail/edit, legacy
`classification_required`, policies, documents, jobs, sources, citations,
backup, and restore. Record artifact identity and retain a verified pre-upgrade
backup. Until this evidence exists, the compatibility column remains private
storage rather than being destructively removed.
