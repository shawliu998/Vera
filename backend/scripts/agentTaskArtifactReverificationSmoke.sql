begin;

insert into public.projects(id, user_id, name)
values (
  '16000000-0000-4000-8000-000000000001',
  'user-artifact-reverify',
  'Artifact re-verification fixture Matter'
);

insert into public.documents(id, project_id, user_id, status)
values (
  '26000000-0000-4000-8000-000000000001',
  '16000000-0000-4000-8000-000000000001',
  'user-artifact-reverify',
  'ready'
);

insert into public.document_versions(
  id, document_id, filename, file_type, storage_path,
  version_number, size_bytes, deleted_at
) values
  (
    '36000000-0000-4000-8000-000000000001',
    '26000000-0000-4000-8000-000000000001',
    'memo-v1.docx', 'docx', 'fixture/memo-v1.docx', 1, 1024, null
  ),
  (
    '36000000-0000-4000-8000-000000000002',
    '26000000-0000-4000-8000-000000000001',
    'memo-v2.docx', 'docx', 'fixture/memo-v2.docx', 2, 2048, null
  );

update public.documents
set current_version_id = '36000000-0000-4000-8000-000000000002'
where id = '26000000-0000-4000-8000-000000000001';

insert into public.agent_tasks(
  id, user_id, matter_id, goal, status, current_step, latest_checkpoint
) values (
  '46000000-0000-4000-8000-000000000001',
  'user-artifact-reverify',
  '16000000-0000-4000-8000-000000000001',
  'Re-verify one externally edited Task draft',
  'completed',
  null,
  jsonb_build_object(
    'schema_version', 'agent_task_checkpoint_v1',
    'contract', jsonb_build_object(
      'fixture', true,
      'step_contracts', jsonb_build_object(
        'steps', jsonb_build_array(
          jsonb_build_object('position', 0, 'capability', 'read_sources'),
          jsonb_build_object('position', 1, 'capability', 'create_draft'),
          jsonb_build_object('position', 2, 'capability', 'verify')
        )
      )
    ),
    'step_receipts', jsonb_build_array(
      jsonb_build_object(
        'kind', 'agent_step_receipt_v1',
        'position', 1,
        'attempt', 1
      ),
      jsonb_build_object(
        'kind', 'agent_step_receipt_v1',
        'position', 2,
        'attempt', 1
      )
    )
  )
);

insert into public.agent_steps(
  id, task_id, position, capability, title, status, attempt,
  repair_attempt, result_summary, result_data
) values
  (
    '56000000-0000-4000-8000-000000000001',
    '46000000-0000-4000-8000-000000000001',
    0, 'read_sources', 'Read', 'completed', 1, 0, 'Read.',
    null
  ),
  (
    '56000000-0000-4000-8000-000000000002',
    '46000000-0000-4000-8000-000000000001',
    1, 'create_draft', 'Draft', 'completed', 1, 0, 'Drafted.',
    '{"effect_receipts":{"preserved":{"status":"committed"}}}'::jsonb
  ),
  (
    '56000000-0000-4000-8000-000000000003',
    '46000000-0000-4000-8000-000000000001',
    2, 'verify', 'Verify', 'completed', 1, 1, 'Verified V1.',
    '{"kind":"structured_verifier_v1","deliverable_versions":[{"version_id":"36000000-0000-4000-8000-000000000001"}]}'::jsonb
  );

insert into public.agent_artifact_links(
  task_id, artifact_type, artifact_id, purpose
) values (
  '46000000-0000-4000-8000-000000000001',
  'draft',
  '26000000-0000-4000-8000-000000000001',
  'Review memo'
);

insert into public.agent_task_review_decisions(
  id, task_id, status, note, artifact_snapshot, created_at
) values
  (
    '76000000-0000-4000-8000-000000000001',
    '46000000-0000-4000-8000-000000000001',
    'review_required',
    'Review V1.',
    '[]'::jsonb,
    '2026-08-07T08:00:00.000Z'
  ),
  (
    '76000000-0000-4000-8000-000000000002',
    '46000000-0000-4000-8000-000000000001',
    'approved',
    'Approved V1.',
    '[]'::jsonb,
    '2026-08-07T09:00:00.000Z'
  );

do $$
declare
  v record;
