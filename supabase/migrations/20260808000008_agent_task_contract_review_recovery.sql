-- Contract gold-flow recovery: allow one server-validated structured
-- disposition revision snapshot and resolve the verifier from the immutable
-- Step Contract for already-created Tasks. Re-applying the complete function
-- definitions keeps both clean installs and incremental upgrades equivalent.

-- Kernel v1 Batch 10d: serialize append-only lawyer decisions with revision
-- activation and publish each transition atomically on the owning Task row.

create or replace function public.record_agent_task_review_decision_v1(
  p_decision_id uuid,
  p_task_id uuid,
  p_user_id text,
  p_expected_latest_decision_id uuid,
  p_status text,
  p_note text,
  p_reviewer_email text,
  p_reviewer_name text,
  p_artifact_snapshot jsonb
)
returns table(outcome text, task_status text, current_step uuid)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_existing public.agent_task_review_decisions%rowtype;
  v_task public.agent_tasks%rowtype;
  v_latest_decision_id uuid;
  v_artifact_count integer;
  v_distinct_artifact_count integer;
  v_valid_artifact_count integer;
begin
  if p_decision_id is null
    or p_task_id is null
    or p_user_id is null
    or length(trim(p_user_id)) = 0
    or p_status is null
    or p_status not in ('approved', 'changes_requested')
    or p_note is null
    or length(p_note) > 4000
    or (p_status = 'changes_requested' and length(trim(p_note)) = 0)
    or (p_reviewer_email is not null and length(p_reviewer_email) > 320)
    or (p_reviewer_name is not null and length(p_reviewer_name) > 300)
    or jsonb_typeof(p_artifact_snapshot) is distinct from 'array'
    or jsonb_array_length(p_artifact_snapshot) > 20 then
    return query select 'invalid_input'::text, null::text, null::uuid;
    return;
  end if;

  select * into v_existing
  from public.agent_task_review_decisions
  where id = p_decision_id;
  if found then
    if v_existing.task_id = p_task_id
      and v_existing.reviewer_id = p_user_id
      and v_existing.status = p_status
      and v_existing.note = p_note
      and v_existing.reviewer_email is not distinct from p_reviewer_email
      and v_existing.reviewer_name is not distinct from p_reviewer_name
      and v_existing.artifact_snapshot = p_artifact_snapshot then
      return query select 'recorded'::text, null::text, null::uuid;
    else
      return query select 'conflict'::text, null::text, null::uuid;
    end if;
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
  if v_task.execution_lease_owner is not null
    and v_task.execution_lease_expires_at > clock_timestamp() then
    return query select 'lease_busy'::text, v_task.status, v_task.current_step;
    return;
  end if;
  if v_task.status <> 'completed' then
    return query select 'task_not_completed'::text, v_task.status, v_task.current_step;
    return;
  end if;

  select id into v_latest_decision_id
  from public.agent_task_review_decisions
  where task_id = p_task_id
  order by created_at desc, id desc
  limit 1;
  if v_latest_decision_id is distinct from p_expected_latest_decision_id then
    return query select 'conflict'::text, v_task.status, v_task.current_step;
    return;
  end if;

  if p_status = 'changes_requested' then
    if jsonb_array_length(p_artifact_snapshot) = 0 then
      null;
    elsif jsonb_array_length(p_artifact_snapshot) <> 1
      or jsonb_typeof(p_artifact_snapshot -> 0) is distinct from 'object'
      or p_artifact_snapshot -> 0 ->> 'kind' is distinct from 'contract_playbook_disposition_revision_v1'
      or jsonb_typeof(p_artifact_snapshot -> 0 -> 'decisions') is distinct from 'array'
      or jsonb_array_length(p_artifact_snapshot -> 0 -> 'decisions') not between 1 and 80
      or exists (
        select 1
        from jsonb_array_elements(p_artifact_snapshot -> 0 -> 'decisions') decision
        where jsonb_typeof(decision) is distinct from 'object'
          or coalesce(decision ->> 'finding_id', '') !~ '^finding-[a-f0-9]{24}$'
          or coalesce(decision ->> 'disposition', '') not in ('accept', 'comment', 'skip')
          or not (decision ? 'direction')
          or (
            decision -> 'direction' <> 'null'::jsonb
            and jsonb_typeof(decision -> 'direction') is distinct from 'string'
          )
          or (
            decision -> 'direction' <> 'null'::jsonb
            and decision ->> 'disposition' is distinct from 'comment'
          )
      ) then
      return query select 'invalid_input'::text, v_task.status, v_task.current_step;
      return;
    end if;
  else
    perform 1
    from public.documents d
    join jsonb_array_elements(p_artifact_snapshot) as artifacts(artifact)
      on d.id::text = artifact ->> 'document_id'
    join public.document_versions v
      on v.id::text = artifact ->> 'version_id'
      and v.document_id = d.id
    order by d.id, v.id
    for update of d, v;

    select
      count(*),
      count(distinct artifact ->> 'artifact_id')
    into v_artifact_count, v_distinct_artifact_count
    from jsonb_array_elements(p_artifact_snapshot) as artifacts(artifact);

    select count(*) into v_valid_artifact_count
    from jsonb_array_elements(p_artifact_snapshot) as artifacts(artifact)
    join public.agent_artifact_links l
      on l.task_id = p_task_id
      and l.artifact_type = artifact ->> 'artifact_type'
      and l.artifact_id = artifact ->> 'artifact_id'
      and l.purpose = artifact ->> 'purpose'
    join public.documents d
      on d.id::text = artifact ->> 'document_id'
    join public.document_versions v
      on v.id = d.current_version_id
      and v.id::text = artifact ->> 'version_id'
      and v.document_id = d.id
    where jsonb_typeof(artifact) = 'object'
      and artifact ->> 'artifact_type' in ('draft', 'tabular_review')
      and artifact ->> 'artifact_id' = artifact ->> 'document_id'
      and length(trim(coalesce(artifact ->> 'purpose', ''))) between 1 and 300
      and jsonb_typeof(artifact -> 'filename') = 'string'
      and length(trim(artifact ->> 'filename')) > 0
      and (
        artifact -> 'file_type' = 'null'::jsonb
        or jsonb_typeof(artifact -> 'file_type') = 'string'
      )
      and (
        artifact -> 'version_number' = 'null'::jsonb
        or jsonb_typeof(artifact -> 'version_number') = 'number'
      )
      and jsonb_typeof(artifact -> 'size_bytes') = 'number'
      and artifact ->> 'size_bytes' ~ '^[0-9]+$'
      and jsonb_typeof(artifact -> 'sha256') = 'string'
      and artifact ->> 'sha256' ~ '^sha256:[a-f0-9]{64}$'
      and d.project_id = v_task.matter_id
      and d.user_id = p_user_id
      and d.status = 'ready'
      and v.deleted_at is null
      and v.storage_path is not null;
    if v_artifact_count <> v_distinct_artifact_count
      or v_valid_artifact_count <> v_artifact_count then
      return query select 'invalid_artifacts'::text, v_task.status, v_task.current_step;
      return;
    end if;
  end if;

  insert into public.agent_task_review_decisions(
    id,
    task_id,
    status,
    reviewer_id,
    reviewer_email,
    reviewer_name,
    note,
    artifact_snapshot
  ) values (
    p_decision_id,
    p_task_id,
    p_status,
    p_user_id,
    p_reviewer_email,
    p_reviewer_name,
    p_note,
    p_artifact_snapshot
  );

  return query select 'recorded'::text, v_task.status, v_task.current_step;
