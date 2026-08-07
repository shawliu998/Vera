-- Kernel v1 Batch 10f: atomically pause or resume one Task while preserving
-- its current Step attempt and fencing every prior execution owner.

create or replace function public.acquire_agent_task_execution_lease_v1(
  p_task_id uuid,
  p_user_id text,
  p_owner_token uuid,
  p_ttl_seconds integer
)
returns table(acquired boolean, expires_at timestamptz)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_expires_at timestamptz;
begin
  if p_task_id is null
    or p_owner_token is null
    or p_user_id is null
    or length(trim(p_user_id)) = 0
    or p_ttl_seconds is null
    or p_ttl_seconds < 30
    or p_ttl_seconds > 3600 then
    return query select false, null::timestamptz;
    return;
  end if;

  update public.agent_tasks
  set
    execution_lease_owner = p_owner_token,
    execution_lease_expires_at =
      clock_timestamp() + make_interval(secs => p_ttl_seconds)
  where id = p_task_id
    and user_id = p_user_id
    and status in ('queued', 'running', 'verifying')
    and (
      execution_lease_owner is null
      or execution_lease_expires_at is null
      or execution_lease_expires_at <= clock_timestamp()
      or execution_lease_owner = p_owner_token
    )
  returning execution_lease_expires_at into v_expires_at;

  return query select v_expires_at is not null, v_expires_at;
end;
$$;

create or replace function public.renew_agent_task_execution_lease_v1(
  p_task_id uuid,
  p_user_id text,
  p_owner_token uuid,
  p_ttl_seconds integer
)
returns table(renewed boolean, expires_at timestamptz)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_expires_at timestamptz;
begin
  if p_task_id is null
    or p_owner_token is null
    or p_user_id is null
    or length(trim(p_user_id)) = 0
    or p_ttl_seconds is null
    or p_ttl_seconds < 30
    or p_ttl_seconds > 3600 then
    return query select false, null::timestamptz;
    return;
  end if;

  update public.agent_tasks
  set execution_lease_expires_at =
    clock_timestamp() + make_interval(secs => p_ttl_seconds)
  where id = p_task_id
    and user_id = p_user_id
    and status in ('queued', 'running', 'verifying')
    and execution_lease_owner = p_owner_token
    and execution_lease_expires_at > clock_timestamp()
  returning execution_lease_expires_at into v_expires_at;

  return query select v_expires_at is not null, v_expires_at;
end;
$$;

