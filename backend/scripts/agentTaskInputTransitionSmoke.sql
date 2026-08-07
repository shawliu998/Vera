insert into public.projects(id)
values
  ('12000000-0000-4000-8000-000000000001'),
  ('12000000-0000-4000-8000-000000000002');

insert into public.documents(id, project_id, user_id, status, current_version_id)
values
  (
    '22000000-0000-4000-8000-000000000001',
    '12000000-0000-4000-8000-000000000001',
    'user-input',
    'ready',
    '32000000-0000-4000-8000-000000000001'
  ),
  (
    '22000000-0000-4000-8000-000000000002',
    '12000000-0000-4000-8000-000000000001',
    'user-input',
    'ready',
    '32000000-0000-4000-8000-000000000002'
  ),
  (
    '22000000-0000-4000-8000-000000000003',
    '12000000-0000-4000-8000-000000000002',
    'user-input',
    'ready',
    '32000000-0000-4000-8000-000000000003'
  );

insert into public.document_versions(
  id, document_id, filename, file_type, storage_path, deleted_at
)
values
  (
    '32000000-0000-4000-8000-000000000001',
    '22000000-0000-4000-8000-000000000001',
    'original.docx',
    'docx',
    'matter/original.docx',
    null
  ),
  (
    '32000000-0000-4000-8000-000000000002',
    '22000000-0000-4000-8000-000000000002',
    'supplement.pdf',
    'pdf',
    'matter/supplement.pdf',
    null
  ),
  (
    '32000000-0000-4000-8000-000000000003',
    '22000000-0000-4000-8000-000000000003',
    'other-matter.pdf',
    'pdf',
    'other/record.pdf',
    null
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
)
values
  (
    '42000000-0000-4000-8000-000000000001',
    'user-input',
    '12000000-0000-4000-8000-000000000001',
    'Supplemental document fixture',
    'waiting_input',
    '52000000-0000-4000-8000-000000000001',
    '62000000-0000-4000-8000-000000000001',
    clock_timestamp() + interval '5 minutes'
  ),
  (
    '42000000-0000-4000-8000-000000000002',
    'user-input',
    '12000000-0000-4000-8000-000000000001',
    'Supplemental text fixture',
    'waiting_input',
    '52000000-0000-4000-8000-000000000003',
    null,
    null
  );

insert into public.agent_steps(id, task_id, position, title, status, attempt)
values
  (
    '52000000-0000-4000-8000-000000000001',
    '42000000-0000-4000-8000-000000000001',
    0,
    'Read supplemental source',
    'blocked',
    1
  ),
  (
    '52000000-0000-4000-8000-000000000002',
    '42000000-0000-4000-8000-000000000001',
    1,
    'Verify result',
    'pending',
    0
  ),
  (
    '52000000-0000-4000-8000-000000000003',
    '42000000-0000-4000-8000-000000000002',
    0,
    'Verify text response',
    'blocked',
    2
  );

do $$
declare
  v record;
  v_valid_context jsonb := jsonb_build_object(
    'kind', 'matter_context_v1',
    'matter_id', '12000000-0000-4000-8000-000000000001',
    'sources', jsonb_build_array(
      jsonb_build_object(
        'document_id', '22000000-0000-4000-8000-000000000001',
        'version_id', '32000000-0000-4000-8000-000000000001',
        'filename', 'original.docx',
        'file_type', 'docx',
        'role', 'source'
      ),
      jsonb_build_object(
        'document_id', '22000000-0000-4000-8000-000000000002',
        'version_id', '32000000-0000-4000-8000-000000000002',
        'filename', 'supplement.pdf',
        'file_type', 'pdf',
        'role', 'source'
      )
    ),
    'workflow', null,
    'compiled_at', '2026-08-07T08:00:00.000Z'
  );
  v_checkpoint jsonb;
