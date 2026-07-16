# Phase 2B — Matter Classification Migration

Date: 2026-07-16

## Completed

Workspace migration v16, `matter_profile_classification`, adds the Gate 1
classification contract to the existing v15 `matter_profiles` table. The
migration is additive: v15 and every earlier migration remain byte-for-byte
immutable, and no Project or Matter row is inferred or backfilled.

## Schema contract

Two nullable columns are appended:

- `workspace_type`: `general_legal`, `transaction`, `dispute`,
  `investigation`, `compliance`, or `research`;
- `jurisdiction`: optional trimmed non-empty text, at most 240 characters and
  with embedded NUL rejected.

`workspace_type` is nullable only for a row created before v16. Such a row is
the persisted `classification_required` state. The migration deliberately does
not map any v15 `matter_type` value to the broader v16 taxonomy and leaves
`jurisdiction` null.

The database enforces the one-way compatibility boundary:

- a new `matter_profiles` insert without `workspace_type` fails;
- a legacy null classification may be set explicitly;
- once non-null, `workspace_type` cannot be cleared back to null;
- invalid classifications, blank/oversized jurisdictions and NUL-containing
  jurisdictions fail at the schema boundary.

Partial indexes cover classified workspace-type and jurisdiction lookups. The
v16 insert and one-way update triggers are checksum-bound with both column
definitions and indexes.

Because the immutable v15 table still requires `matter_type`, the Gate 1
compatibility writer uses the fixed non-semantic value `general` for a newly
created row. That is an application compatibility rule, not a migration-time
guess: v16 never rewrites an existing v15 `matter_type` and does not expose it
as the public classification.

## Security and data-integrity implications

- Project remains the sole ownership and cascade boundary.
- Classification is explicit user-selected metadata, not an AI inference.
- A missing classification is visible and fail-closed; it is not silently
  treated as `general_legal`.
- The migration is transactional, ordered, SHA-256 checksum-recorded and
  idempotent on both SQLite and SQLCipher.
- Existing Matter Policy defaults remain deny-all and are not changed by v16.

## Rollback and recovery

There is no destructive down migration. A pre-v16 executable sees migration
ledger version 16 and fails closed with an unknown-version error; it must not
delete the v16 ledger row or reinterpret the appended columns.

Executable rollback therefore requires either a compatibility build that
retains the v16 migration registry while leaving the additive fields unused,
or restoration of the verified encrypted pre-v16 backup. A current v16 binary
can reopen the same database after a rejected old-binary launch without data or
checksum changes.

An injected failure after the complete v16 DDL but before the migration-ledger
record rolls the columns, indexes and triggers back atomically to the intact
v15 schema and data.

## Validation

The focused and full Workspace migration audits cover:

```text
clean SQLite v16 install and strict constraints
v14-to-v16 preservation upgrade with Legacy sentinel
all five v15 matter_type values preserved with NULL v16 classification
new-insert classification trigger and one-way classified-state trigger
bounded, NUL-safe jurisdiction and exact workspace_type enum
frozen v15 checksum plus v16 checksum drift and idempotent rerun
v16 DDL/ledger injected rollback to intact v15
classification_required and classified restart persistence
pre-v16 executable fail-closed and current-binary recovery
encrypted SQLCipher v15-to-v16 upgrade, integrity check and restart
```

## Scope boundary

This slice changes persistence only. The separate Gate 1 Matter
contracts/repository/service/API and renderer slices consume this schema while
preserving its explicit-classification boundary; they do not make v15 fields
public or infer values for historical rows.
