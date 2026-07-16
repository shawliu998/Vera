# Phase 2A — Matter Foundation Migration

Date: 2026-07-16

## Completed

Workspace migration v15 adds an optional, one-to-one legal extension to the
existing Project ownership boundary. It does not rename `projects`, backfill
legal meaning, or create another database.

```text
Project 1 --- 0..1 MatterProfile
MatterProfile 1 --- 0..1 MatterPolicy
MatterPolicy 1 --- 0..* allowed execution locations
```

An ordinary Project remains valid with no profile. Missing policy and an empty
execution-location set are both deny-all; no local or remote inference is
silently authorized.

## Files changed

- additive v15 migration and registry entry;
- focused Matter-foundation migration audit;
- existing full Workspace migration audit expectations;
- active architecture/schema documentation;
- this migration and rollback record.

## Migrations added

Migration v15, `project_matter_foundation`, creates:

- `matter_profiles`;
- `matter_policies`;
- `matter_policy_execution_locations`;
- bounded lookup indexes and ownership/update guards.

The migration is transactional, checksum-recorded and idempotent. It upgrades
the existing v14 database without modifying v1-v14 migration files or changing
existing Project, document, source or Studio rows.

## Security implications

- Matter ownership remains the existing Project foreign-key boundary.
- Profile metadata is bounded intake data, not a store for sourced facts,
  model conclusions or formal legal state.
- Matter policy defaults external egress off, external legal sources off and
  Word bridge off; audio retention is unconfigured rather than guessed.
- Allowed model execution locations use normalized, enumerated rows instead of
  permissive JSON.
- Invalid enums, booleans, timestamps, ownership changes and cross-owner rows
  fail at the schema boundary.

## Rollback

No destructive down migration is provided. A binary that knows v15 can leave
the additive tables unused. A pre-v15 binary rejects the unknown migration
registry, so executable rollback requires either a compatibility build that
retains the v15 registry or restoration of the verified encrypted pre-migration
backup. Do not delete v15 rows or edit the migration ledger in place.

## Tests

The focused and existing migration suites cover:

```text
clean SQLite v15 install
v14-to-v15 preservation upgrade
ordinary Project without MatterProfile
one-to-one ownership and delete cascade
strict profile and policy constraints
deny-all policy defaults and normalized execution locations
checksum drift, idempotent rerun and injected rollback
encrypted SQLCipher v14-to-v15 upgrade
backend build
```

## Known limitations

- This commit provides persistence only; no Matter repository, service, route
  or renderer uses the new tables yet.
- A missing policy is deliberately unavailable, not an implicit default row.
- Artifact, Review, Work Queue and Conversation state remain later migrations.

## Next phase

Phase 2B adds the Matter Profile repository/service/API and atomically creates
a Project plus MatterProfile. It remains a separate commit from this migration
and from the Phase 2C navigation work.
