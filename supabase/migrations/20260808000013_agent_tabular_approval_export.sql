-- Kernel v1: publish a Task-owned Tabular Review as one immutable approved
-- XLSX Version without letting a live Review, a stale verifier, or caller-
-- supplied export metadata cross the lawyer approval boundary.

-- This canonical encoder deliberately accepts only JSON numbers that survive
-- the PostgreSQL -> JSON -> JavaScript path as exact safe integers. Tabular
-- layouts and citations use integer coordinates; an unexpected decimal fails
-- closed instead of producing a cross-runtime fingerprint.
create or replace function public.agent_json_numbers_are_safe_integers_v1(
  p_value jsonb
)
returns boolean
language plpgsql
immutable
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_kind text;
  v_item jsonb;
  v_text text;
begin
  if p_value is null then
    return false;
  end if;
  v_kind := jsonb_typeof(p_value);
  if v_kind in ('null', 'string', 'boolean') then
    return true;
  end if;
  if v_kind = 'number' then
    v_text := p_value::text;
    return v_text ~ '^-?(0|[1-9][0-9]*)$'
      and abs(v_text::numeric) <= 9007199254740991::numeric;
  end if;
  if v_kind = 'array' then
    for v_item in select value from jsonb_array_elements(p_value) loop
      if not public.agent_json_numbers_are_safe_integers_v1(v_item) then
        return false;
      end if;
    end loop;
    return true;
  end if;
  if v_kind = 'object' then
    for v_item in select value from jsonb_each(p_value) loop
      if not public.agent_json_numbers_are_safe_integers_v1(v_item) then
        return false;
      end if;
    end loop;
    return true;
  end if;
  return false;
end;
$$;

-- Forward signature for the approval function body below. The complete
-- security-definer implementation replaces this declaration later in the
-- same atomic migration before any execute privilege is granted.
create or replace function public.prepare_agent_tabular_export_materialization_v1(
  p_task_id uuid,
  p_user_id text,
  p_review_id uuid,
  p_purpose text,
  p_verified_identity jsonb,
  p_filename text,
  p_size_bytes integer,
  p_sha256 text
)
returns table(
  outcome text,
  verified_identity jsonb,
  export_document_id uuid,
  export_version_id uuid,
  version_number integer,
  storage_path text,
  filename text,
  file_type text
)
language sql
as $$
  select 'invalid_input'::text, null::jsonb, null::uuid, null::uuid,
    null::integer, null::text, null::text, null::text;
$$;

create or replace function public.agent_draft_final_verifier_matches_v1(
  p_task_id uuid,
  p_document_id uuid,
  p_version_id uuid
)
returns boolean
language sql
as $$
  select false;
$$;

create or replace function public.agent_final_verifier_snapshot_matches_v1(
  p_task_id uuid,
  p_artifact_snapshot jsonb
)
returns boolean
language sql
as $$
  select false;
$$;

-- Replace only the approved branch with a strict Draft | current Tabular
-- union. changes_requested retains its established Contract revision behavior.
create or replace function public.record_agent_task_review_decision_v1(
  p_decision_id uuid,
  p_task_id uuid,
  p_user_id text,
  p_expected_latest_decision_id uuid,
  p_status text,
  p_note text,
  p_reviewer_email text,
  p_reviewer_name text,
  p_artifact_snapshot jsonb
)
returns table(outcome text, task_status text, current_step uuid)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_existing public.agent_task_review_decisions%rowtype;
  v_task public.agent_tasks%rowtype;
  v_latest_decision_id uuid;
  v_artifact_count integer;
  v_distinct_artifact_count integer;
  v_draft_count integer;
  v_valid_draft_count integer;
  v_required_deliverable_count integer;
  v_artifact jsonb;
  v_verified_identity jsonb;
  v_plan record;
  v_export_document_id uuid;
  v_export_version_id uuid;
  v_tabular_keys text[] := array[
    'kind', 'artifact_type', 'artifact_id', 'purpose', 'review_id',
    'row_protocol', 'input_digest', 'revision_fingerprint',
    'accepted_view_sha256', 'source_receipt_fingerprint',
    'decision_fingerprint', 'completion_sha256', 'export_document_id',
    'export_version_id', 'version_number', 'filename', 'file_type',
    'size_bytes', 'sha256'
  ];
  v_draft_keys text[] := array[
    'artifact_type', 'artifact_id', 'purpose', 'document_id', 'version_id',
    'version_number', 'filename', 'file_type', 'size_bytes', 'sha256'
  ];
