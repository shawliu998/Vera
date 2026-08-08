begin;

do $$
declare
  v_issue jsonb;
  v_scope_issue jsonb;
begin
  v_issue := jsonb_build_object(
    'code', 'artifact_incomplete_ending',
    'deliverable_key', 'evidence-objection-opinion',
    'document_id', 'c1000000-0000-4000-8000-000000000001',
    'version_id', 'c2000000-0000-4000-8000-000000000001',
    'accepted_view_sha256', 'sha256:' || repeat('a', 64),
    'ending_excerpt',
      '本意见书依据固定证据源文件编制，凡源文件未予确立的真实性、可采性、关联性及款项分配等事项，均明确标注为'
  );
  if not public.agent_verifier_deterministic_issue_valid_v1(v_issue) then
    raise exception 'exact abrupt-ending issue was rejected';
  end if;
  if public.agent_verifier_deterministic_issue_valid_v1(
    v_issue || jsonb_build_object('unexpected', true)
  ) then
    raise exception 'abrupt-ending issue with an extra field was accepted';
  end if;
  if public.agent_verifier_deterministic_issue_valid_v1(
    jsonb_set(v_issue, '{ending_excerpt}', to_jsonb('结论如下'::text))
  ) then
    raise exception 'short heading was accepted as an abrupt ending';
  end if;
  if public.agent_verifier_deterministic_issue_valid_v1(
    jsonb_set(
      v_issue,
      '{ending_excerpt}',
      to_jsonb('本意见书已经完成全部固定事项的审查，并将所有未知内容保留为待律师判断的完整陈述'::text)
    )
  ) then
    raise exception 'non-continuation prose was accepted as an abrupt ending';
  end if;

  v_scope_issue := jsonb_build_object(
    'code', 'verification_scope_exceeded',
    'deliverable_key', 'evidence-inventory',
    'accepted_view_characters', 120001,
    'projected_characters', 100000
  );
  if not public.agent_verifier_deterministic_issue_valid_v1(v_scope_issue) then
    raise exception 'legacy deterministic issue validation regressed';
  end if;
end $$;

insert into public.projects(id, user_id, name)
values (
  'c3000000-0000-4000-8000-000000000001',
  'user-incomplete-ending',
  'Incomplete ending verifier fixture Matter'
);

insert into public.agent_tasks(
  id, user_id, matter_id, goal, status, current_step, deliverables,
  latest_checkpoint, execution_lease_owner, execution_lease_expires_at
) values (
  'c4000000-0000-4000-8000-000000000001',
  'user-incomplete-ending',
  'c3000000-0000-4000-8000-000000000001',
  'Verify the current opinion before an explicit lawyer Decision.',
  'completed',
  'c5000000-0000-4000-8000-000000000001',
  '[]'::jsonb,
  '{}'::jsonb,
  null,
  null
);

insert into public.agent_steps(
  id, task_id, position, title, status, attempt, result_summary, result_data
) values (
  'c5000000-0000-4000-8000-000000000001',
  'c4000000-0000-4000-8000-000000000001',
  0,
  'Verify fixed deliverable',
  'completed',
  3,
  'Structured verification requires lawyer review.',
  null
);

do $$
declare
  v_issue jsonb;
  v_record jsonb;
  v_receipt jsonb;
begin
  v_issue := jsonb_build_object(
    'code', 'artifact_incomplete_ending',
    'deliverable_key', 'evidence-objection-opinion',
    'document_id', 'c1000000-0000-4000-8000-000000000001',
    'version_id', 'c2000000-0000-4000-8000-000000000001',
    'accepted_view_sha256', 'sha256:' || repeat('a', 64),
    'ending_excerpt',
      '本意见书依据固定证据源文件编制，凡源文件未予确立的真实性、可采性、关联性及款项分配等事项，均明确标注为'
  );
  v_record := jsonb_build_object(
    'kind', 'agent_verification_record_v1',
    'task_id', 'c4000000-0000-4000-8000-000000000001',
    'step_id', 'c5000000-0000-4000-8000-000000000001',
    'step_attempt', 3,
    'result', jsonb_build_object(
      'kind', 'agent_verification_result_v1',
      'outcome', 'review_required',
      'dimensions', jsonb_build_object(
        'goal_coverage', 'pass',
        'source_support', 'pass',
        'artifact_integrity', 'gap',
        'workflow_completion', 'pass'
      ),
      'issues', jsonb_build_array(jsonb_build_object(
        'origin', 'deterministic',
        'dimension', 'artifact_integrity',
        'detail', 'The final sentence ends at an explicit continuation marker.',
        'issue', v_issue
      ))
    )
  );
  v_receipt := jsonb_build_object(
    'outcome', 'review_required',
    'postconditions', jsonb_build_array(
      jsonb_build_object(
        'code', 'required_deliverables_current',
        'status', 'pass'
      ),
      jsonb_build_object('code', 'verifier_passed', 'status', 'fail')
    )
  );
  update public.agent_tasks
  set latest_checkpoint = jsonb_build_object(
    'agent_verification_result', v_record
  )
  where id = 'c4000000-0000-4000-8000-000000000001';

  if not public.agent_verifier_review_decision_ready_v1(
    'c4000000-0000-4000-8000-000000000001',
    'c5000000-0000-4000-8000-000000000001',
    3,
    v_receipt
  ) then
    raise exception 'current abrupt-ending record did not bind to the final receipt';
  end if;

  if has_function_privilege(
    'authenticated',
    'public.agent_verifier_deterministic_issue_valid_v1(jsonb)',
    'execute'
  ) or has_function_privilege(
    'authenticated',
    'public.agent_verifier_deterministic_issue_valid_legacy_v1(jsonb)',
    'execute'
  ) then
    raise exception 'authenticated can execute private deterministic validators';
  end if;
end $$;

rollback;