end;
$$;

create or replace function public.start_agent_task_revision_v1(
  p_task_id uuid,
  p_user_id text,
  p_revision_id uuid,
  p_review_decision_id uuid,
  p_first_step_id uuid,
  p_revision_start integer,
  p_expected_first_step_attempt integer,
  p_latest_checkpoint jsonb
)
returns table(outcome text, task_status text, current_step uuid)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_task public.agent_tasks%rowtype;
  v_first public.agent_steps%rowtype;
  v_latest_decision public.agent_task_review_decisions%rowtype;
  v_revision_step_count integer;
  v_invalid_step_count integer;
  v_running_step_count integer;
  v_updated_at timestamptz := clock_timestamp();
  v_revision jsonb;
begin
  v_revision := p_latest_checkpoint -> 'revision_request';
  if p_task_id is null
    or p_user_id is null
    or length(trim(p_user_id)) = 0
    or p_revision_id is null
    or p_review_decision_id is null
    or p_first_step_id is null
    or p_revision_start is null
    or p_revision_start < 0
    or p_revision_start > 100
    or p_expected_first_step_attempt is null
    or p_expected_first_step_attempt < 0
    or p_expected_first_step_attempt = 2147483647
    or jsonb_typeof(p_latest_checkpoint) is distinct from 'object'
    or jsonb_typeof(v_revision) is distinct from 'object'
    or v_revision ->> 'kind' is distinct from 'agent_task_revision_v1'
    or v_revision ->> 'revision_id' is distinct from p_revision_id::text
    or v_revision ->> 'review_decision_id'
      is distinct from p_review_decision_id::text
    or v_revision ->> 'first_step_id' is distinct from p_first_step_id::text
    or jsonb_typeof(v_revision -> 'revision_start') is distinct from 'number'
    or v_revision ->> 'revision_start' is distinct from p_revision_start::text
    or jsonb_typeof(v_revision -> 'attempt') is distinct from 'number'
    or v_revision ->> 'attempt'
      is distinct from (p_expected_first_step_attempt + 1)::text
    or jsonb_typeof(v_revision -> 'requested_at') is distinct from 'string'
    or length(trim(coalesce(v_revision ->> 'requested_at', ''))) = 0 then
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
  if v_task.status <> 'completed' then
    return query select 'conflict'::text, v_task.status, v_task.current_step;
    return;
  end if;
  if v_task.latest_checkpoint -> 'fixed_matter_context'
      is distinct from p_latest_checkpoint -> 'fixed_matter_context'
    or v_task.latest_checkpoint -> 'schema_version'
      is distinct from p_latest_checkpoint -> 'schema_version'
    or v_task.latest_checkpoint -> 'contract'
      is distinct from p_latest_checkpoint -> 'contract'
    or v_task.latest_checkpoint -> 'assignment_revisions'
      is distinct from p_latest_checkpoint -> 'assignment_revisions'
    or v_task.latest_checkpoint -> 'resolved_required_input_ids'
      is distinct from p_latest_checkpoint -> 'resolved_required_input_ids'
    or v_task.latest_checkpoint -> 'step_receipts'
      is distinct from p_latest_checkpoint -> 'step_receipts' then
    return query select 'invalid_input'::text, v_task.status, v_task.current_step;
    return;
  end if;
  if v_task.execution_lease_owner is not null
    and v_task.execution_lease_expires_at > clock_timestamp() then
    return query select 'lease_busy'::text, v_task.status, v_task.current_step;
    return;
  end if;

  select * into v_latest_decision
  from public.agent_task_review_decisions
  where task_id = p_task_id
  order by created_at desc, id desc
  limit 1
  for update;
  if v_latest_decision.id is distinct from p_review_decision_id
    or v_latest_decision.status <> 'changes_requested'
    or length(trim(v_latest_decision.note)) = 0 then
    return query select 'conflict'::text, v_task.status, v_task.current_step;
    return;
  end if;

  perform 1
  from public.agent_steps
  where task_id = p_task_id
  order by position
  for update;
  select * into v_first
  from public.agent_steps
  where id = p_first_step_id
    and task_id = p_task_id
    and position = p_revision_start;
  select count(*) into v_revision_step_count
  from public.agent_steps
  where task_id = p_task_id and position >= p_revision_start;
  select count(*) into v_invalid_step_count
  from public.agent_steps
  where task_id = p_task_id and status not in ('completed', 'skipped');
  select count(*) into v_running_step_count
  from public.agent_steps
  where task_id = p_task_id and status = 'running';
  if v_first.id is null
    or v_first.attempt <> p_expected_first_step_attempt
    or v_first.status not in ('completed', 'skipped')
    or v_revision_step_count = 0
    or v_invalid_step_count <> 0
    or v_running_step_count <> 0 then
    return query select 'conflict'::text, v_task.status, v_task.current_step;
    return;
  end if;

  update public.agent_steps
  set status = 'pending', result_summary = null, updated_at = v_updated_at
  where task_id = p_task_id and position >= p_revision_start;
  update public.agent_steps
  set
    status = 'running',
    attempt = attempt + 1,
    updated_at = v_updated_at
  where id = p_first_step_id;
  update public.agent_tasks
  set
    status = 'running',
    current_step = p_first_step_id,
    latest_checkpoint = p_latest_checkpoint,
    execution_lease_owner = null,
    execution_lease_expires_at = null,
    updated_at = v_updated_at
  where id = p_task_id;

  return query select 'revised'::text, 'running'::text, p_first_step_id;
