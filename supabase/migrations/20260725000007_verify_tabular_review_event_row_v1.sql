-- Atomic, server-owned final claim for timeline "Sources verified".  The
-- mechanical quote relocation happens in the application layer first; this
-- function is the linearization point that removes the check-then-act gap
-- between quote extraction and the verified claim.  It receives row identity
-- only — never client bindings or a client status — re-reads the locked row's
-- own source_bindings, locks and rechecks every pinned Document and current
-- DocumentVersion (non-deleted, same Matter), and only then sets
-- review_status='verified' with a revision increment in one transaction.

create or replace function public.verify_tabular_review_event_row_v1(
  p_review_id uuid,
  p_row_id uuid,
  p_expected_revision integer
)
returns table(
  id uuid,
  review_id uuid,
  origin text,
  event_text text,
  sort_key text,
  sort_precision text,
  source_bindings jsonb,
  conflict_group text,
  revision integer,
  review_status text,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_matter_id uuid;
  v_row public.tabular_review_rows%rowtype;
begin
  if p_review_id is null or p_row_id is null
    or p_expected_revision is null or p_expected_revision < 1 then
    raise exception 'invalid event row verification input';
  end if;

  -- Lock the review first so its Matter scope cannot move while the row and
  -- its pinned sources are rechecked.
  select claimed_review.project_id into v_matter_id
  from public.tabular_reviews claimed_review
  where claimed_review.id = p_review_id
  for update;
  if not found then
    raise exception 'The event row changed; reload it before saving';
  end if;
  if v_matter_id is null then
    raise exception 'Source-bound event rows require a Matter';
  end if;

  -- Lock the authoritative event row; the stored row, not any client payload,
  -- supplies the revision, status, and bindings under claim.
  select * into v_row
  from public.tabular_review_rows claimed_row
  where claimed_row.id = p_row_id
    and claimed_row.review_id = p_review_id
  for update;
  if not found or v_row.revision <> p_expected_revision then
    raise exception 'The event row changed; reload it before saving';
  end if;
  if jsonb_typeof(v_row.source_bindings) is distinct from 'array'
    or jsonb_array_length(v_row.source_bindings) < 1 then
    raise exception 'An event without source evidence cannot be verified';
  end if;
  if v_row.conflict_group is not null then
    raise exception 'Resolve the event conflict before marking it verified';
  end if;

  -- Malformed stored identities fail closed instead of raising a cast error.
  if exists (
    select 1
    from jsonb_array_elements(v_row.source_bindings) binding(value)
    where coalesce(binding.value ->> 'document_id', '')
        !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
       or coalesce(binding.value ->> 'version_id', '')
        !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  ) then
    raise exception 'Event source evidence is unavailable, outside this Matter, or no longer current';
  end if;

  -- Lock every pinned Document and pinned DocumentVersion in deterministic
  -- UUID order so a concurrent upload or deletion cannot move
  -- current_version_id or deleted_at between this recheck and the verified
  -- claim below.
  perform 1
  from public.documents locked_document
  where locked_document.id in (
    select (binding.value ->> 'document_id')::uuid
    from jsonb_array_elements(v_row.source_bindings) binding(value)
  )
  order by locked_document.id
  for update;
  perform 1
  from public.document_versions locked_version
  where locked_version.id in (
    select (binding.value ->> 'version_id')::uuid
    from jsonb_array_elements(v_row.source_bindings) binding(value)
  )
  order by locked_version.id
  for update;

  if exists (
    select 1
    from jsonb_array_elements(v_row.source_bindings) binding(value)
      left join public.documents pinned_document
        on pinned_document.id = (binding.value ->> 'document_id')::uuid
      left join public.document_versions pinned_version
        on pinned_version.id = (binding.value ->> 'version_id')::uuid
        and pinned_version.document_id = pinned_document.id
    where pinned_document.id is null
      or pinned_document.project_id is distinct from v_matter_id
      or pinned_document.current_version_id is distinct from
        (binding.value ->> 'version_id')::uuid
      or pinned_version.id is null
      or pinned_version.deleted_at is not null
  ) then
    raise exception 'Event source evidence is unavailable, outside this Matter, or no longer current';
  end if;

  update public.tabular_review_rows claimed_row
  set review_status = 'verified',
    revision = claimed_row.revision + 1,
    updated_at = now()
  where claimed_row.id = p_row_id
    and claimed_row.review_id = p_review_id;

  return query
  select returned_row.id,
    returned_row.review_id,
    returned_row.origin,
    returned_row.event_text,
    returned_row.sort_key,
    returned_row.sort_precision,
    returned_row.source_bindings,
    returned_row.conflict_group,
    returned_row.revision,
    returned_row.review_status,
    returned_row.created_at,
    returned_row.updated_at
  from public.tabular_review_rows returned_row
  where returned_row.id = p_row_id
    and returned_row.review_id = p_review_id;
end;
$$;

revoke all on function public.verify_tabular_review_event_row_v1(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.verify_tabular_review_event_row_v1(uuid, uuid, integer) to service_role;
