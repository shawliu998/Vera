-- Kernel v1: reserve and commit one real Tabular Review without pretending it
-- is an XLSX DocumentVersion. The Task lease, Step attempt, Matter and owner
-- remain server-enforced, and retries recover the same fixed Review identity.

create or replace function public.reserve_agent_step_tabular_effect_v1(
  p_task_id uuid,
  p_user_id text,
  p_step_id uuid,
  p_step_attempt integer,
  p_lease_owner uuid,
  p_effect_key text,
  p_receipt jsonb
)
returns table(outcome text, effect_receipt jsonb)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_task public.agent_tasks%rowtype;
  v_step public.agent_steps%rowtype;
  v_result_data jsonb;
  v_receipts jsonb;
  v_existing jsonb;
begin
  if p_task_id is null
    or p_user_id is null
    or length(trim(p_user_id)) = 0
    or p_step_id is null
    or p_step_attempt is null
    or p_step_attempt < 1
    or p_lease_owner is null
    or p_effect_key is null
    or length(trim(p_effect_key)) not between 1 and 300
    or jsonb_typeof(p_receipt) is distinct from 'object'
    or p_receipt - array[
      'kind', 'effect_key', 'step_id', 'attempt', 'operation',
      'input_fingerprint', 'status', 'target', 'effect',
      'created_at', 'committed_at'
    ] <> '{}'::jsonb
    or p_receipt ->> 'kind' is distinct from 'agent_step_tabular_effect_v1'
    or p_receipt ->> 'effect_key' is distinct from p_effect_key
    or p_receipt ->> 'step_id' is distinct from p_step_id::text
    or jsonb_typeof(p_receipt -> 'attempt') is distinct from 'number'
    or p_receipt ->> 'attempt' is distinct from p_step_attempt::text
    or p_receipt ->> 'operation' is distinct from 'create_tabular_review'
    or coalesce(p_receipt ->> 'input_fingerprint', '')
      !~ '^[a-f0-9]{64}$'
    or p_receipt ->> 'status' is distinct from 'reserved'
    or jsonb_typeof(p_receipt -> 'target') is distinct from 'object'
    or (p_receipt -> 'target') - 'review_id'::text <> '{}'::jsonb
    or coalesce(p_receipt -> 'target' ->> 'review_id', '')
      !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or p_receipt -> 'effect' is distinct from 'null'::jsonb
    or p_receipt -> 'committed_at' is distinct from 'null'::jsonb
    or jsonb_typeof(p_receipt -> 'created_at') is distinct from 'string'
    or length(trim(coalesce(p_receipt ->> 'created_at', ''))) = 0 then
    return query select 'invalid_input'::text, null::jsonb;
    return;
  end if;

  select * into v_task
  from public.agent_tasks
  where id = p_task_id and user_id = p_user_id
  for update;
  if not found then
    return query select 'not_found'::text, null::jsonb;
    return;
  end if;
  if v_task.status not in ('running', 'verifying')
    or v_task.current_step is distinct from p_step_id
    or v_task.execution_lease_owner is distinct from p_lease_owner
    or v_task.execution_lease_expires_at is null
    or v_task.execution_lease_expires_at <= clock_timestamp() then
    return query select 'lease_lost'::text, null::jsonb;
    return;
  end if;

  select * into v_step
  from public.agent_steps
  where id = p_step_id and task_id = p_task_id
  for update;
  if not found
    or v_step.status <> 'running'
    or v_step.attempt <> p_step_attempt then
    return query select 'conflict'::text, null::jsonb;
    return;
  end if;

  v_result_data := coalesce(v_step.result_data, '{}'::jsonb);
  if jsonb_typeof(v_result_data) is distinct from 'object' then
    return query select 'invalid_input'::text, null::jsonb;
    return;
  end if;
  v_receipts := v_result_data -> 'tabular_effect_receipts';
  if v_receipts is null then
    v_receipts := '{}'::jsonb;
  elsif jsonb_typeof(v_receipts) is distinct from 'object' then
    return query select 'invalid_input'::text, null::jsonb;
    return;
  end if;

  v_existing := v_receipts -> p_effect_key;
  if v_existing is not null then
    if jsonb_typeof(v_existing) is distinct from 'object'
      or (v_existing - 'status' - 'effect' - 'committed_at')
        is distinct from (p_receipt - 'status' - 'effect' - 'committed_at')
      or coalesce(v_existing ->> 'status', '')
        not in ('reserved', 'committed') then
      return query select 'conflict'::text, null::jsonb;
      return;
    end if;
    return query select 'recovered'::text, v_existing;
    return;
  end if;

  update public.agent_steps
  set
    result_data = jsonb_set(
      v_result_data,
      '{tabular_effect_receipts}',
      v_receipts || jsonb_build_object(p_effect_key, p_receipt),
      true
    ),
    updated_at = clock_timestamp()
  where id = p_step_id;
  return query select 'reserved'::text, p_receipt;
