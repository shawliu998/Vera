begin;

insert into public.projects(id, user_id, name)
values (
  'b1300000-0000-4000-8000-000000000001',
  'user-verifier-decision',
  'Structured verifier Decision fixture Matter'
);

insert into public.agent_tasks(
  id, user_id, matter_id, goal, status, current_step, deliverables,
  latest_checkpoint, execution_lease_owner, execution_lease_expires_at
) values (
  'b4300000-0000-4000-8000-000000000001',
  'user-verifier-decision',
  'b1300000-0000-4000-8000-000000000001',
  'Verify a fixed deliverable before the lawyer Decision.',
  'completed',
  'b5300000-0000-4000-8000-000000000001',
  '[]'::jsonb,
  '{}'::jsonb,
  null,
  null
);

insert into public.agent_steps(
  id, task_id, position, title, status, attempt, result_summary, result_data
) values (
  'b5300000-0000-4000-8000-000000000001',
  'b4300000-0000-4000-8000-000000000001',
  0,
  'Verify fixed deliverable',
  'completed',
  2,
  'Structured verification completed.',
  null
);

do $$
declare
  v_clean_receipt jsonb;
  v_review_receipt jsonb;
  v_clean_record jsonb;
  v_review_record jsonb;
  v_bad_record jsonb;
