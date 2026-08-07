-- The only user-review mutation path.  It linearizes the decision log and the
-- optional Learning-P0 shadow receipt under the task row lock.
create or replace function public.apply_agent_task_review_decision_learning_p0(
  p_task_id uuid, p_user_id text, p_expected_task_updated_at timestamptz,
  p_expected_latest_decision_id uuid, p_decision_id uuid, p_status text,
  p_reviewer_email text, p_reviewer_name text, p_note text,
  p_artifact_snapshot jsonb, p_learning_candidate jsonb
) returns uuid language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_task public.agent_tasks%rowtype;
  v_latest public.agent_task_review_decisions%rowtype;
  v_existing public.agent_task_review_decisions%rowtype;
  v_step public.agent_steps%rowtype;
  v_latest_id uuid;
  v_candidate jsonb;
  v_replay boolean := false;
begin
  if p_task_id is null or p_decision_id is null or p_note is null or coalesce(btrim(p_user_id), '') = ''
    or p_status not in ('review_required', 'approved', 'changes_requested')
    or char_length(p_note) > 4000
    or (p_status = 'changes_requested' and coalesce(btrim(p_note), '') = '')
    or (p_status = 'review_required' and (p_reviewer_email is not null or p_reviewer_name is not null or jsonb_array_length(p_artifact_snapshot) <> 0 or p_learning_candidate is not null))
    or jsonb_typeof(p_artifact_snapshot) is distinct from 'array'
    or (p_status = 'approved' and jsonb_typeof(p_learning_candidate) is distinct from 'object')
    or (p_status = 'changes_requested' and p_learning_candidate is not null) then
    raise exception using
      message = 'invalid review decision input',
      errcode = '23514';
  end if;

  select * into v_task from public.agent_tasks where id = p_task_id for update;
  if not found then raise exception 'agent task not found'; end if;
  if v_task.user_id <> p_user_id or v_task.status <> 'completed'
    or v_task.updated_at is distinct from p_expected_task_updated_at then
    raise exception using
      message = 'stale or ineligible review decision',
      errcode = '40001';
  end if;
  perform 1 from public.agent_steps where task_id = p_task_id for update;
  select * into v_latest from public.agent_task_review_decisions
    where task_id = p_task_id order by created_at desc, id desc limit 1 for update;
  v_latest_id := v_latest.id;

  -- Exact replay is intentionally accepted before the baseline check so a
  -- retried request repairs a missing receipt without appending another row.
  select * into v_existing from public.agent_task_review_decisions where id = p_decision_id for update;
  if found then
    if v_existing.task_id <> p_task_id or v_existing.status <> p_status
      or v_existing.reviewer_id is distinct from
        (case when p_status = 'review_required' then null else p_user_id end)
      or v_existing.reviewer_email is distinct from p_reviewer_email
      or v_existing.reviewer_name is distinct from p_reviewer_name
      or v_existing.note is distinct from p_note
      or v_existing.artifact_snapshot is distinct from p_artifact_snapshot then
      raise exception using
        message = 'review decision id payload mismatch',
        errcode = '40001';
    end if;
    v_replay := true;
  elsif v_latest_id is distinct from p_expected_latest_decision_id then
    raise exception using
      message = 'stale review decision baseline',
      errcode = '40001';
  end if;
  -- A delayed exact replay of an older append-only decision is a successful
  -- no-op.  It must never resurrect its old learning receipt over the latest
  -- lawyer decision.
  if v_replay and v_latest_id is distinct from p_decision_id then
    return p_decision_id;
  end if;

  if p_status = 'review_required' then
    if not v_replay then
      insert into public.agent_task_review_decisions
        (id, task_id, status, reviewer_id, reviewer_email, reviewer_name, note, artifact_snapshot, created_at)
      values (p_decision_id, p_task_id, p_status, null, null, null, p_note, p_artifact_snapshot, clock_timestamp());
    end if;
    return p_decision_id;
  end if;

  select * into v_step from public.agent_steps where task_id = p_task_id order by position desc limit 1 for update;
  if not found or v_step.status <> 'completed' or v_step.capability <> 'verify'
    or jsonb_typeof(v_step.result_data) is distinct from 'object'
    or v_step.result_data ->> 'kind' <> 'structured_verifier_v1'
    or jsonb_typeof(v_step.result_data -> 'deliverable_versions') is distinct from 'array' then
    raise exception 'structured final verifier is unavailable';
  end if;

  if p_status = 'approved' then
    v_candidate := p_learning_candidate;
    if (v_candidate - 'kind' - 'lifecycle' - 'scope' - 'approval' - 'final_verify_receipt'
          - 'validating' - 'shadow_comparison' - 'approved_artifacts' - 'evidence_refs' - 'workflow' - 'model' - 'provenance_gaps') <> '{}'::jsonb
      or v_candidate ->> 'kind' <> 'learning_shadow_v1'
      or (v_candidate -> 'lifecycle') - 'candidate' - 'validation' - 'status' - 'active' - 'confirmed' <> '{}'::jsonb
      or (v_candidate -> 'scope') - 'task_id' - 'matter_id' - 'owner_id' <> '{}'::jsonb
      or (v_candidate -> 'approval') - 'decision_id' - 'status' <> '{}'::jsonb
      or (v_candidate -> 'final_verify_receipt') - 'step_id' - 'kind' <> '{}'::jsonb
      or (v_candidate -> 'workflow') - 'id' - 'version' <> '{}'::jsonb
      or (v_candidate -> 'model') - 'id' - 'version' <> '{}'::jsonb
      or (v_candidate -> 'validating') - 'status' - 'method' - 'artifact_refs' <> '{}'::jsonb
      or (v_candidate -> 'shadow_comparison') - 'status' - 'production_effect' - 'expected_artifact_refs' - 'observed_artifact_refs' <> '{}'::jsonb
      or (v_candidate -> 'evidence_refs') - 'approved_artifacts' - 'verifier_sources' <> '{}'::jsonb
      or v_candidate #>> '{lifecycle,candidate}' <> 'candidate'
      or v_candidate #>> '{lifecycle,validation}' <> 'validating'
      or v_candidate #>> '{lifecycle,status}' <> 'shadow'
      or (v_candidate #>> '{lifecycle,active}')::boolean is not false
      or (v_candidate #>> '{lifecycle,confirmed}')::boolean is not false
      or v_candidate #>> '{scope,task_id}' <> p_task_id::text
      or v_candidate #>> '{scope,matter_id}' <> v_task.matter_id::text
      or v_candidate #>> '{scope,owner_id}' <> p_user_id
      or v_candidate #>> '{approval,decision_id}' <> p_decision_id::text
      or v_candidate #>> '{approval,status}' <> 'approved'
      or v_candidate #>> '{final_verify_receipt,step_id}' <> v_step.id::text
      or v_candidate #>> '{final_verify_receipt,kind}' <> 'structured_verifier_v1'
      or jsonb_typeof(v_candidate -> 'approved_artifacts') is distinct from 'array'
      or jsonb_typeof(v_candidate -> 'provenance_gaps') is distinct from 'array'
      or jsonb_typeof(v_candidate -> 'workflow') is distinct from 'object'
      or jsonb_typeof(v_candidate -> 'model') is distinct from 'object'
      or v_candidate #>> '{validating,status}' <> 'passed'
      or v_candidate #>> '{validating,method}' <> 'approved_receipt_replay_v1'
      or v_candidate #>> '{shadow_comparison,status}' <> 'matched'
      or v_candidate #>> '{shadow_comparison,production_effect}' <> 'none'
      or jsonb_typeof(v_candidate #> '{validating,artifact_refs}') is distinct from 'array'
      or jsonb_typeof(v_candidate #> '{shadow_comparison,expected_artifact_refs}') is distinct from 'array'
      or jsonb_typeof(v_candidate #> '{shadow_comparison,observed_artifact_refs}') is distinct from 'array'
      or jsonb_typeof(v_candidate #> '{evidence_refs,approved_artifacts}') is distinct from 'array'
      or jsonb_typeof(v_candidate #> '{evidence_refs,verifier_sources}') is distinct from 'array'
      or v_candidate #>> '{workflow,id}' is distinct from v_task.latest_checkpoint #>> '{contract,context_manifest,workflow,id}'
      or v_candidate #> '{workflow,version}' is distinct from 'null'::jsonb
      or v_candidate #>> '{model,id}' is distinct from v_task.execution_model
      or v_candidate #> '{model,version}' is distinct from 'null'::jsonb
      or (select count(*) from jsonb_array_elements_text(v_candidate -> 'provenance_gaps') gap
            where gap = 'accepted_edit_record_unavailable') <> 1
      or (select count(*) from jsonb_array_elements_text(v_candidate -> 'provenance_gaps') gap
            where gap = 'workflow_version_unavailable') <> 1
      or (select count(*) from jsonb_array_elements_text(v_candidate -> 'provenance_gaps') gap
            where gap = 'model_version_unavailable') <> 1
      or exists (select 1 from jsonb_array_elements_text(v_candidate -> 'provenance_gaps') gap
        where gap not in ('accepted_edit_record_unavailable', 'workflow_version_unavailable',
          'model_version_unavailable', 'workflow_identity_unavailable', 'model_identity_unavailable')) then
      raise exception 'invalid learning shadow candidate';
    end if;
    -- Drafts and real Tabular Reviews have deliberately disjoint identity
    -- shapes. A Review is never synthesized into a DocumentVersion.
    if jsonb_array_length(p_artifact_snapshot) not between 1 and 100
      or exists (select 1 from jsonb_array_elements(p_artifact_snapshot) a where
        jsonb_typeof(a) <> 'object'
        or (a ->> 'artifact_type' = 'draft' and (
          a - array['artifact_type', 'artifact_id', 'purpose', 'document_id', 'version_id', 'version_number', 'filename', 'file_type', 'size_bytes', 'sha256'] <> '{}'::jsonb
          or jsonb_typeof(a -> 'artifact_id') is distinct from 'string'
          or jsonb_typeof(a -> 'purpose') is distinct from 'string'
          or jsonb_typeof(a -> 'document_id') is distinct from 'string'
          or jsonb_typeof(a -> 'version_id') is distinct from 'string'
          or a ->> 'artifact_id' is distinct from a ->> 'document_id'
          or coalesce(a ->> 'document_id', '') !~* '^[0-9a-f]{8}(-?[0-9a-f]{4}){3}-?[0-9a-f]{12}$'
          or coalesce(a ->> 'version_id', '') !~* '^[0-9a-f]{8}(-?[0-9a-f]{4}){3}-?[0-9a-f]{12}$'))
        or (a ->> 'artifact_type' = 'tabular_review' and (
          a - array['artifact_type', 'artifact_id', 'purpose', 'review_id', 'row_protocol', 'input_digest', 'revision_fingerprint'] <> '{}'::jsonb
          or jsonb_typeof(a -> 'artifact_id') is distinct from 'string'
          or jsonb_typeof(a -> 'purpose') is distinct from 'string'
          or jsonb_typeof(a -> 'review_id') is distinct from 'string'
          or a ->> 'artifact_id' is distinct from a ->> 'review_id'
          or a ->> 'row_protocol' <> 'document_rows'
          or coalesce(a ->> 'review_id', '') !~* '^[0-9a-f]{8}(-?[0-9a-f]{4}){3}-?[0-9a-f]{12}$'
          or coalesce(a ->> 'input_digest', '') !~ '^[a-f0-9]{64}$'
          or coalesce(a ->> 'revision_fingerprint', '') !~ '^[a-f0-9]{64}$'))
        or a ->> 'artifact_type' not in ('draft', 'tabular_review')) then
      raise exception 'approved artifact snapshot has an invalid mixed identity';
    end if;

    -- Lock authoritative objects and task links before comparing the captured
    -- server snapshot to the final structured-verifier receipt.
    perform 1 from public.agent_artifact_links l
      where l.task_id = p_task_id order by l.artifact_type, l.artifact_id for update;
    perform 1 from public.documents d join public.document_versions dv on dv.document_id = d.id
      where exists (select 1 from jsonb_array_elements(p_artifact_snapshot) a
        where a ->> 'artifact_type' = 'draft'
          and (a ->> 'document_id')::uuid = d.id and (a ->> 'version_id')::uuid = dv.id)
      order by d.id, dv.id for update of d, dv;
    perform 1 from public.tabular_reviews review
      where exists (select 1 from jsonb_array_elements(p_artifact_snapshot) a
        where a ->> 'artifact_type' = 'tabular_review'
          and (a ->> 'review_id')::uuid = review.id)
      order by review.id for update;

    if exists (select 1 from jsonb_array_elements(p_artifact_snapshot) a where
      (a ->> 'artifact_type' = 'draft' and (
        not exists (select 1 from public.agent_artifact_links l
          join public.documents d on d.id = (a ->> 'document_id')::uuid
          join public.document_versions dv on dv.id = (a ->> 'version_id')::uuid and dv.document_id = d.id
          where l.task_id = p_task_id and l.artifact_type = 'draft'
            and l.artifact_id = a ->> 'document_id' and d.project_id = v_task.matter_id
            and d.current_version_id = dv.id and dv.deleted_at is null)
        or (select count(*) from jsonb_array_elements(v_step.result_data -> 'deliverable_versions') vv
          where vv ->> 'artifact_type' = 'draft'
            and vv - array['key', 'artifact_type', 'document_id', 'version_id'] = '{}'::jsonb
            and (vv ->> 'document_id')::uuid = (a ->> 'document_id')::uuid
            and (vv ->> 'version_id')::uuid = (a ->> 'version_id')::uuid) <> 1))
      or (a ->> 'artifact_type' = 'tabular_review' and (
        not exists (select 1 from public.agent_artifact_links l
          join public.tabular_reviews review on review.id = (a ->> 'review_id')::uuid
          where l.task_id = p_task_id and l.artifact_type = 'tabular_review'
            and l.artifact_id = a ->> 'review_id' and review.project_id = v_task.matter_id
            and review.row_protocol = 'document_rows')
        or (select count(*) from jsonb_array_elements(v_step.result_data -> 'deliverable_versions') vv
          where vv ->> 'artifact_type' = 'tabular_review'
            and vv - array['key', 'artifact_type', 'review_id', 'row_protocol', 'input_digest', 'revision_fingerprint'] = '{}'::jsonb
            and (vv ->> 'review_id')::uuid = (a ->> 'review_id')::uuid
            and vv ->> 'row_protocol' = a ->> 'row_protocol'
            and vv ->> 'input_digest' = a ->> 'input_digest'
            and vv ->> 'revision_fingerprint' = a ->> 'revision_fingerprint') <> 1))) then
      raise exception 'approved artifact snapshot no longer matches task verifier';
    end if;
    if (select count(*) from jsonb_array_elements(p_artifact_snapshot))
       <> (select count(*) from jsonb_array_elements(v_step.result_data -> 'deliverable_versions'))
      or exists (select 1 from jsonb_array_elements(v_step.result_data -> 'deliverable_versions') vv where
        (vv ->> 'artifact_type' = 'draft' and (
          vv - array['key', 'artifact_type', 'document_id', 'version_id'] <> '{}'::jsonb
          or (select count(*) from jsonb_array_elements(p_artifact_snapshot) a where a ->> 'artifact_type' = 'draft'
            and (a ->> 'document_id')::uuid = (vv ->> 'document_id')::uuid
            and (a ->> 'version_id')::uuid = (vv ->> 'version_id')::uuid) <> 1))
        or (vv ->> 'artifact_type' = 'tabular_review' and (
          vv - array['key', 'artifact_type', 'review_id', 'row_protocol', 'input_digest', 'revision_fingerprint'] <> '{}'::jsonb
          or (select count(*) from jsonb_array_elements(p_artifact_snapshot) a where a ->> 'artifact_type' = 'tabular_review'
            and (a ->> 'review_id')::uuid = (vv ->> 'review_id')::uuid
            and a ->> 'row_protocol' = vv ->> 'row_protocol'
            and a ->> 'input_digest' = vv ->> 'input_digest'
            and a ->> 'revision_fingerprint' = vv ->> 'revision_fingerprint') <> 1))
        or vv ->> 'artifact_type' not in ('draft', 'tabular_review'))
      or (select count(*) from jsonb_array_elements(p_artifact_snapshot))
         <> (select count(*) from jsonb_array_elements(v_candidate -> 'approved_artifacts'))
      or exists (select 1 from jsonb_array_elements(v_candidate -> 'approved_artifacts') c where
        (c ->> 'artifact_type' = 'draft' and (
          c - array['artifact_type', 'document_id', 'version_id'] <> '{}'::jsonb
          or (select count(*) from jsonb_array_elements(p_artifact_snapshot) a where a ->> 'artifact_type' = 'draft'
            and (a ->> 'document_id')::uuid = (c ->> 'document_id')::uuid
            and (a ->> 'version_id')::uuid = (c ->> 'version_id')::uuid) <> 1))
        or (c ->> 'artifact_type' = 'tabular_review' and (
          c - array['artifact_type', 'review_id', 'row_protocol', 'input_digest', 'revision_fingerprint'] <> '{}'::jsonb
          or (select count(*) from jsonb_array_elements(p_artifact_snapshot) a where a ->> 'artifact_type' = 'tabular_review'
            and (a ->> 'review_id')::uuid = (c ->> 'review_id')::uuid
            and a ->> 'row_protocol' = c ->> 'row_protocol'
            and a ->> 'input_digest' = c ->> 'input_digest'
            and a ->> 'revision_fingerprint' = c ->> 'revision_fingerprint') <> 1))
        or c ->> 'artifact_type' not in ('draft', 'tabular_review'))
      or exists (select 1 from jsonb_array_elements(p_artifact_snapshot) a where
        (a ->> 'artifact_type' = 'draft' and (select count(*) from jsonb_array_elements(v_candidate -> 'approved_artifacts') c where c ->> 'artifact_type' = 'draft'
          and (c ->> 'document_id')::uuid = (a ->> 'document_id')::uuid and (c ->> 'version_id')::uuid = (a ->> 'version_id')::uuid) <> 1)
        or (a ->> 'artifact_type' = 'tabular_review' and (select count(*) from jsonb_array_elements(v_candidate -> 'approved_artifacts') c where c ->> 'artifact_type' = 'tabular_review'
          and (c ->> 'review_id')::uuid = (a ->> 'review_id')::uuid and c ->> 'row_protocol' = a ->> 'row_protocol'
          and c ->> 'input_digest' = a ->> 'input_digest' and c ->> 'revision_fingerprint' = a ->> 'revision_fingerprint') <> 1) ) then
      raise exception 'learning candidate references do not match approved snapshot';
    end if;
    if v_candidate #> '{validating,artifact_refs}' <> v_candidate -> 'approved_artifacts'
      or v_candidate #> '{shadow_comparison,expected_artifact_refs}' <> v_candidate -> 'approved_artifacts'
      or v_candidate #> '{shadow_comparison,observed_artifact_refs}' <> v_candidate -> 'approved_artifacts'
      or v_candidate #> '{evidence_refs,approved_artifacts}' <> v_candidate -> 'approved_artifacts'
      or (select count(*) from jsonb_array_elements(v_candidate #> '{evidence_refs,verifier_sources}'))
         <> (select count(*) from jsonb_array_elements(coalesce(v_step.result_data -> 'source_versions', '[]'::jsonb)))
      or exists (select 1 from jsonb_array_elements(v_candidate #> '{evidence_refs,verifier_sources}') source
        where jsonb_typeof(source) is distinct from 'object'
          or source - 'document_id' - 'version_id' - 'role' <> '{}'::jsonb
          or jsonb_typeof(source -> 'document_id') is distinct from 'string'
          or jsonb_typeof(source -> 'version_id') is distinct from 'string'
          or jsonb_typeof(source -> 'role') is distinct from 'string'
          or source ->> 'role' not in ('source', 'template', 'precedent', 'authority')
          or (select count(*) from jsonb_array_elements(coalesce(v_step.result_data -> 'source_versions', '[]'::jsonb)) receipt
            where receipt ->> 'document_id' = source ->> 'document_id'
              and receipt ->> 'version_id' = source ->> 'version_id'
              and receipt ->> 'role' = source ->> 'role') <> 1)
      or exists (select 1 from jsonb_array_elements(coalesce(v_step.result_data -> 'source_versions', '[]'::jsonb)) receipt
        where (select count(*) from jsonb_array_elements(v_candidate #> '{evidence_refs,verifier_sources}') source
          where source ->> 'document_id' = receipt ->> 'document_id'
            and source ->> 'version_id' = receipt ->> 'version_id'
            and source ->> 'role' = receipt ->> 'role') <> 1) then
      raise exception 'learning candidate validation or evidence references do not match verifier';
    end if;
  elsif jsonb_array_length(p_artifact_snapshot) <> 0 then
    raise exception 'changes requested must not retain artifact snapshot';
  end if;

  if not v_replay then
    insert into public.agent_task_review_decisions
      (id, task_id, status, reviewer_id, reviewer_email, reviewer_name, note, artifact_snapshot, created_at)
    values (p_decision_id, p_task_id, p_status, p_user_id, p_reviewer_email, p_reviewer_name, p_note, p_artifact_snapshot, clock_timestamp());
  end if;
  if p_status = 'approved' then
    update public.agent_steps set result_data = jsonb_set(result_data, '{learning_p0}', v_candidate, true), updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond')
      where id = v_step.id and (result_data -> 'learning_p0') is distinct from v_candidate;
  else
    update public.agent_steps set result_data = result_data - 'learning_p0', updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond')
      where id = v_step.id and result_data ? 'learning_p0';
  end if;
  return p_decision_id;
end;
$$;

revoke all on function public.apply_agent_task_review_decision_learning_p0(uuid, text, timestamptz, uuid, uuid, text, text, text, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.apply_agent_task_review_decision_learning_p0(uuid, text, timestamptz, uuid, uuid, text, text, text, text, jsonb, jsonb) to service_role;
revoke insert on public.agent_task_review_decisions from service_role;
