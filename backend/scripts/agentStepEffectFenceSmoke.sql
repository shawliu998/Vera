insert into public.projects(id)
values ('14000000-0000-4000-8000-000000000001');

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
  '44000000-0000-4000-8000-000000000001',
  'user-effect',
  '14000000-0000-4000-8000-000000000001',
  'Effect fence fixture',
  'running',
  '54000000-0000-4000-8000-000000000001',
  '64000000-0000-4000-8000-000000000001',
  clock_timestamp() + interval '5 minutes'
);

insert into public.agent_steps(
  id, task_id, position, title, status, attempt, result_data
) values (
  '54000000-0000-4000-8000-000000000001',
  '44000000-0000-4000-8000-000000000001',
  0,
  'Create Word',
  'running',
  2,
  '{"other":"keep"}'::jsonb
);

do $$
declare
  v record;
  v_receipt jsonb := jsonb_build_object(
    'kind', 'agent_step_effect_v1',
    'effect_key', 'agent-step:54000000-0000-4000-8000-000000000001:attempt:2:generate_docx',
    'step_id', '54000000-0000-4000-8000-000000000001',
    'attempt', 2,
    'tool_name', 'generate_docx',
    'input_fingerprint', repeat('a', 64),
    'status', 'reserved',
    'target', jsonb_build_object(
      'document_id', '24000000-0000-4000-8000-000000000001',
      'version_id', '34000000-0000-4000-8000-000000000001'
    ),
    'effect', null,
    'created_at', '2026-08-07T10:00:00.000Z',
    'committed_at', null
  );
  v_key text := 'agent-step:54000000-0000-4000-8000-000000000001:attempt:2:generate_docx';
