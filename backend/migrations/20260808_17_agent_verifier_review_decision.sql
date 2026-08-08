-- Verification outcomes describe automated review, not lawyer approval.
-- A review_required receipt may support an explicit lawyer Decision only when
-- the server-owned structured result is exact, current, and bound to the same
-- final Step attempt. All existing Artifact, source, snapshot, and byte locks
-- remain unchanged.

create or replace function public.agent_verifier_integer_between_v1(
  p_value jsonb,
  p_minimum numeric,
  p_maximum numeric
)
returns boolean
language plpgsql
immutable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_value numeric;
begin
  if jsonb_typeof(p_value) is distinct from 'number'
    or p_minimum is null then
    return false;
  end if;
  begin
    v_value := (p_value #>> '{}')::numeric;
  exception when others then
    return false;
  end;
  return v_value = trunc(v_value)
    and v_value >= p_minimum
    and (p_maximum is null or v_value <= p_maximum);
end;
$$;

create or replace function public.agent_verifier_deterministic_issue_valid_v1(
  p_issue jsonb
)
returns boolean
language plpgsql
immutable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_code text;
begin
  if jsonb_typeof(p_issue) is distinct from 'object'
    or jsonb_typeof(p_issue -> 'code') is distinct from 'string' then
    return false;
  end if;
  v_code := p_issue ->> 'code';

  if v_code = 'artifact_missing' then
    return p_issue ?& array['code', 'deliverable_key', 'artifact_type']
      and p_issue - array['code', 'deliverable_key', 'artifact_type']
        = '{}'::jsonb
      and jsonb_typeof(p_issue -> 'deliverable_key') = 'string'
      and length(trim(p_issue ->> 'deliverable_key')) between 1 and 120
      and jsonb_typeof(p_issue -> 'artifact_type') = 'string'
      and p_issue ->> 'artifact_type' in ('draft', 'tabular_review');
  end if;

  if v_code in ('artifact_outside_matter', 'artifact_unavailable') then
    return p_issue ?& array['code', 'deliverable_key', 'artifact_id']
      and p_issue - array['code', 'deliverable_key', 'artifact_id']
        = '{}'::jsonb
      and jsonb_typeof(p_issue -> 'deliverable_key') = 'string'
      and length(trim(p_issue ->> 'deliverable_key')) between 1 and 120
      and jsonb_typeof(p_issue -> 'artifact_id') = 'string'
      and p_issue ->> 'artifact_id'
        ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  end if;

  if v_code = 'artifact_version_changed' then
    return p_issue ?& array[
        'code', 'deliverable_key', 'document_id',
        'expected_version_id', 'current_version_id'
      ]
      and p_issue - array[
        'code', 'deliverable_key', 'document_id',
        'expected_version_id', 'current_version_id'
      ] = '{}'::jsonb
      and jsonb_typeof(p_issue -> 'deliverable_key') = 'string'
      and length(trim(p_issue ->> 'deliverable_key')) between 1 and 120
      and jsonb_typeof(p_issue -> 'document_id') = 'string'
      and p_issue ->> 'document_id'
        ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      and jsonb_typeof(p_issue -> 'expected_version_id') = 'string'
      and p_issue ->> 'expected_version_id'
        ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      and (
        p_issue -> 'current_version_id' = 'null'::jsonb
        or (
          jsonb_typeof(p_issue -> 'current_version_id') = 'string'
          and p_issue ->> 'current_version_id'
            ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        )
      );
  end if;

  if v_code = 'accepted_view_unreadable' then
    return p_issue ?& array[
        'code', 'deliverable_key', 'document_id', 'version_id'
      ]
      and p_issue - array[
        'code', 'deliverable_key', 'document_id', 'version_id'
      ] = '{}'::jsonb
      and jsonb_typeof(p_issue -> 'deliverable_key') = 'string'
      and length(trim(p_issue ->> 'deliverable_key')) between 1 and 120
      and jsonb_typeof(p_issue -> 'document_id') = 'string'
      and p_issue ->> 'document_id'
        ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      and jsonb_typeof(p_issue -> 'version_id') = 'string'
      and p_issue ->> 'version_id'
        ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  end if;

  if v_code = 'citation_snapshot_missing' then
    return p_issue ?& array['code', 'deliverable_key']
      and p_issue - array['code', 'deliverable_key'] = '{}'::jsonb
      and (
        p_issue -> 'deliverable_key' = 'null'::jsonb
        or (
          jsonb_typeof(p_issue -> 'deliverable_key') = 'string'
          and length(trim(p_issue ->> 'deliverable_key')) between 1 and 120
        )
      );
  end if;

  if v_code = 'citation_relocation_gap' then
    return p_issue ?& array[
        'code', 'deliverable_key', 'total', 'missing', 'statuses'
      ]
      and p_issue - array[
        'code', 'deliverable_key', 'total', 'missing', 'statuses'
      ] = '{}'::jsonb
      and (
        p_issue -> 'deliverable_key' = 'null'::jsonb
        or (
          jsonb_typeof(p_issue -> 'deliverable_key') = 'string'
          and length(trim(p_issue ->> 'deliverable_key')) between 1 and 120
        )
      )
      and public.agent_verifier_integer_between_v1(
        p_issue -> 'total', 1, 5000
      )
      and public.agent_verifier_integer_between_v1(
        p_issue -> 'missing', 1, 5000
      )
      and jsonb_typeof(p_issue -> 'statuses') = 'array'
      and jsonb_array_length(p_issue -> 'statuses') between 1 and 5000
      and not exists (
        select 1
        from jsonb_array_elements(p_issue -> 'statuses') status(value)
        where jsonb_typeof(status.value) is distinct from 'string'
          or status.value #>> '{}' not in (
            'drifted', 'missing', 'version_mismatch'
          )
      );
  end if;

  if v_code = 'citation_marker_gap' then
    return p_issue ?& array[
        'code', 'deliverable_key', 'document_id', 'version_id',
        'accepted_view_sha256', 'citations'
      ]
      and p_issue - array[
        'code', 'deliverable_key', 'document_id', 'version_id',
        'accepted_view_sha256', 'citations'
      ] = '{}'::jsonb
      and jsonb_typeof(p_issue -> 'deliverable_key') = 'string'
      and length(trim(p_issue ->> 'deliverable_key')) between 1 and 120
      and jsonb_typeof(p_issue -> 'document_id') = 'string'
      and p_issue ->> 'document_id'
        ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      and jsonb_typeof(p_issue -> 'version_id') = 'string'
      and p_issue ->> 'version_id'
        ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      and jsonb_typeof(p_issue -> 'accepted_view_sha256') = 'string'
      and p_issue ->> 'accepted_view_sha256'
        ~ '^sha256:[a-f0-9]{64}$'
      and jsonb_typeof(p_issue -> 'citations') = 'array'
      and jsonb_array_length(p_issue -> 'citations') between 1 and 500
      and not exists (
        select 1
        from jsonb_array_elements(p_issue -> 'citations') citation(value)
        where jsonb_typeof(citation.value) is distinct from 'object'
          or not (citation.value ?& array[
            'marker', 'source_document_id', 'source_version_id', 'quote'
          ])
          or citation.value - array[
            'marker', 'source_document_id', 'source_version_id', 'quote'
          ] <> '{}'::jsonb
          or not public.agent_verifier_integer_between_v1(
            citation.value -> 'marker', 1, 500
          )
          or jsonb_typeof(citation.value -> 'source_document_id')
            is distinct from 'string'
          or citation.value ->> 'source_document_id'
            !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          or jsonb_typeof(citation.value -> 'source_version_id')
            is distinct from 'string'
          or citation.value ->> 'source_version_id'
            !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          or jsonb_typeof(citation.value -> 'quote') is distinct from 'string'
          or length(trim(citation.value ->> 'quote')) not between 1 and 4000
      );
  end if;

  if v_code = 'prior_step_incomplete' then
    return p_issue ?& array['code', 'step_positions']
      and p_issue - array['code', 'step_positions'] = '{}'::jsonb
      and jsonb_typeof(p_issue -> 'step_positions') = 'array'
      and jsonb_array_length(p_issue -> 'step_positions') between 1 and 200
      and not exists (
        select 1
        from jsonb_array_elements(p_issue -> 'step_positions') position(value)
        where not public.agent_verifier_integer_between_v1(
          position.value, 0, 200
        )
      );
  end if;

  if v_code = 'verification_scope_exceeded' then
    return p_issue ?& array[
        'code', 'deliverable_key',
        'accepted_view_characters', 'projected_characters'
      ]
      and p_issue - array[
        'code', 'deliverable_key',
        'accepted_view_characters', 'projected_characters'
      ] = '{}'::jsonb
      and jsonb_typeof(p_issue -> 'deliverable_key') = 'string'
      and length(trim(p_issue ->> 'deliverable_key')) between 1 and 120
      and public.agent_verifier_integer_between_v1(
        p_issue -> 'accepted_view_characters', 1, null
      )
      and public.agent_verifier_integer_between_v1(
        p_issue -> 'projected_characters', 0, null
      );
  end if;

  if v_code = 'tabular_review_invalid' then
    return p_issue ?& array[
        'code', 'deliverable_key', 'review_id', 'reason', 'total_cells'
      ]
      and p_issue - array[
        'code', 'deliverable_key', 'review_id', 'reason', 'total_cells'
      ] = '{}'::jsonb
      and jsonb_typeof(p_issue -> 'deliverable_key') = 'string'
      and length(trim(p_issue ->> 'deliverable_key')) between 1 and 120
      and jsonb_typeof(p_issue -> 'review_id') = 'string'
      and p_issue ->> 'review_id'
        ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      and jsonb_typeof(p_issue -> 'reason') = 'string'
      and p_issue ->> 'reason' in (
        'row_protocol', 'layout', 'source_scope', 'cell_coordinate'
      )
      and public.agent_verifier_integer_between_v1(
        p_issue -> 'total_cells', 0, 50000
      );
  end if;

  if v_code = 'tabular_review_revision_unstable' then
    return p_issue ?& array[
        'code', 'deliverable_key', 'review_id', 'reason', 'total_cells'
      ]
      and p_issue - array[
        'code', 'deliverable_key', 'review_id', 'reason', 'total_cells'
      ] = '{}'::jsonb
      and jsonb_typeof(p_issue -> 'deliverable_key') = 'string'
      and length(trim(p_issue ->> 'deliverable_key')) between 1 and 120
      and jsonb_typeof(p_issue -> 'review_id') = 'string'
      and p_issue ->> 'review_id'
        ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      and jsonb_typeof(p_issue -> 'reason') = 'string'
      and p_issue ->> 'reason' in (
        'input_digest_unavailable', 'input_digest_changed',
        'before_unavailable', 'after_unavailable', 'changed'
      )
      and public.agent_verifier_integer_between_v1(
        p_issue -> 'total_cells', 0, 50000
      );
  end if;

  if v_code = 'tabular_review_incomplete' then
    return p_issue ?& array[
        'code', 'deliverable_key', 'review_id',
        'total_cells', 'incomplete_cells'
      ]
      and p_issue - array[
        'code', 'deliverable_key', 'review_id',
        'total_cells', 'incomplete_cells'
      ] = '{}'::jsonb
      and jsonb_typeof(p_issue -> 'deliverable_key') = 'string'
      and length(trim(p_issue ->> 'deliverable_key')) between 1 and 120
      and jsonb_typeof(p_issue -> 'review_id') = 'string'
      and p_issue ->> 'review_id'
        ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      and public.agent_verifier_integer_between_v1(
        p_issue -> 'total_cells', 0, 50000
      )
      and public.agent_verifier_integer_between_v1(
        p_issue -> 'incomplete_cells', 1, 50000
      );
  end if;

  if v_code = 'pack_check_gap' then
    return p_issue ?& array['code', 'profile_id', 'check_code', 'facts']
      and p_issue - array['code', 'profile_id', 'check_code', 'facts']
        = '{}'::jsonb
      and jsonb_typeof(p_issue -> 'profile_id') = 'string'
      and length(trim(p_issue ->> 'profile_id')) between 1 and 160
      and jsonb_typeof(p_issue -> 'check_code') = 'string'
      and length(trim(p_issue ->> 'check_code')) between 1 and 160
      and jsonb_typeof(p_issue -> 'facts') = 'object';
  end if;

  return false;
