import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("keeps approved Tabular export migrations mirrored and fail closed", async () => {
  const backend = await readFile(
    new URL(
      "../../migrations/20260808_13_agent_tabular_approval_export.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const supabase = await readFile(
    new URL(
      "../../../supabase/migrations/20260808000013_agent_tabular_approval_export.sql",
      import.meta.url,
    ),
    "utf8",
  );

  assert.equal(backend, supabase);
  assert.match(
    backend,
    /create or replace function public\.read_agent_tabular_review_revision_fingerprint_v1/i,
  );
  assert.match(
    backend,
    /create or replace function public\.prepare_agent_tabular_export_materialization_v1/i,
  );
  assert.match(
    backend,
    /create or replace function public\.record_agent_task_review_decision_v1/i,
  );
  assert.match(
    backend,
    /create or replace function public\.verify_approved_export_lock/i,
  );
  assert.match(backend, /agent_approved_tabular_artifact_v1/i);
  assert.match(backend, /agent_verified_tabular_artifact_v1/i);
  assert.match(
    backend,
    /create or replace function public\.agent_final_verifier_snapshot_matches_v1/i,
  );
  assert.match(backend, /v_expected_cell_count > 500/i);
  assert.match(backend, /for share of source_document/i);
  assert.match(backend, /for share of source_version/i);
  assert.match(
    backend,
    /jsonb_array_length\(v_receipt -> 'verified_artifacts'\)[\s\S]*v_snapshot_count/i,
  );
  assert.match(
    backend,
    /expected ->> 'version_id'[\s\S]*pin ->> 'version_id'/i,
  );
  assert.match(
    backend,
    /jsonb_array_length\(v_inventory_receipt -> 'fields'\)[\s\S]*v_column_count/i,
  );
  assert.match(backend, /agent_tabular_export_plan_conflict/i);
  assert.match(backend, /when sqlstate 'VTA01' or unique_violation/i);
  assert.match(backend, /for update;[\s\S]*v_plan\.version_number/i);
  assert.match(
    backend,
    /version\.storage_path = 'documents\/'[\s\S]*'\.xlsx'/i,
  );
  assert.match(
    backend,
    /document\.current_version_id = p_version_id[\s\S]*agent_approved_tabular_artifact_v1/i,
  );
  assert.doesNotMatch(
    backend,
    /'storage_path'\s*,\s*v_artifact\s*->/i,
  );
  assert.match(backend, /from public, anon, authenticated, service_role/i);
  assert.match(backend, /to service_role/i);
});
