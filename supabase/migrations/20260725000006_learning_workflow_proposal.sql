-- Q13 editable Workflow proposal: the single transactional save path. A
-- proposal draft is compiled server-side and never persisted; only this
-- explicit save inserts exactly one ordinary row into the existing workflows
-- table. A server-derived UUID namespaces the stable request id by owner and
-- candidate, so an exact retry returns the same row while a reused id with any
-- different payload conflicts and never overwrites. Revoke/save concurrency is
-- linearized through the same per-owner advisory lock every Learning-P1
-- mutation already takes. No table or column is added.
create or replace function public.save_agent_task_learning_workflow_proposal_v1(
  p_task_id uuid,
  p_user_id text,
  p_candidate_id uuid,
  p_request_id uuid,
  p_workflow jsonb
) returns public.workflows
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_task public.agent_tasks%rowtype;
  v_candidate public.learning_candidates%rowtype;
  v_source_task public.agent_tasks%rowtype;
  v_source_step public.agent_steps%rowtype;
  v_source_decision public.agent_task_review_decisions%rowtype;
  v_existing public.workflows%rowtype;
  v_result public.workflows%rowtype;
  v_workflow_id uuid;
  v_metadata jsonb;
  v_columns jsonb;
  v_column jsonb;
  v_jurisdictions text[];
  v_title text;
  v_type text;
  v_prompt_md text;
  v_language text;
  v_practice text;
  v_applicable boolean;
