-- Preserve the server-owned committed Word effect journal when a completed
-- final Verifier is restarted. The prior v1 transition intentionally clears
-- attempt-local output, but committed effects are durable provenance: later
-- verification must still know which fixed Version a bounded repair created.
--
-- This wrapper keeps the v1 validation and atomic state transition intact. It
-- locks the same Task/Step first, accepts only a strict committed receipt map,
-- delegates to v1 in the same transaction, and restores only that bounded map.

create or replace function public.start_agent_task_verifier_retry_v2(
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
  v_effect_receipts jsonb;
  v_preserved_result_data jsonb;
  v_effect_count integer := 0;
  v_valid_effect_count integer := 0;
  v_restored integer := 0;
  v_transition record;
begin
  select * into v_task
  from public.agent_tasks
  where id = p_task_id
    and user_id = p_user_id
  for update;

  if found then
    select * into v_verifier
    from public.agent_steps
    where task_id = p_task_id
    order by position desc
    limit 1
    for update;

    if found
      and v_verifier.result_data is not null
      and v_verifier.result_data ? 'effect_receipts' then
      if jsonb_typeof(v_verifier.result_data -> 'effect_receipts')
        is distinct from 'object' then
        return query
          select 'verifier_invalid'::text, v_task.status, v_task.current_step;
        return;
      end if;

      v_effect_receipts := v_verifier.result_data -> 'effect_receipts';
      select count(*) into v_effect_count
      from jsonb_each(v_effect_receipts);

      if v_effect_count > 60 then
        return query
          select 'verifier_invalid'::text, v_task.status, v_task.current_step;
        return;
      end if;

      select count(*) into v_valid_effect_count
      from jsonb_each(v_effect_receipts) receipt
      where jsonb_typeof(receipt.value) = 'object'
        and receipt.value ?& array[
          'kind', 'effect_key', 'step_id', 'attempt', 'tool_name',
          'input_fingerprint', 'status', 'target', 'effect',
          'created_at', 'committed_at'
        ]
        and receipt.value - array[
          'kind', 'effect_key', 'step_id', 'attempt', 'tool_name',
          'input_fingerprint', 'status', 'target', 'effect',
          'created_at', 'committed_at'
        ] = '{}'::jsonb
        and receipt.value ->> 'kind' = 'agent_step_effect_v1'
        and receipt.value ->> 'effect_key' = receipt.key
        and receipt.value ->> 'step_id' = v_verifier.id::text
        and jsonb_typeof(receipt.value -> 'attempt') = 'number'
        and receipt.value ->> 'attempt' ~ '^[1-9][0-9]*$'
        and (receipt.value ->> 'attempt')::integer <= v_verifier.attempt
        and receipt.value ->> 'tool_name' in ('generate_docx', 'generate_excel')
        and receipt.value ->> 'input_fingerprint' ~ '^[a-f0-9]{64}$'
        and receipt.value ->> 'status' = 'committed'
        and jsonb_typeof(receipt.value -> 'target') = 'object'
        and (receipt.value -> 'target') ?& array['document_id', 'version_id']
        and (receipt.value -> 'target') - array['document_id', 'version_id']
          = '{}'::jsonb
        and receipt.value -> 'target' ->> 'document_id'
          ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        and receipt.value -> 'target' ->> 'version_id'
          ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        and jsonb_typeof(receipt.value -> 'effect') = 'object'
        and (receipt.value -> 'effect')
          ?& array['document_id', 'version_id', 'artifact_type']
        and (receipt.value -> 'effect')
          - array['document_id', 'version_id', 'artifact_type'] = '{}'::jsonb
        and receipt.value -> 'effect' ->> 'document_id'
          = receipt.value -> 'target' ->> 'document_id'
        and receipt.value -> 'effect' ->> 'version_id'
          = receipt.value -> 'target' ->> 'version_id'
        and receipt.value -> 'effect' ->> 'artifact_type'
          in ('draft', 'tabular_review')
        and jsonb_typeof(receipt.value -> 'created_at') = 'string'
        and length(receipt.value ->> 'created_at') between 20 and 40
        and jsonb_typeof(receipt.value -> 'committed_at') = 'string'
        and length(receipt.value ->> 'committed_at') between 20 and 40;

      if v_valid_effect_count <> v_effect_count then
        return query
          select 'verifier_invalid'::text, v_task.status, v_task.current_step;
        return;
      end if;

      if v_effect_count > 0 then
        v_preserved_result_data := jsonb_build_object(
          'effect_receipts',
          v_effect_receipts
        );
      end if;
    end if;
  end if;

  select * into v_transition
  from public.start_agent_task_verifier_retry_v1(
    p_task_id,
    p_user_id,
    p_retry_id
  );

  if v_transition.outcome = 'started'
    and v_preserved_result_data is not null then
    update public.agent_steps
    set result_data = v_preserved_result_data
    where id = v_transition.current_step
      and task_id = p_task_id
      and status = 'running'
      and attempt = v_verifier.attempt + 1;

    get diagnostics v_restored = row_count;
    if v_restored <> 1 then
      raise exception
        'Verifier retry committed without restoring its durable effect journal';
    end if;
  end if;

  return query
    select
      v_transition.outcome::text,
      v_transition.task_status::text,
      v_transition.current_step::uuid;
end;
$$;

revoke all on function public.start_agent_task_verifier_retry_v2(
  uuid, text, text
) from public, anon, authenticated;

grant execute on function public.start_agent_task_verifier_retry_v2(
  uuid, text, text
) to service_role;

comment on function public.start_agent_task_verifier_retry_v2(
  uuid, text, text
) is
  'Restarts the exact final Verifier through v1 while preserving only its strict bounded committed effect journal as durable Version provenance.';
