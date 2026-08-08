begin;

insert into public.projects(id, user_id, name)
values (
  'a1300000-0000-4000-8000-000000000001',
  'user-tabular-approval',
  'Approved Tabular export fixture Matter'
);

insert into public.documents(id, project_id, user_id, status)
values
  (
    'a2300000-0000-4000-8000-000000000001',
    'a1300000-0000-4000-8000-000000000001',
    'user-tabular-approval',
    'ready'
  ),
  (
    'a2300000-0000-4000-8000-000000000002',
    'a1300000-0000-4000-8000-000000000001',
    'user-tabular-approval',
    'ready'
  );

insert into public.document_versions(
  id, document_id, storage_path, source, version_number, filename,
  file_type, size_bytes
) values
  (
    'a3300000-0000-4000-8000-000000000001',
    'a2300000-0000-4000-8000-000000000001',
    'matter/source.txt',
    'upload',
    1,
    'source.txt',
    'txt',
    2048
  ),
  (
    'a3300000-0000-4000-8000-000000000002',
    'a2300000-0000-4000-8000-000000000002',
    'matter/memo.docx',
    'generated',
    3,
    'memo.docx',
    'docx',
    4096
  );

update public.documents
set current_version_id = case id
  when 'a2300000-0000-4000-8000-000000000001'::uuid
    then 'a3300000-0000-4000-8000-000000000001'::uuid
  else 'a3300000-0000-4000-8000-000000000002'::uuid
end
where id in (
  'a2300000-0000-4000-8000-000000000001'::uuid,
  'a2300000-0000-4000-8000-000000000002'::uuid
);

insert into public.agent_tasks(
  id, user_id, matter_id, goal, status, current_step, deliverables,
  latest_checkpoint, execution_lease_owner, execution_lease_expires_at
) values
  (
    'a4300000-0000-4000-8000-000000000001',
    'user-tabular-approval',
    'a1300000-0000-4000-8000-000000000001',
    'Approve the fixed Evidence inventory.',
    'completed',
    'a5300000-0000-4000-8000-000000000002',
    '[{"key":"evidence","title":"Evidence inventory","description":"Fixed evidence review","required":true,"artifact_type":"tabular_review","purpose":"Evidence inventory"}]'::jsonb,
    '{}'::jsonb,
    null,
    null
  ),
  (
    'a4300000-0000-4000-8000-000000000002',
    'user-tabular-approval',
    'a1300000-0000-4000-8000-000000000001',
    'Approve the current Word memo.',
    'completed',
    'a5300000-0000-4000-8000-000000000004',
    '[{"key":"memo","title":"Memo","description":"Current Word memo","required":true,"artifact_type":"draft","purpose":"Memo"}]'::jsonb,
    '{}'::jsonb,
    null,
    null
  );

insert into public.agent_steps(
  id, task_id, position, title, status, attempt, result_summary, result_data
) values
  (
    'a5300000-0000-4000-8000-000000000001',
    'a4300000-0000-4000-8000-000000000001',
    0,
    'Create Evidence inventory',
    'completed',
    1,
    'Created.',
    jsonb_build_object(
      'tabular_effect_receipts',
      jsonb_build_object(
        'agent-step:a5300000-0000-4000-8000-000000000001:attempt:1:create_tabular_review',
        jsonb_build_object(
          'kind', 'agent_step_tabular_effect_v1',
          'effect_key', 'agent-step:a5300000-0000-4000-8000-000000000001:attempt:1:create_tabular_review',
          'step_id', 'a5300000-0000-4000-8000-000000000001',
          'attempt', 1,
          'operation', 'create_tabular_review',
          'input_fingerprint', repeat('1', 64),
          'status', 'committed',
          'target', jsonb_build_object(
            'review_id', 'a6300000-0000-4000-8000-000000000001'
          ),
          'effect', jsonb_build_object(
            'review_id', 'a6300000-0000-4000-8000-000000000001',
            'artifact_type', 'tabular_review'
          ),
          'created_at', '2026-08-08T00:00:00.000Z',
          'committed_at', '2026-08-08T00:00:01.000Z'
        )
      )
    )
  ),
  (
    'a5300000-0000-4000-8000-000000000002',
    'a4300000-0000-4000-8000-000000000001',
    1,
    'Verify Evidence inventory',
    'completed',
    1,
    'Verified.',
    null
  ),
  (
    'a5300000-0000-4000-8000-000000000003',
    'a4300000-0000-4000-8000-000000000002',
    0,
    'Create memo',
    'completed',
    1,
    'Created.',
    null
  ),
  (
    'a5300000-0000-4000-8000-000000000004',
    'a4300000-0000-4000-8000-000000000002',
    1,
    'Verify memo',
    'completed',
    1,
    'Verified.',
    null
  );

insert into public.tabular_reviews(
  id, project_id, user_id, title, practice, row_protocol, workflow_id,
  document_ids, columns_config
) values (
  'a6300000-0000-4000-8000-000000000001',
  'a1300000-0000-4000-8000-000000000001',
  'user-tabular-approval',
  'Evidence inventory',
  'Litigation',
  'document_rows',
  null,
  '["a2300000-0000-4000-8000-000000000001"]'::jsonb,
  '[{"index":0,"name":"Evidence item","format":"text","prompt":"Identify the fixed evidence item.","tags":["evidence_item"]},{"index":1,"name":"Authenticity","format":"text","prompt":"Assess authenticity without inventing proof.","tags":["authenticity"]}]'::jsonb
);

