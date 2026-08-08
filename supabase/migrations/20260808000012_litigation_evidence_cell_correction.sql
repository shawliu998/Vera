-- Litigation Evidence Inventory v1: re-open exactly one fixed unreviewed
-- Cell (or a historical `needs_correction` Cell) without creating another
-- Review, changing another Cell, or trusting a caller-provided checkpoint.
-- The next runner attempt remains bound to the original Task, source Version
-- and Tabular coordinates.

-- `needs_correction` remains readable for historical rows, but a new lawyer
-- review disposition may only be verified or unresolved. A correction must
-- use the source-bound RPC below, which clears the one fixed Cell before a
-- bounded re-generation attempt.
create or replace function public.review_litigation_evidence_cell_v1(
  p_user_id text,
  p_review_id uuid,
  p_cell_id uuid,
  p_expected_review_revision integer,
  p_review_status text
)
returns table(
  outcome text,
  cell_id uuid,
  cell_status text,
  review_status text,
  review_revision integer,
  reviewed_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_review public.tabular_reviews%rowtype;
  v_cell public.tabular_cells%rowtype;
  v_reviewed_at timestamptz := clock_timestamp();
begin
  if p_user_id is null
    or length(trim(p_user_id)) = 0
    or p_review_id is null
    or p_cell_id is null
    or p_expected_review_revision is null
    or p_expected_review_revision < 0
    or p_review_status is null
    or p_review_status not in ('verified', 'unresolved') then
    return query select
      'invalid_input'::text, null::uuid, null::text, null::text,
      null::integer, null::timestamptz;
    return;
  end if;

  select * into v_review
  from public.tabular_reviews review_row
  where review_row.id = p_review_id
    and review_row.user_id = p_user_id
    and review_row.row_protocol = 'document_rows'
  for update;
  if not found then
    return query select
      'not_found'::text, null::uuid, null::text, null::text,
      null::integer, null::timestamptz;
    return;
  end if;

  select * into v_cell
  from public.tabular_cells cell_row
  where cell_row.id = p_cell_id
    and cell_row.review_id = p_review_id
    and cell_row.row_id is null
  for update;
  if not found then
    return query select
      'not_found'::text, null::uuid, null::text, null::text,
      null::integer, null::timestamptz;
    return;
  end if;
  if v_cell.status not in ('pending', 'done') then
    return query select
      'artifact_invalid'::text,
      v_cell.id,
      v_cell.status,
      v_cell.review_status,
      v_cell.review_revision,
      v_cell.reviewed_at;
    return;
  end if;
  if p_review_status = 'verified'
    and (
      v_cell.status <> 'done'
      or v_cell.content is null
      or jsonb_typeof(v_cell.citations) is distinct from 'array'
    ) then
    return query select
      'artifact_invalid'::text,
      v_cell.id,
      v_cell.status,
      v_cell.review_status,
      v_cell.review_revision,
      v_cell.reviewed_at;
    return;
  end if;
  if v_cell.review_revision <> p_expected_review_revision then
    return query select
      'conflict'::text,
      v_cell.id,
      v_cell.status,
      v_cell.review_status,
      v_cell.review_revision,
      v_cell.reviewed_at;
    return;
  end if;

  update public.tabular_cells
  set
    review_status = p_review_status,
    reviewed_at = v_reviewed_at,
    review_revision = v_cell.review_revision + 1
  where id = v_cell.id;

  return query select
    'reviewed'::text,
    v_cell.id,
    v_cell.status,
    p_review_status,
    v_cell.review_revision + 1,
    v_reviewed_at;
end;
$$;

create or replace function public.start_litigation_evidence_cell_correction_v1(
  p_correction_id uuid,
  p_task_id uuid,
  p_user_id text,
  p_step_id uuid,
  p_expected_step_attempt integer,
  p_review_id uuid,
  p_cell_id uuid,
  p_document_id uuid,
  p_version_id uuid,
  p_column_index integer,
  p_expected_review_revision integer,
  p_reason_code text
)
returns table(
  outcome text,
  task_status text,
  current_step uuid,
  cell_id uuid,
  cell_status text,
  review_status text,
  review_revision integer
)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_task public.agent_tasks%rowtype;
  v_step public.agent_steps%rowtype;
  v_review public.tabular_reviews%rowtype;
  v_cell public.tabular_cells%rowtype;
  v_existing_correction jsonb;
  v_correction jsonb;
  v_checkpoint jsonb;
  v_effect_count integer;
  v_link_count integer;
  v_receipt_cell_count integer;
  v_source_pin_count integer;
  v_fixed_source_count integer;
  v_next_attempt integer;
  v_field text;
  v_updated_at timestamptz := clock_timestamp();
begin
  if p_correction_id is null
    or p_task_id is null
    or p_user_id is null
    or length(trim(p_user_id)) = 0
    or p_step_id is null
    or p_expected_step_attempt is null
    or p_expected_step_attempt < 1
    or p_expected_step_attempt = 2147483647
    or p_review_id is null
    or p_cell_id is null
    or p_document_id is null
    or p_version_id is null
    or p_column_index is null
    or p_column_index < 0
    or p_expected_review_revision is null
    or p_expected_review_revision < 0
    or p_reason_code is null
    or p_reason_code not in (
      'citation_not_exact', 'source_conflict', 'material_omission'
    ) then
    return query select
      'invalid_input'::text, null::text, null::uuid, null::uuid,
      null::text, null::text, null::integer;
    return;
  end if;

  select * into v_task
  from public.agent_tasks
  where id = p_task_id and user_id = p_user_id
  for update;
  if not found then
    return query select
      'not_found'::text, null::text, null::uuid, null::uuid,
      null::text, null::text, null::integer;
    return;
  end if;

  -- Exact replay is checked before active-state requirements because a
  -- successful correction leaves this Task running on its next attempt.
  v_existing_correction :=
    v_task.latest_checkpoint -> 'litigation_evidence_inventory_correction';
  if v_existing_correction is not null then
    if jsonb_typeof(v_existing_correction) is distinct from 'object'
      or v_existing_correction ->> 'correction_id'
        is distinct from p_correction_id::text then
      return query select
        'conflict'::text, v_task.status, v_task.current_step, null::uuid,
        null::text, null::text, null::integer;
      return;
    end if;
    if v_existing_correction ->> 'kind'
        is distinct from 'litigation_evidence_inventory_cell_correction_v1'
      or v_existing_correction ->> 'task_id' is distinct from p_task_id::text
      or v_existing_correction ->> 'step_id' is distinct from p_step_id::text
      or v_existing_correction ->> 'generation_step_attempt'
        is distinct from (p_expected_step_attempt + 1)::text
      or v_existing_correction ->> 'review_id'
        is distinct from p_review_id::text
      or v_existing_correction ->> 'cell_id' is distinct from p_cell_id::text
      or v_existing_correction ->> 'document_id'
        is distinct from p_document_id::text
      or v_existing_correction ->> 'version_id'
        is distinct from p_version_id::text
      or v_existing_correction ->> 'field_index'
        is distinct from p_column_index::text
      or v_existing_correction ->> 'expected_review_revision'
        is distinct from p_expected_review_revision::text
      or v_existing_correction ->> 'reason_code'
        is distinct from p_reason_code
      or v_existing_correction ->> 'source_binding_fingerprint'
        is distinct from v_task.latest_checkpoint
          -> 'litigation_evidence_inventory_receipt' ->> 'layout_digest'
      or v_existing_correction ->> 'max_attempts' is distinct from '1'
      or jsonb_typeof(v_existing_correction -> 'requested_at')
        is distinct from 'string' then
      return query select
        'conflict'::text, v_task.status, v_task.current_step, null::uuid,
        null::text, null::text, null::integer;
      return;
    end if;

    select * into v_step
    from public.agent_steps
    where id = p_step_id and task_id = p_task_id
    for update;
    select * into v_cell
    from public.tabular_cells
    where id = p_cell_id and review_id = p_review_id
    for update;
    if v_task.status <> 'running'
      or v_task.current_step is distinct from p_step_id
      or v_task.execution_lease_owner is not null
      or v_task.execution_lease_expires_at is not null
      or v_step.id is null
      or v_step.status <> 'running'
      or v_step.attempt <> p_expected_step_attempt + 1
      or v_cell.id is null
      or v_cell.document_id is distinct from p_document_id
      or v_cell.row_id is not null
      or v_cell.column_index is distinct from p_column_index
      or v_cell.status <> 'pending'
      or v_cell.content is not null
      or v_cell.citations is not null
      or v_cell.review_status is not null
      or v_cell.reviewed_at is not null
      or v_cell.review_revision <> p_expected_review_revision + 1
      or v_task.latest_checkpoint
          -> 'litigation_evidence_inventory_receipt' ->> 'attempt'
        is distinct from (p_expected_step_attempt + 1)::text then
      return query select
        'conflict'::text, v_task.status, v_task.current_step, null::uuid,
        null::text, null::text, null::integer;
      return;
    end if;
    return query select
      'recovered'::text,
      v_task.status,
      v_task.current_step,
      v_cell.id,
      v_cell.status,
      v_cell.review_status,
      v_cell.review_revision;
    return;
  end if;

  if v_task.execution_lease_owner is not null
    and v_task.execution_lease_expires_at > clock_timestamp() then
    return query select
      'lease_busy'::text, v_task.status, v_task.current_step, null::uuid,
      null::text, null::text, null::integer;
    return;
  end if;
  if v_task.status <> 'waiting_input'
    or v_task.current_step is distinct from p_step_id then
    return query select
      'conflict'::text, v_task.status, v_task.current_step, null::uuid,
      null::text, null::text, null::integer;
    return;
  end if;

  select * into v_step
  from public.agent_steps
  where id = p_step_id and task_id = p_task_id
  for update;
  if not found
    or v_step.status <> 'blocked'
    or v_step.attempt <> p_expected_step_attempt
    or v_step.capability is distinct from 'create_tabular'
    or (select count(*) from public.agent_steps
        where task_id = p_task_id and status = 'blocked') <> 1
    or (select count(*) from public.agent_steps
        where task_id = p_task_id and status = 'running') <> 0 then
    return query select
      'conflict'::text, v_task.status, v_task.current_step, null::uuid,
      null::text, null::text, null::integer;
    return;
  end if;

  if jsonb_typeof(v_task.latest_checkpoint) is distinct from 'object'
    or jsonb_typeof(
      v_task.latest_checkpoint -> 'litigation_evidence_inventory_receipt'
    ) is distinct from 'object'
    or v_task.latest_checkpoint
      -> 'litigation_evidence_inventory_receipt' ->> 'kind'
        is distinct from 'litigation_evidence_inventory_receipt_v1'
    or v_task.latest_checkpoint
      -> 'litigation_evidence_inventory_receipt' ->> 'task_id'
        is distinct from p_task_id::text
    or v_task.latest_checkpoint
      -> 'litigation_evidence_inventory_receipt' ->> 'matter_id'
        is distinct from v_task.matter_id::text
    or v_task.latest_checkpoint
      -> 'litigation_evidence_inventory_receipt' ->> 'step_id'
        is distinct from p_step_id::text
    or v_task.latest_checkpoint
      -> 'litigation_evidence_inventory_receipt' ->> 'attempt'
        is distinct from p_expected_step_attempt::text
    or v_task.latest_checkpoint
      -> 'litigation_evidence_inventory_receipt' ->> 'review_id'
        is distinct from p_review_id::text
    or jsonb_typeof(v_task.latest_checkpoint
      -> 'litigation_evidence_inventory_receipt' -> 'source_pins')
        is distinct from 'array'
    or jsonb_typeof(v_task.latest_checkpoint
      -> 'litigation_evidence_inventory_receipt' -> 'cells')
        is distinct from 'array'
    or jsonb_typeof(v_task.latest_checkpoint -> 'fixed_matter_context'
      -> 'sources') is distinct from 'array' then
    return query select
      'artifact_invalid'::text, v_task.status, v_task.current_step, null::uuid,
      null::text, null::text, null::integer;
    return;
  end if;

  select count(*), min(receipt_cell.value ->> 'field') into
    v_receipt_cell_count, v_field
  from jsonb_array_elements(v_task.latest_checkpoint
    -> 'litigation_evidence_inventory_receipt' -> 'cells') receipt_cell
  where jsonb_typeof(receipt_cell.value) = 'object'
    and receipt_cell.value ->> 'cell_id' = p_cell_id::text
    and receipt_cell.value ->> 'document_id' = p_document_id::text
    and receipt_cell.value ->> 'version_id' = p_version_id::text
    and receipt_cell.value ->> 'field_index' = p_column_index::text;
  if v_receipt_cell_count <> 1
    or v_field not in (
      'evidence_item', 'authenticity', 'admissibility', 'relevance',
      'purpose_of_proof'
    )
    or coalesce(v_task.latest_checkpoint
      -> 'litigation_evidence_inventory_receipt' ->> 'layout_digest', '')
      !~ '^sha256:[a-f0-9]{64}$' then
    return query select
      'artifact_invalid'::text, v_task.status, v_task.current_step, null::uuid,
      null::text, null::text, null::integer;
    return;
  end if;

  select count(*) into v_source_pin_count
  from jsonb_array_elements(v_task.latest_checkpoint
    -> 'litigation_evidence_inventory_receipt' -> 'source_pins') source_pin
  where jsonb_typeof(source_pin.value) = 'object'
    and source_pin.value ->> 'document_id' = p_document_id::text
    and source_pin.value ->> 'version_id' = p_version_id::text;
  if v_source_pin_count <> 1 then
    return query select
      'artifact_invalid'::text, v_task.status, v_task.current_step, null::uuid,
      null::text, null::text, null::integer;
    return;
  end if;

  select count(*) into v_fixed_source_count
  from jsonb_array_elements(v_task.latest_checkpoint
    -> 'fixed_matter_context' -> 'sources') source
  join public.documents document_row
    on document_row.id = p_document_id
  join public.document_versions version_row
    on version_row.id = p_version_id
  where jsonb_typeof(source.value) = 'object'
    and source.value ->> 'document_id' = p_document_id::text
    and source.value ->> 'version_id' = p_version_id::text
    and source.value ->> 'role' = 'source'
    and document_row.user_id = p_user_id
    and document_row.project_id = v_task.matter_id
    and document_row.status = 'ready'
    and document_row.current_version_id = p_version_id
    and version_row.document_id = p_document_id
    and version_row.deleted_at is null
    and version_row.storage_path is not null;
  if v_fixed_source_count <> 1 then
    return query select
      'version_conflict'::text, v_task.status, v_task.current_step, null::uuid,
      null::text, null::text, null::integer;
    return;
  end if;

  select count(*) into v_link_count
  from public.agent_artifact_links link
  where link.artifact_type = 'tabular_review'
    and link.artifact_id = p_review_id::text;
  if v_link_count <> 1
    or not exists (
      select 1
      from public.agent_artifact_links link
      where link.task_id = p_task_id
        and link.artifact_type = 'tabular_review'
        and link.artifact_id = p_review_id::text
    ) then
    return query select
      'artifact_invalid'::text, v_task.status, v_task.current_step, null::uuid,
      null::text, null::text, null::integer;
    return;
  end if;

  if jsonb_typeof(v_step.result_data) is distinct from 'object'
    or jsonb_typeof(v_step.result_data -> 'tabular_effect_receipts')
      is distinct from 'object' then
    return query select
      'artifact_invalid'::text, v_task.status, v_task.current_step, null::uuid,
      null::text, null::text, null::integer;
    return;
  end if;
  select count(*) into v_effect_count
  from jsonb_each(v_step.result_data -> 'tabular_effect_receipts') effect
  where jsonb_typeof(effect.value) = 'object'
    and effect.value ->> 'kind' = 'agent_step_tabular_effect_v1'
    and effect.value ->> 'step_id' = p_step_id::text
    and effect.value ->> 'attempt' = p_expected_step_attempt::text
    and effect.value ->> 'operation' = 'create_tabular_review'
    and effect.value ->> 'status' = 'committed'
    and effect.value -> 'target' ->> 'review_id' = p_review_id::text
    and effect.value -> 'effect' ->> 'review_id' = p_review_id::text
    and effect.value -> 'effect' ->> 'artifact_type' = 'tabular_review';
  if v_effect_count <> 1 then
    return query select
      'artifact_invalid'::text, v_task.status, v_task.current_step, null::uuid,
      null::text, null::text, null::integer;
    return;
  end if;

  select * into v_review
  from public.tabular_reviews review_row
  where review_row.id = p_review_id
    and review_row.project_id = v_task.matter_id
    and review_row.user_id = p_user_id
    and review_row.row_protocol = 'document_rows'
  for update;
  if not found then
    return query select
      'artifact_invalid'::text, v_task.status, v_task.current_step, null::uuid,
      null::text, null::text, null::integer;
    return;
  end if;

  select * into v_cell
  from public.tabular_cells cell_row
  where cell_row.id = p_cell_id
    and cell_row.review_id = p_review_id
  for update;
  if not found
    or v_cell.document_id is distinct from p_document_id
    or v_cell.row_id is not null
    or v_cell.column_index is distinct from p_column_index then
    return query select
      'artifact_invalid'::text, v_task.status, v_task.current_step, null::uuid,
      null::text, null::text, null::integer;
    return;
  end if;
  if v_cell.status not in ('pending', 'done')
    or (
      v_cell.review_status is not null
      and v_cell.review_status <> 'needs_correction'
    )
    or v_cell.review_revision <> p_expected_review_revision then
    return query select
      'conflict'::text,
      v_task.status,
      v_task.current_step,
      v_cell.id,
      v_cell.status,
      v_cell.review_status,
      v_cell.review_revision;
    return;
  end if;

  v_next_attempt := p_expected_step_attempt + 1;
  v_correction := jsonb_build_object(
    'kind', 'litigation_evidence_inventory_cell_correction_v1',
    'correction_id', p_correction_id::text,
    'task_id', p_task_id::text,
    'review_id', p_review_id::text,
    'step_id', p_step_id::text,
    'generation_step_attempt', v_next_attempt,
    'cell_id', p_cell_id::text,
    'document_id', p_document_id::text,
    'version_id', p_version_id::text,
    'field', v_field,
    'field_index', p_column_index,
    'expected_review_revision', p_expected_review_revision,
    'reason_code', p_reason_code,
    'source_binding_fingerprint', v_task.latest_checkpoint
      -> 'litigation_evidence_inventory_receipt' ->> 'layout_digest',
    'max_attempts', 1,
    'requested_at', to_char(v_updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
  v_checkpoint := jsonb_set(
    v_task.latest_checkpoint - 'litigation_evidence_review_completion',
    '{litigation_evidence_inventory_correction}',
    v_correction,
    true
  );
  v_checkpoint := jsonb_set(
    v_checkpoint,
    '{litigation_evidence_inventory_receipt,attempt}',
    to_jsonb(v_next_attempt),
    false
  );

  update public.tabular_cells
  set
    status = 'pending',
    content = null,
    citations = null,
    review_status = null,
    reviewed_at = null,
    review_revision = v_cell.review_revision + 1
  where id = v_cell.id;
  update public.agent_steps
  set
    status = 'running',
    attempt = v_next_attempt,
    result_summary = null,
    updated_at = v_updated_at
  where id = p_step_id;
  update public.agent_tasks
  set
    status = 'running',
    current_step = p_step_id,
    latest_checkpoint = v_checkpoint,
    execution_lease_owner = null,
    execution_lease_expires_at = null,
    updated_at = v_updated_at
  where id = p_task_id;

  return query select
    'started'::text,
    'running'::text,
    p_step_id,
    v_cell.id,
    'pending'::text,
    null::text,
    v_cell.review_revision + 1;
end;
$$;

revoke all on function public.review_litigation_evidence_cell_v1(
  text, uuid, uuid, integer, text
) from public, anon, authenticated;
grant execute on function public.review_litigation_evidence_cell_v1(
  text, uuid, uuid, integer, text
) to service_role;

revoke all on function public.start_litigation_evidence_cell_correction_v1(
  uuid, uuid, text, uuid, integer, uuid, uuid, uuid, uuid, integer, integer, text
) from public, anon, authenticated;
grant execute on function public.start_litigation_evidence_cell_correction_v1(
  uuid, uuid, text, uuid, integer, uuid, uuid, uuid, uuid, integer, integer, text
) to service_role;

comment on function public.review_litigation_evidence_cell_v1(
  text, uuid, uuid, integer, text
) is 'Compare-and-swap lawyer disposition for one completed Litigation Evidence Inventory cell; new needs_correction writes are not accepted.';

comment on function public.start_litigation_evidence_cell_correction_v1(
  uuid, uuid, text, uuid, integer, uuid, uuid, uuid, uuid, integer, integer, text
) is 'Atomically reopens one fixed unreviewed or historical needs_correction Evidence Inventory cell for a source-bound next Step attempt.';