begin
  if p_decision_id is null
    or p_task_id is null
    or p_user_id is null
    or length(trim(p_user_id)) = 0
    or p_status is null
    or p_status not in ('approved', 'changes_requested')
    or p_note is null
    or length(p_note) > 4000
    or (p_status = 'changes_requested' and length(trim(p_note)) = 0)
    or (p_reviewer_email is not null and length(p_reviewer_email) > 320)
    or (p_reviewer_name is not null and length(p_reviewer_name) > 300)
    or jsonb_typeof(p_artifact_snapshot) is distinct from 'array'
    or jsonb_array_length(p_artifact_snapshot) > 20 then
    return query select 'invalid_input'::text, null::text, null::uuid;
    return;
  end if;

  select * into v_existing
  from public.agent_task_review_decisions
  where id = p_decision_id;
  if found then
    if v_existing.task_id = p_task_id
      and v_existing.reviewer_id = p_user_id
      and v_existing.status = p_status
      and v_existing.note = p_note
      and v_existing.reviewer_email is not distinct from p_reviewer_email
      and v_existing.reviewer_name is not distinct from p_reviewer_name
      and v_existing.artifact_snapshot = p_artifact_snapshot then
      return query select 'recorded'::text, null::text, null::uuid;
    else
      return query select 'conflict'::text, null::text, null::uuid;
    end if;
    return;
  end if;

  select * into v_task
  from public.agent_tasks
  where id = p_task_id and user_id = p_user_id
  for update;
  if not found then
    return query select 'not_found'::text, null::text, null::uuid;
    return;
  end if;
  -- A concurrent exact replay can observe no Decision before it waits on the
  -- Task row. Re-read after the lock so idempotency does not degrade into a
  -- unique-key exception.
  select * into v_existing
  from public.agent_task_review_decisions
  where id = p_decision_id
  for share;
  if found then
    if v_existing.task_id = p_task_id
      and v_existing.reviewer_id = p_user_id
      and v_existing.status = p_status
      and v_existing.note = p_note
      and v_existing.reviewer_email is not distinct from p_reviewer_email
      and v_existing.reviewer_name is not distinct from p_reviewer_name
      and v_existing.artifact_snapshot = p_artifact_snapshot then
      return query select 'recorded'::text, null::text, null::uuid;
    else
      return query select 'conflict'::text, null::text, null::uuid;
    end if;
    return;
  end if;
  if v_task.execution_lease_owner is not null
    and v_task.execution_lease_expires_at > clock_timestamp() then
    return query select 'lease_busy'::text, v_task.status, v_task.current_step;
    return;
  end if;
  if v_task.status <> 'completed' then
    return query select 'task_not_completed'::text,
      v_task.status, v_task.current_step;
    return;
  end if;

  select id into v_latest_decision_id
  from public.agent_task_review_decisions
  where task_id = p_task_id
  order by created_at desc, id desc
  limit 1
  for share;
  if v_latest_decision_id is distinct from p_expected_latest_decision_id then
    return query select 'conflict'::text, v_task.status, v_task.current_step;
    return;
  end if;

  if p_status = 'changes_requested' then
    if jsonb_array_length(p_artifact_snapshot) = 0 then
      null;
    elsif jsonb_array_length(p_artifact_snapshot) <> 1
      or jsonb_typeof(p_artifact_snapshot -> 0) is distinct from 'object'
      or p_artifact_snapshot -> 0 ->> 'kind'
        is distinct from 'contract_playbook_disposition_revision_v1'
      or jsonb_typeof(p_artifact_snapshot -> 0 -> 'decisions')
        is distinct from 'array'
      or jsonb_array_length(p_artifact_snapshot -> 0 -> 'decisions')
        not between 1 and 80
      or exists (
        select 1
        from jsonb_array_elements(
          p_artifact_snapshot -> 0 -> 'decisions'
        ) decision
        where jsonb_typeof(decision) is distinct from 'object'
          or coalesce(decision ->> 'finding_id', '')
            !~ '^finding-[a-f0-9]{24}$'
          or coalesce(decision ->> 'disposition', '')
            not in ('accept', 'comment', 'skip')
          or not (decision ? 'direction')
          or (
            decision -> 'direction' <> 'null'::jsonb
            and jsonb_typeof(decision -> 'direction') is distinct from 'string'
          )
          or (
            decision -> 'direction' <> 'null'::jsonb
            and decision ->> 'disposition' is distinct from 'comment'
          )
      ) then
      return query select 'invalid_input'::text,
        v_task.status, v_task.current_step;
      return;
    end if;
  else
    -- A Task row protects its checkpoint/deliverables; share-lock every
    -- existing ArtifactLink so an approval cannot outlive a concurrent unlink.
    perform 1
    from public.agent_artifact_links link
    where link.task_id = p_task_id
    order by link.artifact_type, link.artifact_id, link.purpose
    for share;

    select
      count(*),
      count(distinct (
        coalesce(artifact ->> 'artifact_type', '') || ':' ||
        coalesce(artifact ->> 'artifact_id', '')
      )),
      count(*) filter (where artifact ->> 'artifact_type' = 'draft')
    into v_artifact_count, v_distinct_artifact_count, v_draft_count
    from jsonb_array_elements(p_artifact_snapshot) artifacts(artifact);
    if v_artifact_count <> v_distinct_artifact_count then
      return query select 'invalid_artifacts'::text,
        v_task.status, v_task.current_step;
      return;
    end if;

    if jsonb_typeof(v_task.deliverables) is distinct from 'array'
      or exists (
        select 1
        from jsonb_array_elements(v_task.deliverables) deliverable(value)
        where jsonb_typeof(deliverable.value) is distinct from 'object'
          or (
            deliverable.value ? 'required'
            and jsonb_typeof(deliverable.value -> 'required')
              is distinct from 'boolean'
          )
          or (
            deliverable.value ? 'artifact_id'
            and deliverable.value -> 'artifact_id' <> 'null'::jsonb
            and jsonb_typeof(deliverable.value -> 'artifact_id')
              is distinct from 'string'
          )
          or (
            not (deliverable.value ? 'required')
            or deliverable.value ->> 'required' <> 'false'
          ) and (
            deliverable.value ->> 'artifact_type'
              not in ('draft', 'tabular_review')
            or length(trim(coalesce(deliverable.value ->> 'purpose', '')))
              not between 1 and 300
          )
      ) then
      return query select 'invalid_artifacts'::text,
        v_task.status, v_task.current_step;
      return;
    end if;
    select count(*) into v_required_deliverable_count
    from jsonb_array_elements(v_task.deliverables) deliverable(value)
    where not (deliverable.value ? 'required')
      or deliverable.value ->> 'required' <> 'false';
    if v_required_deliverable_count <> v_artifact_count
      or exists (
        select 1
        from jsonb_array_elements(v_task.deliverables) deliverable(value)
        where (
          not (deliverable.value ? 'required')
          or deliverable.value ->> 'required' <> 'false'
        ) and 1 <> (
          select count(*)
          from jsonb_array_elements(p_artifact_snapshot) artifact(value)
          where artifact.value ->> 'artifact_type'
              = deliverable.value ->> 'artifact_type'
            and artifact.value ->> 'purpose'
              = deliverable.value ->> 'purpose'
            and (
              not (deliverable.value ? 'artifact_id')
              or deliverable.value -> 'artifact_id' = 'null'::jsonb
              or artifact.value ->> 'artifact_id'
                = deliverable.value ->> 'artifact_id'
            )
        )
      )
      or exists (
        select 1
        from jsonb_array_elements(p_artifact_snapshot) artifact(value)
        where 1 <> (
          select count(*)
          from jsonb_array_elements(v_task.deliverables) deliverable(value)
          where (
            not (deliverable.value ? 'required')
            or deliverable.value ->> 'required' <> 'false'
          )
            and deliverable.value ->> 'artifact_type'
              = artifact.value ->> 'artifact_type'
            and deliverable.value ->> 'purpose'
              = artifact.value ->> 'purpose'
            and (
              not (deliverable.value ? 'artifact_id')
              or deliverable.value -> 'artifact_id' = 'null'::jsonb
              or deliverable.value ->> 'artifact_id'
                = artifact.value ->> 'artifact_id'
            )
        )
      ) then
      return query select 'invalid_artifacts'::text,
        v_task.status, v_task.current_step;
      return;
    end if;

    if not public.agent_final_verifier_snapshot_matches_v1(
      p_task_id,
      p_artifact_snapshot
    ) then
      return query select 'invalid_artifacts'::text,
        v_task.status, v_task.current_step;
      return;
    end if;

    if exists (
      select 1
      from jsonb_array_elements(p_artifact_snapshot) artifact(value)
      where artifact.value ->> 'artifact_type' = 'draft'
        and (
          jsonb_typeof(artifact.value) is distinct from 'object'
          or not (artifact.value ?& v_draft_keys)
          or artifact.value - v_draft_keys <> '{}'::jsonb
        )
    ) then
      return query select 'invalid_artifacts'::text,
        v_task.status, v_task.current_step;
      return;
    end if;

    -- Preserve the historical current-DocumentVersion gate for Draft rows.
    perform 1
    from public.documents document
    join jsonb_array_elements(p_artifact_snapshot) artifacts(artifact)
      on artifact ->> 'artifact_type' = 'draft'
      and document.id::text = artifact ->> 'document_id'
    join public.document_versions version
      on version.id::text = artifact ->> 'version_id'
      and version.document_id = document.id
    order by document.id, version.id
    for update of document, version;
    select count(*) into v_valid_draft_count
    from jsonb_array_elements(p_artifact_snapshot) artifacts(artifact)
    join public.agent_artifact_links link
      on link.task_id = p_task_id
      and link.artifact_type = 'draft'
      and link.artifact_id = artifact ->> 'artifact_id'
      and link.purpose = artifact ->> 'purpose'
    join public.documents document
      on document.id::text = artifact ->> 'document_id'
    join public.document_versions version
      on version.id = document.current_version_id
      and version.id::text = artifact ->> 'version_id'
      and version.document_id = document.id
    where artifact ->> 'artifact_type' = 'draft'
      and jsonb_typeof(artifact) = 'object'
      and artifact ->> 'artifact_id' = artifact ->> 'document_id'
      and length(trim(coalesce(artifact ->> 'purpose', ''))) between 1 and 300
      and jsonb_typeof(artifact -> 'filename') = 'string'
      and length(trim(artifact ->> 'filename')) between 1 and 500
      and (
        artifact -> 'file_type' = 'null'::jsonb
        or jsonb_typeof(artifact -> 'file_type') = 'string'
      )
      and (
        artifact -> 'version_number' = 'null'::jsonb
        or (
          jsonb_typeof(artifact -> 'version_number') = 'number'
          and artifact ->> 'version_number' ~ '^-?(0|[1-9][0-9]*)$'
          and (artifact ->> 'version_number')::numeric
            between -2147483648 and 2147483647
        )
      )
      and jsonb_typeof(artifact -> 'size_bytes') = 'number'
      and artifact ->> 'size_bytes' ~ '^[0-9]+$'
      and (artifact ->> 'size_bytes')::numeric <= 2147483647
      and jsonb_typeof(artifact -> 'sha256') = 'string'
      and artifact ->> 'sha256' ~ '^sha256:[a-f0-9]{64}$'
      and document.project_id = v_task.matter_id
      and document.user_id = p_user_id
      and document.status = 'ready'
      and version.deleted_at is null
      and version.storage_path is not null
      and artifact ->> 'version_number'
        is not distinct from version.version_number::text
      and artifact ->> 'filename' is not distinct from version.filename
      and artifact ->> 'file_type' is not distinct from version.file_type
      and artifact ->> 'size_bytes' is not distinct from version.size_bytes::text
      and public.agent_draft_final_verifier_matches_v1(
        p_task_id,
        document.id,
        version.id
      );
    if v_valid_draft_count <> v_draft_count then
      return query select 'invalid_artifacts'::text,
        v_task.status, v_task.current_step;
      return;
    end if;

    -- Validate every current Tabular row and its deterministic export plan.
    for v_artifact in
      select artifact from jsonb_array_elements(p_artifact_snapshot)
        artifacts(artifact)
    loop
      if v_artifact ->> 'artifact_type' = 'draft' then
        continue;
      end if;
      if jsonb_typeof(v_artifact) is distinct from 'object'
        or v_artifact ->> 'kind'
          is distinct from 'agent_approved_tabular_artifact_v1'
        or v_artifact ->> 'artifact_type' is distinct from 'tabular_review'
        or not (v_artifact ?& v_tabular_keys)
        or v_artifact - v_tabular_keys <> '{}'::jsonb
        or coalesce(v_artifact ->> 'artifact_id', '')
          !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        or v_artifact ->> 'artifact_id'
          is distinct from v_artifact ->> 'review_id'
        or v_artifact ->> 'row_protocol' is distinct from 'document_rows'
        or length(trim(coalesce(v_artifact ->> 'purpose', '')))
          not between 1 and 300
        or coalesce(v_artifact ->> 'input_digest', '')
          !~ '^[a-f0-9]{64}$'
        or coalesce(v_artifact ->> 'revision_fingerprint', '')
          !~ '^[a-f0-9]{64}$'
        or coalesce(v_artifact ->> 'accepted_view_sha256', '')
          !~ '^sha256:[a-f0-9]{64}$'
        or coalesce(v_artifact ->> 'export_document_id', '')
          !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        or coalesce(v_artifact ->> 'export_version_id', '')
          !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        or jsonb_typeof(v_artifact -> 'version_number')
          is distinct from 'number'
        or coalesce(v_artifact ->> 'version_number', '')
          !~ '^[1-9][0-9]*$'
        or (v_artifact ->> 'version_number')::numeric > 2147483647
        or jsonb_typeof(v_artifact -> 'filename') is distinct from 'string'
        or length(trim(coalesce(v_artifact ->> 'filename', '')))
          not between 1 and 500
        or v_artifact ->> 'file_type' is distinct from 'xlsx'
        or jsonb_typeof(v_artifact -> 'size_bytes') is distinct from 'number'
        or coalesce(v_artifact ->> 'size_bytes', '') !~ '^[1-9][0-9]*$'
        or (v_artifact ->> 'size_bytes')::numeric > 104857600
        or coalesce(v_artifact ->> 'sha256', '')
          !~ '^sha256:[a-f0-9]{64}$' then
        return query select 'invalid_artifacts'::text,
          v_task.status, v_task.current_step;
        return;
      end if;

      v_verified_identity := jsonb_build_object(
        'kind', 'agent_verified_tabular_artifact_v1',
        'review_id', v_artifact -> 'review_id',
        'row_protocol', v_artifact -> 'row_protocol',
        'input_digest', v_artifact -> 'input_digest',
        'revision_fingerprint', v_artifact -> 'revision_fingerprint',
        'accepted_view_sha256', v_artifact -> 'accepted_view_sha256',
        'source_receipt_fingerprint',
          v_artifact -> 'source_receipt_fingerprint',
        'decision_fingerprint', v_artifact -> 'decision_fingerprint',
        'completion_sha256', v_artifact -> 'completion_sha256'
      );
      select * into v_plan
      from public.prepare_agent_tabular_export_materialization_v1(
        p_task_id,
        p_user_id,
        (v_artifact ->> 'review_id')::uuid,
        v_artifact ->> 'purpose',
        v_verified_identity,
        v_artifact ->> 'filename',
        (v_artifact ->> 'size_bytes')::integer,
        v_artifact ->> 'sha256'
      );
      if v_plan.outcome <> 'prepared' then
        return query select
          case when v_plan.outcome = 'conflict'
            then 'conflict' else 'invalid_artifacts' end,
          v_task.status,
          v_task.current_step;
        return;
      end if;
      if v_plan.verified_identity is distinct from v_verified_identity
        or v_plan.export_document_id::text
          is distinct from v_artifact ->> 'export_document_id'
        or v_plan.export_version_id::text
          is distinct from v_artifact ->> 'export_version_id'
        or v_plan.version_number::text
          is distinct from v_artifact ->> 'version_number'
        or v_plan.filename is distinct from v_artifact ->> 'filename'
        or v_plan.file_type is distinct from 'xlsx' then
        return query select 'conflict'::text,
          v_task.status, v_task.current_step;
        return;
      end if;
      perform 1
      from public.documents document
      where document.id = v_plan.export_document_id
      for update;
      perform 1
      from public.document_versions version
      where version.document_id = v_plan.export_document_id
      order by version.version_number, version.id
      for update;
    end loop;

    -- All rows are proven. Create/recover each deterministic export only now;
    -- a returned conflict must also roll back every earlier row in this batch.
    begin
      for v_artifact in
        select artifact from jsonb_array_elements(p_artifact_snapshot)
          artifacts(artifact)
        where artifact ->> 'kind' = 'agent_approved_tabular_artifact_v1'
      loop
      v_verified_identity := jsonb_build_object(
        'kind', 'agent_verified_tabular_artifact_v1',
        'review_id', v_artifact -> 'review_id',
        'row_protocol', v_artifact -> 'row_protocol',
        'input_digest', v_artifact -> 'input_digest',
        'revision_fingerprint', v_artifact -> 'revision_fingerprint',
        'accepted_view_sha256', v_artifact -> 'accepted_view_sha256',
        'source_receipt_fingerprint',
          v_artifact -> 'source_receipt_fingerprint',
        'decision_fingerprint', v_artifact -> 'decision_fingerprint',
        'completion_sha256', v_artifact -> 'completion_sha256'
      );
      select * into v_plan
      from public.prepare_agent_tabular_export_materialization_v1(
        p_task_id,
        p_user_id,
        (v_artifact ->> 'review_id')::uuid,
        v_artifact ->> 'purpose',
        v_verified_identity,
        v_artifact ->> 'filename',
        (v_artifact ->> 'size_bytes')::integer,
        v_artifact ->> 'sha256'
      );
        if v_plan.outcome <> 'prepared'
          or v_plan.version_number::text
            is distinct from v_artifact ->> 'version_number'
          or v_plan.export_document_id::text
            is distinct from v_artifact ->> 'export_document_id'
          or v_plan.export_version_id::text
            is distinct from v_artifact ->> 'export_version_id' then
          raise exception using
            errcode = 'VTA01',
            message = 'agent_tabular_export_plan_conflict';
        end if;
      v_export_document_id := v_plan.export_document_id;
      v_export_version_id := v_plan.export_version_id;

      insert into public.documents(
        id, project_id, user_id, status, library_kind
      ) values (
        v_export_document_id,
        v_task.matter_id,
        p_user_id,
        'pending',
        'file'
      ) on conflict (id) do nothing;

        if exists (
          select 1
          from public.documents document
          where document.id = v_export_document_id
            and (
              document.project_id is distinct from v_task.matter_id
              or document.user_id is distinct from p_user_id
              or document.library_kind is distinct from 'file'
            )
        ) then
          raise exception using
            errcode = 'VTA01',
            message = 'agent_tabular_export_document_conflict';
        end if;

      insert into public.document_versions(
        id,
        document_id,
        storage_path,
        source,
        version_number,
        filename,
        file_type,
        size_bytes
      ) values (
        v_export_version_id,
        v_export_document_id,
        v_plan.storage_path,
        'generated',
        v_plan.version_number,
        v_plan.filename,
        'xlsx',
        (v_artifact ->> 'size_bytes')::integer
      ) on conflict (id) do nothing;

        if not exists (
          select 1
          from public.document_versions version
          where version.id = v_export_version_id
            and version.document_id = v_export_document_id
            and version.storage_path = v_plan.storage_path
            and version.source = 'generated'
            and version.version_number = v_plan.version_number
            and version.filename = v_plan.filename
            and version.file_type = 'xlsx'
            and version.size_bytes = (v_artifact ->> 'size_bytes')::integer
            and version.deleted_at is null
        ) then
          raise exception using
            errcode = 'VTA01',
            message = 'agent_tabular_export_version_conflict';
        end if;

        update public.documents
        set
          status = 'ready',
          current_version_id = v_export_version_id,
          updated_at = clock_timestamp()
        where id = v_export_document_id;
      end loop;
    exception
      when sqlstate 'VTA01' or unique_violation then
        return query select 'conflict'::text,
          v_task.status, v_task.current_step;
        return;
    end;
  end if;

  insert into public.agent_task_review_decisions(
    id,
    task_id,
    status,
    reviewer_id,
    reviewer_email,
    reviewer_name,
    note,
    artifact_snapshot
  ) values (
    p_decision_id,
    p_task_id,
    p_status,
    p_user_id,
    p_reviewer_email,
    p_reviewer_name,
    p_note,
    p_artifact_snapshot
  );

  return query select 'recorded'::text, v_task.status, v_task.current_step;