insert into public.tabular_cells(
  id, review_id, document_id, row_id, column_index, status, content,
  citations, review_status, reviewed_at, review_revision
) values
  (
    'a7300000-0000-4000-8000-000000000001',
    'a6300000-0000-4000-8000-000000000001',
    'a2300000-0000-4000-8000-000000000001',
    null,
    0,
    'done',
    '{"summary":"Source-bound item"}',
    '[]'::jsonb,
    'verified',
    '2026-08-08T00:01:00.000Z',
    1
  ),
  (
    'a7300000-0000-4000-8000-000000000002',
    'a6300000-0000-4000-8000-000000000001',
    'a2300000-0000-4000-8000-000000000001',
    null,
    1,
    'done',
    null,
    null,
    'unresolved',
    '2026-08-08T00:01:01.000Z',
    1
  );

insert into public.agent_artifact_links(task_id, artifact_type, artifact_id, purpose)
values
  (
    'a4300000-0000-4000-8000-000000000001',
    'tabular_review',
    'a6300000-0000-4000-8000-000000000001',
    'Evidence inventory'
  ),
  (
    'a4300000-0000-4000-8000-000000000002',
    'draft',
    'a2300000-0000-4000-8000-000000000002',
    'Memo'
  );

do $$
declare
  v_inventory jsonb;
  v_bad_inventory jsonb;
  v_decisions jsonb;
  v_completion jsonb;
  v_bad_completion jsonb;
  v_identity jsonb;
  v_draft_identity jsonb;
  v_tabular_receipt jsonb;
  v_draft_receipt jsonb;
  v_snapshot jsonb;
  v_draft_snapshot jsonb;
  v_revision record;
  v_plan record;
  v record;
  v_document_count integer;
  v_version_count integer;
