insert into public.projects(id)
values ('13000000-0000-4000-8000-000000000001');

insert into public.documents(
  id, project_id, user_id, status, current_version_id
) values (
  '23000000-0000-4000-8000-000000000001',
  '13000000-0000-4000-8000-000000000001',
  'user-review',
  'ready',
  '33000000-0000-4000-8000-000000000001'
);

insert into public.document_versions(
  id,
  document_id,
  filename,
  file_type,
  storage_path,
  version_number,
  size_bytes,
  deleted_at
) values (
  '33000000-0000-4000-8000-000000000001',
  '23000000-0000-4000-8000-000000000001',
  'memo.docx',
  'docx',
  'matter/memo.docx',
  2,
  4096,
  null
);

insert into public.agent_tasks(
  id,
  user_id,
  matter_id,
  goal,
  status,
  current_step,
  latest_checkpoint,
  execution_lease_owner,
  execution_lease_expires_at
) values
  (
    '43000000-0000-4000-8000-000000000001',
    'user-review',
    '13000000-0000-4000-8000-000000000001',
    'Revision fixture',
    'completed',
    '53000000-0000-4000-8000-000000000005',
    '{"step_receipts":[{"kind":"historical"}]}'::jsonb,
    '63000000-0000-4000-8000-000000000001',
    clock_timestamp() + interval '5 minutes'
  ),
  (
    '43000000-0000-4000-8000-000000000002',
    'user-review',
    '13000000-0000-4000-8000-000000000001',
    'Approval fixture',
    'completed',
    '53000000-0000-4000-8000-000000000010',
    '{}'::jsonb,
    null,
    null
  );

insert into public.agent_steps(
  id, task_id, position, title, status, attempt, result_summary, result_data
) values
  (
    '53000000-0000-4000-8000-000000000001',
    '43000000-0000-4000-8000-000000000001',
    0,
    'Read',
    'completed',
    1,
    'Read.',
    null
  ),
  (
    '53000000-0000-4000-8000-000000000002',
    '43000000-0000-4000-8000-000000000001',
    1,
    'Analyze',
    'completed',
    1,
    'Analyzed.',
    null
  ),
  (
    '53000000-0000-4000-8000-000000000003',
    '43000000-0000-4000-8000-000000000001',
    2,
    'Draft',
    'completed',
    2,
    'Drafted.',
    '{"effect_receipts":{"historical":{"status":"committed"}}}'::jsonb
  ),
  (
    '53000000-0000-4000-8000-000000000004',
    '43000000-0000-4000-8000-000000000001',
    3,
    'Opinion',
    'completed',
    1,
    'Written.',
    null
  ),
  (
    '53000000-0000-4000-8000-000000000005',
    '43000000-0000-4000-8000-000000000001',
    4,
    'Verify',
    'completed',
    1,
    'Verified.',
    null
  ),
  (
    '53000000-0000-4000-8000-000000000010',
    '43000000-0000-4000-8000-000000000002',
    0,
    'Verify approval',
    'completed',
    1,
    'Verified.',
    null
  );

insert into public.agent_artifact_links(
  task_id, artifact_type, artifact_id, purpose
) values
  (
    '43000000-0000-4000-8000-000000000001',
    'draft',
    '23000000-0000-4000-8000-000000000001',
    'Review memo'
  ),
  (
    '43000000-0000-4000-8000-000000000002',
    'draft',
    '23000000-0000-4000-8000-000000000001',
    'Review memo'
  );

insert into public.agent_task_review_decisions(
  id, task_id, status, note, created_at
) values
  (
    '73000000-0000-4000-8000-000000000001',
    '43000000-0000-4000-8000-000000000001',
    'review_required',
    'Initial review required.',
    '2026-08-07T08:00:00.000Z'
  ),
  (
    '73000000-0000-4000-8000-000000000002',
    '43000000-0000-4000-8000-000000000002',
    'review_required',
    'Initial review required.',
    '2026-08-07T08:00:00.000Z'
  );

