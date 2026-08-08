begin;

insert into public.projects(id, user_id, name)
values (
  '17000000-0000-4000-8000-000000000001',
  'user-tabular-effect',
  'Tabular effect fixture Matter'
);

insert into public.agent_tasks(
  id, user_id, matter_id, goal, status, current_step,
  execution_lease_owner, execution_lease_expires_at
) values (
  '47000000-0000-4000-8000-000000000001',
  'user-tabular-effect',
  '17000000-0000-4000-8000-000000000001',
  'Publish one Task-owned Tabular Review',
  'running',
  '57000000-0000-4000-8000-000000000001',
  '67000000-0000-4000-8000-000000000001',
  clock_timestamp() + interval '5 minutes'
);

insert into public.agent_steps(
  id, task_id, position, capability, title, status, attempt, result_data
) values (
  '57000000-0000-4000-8000-000000000001',
  '47000000-0000-4000-8000-000000000001',
  0, 'create_tabular', 'Create evidence inventory', 'running', 1,
  '{"other":"keep"}'::jsonb
);

do $$
declare
  v record;
  v_key text := 'agent-step:57000000-0000-4000-8000-000000000001:attempt:1:create_tabular_review';
  v_receipt jsonb := jsonb_build_object(
    'kind', 'agent_step_tabular_effect_v1',
    'effect_key', 'agent-step:57000000-0000-4000-8000-000000000001:attempt:1:create_tabular_review',
    'step_id', '57000000-0000-4000-8000-000000000001',
    'attempt', 1,
    'operation', 'create_tabular_review',
    'input_fingerprint', repeat('a', 64),
    'status', 'reserved',
    'target', jsonb_build_object(
      'review_id', '27000000-0000-4000-8000-000000000001'
    ),
    'effect', null,
    'created_at', '2026-08-08T10:00:00.000Z',
    'committed_at', null
  );
  v_replay jsonb;
