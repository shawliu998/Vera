# Matter List Pagination Contract

Date: 2026-07-16

Status: **implementation and local packaged acceptance complete; remote
final-commit CI pending**

## Request and response

```text
GET /api/v1/matters
  ?status=active|archived
  &profile_state=profiled|ready|classification_required|absent|all
  &cursor=<opaque>
  &limit=1..100
```

Defaults are `status=active`, `profile_state=all`, and `limit=50`. The response
contains `items` and nullable `next_cursor`; it intentionally contains no total
count.

Profile-state meanings are exact:

| Filter | SQL meaning |
| --- | --- |
| `profiled` | A `matter_profiles` row exists, whether classified or legacy-unclassified. |
| `ready` | A Profile exists and `workspace_type IS NOT NULL`. |
| `classification_required` | A Profile exists and `workspace_type IS NULL`. |
| `absent` | No Profile exists. The Project remains generic. |
| `all` | No Profile predicate. |

## Ordering and cursor ownership

Filtering is applied in SQL before keyset ordering and `LIMIT`. Rows are ordered
by `projects.updated_at DESC, projects.id DESC`. The repository fetches
`limit + 1`, returns at most `limit`, and encodes the last returned ordering
key only when another row exists.

The opaque cursor also binds its `profile_state`. Reusing an `absent` cursor in
the `profiled` stream is a validation error. This prevents skipped or duplicated
rows when the UI paginates the two sections independently.

`updated_at` is the pagination clock. Combined Project/Profile edits use one
monotonic timestamp, so a successfully edited Matter moves coherently in the
Project-ordered stream. Cursor pagination is a traversal snapshot convention,
not a database snapshot: concurrent updates can legitimately move rows ahead
of an already-consumed cursor.

## UI behavior

The `/matters` page requests `profiled` and `absent` concurrently and keeps a
separate cursor and load-more state for each. It deduplicates appended rows by
Project ID. Section labels explicitly say “loaded”; their number is the rows
currently held by the renderer, not a total. No total is inferred from a full
page or from the presence/absence of `next_cursor`.

The focused audit inserts 100 newer generic Projects and two Matters, traverses
both streams, proves the two Matters are not hidden by the generic rows, and
rejects a cursor used with another filter.

## Non-claims

This contract does not promise offset pagination, a stable total, arbitrary
sorting, search, or a unified Matter-only table. The 100-Project traversal and
cursor-isolation evidence belongs to the focused repository/module audit; the
packaged acceptance proves truthful separated Matter/generic projections but
does not claim a 100-row UI load-more exercise.
