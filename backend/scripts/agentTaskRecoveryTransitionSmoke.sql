insert into public.projects(id, user_id, name)
values (
  '11000000-0000-4000-8000-000000000001',
  'user-recovery',
  'Atomic recovery fixture Matter'
);

insert into public.agent_tasks(
  id,
  user_id,
  matter_id,
  goal,
  status,
  current_step,
  execution_lease_owner,
  execution_lease_expires_at
) values (
  '21000000-0000-4000-8000-000000000001',
  'user-recovery',
  '11000000-0000-4000-8000-000000000001',
  'Atomic recovery fixture',
  'running',
  '41000000-0000-4000-8000-000000000001',
  '31000000-0000-4000-8000-000000000001',
  clock_timestamp() + interval '5 minutes'
);

insert into public.agent_steps(id, task_id, position, title, status, attempt)
values
  (
    '41000000-0000-4000-8000-000000000001',
    '21000000-0000-4000-8000-000000000001',
    0,
    'Read source',
    'running',
    1
  ),
  (
    '41000000-0000-4000-8000-000000000002',
    '21000000-0000-4000-8000-000000000001',
    1,
    'Verify result',
    'pending',
    0
  );

insert into public.agent_tasks(
  id,
  user_id,
  matter_id,
  goal,
  status,
  execution_lease_owner,
  execution_lease_expires_at
) values (
  '21000000-0000-4000-8000-000000000002',
  'user-recovery',
  '11000000-0000-4000-8000-000000000001',
  'Planner recovery fixture',
  'queued',
  '31000000-0000-4000-8000-000000000002',
  clock_timestamp() + interval '5 minutes'
);
insert into public.agent_steps(id, task_id, position, title, status, attempt)
values (
  '41000000-0000-4000-8000-000000000003',
  '21000000-0000-4000-8000-000000000002',
  0,
  'Plan work',
  'pending',
  0
);

do $$
declare
  v record;
begin
  select * into v from public.stop_agent_task_state_v1(
    '21000000-0000-4000-8000-000000000001',
    'user-recovery',
    '31000000-0000-4000-8000-000000000099',
    'running',
    '41000000-0000-4000-8000-000000000001',
    1,
    'failed',
    'Synthetic failure.',
    '{"step_id":"41000000-0000-4000-8000-000000000001"}'::jsonb
  );
  if v.outcome <> 'lease_lost' then
    raise exception 'stale stop owner was accepted: %', row_to_json(v);
  end if;
  if (
    select status
    from public.agent_steps
    where id = '41000000-0000-4000-8000-000000000001'
  ) <> 'running' then
    raise exception 'stale stop owner partially mutated the Step';
  end if;

  select * into v from public.stop_agent_task_state_v1(
    '21000000-0000-4000-8000-000000000001',
    'user-recovery',
    '31000000-0000-4000-8000-000000000001',
    'running',
    '41000000-0000-4000-8000-000000000001',
    9,
    'failed',
    'Synthetic failure.',
    '{"step_id":"41000000-0000-4000-8000-000000000001"}'::jsonb
  );
  if v.outcome <> 'conflict' then
    raise exception 'wrong stop attempt was accepted: %', row_to_json(v);
  end if;

  select * into v from public.stop_agent_task_state_v1(
    '21000000-0000-4000-8000-000000000001',
    'user-recovery',
    '31000000-0000-4000-8000-000000000001',
    'running',
    '41000000-0000-4000-8000-000000000001',
    1,
    'failed',
    'Synthetic failure.',
    '{"step_id":"41000000-0000-4000-8000-000000000001"}'::jsonb
  );
  if v.outcome <> 'stopped' or v.task_status <> 'failed' then
    raise exception 'leased stop failed: %', row_to_json(v);
  end if;

  select * into v from public.retry_agent_task_state_v1(
    '21000000-0000-4000-8000-000000000001',
    'user-recovery',
    'failed',
    '41000000-0000-4000-8000-000000000001',
    1,
    '{}'::jsonb
  );
  if v.outcome <> 'lease_busy' then
    raise exception 'retry ignored the still-live prior lease: %', row_to_json(v);
  end if;
  if (
    select status
    from public.agent_steps
    where id = '41000000-0000-4000-8000-000000000001'
  ) <> 'blocked' then
    raise exception 'lease-busy retry partially mutated the Step';
  end if;

  perform * from public.release_agent_task_execution_lease_v1(
    '21000000-0000-4000-8000-000000000001',
    'user-recovery',
    '31000000-0000-4000-8000-000000000001'
  );
  select * into v from public.retry_agent_task_state_v1(
    '21000000-0000-4000-8000-000000000001',
    'user-recovery',
    'failed',
    '41000000-0000-4000-8000-000000000001',
    1,
    '{}'::jsonb
  );
  if v.outcome <> 'retried' or v.task_status <> 'running' then
    raise exception 'atomic retry failed: %', row_to_json(v);
  end if;
  if (
    select attempt
    from public.agent_steps
    where id = '41000000-0000-4000-8000-000000000001'
  ) <> 2 then
    raise exception 'atomic retry did not advance the exact attempt once';
  end if;

  select * into v from public.retry_agent_task_state_v1(
    '21000000-0000-4000-8000-000000000001',
    'user-recovery',
    'failed',
    '41000000-0000-4000-8000-000000000001',
    1,
    '{}'::jsonb
  );
  if v.outcome <> 'conflict' then
    raise exception 'retry replay did not converge to conflict: %', row_to_json(v);
  end if;

  select * into v from public.stop_agent_task_state_v1(
    '21000000-0000-4000-8000-000000000002',
    'user-recovery',
    '31000000-0000-4000-8000-000000000002',
    'queued',
    null,
    null,
    'failed',
    'Planner failed before Step start.',
    '{"step_id":"planner"}'::jsonb
  );
  if v.outcome <> 'stopped' or v.task_status <> 'failed' then
    raise exception 'planner stop failed: %', row_to_json(v);
  end if;
  perform * from public.release_agent_task_execution_lease_v1(
    '21000000-0000-4000-8000-000000000002',
    'user-recovery',
    '31000000-0000-4000-8000-000000000002'
  );
  select * into v from public.retry_agent_task_state_v1(
    '21000000-0000-4000-8000-000000000002',
    'user-recovery',
    'failed',
    null,
    null,
    '{}'::jsonb
  );
  if v.outcome <> 'retried'
    or v.task_status <> 'queued'
    or v.current_step is not null then
    raise exception 'planner retry failed: %', row_to_json(v);
  end if;
  if (
    select status
    from public.agent_steps
    where id = '41000000-0000-4000-8000-000000000003'
  ) <> 'pending' then
    raise exception 'planner retry mutated the pending Step';
  end if;
  if has_function_privilege(
    'authenticated',
    'public.stop_agent_task_state_v1(uuid,text,uuid,text,uuid,integer,text,text,jsonb)',
    'execute'
  ) or has_function_privilege(
    'authenticated',
    'public.retry_agent_task_state_v1(uuid,text,text,uuid,integer,jsonb)',
    'execute'
  ) then
    raise exception 'authenticated role can execute an internal recovery transition';
  end if;
end $$;