end;
$$;

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
            ))) = 0
            or length(trim(coalesce(
              issue.value -> 'issue' ->> 'goal_excerpt', ''
            ))) = 0
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
    or exists (
      select 1
      from jsonb_array_elements(p_receipt -> 'postconditions') item(value)
      where jsonb_typeof(item.value) is distinct from 'object'
        or coalesce(item.value ->> 'status', '') not in ('pass', 'gap')
        or length(trim(coalesce(item.value ->> 'code', ''))) = 0
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
          and item.value ->> 'status' = 'gap'
      );
  end if;
  return false;
end;
$$;

create or replace function public.agent_tabular_final_verifier_matches_v1(
  p_task_id uuid,
  p_review_id uuid,
  p_verified_identity jsonb
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_task public.agent_tasks%rowtype;
  v_final_step public.agent_steps%rowtype;
  v_receipt jsonb;
  v_receipt_count integer;
  v_identity_count integer;
  v_inventory_receipt jsonb;
begin
  if p_task_id is null
    or p_review_id is null
    or jsonb_typeof(p_verified_identity) is distinct from 'object' then
    return false;
  end if;
  select * into v_task
  from public.agent_tasks
  where id = p_task_id
  for share;
  if not found
    or jsonb_typeof(v_task.latest_checkpoint -> 'step_receipts')
      is distinct from 'array' then
    return false;
  end if;
  select * into v_final_step
  from public.agent_steps
  where task_id = p_task_id
  order by position desc
  limit 1
  for share;
  if not found or v_final_step.status <> 'completed' then
    return false;
  end if;
  select count(*), (array_agg(receipt.value))[1]
  into v_receipt_count, v_receipt
  from jsonb_array_elements(v_task.latest_checkpoint -> 'step_receipts')
    receipt(value)
  where jsonb_typeof(receipt.value) = 'object'
    and receipt.value ->> 'kind' = 'agent_step_receipt_v1'
    and receipt.value ->> 'contract_version' = 'agent_step_contract_v1'
    and receipt.value ->> 'position' = v_final_step.position::text
    and receipt.value ->> 'attempt' = v_final_step.attempt::text
    and receipt.value ->> 'capability' = 'verify'
    and receipt.value ->> 'operation' = 'verify';
  if v_receipt_count <> 1
    or not public.agent_verifier_review_decision_ready_v1(
      p_task_id, v_final_step.id, v_final_step.attempt, v_receipt
    )
    or jsonb_typeof(v_receipt -> 'artifact_ids') is distinct from 'array'
    or jsonb_typeof(v_receipt -> 'source_version_ids') is distinct from 'array'
    or jsonb_typeof(v_receipt -> 'verified_artifacts') is distinct from 'array'
    or not (v_receipt -> 'artifact_ids' @> jsonb_build_array(p_review_id::text))
  then
    return false;
  end if;
  select count(*) into v_identity_count
  from jsonb_array_elements(v_receipt -> 'verified_artifacts') item(value)
  where item.value = p_verified_identity;
  if v_identity_count <> 1
    or exists (
      select 1
      from jsonb_array_elements(v_receipt -> 'verified_artifacts') item(value)
      where item.value ->> 'kind' = 'agent_verified_tabular_artifact_v1'
        and item.value ->> 'review_id' = p_review_id::text
        and item.value <> p_verified_identity
    ) then
    return false;
  end if;
  v_inventory_receipt := v_task.latest_checkpoint ->
    'litigation_evidence_inventory_receipt';
  if jsonb_typeof(v_inventory_receipt) = 'object'
    and exists (
      select 1
      from jsonb_array_elements(v_inventory_receipt -> 'source_pins') pin
      where not (
        v_receipt -> 'source_version_ids' @>
          jsonb_build_array(pin ->> 'version_id')
      )
    ) then
    return false;
  end if;
  return true;
end;
$$;

create or replace function public.agent_draft_final_verifier_matches_v1(
  p_task_id uuid,
  p_document_id uuid,
  p_version_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_task public.agent_tasks%rowtype;
  v_final_step public.agent_steps%rowtype;
  v_receipt jsonb;
  v_receipt_count integer;
  v_identity_count integer;
  v_identity_keys text[] := array[
    'kind', 'document_id', 'version_id', 'accepted_view_sha256'
  ];
begin
  if p_task_id is null or p_document_id is null or p_version_id is null then
    return false;
  end if;
  select * into v_task
  from public.agent_tasks
  where id = p_task_id
  for share;
  if not found
    or jsonb_typeof(v_task.latest_checkpoint -> 'step_receipts')
      is distinct from 'array' then
    return false;
  end if;
  select * into v_final_step
  from public.agent_steps
  where task_id = p_task_id
  order by position desc
  limit 1
  for share;
  if not found or v_final_step.status <> 'completed' then
    return false;
  end if;
  select count(*), (array_agg(receipt.value))[1]
  into v_receipt_count, v_receipt
  from jsonb_array_elements(v_task.latest_checkpoint -> 'step_receipts')
    receipt(value)
  where jsonb_typeof(receipt.value) = 'object'
    and receipt.value ->> 'kind' = 'agent_step_receipt_v1'
    and receipt.value ->> 'contract_version' = 'agent_step_contract_v1'
    and receipt.value ->> 'position' = v_final_step.position::text
    and receipt.value ->> 'attempt' = v_final_step.attempt::text
    and receipt.value ->> 'capability' = 'verify'
    and receipt.value ->> 'operation' = 'verify';
  if v_receipt_count <> 1
    or not public.agent_verifier_review_decision_ready_v1(
      p_task_id, v_final_step.id, v_final_step.attempt, v_receipt
    )
    or jsonb_typeof(v_receipt -> 'artifact_ids') is distinct from 'array'
    or jsonb_typeof(v_receipt -> 'verified_artifacts') is distinct from 'array'
    or not (
      v_receipt -> 'artifact_ids' @> jsonb_build_array(p_document_id::text)
    ) then
    return false;
  end if;
  select count(*) into v_identity_count
  from jsonb_array_elements(v_receipt -> 'verified_artifacts') item(value)
  where jsonb_typeof(item.value) = 'object'
    and item.value ?& v_identity_keys
    and item.value - v_identity_keys = '{}'::jsonb
    and item.value ->> 'kind' = 'agent_verified_draft_artifact_v1'
    and item.value ->> 'document_id' = p_document_id::text
    and item.value ->> 'version_id' = p_version_id::text
    and item.value ->> 'accepted_view_sha256'
      ~ '^sha256:[a-f0-9]{64}$';
  return v_identity_count = 1;
end;
$$;

create or replace function public.agent_final_verifier_snapshot_matches_v1(
  p_task_id uuid,
  p_artifact_snapshot jsonb
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_task public.agent_tasks%rowtype;
  v_final_step public.agent_steps%rowtype;
  v_receipt jsonb;
  v_receipt_count integer;
  v_snapshot_count integer;
  v_identity_count integer;
  v_draft_identity_keys text[] := array[
    'kind', 'document_id', 'version_id', 'accepted_view_sha256'
  ];
  v_tabular_identity_keys text[] := array[
    'kind', 'review_id', 'row_protocol', 'input_digest',
    'revision_fingerprint', 'accepted_view_sha256',
    'source_receipt_fingerprint', 'decision_fingerprint', 'completion_sha256'
  ];
begin
  if p_task_id is null
    or jsonb_typeof(p_artifact_snapshot) is distinct from 'array' then
    return false;
  end if;
  select * into v_task
  from public.agent_tasks
  where id = p_task_id
  for share;
  if not found
    or jsonb_typeof(v_task.latest_checkpoint -> 'step_receipts')
      is distinct from 'array' then
    return false;
  end if;
  select * into v_final_step
  from public.agent_steps
  where task_id = p_task_id
  order by position desc
  limit 1
  for share;
  if not found or v_final_step.status <> 'completed' then
    return false;
  end if;
  select count(*), (array_agg(receipt.value))[1]
  into v_receipt_count, v_receipt
  from jsonb_array_elements(v_task.latest_checkpoint -> 'step_receipts')
    receipt(value)
  where jsonb_typeof(receipt.value) = 'object'
    and receipt.value ->> 'kind' = 'agent_step_receipt_v1'
    and receipt.value ->> 'contract_version' = 'agent_step_contract_v1'
    and receipt.value ->> 'position' = v_final_step.position::text
    and receipt.value ->> 'attempt' = v_final_step.attempt::text
    and receipt.value ->> 'capability' = 'verify'
    and receipt.value ->> 'operation' = 'verify';
  if v_receipt_count <> 1
    or not public.agent_verifier_review_decision_ready_v1(
      p_task_id, v_final_step.id, v_final_step.attempt, v_receipt
    )
    or jsonb_typeof(v_receipt -> 'artifact_ids') is distinct from 'array'
    or jsonb_typeof(v_receipt -> 'verified_artifacts') is distinct from 'array'
  then
    return false;
  end if;
  v_snapshot_count := jsonb_array_length(p_artifact_snapshot);
  v_identity_count := jsonb_array_length(v_receipt -> 'verified_artifacts');
  if v_identity_count <> v_snapshot_count
    or jsonb_array_length(v_receipt -> 'artifact_ids') <> v_snapshot_count
    or exists (
      select 1
      from jsonb_array_elements(v_receipt -> 'artifact_ids') artifact_id(value)
      where jsonb_typeof(artifact_id.value) is distinct from 'string'
        or coalesce(artifact_id.value #>> '{}', '')
          !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    )
    or exists (
      select 1
      from jsonb_array_elements_text(v_receipt -> 'artifact_ids') artifact_id(id)
      group by artifact_id.id
      having count(*) > 1
    )
    or exists (
      select 1
      from jsonb_array_elements(v_receipt -> 'verified_artifacts') identity(value)
      group by identity.value ->> 'kind', coalesce(
        identity.value ->> 'document_id', identity.value ->> 'review_id'
      )
      having count(*) > 1
    )
    or exists (
      select 1
      from jsonb_array_elements(v_receipt -> 'verified_artifacts') identity(value)
      where jsonb_typeof(identity.value) is distinct from 'object'
        or not (
          (
            identity.value ->> 'kind' = 'agent_verified_draft_artifact_v1'
            and identity.value ?& v_draft_identity_keys
            and identity.value - v_draft_identity_keys = '{}'::jsonb
            and identity.value ->> 'document_id'
              ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            and identity.value ->> 'version_id'
              ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            and identity.value ->> 'accepted_view_sha256'
              ~ '^sha256:[a-f0-9]{64}$'
          ) or (
            identity.value ->> 'kind' = 'agent_verified_tabular_artifact_v1'
            and identity.value ?& v_tabular_identity_keys
            and identity.value - v_tabular_identity_keys = '{}'::jsonb
            and identity.value ->> 'review_id'
              ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            and identity.value ->> 'row_protocol' = 'document_rows'
            and identity.value ->> 'input_digest' ~ '^[a-f0-9]{64}$'
            and identity.value ->> 'revision_fingerprint' ~ '^[a-f0-9]{64}$'
            and identity.value ->> 'accepted_view_sha256'
              ~ '^sha256:[a-f0-9]{64}$'
            and (
              identity.value -> 'source_receipt_fingerprint' = 'null'::jsonb
              or (
                jsonb_typeof(identity.value -> 'source_receipt_fingerprint')
                  = 'string'
                and identity.value ->> 'source_receipt_fingerprint'
                  ~ '^[a-f0-9]{64}$'
              )
            )
            and (
              identity.value -> 'decision_fingerprint' = 'null'::jsonb
              or (
                jsonb_typeof(identity.value -> 'decision_fingerprint')
                  = 'string'
                and identity.value ->> 'decision_fingerprint'
                  ~ '^[a-f0-9]{64}$'
              )
            )
            and (
              identity.value -> 'completion_sha256' = 'null'::jsonb
              or (
                jsonb_typeof(identity.value -> 'completion_sha256') = 'string'
                and identity.value ->> 'completion_sha256'
                  ~ '^sha256:[a-f0-9]{64}$'
              )
            )
          )
        )
    )
    or exists (
      select 1
      from jsonb_array_elements(p_artifact_snapshot) artifact(value)
      where 1 <> (
        select count(*)
        from jsonb_array_elements(v_receipt -> 'verified_artifacts') identity(value)
        where (
          artifact.value ->> 'artifact_type' = 'draft'
          and identity.value ->> 'kind' = 'agent_verified_draft_artifact_v1'
          and identity.value ->> 'document_id' = artifact.value ->> 'document_id'
          and identity.value ->> 'version_id' = artifact.value ->> 'version_id'
        ) or (
          artifact.value ->> 'kind' = 'agent_approved_tabular_artifact_v1'
          and identity.value = jsonb_build_object(
            'kind', 'agent_verified_tabular_artifact_v1',
            'review_id', artifact.value -> 'review_id',
            'row_protocol', artifact.value -> 'row_protocol',
            'input_digest', artifact.value -> 'input_digest',
            'revision_fingerprint', artifact.value -> 'revision_fingerprint',
            'accepted_view_sha256', artifact.value -> 'accepted_view_sha256',
            'source_receipt_fingerprint', artifact.value -> 'source_receipt_fingerprint',
            'decision_fingerprint', artifact.value -> 'decision_fingerprint',
            'completion_sha256', artifact.value -> 'completion_sha256'
          )
        )
      )
    )
    or exists (
      select 1
      from jsonb_array_elements(v_receipt -> 'verified_artifacts') identity(value)
      where 1 <> (
        select count(*)
        from jsonb_array_elements(p_artifact_snapshot) artifact(value)
        where (
          identity.value ->> 'kind' = 'agent_verified_draft_artifact_v1'
          and artifact.value ->> 'artifact_type' = 'draft'
          and artifact.value ->> 'document_id' = identity.value ->> 'document_id'
          and artifact.value ->> 'version_id' = identity.value ->> 'version_id'
        ) or (
          identity.value ->> 'kind' = 'agent_verified_tabular_artifact_v1'
          and artifact.value ->> 'kind' = 'agent_approved_tabular_artifact_v1'
          and identity.value = jsonb_build_object(
            'kind', 'agent_verified_tabular_artifact_v1',
            'review_id', artifact.value -> 'review_id',
            'row_protocol', artifact.value -> 'row_protocol',
            'input_digest', artifact.value -> 'input_digest',
            'revision_fingerprint', artifact.value -> 'revision_fingerprint',
            'accepted_view_sha256', artifact.value -> 'accepted_view_sha256',
            'source_receipt_fingerprint', artifact.value -> 'source_receipt_fingerprint',
            'decision_fingerprint', artifact.value -> 'decision_fingerprint',
            'completion_sha256', artifact.value -> 'completion_sha256'
          )
        )
      )
    )
    or exists (
      select 1
      from jsonb_array_elements(p_artifact_snapshot) artifact(value)
      where not (
        v_receipt -> 'artifact_ids' @>
          jsonb_build_array(artifact.value ->> 'artifact_id')
      )
    ) then
    return false;
  end if;
  return true;
end;
$$;

revoke all on function public.agent_verifier_review_decision_ready_v1(
  uuid, uuid, integer, jsonb
) from public, anon, authenticated, service_role;

revoke all on function public.agent_verifier_integer_between_v1(
  jsonb, numeric, numeric
) from public, anon, authenticated, service_role;

revoke all on function public.agent_verifier_deterministic_issue_valid_v1(
  jsonb
) from public, anon, authenticated, service_role;

comment on function public.agent_verifier_integer_between_v1(
  jsonb, numeric, numeric
) is
  'Internal exception-safe exact integer range validator for structured verifier facts.';

comment on function public.agent_verifier_deterministic_issue_valid_v1(
  jsonb
) is
  'Internal exact-schema validator for server-owned deterministic verifier issue facts.';

comment on function public.agent_verifier_review_decision_ready_v1(
  uuid, uuid, integer, jsonb
) is
  'Internal fail-closed binding between the final Step receipt and the server-owned structured verification result. Verification outcome remains separate from an explicit lawyer Decision.';
