-- Agent Task execution lease: a task-wide, owner-token-scoped, expiring fence
-- around the single active advanceAgentTaskExecution caller. This is internal
-- runtime state and must never be returned by the Task API or UI.

alter table public.agent_tasks
  add column if not exists execution_lease_owner uuid,
  add column if not exists execution_lease_expires_at timestamptz;

alter table public.agent_tasks
  drop constraint if exists agent_tasks_execution_lease_paired_null;

alter table public.agent_tasks
  add constraint agent_tasks_execution_lease_paired_null
    check (
      (execution_lease_owner is null and execution_lease_expires_at is null)
      or (execution_lease_owner is not null and execution_lease_expires_at is not null)
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
begin
  if p_task_id is null then
    return query select false, null::timestamptz;
    return;
  end if;
  if p_owner_token is null then
    return query select false, null::timestamptz;
    return;
  end if;
  if p_user_id is null or length(trim(p_user_id)) = 0 then
    return query select false, null::timestamptz;
    return;
  end if;
  if p_ttl_seconds is null or p_ttl_seconds < 30 or p_ttl_seconds > 3600 then
    return query select false, null::timestamptz;
    return;
  end if;

  update public.agent_tasks
  set
    execution_lease_owner = p_owner_token,
    execution_lease_expires_at = clock_timestamp() + (p_ttl_seconds || ' seconds')::interval
  where id = p_task_id
    and user_id = p_user_id
    and (
      execution_lease_owner is null
      or execution_lease_expires_at is null
      or execution_lease_expires_at <= clock_timestamp()
      or execution_lease_owner = p_owner_token
    );

  if found then
    return query
    select true, execution_lease_expires_at
    from public.agent_tasks
    where id = p_task_id and user_id = p_user_id;
  else
    return query select false, null::timestamptz;
  end if;
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
begin
  if p_task_id is null or p_owner_token is null or p_user_id is null or length(trim(p_user_id)) = 0 then
    return query select false, null::timestamptz;
    return;
  end if;
  if p_ttl_seconds is null or p_ttl_seconds < 30 or p_ttl_seconds > 3600 then
    return query select false, null::timestamptz;
    return;
  end if;

  update public.agent_tasks
  set execution_lease_expires_at = clock_timestamp() + (p_ttl_seconds || ' seconds')::interval
  where id = p_task_id
    and user_id = p_user_id
    and execution_lease_owner = p_owner_token
    and execution_lease_expires_at > clock_timestamp();

  if found then
    return query
    select true, execution_lease_expires_at
    from public.agent_tasks
    where id = p_task_id and user_id = p_user_id;
  else
    return query select false, null::timestamptz;
  end if;
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
begin
  if p_task_id is null or p_owner_token is null or p_user_id is null or length(trim(p_user_id)) = 0 then
    return query select false;
    return;
  end if;

  update public.agent_tasks
  set
    execution_lease_owner = null,
    execution_lease_expires_at = null
  where id = p_task_id
    and user_id = p_user_id
    and execution_lease_owner = p_owner_token;

  if found then
    return query select true;
  else
    return query select false;
  end if;
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
