-- Permit a final Verifier retry when the prior review gap itself prevented
-- one current Artifact from receiving a verified identity. This changes no
-- Matter, Version, effect, approval, or export boundary.

-- A review gap may legitimately omit a verified identity for the affected
-- Artifact. Retrying that final Verifier still requires every listed Artifact
-- to be Task-owned, and every identity that is present to match the strict
-- server-owned union and one listed Artifact.

create or replace function public.agent_verifier_retry_identity_valid_v1(
  p_identity jsonb,
  p_artifact_ids jsonb
)
returns boolean
language plpgsql
immutable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_target_id text;
begin
  if jsonb_typeof(p_identity) is distinct from 'object'
    or jsonb_typeof(p_artifact_ids) is distinct from 'array'
    or jsonb_typeof(p_identity -> 'kind') is distinct from 'string' then
    return false;
  end if;

  if p_identity ->> 'kind' = 'agent_verified_draft_artifact_v1' then
    if not (p_identity ?& array[
        'kind', 'document_id', 'version_id', 'accepted_view_sha256'
      ])
      or p_identity - array[
        'kind', 'document_id', 'version_id', 'accepted_view_sha256'
      ] <> '{}'::jsonb
      or jsonb_typeof(p_identity -> 'document_id') is distinct from 'string'
      or p_identity ->> 'document_id'
        !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or jsonb_typeof(p_identity -> 'version_id') is distinct from 'string'
      or p_identity ->> 'version_id'
        !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or jsonb_typeof(p_identity -> 'accepted_view_sha256')
        is distinct from 'string'
      or p_identity ->> 'accepted_view_sha256'
        !~ '^sha256:[a-f0-9]{64}$' then
      return false;
    end if;
    v_target_id := p_identity ->> 'document_id';
  elsif p_identity ->> 'kind' = 'agent_verified_tabular_artifact_v1' then
    if not (p_identity ?& array[
        'kind', 'review_id', 'row_protocol', 'input_digest',
        'revision_fingerprint', 'accepted_view_sha256',
        'source_receipt_fingerprint', 'decision_fingerprint',
        'completion_sha256'
      ])
      or p_identity - array[
        'kind', 'review_id', 'row_protocol', 'input_digest',
        'revision_fingerprint', 'accepted_view_sha256',
        'source_receipt_fingerprint', 'decision_fingerprint',
        'completion_sha256'
      ] <> '{}'::jsonb
      or jsonb_typeof(p_identity -> 'review_id') is distinct from 'string'
      or p_identity ->> 'review_id'
        !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or p_identity ->> 'row_protocol' <> 'document_rows'
      or jsonb_typeof(p_identity -> 'input_digest') is distinct from 'string'
      or p_identity ->> 'input_digest' !~ '^[a-f0-9]{64}$'
      or jsonb_typeof(p_identity -> 'revision_fingerprint')
        is distinct from 'string'
      or p_identity ->> 'revision_fingerprint' !~ '^[a-f0-9]{64}$'
      or jsonb_typeof(p_identity -> 'accepted_view_sha256')
        is distinct from 'string'
      or p_identity ->> 'accepted_view_sha256'
        !~ '^sha256:[a-f0-9]{64}$'
      or (
        p_identity -> 'source_receipt_fingerprint' <> 'null'::jsonb
        and (
          jsonb_typeof(p_identity -> 'source_receipt_fingerprint')
            is distinct from 'string'
          or p_identity ->> 'source_receipt_fingerprint'
            !~ '^[a-f0-9]{64}$'
        )
      )
      or (
        p_identity -> 'decision_fingerprint' <> 'null'::jsonb
        and (
          jsonb_typeof(p_identity -> 'decision_fingerprint')
            is distinct from 'string'
          or p_identity ->> 'decision_fingerprint' !~ '^[a-f0-9]{64}$'
        )
      )
      or (
        p_identity -> 'completion_sha256' <> 'null'::jsonb
        and (
          jsonb_typeof(p_identity -> 'completion_sha256')
            is distinct from 'string'
          or p_identity ->> 'completion_sha256'
            !~ '^sha256:[a-f0-9]{64}$'
        )
      ) then
      return false;
    end if;
    v_target_id := p_identity ->> 'review_id';
  else
    return false;
  end if;

  return p_artifact_ids @> jsonb_build_array(v_target_id);