do $$
declare
  v record;
  v_count integer;
  v_artifact_snapshot jsonb := jsonb_build_array(jsonb_build_object(
    'artifact_type', 'draft',
    'artifact_id', '23000000-0000-4000-8000-000000000001',
    'purpose', 'Review memo',
    'document_id', '23000000-0000-4000-8000-000000000001',
    'version_id', '33000000-0000-4000-8000-000000000001',
    'version_number', 2,
    'filename', 'memo.docx',
    'file_type', 'docx',
    'size_bytes', 4096,
    'sha256', 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  ));
  v_revision_checkpoint jsonb := jsonb_build_object(
    'step_receipts', jsonb_build_array(jsonb_build_object('kind', 'historical')),
    'step_id', '53000000-0000-4000-8000-000000000002',
    'iteration', 2,
    'summary', 'Revision requested: correct the analysis.',
    'created_at', '2026-08-07T09:00:00.000Z',
    'revision_request', jsonb_build_object(
      'kind', 'agent_task_revision_v1',
      'revision_id', '83000000-0000-4000-8000-000000000001',
      'review_decision_id', '73000000-0000-4000-8000-000000000003',
      'first_step_id', '53000000-0000-4000-8000-000000000002',
      'revision_start', 1,
      'attempt', 2,
      'requested_at', '2026-08-07T09:00:00.000Z'
    )
  );