end;
$$;

revoke execute on function public.record_agent_task_review_decision_v1(
  uuid, uuid, text, uuid, text, text, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.record_agent_task_review_decision_v1(
  uuid, uuid, text, uuid, text, text, text, text, jsonb
) to service_role;

revoke execute on function public.start_agent_task_revision_v1(
  uuid, text, uuid, uuid, uuid, integer, integer, jsonb
) from public, anon, authenticated;
grant execute on function public.start_agent_task_revision_v1(
  uuid, text, uuid, uuid, uuid, integer, integer, jsonb
) to service_role;

comment on function public.record_agent_task_review_decision_v1(
  uuid, uuid, text, uuid, text, text, text, text, jsonb
) is 'Atomically records one current lawyer review decision for a completed Task.';

comment on function public.start_agent_task_revision_v1(
  uuid, text, uuid, uuid, uuid, integer, integer, jsonb
) is 'Atomically resets one proven revision range and starts its first Step.';

-- Kernel v1 Batch 10p: atomically invalidate only the completed verifier after
-- one Task-owned draft receives a new current Document Version.

create or replace function public.start_agent_task_artifact_reverification_v1(
  p_task_id uuid,
  p_user_id text,
  p_document_id uuid,
  p_base_version_id uuid,
  p_version_id uuid,
  p_mutation_id text
)
returns table(outcome text, task_status text, current_step uuid)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_task public.agent_tasks%rowtype;
  v_document public.documents%rowtype;
  v_base_version public.document_versions%rowtype;
  v_version public.document_versions%rowtype;
  v_verifier public.agent_steps%rowtype;
  v_verifier_contract jsonb;
  v_verifier_count integer;
  v_invalid_step_count integer;
  v_running_step_count integer;
  v_existing_event jsonb;
  v_receipts jsonb;
  v_filtered_receipts jsonb;
  v_checkpoint jsonb;
  v_updated_at timestamptz := clock_timestamp();
begin
  if p_task_id is null
    or p_user_id is null
    or length(trim(p_user_id)) = 0
    or p_document_id is null
    or p_base_version_id is null
    or p_version_id is null
    or p_base_version_id = p_version_id
    or p_mutation_id is null
    or length(trim(p_mutation_id)) not between 1 and 200 then
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

  select * into v_document
  from public.documents
  where id = p_document_id
    and user_id = p_user_id
    and project_id = v_task.matter_id
  for update;
  if not found then
    return query select 'artifact_not_found'::text, v_task.status, v_task.current_step;
    return;
  end if;
  if v_document.current_version_id is distinct from p_version_id then
    return query select 'version_conflict'::text, v_task.status, v_task.current_step;
    return;
  end if;

  select * into v_base_version
  from public.document_versions
  where id = p_base_version_id
    and document_id = p_document_id
    and deleted_at is null;
  select * into v_version
  from public.document_versions
  where id = p_version_id
    and document_id = p_document_id
    and deleted_at is null;
  if v_base_version.id is null or v_version.id is null then
    return query select 'version_conflict'::text, v_task.status, v_task.current_step;
    return;
  end if;

  perform 1
  from public.agent_artifact_links
  where task_id = p_task_id
    and artifact_type = 'draft'
    and artifact_id = p_document_id::text;
  if not found then
    return query select 'artifact_not_found'::text, v_task.status, v_task.current_step;
    return;
  end if;

  v_existing_event := v_task.latest_checkpoint -> 'artifact_reverification';
  if jsonb_typeof(v_existing_event) = 'object'
    and v_existing_event ->> 'mutation_id' = trim(p_mutation_id) then
    if v_existing_event ->> 'kind' = 'agent_task_artifact_reverification_v1'
      and v_existing_event ->> 'task_id' = p_task_id::text
      and v_existing_event ->> 'document_id' = p_document_id::text
      and v_existing_event ->> 'base_version_id' = p_base_version_id::text
      and v_existing_event ->> 'version_id' = p_version_id::text then
      return query select 'already_started'::text, v_task.status, v_task.current_step;
    else
      return query select 'conflict'::text, v_task.status, v_task.current_step;
    end if;
    return;
  end if;

  if v_task.execution_lease_owner is not null
    and v_task.execution_lease_expires_at > clock_timestamp() then
    return query select 'lease_busy'::text, v_task.status, v_task.current_step;
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
    return query select 'contract_invalid'::text, v_task.status, v_task.current_step;
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
  ) as contract(value)
  where contract.value ->> 'position' = v_verifier.position::text
  limit 1;
  select count(*) into v_verifier_count
  from jsonb_array_elements(
    v_task.latest_checkpoint -> 'contract' -> 'step_contracts' -> 'steps'
  ) as contract(value)
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
    return query select 'verifier_invalid'::text, v_task.status, v_task.current_step;
    return;
  end if;

  v_receipts := coalesce(v_task.latest_checkpoint -> 'step_receipts', '[]'::jsonb);
  if jsonb_typeof(v_receipts) is distinct from 'array' then
    return query select 'contract_invalid'::text, v_task.status, v_task.current_step;
    return;
  end if;
  select coalesce(
    jsonb_agg(receipt.value order by receipt.ordinality),
    '[]'::jsonb
  ) into v_filtered_receipts
  from jsonb_array_elements(v_receipts)
    with ordinality as receipt(value, ordinality)
  where receipt.value ->> 'position' is distinct from v_verifier.position::text;

  v_checkpoint := jsonb_set(
    jsonb_set(
      v_task.latest_checkpoint,
      '{step_receipts}',
      v_filtered_receipts,
      true
    ),
    '{artifact_reverification}',
    jsonb_build_object(
      'kind', 'agent_task_artifact_reverification_v1',
      'mutation_id', trim(p_mutation_id),
      'task_id', p_task_id,
      'document_id', p_document_id,
      'base_version_id', p_base_version_id,
      'version_id', p_version_id,
      'verifier_step_id', v_verifier.id,
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

revoke execute on function public.start_agent_task_artifact_reverification_v1(
  uuid, text, uuid, uuid, uuid, text
) from public, anon, authenticated;

grant execute on function public.start_agent_task_artifact_reverification_v1(
  uuid, text, uuid, uuid, uuid, text
) to service_role;

comment on function public.start_agent_task_artifact_reverification_v1(
  uuid, text, uuid, uuid, uuid, text
) is 'Atomically invalidates only the completed verifier after a Task-owned draft advances to one exact current Version.';
