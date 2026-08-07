-- The reservation is intentionally checkpoint-only. It is a persistent
-- fencing token around an outbound model request, not a second task runtime
-- or a new source of record. A dispatched request never expires implicitly.
create or replace function public.reserve_agent_task_suffix_replan_v1(
  p_task_id uuid,
  p_user_id text,
  p_expected_updated_at timestamptz,
  p_expected_current_step uuid,
  p_pivot_position integer,
  p_sanitized_user_input jsonb,
  p_server_required_input jsonb,
  p_accepted_input_digest text,
  p_execution_model text,
  p_created_at timestamptz
)
returns table(reservation_id uuid, updated_at timestamptz)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_task public.agent_tasks%rowtype;
  v_pivot public.agent_steps%rowtype;
  v_pending jsonb;
  v_reservation jsonb;
  v_reservation_id uuid := gen_random_uuid();
  v_checkpoint jsonb;
begin
  if p_user_id is null or char_length(btrim(p_user_id)) = 0
    or p_expected_updated_at is null or p_expected_current_step is null
    or p_pivot_position is null or p_pivot_position < 0 or p_pivot_position > 5
    or p_created_at is null or char_length(btrim(coalesce(p_execution_model, ''))) = 0
    or coalesce(p_accepted_input_digest, '') !~ '^sha256:[0-9a-f]{64}$'
    or jsonb_typeof(p_sanitized_user_input) is distinct from 'object'
    or jsonb_typeof(p_server_required_input) is distinct from 'object' then
    raise exception 'invalid suffix replan reservation input';
  end if;
  select * into v_task from public.agent_tasks where id = p_task_id for update;
  if not found then raise exception 'agent task not found'; end if;
  if v_task.user_id <> p_user_id or v_task.status <> 'waiting_input'
    or v_task.updated_at <> p_expected_updated_at
    or v_task.current_step is distinct from p_expected_current_step
    or v_task.execution_model is distinct from p_execution_model then
    raise exception 'stale or ineligible suffix replan reservation';
  end if;
  if jsonb_typeof(v_task.latest_checkpoint) is distinct from 'object'
    or v_task.latest_checkpoint ? 'suffix_replan_v1' then
    raise exception 'a Work Task permits only one suffix replan';
  end if;
  perform 1 from public.agent_steps locked_step
    where locked_step.task_id = p_task_id for update;
  select pivot_step.* into v_pivot from public.agent_steps pivot_step
    where pivot_step.task_id = p_task_id and pivot_step.position = p_pivot_position;
  if not found or v_pivot.id <> p_expected_current_step or v_pivot.status <> 'blocked'
    or exists (select 1 from public.agent_steps prefix_step where prefix_step.task_id = p_task_id
      and prefix_step.position < p_pivot_position and prefix_step.status <> 'completed')
    or exists (select 1 from public.agent_steps suffix_step where suffix_step.task_id = p_task_id
      and suffix_step.position > p_pivot_position and suffix_step.status <> 'pending') then
    raise exception 'task plan is not a completed prefix plus blocked pivot plus pending suffix';
  end if;
  if (p_sanitized_user_input ->> 'step_id') is distinct from p_expected_current_step::text
    or (v_task.latest_checkpoint -> 'required_input') is distinct from p_server_required_input
    or jsonb_typeof(p_sanitized_user_input -> 'document_ids') is distinct from 'array'
    or jsonb_array_length(p_sanitized_user_input -> 'document_ids') <> 0
    or jsonb_typeof(p_sanitized_user_input -> 'responses') is distinct from 'array'
    or jsonb_array_length(p_sanitized_user_input -> 'responses') < 1
    or jsonb_typeof(p_server_required_input -> 'items') is distinct from 'array'
    or jsonb_array_length(p_server_required_input -> 'items')
      <> jsonb_array_length(p_sanitized_user_input -> 'responses')
    or exists (select 1 from jsonb_array_elements(p_sanitized_user_input -> 'responses') response(value)
      where jsonb_typeof(response.value) is distinct from 'object'
        or (select count(*) from jsonb_object_keys(response.value)) <> 3
        or response.value ->> 'kind' is distinct from 'choice'
        or char_length(btrim(coalesce(response.value ->> 'id', ''))) not between 1 and 80
        or char_length(btrim(coalesce(response.value ->> 'answer', ''))) not between 1 and 1000)
    or (p_server_required_input ->> 'resume_strategy') is distinct from 'replan_remaining'
    or (p_server_required_input ->> 'step_id') is distinct from p_expected_current_step::text
    or exists (select 1 from jsonb_array_elements(p_server_required_input -> 'items') item(value)
      where jsonb_typeof(item.value) is distinct from 'object' or item.value ->> 'kind' is distinct from 'choice')
    or exists (
      select 1 from jsonb_array_elements(p_server_required_input -> 'items') item(value)
      where (select count(*) from jsonb_array_elements(p_sanitized_user_input -> 'responses') response(value)
        where response.value ->> 'id' = item.value ->> 'id' and response.value ->> 'kind' = 'choice') <> 1)
    or exists (
      select 1 from jsonb_array_elements(p_sanitized_user_input -> 'responses') response(value)
      where (select count(*) from jsonb_array_elements(p_server_required_input -> 'items') item(value)
        where item.value ->> 'id' = response.value ->> 'id' and item.value ->> 'kind' = 'choice') <> 1) then
    raise exception 'suffix replan reservation requires validated choice-only input';
  end if;
  v_pending := v_task.latest_checkpoint -> 'suffix_replan_pending_v1';
  v_reservation := v_task.latest_checkpoint -> 'suffix_replan_reservation_v1';
  if jsonb_typeof(v_reservation) = 'object'
    and v_reservation ->> 'phase' = 'model_dispatched' then
    raise exception 'suffix replan model request is already reserved';
  end if;
  if (jsonb_typeof(v_pending) = 'object' and (
        jsonb_typeof(v_reservation) is distinct from 'object'
        or v_reservation ->> 'phase' is distinct from 'retry_available'))
    or (jsonb_typeof(v_pending) is distinct from 'object'
        and jsonb_typeof(v_reservation) = 'object') then
    raise exception 'suffix replan reservation state is invalid';
  end if;
  if jsonb_typeof(v_pending) = 'object' and (
      v_pending ->> 'accepted_input_digest' is distinct from p_accepted_input_digest
      or v_pending ->> 'trigger_step_id' is distinct from p_expected_current_step::text
      or v_pending ->> 'model' is distinct from p_execution_model
      or (v_task.latest_checkpoint -> 'user_input') is distinct from p_sanitized_user_input
      or (v_task.latest_checkpoint -> 'required_input') is distinct from p_server_required_input
    ) then
    raise exception 'suffix replan retry must use the exact accepted input and model';
  end if;
  v_checkpoint := (v_task.latest_checkpoint - 'suffix_replan_v1' - 'suffix_replan_retry_v1')
    || jsonb_build_object(
      'user_input', p_sanitized_user_input,
      'required_input', p_server_required_input,
      'suffix_replan_pending_v1', jsonb_build_object(
        'kind', 'suffix_replan_pending_v1', 'accepted_input_digest', p_accepted_input_digest,
        'pivot_position', p_pivot_position, 'trigger_step_id', p_expected_current_step::text,
        'model', p_execution_model, 'created_at', p_created_at),
      'suffix_replan_reservation_v1', jsonb_build_object(
        'kind', 'suffix_replan_reservation_v1', 'reservation_id', v_reservation_id::text,
        'phase', 'model_dispatched', 'accepted_input_digest', p_accepted_input_digest,
        'pivot_position', p_pivot_position, 'trigger_step_id', p_expected_current_step::text,
        'model', p_execution_model, 'created_at', p_created_at));
  update public.agent_tasks set latest_checkpoint = v_checkpoint, updated_at = now()
    where id = p_task_id;
  return query select v_reservation_id, returned_task.updated_at
    from public.agent_tasks returned_task where returned_task.id = p_task_id;