begin
  v_inventory := jsonb_build_object(
    'kind', 'litigation_evidence_inventory_receipt_v1',
    'task_id', 'a4300000-0000-4000-8000-000000000001',
    'matter_id', 'a1300000-0000-4000-8000-000000000001',
    'review_id', 'a6300000-0000-4000-8000-000000000001',
    'step_id', 'a5300000-0000-4000-8000-000000000001',
    'attempt', 1,
    'procedural_stage', 'first_instance',
    'represented_side', 'claimant',
    'source_pins', jsonb_build_array(jsonb_build_object(
      'document_id', 'a2300000-0000-4000-8000-000000000001',
      'version_id', 'a3300000-0000-4000-8000-000000000001'
    )),
    'fields', jsonb_build_array(
      jsonb_build_object(
        'index', 0,
        'id', 'evidence_item',
        'title', 'Evidence item',
        'semantic_axis', 'Identify the fixed evidence item.'
      ),
      jsonb_build_object(
        'index', 1,
        'id', 'authenticity',
        'title', 'Authenticity',
        'semantic_axis', 'Assess authenticity without inventing proof.'
      )
    ),
    'cells', jsonb_build_array(
      jsonb_build_object(
        'cell_id', 'a7300000-0000-4000-8000-000000000001',
        'document_id', 'a2300000-0000-4000-8000-000000000001',
        'version_id', 'a3300000-0000-4000-8000-000000000001',
        'field', 'evidence_item',
        'field_index', 0
      ),
      jsonb_build_object(
        'cell_id', 'a7300000-0000-4000-8000-000000000002',
        'document_id', 'a2300000-0000-4000-8000-000000000001',
        'version_id', 'a3300000-0000-4000-8000-000000000001',
        'field', 'authenticity',
        'field_index', 1
      )
    ),
    'layout_digest', 'sha256:' || repeat('2', 64)
  );
  select jsonb_agg(jsonb_build_object(
    'cell_id', cell.id,
    'status', cell.status,
    'review_status', cell.review_status,
    'reviewed_at', cell.reviewed_at,
    'review_revision', cell.review_revision,
    'content', cell.content,
    'citations', cell.citations
  ) order by cell.column_index)
  into v_decisions
  from public.tabular_cells cell
  where cell.review_id = 'a6300000-0000-4000-8000-000000000001';
  v_completion := jsonb_build_object(
    'kind', 'litigation_evidence_review_completion_v1',
    'task_id', 'a4300000-0000-4000-8000-000000000001',
    'review_id', 'a6300000-0000-4000-8000-000000000001',
    'step_id', 'a5300000-0000-4000-8000-000000000001',
    'source_receipt_fingerprint', public.agent_sha256_hex_v1(v_inventory),
    'decision_fingerprint', public.agent_sha256_hex_v1(v_decisions),
    'verified_cells', 1,
    'unresolved_cells', 1,
    'completed_at', '2026-08-08T00:02:00.000Z'
  );
  update public.agent_tasks
  set latest_checkpoint = jsonb_build_object(
    'litigation_evidence_inventory_receipt', v_inventory,
    'litigation_evidence_review_completion', v_completion,
    'step_receipts', '[]'::jsonb
  )
  where id = 'a4300000-0000-4000-8000-000000000001';

  select * into v_revision
  from public.read_agent_tabular_review_revision_fingerprint_v1(
    'a4300000-0000-4000-8000-000000000001',
    'user-tabular-approval',
    'a6300000-0000-4000-8000-000000000001',
    repeat('1', 64)
  );
  if v_revision.outcome <> 'current' then
    raise exception 'live revision was not readable: %', row_to_json(v_revision);
  end if;
  v_identity := jsonb_build_object(
    'kind', 'agent_verified_tabular_artifact_v1',
    'review_id', 'a6300000-0000-4000-8000-000000000001',
    'row_protocol', 'document_rows',
    'input_digest', repeat('1', 64),
    'revision_fingerprint', v_revision.revision_fingerprint,
    'accepted_view_sha256', 'sha256:' || repeat('3', 64),
    'source_receipt_fingerprint', v_completion ->> 'source_receipt_fingerprint',
    'decision_fingerprint', v_completion ->> 'decision_fingerprint',
    'completion_sha256', 'sha256:' || public.agent_sha256_hex_v1(v_completion)
  );
  v_tabular_receipt := jsonb_build_object(
    'kind', 'agent_step_receipt_v1',
    'contract_version', 'agent_step_contract_v1',
    'position', 1,
    'attempt', 1,
    'capability', 'verify',
    'operation', 'verify',
    'outcome', 'postconditions_satisfied',
    'summary', 'Verified.',
    'source_version_ids', jsonb_build_array(
      'a3300000-0000-4000-8000-000000000001'
    ),
    'artifact_ids', jsonb_build_array(
      'a6300000-0000-4000-8000-000000000001'
    ),
    'verified_artifacts', jsonb_build_array(v_identity),
    'postconditions', jsonb_build_array(
      jsonb_build_object('code', 'required_deliverables_current', 'status', 'pass'),
      jsonb_build_object('code', 'verifier_passed', 'status', 'pass')
    )
  );
  update public.agent_tasks
  set latest_checkpoint = jsonb_set(
    latest_checkpoint, '{step_receipts}', jsonb_build_array(v_tabular_receipt)
  )
  where id = 'a4300000-0000-4000-8000-000000000001';

  -- The provenance gate rejects duplicate or omitted fixed pins/cells even
  -- when the caller also refreshes the outer receipt fingerprint.
  v_bad_inventory := jsonb_set(
    v_inventory,
    '{source_pins}',
    (v_inventory -> 'source_pins') || (v_inventory -> 'source_pins' -> 0)
  );
  v_bad_completion := jsonb_set(
    v_completion,
    '{source_receipt_fingerprint}',
    to_jsonb(public.agent_sha256_hex_v1(v_bad_inventory))
  );
  update public.agent_tasks set latest_checkpoint = jsonb_set(
    jsonb_set(
      latest_checkpoint,
      '{litigation_evidence_inventory_receipt}',
      v_bad_inventory
    ),
    '{litigation_evidence_review_completion}',
    v_bad_completion
  ) where id = 'a4300000-0000-4000-8000-000000000001';
  select * into v_plan
  from public.prepare_agent_tabular_export_materialization_v1(
    'a4300000-0000-4000-8000-000000000001',
    'user-tabular-approval',
    'a6300000-0000-4000-8000-000000000001',
    'Evidence inventory', v_identity,
    'Evidence inventory - Approved.xlsx', 8192,
    'sha256:' || repeat('5', 64)
  );
  if v_plan.outcome <> 'conflict' then
    raise exception 'duplicate source pin reached materialization';
  end if;

  v_bad_inventory := jsonb_set(
    v_inventory,
    '{source_pins}',
    '[]'::jsonb
  );
  v_bad_completion := jsonb_set(
    v_completion,
    '{source_receipt_fingerprint}',
    to_jsonb(public.agent_sha256_hex_v1(v_bad_inventory))
  );
  update public.agent_tasks set latest_checkpoint = jsonb_set(
    jsonb_set(
      latest_checkpoint,
      '{litigation_evidence_inventory_receipt}',
      v_bad_inventory
    ),
    '{litigation_evidence_review_completion}',
    v_bad_completion
  ) where id = 'a4300000-0000-4000-8000-000000000001';
  select * into v_plan
  from public.prepare_agent_tabular_export_materialization_v1(
    'a4300000-0000-4000-8000-000000000001',
    'user-tabular-approval',
    'a6300000-0000-4000-8000-000000000001',
    'Evidence inventory', v_identity,
    'Evidence inventory - Approved.xlsx', 8192,
    'sha256:' || repeat('5', 64)
  );
  if v_plan.outcome <> 'conflict' then
    raise exception 'omitted source pin reached materialization';
  end if;

  v_bad_inventory := jsonb_set(
    v_inventory,
    '{cells}',
    (v_inventory -> 'cells') || (v_inventory -> 'cells' -> 0)
  );
  v_bad_completion := jsonb_set(
    v_completion,
    '{source_receipt_fingerprint}',
    to_jsonb(public.agent_sha256_hex_v1(v_bad_inventory))
  );
  update public.agent_tasks set latest_checkpoint = jsonb_set(
    jsonb_set(
      latest_checkpoint,
      '{litigation_evidence_inventory_receipt}',
      v_bad_inventory
    ),
    '{litigation_evidence_review_completion}',
    v_bad_completion
  ) where id = 'a4300000-0000-4000-8000-000000000001';
  select * into v_plan
  from public.prepare_agent_tabular_export_materialization_v1(
    'a4300000-0000-4000-8000-000000000001',
    'user-tabular-approval',
    'a6300000-0000-4000-8000-000000000001',
    'Evidence inventory', v_identity,
    'Evidence inventory - Approved.xlsx', 8192,
    'sha256:' || repeat('5', 64)
  );
  if v_plan.outcome <> 'conflict' then
    raise exception 'duplicate fixed cell reached materialization';
  end if;

  v_bad_inventory := jsonb_set(
    v_inventory,
    '{cells}',
    jsonb_build_array(v_inventory -> 'cells' -> 0)
  );
  v_bad_completion := jsonb_set(
    v_completion,
    '{source_receipt_fingerprint}',
    to_jsonb(public.agent_sha256_hex_v1(v_bad_inventory))
  );
  update public.agent_tasks set latest_checkpoint = jsonb_set(
    jsonb_set(
      latest_checkpoint,
      '{litigation_evidence_inventory_receipt}',
      v_bad_inventory
    ),
    '{litigation_evidence_review_completion}',
    v_bad_completion
  ) where id = 'a4300000-0000-4000-8000-000000000001';
  select * into v_plan
  from public.prepare_agent_tabular_export_materialization_v1(
    'a4300000-0000-4000-8000-000000000001',
    'user-tabular-approval',
    'a6300000-0000-4000-8000-000000000001',
    'Evidence inventory', v_identity,
    'Evidence inventory - Approved.xlsx', 8192,
    'sha256:' || repeat('5', 64)
  );
  if v_plan.outcome <> 'conflict' then
    raise exception 'omitted fixed cell reached materialization';
  end if;

  v_bad_inventory := jsonb_set(
    v_inventory,
    '{fields,0,id}',
    to_jsonb('tampered_field'::text)
  );
  v_bad_completion := jsonb_set(
    v_completion,
    '{source_receipt_fingerprint}',
    to_jsonb(public.agent_sha256_hex_v1(v_bad_inventory))
  );
  update public.agent_tasks set latest_checkpoint = jsonb_set(
    jsonb_set(
      latest_checkpoint,
      '{litigation_evidence_inventory_receipt}',
      v_bad_inventory
    ),
    '{litigation_evidence_review_completion}',
    v_bad_completion
  ) where id = 'a4300000-0000-4000-8000-000000000001';
  select * into v_plan
  from public.prepare_agent_tabular_export_materialization_v1(
    'a4300000-0000-4000-8000-000000000001',
    'user-tabular-approval',
    'a6300000-0000-4000-8000-000000000001',
    'Evidence inventory', v_identity,
    'Evidence inventory - Approved.xlsx', 8192,
    'sha256:' || repeat('5', 64)
  );
  if v_plan.outcome <> 'conflict' then
    raise exception 'tampered fixed field reached materialization';
  end if;
  update public.agent_tasks set latest_checkpoint = jsonb_set(
    jsonb_set(
      latest_checkpoint,
      '{litigation_evidence_inventory_receipt}',
      v_inventory
    ),
    '{litigation_evidence_review_completion}',
    v_completion
  ) where id = 'a4300000-0000-4000-8000-000000000001';

  v_draft_identity := jsonb_build_object(
    'kind', 'agent_verified_draft_artifact_v1',
    'document_id', 'a2300000-0000-4000-8000-000000000002',
    'version_id', 'a3300000-0000-4000-8000-000000000002',
    'accepted_view_sha256', 'sha256:' || repeat('4', 64)
  );
  v_draft_receipt := jsonb_build_object(
    'kind', 'agent_step_receipt_v1',
    'contract_version', 'agent_step_contract_v1',
    'position', 1,
    'attempt', 1,
    'capability', 'verify',
    'operation', 'verify',
    'outcome', 'postconditions_satisfied',
    'summary', 'Verified.',
    'source_version_ids', '[]'::jsonb,
    'artifact_ids', jsonb_build_array(
      'a2300000-0000-4000-8000-000000000002'
    ),
    'verified_artifacts', jsonb_build_array(v_draft_identity),
    'postconditions', jsonb_build_array(
      jsonb_build_object('code', 'required_deliverables_current', 'status', 'pass'),
      jsonb_build_object('code', 'verifier_passed', 'status', 'pass')
    )
  );
  update public.agent_tasks
  set latest_checkpoint = jsonb_build_object(
    'step_receipts', jsonb_build_array(v_draft_receipt)
  )
  where id = 'a4300000-0000-4000-8000-000000000002';

  -- Plan rejects every stale binding before an upload is authorized.
  select * into v_plan
  from public.prepare_agent_tabular_export_materialization_v1(
    'a4300000-0000-4000-8000-000000000001',
    'user-tabular-approval',
    'a6300000-0000-4000-8000-000000000001',
    'Evidence inventory',
    jsonb_set(v_identity, '{revision_fingerprint}', to_jsonb(repeat('9', 64))),
    'Evidence inventory - Approved.xlsx',
    8192,
    'sha256:' || repeat('5', 64)
  );
  if v_plan.outcome <> 'conflict' then
    raise exception 'stale Review revision reached materialization';
  end if;
  update public.tabular_cells
  set content = content || ' drift', review_revision = review_revision + 1
  where id = 'a7300000-0000-4000-8000-000000000001';
  select * into v_plan
  from public.prepare_agent_tabular_export_materialization_v1(
    'a4300000-0000-4000-8000-000000000001',
    'user-tabular-approval',
    'a6300000-0000-4000-8000-000000000001',
    'Evidence inventory', v_identity,
    'Evidence inventory - Approved.xlsx', 8192,
    'sha256:' || repeat('5', 64)
  );
  if v_plan.outcome <> 'conflict' then
    raise exception 'cell ABA revision drift reached materialization';
  end if;
  update public.tabular_cells
  set content = '{"summary":"Source-bound item"}', review_revision = 1
  where id = 'a7300000-0000-4000-8000-000000000001';
  update public.documents set current_version_id = null
  where id = 'a2300000-0000-4000-8000-000000000001';
  select * into v_plan
  from public.prepare_agent_tabular_export_materialization_v1(
    'a4300000-0000-4000-8000-000000000001',
    'user-tabular-approval',
    'a6300000-0000-4000-8000-000000000001',
    'Evidence inventory', v_identity,
    'Evidence inventory - Approved.xlsx', 8192,
    'sha256:' || repeat('5', 64)
  );
  if v_plan.outcome <> 'conflict' then
    raise exception 'source Version drift reached materialization';
  end if;
  update public.documents
  set current_version_id = 'a3300000-0000-4000-8000-000000000001'
  where id = 'a2300000-0000-4000-8000-000000000001';

  update public.agent_steps
  set result_data = jsonb_set(
    result_data,
    '{tabular_effect_receipts,agent-step:a5300000-0000-4000-8000-000000000001:attempt:1:create_tabular_review,input_fingerprint}',
    to_jsonb(repeat('8', 64))
  )
  where id = 'a5300000-0000-4000-8000-000000000001';
  select * into v_plan
  from public.prepare_agent_tabular_export_materialization_v1(
    'a4300000-0000-4000-8000-000000000001',
    'user-tabular-approval',
    'a6300000-0000-4000-8000-000000000001',
    'Evidence inventory', v_identity,
    'Evidence inventory - Approved.xlsx', 8192,
    'sha256:' || repeat('5', 64)
  );
  if v_plan.outcome <> 'conflict' then
    raise exception 'effect drift reached materialization';
  end if;
  update public.agent_steps
  set result_data = jsonb_set(
    result_data,
    '{tabular_effect_receipts,agent-step:a5300000-0000-4000-8000-000000000001:attempt:1:create_tabular_review,input_fingerprint}',
    to_jsonb(repeat('1', 64))
  )
  where id = 'a5300000-0000-4000-8000-000000000001';

  update public.agent_tasks
  set latest_checkpoint = jsonb_set(
    latest_checkpoint,
    '{litigation_evidence_review_completion,decision_fingerprint}',
    to_jsonb(repeat('7', 64))
  )
  where id = 'a4300000-0000-4000-8000-000000000001';
  select * into v_plan
  from public.prepare_agent_tabular_export_materialization_v1(
    'a4300000-0000-4000-8000-000000000001',
    'user-tabular-approval',
    'a6300000-0000-4000-8000-000000000001',
    'Evidence inventory', v_identity,
    'Evidence inventory - Approved.xlsx', 8192,
    'sha256:' || repeat('5', 64)
  );
  if v_plan.outcome <> 'conflict' then
    raise exception 'completion drift reached materialization';
  end if;
  update public.agent_tasks
  set latest_checkpoint = jsonb_set(
    latest_checkpoint,
    '{litigation_evidence_review_completion}',
    v_completion
  )
  where id = 'a4300000-0000-4000-8000-000000000001';

  update public.agent_tasks
  set latest_checkpoint = jsonb_set(
    latest_checkpoint,
    '{step_receipts,0,verified_artifacts,0,accepted_view_sha256}',
    to_jsonb('sha256:' || repeat('6', 64))
  )
  where id = 'a4300000-0000-4000-8000-000000000001';
  select * into v_plan
  from public.prepare_agent_tabular_export_materialization_v1(
    'a4300000-0000-4000-8000-000000000001',
    'user-tabular-approval',
    'a6300000-0000-4000-8000-000000000001',
    'Evidence inventory', v_identity,
    'Evidence inventory - Approved.xlsx', 8192,
    'sha256:' || repeat('5', 64)
  );
  if v_plan.outcome <> 'conflict' then
    raise exception 'verifier drift reached materialization';
  end if;
  update public.agent_tasks
  set latest_checkpoint = jsonb_set(
    latest_checkpoint, '{step_receipts}', jsonb_build_array(v_tabular_receipt)
  )
  where id = 'a4300000-0000-4000-8000-000000000001';

  select * into v_plan
  from public.prepare_agent_tabular_export_materialization_v1(
    'a4300000-0000-4000-8000-000000000001',
    'user-tabular-approval',
    'a6300000-0000-4000-8000-000000000001',
    'Evidence inventory', v_identity,
    'Evidence inventory - Approved.xlsx', 8192,
    'sha256:' || repeat('5', 64)
  );
  if v_plan.outcome <> 'prepared' then
    raise exception 'valid export plan failed: %', row_to_json(v_plan);
  end if;
  v_snapshot := jsonb_build_array(jsonb_build_object(
    'kind', 'agent_approved_tabular_artifact_v1',
    'artifact_type', 'tabular_review',
    'artifact_id', 'a6300000-0000-4000-8000-000000000001',
    'purpose', 'Evidence inventory',
    'review_id', 'a6300000-0000-4000-8000-000000000001',
    'row_protocol', 'document_rows',
    'input_digest', v_identity ->> 'input_digest',
    'revision_fingerprint', v_identity ->> 'revision_fingerprint',
    'accepted_view_sha256', v_identity ->> 'accepted_view_sha256',
    'source_receipt_fingerprint', v_identity ->> 'source_receipt_fingerprint',
    'decision_fingerprint', v_identity ->> 'decision_fingerprint',
    'completion_sha256', v_identity ->> 'completion_sha256',
    'export_document_id', v_plan.export_document_id,
    'export_version_id', v_plan.export_version_id,
    'version_number', v_plan.version_number,
    'filename', v_plan.filename,
    'file_type', v_plan.file_type,
    'size_bytes', 8192,
    'sha256', 'sha256:' || repeat('5', 64)
  ));

  -- An extra final-verifier identity cannot be hidden behind an otherwise
  -- exact approved snapshot, and the failed transaction materializes nothing.
  update public.agent_tasks set latest_checkpoint = jsonb_set(
    latest_checkpoint,
    '{step_receipts,0,verified_artifacts}',
    jsonb_build_array(v_identity, v_draft_identity)
  ) where id = 'a4300000-0000-4000-8000-000000000001';
  select * into v from public.record_agent_task_review_decision_v1(
    'a8300000-0000-4000-8000-000000000013',
    'a4300000-0000-4000-8000-000000000001',
    'user-tabular-approval', null, 'approved', '', null, 'Reviewer', v_snapshot
  );
  if v.outcome <> 'invalid_artifacts' then
    raise exception 'extra final-verifier identity was accepted';
  end if;
  update public.agent_tasks set latest_checkpoint = jsonb_set(
    latest_checkpoint,
    '{step_receipts}',
    jsonb_build_array(v_tabular_receipt)
  ) where id = 'a4300000-0000-4000-8000-000000000001';

  -- Legacy Tabular, stale CAS, wrong plan metadata and duplicate rows leave no DB export.
  select * into v from public.record_agent_task_review_decision_v1(
    'a8300000-0000-4000-8000-000000000001',
    'a4300000-0000-4000-8000-000000000001',
    'user-tabular-approval', null, 'approved', '', null, 'Reviewer',
    '[{"artifact_type":"tabular_review","artifact_id":"a6300000-0000-4000-8000-000000000001","purpose":"Evidence inventory","review_id":"a6300000-0000-4000-8000-000000000001","row_protocol":"document_rows","input_digest":"1111111111111111111111111111111111111111111111111111111111111111","revision_fingerprint":"1111111111111111111111111111111111111111111111111111111111111111"}]'::jsonb
  );
  if v.outcome <> 'invalid_artifacts' then
    raise exception 'legacy Tabular approval was accepted';
  end if;
  select * into v from public.record_agent_task_review_decision_v1(
    'a8300000-0000-4000-8000-000000000002',
    'a4300000-0000-4000-8000-000000000001',
    'user-tabular-approval',
    'a8300000-0000-4000-8000-000000000099',
    'approved', '', null, 'Reviewer', v_snapshot
  );
  if v.outcome <> 'conflict' then raise exception 'stale CAS was accepted'; end if;
  select * into v from public.record_agent_task_review_decision_v1(
    'a8300000-0000-4000-8000-000000000003',
    'a4300000-0000-4000-8000-000000000001',
    'user-tabular-approval', null, 'approved', '', null, 'Reviewer',
    jsonb_set(v_snapshot, '{0,version_number}', '99'::jsonb)
  );
  if v.outcome <> 'conflict' then raise exception 'wrong export metadata was accepted'; end if;
  select * into v from public.record_agent_task_review_decision_v1(
    'a8300000-0000-4000-8000-000000000004',
    'a4300000-0000-4000-8000-000000000001',
    'user-tabular-approval', null, 'approved', '', null, 'Reviewer',
    v_snapshot || v_snapshot
  );
  if v.outcome <> 'invalid_artifacts' then raise exception 'duplicate snapshot was accepted'; end if;
  select * into v from public.record_agent_task_review_decision_v1(
    'a8300000-0000-4000-8000-000000000012',
    'a4300000-0000-4000-8000-000000000001',
    'user-tabular-approval', null, 'approved', '', null, 'Reviewer',
    '[]'::jsonb
  );
  if v.outcome <> 'invalid_artifacts' then
    raise exception 'missing required deliverable was accepted';
  end if;
  select count(*) into v_document_count from public.documents
  where id = v_plan.export_document_id;
  select count(*) into v_version_count from public.document_versions
  where id = v_plan.export_version_id;
  if v_document_count <> 0 or v_version_count <> 0 then
    raise exception 'rejected approval left a Document or Version';
  end if;

  if position(
    'for share of source_document' in lower(pg_get_functiondef(
      'public.agent_tabular_live_revision_v1(uuid,text,uuid,text,boolean)'::regprocedure
    ))
  ) = 0 or position(
    'for share of source_version' in lower(pg_get_functiondef(
      'public.agent_tabular_live_revision_v1(uuid,text,uuid,text,boolean)'::regprocedure
    ))
  ) = 0 then
    raise exception 'approval does not hold source Document/Version share locks';
  end if;

  select * into v from public.record_agent_task_review_decision_v1(
    'a8300000-0000-4000-8000-000000000005',
    'a4300000-0000-4000-8000-000000000001',
    'user-tabular-approval', null, 'approved', '', null, 'Reviewer', v_snapshot
  );
  if v.outcome <> 'recorded' then
    raise exception 'valid Tabular approval failed: %', row_to_json(v);
  end if;
  select * into v from public.record_agent_task_review_decision_v1(
    'a8300000-0000-4000-8000-000000000005',
    'a4300000-0000-4000-8000-000000000001',
    'user-tabular-approval', null, 'approved', '', null, 'Reviewer', v_snapshot
  );
  if v.outcome <> 'recorded' or (
    select count(*) from public.agent_task_review_decisions
    where id = 'a8300000-0000-4000-8000-000000000005'
  ) <> 1 then raise exception 'exact replay did not converge'; end if;
  if not public.verify_approved_export_lock(
    'a4300000-0000-4000-8000-000000000001',
    'user-tabular-approval',
    'a8300000-0000-4000-8000-000000000005',
    v_plan.export_document_id,
    v_plan.export_version_id
  ) then raise exception 'approved fixed Tabular Version did not export'; end if;

  -- Live Review drift does not revoke the already-approved fixed Version.
  update public.tabular_cells
  set content = content || ' later edit', review_revision = review_revision + 1
  where id = 'a7300000-0000-4000-8000-000000000001';
  if not public.verify_approved_export_lock(
    'a4300000-0000-4000-8000-000000000001',
    'user-tabular-approval',
    'a8300000-0000-4000-8000-000000000005',
    v_plan.export_document_id,
    v_plan.export_version_id
  ) then raise exception 'live Review edit revoked the approved Version'; end if;

  -- Re-verification of the edited Review produces a second deterministic
  -- Version on the same export Document; the prior Version is not overwritten.
  select jsonb_agg(jsonb_build_object(
    'cell_id', cell.id,
    'status', cell.status,
    'review_status', cell.review_status,
    'reviewed_at', cell.reviewed_at,
    'review_revision', cell.review_revision,
    'content', cell.content,
    'citations', cell.citations
  ) order by cell.column_index)
  into v_decisions
  from public.tabular_cells cell
  where cell.review_id = 'a6300000-0000-4000-8000-000000000001';
  v_completion := jsonb_build_object(
    'kind', 'litigation_evidence_review_completion_v1',
    'task_id', 'a4300000-0000-4000-8000-000000000001',
    'review_id', 'a6300000-0000-4000-8000-000000000001',
    'step_id', 'a5300000-0000-4000-8000-000000000001',
    'source_receipt_fingerprint', public.agent_sha256_hex_v1(v_inventory),
    'decision_fingerprint', public.agent_sha256_hex_v1(v_decisions),
    'verified_cells', 1,
    'unresolved_cells', 1,
    'completed_at', '2026-08-08T00:03:00.000Z'
  );
  update public.agent_tasks
  set latest_checkpoint = jsonb_set(
    jsonb_set(
      latest_checkpoint,
      '{litigation_evidence_review_completion}',
      v_completion
    ),
    '{step_receipts}',
    '[]'::jsonb
  )
  where id = 'a4300000-0000-4000-8000-000000000001';
  select * into v_revision
  from public.read_agent_tabular_review_revision_fingerprint_v1(
    'a4300000-0000-4000-8000-000000000001',
    'user-tabular-approval',
    'a6300000-0000-4000-8000-000000000001',
    repeat('1', 64)
  );
  v_identity := jsonb_build_object(
    'kind', 'agent_verified_tabular_artifact_v1',
    'review_id', 'a6300000-0000-4000-8000-000000000001',
    'row_protocol', 'document_rows',
    'input_digest', repeat('1', 64),
    'revision_fingerprint', v_revision.revision_fingerprint,
    'accepted_view_sha256', 'sha256:' || repeat('7', 64),
    'source_receipt_fingerprint', v_completion ->> 'source_receipt_fingerprint',
    'decision_fingerprint', v_completion ->> 'decision_fingerprint',
    'completion_sha256', 'sha256:' || public.agent_sha256_hex_v1(v_completion)
  );
  v_tabular_receipt := jsonb_set(
    jsonb_set(
      v_tabular_receipt,
      '{verified_artifacts}',
      jsonb_build_array(v_identity)
    ),
    '{summary}',
    to_jsonb('Re-verified.'::text)
  );
  update public.agent_tasks
  set latest_checkpoint = jsonb_set(
    latest_checkpoint, '{step_receipts}', jsonb_build_array(v_tabular_receipt)
  )
  where id = 'a4300000-0000-4000-8000-000000000001';
  select * into v_plan
  from public.prepare_agent_tabular_export_materialization_v1(
    'a4300000-0000-4000-8000-000000000001',
    'user-tabular-approval',
    'a6300000-0000-4000-8000-000000000001',
    'Evidence inventory', v_identity,
    'Evidence inventory - Approved.xlsx', 9216,
    'sha256:' || repeat('8', 64)
  );
  if v_plan.outcome <> 'prepared' or v_plan.version_number <> 2 then
    raise exception 'second approved Version was not planned: %', row_to_json(v_plan);
  end if;
  v_snapshot := jsonb_build_array(jsonb_build_object(
    'kind', 'agent_approved_tabular_artifact_v1',
    'artifact_type', 'tabular_review',
    'artifact_id', 'a6300000-0000-4000-8000-000000000001',
    'purpose', 'Evidence inventory',
    'review_id', 'a6300000-0000-4000-8000-000000000001',
    'row_protocol', 'document_rows',
    'input_digest', v_identity ->> 'input_digest',
    'revision_fingerprint', v_identity ->> 'revision_fingerprint',
    'accepted_view_sha256', v_identity ->> 'accepted_view_sha256',
    'source_receipt_fingerprint', v_identity ->> 'source_receipt_fingerprint',
    'decision_fingerprint', v_identity ->> 'decision_fingerprint',
    'completion_sha256', v_identity ->> 'completion_sha256',
    'export_document_id', v_plan.export_document_id,
    'export_version_id', v_plan.export_version_id,
    'version_number', v_plan.version_number,
    'filename', v_plan.filename,
    'file_type', v_plan.file_type,
    'size_bytes', 9216,
    'sha256', 'sha256:' || repeat('8', 64)
  ));
  select * into v from public.record_agent_task_review_decision_v1(
    'a8300000-0000-4000-8000-000000000010',
    'a4300000-0000-4000-8000-000000000001',
    'user-tabular-approval',
    'a8300000-0000-4000-8000-000000000005',
    'approved', '', null, 'Reviewer', v_snapshot
  );
  if v.outcome <> 'recorded' then raise exception 'second approval failed'; end if;
  if not public.verify_approved_export_lock(
    'a4300000-0000-4000-8000-000000000001',
    'user-tabular-approval',
    'a8300000-0000-4000-8000-000000000010',
    v_plan.export_document_id,
    v_plan.export_version_id
  ) then raise exception 'second approved Version did not export'; end if;
  select * into v from public.record_agent_task_review_decision_v1(
    'a8300000-0000-4000-8000-000000000011',
    'a4300000-0000-4000-8000-000000000001',
    'user-tabular-approval',
    'a8300000-0000-4000-8000-000000000010',
    'changes_requested', 'Re-open the Review.', null, 'Reviewer', '[]'::jsonb
  );
  if v.outcome <> 'recorded' then raise exception 'change request failed'; end if;
  if public.verify_approved_export_lock(
    'a4300000-0000-4000-8000-000000000001',
    'user-tabular-approval',
    'a8300000-0000-4000-8000-000000000010',
    v_plan.export_document_id,
    v_plan.export_version_id
  ) then raise exception 'latest changes_requested did not block export'; end if;

  -- Draft path remains strict, current-Version-bound and verifier-bound.
  v_draft_snapshot := jsonb_build_array(jsonb_build_object(
    'artifact_type', 'draft',
    'artifact_id', 'a2300000-0000-4000-8000-000000000002',
    'purpose', 'Memo',
    'document_id', 'a2300000-0000-4000-8000-000000000002',
    'version_id', 'a3300000-0000-4000-8000-000000000002',
    'version_number', 3,
    'filename', 'memo.docx',
    'file_type', 'docx',
    'size_bytes', 4096,
    'sha256', 'sha256:' || repeat('6', 64)
  ));
  select * into v from public.record_agent_task_review_decision_v1(
    'a8300000-0000-4000-8000-000000000006',
    'a4300000-0000-4000-8000-000000000002',
    'user-tabular-approval', null, 'approved', '', null, 'Reviewer',
    jsonb_set(v_draft_snapshot, '{0,extra}', 'true'::jsonb)
  );
  if v.outcome <> 'invalid_artifacts' then raise exception 'extra Draft key was accepted'; end if;
  update public.agent_tasks set latest_checkpoint = '{"step_receipts":[]}'::jsonb
  where id = 'a4300000-0000-4000-8000-000000000002';
  select * into v from public.record_agent_task_review_decision_v1(
    'a8300000-0000-4000-8000-000000000007',
    'a4300000-0000-4000-8000-000000000002',
    'user-tabular-approval', null, 'approved', '', null, 'Reviewer',
    v_draft_snapshot
  );
  if v.outcome <> 'invalid_artifacts' then raise exception 'missing Draft verifier identity was accepted'; end if;
  update public.agent_tasks set latest_checkpoint = jsonb_build_object(
    'step_receipts', jsonb_build_array(v_draft_receipt)
  ) where id = 'a4300000-0000-4000-8000-000000000002';
  select * into v from public.record_agent_task_review_decision_v1(
    'a8300000-0000-4000-8000-000000000008',
    'a4300000-0000-4000-8000-000000000002',
    'user-tabular-approval', null, 'approved', '', null, 'Reviewer',
    jsonb_set(v_draft_snapshot, '{0,size_bytes}', '4095'::jsonb)
  );
  if v.outcome <> 'invalid_artifacts' then raise exception 'Draft metadata drift was accepted'; end if;
  select * into v from public.record_agent_task_review_decision_v1(
    'a8300000-0000-4000-8000-000000000009',
    'a4300000-0000-4000-8000-000000000002',
    'user-tabular-approval', null, 'approved', '', null, 'Reviewer',
    v_draft_snapshot
  );
  if v.outcome <> 'recorded' then raise exception 'valid Draft approval regressed'; end if;
  if not public.verify_approved_export_lock(
    'a4300000-0000-4000-8000-000000000002',
    'user-tabular-approval',
    'a8300000-0000-4000-8000-000000000009',
    'a2300000-0000-4000-8000-000000000002',
    'a3300000-0000-4000-8000-000000000002'
  ) then raise exception 'Draft final export lock regressed'; end if;

  if has_function_privilege(
    'authenticated',
    'public.prepare_agent_tabular_export_materialization_v1(uuid,text,uuid,text,jsonb,text,integer,text)',
    'execute'
  ) or has_function_privilege(
    'authenticated',
    'public.read_agent_tabular_review_revision_fingerprint_v1(uuid,text,uuid,text)',
    'execute'
  ) then raise exception 'authenticated can execute internal Tabular approval RPCs'; end if;
end $$;

rollback;
