-- Kernel v1 Batch 5: durable Step effect receipts and an expiring,
-- owner-token-scoped Task execution fence. No client role receives direct
-- access to either internal runtime field or lease RPC.

alter table public.agent_steps
  add column if not exists result_data jsonb;

alter table public.agent_steps
  drop constraint if exists agent_steps_result_data_object;

alter table public.agent_steps
  add constraint agent_steps_result_data_object
    check (result_data is null or jsonb_typeof(result_data) = 'object');

alter table public.agent_tasks
  add column if not exists execution_lease_owner uuid,
  add column if not exists execution_lease_expires_at timestamptz;

alter table public.agent_tasks
  drop constraint if exists agent_tasks_execution_lease_paired_null;

alter table public.agent_tasks
  add constraint agent_tasks_execution_lease_paired_null
    check (
      (execution_lease_owner is null and execution_lease_expires_at is null)
      or
      (execution_lease_owner is not null and execution_lease_expires_at is not null)
    );

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
    and (
      execution_lease_owner is null
      or execution_lease_expires_at is null
      or execution_lease_expires_at <= clock_timestamp()
      or execution_lease_owner = p_owner_token
    )
  returning execution_lease_expires_at into v_expires_at;

  return query
    select v_expires_at is not null, v_expires_at;
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
    and execution_lease_owner = p_owner_token
    and execution_lease_expires_at > clock_timestamp()
  returning execution_lease_expires_at into v_expires_at;

  return query
    select v_expires_at is not null, v_expires_at;
end;
$$;

create or replace function public.release_agent_task_execution_lease_v1(
  p_task_id uuid,
  p_user_id text,
  p_owner_token uuid
)
returns table(released boolean)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_released uuid;
begin
  if p_task_id is null
    or p_owner_token is null
    or p_user_id is null
    or length(trim(p_user_id)) = 0 then
    return query select false;
    return;
  end if;

  update public.agent_tasks
  set
    execution_lease_owner = null,
    execution_lease_expires_at = null
  where id = p_task_id
    and user_id = p_user_id
    and execution_lease_owner = p_owner_token
  returning id into v_released;

  return query select v_released is not null;
end;
$$;

revoke execute on function public.acquire_agent_task_execution_lease_v1(uuid, text, uuid, integer)
  from public, anon, authenticated;
revoke execute on function public.renew_agent_task_execution_lease_v1(uuid, text, uuid, integer)
  from public, anon, authenticated;
revoke execute on function public.release_agent_task_execution_lease_v1(uuid, text, uuid)
  from public, anon, authenticated;

grant execute on function public.acquire_agent_task_execution_lease_v1(uuid, text, uuid, integer)
  to service_role;
grant execute on function public.renew_agent_task_execution_lease_v1(uuid, text, uuid, integer)
  to service_role;
grant execute on function public.release_agent_task_execution_lease_v1(uuid, text, uuid)
  to service_role;

comment on column public.agent_steps.result_data is
  'Server-owned structured Step/effect receipts; never model-authoritative.';
comment on column public.agent_tasks.execution_lease_owner is
  'Internal owner-token fence for one active Agent Task runner.';