begin
  select * into v from public.record_agent_task_review_decision_v1(
    '73000000-0000-4000-8000-000000000003',
    '43000000-0000-4000-8000-000000000001',
    'user-review',
    '73000000-0000-4000-8000-000000000001',
    'changes_requested',
    'Correct the governing-law analysis.',
    'reviewer@example.com',
    'Reviewer',
    '[]'::jsonb
  );
  if v.outcome <> 'lease_busy' then
    raise exception 'review ignored a live execution lease: %', row_to_json(v);
  end if;

  perform * from public.release_agent_task_execution_lease_v1(
    '43000000-0000-4000-8000-000000000001',
    'user-review',
    '63000000-0000-4000-8000-000000000001'
  );
  select * into v from public.record_agent_task_review_decision_v1(
    '73000000-0000-4000-8000-000000000003',
    '43000000-0000-4000-8000-000000000001',
    'user-review',
    '73000000-0000-4000-8000-000000000099',
    'changes_requested',
    'Correct the governing-law analysis.',
    'reviewer@example.com',
    'Reviewer',
    '[]'::jsonb
  );
  if v.outcome <> 'conflict' then
    raise exception 'stale review predecessor was accepted: %', row_to_json(v);
  end if;

  select * into v from public.record_agent_task_review_decision_v1(
    '73000000-0000-4000-8000-000000000003',
    '43000000-0000-4000-8000-000000000001',
    'user-review',
    '73000000-0000-4000-8000-000000000001',
    'changes_requested',
    'Correct the governing-law analysis.',
    'reviewer@example.com',
    'Reviewer',
    '[]'::jsonb
  );
  if v.outcome <> 'recorded' then
    raise exception 'valid change request failed: %', row_to_json(v);
  end if;
  select * into v from public.record_agent_task_review_decision_v1(
    '73000000-0000-4000-8000-000000000003',
    '43000000-0000-4000-8000-000000000001',
    'user-review',
    '73000000-0000-4000-8000-000000000001',
    'changes_requested',
    'Correct the governing-law analysis.',
    'reviewer@example.com',
    'Reviewer',
    '[]'::jsonb
  );
  select count(*) into v_count
  from public.agent_task_review_decisions
  where id = '73000000-0000-4000-8000-000000000003';
  if v.outcome <> 'recorded' or v_count <> 1 then
    raise exception 'review replay did not converge exactly once';
  end if;

  select * into v from public.record_agent_task_review_decision_v1(
    '73000000-0000-4000-8000-000000000004',
    '43000000-0000-4000-8000-000000000002',
    'user-review',
    '73000000-0000-4000-8000-000000000002',
    'approved',
    '',
    null,
    'Reviewer',
    jsonb_set(
      v_artifact_snapshot,
      '{0,version_id}',
      '"33000000-0000-4000-8000-000000000099"'::jsonb
    )
  );
  if v.outcome <> 'invalid_artifacts' then
    raise exception 'drifted approval Version was accepted: %', row_to_json(v);
  end if;
  select * into v from public.record_agent_task_review_decision_v1(
    '73000000-0000-4000-8000-000000000004',
    '43000000-0000-4000-8000-000000000002',
    'user-review',
    '73000000-0000-4000-8000-000000000002',
    'approved',
    '',
    null,
    'Reviewer',
    v_artifact_snapshot
  );
  if v.outcome <> 'recorded' then
    raise exception 'valid approval snapshot failed: %', row_to_json(v);
  end if;

  perform * from public.acquire_agent_task_execution_lease_v1(
    '43000000-0000-4000-8000-000000000001',
    'user-review',
    '63000000-0000-4000-8000-000000000002',
    300
  );
  select * into v from public.start_agent_task_revision_v1(
    '43000000-0000-4000-8000-000000000001',
    'user-review',
    '83000000-0000-4000-8000-000000000001',
    '73000000-0000-4000-8000-000000000003',
    '53000000-0000-4000-8000-000000000002',
    1,
    1,
    v_revision_checkpoint
  );
  if v.outcome <> 'lease_busy' then
    raise exception 'revision ignored a live execution lease: %', row_to_json(v);
  end if;
  perform * from public.release_agent_task_execution_lease_v1(
    '43000000-0000-4000-8000-000000000001',
    'user-review',
    '63000000-0000-4000-8000-000000000002'
  );

  select * into v from public.start_agent_task_revision_v1(
    '43000000-0000-4000-8000-000000000001',
    'user-review',
    '83000000-0000-4000-8000-000000000001',
    '73000000-0000-4000-8000-000000000003',
    '53000000-0000-4000-8000-000000000002',
    1,
    1,
    jsonb_set(
      v_revision_checkpoint,
      '{step_receipts}',
      '[{"kind":"replaced"}]'::jsonb
    )
  );
  if v.outcome <> 'invalid_input' then
    raise exception 'revision replaced durable Step receipts: %', row_to_json(v);
  end if;

  select * into v from public.start_agent_task_revision_v1(
    '43000000-0000-4000-8000-000000000001',
    'user-review',
    '83000000-0000-4000-8000-000000000001',
    '73000000-0000-4000-8000-000000000003',
    '53000000-0000-4000-8000-000000000002',
    1,
    1,
    jsonb_set(v_revision_checkpoint, '{revision_request,attempt}', '3'::jsonb)
  );
  if v.outcome <> 'invalid_input' then
    raise exception 'mismatched revision checkpoint was accepted: %', row_to_json(v);
  end if;
  if (
    select status
    from public.agent_steps
    where id = '53000000-0000-4000-8000-000000000002'
  ) <> 'completed' then
    raise exception 'rejected revision produced a partial Step reset';
  end if;

  select * into v from public.start_agent_task_revision_v1(
    '43000000-0000-4000-8000-000000000001',
    'user-review',
    '83000000-0000-4000-8000-000000000001',
    '73000000-0000-4000-8000-000000000003',
    '53000000-0000-4000-8000-000000000002',
    1,
    1,
    v_revision_checkpoint
  );
  if v.outcome <> 'revised' or v.task_status <> 'running' then
    raise exception 'valid revision failed: %', row_to_json(v);
  end if;
  if (
    select status = 'running'
      and attempt = 2
      and result_summary is null
      and result_data is null
    from public.agent_steps
    where id = '53000000-0000-4000-8000-000000000002'
  ) is not true then
    raise exception 'revision did not start the analysis exactly once';
  end if;
  if (
    select status = 'pending'
      and result_summary is null
      and result_data is not null
    from public.agent_steps
    where id = '53000000-0000-4000-8000-000000000003'
  ) is not true then
    raise exception 'revision did not preserve historical effect receipts';
  end if;
  if (
    select count(*)
    from public.agent_steps
    where task_id = '43000000-0000-4000-8000-000000000001'
      and position > 1
      and status = 'pending'
      and result_summary is null
  ) <> 3 then
    raise exception 'revision range was not reset atomically';
  end if;

  select * into v from public.start_agent_task_revision_v1(
    '43000000-0000-4000-8000-000000000001',
    'user-review',
    '83000000-0000-4000-8000-000000000001',
    '73000000-0000-4000-8000-000000000003',
    '53000000-0000-4000-8000-000000000002',
    1,
    1,
    v_revision_checkpoint
  );
  if v.outcome <> 'conflict' or (
    select attempt
    from public.agent_steps
    where id = '53000000-0000-4000-8000-000000000002'
  ) <> 2 then
    raise exception 'revision replay changed the first attempt';
  end if;

  select * into v from public.record_agent_task_review_decision_v1(
    '73000000-0000-4000-8000-000000000005',
    '43000000-0000-4000-8000-000000000001',
    'user-review',
    '73000000-0000-4000-8000-000000000003',
    'approved',
    '',
    null,
    'Reviewer',
    v_artifact_snapshot
  );
  if v.outcome <> 'task_not_completed' then
    raise exception 'review was recorded after revision activation: %', row_to_json(v);
  end if;

  if has_function_privilege(
    'authenticated',
    'public.record_agent_task_review_decision_v1(uuid,uuid,text,uuid,text,text,text,text,jsonb)',
    'execute'
  ) or has_function_privilege(
    'authenticated',
    'public.start_agent_task_revision_v1(uuid,text,uuid,uuid,uuid,integer,integer,jsonb)',
    'execute'
  ) then
    raise exception 'authenticated role can execute an internal review transition';
  end if;
end $$;
