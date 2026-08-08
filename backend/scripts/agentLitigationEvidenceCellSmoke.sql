-- Apply migrations 20260808_10 and 20260808_11 first, then run with psql.
-- This smoke is transactional: it leaves the local database unchanged.
-- It covers lease/effect fencing, replay, lawyer CAS, unresolved pending cells,
-- and a new Step attempt preserving completed fixed coordinates.
begin;

insert into public.projects(id, user_id, name)
values (
  '18100000-0000-4000-8000-000000000001',
  'user-litigation-cell',
  'Litigation cell fixture Matter'
);

insert into public.documents(id, project_id, user_id, status)
values (
  '28100000-0000-4000-8000-000000000001',
  '18100000-0000-4000-8000-000000000001',
  'user-litigation-cell',
  'ready'
);

insert into public.document_versions(
  id, document_id, storage_path, filename, file_type, version_number
) values (
  '38100000-0000-4000-8000-000000000001',
  '28100000-0000-4000-8000-000000000001',
  'smoke/litigation-source-v1.pdf',
  'Bluewater evidence.pdf',
  'pdf',
  1
);

update public.documents
set current_version_id = '38100000-0000-4000-8000-000000000001'
where id = '28100000-0000-4000-8000-000000000001';

insert into public.agent_tasks(
  id, user_id, matter_id, goal, status, current_step,
  execution_lease_owner, execution_lease_expires_at, latest_checkpoint
) values (
  '48100000-0000-4000-8000-000000000001',
  'user-litigation-cell',
  '18100000-0000-4000-8000-000000000001',
  'Generate a fixed Evidence Inventory',
  'running',
  '58100000-0000-4000-8000-000000000001',
  '68100000-0000-4000-8000-000000000001',
  clock_timestamp() + interval '5 minutes',
  jsonb_build_object(
    'fixed_matter_context', jsonb_build_object(
      'kind', 'matter_context_v1',
      'matter_id', '18100000-0000-4000-8000-000000000001',
      'sources', jsonb_build_array(jsonb_build_object(
        'document_id', '28100000-0000-4000-8000-000000000001',
        'version_id', '38100000-0000-4000-8000-000000000001',
        'filename', 'Bluewater evidence.pdf',
        'file_type', 'pdf',
        'role', 'source'
      )),
      'workflow', null,
      'compiled_at', '2026-08-08T00:00:00.000Z'
    ),
    'contract', jsonb_build_object(
      'context_manifest', jsonb_build_object(
        'kind', 'matter_context_v1',
        'matter_id', '18100000-0000-4000-8000-000000000001',
        'sources', jsonb_build_array(jsonb_build_object(
          'document_id', '28100000-0000-4000-8000-000000000001',
          'version_id', '38100000-0000-4000-8000-000000000001',
          'filename', 'Bluewater evidence.pdf',
          'file_type', 'pdf',
          'role', 'source'
        )),
        'workflow', null,
        'compiled_at', '2026-08-08T00:00:00.000Z'
      )
    ),
    'litigation_evidence_inventory_receipt', jsonb_build_object(
      'kind', 'litigation_evidence_inventory_receipt_v1',
      'task_id', '48100000-0000-4000-8000-000000000001',
      'matter_id', '18100000-0000-4000-8000-000000000001',
      'step_id', '58100000-0000-4000-8000-000000000001',
      'attempt', 1,
      'review_id', '78100000-0000-4000-8000-000000000001',
      'cells', jsonb_build_array(
        jsonb_build_object(
          'cell_id', '88100000-0000-4000-8000-000000000001',
          'document_id', '28100000-0000-4000-8000-000000000001',
          'version_id', '38100000-0000-4000-8000-000000000001',
          'field_index', 0
        ),
        jsonb_build_object(
          'cell_id', '98100000-0000-4000-8000-000000000001',
          'document_id', '28100000-0000-4000-8000-000000000001',
          'version_id', '38100000-0000-4000-8000-000000000001',
          'field_index', 1
        )
      )
    )
  )
);

insert into public.agent_steps(
  id, task_id, position, capability, title, status, attempt, result_data
) values (
  '58100000-0000-4000-8000-000000000001',
  '48100000-0000-4000-8000-000000000001',
  0, 'create_tabular', 'Create evidence inventory', 'running', 1,
  '{}'::jsonb
);

insert into public.tabular_reviews(
  id, project_id, user_id, title, practice, row_protocol, document_ids,
  columns_config
) values (
  '78100000-0000-4000-8000-000000000001',
  '18100000-0000-4000-8000-000000000001',
  'user-litigation-cell',
  'Evidence inventory',
  'Litigation',
  'document_rows',
  '["28100000-0000-4000-8000-000000000001"]'::jsonb,
  '[{"index":0,"name":"Evidence item"},{"index":1,"name":"Authenticity"}]'::jsonb
);