end;
$$;

revoke all on function public.agent_verifier_retry_identity_valid_v1(
  jsonb, jsonb
) from public, anon, authenticated, service_role;

create or replace function public.start_agent_task_verifier_retry_v1(
  p_task_id uuid,
  p_user_id text,
  p_retry_id text
)
returns table(outcome text, task_status text, current_step uuid)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_task public.agent_tasks%rowtype;
  v_verifier public.agent_steps%rowtype;
  v_verifier_contract jsonb;
  v_verifier_count integer;
  v_invalid_step_count integer;
  v_running_step_count integer;
  v_receipt jsonb;
  v_receipt_count integer;
  v_receipts jsonb;
  v_filtered_receipts jsonb;
  v_existing_event jsonb;
  v_checkpoint jsonb;
  v_retry_source text;
  v_updated_at timestamptz := clock_timestamp();
begin
  if p_task_id is null
    or p_user_id is null
    or length(trim(p_user_id)) = 0
    or p_retry_id is null
    or length(trim(p_retry_id)) not between 1 and 200 then
    return query select 'invalid_input'::text, null::text, null::uuid;
    return;
  end if;

  select * into v_task
  from public.agent_tasks
  where id = p_task_id and user_id = p_user_id
  for update;
  if not found then
    return query select 'not_found'::text, null::text, null::uuid;
    return;
  end if;

  v_existing_event := v_task.latest_checkpoint -> 'verifier_retry';
  if jsonb_typeof(v_existing_event) = 'object'
    and v_existing_event ->> 'retry_id' = trim(p_retry_id) then
    if v_existing_event ?& array[
        'kind', 'retry_id', 'task_id', 'verifier_step_id',
        'from_attempt', 'attempt', 'requested_at'
      ]
      and v_existing_event - array[
        'kind', 'retry_id', 'task_id', 'verifier_step_id',
        'from_attempt', 'attempt', 'requested_at', 'source'
      ] = '{}'::jsonb
      and v_existing_event ->> 'kind' = 'agent_task_verifier_retry_v1'
      and v_existing_event ->> 'task_id' = p_task_id::text
      and (
        not (v_existing_event ? 'source')
        or v_existing_event ->> 'source' in (
          'structured_current',
          'legacy_unstructured_review_gap'
        )
      )
      and v_task.status = 'verifying'
      and v_task.current_step::text =
        v_existing_event ->> 'verifier_step_id' then
      return query
      select 'already_started'::text, v_task.status, v_task.current_step;
    else
      return query
      select 'conflict'::text, v_task.status, v_task.current_step;
    end if;
    return;
  end if;

  if v_task.execution_lease_owner is not null
    and v_task.execution_lease_expires_at > clock_timestamp() then
    return query
    select 'lease_busy'::text, v_task.status, v_task.current_step;
    return;
  end if;
  if v_task.status <> 'completed' or v_task.current_step is not null then
    return query select 'conflict'::text, v_task.status, v_task.current_step;
    return;
  end if;
  if jsonb_typeof(v_task.latest_checkpoint) is distinct from 'object'
    or v_task.latest_checkpoint ->> 'schema_version'
      is distinct from 'agent_task_checkpoint_v1'
    or jsonb_typeof(v_task.latest_checkpoint -> 'contract')
      is distinct from 'object'
    or jsonb_typeof(
      v_task.latest_checkpoint -> 'contract' -> 'step_contracts' -> 'steps'
    ) is distinct from 'array' then
    return query
    select 'contract_invalid'::text, v_task.status, v_task.current_step;
    return;
  end if;

  perform 1
  from public.agent_steps
  where task_id = p_task_id
  order by position
  for update;

  select * into v_verifier
  from public.agent_steps
  where task_id = p_task_id
  order by position desc
  limit 1;

  select contract.value into v_verifier_contract
  from jsonb_array_elements(
    v_task.latest_checkpoint -> 'contract' -> 'step_contracts' -> 'steps'
  ) contract(value)
  where contract.value ->> 'position' = v_verifier.position::text
  limit 1;
  select count(*) into v_verifier_count
  from jsonb_array_elements(
    v_task.latest_checkpoint -> 'contract' -> 'step_contracts' -> 'steps'
  ) contract(value)
  where contract.value ->> 'capability' = 'verify';
  select count(*) into v_invalid_step_count
  from public.agent_steps
  where task_id = p_task_id
    and status not in ('completed', 'skipped');
  select count(*) into v_running_step_count
  from public.agent_steps
  where task_id = p_task_id and status = 'running';

  if v_verifier.id is null
    or jsonb_typeof(v_verifier_contract) is distinct from 'object'
    or v_verifier_contract ->> 'capability' is distinct from 'verify'
    or v_verifier.status <> 'completed'
    or v_verifier.attempt = 2147483647
    or v_verifier_count <> 1
    or v_invalid_step_count <> 0
    or v_running_step_count <> 0 then
    return query
    select 'verifier_invalid'::text, v_task.status, v_task.current_step;
    return;
  end if;

  v_receipts := coalesce(
    v_task.latest_checkpoint -> 'step_receipts',
    '[]'::jsonb
  );
  if jsonb_typeof(v_receipts) is distinct from 'array' then
    return query
    select 'contract_invalid'::text, v_task.status, v_task.current_step;
    return;
  end if;
  select count(*), (array_agg(receipt.value))[1]
  into v_receipt_count, v_receipt
  from jsonb_array_elements(v_receipts) receipt(value)
  where jsonb_typeof(receipt.value) = 'object'
    and receipt.value ->> 'kind' = 'agent_step_receipt_v1'
    and receipt.value ->> 'contract_version' = 'agent_step_contract_v1'
    and receipt.value ->> 'position' = v_verifier.position::text
    and receipt.value ->> 'attempt' = v_verifier.attempt::text
    and receipt.value ->> 'capability' = 'verify'
    and receipt.value ->> 'operation' = 'verify';
  if v_receipt_count <> 1
    or v_receipt ->> 'outcome' <> 'review_required' then
    return query
    select 'verification_result_invalid'::text,
      v_task.status, v_task.current_step;
    return;
  end if;
  if v_task.latest_checkpoint ? 'agent_verification_result' then
    if not public.agent_verifier_review_decision_ready_v1(
      p_task_id, v_verifier.id, v_verifier.attempt, v_receipt
    ) then
      return query
      select 'verification_result_invalid'::text,
        v_task.status, v_task.current_step;
      return;
    end if;
    v_retry_source := 'structured_current';
  else
    if jsonb_typeof(v_receipt -> 'postconditions') is distinct from 'array'
      or 1 <> (
        select count(*)
        from jsonb_array_elements(v_receipt -> 'postconditions') item(value)
        where item.value ->> 'code' = 'verifier_passed'
          and item.value ->> 'status' in ('fail', 'gap')
      )
      or exists (
        select 1
        from jsonb_array_elements(v_receipt -> 'postconditions') item(value)
        where jsonb_typeof(item.value) is distinct from 'object'
          or length(trim(coalesce(item.value ->> 'code', ''))) = 0
          or coalesce(item.value ->> 'status', '')
            not in ('pass', 'fail', 'gap')
          or (
            item.value ->> 'code' <> 'verifier_passed'
            and item.value ->> 'status' <> 'pass'
          )
      ) then
      return query
      select 'verification_result_invalid'::text,
        v_task.status, v_task.current_step;
      return;
    end if;
    v_retry_source := 'legacy_unstructured_review_gap';
  end if;

  if jsonb_typeof(v_receipt -> 'artifact_ids') is distinct from 'array'
    or jsonb_array_length(v_receipt -> 'artifact_ids') not between 1 and 30
    or jsonb_typeof(v_receipt -> 'verified_artifacts')
      is distinct from 'array'
    or jsonb_array_length(v_receipt -> 'verified_artifacts')
      > jsonb_array_length(v_receipt -> 'artifact_ids')
    or exists (
      select 1
      from jsonb_array_elements(v_receipt -> 'artifact_ids') artifact(value)
      where jsonb_typeof(artifact.value) is distinct from 'string'
        or artifact.value #>> '{}'
          !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    )
    or exists (
      select 1
      from jsonb_array_elements_text(
        v_receipt -> 'artifact_ids'
      ) artifact(id)
      group by artifact.id
      having count(*) > 1
    )
    or exists (
      select 1
      from jsonb_array_elements(
        v_receipt -> 'verified_artifacts'
      ) identity(value)
      where not public.agent_verifier_retry_identity_valid_v1(
        identity.value,
        v_receipt -> 'artifact_ids'
      )
    )
    or exists (
      select 1
      from (
        select coalesce(
          identity.value ->> 'document_id',
          identity.value ->> 'review_id'
        ) as artifact_id
        from jsonb_array_elements(
          v_receipt -> 'verified_artifacts'
        ) identity(value)
      ) verified
      group by verified.artifact_id
      having count(*) > 1
    )
    or exists (
      select 1
      from jsonb_array_elements_text(
        v_receipt -> 'artifact_ids'
      ) artifact(id)
      where not exists (
        select 1
        from public.agent_artifact_links link
        where link.task_id = p_task_id
          and link.artifact_type in ('draft', 'tabular_review')
          and link.artifact_id::text = artifact.id
      )
    ) then
    return query
    select 'artifacts_invalid'::text, v_task.status, v_task.current_step;
    return;
  end if;

  perform 1
  from public.agent_artifact_links
  where task_id = p_task_id
  for share;

  select coalesce(
    jsonb_agg(receipt.value order by receipt.ordinality),
    '[]'::jsonb
  ) into v_filtered_receipts
  from jsonb_array_elements(v_receipts)
    with ordinality receipt(value, ordinality)
  where receipt.value ->> 'position'
    is distinct from v_verifier.position::text;

  v_checkpoint := v_task.latest_checkpoint - array[
    'agent_verification_result',
    'agent_verification_repair',
    'artifact_reverification',
    'verifier_retry'
  ];
  v_checkpoint := jsonb_set(
    jsonb_set(
      v_checkpoint,
      '{step_receipts}',
      v_filtered_receipts,
      true
    ),
    '{verifier_retry}',
    jsonb_build_object(
      'kind', 'agent_task_verifier_retry_v1',
      'retry_id', trim(p_retry_id),
      'task_id', p_task_id,
      'verifier_step_id', v_verifier.id,
      'from_attempt', v_verifier.attempt,
      'attempt', v_verifier.attempt + 1,
      'source', v_retry_source,
      'requested_at', v_updated_at
    ),
    true
  );

  update public.agent_steps
  set
    status = 'running',
    attempt = attempt + 1,
    repair_attempt = 0,
    result_summary = null,
    result_data = null,
    updated_at = greatest(v_updated_at, updated_at + interval '1 microsecond')
  where id = v_verifier.id;

  update public.agent_tasks
  set
    status = 'verifying',
    current_step = v_verifier.id,
    latest_checkpoint = v_checkpoint,
    execution_lease_owner = null,
    execution_lease_expires_at = null,
    updated_at = greatest(v_updated_at, updated_at + interval '1 microsecond')
  where id = p_task_id;

  return query select 'started'::text, 'verifying'::text, v_verifier.id;
end;
$$;

revoke all on function public.start_agent_task_verifier_retry_v1(
  uuid, text, text
) from public, anon, authenticated;

grant execute on function public.start_agent_task_verifier_retry_v1(
  uuid, text, text
) to service_role;

comment on function public.start_agent_task_verifier_retry_v1(
  uuid, text, text
) is
  'Atomically restarts only the final Verifier from an exact current structured result or a fail-closed legacy review-gap receipt. Every listed Artifact remains Task-owned; verified identities may be a strict subset when the prior result itself identified an Artifact gap.';
