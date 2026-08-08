-- Litigation Evidence Inventory v1: keep generated cells inside the existing
-- Task-owned document-row Tabular Review. Generation can only write a fixed
-- cell while its owning Task lease is current; lawyer review lives in explicit
-- columns and is never overwritten by a retry.

-- The row primitive originally arrived in the shared Tabular Review migration.
-- Repeat the small structural baseline here so this capability fails loudly on
-- an incomplete deployment instead of creating a parallel evidence store.
alter table public.tabular_reviews
  add column if not exists row_protocol text;

update public.tabular_reviews
set row_protocol = 'unclaimed'
where row_protocol is null;

do $$
begin
  if exists (
    select 1
    from public.tabular_reviews
    where row_protocol not in ('unclaimed', 'document_rows', 'event_rows_v1')
  ) then
    raise exception 'Cannot establish Tabular row protocol baseline: unsupported row_protocol exists';
  end if;
  if not exists (
    select 1
    from pg_constraint
    where conname = 'tabular_reviews_row_protocol_check'
      and conrelid = 'public.tabular_reviews'::regclass
  ) then
    alter table public.tabular_reviews
      add constraint tabular_reviews_row_protocol_check
      check (row_protocol in ('unclaimed', 'document_rows', 'event_rows_v1'));
  end if;
end;
$$;

alter table public.tabular_reviews
  alter column row_protocol set default 'unclaimed';

alter table public.tabular_reviews
  alter column row_protocol set not null;

-- backend/migrations predates the shared Supabase event-row migration. Keep a
-- minimal compatible parent table here because the document-row cell baseline
-- has a composite FK to it. This creates no new review surface or object.
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

revoke all on public.tabular_review_rows from anon, authenticated;
grant all privileges on public.tabular_review_rows to service_role;

alter table public.tabular_cells
  add column if not exists row_id uuid;

alter table public.tabular_cells
  alter column document_id drop not null;

do $$
declare
  invalid_coordinate record;
begin
  select review_id, id
  into invalid_coordinate
  from public.tabular_cells
  where (row_id is null) = (document_id is null)
  limit 1;
  if found then
    raise exception
      'Cannot establish Tabular row baseline: cell % in review % must have exactly one document_id or row_id',
      invalid_coordinate.id,
      invalid_coordinate.review_id;
  end if;
  if not exists (
    select 1
    from pg_constraint
    where conname = 'tabular_cells_document_xor_row_check'
      and conrelid = 'public.tabular_cells'::regclass
  ) then
    alter table public.tabular_cells
      add constraint tabular_cells_document_xor_row_check
      check ((row_id is null) <> (document_id is null));
  end if;
  if not exists (
    select 1
    from pg_constraint
    where conname = 'tabular_cells_review_row_fkey'
      and conrelid = 'public.tabular_cells'::regclass
  ) then
    alter table public.tabular_cells
      add constraint tabular_cells_review_row_fkey
      foreign key (review_id, row_id)
      references public.tabular_review_rows(review_id, id)
      on delete cascade;
  end if;
end;
$$;

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
      'Cannot establish Tabular coordinate uniqueness: duplicate document-row cell review_id=% document_id=% column_index=%',
      duplicate_coordinate.review_id,
      duplicate_coordinate.document_id,
      duplicate_coordinate.column_index;
  end if;
end;
$$;

create unique index if not exists tabular_cells_legacy_coordinate_unique
  on public.tabular_cells(review_id, document_id, column_index)
  where row_id is null;

create unique index if not exists tabular_cells_event_coordinate_unique
  on public.tabular_cells(review_id, row_id, column_index)
  where row_id is not null;

-- These are the authoritative lawyer-review fields. A generated content
-- envelope retains only model_review_status; review/export decisions must read
-- these server-owned columns.
alter table public.tabular_cells
  add column if not exists review_status text,
  add column if not exists reviewed_at timestamptz,
  add column if not exists review_revision integer not null default 0;

update public.tabular_cells
set review_revision = 0
where review_revision is null;