end;
$$;

drop function if exists public.commit_agent_step_tabular_effect_v1(
  uuid, text, uuid, integer, uuid, text, jsonb, uuid, text
);

create or replace function public.commit_agent_step_tabular_effect_v1(
  p_task_id uuid,
  p_user_id text,
  p_step_id uuid,
  p_step_attempt integer,
  p_lease_owner uuid,
  p_effect_key text,
  p_reserved_receipt jsonb,
  p_review_id uuid,
  p_layout jsonb,
  p_committed_at text
)
returns table(outcome text, effect_receipt jsonb)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_task public.agent_tasks%rowtype;
  v_step public.agent_steps%rowtype;
  v_result_data jsonb;
  v_receipts jsonb;
  v_existing jsonb;
  v_committed jsonb;
  v_artifact_found boolean;
begin
  if p_task_id is null
    or p_user_id is null
    or length(trim(p_user_id)) = 0
    or p_step_id is null
    or p_step_attempt is null
    or p_step_attempt < 1
    or p_lease_owner is null
    or p_effect_key is null
    or length(trim(p_effect_key)) not between 1 and 300
    or p_review_id is null
    or p_committed_at is null
    or p_committed_at !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$'
    or jsonb_typeof(p_reserved_receipt) is distinct from 'object'
    or p_reserved_receipt ->> 'kind'
      is distinct from 'agent_step_tabular_effect_v1'
    or p_reserved_receipt ->> 'effect_key' is distinct from p_effect_key
    or p_reserved_receipt ->> 'step_id' is distinct from p_step_id::text
    or p_reserved_receipt ->> 'attempt' is distinct from p_step_attempt::text
    or p_reserved_receipt ->> 'operation'
      is distinct from 'create_tabular_review'
    or p_reserved_receipt -> 'target' ->> 'review_id'
      is distinct from p_review_id::text
    or p_reserved_receipt ->> 'status' is distinct from 'reserved'
    or p_reserved_receipt -> 'effect' is distinct from 'null'::jsonb
    or p_reserved_receipt -> 'committed_at' is distinct from 'null'::jsonb then
    return query select 'invalid_input'::text, null::jsonb;
    return;
  end if;

  if jsonb_typeof(p_layout) is distinct from 'object'
    or p_layout - array['document_ids', 'columns_config', 'cells']
      <> '{}'::jsonb
    or jsonb_typeof(p_layout -> 'document_ids') is distinct from 'array'
    or jsonb_typeof(p_layout -> 'columns_config') is distinct from 'array'
    or jsonb_typeof(p_layout -> 'cells') is distinct from 'array' then
    return query select 'invalid_input'::text, null::jsonb;
    return;
  end if;
  if jsonb_array_length(p_layout -> 'cells') > 500
    or exists (
      select 1
      from jsonb_array_elements(p_layout -> 'cells') expected
      where jsonb_typeof(expected) is distinct from 'object'
        or expected - array['id', 'document_id', 'column_index']
          <> '{}'::jsonb
        or coalesce(expected ->> 'id', '')
          !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        or coalesce(expected ->> 'document_id', '')
          !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        or jsonb_typeof(expected -> 'column_index') is distinct from 'number'
        or coalesce(expected ->> 'column_index', '') !~ '^\d+$'
    )
    or exists (
      select 1
      from jsonb_array_elements(p_layout -> 'cells') expected
      group by expected ->> 'id'
      having count(*) > 1
    )
    or exists (
      select 1
      from jsonb_array_elements(p_layout -> 'cells') expected
      group by expected ->> 'document_id', expected ->> 'column_index'
      having count(*) > 1
    ) then
    return query select 'invalid_input'::text, null::jsonb;
    return;
  end if;

  select * into v_task
  from public.agent_tasks
  where id = p_task_id and user_id = p_user_id
  for update;
  if not found then
    return query select 'not_found'::text, null::jsonb;
    return;
  end if;
  if v_task.status not in ('running', 'verifying')
    or v_task.current_step is distinct from p_step_id
    or v_task.execution_lease_owner is distinct from p_lease_owner
    or v_task.execution_lease_expires_at is null
    or v_task.execution_lease_expires_at <= clock_timestamp() then
    return query select 'lease_lost'::text, null::jsonb;
    return;
  end if;

  select * into v_step
  from public.agent_steps
  where id = p_step_id and task_id = p_task_id
  for update;
  if not found
    or v_step.status <> 'running'
    or v_step.attempt <> p_step_attempt then
    return query select 'conflict'::text, null::jsonb;
    return;
  end if;

  v_result_data := coalesce(v_step.result_data, '{}'::jsonb);
  if jsonb_typeof(v_result_data) is distinct from 'object'
    or jsonb_typeof(v_result_data -> 'tabular_effect_receipts')
      is distinct from 'object' then
    return query select 'invalid_input'::text, null::jsonb;
    return;
  end if;
  v_receipts := v_result_data -> 'tabular_effect_receipts';
  v_existing := v_receipts -> p_effect_key;
  if jsonb_typeof(v_existing) is distinct from 'object'
    or (v_existing - 'status' - 'effect' - 'committed_at')
      is distinct from (
        p_reserved_receipt - 'status' - 'effect' - 'committed_at'
      )
    or coalesce(v_existing ->> 'status', '')
      not in ('reserved', 'committed') then
    return query select 'conflict'::text, null::jsonb;
    return;
  end if;
  if v_existing ->> 'status' = 'committed' then
    if v_existing -> 'effect' ->> 'review_id'
        is distinct from p_review_id::text
      or v_existing -> 'effect' ->> 'artifact_type'
        is distinct from 'tabular_review' then
      return query select 'conflict'::text, null::jsonb;
      return;
    end if;
    return query select 'committed'::text, v_existing;
    return;
  end if;

  select true into v_artifact_found
  from public.tabular_reviews review
  where review.id = p_review_id
    and review.project_id = v_task.matter_id
    and review.user_id = p_user_id
    and review.row_protocol = 'document_rows'
    and review.document_ids is not distinct from (p_layout -> 'document_ids')
    and review.columns_config is not distinct from (p_layout -> 'columns_config')
    and (
      select count(*)
      from public.tabular_cells cell
      where cell.review_id = review.id
    ) = jsonb_array_length(p_layout -> 'cells')
    and not exists (
      select 1
      from jsonb_array_elements(p_layout -> 'cells') expected
      where not exists (
        select 1
        from public.tabular_cells cell
        where cell.review_id = review.id
          and cell.id::text = expected ->> 'id'
          and cell.document_id::text = expected ->> 'document_id'
          and cell.row_id is null
          and cell.column_index::text = expected ->> 'column_index'
          and cell.status = 'pending'
      )
    )
  for update of review;
  if coalesce(v_artifact_found, false) is not true then
    return query select 'artifact_invalid'::text, null::jsonb;
    return;
  end if;

  v_committed := v_existing || jsonb_build_object(
    'status', 'committed',
    'effect', jsonb_build_object(
      'review_id', p_review_id::text,
      'artifact_type', 'tabular_review'
    ),
    'committed_at', p_committed_at
  );
  update public.agent_steps
  set
    result_data = jsonb_set(
      v_result_data,
      '{tabular_effect_receipts}',
      v_receipts || jsonb_build_object(p_effect_key, v_committed),
      true
    ),
    updated_at = clock_timestamp()
  where id = p_step_id;
  return query select 'committed'::text, v_committed;
end;
$$;

revoke execute on function public.reserve_agent_step_tabular_effect_v1(
  uuid, text, uuid, integer, uuid, text, jsonb
) from public, anon, authenticated;
grant execute on function public.reserve_agent_step_tabular_effect_v1(
  uuid, text, uuid, integer, uuid, text, jsonb
) to service_role;

revoke execute on function public.commit_agent_step_tabular_effect_v1(
  uuid, text, uuid, integer, uuid, text, jsonb, uuid, jsonb, text
) from public, anon, authenticated;
grant execute on function public.commit_agent_step_tabular_effect_v1(
  uuid, text, uuid, integer, uuid, text, jsonb, uuid, jsonb, text
) to service_role;

comment on function public.reserve_agent_step_tabular_effect_v1(
  uuid, text, uuid, integer, uuid, text, jsonb
) is 'Atomically reserves one real Tabular Review effect under the current Task lease.';

comment on function public.commit_agent_step_tabular_effect_v1(
  uuid, text, uuid, integer, uuid, text, jsonb, uuid, jsonb, text
) is 'Commits one Matter-owned document-row Tabular Review under the current Task lease.';