create or replace function public.pause_agent_task_state_v1(
  p_task_id uuid,
  p_user_id text,
  p_expected_task_status text,
  p_step_id uuid,
  p_expected_step_attempt integer,
  p_lease_owner uuid,
  p_force_revoke boolean,
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
  v_derived_status text;
  v_expected_task_status text;
  v_expected_step_id uuid;
  v_expected_step_attempt integer;
  v_latest_checkpoint jsonb;
  v_updated_at timestamptz := clock_timestamp();
begin
  if p_task_id is null
    or p_user_id is null
    or length(trim(p_user_id)) = 0
    or p_force_revoke is null
    or (p_force_revoke and p_lease_owner is not null)
    or (not p_force_revoke and (
      p_expected_task_status is null
      or p_expected_task_status not in ('queued', 'running', 'verifying')
      or ((p_step_id is null) <> (p_expected_step_attempt is null))
      or (p_expected_step_attempt is not null and p_expected_step_attempt < 1)
    ))
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

  if p_force_revoke and v_task.status = 'paused' then
    update public.agent_tasks
    set
      execution_lease_owner = null,
      execution_lease_expires_at = null,
      updated_at = v_updated_at
    where id = p_task_id;
    return query select 'paused'::text, 'paused'::text, v_task.current_step;
    return;
  end if;
  if p_force_revoke
    and v_task.status not in ('queued', 'running', 'verifying') then
    return query select 'conflict'::text, v_task.status, v_task.current_step;
    return;
  end if;
  v_expected_task_status := case
    when p_force_revoke then v_task.status
    else p_expected_task_status
  end;
  v_expected_step_id := case
    when p_force_revoke then v_task.current_step
    else p_step_id
  end;
  v_expected_step_attempt := p_expected_step_attempt;
  v_latest_checkpoint := case
    when p_force_revoke then v_task.latest_checkpoint
    else p_latest_checkpoint
  end;

  select count(*) into v_running_count
  from public.agent_steps
  where task_id = p_task_id and status = 'running';
  select count(*) into v_blocked_count
  from public.agent_steps
  where task_id = p_task_id and status = 'blocked';
  if v_expected_step_id is null then
    if v_expected_task_status <> 'queued'
      or v_task.current_step is not null
      or v_running_count <> 0
      or v_blocked_count <> 0
      or exists (
        select 1 from public.agent_steps
        where task_id = p_task_id and status <> 'pending'
      ) then
      return query select 'conflict'::text, v_task.status, v_task.current_step;
      return;
    end if;
  else
    select * into v_step
    from public.agent_steps
    where id = v_expected_step_id and task_id = p_task_id
    for update;
    if p_force_revoke then
      v_expected_step_attempt := v_step.attempt;
    end if;
    if not found
      or v_expected_task_status not in ('running', 'verifying')
      or v_task.current_step is distinct from v_expected_step_id
      or v_step.status <> 'running'
      or v_step.attempt <> v_expected_step_attempt
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
    v_derived_status := case
      when v_pending_after = 0 then 'verifying'
      else 'running'
    end;
    if v_derived_status <> v_expected_task_status then
      return query select 'conflict'::text, v_task.status, v_task.current_step;
      return;
    end if;
  end if;

  if v_task.status = 'paused' then
    if p_force_revoke
      and (v_task.execution_lease_owner is not null
        or v_task.execution_lease_expires_at is not null) then
      update public.agent_tasks
      set
        execution_lease_owner = null,
        execution_lease_expires_at = null,
        updated_at = v_updated_at
      where id = p_task_id;
    end if;
    return query select 'paused'::text, 'paused'::text, v_task.current_step;
    return;
  end if;
  if v_task.status <> v_expected_task_status then
    return query select 'conflict'::text, v_task.status, v_task.current_step;
    return;
  end if;

  if not p_force_revoke then
    if p_lease_owner is not null then
      if v_task.execution_lease_owner is distinct from p_lease_owner
        or v_task.execution_lease_expires_at is null
        or v_task.execution_lease_expires_at <= clock_timestamp() then
        return query select 'lease_lost'::text, v_task.status, v_task.current_step;
        return;
      end if;
    elsif v_task.execution_lease_owner is not null
      and v_task.execution_lease_expires_at > clock_timestamp() then
      return query select 'lease_busy'::text, v_task.status, v_task.current_step;
      return;
    end if;
  end if;

  update public.agent_tasks
  set
    status = 'paused',
    latest_checkpoint = v_latest_checkpoint,
    execution_lease_owner = null,
    execution_lease_expires_at = null,
    updated_at = v_updated_at
  where id = p_task_id;
  return query select 'paused'::text, 'paused'::text, v_task.current_step;
end;
$$;

create or replace function public.resume_agent_task_state_v1(
  p_task_id uuid,
  p_user_id text
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
    or length(trim(p_user_id)) = 0 then
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
    execution_lease_owner = null,
    execution_lease_expires_at = null,
    updated_at = v_updated_at
  where id = p_task_id;
  return query select 'resumed'::text, v_next_status, v_task.current_step;
end;
$$;

revoke execute on function public.pause_agent_task_state_v1(
  uuid, text, text, uuid, integer, uuid, boolean, jsonb
) from public, anon, authenticated;
revoke execute on function public.resume_agent_task_state_v1(uuid, text)
  from public, anon, authenticated;

grant execute on function public.pause_agent_task_state_v1(
  uuid, text, text, uuid, integer, uuid, boolean, jsonb
) to service_role;
grant execute on function public.resume_agent_task_state_v1(uuid, text)
  to service_role;

comment on function public.pause_agent_task_state_v1(
  uuid, text, text, uuid, integer, uuid, boolean, jsonb
) is 'Atomically pauses one Task, preserves its Step attempt and revokes the prior execution lease.';
comment on function public.resume_agent_task_state_v1(uuid, text)
  is 'Atomically resumes one paused Task from its persisted Step shape without creating a retry.';