end;
$$;

create or replace function public.mark_agent_task_suffix_replan_retryable_v1(
  p_task_id uuid, p_user_id text, p_expected_updated_at timestamptz,
  p_expected_current_step uuid, p_reservation_id uuid, p_retry_receipt jsonb
)
returns table(updated_at timestamptz)
language plpgsql security definer set search_path = pg_catalog, public, pg_temp
as $$
declare v_task public.agent_tasks%rowtype; v_reservation jsonb; v_pending jsonb; v_checkpoint jsonb;
begin
  if p_reservation_id is null or jsonb_typeof(p_retry_receipt) is distinct from 'object'
    or (select count(*) from jsonb_object_keys(p_retry_receipt)) <> 5
    or p_retry_receipt ->> 'kind' is distinct from 'suffix_replan_retry_v1'
    or coalesce(p_retry_receipt ->> 'reason', '') not in ('transient_exhausted', 'proposal_invalid')
    or jsonb_typeof(p_retry_receipt -> 'attempts') is distinct from 'number'
    or coalesce(p_retry_receipt ->> 'attempts', '') !~ '^[1-4]$'
    or jsonb_typeof(p_retry_receipt -> 'model') is distinct from 'string'
    or char_length(btrim(coalesce(p_retry_receipt ->> 'model', ''))) = 0
    or jsonb_typeof(p_retry_receipt -> 'created_at') is distinct from 'string'
    or char_length(btrim(coalesce(p_retry_receipt ->> 'created_at', ''))) = 0 then
    raise exception 'invalid suffix replan retry receipt';
  end if;
  select * into v_task from public.agent_tasks where id = p_task_id for update;
  if not found or v_task.user_id <> p_user_id or v_task.status <> 'waiting_input'
    or v_task.updated_at <> p_expected_updated_at or v_task.current_step is distinct from p_expected_current_step then
    raise exception 'stale suffix replan retry';
  end if;
  v_reservation := v_task.latest_checkpoint -> 'suffix_replan_reservation_v1';
  v_pending := v_task.latest_checkpoint -> 'suffix_replan_pending_v1';
  if jsonb_typeof(v_reservation) is distinct from 'object'
    or v_reservation ->> 'reservation_id' is distinct from p_reservation_id::text
    or v_reservation ->> 'phase' is distinct from 'model_dispatched'
    or v_reservation ->> 'model' is distinct from v_task.execution_model
    or p_retry_receipt ->> 'model' is distinct from v_task.execution_model
    or jsonb_typeof(v_pending) is distinct from 'object'
    or v_pending ->> 'model' is distinct from v_task.execution_model then
    raise exception 'suffix replan reservation is no longer current';
  end if;
  v_checkpoint := jsonb_set(v_task.latest_checkpoint, '{suffix_replan_reservation_v1,phase}', '"retry_available"'::jsonb, true)
    || jsonb_build_object('suffix_replan_retry_v1', p_retry_receipt);
  update public.agent_tasks set latest_checkpoint = v_checkpoint, updated_at = now() where id = p_task_id;
  return query select returned_task.updated_at
    from public.agent_tasks returned_task where returned_task.id = p_task_id;
