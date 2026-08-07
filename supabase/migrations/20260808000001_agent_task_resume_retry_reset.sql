-- Kernel v1 Batch 10w: an explicit resume atomically clears the exhausted
-- automatic provider-retry budget while preserving the current Task and Step.

drop function if exists public.resume_agent_task_state_v1(uuid, text);

create or replace function public.resume_agent_task_state_v1(
  p_task_id uuid,
  p_user_id text,
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
  v_running_count integer;
  v_blocked_count integer;
  v_invalid_before integer;
  v_invalid_after integer;
  v_pending_after integer;
  v_next_status text;
  v_updated_at timestamptz := clock_timestamp();
begin
  if p_task_id is null
    or p_user_id is null
    or length(trim(p_user_id)) = 0
    or (p_latest_checkpoint is not null
      and jsonb_typeof(p_latest_checkpoint) <> 'object') then
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

  select count(*) into v_running_count
  from public.agent_steps
  where task_id = p_task_id and status = 'running';
  select count(*) into v_blocked_count
  from public.agent_steps
  where task_id = p_task_id and status = 'blocked';
  if v_task.current_step is null then
    if v_running_count <> 0
      or v_blocked_count <> 0
      or exists (
        select 1 from public.agent_steps
        where task_id = p_task_id and status <> 'pending'
      ) then
      return query select 'conflict'::text, v_task.status, v_task.current_step;
      return;
    end if;
    v_next_status := 'queued';
  else
    select * into v_step
    from public.agent_steps
    where id = v_task.current_step and task_id = p_task_id
    for update;
    if not found
      or v_step.status <> 'running'
      or v_running_count <> 1
      or v_blocked_count <> 0 then
      return query select 'conflict'::text, v_task.status, v_task.current_step;
      return;
    end if;
    select count(*) into v_invalid_before
    from public.agent_steps
    where task_id = p_task_id
      and position < v_step.position
      and status not in ('completed', 'skipped');
    select count(*) into v_invalid_after
    from public.agent_steps
    where task_id = p_task_id
      and position > v_step.position
      and status <> 'pending';
    if v_invalid_before <> 0 or v_invalid_after <> 0 then
      return query select 'conflict'::text, v_task.status, v_task.current_step;
      return;
    end if;
    select count(*) into v_pending_after
    from public.agent_steps
    where task_id = p_task_id
      and status = 'pending'
      and position > v_step.position;
    v_next_status := case
      when v_pending_after = 0 then 'verifying'
      else 'running'
    end;
  end if;

  if v_task.status = v_next_status then
    return query select 'resumed'::text, v_next_status, v_task.current_step;
    return;
  end if;
  if v_task.status <> 'paused' then
    return query select 'conflict'::text, v_task.status, v_task.current_step;
    return;
  end if;

  update public.agent_tasks
  set
    status = v_next_status,
    latest_checkpoint = p_latest_checkpoint,
    execution_lease_owner = null,
    execution_lease_expires_at = null,
    updated_at = v_updated_at
  where id = p_task_id;
  return query select 'resumed'::text, v_next_status, v_task.current_step;
end;
$$;

revoke execute on function public.resume_agent_task_state_v1(
  uuid, text, jsonb
) from public, anon, authenticated;
grant execute on function public.resume_agent_task_state_v1(
  uuid, text, jsonb
) to service_role;

comment on function public.resume_agent_task_state_v1(uuid, text, jsonb)
  is 'Atomically resumes one paused Task from its persisted Step shape and resets only the supplied retry checkpoint state.';