insert into public.tabular_cells(
  id, review_id, document_id, row_id, column_index, status
) values
  (
    '88100000-0000-4000-8000-000000000001',
    '78100000-0000-4000-8000-000000000001',
    '28100000-0000-4000-8000-000000000001',
    null, 0, 'pending'
  ),
  (
    '98100000-0000-4000-8000-000000000001',
    '78100000-0000-4000-8000-000000000001',
    '28100000-0000-4000-8000-000000000001',
    null, 1, 'pending'
  );

do $$
declare
  v record;
  v_key text := 'agent-step:58100000-0000-4000-8000-000000000001:attempt:1:create_tabular_review';
  v_receipt jsonb := jsonb_build_object(
    'kind', 'agent_step_tabular_effect_v1',
    'effect_key', 'agent-step:58100000-0000-4000-8000-000000000001:attempt:1:create_tabular_review',
    'step_id', '58100000-0000-4000-8000-000000000001',
    'attempt', 1,
    'operation', 'create_tabular_review',
    'input_fingerprint', repeat('a', 64),
    'status', 'reserved',
    'target', jsonb_build_object('review_id', '78100000-0000-4000-8000-000000000001'),
    'effect', null,
    'created_at', '2026-08-08T00:00:00.000Z',
    'committed_at', null
  );
  v_layout jsonb := jsonb_build_object(
    'document_ids', jsonb_build_array('28100000-0000-4000-8000-000000000001'),
    'columns_config', '[{"index":0,"name":"Evidence item"},{"index":1,"name":"Authenticity"}]'::jsonb,
    'cells', jsonb_build_array(
      jsonb_build_object(
        'id', '88100000-0000-4000-8000-000000000001',
        'document_id', '28100000-0000-4000-8000-000000000001',
        'column_index', 0
      ),
      jsonb_build_object(
        'id', '98100000-0000-4000-8000-000000000001',
        'document_id', '28100000-0000-4000-8000-000000000001',
        'column_index', 1
      )
    )
  );
  v_content text := '{"kind":"litigation_evidence_inventory_cell_content_v1","candidate":{"cell_id":"88100000-0000-4000-8000-000000000001"},"summary":"Evidence item: Bluewater agreement","reasoning":"The source heading identifies the agreement.","flag":"grey","model_review_status":"unverified"}';
  v_citations jsonb := '[{"citation_id":"citation-smoke","quote":"Bluewater agreement"}]'::jsonb;