end;
$$;

-- Atomic, server-owned replacement of the unfinished suffix of one Work Task.
-- This is intentionally service_role-only: authenticated clients must never be
-- able to submit a plan, pins, contracts, or checkpoint patch directly.

create or replace function public.apply_agent_task_suffix_replan_v1(
  p_task_id uuid,
  p_user_id text,
  p_expected_updated_at timestamptz,
  p_expected_current_step uuid,
  p_pivot_position integer,
  p_server_compiled_suffix jsonb,
  p_server_compiled_step_contracts jsonb,
  p_server_replan_receipt jsonb,
  p_server_required_input jsonb,
  p_sanitized_user_input jsonb,
  p_reservation_id uuid
)
returns table(task_id uuid, first_step_id uuid, status text, updated_at timestamptz)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_task public.agent_tasks%rowtype;
  v_pivot public.agent_steps%rowtype;
  v_old_repair_attempt smallint := 0;
  v_first_step_id uuid;
  v_first_capability text;
  v_total_steps integer;
  v_suffix_count integer;
  v_checkpoint jsonb;
  v_required_input jsonb;
  v_user_input jsonb;
  v_item jsonb;
  v_suffix_index integer;
begin
  if p_user_id is null or char_length(btrim(p_user_id)) = 0
    or p_expected_updated_at is null or p_expected_current_step is null
    or p_pivot_position is null or p_pivot_position < 0 or p_pivot_position > 5
    or p_reservation_id is null then
    raise exception 'invalid suffix replan identity or pivot';
  end if;
  if jsonb_typeof(p_server_compiled_suffix) is distinct from 'array'
    or jsonb_typeof(p_server_compiled_step_contracts) is distinct from 'object'
    or jsonb_typeof(p_server_replan_receipt) is distinct from 'object'
    or jsonb_typeof(p_server_required_input) is distinct from 'object'
    or jsonb_typeof(p_sanitized_user_input) is distinct from 'object' then
    raise exception 'suffix replan inputs must be server-compiled JSON objects';
  end if;

  select * into v_task
  from public.agent_tasks
  where id = p_task_id
  for update;
  if not found then raise exception 'agent task not found'; end if;
  if v_task.user_id <> p_user_id
    or v_task.status <> 'waiting_input'
    or v_task.updated_at <> p_expected_updated_at
    or v_task.current_step is distinct from p_expected_current_step then
    raise exception 'stale or ineligible suffix replan';
  end if;
  if jsonb_typeof(v_task.latest_checkpoint) is distinct from 'object'
    or jsonb_typeof(v_task.latest_checkpoint -> 'contract') is distinct from 'object'
    or jsonb_typeof(v_task.latest_checkpoint #> '{contract,step_contracts,steps}') is distinct from 'array' then
    raise exception 'task has no immutable Step Contract set';
  end if;
  if v_task.latest_checkpoint ? 'suffix_replan_v1' then
    raise exception 'a Work Task permits only one suffix replan';
  end if;
  if jsonb_typeof(v_task.latest_checkpoint -> 'suffix_replan_reservation_v1') is distinct from 'object'
    or (v_task.latest_checkpoint #>> '{suffix_replan_reservation_v1,reservation_id}') is distinct from p_reservation_id::text
    or (v_task.latest_checkpoint #>> '{suffix_replan_reservation_v1,phase}') is distinct from 'model_dispatched'
    or (v_task.latest_checkpoint #>> '{suffix_replan_reservation_v1,model}') is distinct from v_task.execution_model
    or (v_task.latest_checkpoint #>> '{suffix_replan_pending_v1,accepted_input_digest}')
      is distinct from p_server_replan_receipt ->> 'accepted_input_digest'
    or (v_task.latest_checkpoint #>> '{suffix_replan_pending_v1,trigger_step_id}')
      is distinct from p_expected_current_step::text
    or (v_task.latest_checkpoint #>> '{suffix_replan_pending_v1,pivot_position}')
      is distinct from p_pivot_position::text
    or (v_task.latest_checkpoint -> 'user_input') is distinct from p_sanitized_user_input
    or (v_task.latest_checkpoint -> 'required_input') is distinct from p_server_required_input then
    raise exception 'suffix replan reservation does not match final apply';
  end if;

  -- Lock the whole plan before validating or replacing it. A waiting-input
  -- task must already have had its active step blocked; a running worker is
  -- never safe to replan around.
  perform 1
  from public.agent_steps locked_step
  where locked_step.task_id = p_task_id
  for update;
  if exists (
    select 1
    from public.agent_steps running_step
    where running_step.task_id = p_task_id
      and running_step.status = 'running'
  ) then
    raise exception 'cannot replan while a task step is running';
  end if;
  select pivot_step.* into v_pivot
  from public.agent_steps pivot_step
  where pivot_step.task_id = p_task_id
    and pivot_step.position = p_pivot_position;
  if not found or v_pivot.id <> p_expected_current_step or v_pivot.status <> 'blocked' then
    raise exception 'replan pivot must be the current blocked step';
  end if;
  if exists (
    select 1
    from public.agent_steps prefix_step
    where prefix_step.task_id = p_task_id
      and prefix_step.position < p_pivot_position
      and prefix_step.status <> 'completed'
  ) or exists (
    select 1
    from public.agent_steps suffix_step
    where suffix_step.task_id = p_task_id
      and suffix_step.position > p_pivot_position
      and suffix_step.status <> 'pending'
  ) then
    raise exception 'task plan is not a completed prefix plus replaceable suffix';
  end if;
  if (
    select count(*)
    from public.agent_steps counted_step
    where counted_step.task_id = p_task_id
  ) <> jsonb_array_length(v_task.latest_checkpoint #> '{contract,step_contracts,steps}')
    or (
      select count(*)
      from public.agent_steps positioned_step
      where positioned_step.task_id = p_task_id
        and positioned_step.position between 0 and
          jsonb_array_length(v_task.latest_checkpoint #> '{contract,step_contracts,steps}') - 1
    ) <> jsonb_array_length(v_task.latest_checkpoint #> '{contract,step_contracts,steps}') then
    raise exception 'persisted steps do not match the immutable Step Contract set';
  end if;

  v_suffix_count := jsonb_array_length(p_server_compiled_suffix);
  v_total_steps := p_pivot_position + v_suffix_count;
  if v_suffix_count < 1 or v_total_steps < 3 or v_total_steps > 6 then
    raise exception 'replanned Work Task must contain three to six steps';
  end if;
  if (p_server_compiled_step_contracts ->> 'kind') is distinct from 'agent_step_contract_set_v1'
    or jsonb_typeof(p_server_compiled_step_contracts -> 'steps') is distinct from 'array'
    or jsonb_array_length(p_server_compiled_step_contracts -> 'steps') <> v_total_steps then
    raise exception 'invalid server-compiled Step Contract set';
  end if;
  if (select count(*) from jsonb_object_keys(p_server_replan_receipt)) <> 9
    or (p_server_replan_receipt ->> 'kind') is distinct from 'suffix_replan_v1'
    or (p_server_replan_receipt ->> 'replan_count') is distinct from '1'
    or (p_server_replan_receipt ->> 'pivot_position') is distinct from p_pivot_position::text
    or (p_server_replan_receipt ->> 'trigger_step_id') is distinct from p_expected_current_step::text
    or coalesce(p_server_replan_receipt ->> 'accepted_input_digest', '') !~ '^sha256:[0-9a-f]{64}$'
    or coalesce(p_server_replan_receipt ->> 'completed_prefix_digest', '') !~ '^sha256:[0-9a-f]{64}$'
    or jsonb_typeof(p_server_replan_receipt -> 'completed_prefix_positions') is distinct from 'array'
    or jsonb_array_length(p_server_replan_receipt -> 'completed_prefix_positions') <> p_pivot_position
    or (p_server_replan_receipt ->> 'workflow_id') is distinct from
      (v_task.latest_checkpoint #>> '{contract,context_manifest,workflow,id}')
    or char_length(btrim(coalesce(p_server_replan_receipt ->> 'created_at', ''))) = 0
    or (select count(*) from jsonb_object_keys(p_sanitized_user_input)) not in (5, 6)
    or (p_sanitized_user_input ->> 'step_id') is distinct from p_expected_current_step::text
    or (p_sanitized_user_input ->> 'attempt') is distinct from (v_pivot.attempt + 1)::text
    or (p_sanitized_user_input ->> 'submitted_at') is distinct from
      (p_server_replan_receipt ->> 'created_at')
    or jsonb_typeof(p_sanitized_user_input -> 'document_ids') is distinct from 'array'
    or jsonb_typeof(p_sanitized_user_input -> 'responses') is distinct from 'array'
    or jsonb_array_length(p_sanitized_user_input -> 'document_ids') <> 0
    or jsonb_array_length(p_sanitized_user_input -> 'responses') < 1
    or jsonb_array_length(p_sanitized_user_input -> 'responses') > 12
    or char_length(coalesce(p_sanitized_user_input ->> 'message', '')) > 4000 then
    raise exception 'invalid suffix replan receipt or sanitized user input';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_server_replan_receipt -> 'completed_prefix_positions')
      with ordinality p(value, ordinality)
    where p.value is distinct from to_jsonb((p.ordinality - 1)::integer)
  ) then
    raise exception 'suffix replan receipt does not match the completed prefix';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_sanitized_user_input -> 'responses') r(value)
    where jsonb_typeof(r.value) is distinct from 'object'
      or (select count(*) from jsonb_object_keys(r.value)) <> 3
      or (r.value ->> 'kind') is distinct from 'choice'
      or char_length(btrim(coalesce(r.value ->> 'id', ''))) = 0
      or char_length(r.value ->> 'id') > 80
      or char_length(btrim(coalesce(r.value ->> 'answer', ''))) = 0
      or char_length(r.value ->> 'answer') > 1000
  ) then raise exception 'first suffix replan accepts only validated choice responses'; end if;
  if (select count(*) from jsonb_object_keys(p_server_required_input)) <> 7
    or (p_server_required_input ->> 'kind') is distinct from 'required_input_v1'
    or (p_server_required_input ->> 'resume_strategy') is distinct from 'replan_remaining'
    or (p_server_required_input ->> 'step_id') is distinct from p_expected_current_step::text
    or coalesce(p_server_required_input ->> 'reason_code', '') not in ('missing_fact', 'lawyer_choice')
    or jsonb_typeof(p_server_required_input -> 'items') is distinct from 'array'
    or jsonb_array_length(p_server_required_input -> 'items') < 1
    or jsonb_array_length(p_server_required_input -> 'items') > 12
    or jsonb_array_length(p_server_required_input -> 'items') <>
      jsonb_array_length(p_sanitized_user_input -> 'responses')
    or char_length(btrim(coalesce(p_server_required_input ->> 'prompt', ''))) = 0
    or char_length(p_server_required_input ->> 'prompt') > 4000
    or char_length(btrim(coalesce(p_server_required_input ->> 'created_at', ''))) = 0 then
    raise exception 'invalid server-required input for suffix replan';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_server_required_input -> 'items') item(value)
    where jsonb_typeof(item.value) is distinct from 'object'
      or (item.value ->> 'kind') is distinct from 'choice'
      or (
        select count(*)
        from jsonb_array_elements(p_sanitized_user_input -> 'responses') response(value)
        where response.value ->> 'id' = item.value ->> 'id'
          and response.value ->> 'kind' = 'choice'
      ) <> 1
  ) or exists (
    select 1
    from jsonb_array_elements(p_sanitized_user_input -> 'responses') response(value)
    where (
      select count(*)
      from jsonb_array_elements(p_server_required_input -> 'items') item(value)
      where item.value ->> 'id' = response.value ->> 'id'
        and item.value ->> 'kind' = 'choice'
    ) <> 1
  ) then
    raise exception 'choice responses do not match the server-required input';
  end if;

  for v_item, v_suffix_index in select value, ordinality::integer - 1
    from jsonb_array_elements(p_server_compiled_suffix) with ordinality loop
    if jsonb_typeof(v_item) is distinct from 'object' or (select count(*) from jsonb_object_keys(v_item)) <> 4
      or not (v_item ?& array['position','capability','title','expected_output'])
      or (v_item ->> 'position') is distinct from (p_pivot_position + v_suffix_index)::text
      or coalesce(v_item ->> 'capability', '') not in ('read_sources','analyze','create_tabular','create_draft','verify')
      or char_length(btrim(coalesce(v_item ->> 'title', ''))) not between 3 and 80
      or char_length(btrim(coalesce(v_item ->> 'expected_output', ''))) not between 8 and 500 then
      raise exception 'invalid compiled suffix step';
    end if;
    if (p_server_compiled_step_contracts #>> array['steps', (p_pivot_position + v_suffix_index)::text, 'position'])
        is distinct from (p_pivot_position + v_suffix_index)::text
      or (p_server_compiled_step_contracts #>> array['steps', (p_pivot_position + v_suffix_index)::text, 'capability'])
        is distinct from (v_item ->> 'capability') then
      raise exception 'Step Contract positions or capabilities do not match the compiled plan';
    end if;
  end loop;
  if (p_server_compiled_suffix -> (v_suffix_count - 1) ->> 'capability')
      is distinct from 'verify' then
    raise exception 'replanned suffix must end in verification';
  end if;
  if exists (
    select 1 from generate_series(0, p_pivot_position - 1) i
    where (p_server_compiled_step_contracts #> array['steps',i::text])
      is distinct from (v_task.latest_checkpoint #> array['contract','step_contracts','steps',i::text])
  ) then raise exception 'completed Step Contracts are immutable'; end if;
  if exists (
    select 1 from generate_series(p_pivot_position, v_total_steps - 1) i
    where (p_server_compiled_step_contracts #>> array['steps',i::text,'position'])
        is distinct from i::text
      or (p_server_compiled_step_contracts #>> array['steps',i::text,'capability'])
        is distinct from
          (p_server_compiled_suffix #>> array[(i - p_pivot_position)::text,'capability'])
  ) then raise exception 'replacement Step Contracts do not match the suffix'; end if;

  select coalesce(max(repair_attempt), 0)::smallint into v_old_repair_attempt
  from public.agent_steps repair_step
  where repair_step.task_id = p_task_id;

  delete from public.agent_steps deleted_step
  where deleted_step.task_id = p_task_id
    and deleted_step.position >= p_pivot_position;
  insert into public.agent_steps (task_id, position, capability, title, status, expected_output, attempt, repair_attempt, updated_at)
  select p_task_id, p_pivot_position, x.v_item ->> 'capability', x.v_item ->> 'title',
    'running', x.v_item ->> 'expected_output', 1,
    case when x.v_item ->> 'capability' = 'verify' then v_old_repair_attempt else 0 end, now()
  from jsonb_array_elements(p_server_compiled_suffix) with ordinality x(v_item, ordinality)
  where x.ordinality = 1
  returning id, capability into v_first_step_id, v_first_capability;
  insert into public.agent_steps (task_id, position, capability, title, status, expected_output, attempt, repair_attempt, updated_at)
  select p_task_id, (x.v_item ->> 'position')::integer, x.v_item ->> 'capability', x.v_item ->> 'title',
    'pending', x.v_item ->> 'expected_output', 0,
    case when x.v_item ->> 'capability' = 'verify' then v_old_repair_attempt else 0 end, now()
  from jsonb_array_elements(p_server_compiled_suffix) with ordinality x(v_item, ordinality)
  where x.ordinality > 1;

  v_user_input := jsonb_set(jsonb_set(p_sanitized_user_input, '{step_id}', to_jsonb(v_first_step_id::text), true), '{attempt}', '1'::jsonb, true);
  v_required_input := jsonb_set(p_server_required_input, '{step_id}', to_jsonb(v_first_step_id::text), true);
  v_checkpoint := jsonb_set(v_task.latest_checkpoint, '{contract,step_contracts}', p_server_compiled_step_contracts, true);
  v_checkpoint := (v_checkpoint - 'required_input' - 'runner_retry' - 'planner_request' - 'source_version_change'
      - 'suffix_replan_pending_v1' - 'suffix_replan_reservation_v1' - 'suffix_replan_retry_v1')
    || jsonb_build_object('required_input', v_required_input, 'user_input', v_user_input, 'suffix_replan_v1', p_server_replan_receipt,
      'step_id', v_first_step_id::text, 'iteration', 1,
      'summary', 'Remaining steps replanned from validated user input.',
      'created_at', p_server_replan_receipt ->> 'created_at');
  if jsonb_typeof(v_checkpoint -> 'runtime') = 'object' then
    v_checkpoint := jsonb_set(
      v_checkpoint,
      '{runtime}',
      (v_checkpoint -> 'runtime') - 'runner_retry' - 'planner_request' - 'source_version_change',
      true
    );
  end if;
  update public.agent_tasks set
    status = case when v_first_capability = 'verify' then 'verifying' else 'running' end,
    current_step = v_first_step_id,
    latest_checkpoint = v_checkpoint,
    updated_at = now()
  where id = p_task_id;

  return query select p_task_id, v_first_step_id,
    case when v_first_capability = 'verify' then 'verifying' else 'running' end,
    (
      select returned_task.updated_at
      from public.agent_tasks returned_task
      where returned_task.id = p_task_id
    );
end;
$$;

revoke all on function public.reserve_agent_task_suffix_replan_v1(uuid, text, timestamptz, uuid, integer, jsonb, jsonb, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.reserve_agent_task_suffix_replan_v1(uuid, text, timestamptz, uuid, integer, jsonb, jsonb, text, text, timestamptz) to service_role;
revoke all on function public.mark_agent_task_suffix_replan_retryable_v1(uuid, text, timestamptz, uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.mark_agent_task_suffix_replan_retryable_v1(uuid, text, timestamptz, uuid, uuid, jsonb) to service_role;
revoke all on function public.apply_agent_task_suffix_replan_v1(uuid, text, timestamptz, uuid, integer, jsonb, jsonb, jsonb, jsonb, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.apply_agent_task_suffix_replan_v1(uuid, text, timestamptz, uuid, integer, jsonb, jsonb, jsonb, jsonb, jsonb, uuid) to service_role;