do $$
begin
  if exists (
    select 1
    from public.tabular_cells
    where review_status is not null
      and review_status not in ('verified', 'unresolved', 'needs_correction')
  ) then
    raise exception 'Cannot establish lawyer review baseline: unsupported review_status exists';
  end if;
  if exists (
    select 1
    from public.tabular_cells
    where review_revision < 0
  ) then
    raise exception 'Cannot establish lawyer review baseline: negative review_revision exists';
  end if;
  if exists (
    select 1
    from public.tabular_cells
    where (review_status is null) <> (reviewed_at is null)
  ) then
    raise exception 'Cannot establish lawyer review baseline: review_status and reviewed_at must move together';
  end if;
  if not exists (
    select 1
    from pg_constraint
    where conname = 'tabular_cells_review_status_check'
      and conrelid = 'public.tabular_cells'::regclass
  ) then
    alter table public.tabular_cells
      add constraint tabular_cells_review_status_check
      check (
        review_status is null
        or review_status in ('verified', 'unresolved', 'needs_correction')
      );
  end if;
  if not exists (
    select 1
    from pg_constraint
    where conname = 'tabular_cells_review_revision_check'
      and conrelid = 'public.tabular_cells'::regclass
  ) then
    alter table public.tabular_cells
      add constraint tabular_cells_review_revision_check
      check (review_revision >= 0);
  end if;
  if not exists (
    select 1
    from pg_constraint
    where conname = 'tabular_cells_review_timestamp_pair_check'
      and conrelid = 'public.tabular_cells'::regclass
  ) then
    alter table public.tabular_cells
      add constraint tabular_cells_review_timestamp_pair_check
      check ((review_status is null) = (reviewed_at is null));
  end if;
end;
$$;

