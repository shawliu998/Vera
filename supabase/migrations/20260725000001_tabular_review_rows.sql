-- Shared event-row primitive for litigation timelines and transaction reviews.
-- It remains a child of the existing Tabular Review; it is not another Review
-- or a second evidence store.

alter table public.tabular_reviews
  add column if not exists row_protocol text not null default 'unclaimed'
  check (row_protocol in ('unclaimed', 'document_rows', 'event_rows_v1'));

-- Existing Tabular Reviews are legacy document-row reviews whenever a cell or
-- Task/Memo link already exists. Do not infer event semantics from old data.
update public.tabular_reviews review
set row_protocol = 'document_rows'
where review.row_protocol = 'unclaimed'
  and (
    exists (
      select 1 from public.tabular_cells cell
      where cell.review_id = review.id
    )
    or (
      jsonb_typeof(review.document_ids) = 'array'
      and jsonb_array_length(review.document_ids) > 0
    )
    or exists (
      select 1 from public.agent_artifact_links link
      where link.artifact_type = 'tabular_review'
        and link.artifact_id = review.id::text
    )
  );

create table if not exists public.tabular_review_rows (
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null references public.tabular_reviews(id) on delete cascade,
  origin text not null check (origin in ('extracted', 'manual')),
  sort_key text not null check (char_length(btrim(sort_key)) between 1 and 128),
  sort_precision text not null
    check (sort_precision in ('day', 'month', 'year', 'unknown')),
  source_bindings jsonb not null default '[]'::jsonb
    check (jsonb_typeof(source_bindings) = 'array'),
  conflict_group text check (
    conflict_group is null or char_length(btrim(conflict_group)) between 1 and 128
  ),
  revision integer not null default 1 check (revision >= 1),
  review_status text not null default 'unverified'
    check (review_status in ('verified', 'unverified', 'needs_correction')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (review_id, id)
);

create index if not exists tabular_review_rows_review_sort_idx
  on public.tabular_review_rows(review_id, sort_key, id);

alter table public.tabular_cells
  add column if not exists row_id uuid;

alter table public.tabular_cells
  alter column document_id drop not null;

alter table public.tabular_cells
  drop constraint if exists tabular_cells_document_xor_row_check;

alter table public.tabular_cells
  add constraint tabular_cells_document_xor_row_check
  check ((row_id is null) <> (document_id is null));

alter table public.tabular_cells
  drop constraint if exists tabular_cells_review_row_fkey;

alter table public.tabular_cells
  add constraint tabular_cells_review_row_fkey
  foreign key (review_id, row_id)
  references public.tabular_review_rows(review_id, id)
  on delete cascade;

-- A legacy database may have duplicate cells because the former schema had no
-- coordinate uniqueness constraint. Stop with an actionable diagnostic rather
-- than silently deleting or merging user work.
do $$
declare
  duplicate_coordinate record;
begin
  select review_id, document_id, column_index
  into duplicate_coordinate
  from public.tabular_cells
  where row_id is null
  group by review_id, document_id, column_index
  having count(*) > 1
  limit 1;
  if found then
    raise exception
      'Cannot add Tabular coordinate uniqueness: duplicate legacy cell review_id=% document_id=% column_index=%',
      duplicate_coordinate.review_id,
      duplicate_coordinate.document_id,
      duplicate_coordinate.column_index;
  end if;
end $$;

create unique index if not exists tabular_cells_legacy_coordinate_unique
  on public.tabular_cells(review_id, document_id, column_index)
  where row_id is null;

create unique index if not exists tabular_cells_event_coordinate_unique
  on public.tabular_cells(review_id, row_id, column_index)
  where row_id is not null;

revoke all on public.tabular_review_rows from anon, authenticated;
grant all privileges on public.tabular_review_rows to service_role;
