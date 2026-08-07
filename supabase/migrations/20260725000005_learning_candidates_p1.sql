-- Learning-P1 is a narrow, service-owned lifecycle ledger. It stores only
-- procedural metadata and evidence references. It is not a Memory system and
-- is deliberately limited to literal Task, Matter, and User scope.
create table if not exists public.learning_candidates (
  id uuid primary key,
  owner_id text not null,
  scope text not null check (scope in ('task', 'matter', 'user')),
  scope_key text not null,
  matter_id uuid references public.projects(id) on delete cascade,
  kind text not null check (kind ~ '^[a-z0-9]+(_[a-z0-9]+)*$'),
  version integer not null check (version > 0),
  status text not null check (status in ('active', 'expired', 'revoked')),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  evidence_refs jsonb not null check (jsonb_typeof(evidence_refs) = 'object'),
  -- The payload is immutable procedural metadata only. It is never the
  -- Learning-P0 shadow object and never carries goal text, document bodies,
  -- filenames, notes, chat, quotes, Matter facts, or chain-of-thought.
  check (
    payload ->> 'kind' = 'learning_procedure_v1'
    and payload #>> '{validation,production_effect}' = 'none'
  ),
  -- Account and Matter deletion must stay possible even though direct DML is
  -- revoked, so source rows cascade; lineage pointers tolerate hard deletion.
  source_task_id uuid not null
    references public.agent_tasks(id) on delete cascade,
  source_step_id uuid not null
    references public.agent_steps(id) on delete cascade,
  source_review_decision_id uuid not null
    references public.agent_task_review_decisions(id) on delete cascade,
  supersedes_id uuid
    references public.learning_candidates(id) on delete set null,
  rollback_source_id uuid
    references public.learning_candidates(id) on delete set null,
  confirmed_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz,
  revoked_at timestamptz,
  revoked_reason text
    check (revoked_reason is null or revoked_reason in ('superseded', 'user', 'rollback')),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique(owner_id, scope, scope_key, kind, version),
  check (
    (scope = 'task' and matter_id is not null and scope_key = source_task_id::text)
    or (scope = 'matter' and matter_id is not null and scope_key = matter_id::text)
    or (scope = 'user' and matter_id is null and scope_key = owner_id)
  ),
  check (
    (status = 'revoked' and revoked_at is not null and revoked_reason is not null)
    or (status in ('active', 'expired') and revoked_at is null and revoked_reason is null)
  )
);

create unique index if not exists learning_candidates_one_active_idx
  on public.learning_candidates(owner_id, scope, scope_key, kind)
  where status = 'active';

create index if not exists learning_candidates_lookup_idx
  on public.learning_candidates(
    owner_id,
    scope,
    scope_key,
    kind,
    status,
    version desc
  );

create index if not exists learning_candidates_source_task_idx
  on public.learning_candidates(source_task_id, version desc);

alter table public.learning_candidates enable row level security;
revoke all on public.learning_candidates
  from public, anon, authenticated, service_role;

-- All lifecycle mutations and task INSERT pinning use this exact owner-scoped
-- lock. It is intentionally broader than one candidate key: task creation may
-- need to choose between Matter and User candidates in one atomic snapshot.
create or replace function public.lock_learning_candidate_owner_v1(
  p_owner_id text
) returns void
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if coalesce(btrim(p_owner_id), '') = '' then
    raise exception using
      message = 'invalid learning owner',
      errcode = '23514';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended('vera-learning-p1:' || p_owner_id, 0)
  );
end;
$$;

