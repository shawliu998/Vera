-- Kernel v1 Batch 10: atomically advance one leased Agent Task Step, the
-- owning Task pointer/status and the completion review decision.

create or replace function public.advance_agent_task_state_v1(
  p_task_id uuid,
  p_user_id text,
  p_lease_owner uuid,
  p_expected_task_status text,
  p_step_id uuid,
  p_expected_step_attempt integer,
  p_result_summary text,
  p_latest_checkpoint jsonb,
  p_review_note text
)
returns table(outcome text, task_status text, current_step uuid)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_task public.agent_tasks%rowtype;
  v_step public.agent_steps%rowtype;
  v_next public.agent_steps%rowtype;
  v_first_pending public.agent_steps%rowtype;
  v_other_running integer;
  v_blocked_after integer;
  v_pending_after integer;
  v_next_status text;
  v_next_current_step uuid;
  v_updated_at timestamptz := clock_timestamp();
begin
  if p_task_id is null
    or p_user_id is null
    or length(trim(p_user_id)) = 0
    or p_lease_owner is null
    or p_expected_task_status is null
    or p_expected_task_status not in ('queued', 'running', 'verifying')
    or p_step_id is null
    or p_expected_step_attempt is null
    or p_expected_step_attempt < 0
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

  select * into v_step
  from public.agent_steps
  where id = p_step_id and task_id = p_task_id
  for update;
  if not found or v_step.attempt <> p_expected_step_attempt then
    return query select 'conflict'::text, v_task.status, v_task.current_step;
    return;
  end if;

  select count(*) into v_other_running
  from public.agent_steps
  where task_id = p_task_id and status = 'running' and id <> p_step_id;
  if v_other_running <> 0 then
    return query select 'conflict'::text, v_task.status, v_task.current_step;
    return;
  end if;

  if p_expected_task_status = 'queued' then
    select * into v_first_pending
    from public.agent_steps
    where task_id = p_task_id and status = 'pending'
    order by position asc
    limit 1
    for update;
    if v_task.current_step is not null
      or v_step.status <> 'pending'
      or v_first_pending.id is distinct from p_step_id then
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
    set status = v_next_status, current_step = p_step_id, updated_at = v_updated_at
    where id = p_task_id;

    return query select 'advanced'::text, v_next_status, p_step_id;
    return;
  end if;

  if v_task.current_step is distinct from p_step_id
    or v_step.status <> 'running' then
    return query select 'conflict'::text, v_task.status, v_task.current_step;
    return;
  end if;
  if p_result_summary is null or length(trim(p_result_summary)) = 0 then
    return query select 'invalid_input'::text, v_task.status, v_task.current_step;
    return;
  end if;

  select count(*) into v_blocked_after
  from public.agent_steps
  where task_id = p_task_id
    and position > v_step.position
    and status in ('running', 'blocked');
  if v_blocked_after <> 0 then
    return query select 'conflict'::text, v_task.status, v_task.current_step;
    return;
  end if;

  select * into v_next
  from public.agent_steps
  where task_id = p_task_id
    and position > v_step.position
    and status = 'pending'
  order by position asc
  limit 1
  for update;

  if v_next.id is null then
    v_next_status := 'completed';
    v_next_current_step := null;
    if p_review_note is null or length(trim(p_review_note)) = 0 then
      return query select 'invalid_input'::text, v_task.status, v_task.current_step;
      return;
    end if;
  else
    select count(*) into v_pending_after
    from public.agent_steps
    where task_id = p_task_id
      and status = 'pending'
      and position > v_next.position;
    v_next_status := case when v_pending_after = 0 then 'verifying' else 'running' end;
    v_next_current_step := v_next.id;
  end if;

  update public.agent_steps
  set status = 'completed', result_summary = trim(p_result_summary), updated_at = v_updated_at
  where id = p_step_id;
  if v_next_current_step is not null then
    update public.agent_steps
    set status = 'running', attempt = attempt + 1, updated_at = v_updated_at
    where id = v_next_current_step;
  end if;
  update public.agent_tasks
  set
    status = v_next_status,
    current_step = v_next_current_step,
    latest_checkpoint = p_latest_checkpoint,
    updated_at = v_updated_at
  where id = p_task_id;

  if v_next_status = 'completed' then
    insert into public.agent_task_review_decisions(
      task_id, status, note, artifact_snapshot
    ) values (
      p_task_id, 'review_required', trim(p_review_note), '[]'::jsonb
    );
  end if;

  return query select 'advanced'::text, v_next_status, v_next_current_step;
end;
$$;

revoke execute on function public.advance_agent_task_state_v1(
  uuid, text, uuid, text, uuid, integer, text, jsonb, text
) from public, anon, authenticated;

grant execute on function public.advance_agent_task_state_v1(
  uuid, text, uuid, text, uuid, integer, text, jsonb, text
) to service_role;

comment on function public.advance_agent_task_state_v1(
  uuid, text, uuid, text, uuid, integer, text, jsonb, text
) is 'Atomically advances one leased Agent Step, Task state and completion review decision.';
