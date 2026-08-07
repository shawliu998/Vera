insert into public.projects(id)
values
  ('15000000-0000-4000-8000-000000000001'),
  ('15000000-0000-4000-8000-000000000002'),
  ('15000000-0000-4000-8000-000000000003');

insert into public.agent_tasks(
  id, user_id, matter_id, goal, status, current_step,
  execution_lease_owner, execution_lease_expires_at
) values (
  '45000000-0000-4000-8000-000000000001',
  'user-pause',
  '15000000-0000-4000-8000-000000000001',
  'Pause running task',
  'running',
  '55000000-0000-4000-8000-000000000001',
  '65000000-0000-4000-8000-000000000001',
  clock_timestamp() + interval '5 minutes'
), (
  '45000000-0000-4000-8000-000000000002',
  'user-pause',
  '15000000-0000-4000-8000-000000000002',
  'Pause planner task',
  'queued',
  null,
  '65000000-0000-4000-8000-000000000002',
  clock_timestamp() + interval '5 minutes'
), (
  '45000000-0000-4000-8000-000000000003',
  'user-pause',
  '15000000-0000-4000-8000-000000000003',
  'Reject torn resume',
  'paused',
  '55000000-0000-4000-8000-000000000004',
  null,
  null
);

insert into public.agent_steps(
  id, task_id, position, title, status, attempt
) values
  (
    '55000000-0000-4000-8000-000000000001',
    '45000000-0000-4000-8000-000000000001',
    0, 'Draft', 'running', 2
  ),
  (
    '55000000-0000-4000-8000-000000000002',
    '45000000-0000-4000-8000-000000000001',
    1, 'Verify', 'pending', 0
  ),
  (
    '55000000-0000-4000-8000-000000000003',
    '45000000-0000-4000-8000-000000000002',
    0, 'Read', 'pending', 0
  ),
  (
    '55000000-0000-4000-8000-000000000004',
    '45000000-0000-4000-8000-000000000003',
    0, 'First', 'running', 1
  ),
  (
    '55000000-0000-4000-8000-000000000005',
    '45000000-0000-4000-8000-000000000003',
    1, 'Second', 'running', 1
  );

do $$
declare
  v record;
  v_acquired boolean;
  v_renewed boolean;
