-- Kernel v1 Batch 10d: durably checkpoint bounded server-owned work without
-- advancing the Step or releasing its execution lease.

create or replace function public.commit_agent_task_checkpoint_v1(
  p_task_id uuid,
  p_user_id text,
  p_lease_owner text,
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
  v_running_count integer;
  v_updated_at timestamptz := clock_timestamp();
begin
  if p_task_id is null
    or p_user_id is null
    or length(trim(p_user_id)) = 0
    or p_lease_owner is null
    or length(trim(p_lease_owner)) = 0
    or p_expected_task_status is null
    or p_expected_task_status not in ('running', 'verifying')
    or p_step_id is null
    or p_expected_step_attempt is null
    or p_expected_step_attempt < 1
    or p_latest_checkpoint is null
    or jsonb_typeof(p_latest_checkpoint) is distinct from 'object' then
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
  if v_task.status <> p_expected_task_status
    or v_task.current_step is distinct from p_step_id then
    return query select 'conflict'::text, v_task.status, v_task.current_step;
    return;
  end if;

  select * into v_step
  from public.agent_steps
  where id = p_step_id and task_id = p_task_id
  for update;
  select count(*) into v_running_count
  from public.agent_steps
  where task_id = p_task_id and status = 'running';
  if v_step.id is null
    or v_step.status <> 'running'
    or v_step.attempt <> p_expected_step_attempt
    or v_running_count <> 1 then
    return query select 'conflict'::text, v_task.status, v_task.current_step;
    return;
  end if;

  update public.agent_tasks
  set latest_checkpoint = p_latest_checkpoint, updated_at = v_updated_at
  where id = p_task_id;

  return query select 'recorded'::text, v_task.status, p_step_id;
end;
$$;

revoke execute on function public.commit_agent_task_checkpoint_v1(
  uuid, text, text, text, uuid, integer, jsonb
) from public, anon, authenticated;
grant execute on function public.commit_agent_task_checkpoint_v1(
  uuid, text, text, text, uuid, integer, jsonb
) to service_role;

comment on function public.commit_agent_task_checkpoint_v1(
  uuid, text, text, text, uuid, integer, jsonb
) is 'Atomically checkpoints bounded server-owned Step progress under the active execution lease.';