begin
  v_checkpoint := jsonb_build_object(
    'fixed_matter_context', v_valid_context,
    'user_input', jsonb_build_object(
      'submission_id', 'submission-valid',
      'step_id', '52000000-0000-4000-8000-000000000001',
      'attempt', 2,
      'submitted_at', '2026-08-07T08:00:00.000Z',
      'document_ids', jsonb_build_array(
        '22000000-0000-4000-8000-000000000002'
      )
    )
  );

  select * into v from public.submit_agent_task_input_v1(
    '42000000-0000-4000-8000-000000000001',
    'user-input',
    '52000000-0000-4000-8000-000000000001',
    1,
    array['22000000-0000-4000-8000-000000000002'::uuid],
    v_checkpoint
  );
  if v.outcome <> 'lease_busy' then
    raise exception 'input ignored the live prior lease: %', row_to_json(v);
  end if;

  perform * from public.release_agent_task_execution_lease_v1(
    '42000000-0000-4000-8000-000000000001',
    'user-input',
    '62000000-0000-4000-8000-000000000001'
  );
  select * into v from public.submit_agent_task_input_v1(
    '42000000-0000-4000-8000-000000000001',
    'user-input',
    '52000000-0000-4000-8000-000000000001',
    1,
    array['22000000-0000-4000-8000-000000000003'::uuid],
    jsonb_set(
      v_checkpoint,
      '{user_input,document_ids}',
      '["22000000-0000-4000-8000-000000000003"]'::jsonb
    )
  );
  if v.outcome <> 'source_invalid' then
    raise exception 'cross-Matter input source was accepted: %', row_to_json(v);
  end if;

  select * into v from public.submit_agent_task_input_v1(
    '42000000-0000-4000-8000-000000000001',
    'user-input',
    '52000000-0000-4000-8000-000000000001',
    1,
    array['22000000-0000-4000-8000-000000000002'::uuid],
    jsonb_set(
      v_checkpoint,
      '{fixed_matter_context,sources,1,version_id}',
      '"32000000-0000-4000-8000-000000000099"'::jsonb
    )
  );
  if v.outcome <> 'context_invalid' then
    raise exception 'drifted fixed Version was accepted: %', row_to_json(v);
  end if;
  if (
    select count(*)
    from public.agent_artifact_links
    where task_id = '42000000-0000-4000-8000-000000000001'
  ) <> 0 or (
    select status
    from public.agent_steps
    where id = '52000000-0000-4000-8000-000000000001'
  ) <> 'blocked' then
    raise exception 'rejected input produced a partial write';
  end if;

  select * into v from public.submit_agent_task_input_v1(
    '42000000-0000-4000-8000-000000000001',
    'user-input',
    '52000000-0000-4000-8000-000000000001',
    1,
    array['22000000-0000-4000-8000-000000000002'::uuid],
    jsonb_set(
      v_checkpoint,
      '{user_input,document_ids}',
      '[]'::jsonb
    )
  );
  if v.outcome <> 'invalid_input' then
    raise exception 'mismatched checkpoint documents were accepted: %', row_to_json(v);
  end if;

  select * into v from public.submit_agent_task_input_v1(
    '42000000-0000-4000-8000-000000000001',
    'user-input',
    '52000000-0000-4000-8000-000000000001',
    1,
    array['22000000-0000-4000-8000-000000000002'::uuid],
    jsonb_set(v_checkpoint, '{user_input,attempt}', '3'::jsonb)
  );
  if v.outcome <> 'invalid_input' then
    raise exception 'mismatched checkpoint attempt was accepted: %', row_to_json(v);
  end if;

  select * into v from public.submit_agent_task_input_v1(
    '42000000-0000-4000-8000-000000000001',
    'user-input',
    '52000000-0000-4000-8000-000000000001',
    1,
    array[]::uuid[],
    (v_checkpoint #- '{user_input,document_ids}')
  );
  if v.outcome <> 'invalid_input' then
    raise exception 'missing checkpoint document set was accepted: %', row_to_json(v);
  end if;

  select * into v from public.submit_agent_task_input_v1(
    '42000000-0000-4000-8000-000000000001',
    'user-input',
    '52000000-0000-4000-8000-000000000001',
    1,
    array['22000000-0000-4000-8000-000000000002'::uuid],
    v_checkpoint
  );
  if v.outcome <> 'activated' or v.task_status <> 'running' then
    raise exception 'valid supplemental input failed: %', row_to_json(v);
  end if;
  if (
    select count(*)
    from public.agent_artifact_links
    where task_id = '42000000-0000-4000-8000-000000000001'
      and artifact_id = '22000000-0000-4000-8000-000000000002'
      and purpose = 'Source document'
  ) <> 1 then
    raise exception 'supplemental source link was not committed exactly once';
  end if;

  select * into v from public.submit_agent_task_input_v1(
    '42000000-0000-4000-8000-000000000001',
    'user-input',
    '52000000-0000-4000-8000-000000000001',
    1,
    array['22000000-0000-4000-8000-000000000002'::uuid],
    v_checkpoint
  );
  if v.outcome <> 'conflict' then
    raise exception 'input replay did not converge to conflict: %', row_to_json(v);
  end if;

  select * into v from public.submit_agent_task_input_v1(
    '42000000-0000-4000-8000-000000000002',
    'user-input',
    '52000000-0000-4000-8000-000000000003',
    2,
    array[]::uuid[],
    jsonb_build_object(
      'fixed_matter_context', jsonb_set(
        v_valid_context,
        '{sources}',
        (v_valid_context -> 'sources') -> 0
      ),
      'user_input', jsonb_build_object(
        'submission_id', 'submission-text',
        'step_id', '52000000-0000-4000-8000-000000000003',
        'attempt', 3,
        'submitted_at', '2026-08-07T08:00:00.000Z',
        'message', 'Confirmed.',
        'document_ids', jsonb_build_array()
      )
    )
  );
  if v.outcome <> 'context_invalid' then
    raise exception 'malformed text-only context was accepted: %', row_to_json(v);
  end if;

  select * into v from public.submit_agent_task_input_v1(
    '42000000-0000-4000-8000-000000000002',
    'user-input',
    '52000000-0000-4000-8000-000000000003',
    2,
    array[]::uuid[],
    jsonb_build_object(
      'fixed_matter_context', jsonb_set(
        v_valid_context,
        '{sources}',
        jsonb_build_array((v_valid_context -> 'sources') -> 0)
      ),
      'user_input', jsonb_build_object(
        'submission_id', 'submission-text',
        'step_id', '52000000-0000-4000-8000-000000000003',
        'attempt', 3,
        'submitted_at', '2026-08-07T08:00:00.000Z',
        'message', 'Confirmed.',
        'document_ids', jsonb_build_array()
      )
    )
  );
  if v.outcome <> 'activated' or v.task_status <> 'verifying' then
    raise exception 'text-only input failed: %', row_to_json(v);
  end if;
  if has_function_privilege(
    'authenticated',
    'public.submit_agent_task_input_v1(uuid,text,uuid,integer,uuid[],jsonb)',
    'execute'
  ) then
    raise exception 'authenticated role can execute the internal input transition';
  end if;
end $$;