begin
  select * into v from public.reserve_agent_step_tabular_effect_v1(
    '47000000-0000-4000-8000-000000000001',
    'user-tabular-effect',
    '57000000-0000-4000-8000-000000000001',
    1,
    '67000000-0000-4000-8000-000000000099',
    v_key,
    v_receipt
  );
  if v.outcome <> 'lease_lost' then
    raise exception 'wrong lease reserved a Tabular effect: %', row_to_json(v);
  end if;

  select * into v from public.reserve_agent_step_tabular_effect_v1(
    '47000000-0000-4000-8000-000000000001',
    'user-tabular-effect',
    '57000000-0000-4000-8000-000000000001',
    1,
    '67000000-0000-4000-8000-000000000001',
    v_key,
    v_receipt
  );
  if v.outcome <> 'reserved' or v.effect_receipt <> v_receipt then
    raise exception 'valid Tabular reservation failed: %', row_to_json(v);
  end if;

  select * into v from public.reserve_agent_step_tabular_effect_v1(
    '47000000-0000-4000-8000-000000000001',
    'user-tabular-effect',
    '57000000-0000-4000-8000-000000000001',
    1,
    '67000000-0000-4000-8000-000000000001',
    v_key,
    v_receipt
  );
  if v.outcome <> 'recovered' then
    raise exception 'Tabular reservation replay did not converge: %', row_to_json(v);
  end if;

  select * into v from public.commit_agent_step_tabular_effect_v1(
    '47000000-0000-4000-8000-000000000001',
    'user-tabular-effect',
    '57000000-0000-4000-8000-000000000001',
    1,
    '67000000-0000-4000-8000-000000000001',
    v_key,
    v_receipt,
    '27000000-0000-4000-8000-000000000001',
    '{"document_ids":[],"columns_config":[],"cells":[]}'::jsonb,
    '2026-08-08T10:01:00.000Z'
  );
  if v.outcome <> 'artifact_invalid' then
    raise exception 'missing Tabular Review was committed: %', row_to_json(v);
  end if;

  insert into public.tabular_reviews(
    id, project_id, user_id, title, row_protocol, document_ids, columns_config
  ) values (
    '27000000-0000-4000-8000-000000000001',
    '17000000-0000-4000-8000-000000000001',
    'user-tabular-effect',
    'Evidence inventory',
    'document_rows',
    '[]'::jsonb,
    '[]'::jsonb
  );

  select * into v from public.commit_agent_step_tabular_effect_v1(
    '47000000-0000-4000-8000-000000000001',
    'user-tabular-effect',
    '57000000-0000-4000-8000-000000000001',
    1,
    '67000000-0000-4000-8000-000000000001',
    v_key,
    v_receipt,
    '27000000-0000-4000-8000-000000000001',
    '{"document_ids":[],"columns_config":[{"drift":true}],"cells":[]}'::jsonb,
    '2026-08-08T10:01:00.000Z'
  );
  if v.outcome <> 'artifact_invalid' then
    raise exception 'drifted Tabular layout was committed: %', row_to_json(v);
  end if;

  select * into v from public.commit_agent_step_tabular_effect_v1(
    '47000000-0000-4000-8000-000000000001',
    'user-tabular-effect',
    '57000000-0000-4000-8000-000000000001',
    1,
    '67000000-0000-4000-8000-000000000001',
    v_key,
    v_receipt,
    '27000000-0000-4000-8000-000000000001',
    '{"document_ids":[],"columns_config":[],"cells":[]}'::jsonb,
    '2026-08-08T10:01:00.000Z'
  );
  if v.outcome <> 'committed'
    or v.effect_receipt ->> 'status' <> 'committed'
    or v.effect_receipt -> 'effect' ->> 'review_id'
      <> '27000000-0000-4000-8000-000000000001' then
    raise exception 'valid Tabular commit failed: %', row_to_json(v);
  end if;

  if (
    select result_data ->> 'other'
    from public.agent_steps
    where id = '57000000-0000-4000-8000-000000000001'
  ) <> 'keep' then
    raise exception 'Tabular effect replaced unrelated Step result data';
  end if;

  -- Simulate the exact production boundary: the Review/effect committed, the
  -- runner stopped before its Task checkpoint, and Resume acquired a new
  -- lease. A new wall-clock timestamp must recover the persisted receipt.
  update public.agent_tasks
  set
    execution_lease_owner = '67000000-0000-4000-8000-000000000002',
    execution_lease_expires_at = clock_timestamp() + interval '5 minutes'
  where id = '47000000-0000-4000-8000-000000000001';
  v_replay := jsonb_set(
    v_receipt,
    '{created_at}',
    '"2026-08-08T10:05:00.000Z"'::jsonb
  );
  select * into v from public.reserve_agent_step_tabular_effect_v1(
    '47000000-0000-4000-8000-000000000001',
    'user-tabular-effect',
    '57000000-0000-4000-8000-000000000001',
    1,
    '67000000-0000-4000-8000-000000000002',
    v_key,
    v_replay
  );
  if v.outcome <> 'recovered'
    or v.effect_receipt ->> 'status' <> 'committed'
    or v.effect_receipt ->> 'created_at' <> '2026-08-08T10:00:00.000Z' then
    raise exception 'new lease did not recover committed Tabular effect: %',
      row_to_json(v);
  end if;

  v_replay := v.effect_receipt || jsonb_build_object(
    'status', 'reserved',
    'effect', null,
    'committed_at', null
  );
  select * into v from public.commit_agent_step_tabular_effect_v1(
    '47000000-0000-4000-8000-000000000001',
    'user-tabular-effect',
    '57000000-0000-4000-8000-000000000001',
    1,
    '67000000-0000-4000-8000-000000000002',
    v_key,
    v_replay,
    '27000000-0000-4000-8000-000000000001',
    '{"document_ids":[],"columns_config":[],"cells":[]}'::jsonb,
    '2026-08-08T10:06:00.000Z'
  );
  if v.outcome <> 'committed'
    or v.effect_receipt ->> 'created_at' <> '2026-08-08T10:00:00.000Z'
    or v.effect_receipt ->> 'committed_at' <> '2026-08-08T10:01:00.000Z' then
    raise exception 'committed Tabular effect replay did not converge: %',
      row_to_json(v);
  end if;

  select * into v from public.reserve_agent_step_tabular_effect_v1(
    '47000000-0000-4000-8000-000000000001',
    'user-tabular-effect',
    '57000000-0000-4000-8000-000000000001',
    1,
    '67000000-0000-4000-8000-000000000002',
    v_key,
    jsonb_set(v_replay, '{input_fingerprint}', to_jsonb(repeat('b', 64)))
  );
  if v.outcome <> 'conflict' then
    raise exception 'non-identical Tabular effect replay did not fail closed: %',
      row_to_json(v);
  end if;

  if (
    select count(*)
    from public.tabular_reviews
    where id = '27000000-0000-4000-8000-000000000001'
  ) <> 1 then
    raise exception 'Tabular effect replay duplicated its fixed Review';
  end if;
end;
$$;

set role authenticated;
do $$
begin
  begin
    perform * from public.reserve_agent_step_tabular_effect_v1(
      '47000000-0000-4000-8000-000000000001',
      'user-tabular-effect',
      '57000000-0000-4000-8000-000000000001',
      1,
      '67000000-0000-4000-8000-000000000001',
      'unauthorized',
      '{}'::jsonb
    );
    raise exception 'authenticated unexpectedly reserved a Tabular effect';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;

rollback;