begin
  select * into v from public.reserve_agent_step_tabular_effect_v1(
    '48100000-0000-4000-8000-000000000001',
    'user-litigation-cell',
    '58100000-0000-4000-8000-000000000001',
    1,
    '68100000-0000-4000-8000-000000000001',
    v_key,
    v_receipt
  );
  if v.outcome <> 'reserved' then
    raise exception 'initial Tabular reservation failed: %', row_to_json(v);
  end if;

  select * into v from public.commit_agent_step_tabular_effect_v1(
    '48100000-0000-4000-8000-000000000001',
    'user-litigation-cell',
    '58100000-0000-4000-8000-000000000001',
    1,
    '68100000-0000-4000-8000-000000000001',
    v_key,
    v_receipt,
    '78100000-0000-4000-8000-000000000001',
    v_layout,
    '2026-08-08T00:01:00.000Z'
  );
  if v.outcome <> 'committed' then
    raise exception 'initial Tabular commit failed: %', row_to_json(v);
  end if;

  select * into v from public.commit_agent_litigation_evidence_cell_v1(
    '48100000-0000-4000-8000-000000000001',
    'user-litigation-cell',
    '58100000-0000-4000-8000-000000000001',
    1,
    '68100000-0000-4000-8000-000000000001',
    '78100000-0000-4000-8000-000000000001',
    '88100000-0000-4000-8000-000000000001',
    '28100000-0000-4000-8000-000000000001',
    '38100000-0000-4000-8000-000000000001',
    0,
    v_content,
    v_citations
  );
  if v.outcome <> 'committed' or v.cell_status <> 'done'
    or v.review_status is not null or v.review_revision <> 0 then
    raise exception 'fixed generated cell was not committed: %', row_to_json(v);
  end if;

  select * into v from public.commit_agent_litigation_evidence_cell_v1(
    '48100000-0000-4000-8000-000000000001',
    'user-litigation-cell',
    '58100000-0000-4000-8000-000000000001',
    1,
    '68100000-0000-4000-8000-000000000001',
    '78100000-0000-4000-8000-000000000001',
    '88100000-0000-4000-8000-000000000001',
    '28100000-0000-4000-8000-000000000001',
    '38100000-0000-4000-8000-000000000001',
    0,
    v_content,
    v_citations
  );
  if v.outcome <> 'recovered' then
    raise exception 'same generated cell did not recover: %', row_to_json(v);
  end if;

  select * into v from public.commit_agent_litigation_evidence_cell_v1(
    '48100000-0000-4000-8000-000000000001',
    'user-litigation-cell',
    '58100000-0000-4000-8000-000000000001',
    1,
    '68100000-0000-4000-8000-000000000001',
    '78100000-0000-4000-8000-000000000001',
    '88100000-0000-4000-8000-000000000001',
    '28100000-0000-4000-8000-000000000001',
    '38100000-0000-4000-8000-000000000001',
    0,
    replace(v_content, 'Bluewater agreement', 'Different evidence'),
    v_citations
  );
  if v.outcome <> 'conflict' then
    raise exception 'different generated cell rewrote an effect: %', row_to_json(v);
  end if;

  select * into v from public.review_litigation_evidence_cell_v1(
    'user-litigation-cell',
    '78100000-0000-4000-8000-000000000001',
    '88100000-0000-4000-8000-000000000001',
    0,
    'verified'
  );
  if v.outcome <> 'reviewed' or v.review_status <> 'verified'
    or v.review_revision <> 1 then
    raise exception 'verified lawyer review failed: %', row_to_json(v);
  end if;

  select * into v from public.commit_agent_litigation_evidence_cell_v1(
    '48100000-0000-4000-8000-000000000001',
    'user-litigation-cell',
    '58100000-0000-4000-8000-000000000001',
    1,
    '68100000-0000-4000-8000-000000000001',
    '78100000-0000-4000-8000-000000000001',
    '88100000-0000-4000-8000-000000000001',
    '28100000-0000-4000-8000-000000000001',
    '38100000-0000-4000-8000-000000000001',
    0,
    v_content,
    v_citations
  );
  if v.outcome <> 'recovered' or v.review_status <> 'verified'
    or v.review_revision <> 1 then
    raise exception 'generated retry overwrote the lawyer disposition: %', row_to_json(v);
  end if;

  select * into v from public.review_litigation_evidence_cell_v1(
    'user-litigation-cell',
    '78100000-0000-4000-8000-000000000001',
    '98100000-0000-4000-8000-000000000001',
    0,
    'unresolved'
  );
  if v.outcome <> 'reviewed' or v.cell_status <> 'pending'
    or v.review_status <> 'unresolved' or v.review_revision <> 1 then
    raise exception 'unresolved pending cell was not reviewable: %', row_to_json(v);
  end if;

  select * into v from public.review_litigation_evidence_cell_v1(
    'user-litigation-cell',
    '78100000-0000-4000-8000-000000000001',
    '98100000-0000-4000-8000-000000000001',
    1,
    'verified'
  );
  if v.outcome <> 'artifact_invalid' then
    raise exception 'pending cell was incorrectly marked verified: %', row_to_json(v);
  end if;

  select * into v from public.review_litigation_evidence_cell_v1(
    'user-litigation-cell',
    '78100000-0000-4000-8000-000000000001',
    '98100000-0000-4000-8000-000000000001',
    1,
    'needs_correction'
  );
  if v.outcome <> 'reviewed' or v.cell_status <> 'pending'
    or v.review_status <> 'needs_correction' or v.review_revision <> 2 then
    raise exception 'pending correction review failed: %', row_to_json(v);
  end if;

  update public.agent_steps
  set attempt = 2, result_data = '{}'::jsonb
  where id = '58100000-0000-4000-8000-000000000001';

  v_key := 'agent-step:58100000-0000-4000-8000-000000000001:attempt:2:create_tabular_review';
  v_receipt := jsonb_set(
    jsonb_set(v_receipt, '{effect_key}', to_jsonb(v_key)),
    '{attempt}',
    '2'::jsonb
  );
  select * into v from public.reserve_agent_step_tabular_effect_v1(
    '48100000-0000-4000-8000-000000000001',
    'user-litigation-cell',
    '58100000-0000-4000-8000-000000000001',
    2,
    '68100000-0000-4000-8000-000000000001',
    v_key,
    v_receipt
  );
  if v.outcome <> 'reserved' then
    raise exception 'new-attempt Tabular reservation failed: %', row_to_json(v);
  end if;
  select * into v from public.commit_agent_step_tabular_effect_v1(
    '48100000-0000-4000-8000-000000000001',
    'user-litigation-cell',
    '58100000-0000-4000-8000-000000000001',
    2,
    '68100000-0000-4000-8000-000000000001',
    v_key,
    v_receipt,
    '78100000-0000-4000-8000-000000000001',
    v_layout,
    '2026-08-08T00:02:00.000Z'
  );
  if v.outcome <> 'committed' then
    raise exception 'new attempt rejected completed fixed cells: %', row_to_json(v);
  end if;
end;
$$;

set role authenticated;
do $$
begin
  begin
    perform * from public.commit_agent_litigation_evidence_cell_v1(
      '48100000-0000-4000-8000-000000000001',
      'user-litigation-cell',
      '58100000-0000-4000-8000-000000000001',
      2,
      '68100000-0000-4000-8000-000000000001',
      '78100000-0000-4000-8000-000000000001',
      '88100000-0000-4000-8000-000000000001',
      '28100000-0000-4000-8000-000000000001',
      '38100000-0000-4000-8000-000000000001',
      0,
      '{"summary":"unauthorized"}',
      '[]'::jsonb
    );
    raise exception 'authenticated unexpectedly committed a litigation cell';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;

rollback;