begin
  select * into v
  from public.start_agent_task_artifact_reverification_v1(
    '46000000-0000-4000-8000-000000000001',
    'user-artifact-reverify',
    '26000000-0000-4000-8000-000000000001',
    '36000000-0000-4000-8000-000000000001',
    '36000000-0000-4000-8000-000000000002',
    'artifact-edit:36000000-0000-4000-8000-000000000002'
  );
  if v.outcome <> 'started'
    or v.task_status <> 'verifying'
    or v.current_step <> '56000000-0000-4000-8000-000000000003' then
    raise exception 'Artifact re-verification did not start: %', row_to_json(v);
  end if;

  if not exists (
    select 1
    from public.agent_steps
    where id = '56000000-0000-4000-8000-000000000003'
      and status = 'running'
      and attempt = 2
      and repair_attempt = 0
      and result_summary is null
      and result_data is null
  ) then
    raise exception 'Verifier state was not reset for the new Version';
  end if;

  if not exists (
    select 1
    from public.agent_steps
    where id = '56000000-0000-4000-8000-000000000002'
      and status = 'completed'
      and attempt = 1
      and result_data =
        '{"effect_receipts":{"preserved":{"status":"committed"}}}'::jsonb
  ) then
    raise exception 'Completed draft effects were not preserved';
  end if;

  if not exists (
    select 1
    from public.agent_tasks
    where id = '46000000-0000-4000-8000-000000000001'
      and status = 'verifying'
      and current_step = '56000000-0000-4000-8000-000000000003'
      and latest_checkpoint -> 'artifact_reverification' ->> 'version_id'
        = '36000000-0000-4000-8000-000000000002'
      and jsonb_array_length(latest_checkpoint -> 'step_receipts') = 1
      and latest_checkpoint -> 'step_receipts' -> 0 ->> 'position' = '1'
  ) then
    raise exception 'Task checkpoint did not invalidate only the verifier receipt';
  end if;

  if (
    select count(*)
    from public.agent_task_review_decisions
    where task_id = '46000000-0000-4000-8000-000000000001'
  ) <> 2 then
    raise exception 'Lawyer review history was not preserved';
  end if;

  if not exists (
    select 1
    from public.documents
    where id = '26000000-0000-4000-8000-000000000001'
      and current_version_id = '36000000-0000-4000-8000-000000000002'
  ) then
    raise exception 'The edited current Version changed during re-verification start';
  end if;

  select * into v
  from public.start_agent_task_artifact_reverification_v1(
    '46000000-0000-4000-8000-000000000001',
    'user-artifact-reverify',
    '26000000-0000-4000-8000-000000000001',
    '36000000-0000-4000-8000-000000000001',
    '36000000-0000-4000-8000-000000000002',
    'artifact-edit:36000000-0000-4000-8000-000000000002'
  );
  if v.outcome <> 'already_started' then
    raise exception 'Artifact re-verification replay was not idempotent: %', row_to_json(v);
  end if;
  if not exists (
    select 1 from public.agent_steps
    where id = '56000000-0000-4000-8000-000000000003'
      and attempt = 2
  ) then
    raise exception 'Artifact re-verification replay created another attempt';
  end if;

  update public.documents
  set current_version_id = '36000000-0000-4000-8000-000000000001'
  where id = '26000000-0000-4000-8000-000000000001';
  select * into v
  from public.start_agent_task_artifact_reverification_v1(
    '46000000-0000-4000-8000-000000000001',
    'user-artifact-reverify',
    '26000000-0000-4000-8000-000000000001',
    '36000000-0000-4000-8000-000000000001',
    '36000000-0000-4000-8000-000000000002',
    'artifact-edit:36000000-0000-4000-8000-000000000002'
  );
  if v.outcome <> 'version_conflict' then
    raise exception 'Stale idempotent event ignored current Version drift: %', row_to_json(v);
  end if;
  update public.documents
  set current_version_id = '36000000-0000-4000-8000-000000000002'
  where id = '26000000-0000-4000-8000-000000000001';

  select * into v
  from public.start_agent_task_artifact_reverification_v1(
    '46000000-0000-4000-8000-000000000001',
    'user-artifact-reverify',
    '26000000-0000-4000-8000-000000000001',
    '36000000-0000-4000-8000-000000000001',
    '36000000-0000-4000-8000-000000000002',
    'artifact-edit:different'
  );
  if v.outcome <> 'conflict' then
    raise exception 'Concurrent Artifact re-verification was not rejected: %', row_to_json(v);
  end if;
end;
$$;

set role authenticated;
do $$
begin
  begin
    perform * from public.start_agent_task_artifact_reverification_v1(
      '46000000-0000-4000-8000-000000000001',
      'user-artifact-reverify',
      '26000000-0000-4000-8000-000000000001',
      '36000000-0000-4000-8000-000000000001',
      '36000000-0000-4000-8000-000000000002',
      'artifact-edit:unauthorized'
    );
    raise exception 'authenticated unexpectedly executed Artifact re-verification RPC';
  exception
    when insufficient_privilege then null;
  end;
end;
$$;
reset role;

rollback;
