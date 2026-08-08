begin;

insert into public.projects(id, user_id, name)
values (
  '1b000000-0000-4000-8000-000000000001',
  'user-checkpoint-lease',
  'Checkpoint lease fixture Matter'
);

insert into public.agent_tasks(
  id, user_id, matter_id, goal, status, current_step,
  execution_lease_owner, execution_lease_expires_at, latest_checkpoint
) values (
  '4b000000-0000-4000-8000-000000000001',
  'user-checkpoint-lease',
  '1b000000-0000-4000-8000-000000000001',
  'Persist one bounded publication checkpoint',
  'running',
  '5b000000-0000-4000-8000-000000000001',
  '6b000000-0000-4000-8000-000000000001',
  clock_timestamp() + interval '5 minutes',
  '{"schema_version":"agent_task_checkpoint_v1","preserve":true}'::jsonb
);

insert into public.agent_steps(
  id, task_id, position, capability, title, status, attempt, result_data
) values (
  '5b000000-0000-4000-8000-000000000001',
  '4b000000-0000-4000-8000-000000000001',
  0, 'create_tabular', 'Publish evidence inventory', 'running', 1,
  '{}'::jsonb
);

do $$
declare
  v record;
  v_checkpoint jsonb := jsonb_build_object(
    'schema_version', 'agent_task_checkpoint_v1',
    'step_id', '5b000000-0000-4000-8000-000000000001',
    'iteration', 1,
    'litigation_evidence_inventory_receipt', jsonb_build_object(
      'kind', 'litigation_evidence_inventory_receipt_v1'
    )
  );
begin
  select * into v from public.commit_agent_task_checkpoint_v1(
    '4b000000-0000-4000-8000-000000000001',
    'user-checkpoint-lease',
    '6b000000-0000-4000-8000-000000000099',
    'running',
    '5b000000-0000-4000-8000-000000000001',
    1,
    v_checkpoint,
    '{}'::uuid[]
  );
  if v.outcome <> 'lease_lost' then
    raise exception 'wrong UUID lease recorded a checkpoint: %', row_to_json(v);
  end if;

  select * into v from public.commit_agent_task_checkpoint_v1(
    '4b000000-0000-4000-8000-000000000001',
    'user-checkpoint-lease',
    '6b000000-0000-4000-8000-000000000001',
    'running',
    '5b000000-0000-4000-8000-000000000001',
    1,
    v_checkpoint,
    '{}'::uuid[]
  );
  if v.outcome <> 'recorded' then
    raise exception 'valid UUID lease did not record checkpoint: %', row_to_json(v);
  end if;
  if (
    select latest_checkpoint
    from public.agent_tasks
    where id = '4b000000-0000-4000-8000-000000000001'
  ) is distinct from v_checkpoint then
    raise exception 'recorded checkpoint differs from fixed input';
  end if;
end;
$$;

set role authenticated;
do $$
begin
  begin
    perform * from public.commit_agent_task_checkpoint_v1(
      '4b000000-0000-4000-8000-000000000001',
      'user-checkpoint-lease',
      '6b000000-0000-4000-8000-000000000001',
      'running',
      '5b000000-0000-4000-8000-000000000001',
      1,
      '{}'::jsonb,
      '{}'::uuid[]
    );
    raise exception 'authenticated unexpectedly recorded a Task checkpoint';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;

rollback;
