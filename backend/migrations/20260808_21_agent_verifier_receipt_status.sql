-- Align the database verifier binding with the canonical Step receipt contract.
-- Verification result dimensions use pass|gap; deterministic Step
-- postconditions use pass|fail. The earlier review Decision helper accidentally
-- mixed those two semantic axes and rejected every fresh structured
-- review_required receipt emitted by the application.

create or replace function public.agent_verifier_review_decision_ready_v1(
  p_task_id uuid,
  p_step_id uuid,
  p_step_attempt integer,
  p_receipt jsonb
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_record jsonb;
  v_result jsonb;
  v_issues jsonb;
  v_dimensions jsonb;
  v_receipt_outcome text;
  v_result_outcome text;
  v_dimension text;
  v_has_issue boolean;
begin
  if p_task_id is null
    or p_step_id is null
    or p_step_attempt is null
    or p_step_attempt < 1
    or jsonb_typeof(p_receipt) is distinct from 'object' then
    return false;
  end if;

  select latest_checkpoint -> 'agent_verification_result'
  into v_record
  from public.agent_tasks
  where id = p_task_id
  for share;
  if not found
    or jsonb_typeof(v_record) is distinct from 'object'
    or not (v_record ?& array[
      'kind', 'task_id', 'step_id', 'step_attempt', 'result'
    ])
    or v_record - array[
      'kind', 'task_id', 'step_id', 'step_attempt', 'result'
    ] <> '{}'::jsonb
    or v_record ->> 'kind' <> 'agent_verification_record_v1'
    or v_record ->> 'task_id' <> p_task_id::text
    or v_record ->> 'step_id' <> p_step_id::text
    or jsonb_typeof(v_record -> 'step_attempt') is distinct from 'number'
    or v_record ->> 'step_attempt' <> p_step_attempt::text then
    return false;
  end if;

  v_result := v_record -> 'result';
  if jsonb_typeof(v_result) is distinct from 'object'
    or not (v_result ?& array[
      'kind', 'outcome', 'dimensions', 'issues'
    ])
    or v_result - array[
      'kind', 'outcome', 'dimensions', 'issues'
    ] <> '{}'::jsonb
    or v_result ->> 'kind' <> 'agent_verification_result_v1'
    or coalesce(v_result ->> 'outcome', '') not in (
      'clean_pass', 'review_required'
    )
    or jsonb_typeof(v_result -> 'dimensions') is distinct from 'object'
    or jsonb_typeof(v_result -> 'issues') is distinct from 'array'
    or jsonb_array_length(v_result -> 'issues') > 120 then
    return false;
  end if;
  v_issues := v_result -> 'issues';
  v_dimensions := v_result -> 'dimensions';
  if not (v_dimensions ?& array[
      'goal_coverage', 'source_support',
      'artifact_integrity', 'workflow_completion'
    ])
    or v_dimensions - array[
      'goal_coverage', 'source_support',
      'artifact_integrity', 'workflow_completion'
    ] <> '{}'::jsonb
    or exists (
      select 1
      from jsonb_each(v_dimensions) dimension(key, value)
      where jsonb_typeof(dimension.value) is distinct from 'string'
        or dimension.value #>> '{}' not in ('pass', 'gap')
    )
    or exists (
      select 1
      from jsonb_array_elements(v_issues) issue(value)
      where jsonb_typeof(issue.value) is distinct from 'object'
        or coalesce(issue.value ->> 'origin', '')
          not in ('deterministic', 'semantic')
        or coalesce(issue.value ->> 'dimension', '') not in (
          'goal_coverage', 'source_support',
          'artifact_integrity', 'workflow_completion'
        )
        or jsonb_typeof(issue.value -> 'detail') is distinct from 'string'
        or length(trim(issue.value ->> 'detail')) = 0
        or length(issue.value ->> 'detail') > 2000
        or jsonb_typeof(issue.value -> 'issue') is distinct from 'object'
        or length(trim(coalesce(issue.value -> 'issue' ->> 'code', ''))) = 0
        or issue.value - array['origin', 'dimension', 'detail', 'issue']
          <> '{}'::jsonb
        or (
          issue.value ->> 'origin' = 'deterministic'
          and not public.agent_verifier_deterministic_issue_valid_v1(
            issue.value -> 'issue'
          )
        )
        or (
          issue.value ->> 'origin' = 'semantic'
          and (
            issue.value ->> 'dimension' <> 'goal_coverage'
            or issue.value -> 'issue' ->> 'code'
              <> 'semantic_goal_omission'
            or not ((issue.value -> 'issue') ?& array[
              'code', 'deliverable_key', 'goal_excerpt', 'detail'
            ])
            or (issue.value -> 'issue') - array[
              'code', 'deliverable_key', 'goal_excerpt', 'detail'
            ] <> '{}'::jsonb
            or length(trim(coalesce(
              issue.value -> 'issue' ->> 'deliverable_key', ''
            ))) not between 1 and 120
            or length(trim(coalesce(
              issue.value -> 'issue' ->> 'goal_excerpt', ''
            ))) not between 1 and 2000
            or length(trim(coalesce(
              issue.value -> 'issue' ->> 'detail', ''
            ))) not between 1 and 2000
          )
        )
    ) then
    return false;
  end if;

  foreach v_dimension in array array[
    'goal_coverage', 'source_support',
    'artifact_integrity', 'workflow_completion'
  ] loop
    select exists (
      select 1
      from jsonb_array_elements(v_issues) issue(value)
      where issue.value ->> 'dimension' = v_dimension
    ) into v_has_issue;
    if (v_dimensions ->> v_dimension) <>
      (case when v_has_issue then 'gap' else 'pass' end) then
      return false;
    end if;
  end loop;

  v_receipt_outcome := p_receipt ->> 'outcome';
  v_result_outcome := v_result ->> 'outcome';
  if jsonb_typeof(p_receipt -> 'postconditions') is distinct from 'array'
    or jsonb_array_length(p_receipt -> 'postconditions') not between 1 and 7
    or exists (
      select 1
      from jsonb_array_elements(p_receipt -> 'postconditions') item(value)
      where jsonb_typeof(item.value) is distinct from 'object'
        or not (item.value ?& array['code', 'status'])
        or item.value - array['code', 'status'] <> '{}'::jsonb
        or jsonb_typeof(item.value -> 'code') is distinct from 'string'
        or item.value ->> 'code' not in (
          'summary_present', 'source_versions_recorded',
          'artifact_created', 'artifact_current_version',
          'required_deliverables_current',
          'source_requirement_satisfied', 'verifier_passed'
        )
        or jsonb_typeof(item.value -> 'status') is distinct from 'string'
        or item.value ->> 'status' not in ('pass', 'fail')
    )
    or exists (
      select 1
      from jsonb_array_elements(p_receipt -> 'postconditions') item(value)
      group by item.value ->> 'code'
      having count(*) > 1
    ) then
    return false;
  end if;
  if v_receipt_outcome = 'postconditions_satisfied' then
    return v_result_outcome = 'clean_pass'
      and jsonb_array_length(v_issues) = 0
      and not exists (
        select 1
        from jsonb_array_elements(p_receipt -> 'postconditions') item(value)
        where item.value ->> 'status' <> 'pass'
      )
      and exists (
        select 1
        from jsonb_array_elements(p_receipt -> 'postconditions') item(value)
        where item.value ->> 'code' = 'verifier_passed'
          and item.value ->> 'status' = 'pass'
      );
  end if;
  if v_receipt_outcome = 'review_required' then
    return v_result_outcome = 'review_required'
      and jsonb_array_length(v_issues) > 0
      and exists (
        select 1
        from jsonb_array_elements(p_receipt -> 'postconditions') item(value)
        where item.value ->> 'code' = 'verifier_passed'
          and item.value ->> 'status' = 'fail'
      );
  end if;
  return false;
end;
$$;

revoke all on function public.agent_verifier_review_decision_ready_v1(
  uuid, uuid, integer, jsonb
) from public, anon, authenticated, service_role;

comment on function public.agent_verifier_review_decision_ready_v1(
  uuid, uuid, integer, jsonb
) is
  'Internal fail-closed binding between the final Step receipt (pass|fail postconditions) and the server-owned structured verification result (pass|gap dimensions). Verification outcome remains separate from an explicit lawyer Decision.';