end;
$$;

create or replace function public.agent_canonical_json_v1(p_value jsonb)
returns text
language plpgsql
immutable
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_kind text;
  v_result text;
begin
  if p_value is null then
    return null;
  end if;
  v_kind := jsonb_typeof(p_value);
  if v_kind = 'object' then
    select '{' || coalesce(string_agg(
      to_jsonb(item.key)::text || ':' ||
        public.agent_canonical_json_v1(item.value),
      ',' order by item.key collate "C"
    ), '') || '}'
    into v_result
    from jsonb_each(p_value) item;
    return v_result;
  end if;
  if v_kind = 'array' then
    select '[' || coalesce(string_agg(
      public.agent_canonical_json_v1(item.value),
      ',' order by item.ordinality
    ), '') || ']'
    into v_result
    from jsonb_array_elements(p_value) with ordinality item(value, ordinality);
    return v_result;
  end if;
  if v_kind = 'string' then
    return to_jsonb(p_value #>> '{}')::text;
  end if;
  return p_value::text;
end;
$$;

create or replace function public.agent_sha256_hex_v1(p_value jsonb)
returns text
language sql
immutable
set search_path = pg_catalog, public, extensions, pg_temp
as $$
  select encode(
    extensions.digest(
      convert_to(public.agent_canonical_json_v1(p_value), 'UTF8'),
      'sha256'
    ),
    'hex'
  );
$$;

create or replace function public.agent_deterministic_uuid_v1(p_scope text)
returns uuid
language plpgsql
immutable
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare
  v_hex text;
  v_nibble integer;
begin
  if p_scope is null or length(p_scope) = 0 then
    return null;
  end if;
  v_hex := substr(encode(
    extensions.digest(convert_to(p_scope, 'UTF8'), 'sha256'),
    'hex'
  ), 1, 32);
  v_hex := overlay(v_hex placing '4' from 13 for 1);
  v_nibble := position(substr(v_hex, 17, 1) in '0123456789abcdef') - 1;
  v_hex := overlay(v_hex placing substr('89ab', (v_nibble % 4) + 1, 1)
    from 17 for 1);
  return (
    substr(v_hex, 1, 8) || '-' ||
    substr(v_hex, 9, 4) || '-' ||
    substr(v_hex, 13, 4) || '-' ||
    substr(v_hex, 17, 4) || '-' ||
    substr(v_hex, 21, 12)
  )::uuid;
end;
$$;

-- Internal live-state compiler. It locks the Review and its fixed cells while
-- producing the opaque DB revision and independent completion provenance.
-- The server builds accepted_view_sha256 from the same rows between two
-- revision reads and persists it in the final verifier receipt.
create or replace function public.agent_tabular_live_revision_v1(
  p_task_id uuid,
  p_user_id text,
  p_review_id uuid,
  p_expected_input_digest text,
  p_include_provenance boolean
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare
  v_task public.agent_tasks%rowtype;
  v_review public.tabular_reviews%rowtype;
  v_effect jsonb;
  v_effect_count integer;
  v_document_count integer;
  v_column_count integer;
  v_expected_cell_count bigint;
  v_actual_cell_count bigint;
  v_owned_document_count integer;
  v_revision_cells jsonb;
  v_revision_value jsonb;
  v_revision_fingerprint text;
  v_inventory_receipt jsonb;
  v_completion jsonb;
  v_completion_decisions jsonb;
  v_source_receipt_fingerprint text;
  v_decision_fingerprint text;
  v_completion_sha256 text;
  v_verified_count integer;
  v_unresolved_count integer;
begin
  if p_task_id is null
    or p_user_id is null
    or length(trim(p_user_id)) = 0
    or p_user_id <> trim(p_user_id)
    or p_user_id !~ '^[A-Za-z0-9_@.+:=|-]{1,200}$'
    or position('..' in p_user_id) > 0
    or p_review_id is null
    or p_expected_input_digest is null
    or p_expected_input_digest !~ '^[a-f0-9]{64}$'
    or p_include_provenance is null then
    return jsonb_build_object('outcome', 'invalid_input');
  end if;

  select * into v_task
  from public.agent_tasks
  where id = p_task_id and user_id = p_user_id
  for share;
  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  select * into v_review
  from public.tabular_reviews
  where id = p_review_id
  for share;
  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  if v_review.project_id is distinct from v_task.matter_id
    or v_review.user_id is distinct from p_user_id
    or v_review.row_protocol is distinct from 'document_rows'
    or not exists (
      select 1
      from public.agent_artifact_links link
      where link.task_id = p_task_id
        and link.artifact_type = 'tabular_review'
        and link.artifact_id = p_review_id::text
    )
    or jsonb_typeof(v_review.document_ids) is distinct from 'array'
    or jsonb_array_length(v_review.document_ids) = 0
    or jsonb_array_length(v_review.document_ids) > 500
    or jsonb_typeof(v_review.columns_config) is distinct from 'array'
    or jsonb_array_length(v_review.columns_config) = 0
    or jsonb_array_length(v_review.columns_config) > 200
    or not public.agent_json_numbers_are_safe_integers_v1(
      v_review.columns_config
    ) then
    return jsonb_build_object('outcome', 'conflict');
  end if;

  if exists (
    select 1
    from jsonb_array_elements(v_review.document_ids) document(value)
    where jsonb_typeof(document.value) is distinct from 'string'
      or coalesce(document.value #>> '{}', '')
        !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ) or exists (
    select 1
    from jsonb_array_elements(v_review.document_ids) document(value)
    group by document.value
    having count(*) > 1
  ) or exists (
    select 1
    from jsonb_array_elements(v_review.columns_config) column_value(value)
    where jsonb_typeof(column_value.value) is distinct from 'object'
      or jsonb_typeof(column_value.value -> 'index') is distinct from 'number'
      or coalesce(column_value.value ->> 'index', '') !~ '^(0|[1-9][0-9]*)$'
      or (column_value.value ->> 'index')::numeric > 2147483647
  ) or exists (
    select 1
    from jsonb_array_elements(v_review.columns_config) column_value(value)
    group by column_value.value ->> 'index'
    having count(*) > 1
  ) then
    return jsonb_build_object('outcome', 'conflict');
  end if;

  v_document_count := jsonb_array_length(v_review.document_ids);
  v_column_count := jsonb_array_length(v_review.columns_config);
  v_expected_cell_count := v_document_count::bigint * v_column_count::bigint;
  if v_expected_cell_count > 500 then
    return jsonb_build_object('outcome', 'conflict');
  end if;

  select count(*) into v_owned_document_count
  from jsonb_array_elements_text(v_review.document_ids) document(id)
  join public.documents source_document
    on source_document.id = document.id::uuid
    and source_document.project_id = v_task.matter_id
    and source_document.user_id = p_user_id;
  if v_owned_document_count <> v_document_count then
    return jsonb_build_object('outcome', 'conflict');
  end if;
  perform 1
  from public.documents source_document
  join jsonb_array_elements_text(v_review.document_ids) document(id)
    on source_document.id = document.id::uuid
  order by source_document.id
  for share of source_document;
  perform 1
  from public.document_versions source_version
  join public.documents source_document
    on source_document.current_version_id = source_version.id
  join jsonb_array_elements_text(v_review.document_ids) document(id)
    on source_document.id = document.id::uuid
  order by source_version.id
  for share of source_version;

  perform 1
  from public.tabular_cells cell
  where cell.review_id = p_review_id
  order by cell.id
  for share;
  select count(*) into v_actual_cell_count
  from public.tabular_cells cell
  where cell.review_id = p_review_id;
  if v_actual_cell_count <> v_expected_cell_count
    or exists (
      select 1
      from public.tabular_cells cell
      where cell.review_id = p_review_id
        and (
          cell.document_id is null
          or cell.row_id is not null
          or cell.review_revision < 0
          or not public.agent_json_numbers_are_safe_integers_v1(
            coalesce(cell.citations, 'null'::jsonb)
          )
          or not exists (
            select 1
            from jsonb_array_elements_text(v_review.document_ids) document(id)
            where document.id::uuid = cell.document_id
          )
          or not exists (
            select 1
            from jsonb_array_elements(v_review.columns_config) column_value(value)
            where (column_value.value ->> 'index')::integer = cell.column_index
          )
        )
    )
    or exists (
      select 1
      from jsonb_array_elements_text(v_review.document_ids) document(id)
      cross join jsonb_array_elements(v_review.columns_config) column_value(value)
      where not exists (
        select 1
        from public.tabular_cells cell
        where cell.review_id = p_review_id
          and cell.document_id = document.id::uuid
          and cell.row_id is null
          and cell.column_index = (column_value.value ->> 'index')::integer
      )
    ) then
    return jsonb_build_object('outcome', 'conflict');
  end if;

  -- Bind the Review to the committed effect on the current attempt. Historical
  -- attempts may remain in result_data, but they cannot supply the input digest.
  perform 1
  from public.agent_steps step
  where step.task_id = p_task_id
  order by step.position
  for share;
  select count(*), (array_agg(candidate.receipt))[1]
  into v_effect_count, v_effect
  from (
    select receipt.value as receipt
    from public.agent_steps step
    cross join lateral jsonb_each(
      case
        when jsonb_typeof(step.result_data -> 'tabular_effect_receipts') = 'object'
          then step.result_data -> 'tabular_effect_receipts'
        else '{}'::jsonb
      end
    ) receipt(key, value)
    where step.task_id = p_task_id
      and step.status = 'completed'
      and jsonb_typeof(receipt.value) = 'object'
      and receipt.value ?& array[
        'kind', 'effect_key', 'step_id', 'attempt', 'operation',
        'input_fingerprint', 'status', 'target', 'effect',
        'created_at', 'committed_at'
      ]::text[]
      and receipt.value - array[
        'kind', 'effect_key', 'step_id', 'attempt', 'operation',
        'input_fingerprint', 'status', 'target', 'effect',
        'created_at', 'committed_at'
      ]::text[] = '{}'::jsonb
      and receipt.value ->> 'kind' = 'agent_step_tabular_effect_v1'
      and receipt.value ->> 'effect_key' = receipt.key
      and receipt.value ->> 'status' = 'committed'
      and receipt.value ->> 'operation' = 'create_tabular_review'
      and receipt.value ->> 'step_id' = step.id::text
      and coalesce(receipt.value ->> 'attempt', '') ~ '^(0|[1-9][0-9]*)$'
      and (receipt.value ->> 'attempt')::integer = step.attempt
      and receipt.value -> 'target' ->> 'review_id' = p_review_id::text
      and receipt.value -> 'effect' ->> 'review_id' = p_review_id::text
      and receipt.value -> 'effect' ->> 'artifact_type' = 'tabular_review'
      and receipt.value ->> 'input_fingerprint' = p_expected_input_digest
  ) candidate;
  if v_effect_count <> 1 then
    return jsonb_build_object('outcome', 'conflict');
  end if;

  select jsonb_agg(
      jsonb_build_object(
        'cell_id', cell.id,
        'document_id', cell.document_id,
        'row_id', cell.row_id,
        'column_index', cell.column_index,
        'status', cell.status,
        'content', cell.content,
        'citations', cell.citations,
        'review_status', cell.review_status,
        'review_revision', cell.review_revision
      ) order by document.ordinality, column_value.ordinality
    )
  into v_revision_cells
  from jsonb_array_elements_text(v_review.document_ids)
    with ordinality document(id, ordinality)
  cross join jsonb_array_elements(v_review.columns_config)
    with ordinality column_value(value, ordinality)
  join public.tabular_cells cell
    on cell.review_id = p_review_id
    and cell.document_id = document.id::uuid
    and cell.row_id is null
    and cell.column_index = (column_value.value ->> 'index')::integer;

  v_revision_value := jsonb_build_object(
    'kind', 'agent_tabular_review_revision_v1',
    'review', jsonb_build_object(
      'id', v_review.id,
      'project_id', v_review.project_id,
      'user_id', v_review.user_id,
      'title', v_review.title,
      'practice', v_review.practice,
      'workflow_id', v_review.workflow_id,
      'row_protocol', v_review.row_protocol,
      'document_ids', v_review.document_ids,
      'columns_config', v_review.columns_config
    ),
    'cells', v_revision_cells
  );
  v_revision_fingerprint := public.agent_sha256_hex_v1(v_revision_value);

  if not p_include_provenance then
    return jsonb_build_object(
      'outcome', 'current',
      'input_digest', p_expected_input_digest,
      'revision_fingerprint', v_revision_fingerprint
    );
  end if;

  v_inventory_receipt := v_task.latest_checkpoint ->
    'litigation_evidence_inventory_receipt';
  v_completion := v_task.latest_checkpoint ->
    'litigation_evidence_review_completion';
  if v_inventory_receipt is null and v_completion is null then
    v_source_receipt_fingerprint := null;
    v_decision_fingerprint := null;
    v_completion_sha256 := null;
  elsif jsonb_typeof(v_inventory_receipt) is distinct from 'object'
    or jsonb_typeof(v_completion) is distinct from 'object'
    or v_inventory_receipt ->> 'kind'
      is distinct from 'litigation_evidence_inventory_receipt_v1'
    or v_inventory_receipt ->> 'task_id' is distinct from p_task_id::text
    or v_inventory_receipt ->> 'matter_id'
      is distinct from v_task.matter_id::text
    or v_inventory_receipt ->> 'review_id' is distinct from p_review_id::text
    or v_inventory_receipt ->> 'step_id' is distinct from v_effect ->> 'step_id'
    or v_inventory_receipt ->> 'attempt' is distinct from v_effect ->> 'attempt'
    or jsonb_typeof(v_inventory_receipt -> 'source_pins')
      is distinct from 'array'
    or jsonb_typeof(v_inventory_receipt -> 'fields') is distinct from 'array'
    or jsonb_typeof(v_inventory_receipt -> 'cells') is distinct from 'array'
    or v_completion ->> 'kind'
      is distinct from 'litigation_evidence_review_completion_v1'
    or v_completion ->> 'task_id' is distinct from p_task_id::text
    or v_completion ->> 'review_id' is distinct from p_review_id::text
    or v_completion ->> 'step_id' is distinct from v_effect ->> 'step_id'
    or coalesce(v_completion ->> 'source_receipt_fingerprint', '')
      !~ '^[a-f0-9]{64}$'
    or coalesce(v_completion ->> 'decision_fingerprint', '')
      !~ '^[a-f0-9]{64}$' then
    return jsonb_build_object('outcome', 'conflict');
  else
    v_source_receipt_fingerprint :=
      public.agent_sha256_hex_v1(v_inventory_receipt);
    if v_completion ->> 'source_receipt_fingerprint'
      is distinct from v_source_receipt_fingerprint then
      return jsonb_build_object('outcome', 'conflict');
    end if;

    if jsonb_array_length(v_inventory_receipt -> 'cells')
        <> v_actual_cell_count
      or jsonb_array_length(v_inventory_receipt -> 'source_pins')
        <> v_document_count
      or jsonb_array_length(v_inventory_receipt -> 'fields')
        <> v_column_count
      or exists (
        select 1
        from jsonb_array_elements(v_inventory_receipt -> 'cells') expected
        group by expected ->> 'cell_id'
        having count(*) > 1
      )
      or exists (
        select 1
        from jsonb_array_elements(v_inventory_receipt -> 'source_pins') pin
        group by pin ->> 'document_id'
        having count(*) > 1
      )
      or exists (
        select 1
        from jsonb_array_elements(v_inventory_receipt -> 'fields') field
        group by field ->> 'index'
        having count(*) > 1
      )
      or exists (
        select 1
        from jsonb_array_elements(v_inventory_receipt -> 'fields') field
        group by field ->> 'id'
        having count(*) > 1
      )
      or exists (
        select 1
        from jsonb_array_elements(v_inventory_receipt -> 'fields') field
        where jsonb_typeof(field) is distinct from 'object'
          or not (field ?& array[
            'index', 'id', 'title', 'semantic_axis'
          ]::text[])
          or field - array[
            'index', 'id', 'title', 'semantic_axis'
          ]::text[] <> '{}'::jsonb
          or jsonb_typeof(field -> 'index') is distinct from 'number'
          or coalesce(field ->> 'index', '') !~ '^(0|[1-9][0-9]*)$'
          or jsonb_typeof(field -> 'id') is distinct from 'string'
          or jsonb_typeof(field -> 'title') is distinct from 'string'
          or jsonb_typeof(field -> 'semantic_axis') is distinct from 'string'
          or 1 <> (
            select count(*)
            from jsonb_array_elements(v_review.columns_config) column_value(value)
            where column_value.value ->> 'index' = field ->> 'index'
              and column_value.value ->> 'name' = field ->> 'title'
              and column_value.value ->> 'format' = 'text'
              and column_value.value ->> 'prompt' = field ->> 'semantic_axis'
              and column_value.value -> 'tags'
                = jsonb_build_array(field ->> 'id')
          )
      )
      or exists (
        select 1
        from jsonb_array_elements(v_review.columns_config) column_value(value)
        where 1 <> (
          select count(*)
          from jsonb_array_elements(v_inventory_receipt -> 'fields') field
          where field ->> 'index' = column_value.value ->> 'index'
            and field ->> 'title' = column_value.value ->> 'name'
            and field ->> 'semantic_axis' = column_value.value ->> 'prompt'
            and column_value.value -> 'tags'
              = jsonb_build_array(field ->> 'id')
        )
      )
      or exists (
        select 1
        from jsonb_array_elements(v_inventory_receipt -> 'cells') expected
        where jsonb_typeof(expected) is distinct from 'object'
          or not (expected ?& array[
            'cell_id', 'document_id', 'version_id', 'field', 'field_index'
          ]::text[])
          or expected - array[
            'cell_id', 'document_id', 'version_id', 'field', 'field_index'
          ]::text[] <> '{}'::jsonb
          or not exists (
            select 1
            from public.tabular_cells cell
            where cell.review_id = p_review_id
              and cell.id::text = expected ->> 'cell_id'
              and cell.document_id::text = expected ->> 'document_id'
              and cell.column_index::text = expected ->> 'field_index'
          )
          or not exists (
            select 1
            from jsonb_array_elements(v_inventory_receipt -> 'source_pins') pin
            where pin ->> 'document_id' = expected ->> 'document_id'
              and pin ->> 'version_id' = expected ->> 'version_id'
          )
          or not exists (
            select 1
            from jsonb_array_elements(v_inventory_receipt -> 'fields') field
            where field ->> 'id' = expected ->> 'field'
              and field ->> 'index' = expected ->> 'field_index'
          )
      )
      or exists (
        select 1
        from public.tabular_cells cell
        where cell.review_id = p_review_id
          and 1 <> (
            select count(*)
            from jsonb_array_elements(v_inventory_receipt -> 'cells') expected
            where expected ->> 'cell_id' = cell.id::text
              and expected ->> 'document_id' = cell.document_id::text
              and expected ->> 'field_index' = cell.column_index::text
          )
      )
      or exists (
        select 1
        from jsonb_array_elements_text(v_review.document_ids) document(id)
        where 1 <> (
          select count(*)
          from jsonb_array_elements(v_inventory_receipt -> 'source_pins') pin
          where pin ->> 'document_id' = document.id
        )
      )
      or exists (
        select 1
        from jsonb_array_elements(v_inventory_receipt -> 'source_pins') pin
        where jsonb_typeof(pin) is distinct from 'object'
          or not (pin ?& array['document_id', 'version_id']::text[])
          or pin - array['document_id', 'version_id']::text[] <> '{}'::jsonb
          or coalesce(pin ->> 'document_id', '')
            !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          or coalesce(pin ->> 'version_id', '')
            !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          or not exists (
            select 1
            from public.documents source_document
            join public.document_versions source_version
              on source_version.id = (pin ->> 'version_id')::uuid
              and source_version.document_id = source_document.id
            where source_document.id = (pin ->> 'document_id')::uuid
              and source_document.project_id = v_task.matter_id
              and source_document.user_id = p_user_id
              and source_document.status = 'ready'
              and source_document.current_version_id = source_version.id
              and source_version.deleted_at is null
              and source_version.storage_path is not null
          )
          or not exists (
            select 1
            from jsonb_array_elements_text(v_review.document_ids) document(id)
            where document.id = pin ->> 'document_id'
          )
      ) then
      return jsonb_build_object('outcome', 'conflict');
    end if;

    select jsonb_agg(
      jsonb_build_object(
        'cell_id', cell.id,
        'status', cell.status,
        'review_status', cell.review_status,
        'reviewed_at', cell.reviewed_at,
        'review_revision', cell.review_revision,
        'content', cell.content,
        'citations', cell.citations
      ) order by expected.ordinality
    )
    into v_completion_decisions
    from jsonb_array_elements(v_inventory_receipt -> 'cells')
      with ordinality expected(value, ordinality)
    join public.tabular_cells cell
      on cell.review_id = p_review_id
      and cell.id::text = expected.value ->> 'cell_id';
    v_decision_fingerprint :=
      public.agent_sha256_hex_v1(v_completion_decisions);
    if v_completion ->> 'decision_fingerprint'
      is distinct from v_decision_fingerprint then
      return jsonb_build_object('outcome', 'conflict');
    end if;

    select
      count(*) filter (where review_status = 'verified'),
      count(*) filter (where review_status = 'unresolved')
    into v_verified_count, v_unresolved_count
    from public.tabular_cells
    where review_id = p_review_id;
    if v_verified_count + v_unresolved_count <> v_actual_cell_count
      or v_completion ->> 'verified_cells'
        is distinct from v_verified_count::text
      or v_completion ->> 'unresolved_cells'
        is distinct from v_unresolved_count::text then
      return jsonb_build_object('outcome', 'conflict');
    end if;
    v_completion_sha256 := 'sha256:' ||
      public.agent_sha256_hex_v1(v_completion);
  end if;

  return jsonb_build_object(
    'outcome', 'current',
    'input_digest', p_expected_input_digest,
    'revision_fingerprint', v_revision_fingerprint,
    'source_receipt_fingerprint', v_source_receipt_fingerprint,
    'decision_fingerprint', v_decision_fingerprint,
    'completion_sha256', v_completion_sha256
  );
end;
$$;

create or replace function public.agent_tabular_final_verifier_matches_v1(
  p_task_id uuid,
  p_review_id uuid,
  p_verified_identity jsonb
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_task public.agent_tasks%rowtype;
  v_final_step public.agent_steps%rowtype;
  v_receipt jsonb;
  v_receipt_count integer;
  v_identity_count integer;
  v_inventory_receipt jsonb;
begin
  if p_task_id is null
    or p_review_id is null
    or jsonb_typeof(p_verified_identity) is distinct from 'object' then
    return false;
  end if;
  select * into v_task
  from public.agent_tasks
  where id = p_task_id
  for share;
  if not found
    or jsonb_typeof(v_task.latest_checkpoint -> 'step_receipts')
      is distinct from 'array' then
    return false;
  end if;
  select * into v_final_step
  from public.agent_steps
  where task_id = p_task_id
  order by position desc
  limit 1
  for share;
  if not found or v_final_step.status <> 'completed' then
    return false;
  end if;

  select count(*), (array_agg(receipt.value))[1]
  into v_receipt_count, v_receipt
  from jsonb_array_elements(v_task.latest_checkpoint -> 'step_receipts')
    receipt(value)
  where jsonb_typeof(receipt.value) = 'object'
    and receipt.value ->> 'kind' = 'agent_step_receipt_v1'
    and receipt.value ->> 'contract_version' = 'agent_step_contract_v1'
    and receipt.value ->> 'position' = v_final_step.position::text
    and receipt.value ->> 'attempt' = v_final_step.attempt::text
    and receipt.value ->> 'capability' = 'verify'
    and receipt.value ->> 'operation' = 'verify';
  if v_receipt_count <> 1
    or v_receipt ->> 'outcome' <> 'postconditions_satisfied'
    or jsonb_typeof(v_receipt -> 'artifact_ids') is distinct from 'array'
    or jsonb_typeof(v_receipt -> 'source_version_ids') is distinct from 'array'
    or jsonb_typeof(v_receipt -> 'postconditions') is distinct from 'array'
    or jsonb_typeof(v_receipt -> 'verified_artifacts') is distinct from 'array'
    or not (v_receipt -> 'artifact_ids' @> jsonb_build_array(p_review_id::text))
    or not exists (
      select 1
      from jsonb_array_elements(v_receipt -> 'postconditions') item(value)
      where item.value ->> 'code' = 'verifier_passed'
        and item.value ->> 'status' = 'pass'
    )
    or exists (
      select 1
      from jsonb_array_elements(v_receipt -> 'postconditions') item(value)
      where jsonb_typeof(item.value) is distinct from 'object'
        or item.value ->> 'status' is distinct from 'pass'
    ) then
    return false;
  end if;

  select count(*) into v_identity_count
  from jsonb_array_elements(v_receipt -> 'verified_artifacts') item(value)
  where item.value = p_verified_identity;
  if v_identity_count <> 1
    or exists (
      select 1
      from jsonb_array_elements(v_receipt -> 'verified_artifacts') item(value)
      where item.value ->> 'kind' = 'agent_verified_tabular_artifact_v1'
        and item.value ->> 'review_id' = p_review_id::text
        and item.value <> p_verified_identity
    ) then
    return false;
  end if;

  v_inventory_receipt := v_task.latest_checkpoint ->
    'litigation_evidence_inventory_receipt';
  if jsonb_typeof(v_inventory_receipt) = 'object'
    and exists (
      select 1
      from jsonb_array_elements(v_inventory_receipt -> 'source_pins') pin
      where not (
        v_receipt -> 'source_version_ids' @>
          jsonb_build_array(pin ->> 'version_id')
      )
    ) then
    return false;
  end if;
  return true;
end;
$$;

create or replace function public.agent_draft_final_verifier_matches_v1(
  p_task_id uuid,
  p_document_id uuid,
  p_version_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_task public.agent_tasks%rowtype;
  v_final_step public.agent_steps%rowtype;
  v_receipt jsonb;
  v_receipt_count integer;
  v_identity_count integer;
  v_identity_keys text[] := array[
    'kind', 'document_id', 'version_id', 'accepted_view_sha256'
  ];
begin
  if p_task_id is null or p_document_id is null or p_version_id is null then
    return false;
  end if;
  select * into v_task
  from public.agent_tasks
  where id = p_task_id
  for share;
  if not found
    or jsonb_typeof(v_task.latest_checkpoint -> 'step_receipts')
      is distinct from 'array' then
    return false;
  end if;
  select * into v_final_step
  from public.agent_steps
  where task_id = p_task_id
  order by position desc
  limit 1
  for share;
  if not found or v_final_step.status <> 'completed' then
    return false;
  end if;
  select count(*), (array_agg(receipt.value))[1]
  into v_receipt_count, v_receipt
  from jsonb_array_elements(v_task.latest_checkpoint -> 'step_receipts')
    receipt(value)
  where jsonb_typeof(receipt.value) = 'object'
    and receipt.value ->> 'kind' = 'agent_step_receipt_v1'
    and receipt.value ->> 'contract_version' = 'agent_step_contract_v1'
    and receipt.value ->> 'position' = v_final_step.position::text
    and receipt.value ->> 'attempt' = v_final_step.attempt::text
    and receipt.value ->> 'capability' = 'verify'
    and receipt.value ->> 'operation' = 'verify';
  if v_receipt_count <> 1
    or v_receipt ->> 'outcome' <> 'postconditions_satisfied'
    or jsonb_typeof(v_receipt -> 'artifact_ids') is distinct from 'array'
    or jsonb_typeof(v_receipt -> 'postconditions') is distinct from 'array'
    or jsonb_typeof(v_receipt -> 'verified_artifacts') is distinct from 'array'
    or not (
      v_receipt -> 'artifact_ids' @> jsonb_build_array(p_document_id::text)
    )
    or not exists (
      select 1
      from jsonb_array_elements(v_receipt -> 'postconditions') item(value)
      where item.value ->> 'code' = 'verifier_passed'
        and item.value ->> 'status' = 'pass'
    )
    or exists (
      select 1
      from jsonb_array_elements(v_receipt -> 'postconditions') item(value)
      where jsonb_typeof(item.value) is distinct from 'object'
        or item.value ->> 'status' is distinct from 'pass'
    ) then
    return false;
  end if;
  select count(*) into v_identity_count
  from jsonb_array_elements(v_receipt -> 'verified_artifacts') item(value)
  where jsonb_typeof(item.value) = 'object'
    and item.value ?& v_identity_keys
    and item.value - v_identity_keys = '{}'::jsonb
    and item.value ->> 'kind' = 'agent_verified_draft_artifact_v1'
    and item.value ->> 'document_id' = p_document_id::text
    and item.value ->> 'version_id' = p_version_id::text
    and item.value ->> 'accepted_view_sha256'
      ~ '^sha256:[a-f0-9]{64}$';
  return v_identity_count = 1;
end;
$$;

create or replace function public.agent_final_verifier_snapshot_matches_v1(
  p_task_id uuid,
  p_artifact_snapshot jsonb
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_task public.agent_tasks%rowtype;
  v_final_step public.agent_steps%rowtype;
  v_receipt jsonb;
  v_receipt_count integer;
  v_snapshot_count integer;
  v_identity_count integer;
  v_draft_identity_keys text[] := array[
    'kind', 'document_id', 'version_id', 'accepted_view_sha256'
  ];
  v_tabular_identity_keys text[] := array[
    'kind', 'review_id', 'row_protocol', 'input_digest',
    'revision_fingerprint', 'accepted_view_sha256',
    'source_receipt_fingerprint', 'decision_fingerprint', 'completion_sha256'
  ];
begin
  if p_task_id is null
    or jsonb_typeof(p_artifact_snapshot) is distinct from 'array' then
    return false;
  end if;
  select * into v_task
  from public.agent_tasks
  where id = p_task_id
  for share;
  if not found
    or jsonb_typeof(v_task.latest_checkpoint -> 'step_receipts')
      is distinct from 'array' then
    return false;
  end if;
  select * into v_final_step
  from public.agent_steps
  where task_id = p_task_id
  order by position desc
  limit 1
  for share;
  if not found or v_final_step.status <> 'completed' then
    return false;
  end if;
  select count(*), (array_agg(receipt.value))[1]
  into v_receipt_count, v_receipt
  from jsonb_array_elements(v_task.latest_checkpoint -> 'step_receipts')
    receipt(value)
  where jsonb_typeof(receipt.value) = 'object'
    and receipt.value ->> 'kind' = 'agent_step_receipt_v1'
    and receipt.value ->> 'contract_version' = 'agent_step_contract_v1'
    and receipt.value ->> 'position' = v_final_step.position::text
    and receipt.value ->> 'attempt' = v_final_step.attempt::text
    and receipt.value ->> 'capability' = 'verify'
    and receipt.value ->> 'operation' = 'verify';
  if v_receipt_count <> 1
    or v_receipt ->> 'outcome' <> 'postconditions_satisfied'
    or jsonb_typeof(v_receipt -> 'artifact_ids') is distinct from 'array'
    or jsonb_typeof(v_receipt -> 'verified_artifacts') is distinct from 'array'
    or jsonb_typeof(v_receipt -> 'postconditions') is distinct from 'array'
    or not exists (
      select 1
      from jsonb_array_elements(v_receipt -> 'postconditions') item(value)
      where item.value ->> 'code' = 'verifier_passed'
        and item.value ->> 'status' = 'pass'
    )
    or exists (
      select 1
      from jsonb_array_elements(v_receipt -> 'postconditions') item(value)
      where jsonb_typeof(item.value) is distinct from 'object'
        or item.value ->> 'status' is distinct from 'pass'
    ) then
    return false;
  end if;
  v_snapshot_count := jsonb_array_length(p_artifact_snapshot);
  v_identity_count := jsonb_array_length(v_receipt -> 'verified_artifacts');
  if v_identity_count <> v_snapshot_count
    or jsonb_array_length(v_receipt -> 'artifact_ids') <> v_snapshot_count
    or exists (
      select 1
      from jsonb_array_elements(v_receipt -> 'artifact_ids') artifact_id(value)
      where jsonb_typeof(artifact_id.value) is distinct from 'string'
        or coalesce(artifact_id.value #>> '{}', '')
          !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    )
    or exists (
      select 1
      from jsonb_array_elements_text(v_receipt -> 'artifact_ids') artifact_id(id)
      group by artifact_id.id
      having count(*) > 1
    )
    or exists (
      select 1
      from jsonb_array_elements(v_receipt -> 'verified_artifacts') identity(value)
      group by
        identity.value ->> 'kind',
        coalesce(
          identity.value ->> 'document_id',
          identity.value ->> 'review_id'
        )
      having count(*) > 1
    )
    or exists (
      select 1
      from jsonb_array_elements(v_receipt -> 'verified_artifacts') identity(value)
      where jsonb_typeof(identity.value) is distinct from 'object'
        or not (
          (
            identity.value ->> 'kind' = 'agent_verified_draft_artifact_v1'
            and identity.value ?& v_draft_identity_keys
            and identity.value - v_draft_identity_keys = '{}'::jsonb
            and identity.value ->> 'document_id'
              ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            and identity.value ->> 'version_id'
              ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            and identity.value ->> 'accepted_view_sha256'
              ~ '^sha256:[a-f0-9]{64}$'
          ) or (
            identity.value ->> 'kind' = 'agent_verified_tabular_artifact_v1'
            and identity.value ?& v_tabular_identity_keys
            and identity.value - v_tabular_identity_keys = '{}'::jsonb
            and identity.value ->> 'review_id'
              ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            and identity.value ->> 'row_protocol' = 'document_rows'
            and identity.value ->> 'input_digest' ~ '^[a-f0-9]{64}$'
            and identity.value ->> 'revision_fingerprint' ~ '^[a-f0-9]{64}$'
            and identity.value ->> 'accepted_view_sha256'
              ~ '^sha256:[a-f0-9]{64}$'
            and (
              identity.value -> 'source_receipt_fingerprint' = 'null'::jsonb
              or (
                jsonb_typeof(
                  identity.value -> 'source_receipt_fingerprint'
                ) = 'string'
                and identity.value ->> 'source_receipt_fingerprint'
                  ~ '^[a-f0-9]{64}$'
              )
            )
            and (
              identity.value -> 'decision_fingerprint' = 'null'::jsonb
              or (
                jsonb_typeof(identity.value -> 'decision_fingerprint')
                  = 'string'
                and identity.value ->> 'decision_fingerprint'
                  ~ '^[a-f0-9]{64}$'
              )
            )
            and (
              identity.value -> 'completion_sha256' = 'null'::jsonb
              or (
                jsonb_typeof(identity.value -> 'completion_sha256') = 'string'
                and identity.value ->> 'completion_sha256'
                  ~ '^sha256:[a-f0-9]{64}$'
              )
            )
          )
        )
    )
    or exists (
      select 1
      from jsonb_array_elements(p_artifact_snapshot) artifact(value)
      where 1 <> (
        select count(*)
        from jsonb_array_elements(v_receipt -> 'verified_artifacts') identity(value)
        where (
          artifact.value ->> 'artifact_type' = 'draft'
          and identity.value ->> 'kind' = 'agent_verified_draft_artifact_v1'
          and identity.value ->> 'document_id' = artifact.value ->> 'document_id'
          and identity.value ->> 'version_id' = artifact.value ->> 'version_id'
        ) or (
          artifact.value ->> 'kind' = 'agent_approved_tabular_artifact_v1'
          and identity.value = jsonb_build_object(
            'kind', 'agent_verified_tabular_artifact_v1',
            'review_id', artifact.value -> 'review_id',
            'row_protocol', artifact.value -> 'row_protocol',
            'input_digest', artifact.value -> 'input_digest',
            'revision_fingerprint', artifact.value -> 'revision_fingerprint',
            'accepted_view_sha256', artifact.value -> 'accepted_view_sha256',
            'source_receipt_fingerprint',
              artifact.value -> 'source_receipt_fingerprint',
            'decision_fingerprint', artifact.value -> 'decision_fingerprint',
            'completion_sha256', artifact.value -> 'completion_sha256'
          )
        )
      )
    )
    or exists (
      select 1
      from jsonb_array_elements(v_receipt -> 'verified_artifacts') identity(value)
      where 1 <> (
        select count(*)
        from jsonb_array_elements(p_artifact_snapshot) artifact(value)
        where (
          identity.value ->> 'kind' = 'agent_verified_draft_artifact_v1'
          and artifact.value ->> 'artifact_type' = 'draft'
          and artifact.value ->> 'document_id' = identity.value ->> 'document_id'
          and artifact.value ->> 'version_id' = identity.value ->> 'version_id'
        ) or (
          identity.value ->> 'kind' = 'agent_verified_tabular_artifact_v1'
          and artifact.value ->> 'kind' = 'agent_approved_tabular_artifact_v1'
          and identity.value = jsonb_build_object(
            'kind', 'agent_verified_tabular_artifact_v1',
            'review_id', artifact.value -> 'review_id',
            'row_protocol', artifact.value -> 'row_protocol',
            'input_digest', artifact.value -> 'input_digest',
            'revision_fingerprint', artifact.value -> 'revision_fingerprint',
            'accepted_view_sha256', artifact.value -> 'accepted_view_sha256',
            'source_receipt_fingerprint',
              artifact.value -> 'source_receipt_fingerprint',
            'decision_fingerprint', artifact.value -> 'decision_fingerprint',
            'completion_sha256', artifact.value -> 'completion_sha256'
          )
        )
      )
    )
    or exists (
      select 1
      from jsonb_array_elements(p_artifact_snapshot) artifact(value)
      where not (
        v_receipt -> 'artifact_ids' @>
          jsonb_build_array(artifact.value ->> 'artifact_id')
      )
    ) then
    return false;
  end if;
  return true;
end;
$$;

create or replace function public.prepare_agent_tabular_export_materialization_v1(
  p_task_id uuid,
  p_user_id text,
  p_review_id uuid,
  p_purpose text,
  p_verified_identity jsonb,
  p_filename text,
  p_size_bytes integer,
  p_sha256 text
)
returns table(
  outcome text,
  verified_identity jsonb,
  export_document_id uuid,
  export_version_id uuid,
  version_number integer,
  storage_path text,
  filename text,
  file_type text
)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_task public.agent_tasks%rowtype;
  v_live jsonb;
  v_document public.documents%rowtype;
  v_version public.document_versions%rowtype;
  v_export_document_id uuid;
  v_export_version_id uuid;
  v_version_number integer;
  v_storage_path text;
  v_expected_keys text[] := array[
    'kind', 'review_id', 'row_protocol', 'input_digest',
    'revision_fingerprint', 'accepted_view_sha256',
    'source_receipt_fingerprint', 'decision_fingerprint', 'completion_sha256'
  ];
begin
  if p_task_id is null
    or p_user_id is null
    or length(trim(p_user_id)) = 0
    or p_user_id <> trim(p_user_id)
    or p_user_id !~ '^[A-Za-z0-9_@.+:=|-]{1,200}$'
    or position('..' in p_user_id) > 0
    or p_review_id is null
    or p_purpose is null
    or length(trim(p_purpose)) not between 1 and 300
    or p_filename is null
    or length(trim(p_filename)) not between 1 and 500
    or p_filename <> trim(p_filename)
    or p_filename ~ '[\\/]'
    or p_filename ~ '[[:cntrl:]]'
    or lower(right(p_filename, 5)) <> '.xlsx'
    or p_size_bytes is null
    or p_size_bytes < 1
    or p_size_bytes > 104857600
    or p_sha256 is null
    or p_sha256 !~ '^sha256:[a-f0-9]{64}$'
    or jsonb_typeof(p_verified_identity) is distinct from 'object'
    or not (p_verified_identity ?& v_expected_keys)
    or p_verified_identity - v_expected_keys <> '{}'::jsonb
    or jsonb_typeof(p_verified_identity -> 'kind') is distinct from 'string'
    or jsonb_typeof(p_verified_identity -> 'review_id') is distinct from 'string'
    or jsonb_typeof(p_verified_identity -> 'row_protocol') is distinct from 'string'
    or jsonb_typeof(p_verified_identity -> 'input_digest') is distinct from 'string'
    or jsonb_typeof(p_verified_identity -> 'revision_fingerprint')
      is distinct from 'string'
    or jsonb_typeof(p_verified_identity -> 'accepted_view_sha256')
      is distinct from 'string'
    or p_verified_identity ->> 'kind'
      is distinct from 'agent_verified_tabular_artifact_v1'
    or p_verified_identity ->> 'review_id' is distinct from p_review_id::text
    or p_verified_identity ->> 'row_protocol' is distinct from 'document_rows'
    or coalesce(p_verified_identity ->> 'input_digest', '')
      !~ '^[a-f0-9]{64}$'
    or coalesce(p_verified_identity ->> 'revision_fingerprint', '')
      !~ '^[a-f0-9]{64}$'
    or coalesce(p_verified_identity ->> 'accepted_view_sha256', '')
      !~ '^sha256:[a-f0-9]{64}$'
    or (
      p_verified_identity -> 'source_receipt_fingerprint' <> 'null'::jsonb
      and (
        jsonb_typeof(p_verified_identity -> 'source_receipt_fingerprint')
          is distinct from 'string'
        or coalesce(p_verified_identity ->> 'source_receipt_fingerprint', '')
          !~ '^[a-f0-9]{64}$'
      )
    )
    or (
      p_verified_identity -> 'decision_fingerprint' <> 'null'::jsonb
      and (
        jsonb_typeof(p_verified_identity -> 'decision_fingerprint')
          is distinct from 'string'
        or coalesce(p_verified_identity ->> 'decision_fingerprint', '')
          !~ '^[a-f0-9]{64}$'
      )
    )
    or (
      p_verified_identity -> 'completion_sha256' <> 'null'::jsonb
      and (
        jsonb_typeof(p_verified_identity -> 'completion_sha256')
          is distinct from 'string'
        or coalesce(p_verified_identity ->> 'completion_sha256', '')
          !~ '^sha256:[a-f0-9]{64}$'
      )
    ) then
    return query select 'invalid_input'::text, null::jsonb, null::uuid,
      null::uuid, null::integer, null::text, null::text, null::text;
    return;
  end if;

  select * into v_task
  from public.agent_tasks
  where id = p_task_id and user_id = p_user_id
  for share;
  if not found then
    return query select 'not_found'::text, null::jsonb, null::uuid,
      null::uuid, null::integer, null::text, null::text, null::text;
    return;
  end if;
  if v_task.status <> 'completed'
    or (
      v_task.execution_lease_owner is not null
      and v_task.execution_lease_expires_at > clock_timestamp()
    ) then
    return query select 'conflict'::text, null::jsonb, null::uuid,
      null::uuid, null::integer, null::text, null::text, null::text;
    return;
  end if;
  if not exists (
    select 1
    from public.agent_artifact_links link
    where link.task_id = p_task_id
      and link.artifact_type = 'tabular_review'
      and link.artifact_id = p_review_id::text
      and link.purpose = p_purpose
  ) then
    return query select 'invalid_artifacts'::text, null::jsonb, null::uuid,
      null::uuid, null::integer, null::text, null::text, null::text;
    return;
  end if;

  v_live := public.agent_tabular_live_revision_v1(
    p_task_id,
    p_user_id,
    p_review_id,
    p_verified_identity ->> 'input_digest',
    true
  );
  if v_live ->> 'outcome' <> 'current'
    or v_live ->> 'input_digest'
      is distinct from p_verified_identity ->> 'input_digest'
    or v_live ->> 'revision_fingerprint'
      is distinct from p_verified_identity ->> 'revision_fingerprint'
    or v_live -> 'source_receipt_fingerprint'
      is distinct from p_verified_identity -> 'source_receipt_fingerprint'
    or v_live -> 'decision_fingerprint'
      is distinct from p_verified_identity -> 'decision_fingerprint'
    or v_live -> 'completion_sha256'
      is distinct from p_verified_identity -> 'completion_sha256'
    or not public.agent_tabular_final_verifier_matches_v1(
      p_task_id,
      p_review_id,
      p_verified_identity
    ) then
    return query select 'conflict'::text, null::jsonb, null::uuid,
      null::uuid, null::integer, null::text, null::text, null::text;
    return;
  end if;

  v_export_document_id := public.agent_deterministic_uuid_v1(
    'agent-approved-tabular-export-document-v1|' ||
    octet_length(p_task_id::text)::text || ':' || p_task_id::text || '|' ||
    octet_length(p_review_id::text)::text || ':' || p_review_id::text || '|' ||
    octet_length(p_purpose)::text || ':' || p_purpose
  );
  v_export_version_id := public.agent_deterministic_uuid_v1(
    'agent-approved-tabular-export-version-v1|' ||
    octet_length(v_export_document_id::text)::text || ':' ||
      v_export_document_id::text || '|' ||
    octet_length(p_verified_identity ->> 'revision_fingerprint')::text || ':' ||
      (p_verified_identity ->> 'revision_fingerprint') || '|' ||
    octet_length(p_verified_identity ->> 'accepted_view_sha256')::text || ':' ||
      (p_verified_identity ->> 'accepted_view_sha256') || '|' ||
    octet_length(p_sha256)::text || ':' || p_sha256
  );
  v_storage_path := 'documents/' || p_user_id || '/' ||
    v_export_document_id::text || '/versions/' ||
    v_export_version_id::text || '.xlsx';

  select * into v_document
  from public.documents
  where id = v_export_document_id
  for share;
  if found and (
    v_document.project_id is distinct from v_task.matter_id
    or v_document.user_id is distinct from p_user_id
    or v_document.library_kind is distinct from 'file'
  ) then
    return query select 'conflict'::text, null::jsonb, null::uuid,
      null::uuid, null::integer, null::text, null::text, null::text;
    return;
  end if;

  select * into v_version
  from public.document_versions
  where id = v_export_version_id
  for share;
  if found then
    if v_version.document_id is distinct from v_export_document_id
      or v_version.storage_path is distinct from v_storage_path
      or v_version.filename is distinct from p_filename
      or v_version.file_type is distinct from 'xlsx'
      or v_version.size_bytes is distinct from p_size_bytes
      or v_version.source is distinct from 'generated'
      or v_version.deleted_at is not null
      or v_version.version_number is null
      or v_version.version_number < 1 then
      return query select 'conflict'::text, null::jsonb, null::uuid,
        null::uuid, null::integer, null::text, null::text, null::text;
      return;
    end if;
    v_version_number := v_version.version_number;
  else
    select coalesce(max(existing.version_number), 0) + 1
    into v_version_number
    from public.document_versions existing
    where existing.document_id = v_export_document_id;
  end if;
  if v_version_number < 1 or v_version_number = 2147483647 then
    return query select 'conflict'::text, null::jsonb, null::uuid,
      null::uuid, null::integer, null::text, null::text, null::text;
    return;
  end if;

  return query select
    'prepared'::text,
    p_verified_identity,
    v_export_document_id,
    v_export_version_id,
    v_version_number,
    v_storage_path,
    p_filename,
    'xlsx'::text;
end;
$$;

create or replace function public.read_agent_tabular_review_revision_fingerprint_v1(
  p_task_id uuid,
  p_user_id text,
  p_review_id uuid,
  p_expected_input_digest text
)
returns table(outcome text, revision_fingerprint text)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_live jsonb;
begin
  v_live := public.agent_tabular_live_revision_v1(
    p_task_id,
    p_user_id,
    p_review_id,
    p_expected_input_digest,
    false
  );
  return query select
    v_live ->> 'outcome',
    case when v_live ->> 'outcome' = 'current'
      then v_live ->> 'revision_fingerprint' else null end;
end;
$$;

-- Final egress still requires the latest approved decision. Drafts retain the
-- historical current-Version lock; a current Tabular snapshot instead locks
-- its immutable approved export Version and deliberately ignores later live
-- Review edits or a later current Version on the export Document.
create or replace function public.verify_approved_export_lock(
  p_task_id uuid,
  p_user_id text,
  p_decision_id uuid,
  p_document_id uuid,
  p_version_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select exists (
    select 1
    from public.agent_tasks task
    join public.agent_task_review_decisions decision
      on decision.task_id = task.id
    join public.documents document
      on document.id = p_document_id
    join public.document_versions version
      on version.id = p_version_id
      and version.document_id = document.id
    where task.id = p_task_id
      and task.user_id = p_user_id
      and p_user_id = trim(p_user_id)
      and p_user_id ~ '^[A-Za-z0-9_@.+:=|-]{1,200}$'
      and position('..' in p_user_id) = 0
      and task.status = 'completed'
      and document.project_id = task.matter_id
      and document.user_id = task.user_id
      and decision.id = p_decision_id
      and decision.status = 'approved'
      and decision.id = (
        select latest.id
        from public.agent_task_review_decisions latest
        where latest.task_id = task.id
        order by latest.created_at desc, latest.id desc
        limit 1
      )
      and jsonb_typeof(decision.artifact_snapshot) = 'array'
      and jsonb_array_length(decision.artifact_snapshot) <= 20
      and jsonb_array_length(decision.artifact_snapshot) = (
        select count(distinct (
          coalesce(item ->> 'artifact_type', '') || ':' ||
          coalesce(item ->> 'artifact_id', '')
        ))
        from jsonb_array_elements(decision.artifact_snapshot) artifact(item)
      )
      and not exists (
        select 1
        from jsonb_array_elements(decision.artifact_snapshot) artifact(item)
        where jsonb_typeof(item) <> 'object'
          or not (
            (
              item ->> 'artifact_type' = 'draft'
              and item ?& array[
                'artifact_type', 'artifact_id', 'purpose', 'document_id',
                'version_id', 'version_number', 'filename', 'file_type',
                'size_bytes', 'sha256'
              ]::text[]
              and item - array[
                'artifact_type', 'artifact_id', 'purpose', 'document_id',
                'version_id', 'version_number', 'filename', 'file_type',
                'size_bytes', 'sha256'
              ]::text[] = '{}'::jsonb
              and item ->> 'artifact_id' = item ->> 'document_id'
              and coalesce(item ->> 'artifact_id', '')
                ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              and coalesce(item ->> 'version_id', '')
                ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              and jsonb_typeof(item -> 'purpose') = 'string'
              and length(trim(item ->> 'purpose')) between 1 and 300
              and (
                item -> 'version_number' = 'null'::jsonb
                or (
                  jsonb_typeof(item -> 'version_number') = 'number'
                  and item ->> 'version_number'
                    ~ '^-?(0|[1-9][0-9]*)$'
                  and (item ->> 'version_number')::numeric
                    between -2147483648 and 2147483647
                )
              )
              and jsonb_typeof(item -> 'filename') = 'string'
              and length(trim(item ->> 'filename')) between 1 and 500
              and (
                item -> 'file_type' = 'null'::jsonb
                or jsonb_typeof(item -> 'file_type') = 'string'
              )
              and jsonb_typeof(item -> 'size_bytes') = 'number'
              and item ->> 'size_bytes' ~ '^[0-9]+$'
              and (item ->> 'size_bytes')::numeric <= 2147483647
              and jsonb_typeof(item -> 'sha256') = 'string'
              and item ->> 'sha256' ~ '^sha256:[a-f0-9]{64}$'
            ) or (
              item ->> 'kind' = 'agent_approved_tabular_artifact_v1'
              and item ->> 'artifact_type' = 'tabular_review'
              and item ?& array[
                'kind', 'artifact_type', 'artifact_id', 'purpose', 'review_id',
                'row_protocol', 'input_digest', 'revision_fingerprint',
                'accepted_view_sha256', 'source_receipt_fingerprint',
                'decision_fingerprint', 'completion_sha256',
                'export_document_id', 'export_version_id', 'version_number',
                'filename', 'file_type', 'size_bytes', 'sha256'
              ]::text[]
              and item - array[
                'kind', 'artifact_type', 'artifact_id', 'purpose', 'review_id',
                'row_protocol', 'input_digest', 'revision_fingerprint',
                'accepted_view_sha256', 'source_receipt_fingerprint',
                'decision_fingerprint', 'completion_sha256',
                'export_document_id', 'export_version_id', 'version_number',
                'filename', 'file_type', 'size_bytes', 'sha256'
              ]::text[] = '{}'::jsonb
              and item ->> 'artifact_id' = item ->> 'review_id'
              and item ->> 'artifact_id'
                ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              and jsonb_typeof(item -> 'purpose') = 'string'
              and length(trim(item ->> 'purpose')) between 1 and 300
              and item ->> 'row_protocol' = 'document_rows'
              and item ->> 'input_digest' ~ '^[a-f0-9]{64}$'
              and item ->> 'revision_fingerprint' ~ '^[a-f0-9]{64}$'
              and item ->> 'accepted_view_sha256'
                ~ '^sha256:[a-f0-9]{64}$'
              and (
                item -> 'source_receipt_fingerprint' = 'null'::jsonb
                or (
                  jsonb_typeof(item -> 'source_receipt_fingerprint') = 'string'
                  and item ->> 'source_receipt_fingerprint'
                    ~ '^[a-f0-9]{64}$'
                )
              )
              and (
                item -> 'decision_fingerprint' = 'null'::jsonb
                or (
                  jsonb_typeof(item -> 'decision_fingerprint') = 'string'
                  and item ->> 'decision_fingerprint' ~ '^[a-f0-9]{64}$'
                )
              )
              and (
                item -> 'completion_sha256' = 'null'::jsonb
                or (
                  jsonb_typeof(item -> 'completion_sha256') = 'string'
                  and item ->> 'completion_sha256'
                    ~ '^sha256:[a-f0-9]{64}$'
                )
              )
              and item ->> 'export_document_id'
                ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              and item ->> 'export_version_id'
                ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              and item ->> 'version_number' ~ '^[1-9][0-9]*$'
              and (item ->> 'version_number')::numeric <= 2147483647
              and jsonb_typeof(item -> 'filename') = 'string'
              and length(trim(item ->> 'filename')) between 1 and 500
              and item ->> 'file_type' = 'xlsx'
              and jsonb_typeof(item -> 'size_bytes') = 'number'
              and item ->> 'size_bytes' ~ '^[1-9][0-9]*$'
              and (item ->> 'size_bytes')::numeric <= 104857600
              and jsonb_typeof(item -> 'sha256') = 'string'
              and item ->> 'sha256' ~ '^sha256:[a-f0-9]{64}$'
            )
          )
      )
      and version.deleted_at is null
      and 1 = (
        select count(*)
        from jsonb_array_elements(
          case
            when jsonb_typeof(decision.artifact_snapshot) = 'array'
              then decision.artifact_snapshot
            else '[]'::jsonb
          end
        ) artifact(item)
        where (
          artifact.item ->> 'artifact_type' = 'draft'
          and artifact.item ->> 'artifact_id' = p_document_id::text
          and artifact.item ->> 'document_id' = p_document_id::text
          and artifact.item ->> 'version_id' = p_version_id::text
          and document.current_version_id = p_version_id
          and artifact.item ->> 'version_number'
            is not distinct from version.version_number::text
          and artifact.item ->> 'filename' is not distinct from version.filename
          and artifact.item ->> 'file_type' is not distinct from version.file_type
          and artifact.item ->> 'size_bytes' = version.size_bytes::text
        ) or (
          artifact.item ->> 'kind' = 'agent_approved_tabular_artifact_v1'
          and artifact.item ->> 'artifact_type' = 'tabular_review'
          and artifact.item ->> 'export_document_id' = p_document_id::text
          and artifact.item ->> 'export_version_id' = p_version_id::text
          and artifact.item ->> 'version_number'
            = version.version_number::text
          and artifact.item ->> 'filename' = version.filename
          and artifact.item ->> 'file_type' = 'xlsx'
          and version.file_type = 'xlsx'
          and artifact.item ->> 'size_bytes' = version.size_bytes::text
          and artifact.item ->> 'sha256' ~ '^sha256:[a-f0-9]{64}$'
          and version.source = 'generated'
          and version.storage_path = 'documents/' || p_user_id || '/' ||
            p_document_id::text || '/versions/' || p_version_id::text || '.xlsx'
          and document.status = 'ready'
        )
      )
  );
$$;

revoke all on function public.agent_json_numbers_are_safe_integers_v1(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.agent_canonical_json_v1(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.agent_sha256_hex_v1(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.agent_deterministic_uuid_v1(text)
  from public, anon, authenticated, service_role;
revoke all on function public.agent_tabular_live_revision_v1(
  uuid, text, uuid, text, boolean
) from public, anon, authenticated, service_role;
revoke all on function public.agent_tabular_final_verifier_matches_v1(
  uuid, uuid, jsonb
) from public, anon, authenticated, service_role;
revoke all on function public.agent_draft_final_verifier_matches_v1(
  uuid, uuid, uuid
) from public, anon, authenticated, service_role;
revoke all on function public.agent_final_verifier_snapshot_matches_v1(
  uuid, jsonb
) from public, anon, authenticated, service_role;

revoke all on function public.read_agent_tabular_review_revision_fingerprint_v1(
  uuid, text, uuid, text
) from public, anon, authenticated, service_role;
grant execute on function public.read_agent_tabular_review_revision_fingerprint_v1(
  uuid, text, uuid, text
) to service_role;

revoke all on function public.prepare_agent_tabular_export_materialization_v1(
  uuid, text, uuid, text, jsonb, text, integer, text
) from public, anon, authenticated, service_role;
grant execute on function public.prepare_agent_tabular_export_materialization_v1(
  uuid, text, uuid, text, jsonb, text, integer, text
) to service_role;

revoke execute on function public.record_agent_task_review_decision_v1(
  uuid, uuid, text, uuid, text, text, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.record_agent_task_review_decision_v1(
  uuid, uuid, text, uuid, text, text, text, text, jsonb
) to service_role;

revoke all on function public.verify_approved_export_lock(
  uuid, text, uuid, uuid, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.verify_approved_export_lock(
  uuid, text, uuid, uuid, uuid
) to service_role;

comment on function public.read_agent_tabular_review_revision_fingerprint_v1(
  uuid, text, uuid, text
) is 'Returns the DB-owned live Tabular Review revision under fixed Task, owner, layout and effect boundaries.';
comment on function public.prepare_agent_tabular_export_materialization_v1(
  uuid, text, uuid, text, jsonb, text, integer, text
) is 'Returns a no-write deterministic approved XLSX export plan only for the current final-verifier identity.';
comment on function public.record_agent_task_review_decision_v1(
  uuid, uuid, text, uuid, text, text, text, text, jsonb
) is 'Atomically records a completed Task decision and materializes each strictly bound approved Tabular XLSX Version.';
comment on function public.verify_approved_export_lock(
  uuid, text, uuid, uuid, uuid
) is 'Authorizes only the latest approved Draft current Version or immutable approved Tabular export Version.';
