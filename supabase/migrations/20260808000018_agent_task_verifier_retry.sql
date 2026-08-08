-- Restart only the final Verifier for a completed Task whose current,
-- server-owned structured outcome is review_required. This transition does
-- not require or invent a prior Document revision: any bounded repair is
-- selected later from the fresh structured issue and fixed current Artifact.

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
        'from_attempt', 'attempt', 'requested_at'
      ] = '{}'::jsonb
      and v_existing_event ->> 'kind' = 'agent_task_verifier_retry_v1'
      and v_existing_event ->> 'task_id' = p_task_id::text
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
    or v_receipt ->> 'outcome' <> 'review_required'
    or not public.agent_verifier_review_decision_ready_v1(
      p_task_id, v_verifier.id, v_verifier.attempt, v_receipt
    ) then
    return query
    select 'verification_result_invalid'::text,
      v_task.status, v_task.current_step;
    return;
  end if;

  if jsonb_typeof(v_receipt -> 'artifact_ids') is distinct from 'array'
    or jsonb_array_length(v_receipt -> 'artifact_ids') not between 1 and 30
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
  'Atomically restarts only the final Verifier from one exact current review_required structured result; it never selects or mutates an Artifact.';