create or replace function public.commit_agent_litigation_evidence_cell_v1(
  p_task_id uuid,
  p_user_id text,
  p_step_id uuid,
  p_step_attempt integer,
  p_lease_owner uuid,
  p_review_id uuid,
  p_cell_id uuid,
  p_document_id uuid,
  p_version_id uuid,
  p_column_index integer,
  p_content text,
  p_citations jsonb
)
returns table(
  outcome text,
  cell_id uuid,
  cell_status text,
  review_status text,
  review_revision integer,
  reviewed_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_task public.agent_tasks%rowtype;
  v_step public.agent_steps%rowtype;
  v_review public.tabular_reviews%rowtype;
  v_cell public.tabular_cells%rowtype;
  v_effect_count integer;
  v_receipt_cell_count integer;
  v_source_count integer;
begin
  if p_task_id is null
    or p_user_id is null
    or length(trim(p_user_id)) = 0
    or p_step_id is null
    or p_step_attempt is null
    or p_step_attempt < 1
    or p_lease_owner is null
    or p_review_id is null
    or p_cell_id is null
    or p_document_id is null
    or p_version_id is null
    or p_column_index is null
    or p_column_index < 0
    or p_content is null
    or length(trim(p_content)) not between 2 and 120000
    or jsonb_typeof(p_citations) is distinct from 'array'
    or jsonb_array_length(p_citations) > 24
    or length(p_citations::text) > 120000 then
    return query select
      'invalid_input'::text, null::uuid, null::text, null::text,
      null::integer, null::timestamptz;
    return;
  end if;

  select * into v_task
  from public.agent_tasks
  where id = p_task_id and user_id = p_user_id
  for update;
  if not found then
    return query select
      'not_found'::text, null::uuid, null::text, null::text,
      null::integer, null::timestamptz;
    return;
  end if;
  if v_task.status not in ('running', 'verifying')
    or v_task.current_step is distinct from p_step_id
    or v_task.execution_lease_owner is distinct from p_lease_owner
    or v_task.execution_lease_expires_at is null
    or v_task.execution_lease_expires_at <= clock_timestamp() then
    return query select
      'lease_lost'::text, null::uuid, null::text, null::text,
      null::integer, null::timestamptz;
    return;
  end if;

  select * into v_step
  from public.agent_steps
  where id = p_step_id and task_id = p_task_id
  for update;
  if not found
    or v_step.status <> 'running'
    or v_step.attempt <> p_step_attempt then
    return query select
      'conflict'::text, null::uuid, null::text, null::text,
      null::integer, null::timestamptz;
    return;
  end if;

  if jsonb_typeof(v_step.result_data) is distinct from 'object'
    or jsonb_typeof(v_step.result_data -> 'tabular_effect_receipts')
      is distinct from 'object' then
    return query select
      'artifact_invalid'::text, null::uuid, null::text, null::text,
      null::integer, null::timestamptz;
    return;
  end if;
  select count(*) into v_effect_count
  from jsonb_each(v_step.result_data -> 'tabular_effect_receipts') receipt
  where receipt.value ->> 'kind' = 'agent_step_tabular_effect_v1'
    and receipt.value ->> 'step_id' = p_step_id::text
    and receipt.value ->> 'attempt' = p_step_attempt::text
    and receipt.value ->> 'operation' = 'create_tabular_review'
    and receipt.value ->> 'status' = 'committed'
    and receipt.value -> 'target' ->> 'review_id' = p_review_id::text
    and receipt.value -> 'effect' ->> 'review_id' = p_review_id::text
    and receipt.value -> 'effect' ->> 'artifact_type' = 'tabular_review';
  if v_effect_count <> 1 then
    return query select
      'artifact_invalid'::text, null::uuid, null::text, null::text,
      null::integer, null::timestamptz;
    return;
  end if;

  if jsonb_typeof(v_task.latest_checkpoint -> 'fixed_matter_context')
      is distinct from 'object'
    or jsonb_typeof(v_task.latest_checkpoint -> 'contract' -> 'context_manifest')
      is distinct from 'object'
    or v_task.latest_checkpoint -> 'fixed_matter_context'
      is distinct from v_task.latest_checkpoint -> 'contract' -> 'context_manifest'
    or v_task.latest_checkpoint -> 'fixed_matter_context' ->> 'matter_id'
      is distinct from v_task.matter_id::text
    or jsonb_typeof(
      v_task.latest_checkpoint -> 'fixed_matter_context' -> 'sources'
    ) is distinct from 'array'
    or jsonb_typeof(
      v_task.latest_checkpoint -> 'litigation_evidence_inventory_receipt'
    ) is distinct from 'object' then
    return query select
      'artifact_invalid'::text, null::uuid, null::text, null::text,
      null::integer, null::timestamptz;
    return;
  end if;

  if v_task.latest_checkpoint
        -> 'litigation_evidence_inventory_receipt' ->> 'kind'
      is distinct from 'litigation_evidence_inventory_receipt_v1'
    or v_task.latest_checkpoint
        -> 'litigation_evidence_inventory_receipt' ->> 'task_id'
      is distinct from p_task_id::text
    or v_task.latest_checkpoint
        -> 'litigation_evidence_inventory_receipt' ->> 'matter_id'
      is distinct from v_task.matter_id::text
    or v_task.latest_checkpoint
        -> 'litigation_evidence_inventory_receipt' ->> 'step_id'
      is distinct from p_step_id::text
    or v_task.latest_checkpoint
        -> 'litigation_evidence_inventory_receipt' ->> 'attempt'
      is distinct from p_step_attempt::text
    or v_task.latest_checkpoint
        -> 'litigation_evidence_inventory_receipt' ->> 'review_id'
      is distinct from p_review_id::text
    or jsonb_typeof(
      v_task.latest_checkpoint
        -> 'litigation_evidence_inventory_receipt' -> 'cells'
    ) is distinct from 'array' then
    return query select
      'artifact_invalid'::text, null::uuid, null::text, null::text,
      null::integer, null::timestamptz;
    return;
  end if;
  select count(*) into v_receipt_cell_count
  from jsonb_array_elements(
    v_task.latest_checkpoint
      -> 'litigation_evidence_inventory_receipt' -> 'cells'
  ) receipt_cell
  where receipt_cell.value ->> 'cell_id' = p_cell_id::text
    and receipt_cell.value ->> 'document_id' = p_document_id::text
    and receipt_cell.value ->> 'version_id' = p_version_id::text
    and receipt_cell.value ->> 'field_index' = p_column_index::text;
  if v_receipt_cell_count <> 1 then
    return query select
      'artifact_invalid'::text, null::uuid, null::text, null::text,
      null::integer, null::timestamptz;
    return;
  end if;

  select count(*) into v_source_count
  from jsonb_array_elements(
    v_task.latest_checkpoint -> 'fixed_matter_context' -> 'sources'
  ) source
  join public.documents document_row
    on document_row.id = p_document_id
  join public.document_versions version_row
    on version_row.id = p_version_id
  where source.value ->> 'document_id' = p_document_id::text
    and source.value ->> 'version_id' = p_version_id::text
    and source.value ->> 'role' = 'source'
    and document_row.user_id = p_user_id
    and document_row.project_id = v_task.matter_id
    and document_row.status = 'ready'
    and document_row.current_version_id = p_version_id
    and version_row.document_id = p_document_id
    and version_row.deleted_at is null
    and version_row.storage_path is not null;
  if v_source_count <> 1 then
    return query select
      'artifact_invalid'::text, null::uuid, null::text, null::text,
      null::integer, null::timestamptz;
    return;
  end if;

  select * into v_review
  from public.tabular_reviews review_row
  where review_row.id = p_review_id
    and review_row.project_id = v_task.matter_id
    and review_row.user_id = p_user_id
    and review_row.row_protocol = 'document_rows'
  for update;
  if not found then
    return query select
      'artifact_invalid'::text, null::uuid, null::text, null::text,
      null::integer, null::timestamptz;
    return;
  end if;

  select * into v_cell
  from public.tabular_cells cell_row
  where cell_row.id = p_cell_id
    and cell_row.review_id = p_review_id
  for update;
  if not found
    or v_cell.document_id is distinct from p_document_id
    or v_cell.row_id is not null
    or v_cell.column_index is distinct from p_column_index then
    return query select
      'artifact_invalid'::text, null::uuid, null::text, null::text,
      null::integer, null::timestamptz;
    return;
  end if;

  if v_cell.status = 'done' then
    if v_cell.content is not distinct from p_content
      and v_cell.citations is not distinct from p_citations then
      return query select
        'recovered'::text,
        v_cell.id,
        v_cell.status,
        v_cell.review_status,
        v_cell.review_revision,
        v_cell.reviewed_at;
      return;
    end if;
    return query select
      'conflict'::text,
      v_cell.id,
      v_cell.status,
      v_cell.review_status,
      v_cell.review_revision,
      v_cell.reviewed_at;
    return;
  end if;

  if v_cell.review_status is not null then
    return query select
      'review_locked'::text,
      v_cell.id,
      v_cell.status,
      v_cell.review_status,
      v_cell.review_revision,
      v_cell.reviewed_at;
    return;
  end if;
  if v_cell.status <> 'pending' then
    return query select
      'conflict'::text,
      v_cell.id,
      v_cell.status,
      v_cell.review_status,
      v_cell.review_revision,
      v_cell.reviewed_at;
    return;
  end if;

  update public.tabular_cells
  set content = p_content, citations = p_citations, status = 'done'
  where id = v_cell.id;

  return query select
    'committed'::text,
    v_cell.id,
    'done'::text,
    v_cell.review_status,
    v_cell.review_revision,
    v_cell.reviewed_at;
end;
$$;

-- Lawyer review is a compare-and-swap transition over the same existing cell.
-- It never rewrites generated content or citations, so a stale reviewer cannot
-- erase a more recent disposition.
create or replace function public.review_litigation_evidence_cell_v1(
  p_user_id text,
  p_review_id uuid,
  p_cell_id uuid,
  p_expected_review_revision integer,
  p_review_status text
)
returns table(
  outcome text,
  cell_id uuid,
  cell_status text,
  review_status text,
  review_revision integer,
  reviewed_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_review public.tabular_reviews%rowtype;
  v_cell public.tabular_cells%rowtype;
  v_reviewed_at timestamptz := clock_timestamp();
begin
  if p_user_id is null
    or length(trim(p_user_id)) = 0
    or p_review_id is null
    or p_cell_id is null
    or p_expected_review_revision is null
    or p_expected_review_revision < 0
    or p_review_status is null
    or p_review_status not in ('verified', 'unresolved', 'needs_correction') then
    return query select
      'invalid_input'::text, null::uuid, null::text, null::text,
      null::integer, null::timestamptz;
    return;
  end if;

  select * into v_review
  from public.tabular_reviews review_row
  where review_row.id = p_review_id
    and review_row.user_id = p_user_id
    and review_row.row_protocol = 'document_rows'
  for update;
  if not found then
    return query select
      'not_found'::text, null::uuid, null::text, null::text,
      null::integer, null::timestamptz;
    return;
  end if;

  select * into v_cell
  from public.tabular_cells cell_row
  where cell_row.id = p_cell_id
    and cell_row.review_id = p_review_id
    and cell_row.row_id is null
  for update;
  if not found then
    return query select
      'not_found'::text, null::uuid, null::text, null::text,
      null::integer, null::timestamptz;
    return;
  end if;
  if v_cell.status not in ('pending', 'done') then
    return query select
      'artifact_invalid'::text,
      v_cell.id,
      v_cell.status,
      v_cell.review_status,
      v_cell.review_revision,
      v_cell.reviewed_at;
    return;
  end if;
  if p_review_status = 'verified'
    and (
      v_cell.status <> 'done'
      or v_cell.content is null
      or jsonb_typeof(v_cell.citations) is distinct from 'array'
    ) then
    return query select
      'artifact_invalid'::text,
      v_cell.id,
      v_cell.status,
      v_cell.review_status,
      v_cell.review_revision,
      v_cell.reviewed_at;
    return;
  end if;
  if v_cell.review_revision <> p_expected_review_revision then
    return query select
      'conflict'::text,
      v_cell.id,
      v_cell.status,
      v_cell.review_status,
      v_cell.review_revision,
      v_cell.reviewed_at;
    return;
  end if;

  update public.tabular_cells
  set
    review_status = p_review_status,
    reviewed_at = v_reviewed_at,
    review_revision = v_cell.review_revision + 1
  where id = v_cell.id;

  return query select
    'reviewed'::text,
    v_cell.id,
    v_cell.status,
    p_review_status,
    v_cell.review_revision + 1,
    v_reviewed_at;
end;
$$;

revoke all on function public.commit_agent_litigation_evidence_cell_v1(
  uuid, text, uuid, integer, uuid, uuid, uuid, uuid, uuid, integer, text, jsonb
) from public, anon, authenticated;
grant execute on function public.commit_agent_litigation_evidence_cell_v1(
  uuid, text, uuid, integer, uuid, uuid, uuid, uuid, uuid, integer, text, jsonb
) to service_role;

revoke all on function public.review_litigation_evidence_cell_v1(
  text, uuid, uuid, integer, text
) from public, anon, authenticated;
grant execute on function public.review_litigation_evidence_cell_v1(
  text, uuid, uuid, integer, text
) to service_role;

comment on function public.commit_agent_litigation_evidence_cell_v1(
  uuid, text, uuid, integer, uuid, uuid, uuid, uuid, uuid, integer, text, jsonb
) is 'Commits one fixed, source-bound Litigation Evidence Inventory cell under the current Task lease without overwriting lawyer review.';

comment on function public.review_litigation_evidence_cell_v1(
  text, uuid, uuid, integer, text
) is 'Compare-and-swap lawyer disposition for one completed Litigation Evidence Inventory cell.';
