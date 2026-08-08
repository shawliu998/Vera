-- Kernel v1 Batch 14: accept one bounded structured Required Input submission
-- without inventing a free-text message, while retaining the existing atomic source/context fence.

create or replace function public.submit_agent_task_input_v1(
  p_task_id uuid,
  p_user_id text,
  p_step_id uuid,
  p_expected_step_attempt integer,
  p_document_ids uuid[],
  p_latest_checkpoint jsonb
)
returns table(outcome text, task_status text, current_step uuid)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_task public.agent_tasks%rowtype;
  v_step public.agent_steps%rowtype;
  v_blocked_count integer;
  v_running_count integer;
  v_pending_after integer;
  v_document_count integer;
  v_distinct_document_count integer;
  v_checkpoint_document_count integer;
  v_distinct_checkpoint_document_count integer;
  v_matching_checkpoint_document_count integer;
  v_context jsonb;
  v_source_count integer;
  v_distinct_source_count integer;
  v_valid_source_count integer;
  v_input_context_count integer;
  v_structured_response_count integer := 0;
  v_distinct_structured_response_count integer := 0;
  v_next_status text;
  v_updated_at timestamptz := clock_timestamp();
begin
  if p_task_id is null
    or p_user_id is null
    or length(trim(p_user_id)) = 0
    or p_step_id is null
    or p_expected_step_attempt is null
    or p_expected_step_attempt < 0
    or p_expected_step_attempt = 2147483647
    or p_document_ids is null
    or cardinality(p_document_ids) > 100
    or array_position(p_document_ids, null) is not null
    or p_latest_checkpoint is null
    or jsonb_typeof(p_latest_checkpoint) is distinct from 'object'
    or jsonb_typeof(p_latest_checkpoint -> 'user_input') is distinct from 'object'
    or jsonb_typeof(
      p_latest_checkpoint -> 'user_input' -> 'step_id'
    ) is distinct from 'string'
    or p_latest_checkpoint -> 'user_input' ->> 'step_id'
      is distinct from p_step_id::text
    or jsonb_typeof(
      p_latest_checkpoint -> 'user_input' -> 'attempt'
    ) is distinct from 'number'
    or p_latest_checkpoint -> 'user_input' ->> 'attempt'
      is distinct from (p_expected_step_attempt + 1)::text
    or jsonb_typeof(
      p_latest_checkpoint -> 'user_input' -> 'submitted_at'
    ) is distinct from 'string'
    or length(trim(coalesce(
      p_latest_checkpoint -> 'user_input' ->> 'submitted_at', ''
    ))) = 0
    or jsonb_typeof(
      p_latest_checkpoint -> 'user_input' -> 'submission_id'
    ) is distinct from 'string'
    or length(trim(coalesce(
      p_latest_checkpoint -> 'user_input' ->> 'submission_id', ''
    ))) = 0
    or jsonb_typeof(
      p_latest_checkpoint -> 'user_input' -> 'document_ids'
    ) is distinct from 'array'
    or (
      p_latest_checkpoint -> 'user_input' ? 'message'
      and jsonb_typeof(p_latest_checkpoint -> 'user_input' -> 'message')
        <> 'string'
    )
    or (
      p_latest_checkpoint -> 'user_input' ? 'structured_responses'
      and jsonb_typeof(
        p_latest_checkpoint -> 'user_input' -> 'structured_responses'
      ) <> 'array'
    )
    or (case
      when jsonb_typeof(
        p_latest_checkpoint -> 'user_input' -> 'structured_responses'
      ) = 'array'
      then jsonb_array_length(
        p_latest_checkpoint -> 'user_input' -> 'structured_responses'
      ) > 12
      else false
    end) then
    return query select 'invalid_input'::text, null::text, null::uuid;
    return;
  end if;

  select count(*), count(distinct document_id)
  into v_document_count, v_distinct_document_count
  from unnest(p_document_ids) as supplied(document_id);
  if v_document_count <> v_distinct_document_count then
    return query select 'invalid_input'::text, null::text, null::uuid;
    return;
  end if;

  if exists (
    select 1
    from jsonb_array_elements(
      p_latest_checkpoint -> 'user_input' -> 'document_ids'
    ) as checkpoint(document_id)
    where jsonb_typeof(document_id) is distinct from 'string'
  ) then
    return query select 'invalid_input'::text, null::text, null::uuid;
    return;
  end if;

  if jsonb_typeof(
    p_latest_checkpoint -> 'user_input' -> 'structured_responses'
  ) = 'array' then
    if exists (
      select 1
      from jsonb_array_elements(
        p_latest_checkpoint -> 'user_input' -> 'structured_responses'
      ) as supplied(response)
      where jsonb_typeof(response) is distinct from 'object'
        or jsonb_typeof(response -> 'id') is distinct from 'string'
        or length(trim(coalesce(response ->> 'id', ''))) not between 1 and 80
        or jsonb_typeof(response -> 'kind') is distinct from 'string'
        or response ->> 'kind' not in ('choice', 'documents')
        or (
          response ->> 'kind' = 'choice'
          and (
            jsonb_typeof(response -> 'answer') is distinct from 'string'
            or length(trim(coalesce(response ->> 'answer', '')))
              not between 1 and 1000
          )
        )
        or (
          response ->> 'kind' = 'documents'
          and (
            jsonb_typeof(response -> 'document_ids') is distinct from 'array'
            or case
              when jsonb_typeof(response -> 'document_ids') = 'array'
              then jsonb_array_length(response -> 'document_ids') > 100
              else true
            end
            or case
              when jsonb_typeof(response -> 'document_ids') = 'array'
              then exists (
                select 1
                from jsonb_array_elements(
                  response -> 'document_ids'
                ) as selected(document_id)
                where jsonb_typeof(document_id) is distinct from 'string'
                  or length(trim(coalesce(document_id #>> '{}', '')))
                    not between 1 and 200
              )
              else true
            end
          )
        )
    ) then
      return query select 'invalid_input'::text, null::text, null::uuid;
      return;
    end if;

    select count(*), count(distinct response ->> 'id')
    into
      v_structured_response_count,
      v_distinct_structured_response_count
    from jsonb_array_elements(
      p_latest_checkpoint -> 'user_input' -> 'structured_responses'
    ) as supplied(response);
    if v_structured_response_count <> v_distinct_structured_response_count then
      return query select 'invalid_input'::text, null::text, null::uuid;
      return;
    end if;
  end if;

  select
    count(*),
    count(distinct checkpoint_document_id),
    count(*) filter (
      where checkpoint_document_id = any(
        select document_id::text
        from unnest(p_document_ids) as supplied(document_id)
      )
    )
  into
    v_checkpoint_document_count,
    v_distinct_checkpoint_document_count,
    v_matching_checkpoint_document_count
  from jsonb_array_elements_text(
    p_latest_checkpoint -> 'user_input' -> 'document_ids'
  ) as checkpoint(checkpoint_document_id);
  if v_checkpoint_document_count <> cardinality(p_document_ids)
    or v_checkpoint_document_count <> v_distinct_checkpoint_document_count
    or v_matching_checkpoint_document_count <> cardinality(p_document_ids)
    or (
      cardinality(p_document_ids) = 0
      and length(trim(coalesce(
        p_latest_checkpoint -> 'user_input' ->> 'message', ''
      ))) = 0
      and v_structured_response_count = 0
    ) then
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
  if v_task.status <> 'waiting_input'
    or v_task.current_step is distinct from p_step_id then
    return query select 'conflict'::text, v_task.status, v_task.current_step;
    return;
  end if;
  if v_task.execution_lease_owner is not null
    and v_task.execution_lease_expires_at > clock_timestamp() then
    return query select 'lease_busy'::text, v_task.status, v_task.current_step;
    return;
  end if;

  select * into v_step
  from public.agent_steps
  where id = p_step_id and task_id = p_task_id
  for update;
  select count(*) into v_blocked_count
  from public.agent_steps
  where task_id = p_task_id and status = 'blocked';
  select count(*) into v_running_count
  from public.agent_steps
  where task_id = p_task_id and status = 'running';
  if v_step.id is null
    or v_step.status <> 'blocked'
    or v_step.attempt <> p_expected_step_attempt
    or v_blocked_count <> 1
    or v_running_count <> 0 then
    return query select 'conflict'::text, v_task.status, v_task.current_step;
    return;
  end if;

  select count(*) into v_document_count
  from public.documents d
  join public.document_versions v on v.id = d.current_version_id
  where d.id = any(p_document_ids)
    and d.project_id = v_task.matter_id
    and d.user_id = p_user_id
    and d.status = 'ready'
    and v.document_id = d.id
    and v.deleted_at is null
    and v.storage_path is not null;
  if v_document_count <> cardinality(p_document_ids) then
    return query select 'source_invalid'::text, v_task.status, v_task.current_step;
    return;
  end if;

  v_context := p_latest_checkpoint -> 'fixed_matter_context';
  if v_context is not null then
    if jsonb_typeof(v_context) is distinct from 'object'
      or v_context ->> 'kind' is distinct from 'matter_context_v1'
      or v_context ->> 'matter_id' is distinct from v_task.matter_id::text
      or jsonb_typeof(v_context -> 'sources') is distinct from 'array'
      or jsonb_array_length(v_context -> 'sources') > 100 then
      return query select 'context_invalid'::text, v_task.status, v_task.current_step;
      return;
    end if;

    select
      count(*),
      count(distinct context_sources.item ->> 'document_id')
    into v_source_count, v_distinct_source_count
    from jsonb_array_elements(v_context -> 'sources') as context_sources(item);
    if v_source_count <> v_distinct_source_count then
      return query select 'context_invalid'::text, v_task.status, v_task.current_step;
      return;
    end if;

    select count(*) into v_valid_source_count
    from jsonb_array_elements(v_context -> 'sources') as context_sources(item)
    join public.documents d
      on d.id::text = context_sources.item ->> 'document_id'
    join public.document_versions v on v.id = d.current_version_id
    where d.project_id = v_task.matter_id
      and d.user_id = p_user_id
      and d.status = 'ready'
      and d.current_version_id::text = context_sources.item ->> 'version_id'
      and v.document_id = d.id
      and v.deleted_at is null
      and v.storage_path is not null;
    if v_valid_source_count <> v_source_count then
      return query select 'context_invalid'::text, v_task.status, v_task.current_step;
      return;
    end if;

    select count(*) into v_input_context_count
    from unnest(p_document_ids) as supplied(document_id)
    join jsonb_array_elements(v_context -> 'sources') as context_sources(item)
      on context_sources.item ->> 'document_id' = document_id::text;
    if v_input_context_count <> cardinality(p_document_ids) then
      return query select 'context_invalid'::text, v_task.status, v_task.current_step;
      return;
    end if;
  end if;

  select count(*) into v_pending_after
  from public.agent_steps
  where task_id = p_task_id
    and status = 'pending'
    and position > v_step.position;
  v_next_status := case when v_pending_after = 0 then 'verifying' else 'running' end;

  insert into public.agent_artifact_links(
    task_id, artifact_type, artifact_id, purpose
  )
  select p_task_id, 'document', document_id::text, 'Source document'
  from unnest(p_document_ids) as supplied(document_id)
  on conflict (task_id, artifact_type, artifact_id)
  do update set purpose = excluded.purpose;

  update public.agent_steps
  set status = 'running', attempt = attempt + 1, updated_at = v_updated_at
  where id = p_step_id;
  update public.agent_tasks
  set
    status = v_next_status,
    current_step = p_step_id,
    latest_checkpoint = p_latest_checkpoint,
    execution_lease_owner = null,
    execution_lease_expires_at = null,
    updated_at = v_updated_at
  where id = p_task_id;

  return query select 'activated'::text, v_next_status, p_step_id;
end;
$$;

revoke execute on function public.submit_agent_task_input_v1(
  uuid, text, uuid, integer, uuid[], jsonb
) from public, anon, authenticated;
grant execute on function public.submit_agent_task_input_v1(
  uuid, text, uuid, integer, uuid[], jsonb
) to service_role;

comment on function public.submit_agent_task_input_v1(
  uuid, text, uuid, integer, uuid[], jsonb
) is 'Atomically binds supplemental Matter documents or one bounded structured response set and resumes one input-blocked Step.';
