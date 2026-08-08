begin;

insert into public.projects(id, user_id, name)
values (
  '17000000-0000-4000-8000-000000000001',
  'structured-input-smoke',
  'Structured input atomic fixture'
);

insert into public.agent_tasks(
  id, user_id, matter_id, goal, status, current_step
)
values (
  '47000000-0000-4000-8000-000000000001',
  'structured-input-smoke',
  '17000000-0000-4000-8000-000000000001',
  'Confirm three fixed litigation choices',
  'waiting_input',
  '57000000-0000-4000-8000-000000000001'
);

insert into public.agent_steps(id, task_id, position, title, status, attempt)
values
  (
    '57000000-0000-4000-8000-000000000001',
    '47000000-0000-4000-8000-000000000001',
    0,
    'Read fixed source versions',
    'blocked',
    1
  ),
  (
    '57000000-0000-4000-8000-000000000002',
    '47000000-0000-4000-8000-000000000001',
    1,
    'Analyze bounded work scope',
    'pending',
    0
  );

do $$
declare
  v record;
  v_checkpoint jsonb := jsonb_build_object(
    'fixed_matter_context', jsonb_build_object(
      'kind', 'matter_context_v1',
      'matter_id', '17000000-0000-4000-8000-000000000001',
      'sources', jsonb_build_array(),
      'workflow', null,
      'compiled_at', '2026-08-08T12:00:00.000Z'
    ),
    'user_input', jsonb_build_object(
      'submission_id', 'structured-input-valid',
      'step_id', '57000000-0000-4000-8000-000000000001',
      'attempt', 2,
      'submitted_at', '2026-08-08T12:00:00.000Z',
      'document_ids', jsonb_build_array(),
      'structured_responses', jsonb_build_array(
        jsonb_build_object(
          'id', 'litigation-procedural-stage',
          'kind', 'choice',
          'answer', 'first_instance'
        ),
        jsonb_build_object(
          'id', 'litigation-represented-side',
          'kind', 'choice',
          'answer', 'claimant_plaintiff'
        ),
        jsonb_build_object(
          'id', 'litigation-output-language',
          'kind', 'choice',
          'answer', 'zh'
        )
      )
    )
  );
begin
  select * into v from public.submit_agent_task_input_v1(
    '47000000-0000-4000-8000-000000000001',
    'structured-input-smoke',
    '57000000-0000-4000-8000-000000000001',
    1,
    array[]::uuid[],
    v_checkpoint #- '{user_input,structured_responses}'
  );
  if v.outcome <> 'invalid_input' then
    raise exception 'empty response resumed the Step: %', row_to_json(v);
  end if;

  select * into v from public.submit_agent_task_input_v1(
    '47000000-0000-4000-8000-000000000001',
    'structured-input-smoke',
    '57000000-0000-4000-8000-000000000001',
    1,
    array[]::uuid[],
    jsonb_set(
      v_checkpoint,
      '{user_input,structured_responses}',
      '{"not":"an array"}'::jsonb
    )
  );
  if v.outcome <> 'invalid_input' then
    raise exception 'non-array structured response was accepted: %', row_to_json(v);
  end if;

  select * into v from public.submit_agent_task_input_v1(
    '47000000-0000-4000-8000-000000000001',
    'structured-input-smoke',
    '57000000-0000-4000-8000-000000000001',
    1,
    array[]::uuid[],
    jsonb_set(
      v_checkpoint,
      '{user_input,structured_responses,1,id}',
      '"litigation-procedural-stage"'::jsonb
    )
  );
  if v.outcome <> 'invalid_input' then
    raise exception 'duplicate structured response ids were accepted: %', row_to_json(v);
  end if;

  select * into v from public.submit_agent_task_input_v1(
    '47000000-0000-4000-8000-000000000001',
    'structured-input-smoke',
    '57000000-0000-4000-8000-000000000001',
    1,
    array[]::uuid[],
    v_checkpoint
  );
  if v.outcome <> 'activated' or v.task_status <> 'running' then
    raise exception 'valid structured-only input failed: %', row_to_json(v);
  end if;
  if (
    select jsonb_array_length(
      latest_checkpoint -> 'user_input' -> 'structured_responses'
    )
    from public.agent_tasks
    where id = '47000000-0000-4000-8000-000000000001'
  ) <> 3 then
    raise exception 'structured response set was not persisted intact';
  end if;
  if (
    select latest_checkpoint -> 'user_input' ? 'message'
    from public.agent_tasks
    where id = '47000000-0000-4000-8000-000000000001'
  ) then
    raise exception 'structured-only input invented a free-text message';
  end if;
  if (
    select attempt
    from public.agent_steps
    where id = '57000000-0000-4000-8000-000000000001'
  ) <> 2 then
    raise exception 'structured-only input did not advance the fixed attempt';
  end if;

  select * into v from public.submit_agent_task_input_v1(
    '47000000-0000-4000-8000-000000000001',
    'structured-input-smoke',
    '57000000-0000-4000-8000-000000000001',
    1,
    array[]::uuid[],
    v_checkpoint
  );
  if v.outcome <> 'conflict' then
    raise exception 'structured response replay did not fail closed: %', row_to_json(v);
  end if;

  if has_function_privilege(
    'authenticated',
    'public.submit_agent_task_input_v1(uuid,text,uuid,integer,uuid[],jsonb)',
    'execute'
  ) then
    raise exception 'authenticated can execute the internal input transition';
  end if;
end $$;

rollback;
