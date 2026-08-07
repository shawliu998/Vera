insert into public.projects(id)
values ('10000000-0000-4000-8000-000000000001');

insert into public.agent_tasks(
  id,
  user_id,
  matter_id,
  goal,
  status,
  execution_lease_owner,
  execution_lease_expires_at
) values (
  '20000000-0000-4000-8000-000000000001',
  'user-fixture',
  '10000000-0000-4000-8000-000000000001',
  'Atomic transition fixture',
  'queued',
  '30000000-0000-4000-8000-000000000001',
  clock_timestamp() + interval '5 minutes'
);

insert into public.agent_steps(id, task_id, position, title, status, attempt)
values
  (
    '40000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    0,
    'Create artifact',
    'pending',
    0
  ),
  (
    '40000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000001',
    1,
    'Verify artifact',
    'pending',
    0
  );

do $$
declare
  v record;
begin
  select * into v from public.advance_agent_task_state_v1(
    '20000000-0000-4000-8000-000000000001',
    'user-fixture',
    '30000000-0000-4000-8000-000000000001',
    'queued',
    '40000000-0000-4000-8000-000000000001',
    0,
    null,
    '{}'::jsonb,
    null
  );
  if v.outcome <> 'advanced' or v.task_status <> 'running' then
    raise exception 'start transition failed: %', row_to_json(v);
  end if;

  select * into v from public.advance_agent_task_state_v1(
    '20000000-0000-4000-8000-000000000001',
    'user-fixture',
    '30000000-0000-4000-8000-000000000001',
    'running',
    '40000000-0000-4000-8000-000000000001',
    1,
    'artifact created',
    '{"step_id":"40000000-0000-4000-8000-000000000001"}'::jsonb,
    null
  );
  if v.outcome <> 'advanced'
    or v.task_status <> 'verifying'
    or v.current_step <> '40000000-0000-4000-8000-000000000002'::uuid then
    raise exception 'next transition failed: %', row_to_json(v);
  end if;

  select * into v from public.advance_agent_task_state_v1(
    '20000000-0000-4000-8000-000000000001',
    'user-fixture',
    '30000000-0000-4000-8000-000000000099',
    'verifying',
    '40000000-0000-4000-8000-000000000002',
    1,
    'verified',
    '{"step_id":"40000000-0000-4000-8000-000000000002"}'::jsonb,
    'Review required.'
  );
  if v.outcome <> 'lease_lost' then
    raise exception 'stale lease was accepted: %', row_to_json(v);
  end if;

  select * into v from public.advance_agent_task_state_v1(
    '20000000-0000-4000-8000-000000000001',
    'user-fixture',
    '30000000-0000-4000-8000-000000000001',
    'verifying',
    '40000000-0000-4000-8000-000000000002',
    1,
    'verified',
    '{"step_id":"40000000-0000-4000-8000-000000000002"}'::jsonb,
    null
  );
  if v.outcome <> 'invalid_input' then
    raise exception 'missing review note did not fail closed: %', row_to_json(v);
  end if;
  if (
    select status
    from public.agent_steps
    where id = '40000000-0000-4000-8000-000000000002'
  ) <> 'running' then
    raise exception 'invalid final transition partially mutated the Step';
  end if;

  select * into v from public.advance_agent_task_state_v1(
    '20000000-0000-4000-8000-000000000001',
    'user-fixture',
    '30000000-0000-4000-8000-000000000001',
    'verifying',
    '40000000-0000-4000-8000-000000000002',
    1,
    'verified',
    '{"step_id":"40000000-0000-4000-8000-000000000002"}'::jsonb,
    'Review required.'
  );
  if v.outcome <> 'advanced'
    or v.task_status <> 'completed'
    or v.current_step is not null then
    raise exception 'completion transition failed: %', row_to_json(v);
  end if;

  select * into v from public.advance_agent_task_state_v1(
    '20000000-0000-4000-8000-000000000001',
    'user-fixture',
    '30000000-0000-4000-8000-000000000001',
    'verifying',
    '40000000-0000-4000-8000-000000000002',
    1,
    'verified',
    '{"step_id":"40000000-0000-4000-8000-000000000002"}'::jsonb,
    'Review required.'
  );
  if v.outcome <> 'conflict' then
    raise exception 'replay did not converge to conflict: %', row_to_json(v);
  end if;
  if (
    select count(*)
    from public.agent_task_review_decisions
    where task_id = '20000000-0000-4000-8000-000000000001'
  ) <> 1 then
    raise exception 'completion review decision was duplicated';
  end if;
  if has_function_privilege(
    'authenticated',
    'public.advance_agent_task_state_v1(uuid,text,uuid,text,uuid,integer,text,jsonb,text)',
    'execute'
  ) then
    raise exception 'authenticated role can execute internal transition';
  end if;
  if not has_function_privilege(
    'service_role',
    'public.advance_agent_task_state_v1(uuid,text,uuid,text,uuid,integer,text,jsonb,text)',
    'execute'
  ) then
    raise exception 'service role cannot execute internal transition';
  end if;
end $$;
