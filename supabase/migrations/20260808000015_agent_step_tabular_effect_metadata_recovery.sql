-- Kernel v1 Batch 15: recover the same fixed Tabular effect after a runner
-- lease changes. Timestamps are persisted history, not mutation identity;
-- Task/Step/attempt/effect/layout fingerprints and target Review remain fixed.

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
      or v_existing - array[
        'kind', 'effect_key', 'step_id', 'attempt', 'operation',
        'input_fingerprint', 'status', 'target', 'effect',
        'created_at', 'committed_at'
      ] <> '{}'::jsonb
      or jsonb_typeof(v_existing -> 'created_at') is distinct from 'string'
      or length(trim(coalesce(v_existing ->> 'created_at', ''))) = 0
      or (
        v_existing - array[
          'status', 'effect', 'created_at', 'committed_at'
        ]
      ) is distinct from (
        p_receipt - array[
          'status', 'effect', 'created_at', 'committed_at'
        ]
      )
      or coalesce(v_existing ->> 'status', '')
        not in ('reserved', 'committed')
      or (
        v_existing ->> 'status' = 'reserved'
        and (
          v_existing -> 'effect' is distinct from 'null'::jsonb
          or v_existing -> 'committed_at' is distinct from 'null'::jsonb
        )
      )
      or (
        v_existing ->> 'status' = 'committed'
        and (
          jsonb_typeof(v_existing -> 'effect') is distinct from 'object'
          or (v_existing -> 'effect') - array['review_id', 'artifact_type']
            <> '{}'::jsonb
          or v_existing -> 'effect' ->> 'review_id'
            is distinct from v_existing -> 'target' ->> 'review_id'
          or v_existing -> 'effect' ->> 'artifact_type'
            is distinct from 'tabular_review'
          or jsonb_typeof(v_existing -> 'committed_at')
            is distinct from 'string'
          or length(trim(coalesce(v_existing ->> 'committed_at', ''))) = 0
        )
      ) then
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

revoke execute on function public.reserve_agent_step_tabular_effect_v1(
  uuid, text, uuid, integer, uuid, text, jsonb
) from public, anon, authenticated;
grant execute on function public.reserve_agent_step_tabular_effect_v1(
  uuid, text, uuid, integer, uuid, text, jsonb
) to service_role;

comment on function public.reserve_agent_step_tabular_effect_v1(
  uuid, text, uuid, integer, uuid, text, jsonb
) is 'Atomically reserves or exactly recovers one fixed Tabular Review effect under the current Task lease; persisted timestamps are not effect identity.';
