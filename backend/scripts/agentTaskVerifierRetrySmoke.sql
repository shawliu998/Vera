begin;

insert into public.projects(id, user_id, name)
values (
  'c1300000-0000-4000-8000-000000000001',
  'user-verifier-retry',
  'Multi-Artifact Verifier retry fixture Matter'
);

insert into public.documents(id, project_id, user_id, status)
values
  (
    'c2300000-0000-4000-8000-000000000001',
    'c1300000-0000-4000-8000-000000000001',
    'user-verifier-retry',
    'ready'
  ),
  (
    'c2300000-0000-4000-8000-000000000002',
    'c1300000-0000-4000-8000-000000000001',
    'user-verifier-retry',
    'ready'
  );

insert into public.document_versions(
  id, document_id, storage_path, source, version_number, filename,
  file_type, size_bytes
) values
  (
    'c3300000-0000-4000-8000-000000000001',
    'c2300000-0000-4000-8000-000000000001',
    'retry/opinion-v1.docx',
    'generated',
    1,
    'opinion.docx',
    'docx',
    1024
  ),
  (
    'c3300000-0000-4000-8000-000000000002',
    'c2300000-0000-4000-8000-000000000002',
    'retry/outline-v1.docx',
    'generated',
    1,
    'outline.docx',
    'docx',
    1024
  );

update public.documents
set current_version_id = case id
  when 'c2300000-0000-4000-8000-000000000001'::uuid
    then 'c3300000-0000-4000-8000-000000000001'::uuid
  else 'c3300000-0000-4000-8000-000000000002'::uuid
end
where id in (
  'c2300000-0000-4000-8000-000000000001'::uuid,
  'c2300000-0000-4000-8000-000000000002'::uuid
);

insert into public.agent_tasks(
  id, user_id, matter_id, goal, status, current_step, deliverables,
  latest_checkpoint, execution_lease_owner, execution_lease_expires_at
) values (
  'c4300000-0000-4000-8000-000000000001',
  'user-verifier-retry',
  'c1300000-0000-4000-8000-000000000001',
  'Re-run only the final verifier, then repair one fixed draft if proven.',
  'completed',
  null,
  '[
    {"key":"opinion","title":"Opinion","required":true,"artifact_type":"draft","purpose":"Opinion"},
    {"key":"outline","title":"Outline","required":true,"artifact_type":"draft","purpose":"Outline"}
  ]'::jsonb,
  '{}'::jsonb,
  null,
  null
);

insert into public.agent_steps(
  id, task_id, position, title, status, attempt, result_summary, result_data
) values
  (
    'c5300000-0000-4000-8000-000000000001',
    'c4300000-0000-4000-8000-000000000001',
    0,
    'Create fixed drafts',
    'completed',
    1,
    'Created.',
    null
  ),
  (
    'c5300000-0000-4000-8000-000000000002',
    'c4300000-0000-4000-8000-000000000001',
    1,
    'Verify fixed drafts',
    'completed',
    1,
    'Review required.',
    null
  );

insert into public.agent_artifact_links(
  task_id, artifact_type, artifact_id, purpose
) values
  (
    'c4300000-0000-4000-8000-000000000001',
    'draft',
    'c2300000-0000-4000-8000-000000000001',
    'Opinion'
  ),
  (
    'c4300000-0000-4000-8000-000000000001',
    'draft',
    'c2300000-0000-4000-8000-000000000002',
    'Outline'
  );

do $$
declare
  v_receipt jsonb;
  v_record jsonb;
  v_checkpoint jsonb;
  v record;
  v_task public.agent_tasks%rowtype;
  v_verifier public.agent_steps%rowtype;