begin
  v_clean_receipt := jsonb_build_object(
    'outcome', 'postconditions_satisfied',
    'postconditions', jsonb_build_array(
      jsonb_build_object(
        'code', 'required_deliverables_current',
        'status', 'pass'
      ),
      jsonb_build_object('code', 'verifier_passed', 'status', 'pass')
    )
  );
  v_review_receipt := jsonb_build_object(
    'outcome', 'review_required',
    'postconditions', jsonb_build_array(
      jsonb_build_object(
        'code', 'required_deliverables_current',
        'status', 'pass'
      ),
      jsonb_build_object('code', 'verifier_passed', 'status', 'fail')
    )
  );
  v_clean_record := jsonb_build_object(
    'kind', 'agent_verification_record_v1',
    'task_id', 'b4300000-0000-4000-8000-000000000001',
    'step_id', 'b5300000-0000-4000-8000-000000000001',
    'step_attempt', 2,
    'result', jsonb_build_object(
      'kind', 'agent_verification_result_v1',
      'outcome', 'clean_pass',
      'dimensions', jsonb_build_object(
        'goal_coverage', 'pass',
        'source_support', 'pass',
        'artifact_integrity', 'pass',
        'workflow_completion', 'pass'
      ),
      'issues', '[]'::jsonb
    )
  );
  v_review_record := jsonb_build_object(
    'kind', 'agent_verification_record_v1',
    'task_id', 'b4300000-0000-4000-8000-000000000001',
    'step_id', 'b5300000-0000-4000-8000-000000000001',
    'step_attempt', 2,
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
        'origin', 'deterministic',
        'dimension', 'goal_coverage',
        'detail', 'The accepted view exceeded the bounded semantic projection.',
        'issue', jsonb_build_object(
          'code', 'verification_scope_exceeded',
          'deliverable_key', 'evidence-inventory',
          'accepted_view_characters', 120001,
          'projected_characters', 100000
        )
      ))
    )
  );

  update public.agent_tasks
  set latest_checkpoint = jsonb_build_object(
    'agent_verification_result', v_clean_record
  )
  where id = 'b4300000-0000-4000-8000-000000000001';
  if not public.agent_verifier_review_decision_ready_v1(
    'b4300000-0000-4000-8000-000000000001',
    'b5300000-0000-4000-8000-000000000001',
    2,
    v_clean_receipt
  ) then
    raise exception 'matching clean structured verification was rejected';
  end if;
  if public.agent_verifier_review_decision_ready_v1(
    'b4300000-0000-4000-8000-000000000001',
    'b5300000-0000-4000-8000-000000000001',
    2,
    v_review_receipt
  ) then
    raise exception 'clean result matched a review_required receipt';
  end if;

  update public.agent_tasks
  set latest_checkpoint = jsonb_build_object(
    'agent_verification_result', v_review_record
  )
  where id = 'b4300000-0000-4000-8000-000000000001';
  if not public.agent_verifier_review_decision_ready_v1(
    'b4300000-0000-4000-8000-000000000001',
    'b5300000-0000-4000-8000-000000000001',
    2,
    v_review_receipt
  ) then
    raise exception 'matching review_required structured verification was rejected';
  end if;

  v_bad_record := jsonb_set(
    v_review_record,
    '{result,issues,0,issue,unexpected}',
    'true'::jsonb
  );
  update public.agent_tasks
  set latest_checkpoint = jsonb_build_object(
    'agent_verification_result', v_bad_record
  )
  where id = 'b4300000-0000-4000-8000-000000000001';
  if public.agent_verifier_review_decision_ready_v1(
    'b4300000-0000-4000-8000-000000000001',
    'b5300000-0000-4000-8000-000000000001',
    2,
    v_review_receipt
  ) then
    raise exception 'deterministic issue with an extra fact was accepted';
  end if;

  v_bad_record := jsonb_set(
    v_review_record,
    '{result,issues,0,issue,accepted_view_characters}',
    to_jsonb('not-a-number'::text)
  );
  update public.agent_tasks
  set latest_checkpoint = jsonb_build_object(
    'agent_verification_result', v_bad_record
  )
  where id = 'b4300000-0000-4000-8000-000000000001';
  if public.agent_verifier_review_decision_ready_v1(
    'b4300000-0000-4000-8000-000000000001',
    'b5300000-0000-4000-8000-000000000001',
    2,
    v_review_receipt
  ) then
    raise exception 'non-numeric deterministic issue count was accepted';
  end if;

  update public.agent_tasks
  set latest_checkpoint = jsonb_build_object(
    'agent_verification_result',
    jsonb_set(v_review_record, '{step_attempt}', '1'::jsonb)
  )
  where id = 'b4300000-0000-4000-8000-000000000001';
  if public.agent_verifier_review_decision_ready_v1(
    'b4300000-0000-4000-8000-000000000001',
    'b5300000-0000-4000-8000-000000000001',
    2,
    v_review_receipt
  ) then
    raise exception 'stale verifier Step attempt was accepted';
  end if;

  update public.agent_tasks
  set latest_checkpoint = jsonb_build_object(
    'agent_verification_result', v_review_record
  )
  where id = 'b4300000-0000-4000-8000-000000000001';
  if public.agent_verifier_review_decision_ready_v1(
    'b4300000-0000-4000-8000-000000000001',
    'b5300000-0000-4000-8000-000000000001',
    2,
    jsonb_set(
      v_review_receipt,
      '{postconditions,1,status}',
      to_jsonb('pass'::text)
    )
  ) then
    raise exception 'review_required result matched a passing verifier receipt';
  end if;

  v_bad_record := jsonb_set(
    v_review_record,
    '{result,issues,0}',
    jsonb_build_object(
      'origin', 'semantic',
      'dimension', 'goal_coverage',
      'detail', 'A required point is absent.',
      'issue', jsonb_build_object(
        'code', 'semantic_goal_omission',
        'deliverable_key', 'memo',
        'detail', 'A required point is absent.'
      )
    )
  );
  update public.agent_tasks
  set latest_checkpoint = jsonb_build_object(
    'agent_verification_result', v_bad_record
  )
  where id = 'b4300000-0000-4000-8000-000000000001';
  if public.agent_verifier_review_decision_ready_v1(
    'b4300000-0000-4000-8000-000000000001',
    'b5300000-0000-4000-8000-000000000001',
    2,
    v_review_receipt
  ) then
    raise exception 'malformed semantic issue was accepted';
  end if;

  if has_function_privilege(
    'authenticated',
    'public.agent_verifier_review_decision_ready_v1(uuid,uuid,integer,jsonb)',
    'execute'
  ) or has_function_privilege(
    'authenticated',
    'public.agent_verifier_deterministic_issue_valid_v1(jsonb)',
    'execute'
  ) then
    raise exception 'authenticated can execute internal verifier helpers';
  end if;
end $$;

rollback;