-- The caller locks Task/Step/Decision/Document rows before using this helper.
-- It rechecks the latest approved decision, final structured verifier, current
-- deliverable versions, Task links, and the exact Learning-P0 shadow receipt.
create or replace function public.agent_learning_approved_evidence_current_v1(
  p_task_id uuid,
  p_step_id uuid,
  p_decision_id uuid,
  p_owner_id text
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_task public.agent_tasks%rowtype;
  v_step public.agent_steps%rowtype;
  v_decision public.agent_task_review_decisions%rowtype;
  v_shadow jsonb;
begin
  select * into v_task
    from public.agent_tasks
    where id = p_task_id;
  select * into v_step
    from public.agent_steps
    where id = p_step_id and task_id = p_task_id;
  select * into v_decision
    from public.agent_task_review_decisions
    where id = p_decision_id and task_id = p_task_id;

  if v_task.id is null
    or v_task.user_id is distinct from p_owner_id
    or v_task.status <> 'completed'
    or v_step.id is null
    or v_step.id is distinct from (
      select final_step.id
        from public.agent_steps final_step
        where final_step.task_id = p_task_id
        order by final_step.position desc
        limit 1
    )
    or v_step.status <> 'completed'
    or v_step.capability <> 'verify'
    or jsonb_typeof(v_step.result_data) is distinct from 'object'
    or v_step.result_data ->> 'kind' <> 'structured_verifier_v1'
    or v_decision.id is null
    or v_decision.id is distinct from (
      select latest_decision.id
        from public.agent_task_review_decisions latest_decision
        where latest_decision.task_id = p_task_id
        order by latest_decision.created_at desc, latest_decision.id desc
        limit 1
    )
    or v_decision.status <> 'approved'
    or jsonb_typeof(v_decision.artifact_snapshot) is distinct from 'array'
  then
    return false;
  end if;
  -- jsonb_array_length errors on a non-array and SQL never guarantees OR
  -- evaluation order, so length checks run only after the array guard above.
  if jsonb_array_length(v_decision.artifact_snapshot) not between 1 and 100 then
    return false;
  end if;

  v_shadow := v_step.result_data -> 'learning_p0';
  if jsonb_typeof(v_shadow) is distinct from 'object'
    or v_shadow ->> 'kind' <> 'learning_shadow_v1'
    or v_shadow #>> '{lifecycle,status}' <> 'shadow'
    or v_shadow #> '{lifecycle,active}' is distinct from 'false'::jsonb
    or v_shadow #> '{lifecycle,confirmed}' is distinct from 'false'::jsonb
    or v_shadow #>> '{scope,task_id}' <> v_task.id::text
    or v_shadow #>> '{scope,matter_id}' <> v_task.matter_id::text
    or v_shadow #>> '{scope,owner_id}' <> p_owner_id
    or v_shadow #>> '{approval,decision_id}' <> v_decision.id::text
    or v_shadow #>> '{approval,status}' <> 'approved'
    or v_shadow #>> '{final_verify_receipt,step_id}' <> v_step.id::text
    or v_shadow #>> '{final_verify_receipt,kind}' <> 'structured_verifier_v1'
    or v_shadow #>> '{validating,status}' <> 'passed'
    or v_shadow #>> '{validating,method}' <> 'approved_receipt_replay_v1'
    or v_shadow #>> '{shadow_comparison,status}' <> 'matched'
    or v_shadow #>> '{shadow_comparison,production_effect}' <> 'none'
    or jsonb_typeof(v_shadow -> 'approved_artifacts') is distinct from 'array'
    or jsonb_typeof(v_shadow #> '{evidence_refs,approved_artifacts}')
      is distinct from 'array'
    or jsonb_typeof(v_shadow #> '{evidence_refs,verifier_sources}')
      is distinct from 'array'
    or jsonb_typeof(v_step.result_data -> 'deliverable_versions')
      is distinct from 'array'
  then
    return false;
  end if;
  if jsonb_array_length(v_decision.artifact_snapshot)
      <> jsonb_array_length(v_shadow -> 'approved_artifacts')
    or jsonb_array_length(v_decision.artifact_snapshot)
      <> jsonb_array_length(v_step.result_data -> 'deliverable_versions')
  then
    return false;
  end if;

  -- A draft carries only DocumentVersion identity; a real document-row Review
  -- carries only its review receipt. Never coerce either shape into the other.
  if exists (select 1 from jsonb_array_elements(v_decision.artifact_snapshot) snapshot(value) where
    jsonb_typeof(snapshot.value) <> 'object'
    or (snapshot.value ->> 'artifact_type' = 'draft' and (
      snapshot.value - array['artifact_type', 'artifact_id', 'purpose', 'document_id', 'version_id', 'version_number', 'filename', 'file_type', 'size_bytes', 'sha256'] <> '{}'::jsonb
      or snapshot.value ->> 'artifact_id' is distinct from snapshot.value ->> 'document_id'
      or coalesce(snapshot.value ->> 'document_id', '') !~* '^[0-9a-f]{8}(-?[0-9a-f]{4}){3}-?[0-9a-f]{12}$'
      or coalesce(snapshot.value ->> 'version_id', '') !~* '^[0-9a-f]{8}(-?[0-9a-f]{4}){3}-?[0-9a-f]{12}$'))
    or (snapshot.value ->> 'artifact_type' = 'tabular_review' and (
      snapshot.value - array['artifact_type', 'artifact_id', 'purpose', 'review_id', 'row_protocol', 'input_digest', 'revision_fingerprint'] <> '{}'::jsonb
      or snapshot.value ->> 'artifact_id' is distinct from snapshot.value ->> 'review_id'
      or snapshot.value ->> 'row_protocol' <> 'document_rows'
      or coalesce(snapshot.value ->> 'review_id', '') !~* '^[0-9a-f]{8}(-?[0-9a-f]{4}){3}-?[0-9a-f]{12}$'
      or coalesce(snapshot.value ->> 'input_digest', '') !~ '^[a-f0-9]{64}$'
      or coalesce(snapshot.value ->> 'revision_fingerprint', '') !~ '^[a-f0-9]{64}$'))
    or snapshot.value ->> 'artifact_type' not in ('draft', 'tabular_review')) then
    return false;
  end if;

  if exists (select 1 from jsonb_array_elements(v_decision.artifact_snapshot) snapshot(value) where
    (snapshot.value ->> 'artifact_type' = 'draft' and (
      not exists (select 1 from public.agent_artifact_links link
        join public.documents document on document.id = (snapshot.value ->> 'document_id')::uuid
        join public.document_versions version on version.id = (snapshot.value ->> 'version_id')::uuid and version.document_id = document.id
        where link.task_id = p_task_id and link.artifact_type = 'draft'
          and link.artifact_id = snapshot.value ->> 'document_id'
          and document.project_id = v_task.matter_id and document.current_version_id = version.id and version.deleted_at is null)
      or (select count(*) from jsonb_array_elements(v_shadow -> 'approved_artifacts') shadow_artifact(value) where shadow_artifact.value ->> 'artifact_type' = 'draft'
        and shadow_artifact.value - array['artifact_type', 'document_id', 'version_id'] = '{}'::jsonb
        and (shadow_artifact.value ->> 'document_id')::uuid = (snapshot.value ->> 'document_id')::uuid
        and (shadow_artifact.value ->> 'version_id')::uuid = (snapshot.value ->> 'version_id')::uuid) <> 1
      or (select count(*) from jsonb_array_elements(v_step.result_data -> 'deliverable_versions') verified(value) where verified.value ->> 'artifact_type' = 'draft'
        and verified.value - array['key', 'artifact_type', 'document_id', 'version_id'] = '{}'::jsonb
        and (verified.value ->> 'document_id')::uuid = (snapshot.value ->> 'document_id')::uuid
        and (verified.value ->> 'version_id')::uuid = (snapshot.value ->> 'version_id')::uuid) <> 1))
    or (snapshot.value ->> 'artifact_type' = 'tabular_review' and (
      not exists (select 1 from public.agent_artifact_links link
        join public.tabular_reviews review on review.id = (snapshot.value ->> 'review_id')::uuid
        where link.task_id = p_task_id and link.artifact_type = 'tabular_review'
          and link.artifact_id = snapshot.value ->> 'review_id'
          and review.project_id = v_task.matter_id and review.row_protocol = 'document_rows')
      or (select count(*) from jsonb_array_elements(v_shadow -> 'approved_artifacts') shadow_artifact(value) where shadow_artifact.value ->> 'artifact_type' = 'tabular_review'
        and shadow_artifact.value - array['artifact_type', 'review_id', 'row_protocol', 'input_digest', 'revision_fingerprint'] = '{}'::jsonb
        and (shadow_artifact.value ->> 'review_id')::uuid = (snapshot.value ->> 'review_id')::uuid
        and shadow_artifact.value ->> 'row_protocol' = snapshot.value ->> 'row_protocol'
        and shadow_artifact.value ->> 'input_digest' = snapshot.value ->> 'input_digest'
        and shadow_artifact.value ->> 'revision_fingerprint' = snapshot.value ->> 'revision_fingerprint') <> 1
      or (select count(*) from jsonb_array_elements(v_step.result_data -> 'deliverable_versions') verified(value) where verified.value ->> 'artifact_type' = 'tabular_review'
        and verified.value - array['key', 'artifact_type', 'review_id', 'row_protocol', 'input_digest', 'revision_fingerprint'] = '{}'::jsonb
        and (verified.value ->> 'review_id')::uuid = (snapshot.value ->> 'review_id')::uuid
        and verified.value ->> 'row_protocol' = snapshot.value ->> 'row_protocol'
        and verified.value ->> 'input_digest' = snapshot.value ->> 'input_digest'
        and verified.value ->> 'revision_fingerprint' = snapshot.value ->> 'revision_fingerprint') <> 1))) then
    return false;
  end if;

  if exists (select 1 from jsonb_array_elements(v_shadow -> 'approved_artifacts') shadow_artifact(value) where
    (shadow_artifact.value ->> 'artifact_type' = 'draft' and (
      shadow_artifact.value - array['artifact_type', 'document_id', 'version_id'] <> '{}'::jsonb
      or (select count(*) from jsonb_array_elements(v_decision.artifact_snapshot) snapshot(value) where snapshot.value ->> 'artifact_type' = 'draft'
        and (snapshot.value ->> 'document_id')::uuid = (shadow_artifact.value ->> 'document_id')::uuid
        and (snapshot.value ->> 'version_id')::uuid = (shadow_artifact.value ->> 'version_id')::uuid) <> 1))
    or (shadow_artifact.value ->> 'artifact_type' = 'tabular_review' and (
      shadow_artifact.value - array['artifact_type', 'review_id', 'row_protocol', 'input_digest', 'revision_fingerprint'] <> '{}'::jsonb
      or (select count(*) from jsonb_array_elements(v_decision.artifact_snapshot) snapshot(value) where snapshot.value ->> 'artifact_type' = 'tabular_review'
        and (snapshot.value ->> 'review_id')::uuid = (shadow_artifact.value ->> 'review_id')::uuid
        and snapshot.value ->> 'row_protocol' = shadow_artifact.value ->> 'row_protocol'
        and snapshot.value ->> 'input_digest' = shadow_artifact.value ->> 'input_digest'
        and snapshot.value ->> 'revision_fingerprint' = shadow_artifact.value ->> 'revision_fingerprint') <> 1))
    or shadow_artifact.value ->> 'artifact_type' not in ('draft', 'tabular_review')) then
    return false;
  end if;

  return true;
end;
$$;

create or replace function public.confirm_agent_task_learning_candidate_v1(
  p_task_id uuid,
  p_user_id text,
  p_candidate_id uuid,
  p_scope text,
  p_expected_task_updated_at timestamptz,
  p_expected_active_id uuid,
  p_expires_at timestamptz
) returns public.learning_candidates
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_task public.agent_tasks%rowtype;
  v_step public.agent_steps%rowtype;
  v_decision public.agent_task_review_decisions%rowtype;
  v_existing public.learning_candidates%rowtype;
  v_active public.learning_candidates%rowtype;
  v_result public.learning_candidates%rowtype;
  v_shadow jsonb;
  v_payload jsonb;
  v_evidence_refs jsonb;
  v_kind text;
  v_scope_key text;
  v_matter_id uuid;
  v_version integer;
begin
  if p_task_id is null
    or p_candidate_id is null
    or p_scope not in ('task', 'matter', 'user')
    or coalesce(btrim(p_user_id), '') = ''
    or p_expected_task_updated_at is null
    or (p_expires_at is not null and p_expires_at <= clock_timestamp())
  then
    raise exception using
      message = 'invalid learning confirmation',
      errcode = '23514';
  end if;

  perform public.lock_learning_candidate_owner_v1(p_user_id);
  select * into v_task
    from public.agent_tasks
    where id = p_task_id
    for update;
  if not found or v_task.user_id <> p_user_id then
    raise exception 'agent task not found';
  end if;

  v_kind := v_task.latest_checkpoint #>> '{contract,goal_spec,task_family}';
  if coalesce(v_kind, '') !~ '^[a-z0-9]+(_[a-z0-9]+)*$' then
    raise exception using
      message = 'invalid task family for learning confirmation',
      errcode = '23514';
  end if;
  v_scope_key := case p_scope
    when 'task' then v_task.id::text
    when 'matter' then v_task.matter_id::text
    else p_user_id
  end;
  v_matter_id := case when p_scope = 'user' then null else v_task.matter_id end;

  -- Exact operation replay is accepted before mutable baselines. Reusing the
  -- same operation id with a different payload is a conflict.
  select * into v_existing
    from public.learning_candidates
    where id = p_candidate_id
    for update;
  if found then
    if v_existing.owner_id <> p_user_id
      or v_existing.source_task_id <> p_task_id
      or v_existing.scope <> p_scope
      or v_existing.scope_key <> v_scope_key
      or v_existing.kind <> v_kind
      or v_existing.matter_id is distinct from v_matter_id
      or v_existing.expires_at is distinct from p_expires_at
    then
      raise exception using
        message = 'learning confirmation id payload mismatch',
        errcode = '40001';
    end if;
    return v_existing;
  end if;

  if v_task.status <> 'completed'
    or v_task.updated_at is distinct from p_expected_task_updated_at
  then
    raise exception using
      message = 'stale or ineligible learning confirmation',
      errcode = '40001';
  end if;

  update public.learning_candidates
    set status = 'expired',
        updated_at = clock_timestamp()
    where owner_id = p_user_id
      and status = 'active'
      and expires_at is not null
      and expires_at <= clock_timestamp();

  select * into v_active
    from public.learning_candidates
    where owner_id = p_user_id
      and scope = p_scope
      and scope_key = v_scope_key
      and kind = v_kind
      and status = 'active'
    for update;
  if v_active.id is distinct from p_expected_active_id then
    raise exception using
      message = 'stale learning active baseline',
      errcode = '40001';
  end if;

  select * into v_step
    from public.agent_steps
    where task_id = p_task_id
    order by position desc
    limit 1
    for update;
  select * into v_decision
    from public.agent_task_review_decisions
    where task_id = p_task_id
    order by created_at desc, id desc
    limit 1
    for update;
  if v_step.id is null
    or v_decision.id is null
    or jsonb_typeof(v_decision.artifact_snapshot) is distinct from 'array'
  then
    raise exception using
      message = 'approved Learning-P0 receipt unavailable',
      errcode = '23514';
  end if;

  perform 1
    from public.documents document
    join public.document_versions version
      on version.document_id = document.id
    where exists (
      select 1
        from jsonb_array_elements(v_decision.artifact_snapshot) snapshot(value)
        where snapshot.value ->> 'document_id' = document.id::text
          and snapshot.value ->> 'version_id' = version.id::text
    )
    order by document.id, version.id
    for update of document, version;
  perform 1 from public.agent_artifact_links link
    where link.task_id = p_task_id
    order by link.artifact_type, link.artifact_id
    for update;
  perform 1 from public.tabular_reviews review
    where exists (
      select 1 from jsonb_array_elements(v_decision.artifact_snapshot) snapshot(value)
      where snapshot.value ->> 'artifact_type' = 'tabular_review'
        and snapshot.value ->> 'review_id' = review.id::text
    )
    order by review.id
    for update;

  if not public.agent_learning_approved_evidence_current_v1(
    p_task_id,
    v_step.id,
    v_decision.id,
    p_user_id
  ) then
    raise exception using
      message = 'approved Learning-P0 evidence is no longer current',
      errcode = '23514';
  end if;

  v_shadow := v_step.result_data -> 'learning_p0';
  v_payload := jsonb_build_object(
    'kind', 'learning_procedure_v1',
    'task_family', v_kind,
    'workflow', v_shadow -> 'workflow',
    'model', v_shadow -> 'model',
    'validation', jsonb_build_object(
      'status', 'passed',
      'method', v_shadow #>> '{validating,method}',
      'shadow_comparison', v_shadow #>> '{shadow_comparison,status}',
      'production_effect', 'none'
    ),
    'provenance_gaps', v_shadow -> 'provenance_gaps'
  );
  v_evidence_refs := v_shadow -> 'evidence_refs';
  if jsonb_typeof(v_evidence_refs) is distinct from 'object' then
    raise exception using
      message = 'invalid Learning-P0 evidence references',
      errcode = '23514';
  end if;

  if v_active.id is not null then
    update public.learning_candidates
      set status = 'revoked',
          revoked_at = clock_timestamp(),
          revoked_reason = 'superseded',
          updated_at = clock_timestamp()
      where id = v_active.id;
  end if;
  select coalesce(max(candidate.version), 0) + 1
    into v_version
    from public.learning_candidates candidate
    where candidate.owner_id = p_user_id
      and candidate.scope = p_scope
      and candidate.scope_key = v_scope_key
      and candidate.kind = v_kind;

  insert into public.learning_candidates(
    id,
    owner_id,
    scope,
    scope_key,
    matter_id,
    kind,
    version,
    status,
    payload,
    evidence_refs,
    source_task_id,
    source_step_id,
    source_review_decision_id,
    supersedes_id,
    expires_at
  ) values (
    p_candidate_id,
    p_user_id,
    p_scope,
    v_scope_key,
    v_matter_id,
    v_kind,
    v_version,
    'active',
    v_payload,
    v_evidence_refs,
    v_task.id,
    v_step.id,
    v_decision.id,
    v_active.id,
    p_expires_at
  )
  returning * into v_result;

  if p_scope = 'task' then
    update public.agent_tasks
      set latest_checkpoint = jsonb_set(
            latest_checkpoint,
            '{contract,learning_p1}',
            jsonb_build_object(
              'kind', 'learning_p1_pins_v1',
              'pins', jsonb_build_array(jsonb_build_object(
                'candidate_id', v_result.id::text,
                'version', v_result.version,
                'scope', v_result.scope,
                'kind', v_result.kind
              ))
            ),
            true
          ),
          updated_at = greatest(
            clock_timestamp(),
            updated_at + interval '1 microsecond'
          )
      where id = v_task.id;
  end if;
  return v_result;
end;
$$;

create or replace function public.revoke_agent_task_learning_candidate_v1(
  p_task_id uuid,
  p_user_id text,
  p_candidate_id uuid,
  p_expected_task_updated_at timestamptz
) returns public.learning_candidates
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_task public.agent_tasks%rowtype;
  v_candidate public.learning_candidates%rowtype;
begin
  if p_task_id is null
    or p_candidate_id is null
    or p_expected_task_updated_at is null
    or coalesce(btrim(p_user_id), '') = ''
  then
    raise exception using
      message = 'invalid learning revoke',
      errcode = '23514';
  end if;
  perform public.lock_learning_candidate_owner_v1(p_user_id);
  select * into v_task
    from public.agent_tasks
    where id = p_task_id
    for update;
  if not found or v_task.user_id <> p_user_id then
    raise exception 'agent task not found';
  end if;

  update public.learning_candidates
    set status = 'expired',
        updated_at = clock_timestamp()
    where owner_id = p_user_id
      and status = 'active'
      and expires_at is not null
      and expires_at <= clock_timestamp();
  select * into v_candidate
    from public.learning_candidates
    where id = p_candidate_id and owner_id = p_user_id
    for update;
  if not found then
    raise exception using
      message = 'stale learning candidate',
      errcode = '40001';
  end if;
  if v_candidate.status = 'revoked'
    and v_candidate.revoked_reason = 'user'
  then
    return v_candidate;
  end if;
  if v_task.updated_at is distinct from p_expected_task_updated_at
    or v_candidate.status <> 'active'
    or (
      v_candidate.scope = 'task'
      and v_candidate.scope_key <> v_task.id::text
    )
    or (
      v_candidate.scope = 'matter'
      and v_candidate.matter_id is distinct from v_task.matter_id
    )
  then
    raise exception using
      message = 'stale or inaccessible learning revoke',
      errcode = '40001';
  end if;
  update public.learning_candidates
    set status = 'revoked',
        revoked_at = clock_timestamp(),
        revoked_reason = 'user',
        updated_at = clock_timestamp()
    where id = v_candidate.id
    returning * into v_candidate;
  return v_candidate;
end;
$$;

create or replace function public.rollback_agent_task_learning_candidate_v1(
  p_task_id uuid,
  p_user_id text,
  p_current_candidate_id uuid,
  p_rollback_candidate_id uuid,
  p_expected_task_updated_at timestamptz
) returns public.learning_candidates
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_task public.agent_tasks%rowtype;
  v_current public.learning_candidates%rowtype;
  v_previous public.learning_candidates%rowtype;
  v_existing public.learning_candidates%rowtype;
  v_source_task public.agent_tasks%rowtype;
  v_source_step public.agent_steps%rowtype;
  v_source_decision public.agent_task_review_decisions%rowtype;
  v_result public.learning_candidates%rowtype;
  v_version integer;
begin
  if p_task_id is null
    or p_current_candidate_id is null
    or p_rollback_candidate_id is null
    or p_expected_task_updated_at is null
    or coalesce(btrim(p_user_id), '') = ''
  then
    raise exception using
      message = 'invalid learning rollback',
      errcode = '23514';
  end if;
  perform public.lock_learning_candidate_owner_v1(p_user_id);
  select * into v_task
    from public.agent_tasks
    where id = p_task_id
    for update;
  if not found or v_task.user_id <> p_user_id then
    raise exception 'agent task not found';
  end if;

  select * into v_existing
    from public.learning_candidates
    where id = p_rollback_candidate_id
    for update;
  if found then
    if v_existing.owner_id <> p_user_id
      or v_existing.supersedes_id is distinct from p_current_candidate_id
      or v_existing.rollback_source_id is null
    then
      raise exception using
        message = 'learning rollback id payload mismatch',
        errcode = '40001';
    end if;
    return v_existing;
  end if;

  if v_task.status <> 'completed'
    or v_task.updated_at is distinct from p_expected_task_updated_at
  then
    raise exception using
      message = 'stale learning rollback',
      errcode = '40001';
  end if;
  update public.learning_candidates
    set status = 'expired',
        updated_at = clock_timestamp()
    where owner_id = p_user_id
      and status = 'active'
      and expires_at is not null
      and expires_at <= clock_timestamp();
  select * into v_current
    from public.learning_candidates
    where id = p_current_candidate_id
      and owner_id = p_user_id
      and status = 'active'
    for update;
  if not found
    or (
      v_current.scope = 'task'
      and v_current.scope_key <> v_task.id::text
    )
    or (
      v_current.scope = 'matter'
      and v_current.matter_id is distinct from v_task.matter_id
    )
  then
    raise exception using
      message = 'stale or inaccessible learning rollback',
      errcode = '40001';
  end if;

  select * into v_previous
    from public.learning_candidates
    where id = v_current.supersedes_id
      and owner_id = p_user_id
      and scope = v_current.scope
      and scope_key = v_current.scope_key
      and kind = v_current.kind
      and status = 'revoked'
      and revoked_reason in ('superseded', 'rollback')
      and (expires_at is null or expires_at > clock_timestamp())
    for update;
  if not found then
    raise exception using
      message = 'no valid learning rollback predecessor',
      errcode = '23514';
  end if;

  select * into v_source_task
    from public.agent_tasks
    where id = v_previous.source_task_id
    for update;
  select * into v_source_step
    from public.agent_steps
    where id = v_previous.source_step_id
    for update;
  select * into v_source_decision
    from public.agent_task_review_decisions
    where id = v_previous.source_review_decision_id
    for update;
  if jsonb_typeof(v_source_decision.artifact_snapshot) is distinct from 'array' then
    raise exception using
      message = 'rollback evidence is unavailable',
      errcode = '23514';
  end if;
  perform 1
    from public.documents document
    join public.document_versions version
      on version.document_id = document.id
    where exists (
      select 1
        from jsonb_array_elements(v_source_decision.artifact_snapshot) snapshot(value)
        where snapshot.value ->> 'document_id' = document.id::text
          and snapshot.value ->> 'version_id' = version.id::text
    )
    order by document.id, version.id
    for update of document, version;
  perform 1 from public.agent_artifact_links link
    where link.task_id = v_previous.source_task_id
    order by link.artifact_type, link.artifact_id
    for update;
  perform 1 from public.tabular_reviews review
    where exists (
      select 1 from jsonb_array_elements(v_source_decision.artifact_snapshot) snapshot(value)
      where snapshot.value ->> 'artifact_type' = 'tabular_review'
        and snapshot.value ->> 'review_id' = review.id::text
    )
    order by review.id
    for update;
  if not public.agent_learning_approved_evidence_current_v1(
    v_previous.source_task_id,
    v_previous.source_step_id,
    v_previous.source_review_decision_id,
    p_user_id
  ) then
    raise exception using
      message = 'rollback evidence is no longer current',
      errcode = '23514';
  end if;

  update public.learning_candidates
    set status = 'revoked',
        revoked_at = clock_timestamp(),
        revoked_reason = 'rollback',
        updated_at = clock_timestamp()
    where id = v_current.id;
  select coalesce(max(candidate.version), 0) + 1
    into v_version
    from public.learning_candidates candidate
    where candidate.owner_id = p_user_id
      and candidate.scope = v_current.scope
      and candidate.scope_key = v_current.scope_key
      and candidate.kind = v_current.kind;
  insert into public.learning_candidates(
    id,
    owner_id,
    scope,
    scope_key,
    matter_id,
    kind,
    version,
    status,
    payload,
    evidence_refs,
    source_task_id,
    source_step_id,
    source_review_decision_id,
    supersedes_id,
    rollback_source_id,
    expires_at
  ) values (
    p_rollback_candidate_id,
    p_user_id,
    v_current.scope,
    v_current.scope_key,
    v_current.matter_id,
    v_current.kind,
    v_version,
    'active',
    v_previous.payload,
    v_previous.evidence_refs,
    v_previous.source_task_id,
    v_previous.source_step_id,
    v_previous.source_review_decision_id,
    v_current.id,
    v_previous.id,
    v_previous.expires_at
  )
  returning * into v_result;

  if v_result.scope = 'task' then
    update public.agent_tasks
      set latest_checkpoint = jsonb_set(
            latest_checkpoint,
            '{contract,learning_p1}',
            jsonb_build_object(
              'kind', 'learning_p1_pins_v1',
              'pins', jsonb_build_array(jsonb_build_object(
                'candidate_id', v_result.id::text,
                'version', v_result.version,
                'scope', v_result.scope,
                'kind', v_result.kind
              ))
            ),
            true
          ),
          updated_at = greatest(
            clock_timestamp(),
            updated_at + interval '1 microsecond'
          )
      where id = v_task.id;
  end if;
  return v_result;
end;
$$;

create or replace function public.list_agent_task_learning_candidates_v1(
  p_task_id uuid,
  p_user_id text
) returns setof public.learning_candidates
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_task public.agent_tasks%rowtype;
  v_kind text;
begin
  perform public.lock_learning_candidate_owner_v1(p_user_id);
  select * into v_task
    from public.agent_tasks
    where id = p_task_id;
  if not found or v_task.user_id <> p_user_id then
    raise exception 'agent task not found';
  end if;
  v_kind := v_task.latest_checkpoint #>> '{contract,goal_spec,task_family}';
  update public.learning_candidates
    set status = 'expired',
        updated_at = clock_timestamp()
    where owner_id = p_user_id
      and status = 'active'
      and expires_at is not null
      and expires_at <= clock_timestamp();
  return query
    select candidate.*
      from public.learning_candidates candidate
      where candidate.owner_id = p_user_id
        and (
          candidate.source_task_id = p_task_id
          or (
            candidate.status = 'active'
            and candidate.kind = v_kind
            and (
              (candidate.scope = 'task' and candidate.scope_key = v_task.id::text)
              or (
                candidate.scope = 'matter'
                and candidate.matter_id = v_task.matter_id
              )
              or candidate.scope = 'user'
            )
          )
        )
      order by candidate.created_at desc, candidate.id desc;
end;
$$;

-- A server-only marker asks this BEFORE INSERT trigger to pin the one most
-- specific active version for the new Task family. The same owner lock makes
-- pinning linearizable with confirm, expiry, revoke, and rollback.
create or replace function public.pin_learning_candidates_on_agent_task_insert_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_request jsonb;
  v_kind text;
  v_pins jsonb;
begin
  v_request := new.latest_checkpoint -> 'learning_p1_pin_request';
  if v_request is null then
    return new;
  end if;
  if jsonb_typeof(new.latest_checkpoint) is distinct from 'object'
    or jsonb_typeof(new.latest_checkpoint -> 'contract') is distinct from 'object'
    or jsonb_typeof(v_request) is distinct from 'object'
  then
    raise exception using
      message = 'invalid Learning-P1 pin request',
      errcode = '23514';
  end if;
  -- Key subtraction runs only after the object guard: OR evaluation order is
  -- not guaranteed and the marker must be rejected, never mis-parsed.
  if v_request - 'kind' - 'task_family' <> '{}'::jsonb
    or v_request ->> 'kind' <> 'learning_p1_pin_request_v1'
    or coalesce(v_request ->> 'task_family', '') !~ '^[a-z0-9]+(_[a-z0-9]+)*$'
    or v_request ->> 'task_family'
      is distinct from new.latest_checkpoint #>> '{contract,goal_spec,task_family}'
  then
    raise exception using
      message = 'invalid Learning-P1 pin request',
      errcode = '23514';
  end if;
  v_kind := v_request ->> 'task_family';
  perform public.lock_learning_candidate_owner_v1(new.user_id);
  update public.learning_candidates
    set status = 'expired',
        updated_at = clock_timestamp()
    where owner_id = new.user_id
      and status = 'active'
      and expires_at is not null
      and expires_at <= clock_timestamp();

  select coalesce((
    select jsonb_build_array(jsonb_build_object(
      'candidate_id', candidate.id::text,
      'version', candidate.version,
      'scope', candidate.scope,
      'kind', candidate.kind
    ))
      from public.learning_candidates candidate
      where candidate.owner_id = new.user_id
        and candidate.kind = v_kind
        and candidate.status = 'active'
        and (
          (candidate.scope = 'matter' and candidate.matter_id = new.matter_id)
          or candidate.scope = 'user'
        )
      order by
        case candidate.scope when 'matter' then 0 else 1 end,
        candidate.version desc,
        candidate.id
      limit 1
  ), '[]'::jsonb) into v_pins;

  new.latest_checkpoint := jsonb_set(
    new.latest_checkpoint - 'learning_p1_pin_request',
    '{contract,learning_p1}',
    jsonb_build_object(
      'kind', 'learning_p1_pins_v1',
      'pins', v_pins
    ),
    true
  );
  return new;
end;
$$;

drop trigger if exists pin_learning_candidates_on_agent_task_insert_v1
  on public.agent_tasks;
create trigger pin_learning_candidates_on_agent_task_insert_v1
  before insert on public.agent_tasks
  for each row
  execute function public.pin_learning_candidates_on_agent_task_insert_v1();

revoke all on function public.lock_learning_candidate_owner_v1(text)
  from public, anon, authenticated, service_role;
revoke all on function public.agent_learning_approved_evidence_current_v1(
  uuid, uuid, uuid, text
) from public, anon, authenticated, service_role;
revoke all on function public.confirm_agent_task_learning_candidate_v1(
  uuid, text, uuid, text, timestamptz, uuid, timestamptz
) from public, anon, authenticated, service_role;
revoke all on function public.revoke_agent_task_learning_candidate_v1(
  uuid, text, uuid, timestamptz
) from public, anon, authenticated, service_role;
revoke all on function public.rollback_agent_task_learning_candidate_v1(
  uuid, text, uuid, uuid, timestamptz
) from public, anon, authenticated, service_role;
revoke all on function public.list_agent_task_learning_candidates_v1(
  uuid, text
) from public, anon, authenticated, service_role;
revoke all on function public.pin_learning_candidates_on_agent_task_insert_v1()
  from public, anon, authenticated, service_role;

grant execute on function public.confirm_agent_task_learning_candidate_v1(
  uuid, text, uuid, text, timestamptz, uuid, timestamptz
) to service_role;
grant execute on function public.revoke_agent_task_learning_candidate_v1(
  uuid, text, uuid, timestamptz
) to service_role;
grant execute on function public.rollback_agent_task_learning_candidate_v1(
  uuid, text, uuid, uuid, timestamptz
) to service_role;
grant execute on function public.list_agent_task_learning_candidates_v1(
  uuid, text
) to service_role;