begin
  v_receipt := jsonb_build_object(
    'kind', 'agent_step_receipt_v1',
    'contract_version', 'agent_step_contract_v1',
    'position', 1,
    'attempt', 1,
    'capability', 'verify',
    'operation', 'verify',
    'outcome', 'review_required',
    'summary', 'One exact draft has a semantic omission.',
    'source_version_ids', '[]'::jsonb,
    'artifact_ids', jsonb_build_array(
      'c2300000-0000-4000-8000-000000000001',
      'c2300000-0000-4000-8000-000000000002'
    ),
    'verified_artifacts', jsonb_build_array(
      jsonb_build_object(
        'kind', 'agent_verified_draft_artifact_v1',
        'document_id', 'c2300000-0000-4000-8000-000000000001',
        'version_id', 'c3300000-0000-4000-8000-000000000001',
        'accepted_view_sha256', 'sha256:' || repeat('1', 64)
      )
    ),
    'postconditions', jsonb_build_array(
      jsonb_build_object(
        'code', 'required_deliverables_current',
        'status', 'pass'
      ),
      jsonb_build_object('code', 'verifier_passed', 'status', 'fail')
    )
  );
  v_record := jsonb_build_object(
    'kind', 'agent_verification_record_v1',
    'task_id', 'c4300000-0000-4000-8000-000000000001',
    'step_id', 'c5300000-0000-4000-8000-000000000002',
    'step_attempt', 1,
    'result', jsonb_build_object(
      'kind', 'agent_verification_result_v1',
      'outcome', 'review_required',
      'dimensions', jsonb_build_object(
        'goal_coverage', 'gap',
        'source_support', 'pass',
        'artifact_integrity', 'pass',
        'workflow_completion', 'pass'
      ),
      'issues', jsonb_build_array(jsonb_build_object(
        'origin', 'semantic',
        'dimension', 'goal_coverage',
        'detail', 'The opinion omits one fixed objective.',
        'issue', jsonb_build_object(
          'code', 'semantic_goal_omission',
          'deliverable_key', 'opinion',
          'goal_excerpt', 'Prepare the fixed opinion.',
          'detail', 'The opinion omits one fixed objective.'
        )
      ))
    )
  );
  v_checkpoint := jsonb_build_object(
    'schema_version', 'agent_task_checkpoint_v1',
    'contract', jsonb_build_object(
      'step_contracts', jsonb_build_object(
        'steps', jsonb_build_array(
          jsonb_build_object('position', 0, 'capability', 'create_draft'),
          jsonb_build_object('position', 1, 'capability', 'verify')
        )
      )
    ),
    'step_receipts', jsonb_build_array(
      jsonb_build_object(
        'kind', 'agent_step_receipt_v1',
        'position', 0,
        'attempt', 1,
        'capability', 'create_draft'
      ),
      v_receipt
    ),
    'agent_verification_result', v_record,
    'agent_verification_repair', jsonb_build_object(
      'kind', 'stale-repair-must-not-survive'
    )
  );
  update public.agent_tasks
  set latest_checkpoint = v_checkpoint
  where id = 'c4300000-0000-4000-8000-000000000001';

  update public.agent_tasks
  set latest_checkpoint = jsonb_set(
    latest_checkpoint,
    '{agent_verification_result}',
    'null'::jsonb
  )
  where id = 'c4300000-0000-4000-8000-000000000001';
  select * into v
  from public.start_agent_task_verifier_retry_v2(
    'c4300000-0000-4000-8000-000000000001',
    'user-verifier-retry',
    'agent-task-verifier-retry:fixture:2'
  );
  if v.outcome <> 'verification_result_invalid' then
    raise exception 'malformed present structured verification result was accepted';
  end if;

  update public.agent_tasks
  set latest_checkpoint = jsonb_set(
    latest_checkpoint,
    '{agent_verification_result}',
    v_record
  )
  where id = 'c4300000-0000-4000-8000-000000000001';
  update public.agent_tasks
  set latest_checkpoint = jsonb_set(
    latest_checkpoint,
    '{step_receipts,1,artifact_ids,1}',
    to_jsonb('c2300000-0000-4000-8000-000000000099'::text)
  )
  where id = 'c4300000-0000-4000-8000-000000000001';
  select * into v
  from public.start_agent_task_verifier_retry_v2(
    'c4300000-0000-4000-8000-000000000001',
    'user-verifier-retry',
    'agent-task-verifier-retry:fixture:2'
  );
  if v.outcome <> 'artifacts_invalid' then
    raise exception 'unowned receipt Artifact was accepted';
  end if;

  update public.agent_tasks
  set latest_checkpoint = jsonb_set(
    v_checkpoint,
    '{step_receipts,1,verified_artifacts,0,unexpected}',
    'true'::jsonb
  )
  where id = 'c4300000-0000-4000-8000-000000000001';
  select * into v
  from public.start_agent_task_verifier_retry_v2(
    'c4300000-0000-4000-8000-000000000001',
    'user-verifier-retry',
    'agent-task-verifier-retry:fixture:2'
  );
  if v.outcome <> 'artifacts_invalid' then
    raise exception 'malformed partial verified identity was accepted';
  end if;

  update public.agent_tasks
  set latest_checkpoint = v_checkpoint
  where id = 'c4300000-0000-4000-8000-000000000001';

  update public.agent_steps
  set result_data = jsonb_build_object(
    'effect_receipts',
    jsonb_build_object(
      'agent-step:c5300000-0000-4000-8000-000000000002:attempt:1:generate_docx',
      jsonb_build_object(
        'kind', 'agent_step_effect_v1',
        'effect_key',
          'agent-step:c5300000-0000-4000-8000-000000000002:attempt:1:generate_docx',
        'step_id', 'c5300000-0000-4000-8000-000000000002',
        'attempt', 1,
        'tool_name', 'generate_docx',
        'input_fingerprint', repeat('a', 64),
        'status', 'committed',
        'target', jsonb_build_object(
          'document_id', 'c2300000-0000-4000-8000-000000000001',
          'version_id', 'c3300000-0000-4000-8000-000000000001'
        ),
        'effect', jsonb_build_object(
          'document_id', 'c2300000-0000-4000-8000-000000000001',
          'version_id', 'c3300000-0000-4000-8000-000000000001',
          'artifact_type', 'draft'
        ),
        'created_at', '2026-08-08T00:00:00.000Z',
        'committed_at', '2026-08-08T00:00:01.000Z'
      )
    )
  )
  where id = 'c5300000-0000-4000-8000-000000000002';

  select * into v
  from public.start_agent_task_verifier_retry_v2(
    'c4300000-0000-4000-8000-000000000001',
    'user-verifier-retry',
    'agent-task-verifier-retry:fixture:2'
  );
  if v.outcome <> 'started'
    or v.task_status <> 'verifying'
    or v.current_step <> 'c5300000-0000-4000-8000-000000000002'::uuid then
    raise exception 'valid multi-Artifact Verifier retry failed: %', row_to_json(v);
  end if;

  select * into v_task
  from public.agent_tasks
  where id = 'c4300000-0000-4000-8000-000000000001';
  select * into v_verifier
  from public.agent_steps
  where id = 'c5300000-0000-4000-8000-000000000002';
  if v_task.status <> 'verifying'
    or v_task.current_step <> v_verifier.id
    or v_verifier.status <> 'running'
    or v_verifier.attempt <> 2
    or v_verifier.repair_attempt <> 0
    or v_task.latest_checkpoint ? 'agent_verification_result'
    or v_task.latest_checkpoint ? 'agent_verification_repair'
    or jsonb_array_length(v_task.latest_checkpoint -> 'step_receipts') <> 1
    or v_task.latest_checkpoint -> 'verifier_retry' ->> 'attempt' <> '2'
    or v_task.latest_checkpoint -> 'verifier_retry' ->> 'source'
      <> 'structured_current'
    or v_verifier.result_data -> 'effect_receipts'
      -> 'agent-step:c5300000-0000-4000-8000-000000000002:attempt:1:generate_docx'
      -> 'effect' ->> 'version_id'
      <> 'c3300000-0000-4000-8000-000000000001' then
    raise exception 'Verifier retry transition left torn state';
  end if;

  select * into v
  from public.start_agent_task_verifier_retry_v2(
    'c4300000-0000-4000-8000-000000000001',
    'user-verifier-retry',
    'agent-task-verifier-retry:fixture:2'
  );
  if v.outcome <> 'already_started' then
    raise exception 'Verifier retry replay was not idempotent';
  end if;
  select * into v
  from public.start_agent_task_verifier_retry_v2(
    'c4300000-0000-4000-8000-000000000001',
    'user-verifier-retry',
    'agent-task-verifier-retry:fixture:3'
  );
  if v.outcome <> 'conflict' then
    raise exception 'a second concurrent Verifier retry was accepted';
  end if;

  -- Historical Tasks have no structured record. They may restart only the
  -- Verifier from an exact legacy review-gap receipt; the old summary never
  -- authorizes an Artifact mutation.
  v_receipt := jsonb_set(v_receipt, '{attempt}', '2'::jsonb);
  v_checkpoint := jsonb_set(
    v_checkpoint - array[
      'agent_verification_result',
      'agent_verification_repair',
      'verifier_retry'
    ],
    '{step_receipts,1}',
    v_receipt
  );
  update public.agent_steps
  set status = 'completed', attempt = 2, result_summary = 'Legacy review gap.'
  where id = 'c5300000-0000-4000-8000-000000000002';
  update public.agent_tasks
  set
    status = 'completed',
    current_step = null,
    latest_checkpoint = v_checkpoint
  where id = 'c4300000-0000-4000-8000-000000000001';
  select * into v
  from public.start_agent_task_verifier_retry_v2(
    'c4300000-0000-4000-8000-000000000001',
    'user-verifier-retry',
    'agent-task-verifier-retry:fixture:3'
  );
  select * into v_task
  from public.agent_tasks
  where id = 'c4300000-0000-4000-8000-000000000001';
  if v.outcome <> 'started'
    or v_task.latest_checkpoint -> 'verifier_retry' ->> 'source'
      <> 'legacy_unstructured_review_gap'
    or v_task.latest_checkpoint -> 'verifier_retry' ->> 'attempt' <> '3' then
    raise exception 'exact legacy review gap could not restart only the Verifier';
  end if;

  if has_function_privilege(
    'authenticated',
    'public.start_agent_task_verifier_retry_v2(uuid,text,text)',
    'execute'
  ) then
    raise exception 'authenticated can execute the internal Verifier retry RPC';
  end if;
end $$;

rollback;
