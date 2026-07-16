# Vera Legal Matter Agent Convergence — Data Migration Plan

> Superseded sequencing notice (2026-07-16): retained as historical migration
> design. Migration v15 has since landed on the feature branch, while the
> Proposal-first sequence and later provisional versions are governed by
> `docs/roadmap_legal_workspace.md`. Existing committed migration files remain
> immutable.

Date: 2026-07-16
Baseline Workspace schema: v14
Status: Historical / superseded migration design; no migration is applied by this document

## 1. Migration contract

All new Workspace migrations are additive, ordered, checksum-recorded,
transactional, idempotent, and upgradeable from every runtime-valid production
prefix already supported by the v14 migration runner. Existing migration files
and checksums are immutable.

There are no destructive down migrations. However, the current runner fails
closed when its binary does not recognize the recorded migration registry, so
an arbitrary older binary cannot simply ignore a newer ledger. Application
rollback must use a compatibility binary that still knows the landed migration
registry, or restore the verified pre-migration encrypted backup. It never drops
new tables or deletes selected migrated records in place. Before Legacy
migration, a verified encrypted backup and migration report are mandatory.

## 2. Planned schema sequence

The next migration number is v15. Numbers below are reservations so phases do
not accidentally combine unrelated domains; a number is considered final only
when its migration and checksum land.

| Version | Domain | Tables / changes | Phase |
| --- | --- | --- | --- |
| v15 | Matter foundation | `matter_profiles`, `matter_policies` | Matter Profile |
| v16 | Artifact graph | `matter_artifacts`, `artifact_revisions`, `artifact_source_links`, `artifact_relations` | Case Map |
| v17 | Human review/work | `review_items`, `review_decisions`, `work_items`, `work_item_links` | Review + Work Queue |
| v18 | Conversations | sessions, participants, transcript segments, speaker bindings, extractions, processing runs; additive Source kind/locator support | Imported Conversations |
| v19 | Email/manual-note sources | `project_source_records`, `project_source_record_versions`; additive email/note snapshot locators | Source extensions |
| v20 | Validation | `validation_runs`, `validation_findings`, `artifact_dependencies`, `stale_markers` | Validation |
| v21 | Agent/inference | agent runs/events/tool calls/approvals/proposals and privacy-profile additions | Agent Broker |
| v22 | Word bridge | `word_document_bindings`, `word_sync_sessions`, `word_operations` | Word |
| v23 | Legacy migration ledger | `legacy_migration_runs`, `legacy_migration_items`, `legacy_migration_errors` | Legacy migration |
| v24 | Evaluation | `eval_cases`, `eval_runs`, `eval_annotations` | Evaluation/release quality |

If implementation reveals a necessary separation, allocate another version;
never append unrelated DDL to an already reviewed migration.

## 3. Invariants enforced by schema and service

### MatterProfile

- `project_id` is both primary/unique ownership and a foreign key to Projects.
- Project deletion follows the existing Project ownership policy.
- nullable legal metadata is not a place for source facts or model conclusions.
- create-Matter service writes Project and MatterProfile in one transaction.

### Artifact graph

- Artifact IDs and revisions are Project-scoped through verified ownership.
- `current_revision_id` must point to a revision owned by that Artifact.
- Artifact rows hold stable identity/status; payload lives in immutable revision
  JSON with a bounded, named schema.
- revision, source-link, and relation updates are rejected; corrections append.
- source links bind an existing snapshot and optional anchor from the same
  Project and store a typed support relation.
- relation endpoints belong to the same Project and reject self/cycle/type
  combinations not permitted by the relation registry.

### Review

- a Review Item references a target; it does not clone the target payload;
- a target/dedup key prevents duplicate open review work;
- one unresolved item cannot have a terminal decision;
- acceptance/modification/rejection and Artifact revision promotion occur in a
  single service transaction with audit protection healthy;
- client instructions and conflicts are marked non-batchable.

### Work Queue

- automated sources carry a stable dedup key;
- completion is timestamped and retained;
- source ID, related Artifact, owner, priority, and due date remain separately
  queryable; no source payload is copied.

### Conversations

- audio blob reference and Source Snapshot belong to the session Project;
- segment time ranges are non-negative and ordered;
- machine text is immutable; reviewed text is a separate nullable field or
  revision record and never replaces machine text;
- extraction references one or more session segments and exactly one Review
  Item before promotion;