begin
  select * into v from public.reserve_agent_step_effect_v1(
    '44000000-0000-4000-8000-000000000001',
    'user-effect',
    '54000000-0000-4000-8000-000000000001',
    2,
    '64000000-0000-4000-8000-000000000099',
    v_key,
    v_receipt
  );
  if v.outcome <> 'lease_lost' then
    raise exception 'wrong lease owner reserved an effect: %', row_to_json(v);
  end if;
  if (
    select result_data ? 'effect_receipts'
    from public.agent_steps
    where id = '54000000-0000-4000-8000-000000000001'
  ) then
    raise exception 'rejected reservation wrote a partial receipt';
  end if;

  select * into v from public.reserve_agent_step_effect_v1(
    '44000000-0000-4000-8000-000000000001',
    'user-effect',
    '54000000-0000-4000-8000-000000000001',
    1,
    '64000000-0000-4000-8000-000000000001',
    v_key,
    jsonb_set(v_receipt, '{attempt}', '1'::jsonb)
  );
  if v.outcome <> 'conflict' then
    raise exception 'wrong Step attempt reserved an effect: %', row_to_json(v);
  end if;

  select * into v from public.reserve_agent_step_effect_v1(
    '44000000-0000-4000-8000-000000000001',
    'user-effect',
    '54000000-0000-4000-8000-000000000001',
    2,
    '64000000-0000-4000-8000-000000000001',
    v_key,
    v_receipt
  );
  if v.outcome <> 'reserved' or v.effect_receipt <> v_receipt then
    raise exception 'valid effect reservation failed: %', row_to_json(v);
  end if;
  if (
    select result_data ->> 'other'
    from public.agent_steps
    where id = '54000000-0000-4000-8000-000000000001'
  ) <> 'keep' then
    raise exception 'effect reservation replaced unrelated Step data';
  end if;

  select * into v from public.reserve_agent_step_effect_v1(
    '44000000-0000-4000-8000-000000000001',
    'user-effect',
    '54000000-0000-4000-8000-000000000001',
    2,
    '64000000-0000-4000-8000-000000000001',
    v_key,
    v_receipt
  );
  if v.outcome <> 'recovered' then
    raise exception 'effect reservation replay did not converge: %', row_to_json(v);
  end if;
  select * into v from public.reserve_agent_step_effect_v1(
    '44000000-0000-4000-8000-000000000001',
    'user-effect',
    '54000000-0000-4000-8000-000000000001',
    2,
    '64000000-0000-4000-8000-000000000001',
    v_key,
    jsonb_set(v_receipt, '{input_fingerprint}', to_jsonb(repeat('b', 64)))
  );
  if v.outcome <> 'conflict' then
    raise exception 'different effect input reused a reservation: %', row_to_json(v);
  end if;

  select * into v from public.commit_agent_step_effect_v1(
    '44000000-0000-4000-8000-000000000001',
    'user-effect',
    '54000000-0000-4000-8000-000000000001',
    2,
    '64000000-0000-4000-8000-000000000001',
    v_key,
    v_receipt,
    'draft',
    '24000000-0000-4000-8000-000000000001',
    '34000000-0000-4000-8000-000000000001',
    '2026-08-07T10:01:00.000Z'
  );
  if v.outcome <> 'artifact_invalid' then
    raise exception 'missing Matter artifact was committed: %', row_to_json(v);
  end if;

  insert into public.documents(
    id, project_id, user_id, status, current_version_id
  ) values (
    '24000000-0000-4000-8000-000000000001',
    '14000000-0000-4000-8000-000000000001',
    'user-effect',
    'ready',
    '34000000-0000-4000-8000-000000000001'
  );
  insert into public.document_versions(
    id, document_id, filename, file_type, storage_path, deleted_at
  ) values (
    '34000000-0000-4000-8000-000000000001',
    '24000000-0000-4000-8000-000000000001',
    'memo.docx',
    'docx',
    'matter/memo.docx',
    null
  );

  update public.agent_tasks
  set
    status = 'paused',
    execution_lease_owner = null,
    execution_lease_expires_at = null
  where id = '44000000-0000-4000-8000-000000000001';
  select * into v from public.commit_agent_step_effect_v1(
    '44000000-0000-4000-8000-000000000001',
    'user-effect',
    '54000000-0000-4000-8000-000000000001',
    2,
    '64000000-0000-4000-8000-000000000001',
    v_key,
    v_receipt,
    'draft',
    '24000000-0000-4000-8000-000000000001',
    '34000000-0000-4000-8000-000000000001',
    '2026-08-07T10:01:00.000Z'
  );
  if v.outcome <> 'lease_lost' then
    raise exception 'paused Task accepted an old effect: %', row_to_json(v);
  end if;

  update public.agent_tasks
  set status = 'running'
  where id = '44000000-0000-4000-8000-000000000001';
  perform * from public.acquire_agent_task_execution_lease_v1(
    '44000000-0000-4000-8000-000000000001',
    'user-effect',
    '64000000-0000-4000-8000-000000000002',
    300
  );
  select * into v from public.commit_agent_step_effect_v1(
    '44000000-0000-4000-8000-000000000001',
    'user-effect',
    '54000000-0000-4000-8000-000000000001',
    2,
    '64000000-0000-4000-8000-000000000001',
    v_key,
    v_receipt,
    'draft',
    '24000000-0000-4000-8000-000000000001',
    '34000000-0000-4000-8000-000000000001',
    '2026-08-07T10:01:00.000Z'
  );
  if v.outcome <> 'lease_lost' then
    raise exception 'superseded lease committed an effect: %', row_to_json(v);
  end if;
  select * into v from public.commit_agent_step_effect_v1(
    '44000000-0000-4000-8000-000000000001',
    'user-effect',
    '54000000-0000-4000-8000-000000000001',
    2,
    '64000000-0000-4000-8000-000000000002',
    v_key,
    v_receipt,
    'draft',
    '24000000-0000-4000-8000-000000000001',
    '34000000-0000-4000-8000-000000000001',
    '2026-08-07T10:01:00.000Z'
  );
  if v.outcome <> 'committed'
    or v.effect_receipt ->> 'status' <> 'committed' then
    raise exception 'new lease failed to recover and commit the effect: %', row_to_json(v);
  end if;
  select * into v from public.commit_agent_step_effect_v1(
    '44000000-0000-4000-8000-000000000001',
    'user-effect',
    '54000000-0000-4000-8000-000000000001',
    2,
    '64000000-0000-4000-8000-000000000002',
    v_key,
    v_receipt,
    'draft',
    '24000000-0000-4000-8000-000000000001',
    '34000000-0000-4000-8000-000000000001',
    '2026-08-07T10:02:00.000Z'
  );
  if v.outcome <> 'committed'
    or v.effect_receipt ->> 'committed_at' <> '2026-08-07T10:01:00.000Z' then
    raise exception 'effect commit replay did not preserve the first commit';
  end if;

  update public.agent_steps
  set attempt = 3
  where id = '54000000-0000-4000-8000-000000000001';
  select * into v from public.reserve_agent_step_effect_v1(
    '44000000-0000-4000-8000-000000000001',
    'user-effect',
    '54000000-0000-4000-8000-000000000001',
    2,
    '64000000-0000-4000-8000-000000000002',
    v_key,
    v_receipt
  );
  if v.outcome <> 'conflict' then
    raise exception 'old attempt recovered after Step retry: %', row_to_json(v);
  end if;

  if has_function_privilege(
    'authenticated',
    'public.reserve_agent_step_effect_v1(uuid,text,uuid,integer,uuid,text,jsonb)',
    'execute'
  ) or has_function_privilege(
    'authenticated',
    'public.commit_agent_step_effect_v1(uuid,text,uuid,integer,uuid,text,jsonb,text,uuid,uuid,text)',
    'execute'
  ) then
    raise exception 'authenticated role can execute the internal effect journal';
  end if;
end $$;
