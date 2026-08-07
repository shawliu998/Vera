-- Kernel v1 Batch 10p: atomically invalidate only the completed verifier after
-- one Task-owned draft receives a new current Document Version.

create or replace function public.start_agent_task_artifact_reverification_v1(
  p_task_id uuid,
  p_user_id text,
  p_document_id uuid,
  p_base_version_id uuid,
  p_version_id uuid,
  p_mutation_id text
)
returns table(outcome text, task_status text, current_step uuid)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_task public.agent_tasks%rowtype;
  v_document public.documents%rowtype;
  v_base_version public.document_versions%rowtype;
  v_version public.document_versions%rowtype;
  v_verifier public.agent_steps%rowtype;
  v_verifier_count integer;
  v_invalid_step_count integer;
  v_running_step_count integer;
  v_existing_event jsonb;
  v_receipts jsonb;
  v_filtered_receipts jsonb;
  v_checkpoint jsonb;
  v_updated_at timestamptz := clock_timestamp();
begin
  if p_task_id is null
    or p_user_id is null
    or length(trim(p_user_id)) = 0
    or p_document_id is null
    or p_base_version_id is null
    or p_version_id is null
    or p_base_version_id = p_version_id
    or p_mutation_id is null
    or length(trim(p_mutation_id)) not between 1 and 200 then
    return query select 'invalid_input'::text, null::text, null::uuid;
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

  select * into v_document
  from public.documents
  where id = p_document_id
    and user_id = p_user_id
    and project_id = v_task.matter_id
  for update;
  if not found then
    return query select 'artifact_not_found'::text, v_task.status, v_task.current_step;
    return;
  end if;
  if v_document.current_version_id is distinct from p_version_id then
    return query select 'version_conflict'::text, v_task.status, v_task.current_step;
    return;
  end if;

  select * into v_base_version
  from public.document_versions
  where id = p_base_version_id
    and document_id = p_document_id
    and deleted_at is null;
  select * into v_version
  from public.document_versions
  where id = p_version_id
    and document_id = p_document_id
    and deleted_at is null;
  if v_base_version.id is null or v_version.id is null then
    return query select 'version_conflict'::text, v_task.status, v_task.current_step;
    return;
  end if;

  perform 1
  from public.agent_artifact_links
  where task_id = p_task_id
    and artifact_type = 'draft'
    and artifact_id = p_document_id::text;
  if not found then
    return query select 'artifact_not_found'::text, v_task.status, v_task.current_step;
    return;
  end if;

  v_existing_event := v_task.latest_checkpoint -> 'artifact_reverification';
  if jsonb_typeof(v_existing_event) = 'object'
    and v_existing_event ->> 'mutation_id' = trim(p_mutation_id) then
    if v_existing_event ->> 'kind' = 'agent_task_artifact_reverification_v1'
      and v_existing_event ->> 'task_id' = p_task_id::text
      and v_existing_event ->> 'document_id' = p_document_id::text
      and v_existing_event ->> 'base_version_id' = p_base_version_id::text
      and v_existing_event ->> 'version_id' = p_version_id::text then
      return query select 'already_started'::text, v_task.status, v_task.current_step;
    else
      return query select 'conflict'::text, v_task.status, v_task.current_step;
    end if;
    return;
  end if;

  if v_task.execution_lease_owner is not null
    and v_task.execution_lease_expires_at > clock_timestamp() then
    return query select 'lease_busy'::text, v_task.status, v_task.current_step;
    return;
  end if;
  if v_task.status <> 'completed' or v_task.current_step is not null then
    return query select 'conflict'::text, v_task.status, v_task.current_step;
    return;
  end if;
  if jsonb_typeof(v_task.latest_checkpoint) is distinct from 'object'
    or v_task.latest_checkpoint ->> 'schema_version'
      is distinct from 'agent_task_checkpoint_v1'
    or jsonb_typeof(v_task.latest_checkpoint -> 'contract')
      is distinct from 'object' then
    return query select 'contract_invalid'::text, v_task.status, v_task.current_step;
    return;
  end if;

  perform 1
  from public.agent_steps
  where task_id = p_task_id
  order by position
  for update;

  select * into v_verifier
  from public.agent_steps
  where task_id = p_task_id
  order by position desc
  limit 1;

  select count(*) into v_verifier_count
  from public.agent_steps
  where task_id = p_task_id and capability = 'verify';
  select count(*) into v_invalid_step_count
  from public.agent_steps
  where task_id = p_task_id
    and status not in ('completed', 'skipped');
  select count(*) into v_running_step_count
  from public.agent_steps
  where task_id = p_task_id and status = 'running';

  if v_verifier.id is null
    or v_verifier.capability is distinct from 'verify'
    or v_verifier.status <> 'completed'
    or v_verifier.attempt = 2147483647
    or v_verifier_count <> 1
    or v_invalid_step_count <> 0
    or v_running_step_count <> 0 then
    return query select 'verifier_invalid'::text, v_task.status, v_task.current_step;
    return;
  end if;

  v_receipts := coalesce(v_task.latest_checkpoint -> 'step_receipts', '[]'::jsonb);
  if jsonb_typeof(v_receipts) is distinct from 'array' then
    return query select 'contract_invalid'::text, v_task.status, v_task.current_step;
    return;
  end if;
  select coalesce(
    jsonb_agg(receipt.value order by receipt.ordinality),
    '[]'::jsonb
  ) into v_filtered_receipts
  from jsonb_array_elements(v_receipts)
    with ordinality as receipt(value, ordinality)
  where receipt.value ->> 'position' is distinct from v_verifier.position::text;

  v_checkpoint := jsonb_set(
    jsonb_set(
      v_task.latest_checkpoint,
      '{step_receipts}',
      v_filtered_receipts,
      true
    ),
    '{artifact_reverification}',
    jsonb_build_object(
      'kind', 'agent_task_artifact_reverification_v1',
      'mutation_id', trim(p_mutation_id),
      'task_id', p_task_id,
      'document_id', p_document_id,
      'base_version_id', p_base_version_id,
      'version_id', p_version_id,
      'verifier_step_id', v_verifier.id,
      'attempt', v_verifier.attempt + 1,
      'requested_at', v_updated_at
    ),
    true
  );

  update public.agent_steps
  set
    status = 'running',
    attempt = attempt + 1,
    repair_attempt = 0,
    result_summary = null,
    result_data = null,
    updated_at = greatest(v_updated_at, updated_at + interval '1 microsecond')
  where id = v_verifier.id;

  update public.agent_tasks
  set
    status = 'verifying',
    current_step = v_verifier.id,
    latest_checkpoint = v_checkpoint,
    execution_lease_owner = null,
    execution_lease_expires_at = null,
    updated_at = greatest(v_updated_at, updated_at + interval '1 microsecond')
  where id = p_task_id;

  return query select 'started'::text, 'verifying'::text, v_verifier.id;
end;
$$;

revoke execute on function public.start_agent_task_artifact_reverification_v1(
  uuid, text, uuid, uuid, uuid, text
) from public, anon, authenticated;

grant execute on function public.start_agent_task_artifact_reverification_v1(
  uuid, text, uuid, uuid, uuid, text
) to service_role;

comment on function public.start_agent_task_artifact_reverification_v1(
  uuid, text, uuid, uuid, uuid, text
) is 'Atomically invalidates only the completed verifier after a Task-owned draft advances to one exact current Version.';
