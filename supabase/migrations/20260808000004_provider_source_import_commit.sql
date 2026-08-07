-- Serialize provider-source Version allocation and current-pointer activation
-- for one existing Matter-owned Document. Storage bytes are uploaded to a
-- deterministic path before this commit and verified again by the server.

create or replace function public.commit_provider_source_version_v1(
  p_document_id uuid,
  p_version_id uuid,
  p_user_id text,
  p_matter_id uuid,
  p_expected_current_version_id uuid,
  p_storage_path text,
  p_filename text,
  p_file_type text,
  p_size_bytes integer,
  p_provider_source jsonb,
  p_updated_at timestamptz
)
returns table(outcome text, version_number integer, current_version_id uuid)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_document public.documents%rowtype;
  v_version public.document_versions%rowtype;
  v_version_number integer;
  v_created boolean := false;
begin
  if p_document_id is null
    or p_version_id is null
    or p_user_id is null
    or length(trim(p_user_id)) = 0
    or p_matter_id is null
    or p_storage_path is null
    or length(trim(p_storage_path)) = 0
    or length(p_storage_path) > 2000
    or p_filename is null
    or length(trim(p_filename)) = 0
    or length(p_filename) > 500
    or coalesce(p_file_type, '') not in ('txt', 'json', 'xml')
    or p_size_bytes is null
    or p_size_bytes < 1
    or p_size_bytes > 2000000
    or p_updated_at is null
    or jsonb_typeof(p_provider_source) is distinct from 'object'
    or p_provider_source ->> 'schema_version'
      is distinct from 'provider_source_provenance_v1'
    or coalesce(p_provider_source ->> 'connector_id', '') = ''
    or coalesce(p_provider_source ->> 'provider_id', '') = ''
    or coalesce(p_provider_source ->> 'external_id', '') = ''
    or coalesce(p_provider_source ->> 'snapshot_ref', '') = ''
    or coalesce(p_provider_source ->> 'content_sha256', '')
      !~ '^sha256:[a-f0-9]{64}$'
    or jsonb_typeof(p_provider_source -> 'metadata') is distinct from 'object'
    or jsonb_path_exists(p_provider_source, '$.**.source_body')
    or (p_provider_source
      - 'schema_version'
      - 'connector_id'
      - 'connector_version'
      - 'provider_id'
      - 'provider_version'
      - 'request_ref'
      - 'snapshot_ref'
      - 'external_id'
      - 'source_kind'
      - 'title'
      - 'canonical_url'
      - 'retrieved_at'
      - 'as_of_date'
      - 'content_sha256'
      - 'metadata') is distinct from '{}'::jsonb then
    return query select 'invalid_input'::text, null::integer, null::uuid;
    return;
  end if;

  select * into v_document
  from public.documents
  where id = p_document_id
  for update;
  if not found
    or v_document.user_id is distinct from p_user_id
    or v_document.project_id is distinct from p_matter_id then
    return query select 'scope_conflict'::text, null::integer, null::uuid;
    return;
  end if;
  if v_document.current_version_id is distinct from p_expected_current_version_id
    and v_document.current_version_id is distinct from p_version_id then
    return query select
      'current_conflict'::text,
      null::integer,
      v_document.current_version_id;
    return;
  end if;

  select * into v_version
  from public.document_versions
  where id = p_version_id
  for update;
  if found then
    if v_version.document_id is distinct from p_document_id
      or v_version.deleted_at is not null
      or v_version.storage_path is null
      or v_version.source is distinct from 'provider_import'
      or v_version.version_number is null
      or v_version.version_number < 1
      or v_version.filename is null
      or v_version.file_type is distinct from p_file_type
      or v_version.size_bytes is distinct from p_size_bytes
      or jsonb_build_object(
        'provider_id', v_version.provider_source ->> 'provider_id',
        'external_id', v_version.provider_source ->> 'external_id',
        'source_kind', v_version.provider_source ->> 'source_kind',
        'content_sha256', v_version.provider_source ->> 'content_sha256'
      ) is distinct from jsonb_build_object(
        'provider_id', p_provider_source ->> 'provider_id',
        'external_id', p_provider_source ->> 'external_id',
        'source_kind', p_provider_source ->> 'source_kind',
        'content_sha256', p_provider_source ->> 'content_sha256'
      ) then
      return query select
        'binding_conflict'::text,
        null::integer,
        v_document.current_version_id;
      return;
    end if;
    v_version_number := v_version.version_number;
  else
    select coalesce(max(dv.version_number), 0) + 1
    into v_version_number
    from public.document_versions dv
    where dv.document_id = p_document_id;
    insert into public.document_versions (
      id,
      document_id,
      storage_path,
      pdf_storage_path,
      source,
      version_number,
      filename,
      file_type,
      size_bytes,
      page_count,
      provider_source
    ) values (
      p_version_id,
      p_document_id,
      p_storage_path,
      null,
      'provider_import',
      v_version_number,
      p_filename,
      p_file_type,
      p_size_bytes,
      null,
      p_provider_source
    );
    v_created := true;
  end if;

  update public.documents
  set
    current_version_id = p_version_id,
    status = 'ready',
    updated_at = p_updated_at
  where id = p_document_id;

  return query select
    case when v_created then 'committed' else 'recovered' end,
    v_version_number,
    p_version_id;
end;
$$;

revoke execute on function public.commit_provider_source_version_v1(
  uuid, uuid, text, uuid, uuid, text, text, text, integer, jsonb, timestamptz
) from public, anon, authenticated;
grant execute on function public.commit_provider_source_version_v1(
  uuid, uuid, text, uuid, uuid, text, text, text, integer, jsonb, timestamptz
) to service_role;

comment on function public.commit_provider_source_version_v1(
  uuid, uuid, text, uuid, uuid, text, text, text, integer, jsonb, timestamptz
) is 'Atomically commits one validated provider snapshot as the current Version of an existing Matter-owned Document.';