begin
  -- Only the ordinary editable Workflow fields are accepted. Identity,
  -- lifecycle, evidence, and task fields are rejected, never ignored.
  if p_task_id is null
    or p_candidate_id is null
    or p_request_id is null
    or coalesce(btrim(p_user_id), '') = ''
    or jsonb_typeof(p_workflow) is distinct from 'object'
    or p_workflow - 'metadata' - 'skill_md' - 'columns_config' <> '{}'::jsonb
  then
    raise exception using
      message = 'invalid learning workflow proposal',
      errcode = '23514';
  end if;
  v_metadata := p_workflow -> 'metadata';
  if jsonb_typeof(v_metadata) is distinct from 'object'
    or v_metadata - 'title' - 'type' - 'language' - 'practice' - 'jurisdictions'
      <> '{}'::jsonb
    or jsonb_typeof(v_metadata -> 'title') is distinct from 'string'
    or jsonb_typeof(v_metadata -> 'type') is distinct from 'string'
  then
    raise exception using
      message = 'invalid learning workflow proposal',
      errcode = '23514';
  end if;
  v_title := btrim(v_metadata ->> 'title');
  v_type := v_metadata ->> 'type';
  if v_title = ''
    or char_length(v_title) > 200
    or v_type not in ('assistant', 'tabular')
  then
    raise exception using
      message = 'invalid learning workflow proposal',
      errcode = '23514';
  end if;
  if v_metadata -> 'language' is not null
    and jsonb_typeof(v_metadata -> 'language') <> 'null'
  then
    if jsonb_typeof(v_metadata -> 'language') is distinct from 'string' then
      raise exception using
        message = 'invalid learning workflow proposal',
        errcode = '23514';
    end if;
    v_language := nullif(btrim(v_metadata ->> 'language'), '');
    if v_language is not null and char_length(v_language) > 120 then
      raise exception using
        message = 'invalid learning workflow proposal',
        errcode = '23514';
    end if;
  end if;
  if v_metadata -> 'practice' is not null
    and jsonb_typeof(v_metadata -> 'practice') <> 'null'
  then
    if jsonb_typeof(v_metadata -> 'practice') is distinct from 'string' then
      raise exception using
        message = 'invalid learning workflow proposal',
        errcode = '23514';
    end if;
    v_practice := nullif(btrim(v_metadata ->> 'practice'), '');
    if v_practice is not null and char_length(v_practice) > 120 then
      raise exception using
        message = 'invalid learning workflow proposal',
        errcode = '23514';
    end if;
  end if;
  if v_metadata -> 'jurisdictions' is not null
    and jsonb_typeof(v_metadata -> 'jurisdictions') <> 'null'
  then
    -- jsonb_array_elements_text errors on a non-array and SQL never
    -- guarantees OR evaluation order, so content checks run only after the
    -- array guard.
    if jsonb_typeof(v_metadata -> 'jurisdictions') is distinct from 'array' then
      raise exception using
        message = 'invalid learning workflow proposal',
        errcode = '23514';
    end if;
    if (
      select count(*)
        from jsonb_array_elements(v_metadata -> 'jurisdictions') item(value)
    ) > 12 or exists (
      select 1
        from jsonb_array_elements(v_metadata -> 'jurisdictions') item(value)
        where jsonb_typeof(item.value) is distinct from 'string'
    ) then
      raise exception using
        message = 'invalid learning workflow proposal',
        errcode = '23514';
    end if;
    if exists (
      select 1
        from jsonb_array_elements(v_metadata -> 'jurisdictions') item(value)
        where btrim(item.value #>> '{}') = ''
          or char_length(btrim(item.value #>> '{}')) > 120
    ) then
      raise exception using
        message = 'invalid learning workflow proposal',
        errcode = '23514';
    end if;
    select coalesce(array_agg(btrim(item.value #>> '{}')), '{}'::text[])
      into v_jurisdictions
      from jsonb_array_elements(v_metadata -> 'jurisdictions') item(value);
  end if;
  if p_workflow -> 'skill_md' is not null
    and jsonb_typeof(p_workflow -> 'skill_md') <> 'null'
  then
    if jsonb_typeof(p_workflow -> 'skill_md') is distinct from 'string'
      or char_length(btrim(p_workflow ->> 'skill_md')) > 32000
    then
      raise exception using
        message = 'invalid learning workflow proposal',
        errcode = '23514';
    end if;
    if nullif(btrim(p_workflow ->> 'skill_md'), '') is not null then
      v_prompt_md := p_workflow ->> 'skill_md';
    end if;
  end if;
  if p_workflow -> 'columns_config' is not null
    and jsonb_typeof(p_workflow -> 'columns_config') <> 'null'
  then
    if jsonb_typeof(p_workflow -> 'columns_config') is distinct from 'array' then
      raise exception using
        message = 'invalid learning workflow proposal',
        errcode = '23514';
    end if;
    if jsonb_array_length(p_workflow -> 'columns_config') not between 1 and 40 then
      raise exception using
        message = 'invalid learning workflow proposal',
        errcode = '23514';
    end if;
    for v_column in
      select element.value
        from jsonb_array_elements(p_workflow -> 'columns_config') element(value)
    loop
      if jsonb_typeof(v_column) is distinct from 'object'
        or v_column - 'index' - 'name' - 'prompt' - 'format' - 'tags'
          <> '{}'::jsonb
        or jsonb_typeof(v_column -> 'index') is distinct from 'number'
        or jsonb_typeof(v_column -> 'name') is distinct from 'string'
        or jsonb_typeof(v_column -> 'prompt') is distinct from 'string'
      then
        raise exception using
          message = 'invalid learning workflow proposal',
          errcode = '23514';
      end if;
      -- Numeric casts run only after the type guard above.
      if (v_column ->> 'index')::numeric
          <> floor((v_column ->> 'index')::numeric)
        or (v_column ->> 'index')::numeric < 0
        or (v_column ->> 'index')::numeric > 1000
        or btrim(v_column ->> 'name') = ''
        or char_length(btrim(v_column ->> 'name')) > 120
        or btrim(v_column ->> 'prompt') = ''
        or char_length(btrim(v_column ->> 'prompt')) > 4000
      then
        raise exception using
          message = 'invalid learning workflow proposal',
          errcode = '23514';
      end if;
      if v_column -> 'format' is not null
        and jsonb_typeof(v_column -> 'format') <> 'null'
      then
        if jsonb_typeof(v_column -> 'format') is distinct from 'string'
          or v_column ->> 'format' not in (
            'text', 'bulleted_list', 'number', 'currency', 'yes_no', 'date',
            'tag', 'percentage', 'monetary_amount'
          )
        then
          raise exception using
            message = 'invalid learning workflow proposal',
            errcode = '23514';
        end if;
      end if;
      if v_column -> 'tags' is not null
        and jsonb_typeof(v_column -> 'tags') <> 'null'
      then
        if jsonb_typeof(v_column -> 'tags') is distinct from 'array' then
          raise exception using
            message = 'invalid learning workflow proposal',
            errcode = '23514';
        end if;
        if (
          select count(*)
            from jsonb_array_elements(v_column -> 'tags') tag(value)
        ) > 12 or exists (
          select 1
            from jsonb_array_elements(v_column -> 'tags') tag(value)
            where jsonb_typeof(tag.value) is distinct from 'string'
        ) then
          raise exception using
            message = 'invalid learning workflow proposal',
            errcode = '23514';
        end if;
        if exists (
          select 1
            from jsonb_array_elements(v_column -> 'tags') tag(value)
            where btrim(tag.value #>> '{}') = ''
              or char_length(btrim(tag.value #>> '{}')) > 60
        ) then
          raise exception using
            message = 'invalid learning workflow proposal',
            errcode = '23514';
        end if;
      end if;
    end loop;
    if (
      select count(distinct element.value ->> 'index')
        from jsonb_array_elements(p_workflow -> 'columns_config') element(value)
    ) <> jsonb_array_length(p_workflow -> 'columns_config') then
      raise exception using
        message = 'invalid learning workflow proposal',
        errcode = '23514';
    end if;
    v_columns := p_workflow -> 'columns_config';
  end if;
  if (v_type = 'assistant' and v_prompt_md is null)
    or (v_type = 'tabular' and v_columns is null)
  then
    raise exception using
      message = 'invalid learning workflow proposal',
      errcode = '23514';
  end if;
  -- The same defaults the ordinary workflow create route applies.
  v_language := coalesce(v_language, 'English');
  v_practice := coalesce(v_practice, 'General Transactions');
  v_jurisdictions := coalesce(v_jurisdictions, array['General']::text[]);

  perform public.lock_learning_candidate_owner_v1(p_user_id);
  select * into v_task
    from public.agent_tasks
    where id = p_task_id
    for update;
  if not found or v_task.user_id <> p_user_id then
    raise exception 'agent task not found';
  end if;

  -- Namespace the client request id by the server-owned candidate and owner.
  -- This makes an existing row evidence of this exact Q13 operation rather than
  -- an unrelated ordinary Workflow whose client happened to reuse its UUID.
  v_workflow_id := md5(jsonb_build_array(
    'vera_learning_workflow_proposal_v1',
    p_user_id,
    p_candidate_id::text,
    p_request_id::text
  )::text)::uuid;
  -- Exact operation replay is accepted after task ownership is verified and
  -- before mutable lifecycle baselines. Reusing the same request id with a
  -- different payload is a conflict.
  select * into v_existing
    from public.workflows
    where id = v_workflow_id
    for update;
  if found then
    if v_existing.user_id is distinct from p_user_id
      or v_existing.title is distinct from v_title
      or v_existing.type is distinct from v_type
      or v_existing.prompt_md is distinct from v_prompt_md
      or v_existing.columns_config is distinct from v_columns
      or v_existing.language is distinct from v_language
      or v_existing.practice is distinct from v_practice
      or v_existing.jurisdictions is distinct from v_jurisdictions
    then
      raise exception using
        message = 'learning workflow proposal id payload mismatch',
        errcode = '40001';
    end if;
    return v_existing;
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
  if not found
    or v_candidate.status <> 'active'
    or v_candidate.confirmed_at is null
    or (
      v_candidate.expires_at is not null
      and v_candidate.expires_at <= clock_timestamp()
    )
  then
    raise exception using
      message = 'stale or ineligible learning workflow proposal',
      errcode = '40001';
  end if;
  -- Applicability mirrors the task-contextual candidate list: the exact
  -- selected token must belong to this task as its source, or be an active
  -- candidate for this task family in this task, Matter, or user scope.
  v_applicable := v_candidate.source_task_id = p_task_id
    or (
      v_candidate.kind
        = v_task.latest_checkpoint #>> '{contract,goal_spec,task_family}'
      and (
        (v_candidate.scope = 'task' and v_candidate.scope_key = v_task.id::text)
        or (
          v_candidate.scope = 'matter'
          and v_candidate.matter_id = v_task.matter_id
        )
        or v_candidate.scope = 'user'
      )
    );
  if not v_applicable then
    raise exception using
      message = 'stale or ineligible learning workflow proposal',
      errcode = '40001';
  end if;

  -- The approved evidence behind the candidate is re-verified inside this
  -- transaction: source Task/Step/Decision and the approved document versions
  -- are locked in deterministic order before the currentness re-check.
  select * into v_source_task
    from public.agent_tasks
    where id = v_candidate.source_task_id
    for update;
  select * into v_source_step
    from public.agent_steps
    where id = v_candidate.source_step_id
    for update;
  select * into v_source_decision
    from public.agent_task_review_decisions
    where id = v_candidate.source_review_decision_id
    for update;
  if jsonb_typeof(v_source_decision.artifact_snapshot) is distinct from 'array' then
    raise exception using
      message = 'stale learning workflow proposal evidence',
      errcode = '40001';
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
  if not public.agent_learning_approved_evidence_current_v1(
    v_candidate.source_task_id,
    v_candidate.source_step_id,
    v_candidate.source_review_decision_id,
    p_user_id
  ) then
    raise exception using
      message = 'learning workflow proposal evidence is no longer current',
      errcode = '40001';
  end if;

  insert into public.workflows(
    id,
    user_id,
    title,
    type,
    prompt_md,
    columns_config,
    language,
    practice,
    jurisdictions
  ) values (
    v_workflow_id,
    p_user_id,
    v_title,
    v_type,
    v_prompt_md,
    v_columns,
    v_language,
    v_practice,
    v_jurisdictions
  )
  on conflict (id) do nothing
  returning * into v_result;
  if not found then
    -- A concurrent commit landed this id first. It is a replay only when the
    -- payload matches exactly; anything else conflicts and is never
    -- overwritten.
    select * into v_result
      from public.workflows
      where id = v_workflow_id;
    if not found
      or v_result.user_id is distinct from p_user_id
      or v_result.title is distinct from v_title
      or v_result.type is distinct from v_type
      or v_result.prompt_md is distinct from v_prompt_md
      or v_result.columns_config is distinct from v_columns
      or v_result.language is distinct from v_language
      or v_result.practice is distinct from v_practice
      or v_result.jurisdictions is distinct from v_jurisdictions
    then
      raise exception using
        message = 'learning workflow proposal id payload mismatch',
        errcode = '40001';
    end if;
  end if;
  return v_result;
end;
$$;

revoke all on function public.save_agent_task_learning_workflow_proposal_v1(
  uuid, text, uuid, uuid, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.save_agent_task_learning_workflow_proposal_v1(
  uuid, text, uuid, uuid, jsonb
) to service_role;