- speaker confirmation is explicit; customer instructions cannot be accepted
  without the required confirmation checks.

## 4. Source model evolution

The current source foundation is extended rather than replaced. Existing
Project-document and legal-authority snapshots remain byte-for-byte readable.
New `source_kind` values and strict locator schemas are additive.

Conversation locator:

```json
{
  "sessionId": "...",
  "segmentId": "...",
  "startMs": 0,
  "endMs": 1200,
  "participantId": null,
  "transcriptRevision": "machine:1"
}
```

Email, authority, and note locators are similarly strict, bounded, and free of
credentials or local paths. Anchor validation includes quote or segment hash.
A changed transcript/document creates a new snapshot; it does not update the
old source.

An email or manual note also needs a canonical original. v19 therefore owns a
Project-scoped source record and immutable version in the existing SQLCipher
database, with content in the existing encrypted blob store. Email import
preserves the original message bytes plus normalized body ranges; manual-note
edits append versions. The snapshot capture API binds one exact record version.
There is no arbitrary mailbox connector in this migration: external provider
access requires a later allowlisted credential/egress adapter, and fixture or
link-only metadata cannot stand in for captured content.

## 5. Legacy mapping

| Legacy object | New target | Conflict behavior |
| --- | --- | --- |
| Matter | Project + MatterProfile | Preserve Legacy ID; do not merge by name. |
| Fact | `fact` Artifact + migration revision | Preserve allegation/confirmation ambiguity in payload and report. |
| Evidence | `evidence_item` Artifact + source link | Missing source/anchor is reported; never fabricate one. |
| Issue | `issue` Artifact | Preserve status and original text; unknown status is explicit. |
| Position | `position` Artifact/revisions | Order by verified timestamps only; ambiguous order is reported. |
| Decision/Review | decision Artifact or review history | No automatic acceptance without a provable Legacy decision. |
| Task/Deadline | Work Item | Preserve due date and completion history; rule provenance stays linked. |
| Voice | Conversation session | Missing audio/transcript lineage is reported; no synthetic source. |
| Draft | Studio document/version | Import immutable bytes/text and citations when verifiable. |

Every created object stores its Legacy type and ID in bounded migration
metadata or the migration-item ledger. The unique key is migration source +
Legacy type + Legacy ID + target type, making reruns idempotent.

## 6. Legacy migration lifecycle

```text
preflight
  -> encrypted backup + restore verification
  -> dry-run scan
  -> deterministic mapping report
  -> user-visible conflicts/unmigratable items
  -> execute in bounded batches
  -> per-item verification
  -> compatibility and isolation report
  -> Legacy read-only mode
```

Run states are `planned`, `dry_run_complete`, `running`, `complete`, `partial`,
and `failed`. Item states distinguish `mapped`, `created`, `already_migrated`,
`conflict`, `unmigratable`, and `failed`. Safe error records contain object IDs
and normalized reasons, not secrets, absolute paths, raw audio, or unrestricted
document content.

Failure of one bounded item is recorded without guessing. Transaction scope is
small enough to resume but large enough that a target object and all mandatory
links cannot become partially visible.

## 7. Upgrade tests per migration

Each migration adds:

- clean SQLCipher install and v14-to-current upgrade;
- upgrade from all runtime-valid historical prefixes through the default chain;
- migration checksum and idempotent rerun;
- DDL plus ledger rollback on injected failure;
- foreign-key, CHECK, trigger, and immutable-row tests;
- malformed/boundary JSON and cross-Project isolation tests;
- existing Project/document/source/Studio data preservation;
- application restart and backup/restore verification;
- plaintext/SQLCipher downgrade fail-closed tests.

Legacy migration additionally uses a real old-schema fixture, dry run, repeated
execution, partial failure, restore, and read-only enforcement. Fixtures are
test evidence only and must never be described as a live provider or real user
migration.

## 8. Rollback and recovery

New background jobs are disabled before rollback. A compatibility binary that
contains the new migration registry can run against the additive schema; a
pre-registry binary cannot and requires restoration of the verified encrypted
pre-migration backup. If a new migration fails, its transaction and ledger row
roll back together. If Legacy object migration is partial, rerun from the
recorded item state; do not delete successful new objects.

Restoring the pre-migration encrypted backup is an explicit whole-workspace
recovery path and is verified before destructive Legacy deletion is ever
considered. No early phase drops Legacy tables, blobs, or source files.
