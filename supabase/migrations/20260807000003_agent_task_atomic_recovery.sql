-- Kernel v1 Batch 10b: atomically block/stop a leased active Step and
-- atomically reactivate one blocked Step after its prior lease is gone.

create or replace function public.stop_agent_task_state_v1(
  p_task_id uuid,
  p_user_id text,
  p_lease_owner uuid,
  p_expected_task_status text,
  p_step_id uuid,
  p_expected_step_attempt integer,
  p_target_status text,
  p_result_summary text,
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
  v_updated_at timestamptz := clock_timestamp();
begin
  if p_task_id is null
    or p_user_id is null
    or length(trim(p_user_id)) = 0
    or p_lease_owner is null
    or p_expected_task_status is null
    or p_expected_task_status not in ('queued', 'running', 'verifying')
    or p_target_status is null
    or p_target_status not in ('waiting_input', 'failed')
    or p_result_summary is null
    or length(trim(p_result_summary)) = 0
    or p_latest_checkpoint is null
    or jsonb_typeof(p_latest_checkpoint) <> 'object'
    or ((p_step_id is null) <> (p_expected_step_attempt is null))
    or (p_expected_step_attempt is not null and p_expected_step_attempt < 0) then
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
  if v_task.execution_lease_owner is distinct from p_lease_owner
    or v_task.execution_lease_expires_at is null
    or v_task.execution_lease_expires_at <= clock_timestamp() then
    return query select 'lease_lost'::text, v_task.status, v_task.current_step;
    return;
  end if;
  if v_task.status <> p_expected_task_status then
    return query select 'conflict'::text, v_task.status, v_task.current_step;
    return;
  end if;

  select count(*) into v_running_count
  from public.agent_steps
  where task_id = p_task_id and status = 'running';
  if p_step_id is null then
    if p_expected_task_status <> 'queued'
      or v_task.current_step is not null
      or v_running_count <> 0 then
      return query select 'conflict'::text, v_task.status, v_task.current_step;
      return;
    end if;
  else
    select * into v_step
    from public.agent_steps
    where id = p_step_id and task_id = p_task_id
    for update;
    if not found
      or v_task.current_step is distinct from p_step_id
      or v_step.status <> 'running'
      or v_step.attempt <> p_expected_step_attempt
      or v_running_count <> 1 then
      return query select 'conflict'::text, v_task.status, v_task.current_step;
      return;
    end if;
  end if;

  if p_step_id is not null then
    update public.agent_steps
    set
      status = 'blocked',
      result_summary = trim(p_result_summary),
      updated_at = v_updated_at
    where id = p_step_id;
  end if;
  update public.agent_tasks
  set
    status = p_target_status,
    current_step = p_step_id,
    latest_checkpoint = p_latest_checkpoint,
    updated_at = v_updated_at
  where id = p_task_id;

  return query select 'stopped'::text, p_target_status, p_step_id;
end;
$$;

create or replace function public.retry_agent_task_state_v1(
  p_task_id uuid,
  p_user_id text,
  p_expected_task_status text,
  p_step_id uuid,
  p_expected_step_attempt integer,
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
  v_pending_after integer;
  v_next_status text;
  v_updated_at timestamptz := clock_timestamp();
begin
  if p_task_id is null
    or p_user_id is null
    or length(trim(p_user_id)) = 0
    or p_expected_task_status is null
    or p_expected_task_status not in ('waiting_input', 'failed')
    or ((p_step_id is null) <> (p_expected_step_attempt is null))
    or (p_expected_step_attempt is not null and p_expected_step_attempt < 0)
    or (p_latest_checkpoint is not null and jsonb_typeof(p_latest_checkpoint) <> 'object') then
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
  if v_task.status <> p_expected_task_status then
    return query select 'conflict'::text, v_task.status, v_task.current_step;
    return;
  end if;
  if v_task.execution_lease_owner is not null
    and v_task.execution_lease_expires_at > clock_timestamp() then
    return query select 'lease_busy'::text, v_task.status, v_task.current_step;
    return;
  end if;

  if p_step_id is null then
    select count(*) into v_blocked_count
    from public.agent_steps
    where task_id = p_task_id and status in ('running', 'blocked');
    if p_expected_task_status <> 'failed'
      or v_task.current_step is not null
      or v_blocked_count <> 0 then
      return query select 'conflict'::text, v_task.status, v_task.current_step;
      return;
    end if;

    update public.agent_tasks
    set
      status = 'queued',
      current_step = null,
      latest_checkpoint = p_latest_checkpoint,
      execution_lease_owner = null,
      execution_lease_expires_at = null,
      updated_at = v_updated_at
    where id = p_task_id;
    return query select 'retried'::text, 'queued'::text, null::uuid;
    return;
  end if;

  select * into v_step
  from public.agent_steps
  where id = p_step_id and task_id = p_task_id
  for update;
  select count(*) into v_blocked_count
  from public.agent_steps
  where task_id = p_task_id and status = 'blocked';
  if v_step.id is null
    or v_task.current_step is distinct from p_step_id
    or v_step.status <> 'blocked'
    or v_step.attempt <> p_expected_step_attempt
    or v_blocked_count <> 1 then
    return query select 'conflict'::text, v_task.status, v_task.current_step;
    return;
  end if;

  select count(*) into v_pending_after
  from public.agent_steps
  where task_id = p_task_id
    and status = 'pending'
    and position > v_step.position;
  v_next_status := case when v_pending_after = 0 then 'verifying' else 'running' end;

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

  return query select 'retried'::text, v_next_status, p_step_id;
end;
$$;

revoke execute on function public.stop_agent_task_state_v1(
  uuid, text, uuid, text, uuid, integer, text, text, jsonb
) from public, anon, authenticated;
revoke execute on function public.retry_agent_task_state_v1(
  uuid, text, text, uuid, integer, jsonb
) from public, anon, authenticated;

grant execute on function public.stop_agent_task_state_v1(
  uuid, text, uuid, text, uuid, integer, text, text, jsonb
) to service_role;
grant execute on function public.retry_agent_task_state_v1(
  uuid, text, text, uuid, integer, jsonb
) to service_role;

comment on function public.stop_agent_task_state_v1(
  uuid, text, uuid, text, uuid, integer, text, text, jsonb
) is 'Atomically blocks the exact leased Step and stops its owning active Task.';
comment on function public.retry_agent_task_state_v1(
  uuid, text, text, uuid, integer, jsonb
) is 'Atomically retries one blocked Step after its prior execution lease is gone.';