begin
  select * into v from public.pause_agent_task_state_v1(
    '45000000-0000-4000-8000-000000000001',
    'user-pause',
    'running',
    '55000000-0000-4000-8000-000000000001',
    2,
    '65000000-0000-4000-8000-000000000099',
    false,
    '{"summary":"wrong owner"}'::jsonb
  );
  if v.outcome <> 'lease_lost' then
    raise exception 'wrong owner paused a Task: %', row_to_json(v);
  end if;

  select * into v from public.pause_agent_task_state_v1(
    '45000000-0000-4000-8000-000000000001',
    'user-pause',
    'running',
    '55000000-0000-4000-8000-000000000001',
    2,
    null,
    false,
    '{"summary":"background pause"}'::jsonb
  );
  if v.outcome <> 'lease_busy' then
    raise exception 'lease-free background pause revoked a live owner: %', row_to_json(v);
  end if;

  update public.agent_steps
  set status = 'completed'
  where id = '55000000-0000-4000-8000-000000000001';
  update public.agent_steps
  set status = 'running', attempt = 1
  where id = '55000000-0000-4000-8000-000000000002';
  update public.agent_tasks
  set
    status = 'verifying',
    current_step = '55000000-0000-4000-8000-000000000002',
    latest_checkpoint = '{"fresh":true}'::jsonb
  where id = '45000000-0000-4000-8000-000000000001';

  select * into v from public.pause_agent_task_state_v1(
    '45000000-0000-4000-8000-000000000001',
    'user-pause',
    'running',
    '55000000-0000-4000-8000-000000000001',
    2,
    null,
    true,
    '{"summary":"user pause"}'::jsonb
  );
  if v.outcome <> 'paused' then
    raise exception 'user pause failed: %', row_to_json(v);
  end if;
  if exists (
    select 1 from public.agent_tasks
    where id = '45000000-0000-4000-8000-000000000001'
      and (status <> 'paused'
        or execution_lease_owner is not null
        or execution_lease_expires_at is not null)
  ) then
    raise exception 'pause did not atomically revoke the lease';
  end if;
  if not exists (
    select 1 from public.agent_tasks t
    join public.agent_steps s on s.id = t.current_step
    where t.id = '45000000-0000-4000-8000-000000000001'
      and t.current_step = '55000000-0000-4000-8000-000000000002'
      and t.latest_checkpoint = '{"fresh":true}'::jsonb
      and s.status = 'running' and s.attempt = 1
  ) then
    raise exception 'user pause did not bind the locked current Step and checkpoint';
  end if;

  select acquired into v_acquired
  from public.acquire_agent_task_execution_lease_v1(
    '45000000-0000-4000-8000-000000000001',
    'user-pause',
    '65000000-0000-4000-8000-000000000003',
    300
  );
  if v_acquired then
    raise exception 'paused Task acquired an execution lease';
  end if;
  select renewed into v_renewed
  from public.renew_agent_task_execution_lease_v1(
    '45000000-0000-4000-8000-000000000001',
    'user-pause',
    '65000000-0000-4000-8000-000000000001',
    300
  );
  if v_renewed then
    raise exception 'paused Task renewed an obsolete execution lease';
  end if;

  select * into v from public.resume_agent_task_state_v1(
    '45000000-0000-4000-8000-000000000001', 'user-pause'
  );
  if v.outcome <> 'resumed' or v.task_status <> 'verifying' then
    raise exception 'running Task resume failed: %', row_to_json(v);
  end if;
  if not exists (
    select 1 from public.agent_steps
    where id = '55000000-0000-4000-8000-000000000002'
      and status = 'running' and attempt = 1
  ) then
    raise exception 'resume silently created a retry';
  end if;

  select acquired into v_acquired
  from public.acquire_agent_task_execution_lease_v1(
    '45000000-0000-4000-8000-000000000001',
    'user-pause',
    '65000000-0000-4000-8000-000000000003',
    300
  );
  if not v_acquired then
    raise exception 'resumed Task could not acquire a new lease';
  end if;
  select * into v from public.pause_agent_task_state_v1(
    '45000000-0000-4000-8000-000000000001',
    'user-pause',
    'verifying',
    '55000000-0000-4000-8000-000000000002',
    1,
    '65000000-0000-4000-8000-000000000003',
    false,
    '{"summary":"owned pause"}'::jsonb
  );
  if v.outcome <> 'paused' then
    raise exception 'current owner could not pause atomically: %', row_to_json(v);
  end if;

  select * into v from public.pause_agent_task_state_v1(
    '45000000-0000-4000-8000-000000000002',
    'user-pause',
    'queued',
    null,
    null,
    '65000000-0000-4000-8000-000000000002',
    false,
    '{"summary":"planner pause"}'::jsonb
  );
  if v.outcome <> 'paused' or v.current_step is not null then
    raise exception 'queued planner pause failed: %', row_to_json(v);
  end if;
  select * into v from public.resume_agent_task_state_v1(
    '45000000-0000-4000-8000-000000000002', 'user-pause'
  );
  if v.outcome <> 'resumed' or v.task_status <> 'queued' then
    raise exception 'queued planner resume failed: %', row_to_json(v);
  end if;

  select * into v from public.resume_agent_task_state_v1(
    '45000000-0000-4000-8000-000000000003', 'user-pause'
  );
  if v.outcome <> 'conflict' then
    raise exception 'torn two-running-Step Task resumed: %', row_to_json(v);
  end if;
end;
$$;

set role authenticated;
do $$
begin
  begin
    perform * from public.resume_agent_task_state_v1(
      '45000000-0000-4000-8000-000000000001', 'user-pause'
    );
    raise exception 'authenticated unexpectedly executed pause/resume RPC';
  exception
    when insufficient_privilege then null;
  end;
end;
$$;
reset role;

select
  t.id,
  t.status,
  t.current_step,
  t.execution_lease_owner,
  s.status as step_status,
  s.attempt
from public.agent_tasks t
left join public.agent_steps s on s.id = t.current_step
order by t.id;
