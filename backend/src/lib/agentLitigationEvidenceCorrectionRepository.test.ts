import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  LitigationEvidenceCellCorrectionTransitionError,
  startLitigationEvidenceCellCorrection,
} from "./agentLitigationEvidenceCorrectionRepository";

const ids = {
  correction: "11111111-1111-4111-8111-111111111111",
  task: "22222222-2222-4222-8222-222222222222",
  step: "33333333-3333-4333-8333-333333333333",
  review: "44444444-4444-4444-8444-444444444444",
  cell: "55555555-5555-4555-8555-555555555555",
  document: "66666666-6666-4666-8666-666666666666",
  version: "77777777-7777-4777-8777-777777777777",
};

function validInput() {
  return {
    correctionId: ids.correction,
    taskId: ids.task,
    userId: "user-litigation-correction",
    stepId: ids.step,
    expectedStepAttempt: 1,
    reviewId: ids.review,
    cellId: ids.cell,
    documentId: ids.document,
    versionId: ids.version,
    columnIndex: 4,
    expectedReviewRevision: 0,
    reasonCode: "citation_not_exact" as const,
  };
}

test("starts a source-bound correction with a closed reason code", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const db = {
    async rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      return {
        data: [
          {
            outcome: "started",
            task_status: "running",
            current_step: ids.step,
            cell_id: ids.cell,
            cell_status: "pending",
            review_status: null,
            review_revision: 1,
          },
        ],
        error: null,
      };
    },
  };

  const started = await startLitigationEvidenceCellCorrection(db as never, validInput());
  assert.equal(started.outcome, "started");
  assert.equal(calls[0]?.name, "start_litigation_evidence_cell_correction_v1");
  assert.deepEqual(calls[0]?.args, {
    p_correction_id: ids.correction,
    p_task_id: ids.task,
    p_user_id: "user-litigation-correction",
    p_step_id: ids.step,
    p_expected_step_attempt: 1,
    p_review_id: ids.review,
    p_cell_id: ids.cell,
    p_document_id: ids.document,
    p_version_id: ids.version,
    p_column_index: 4,
    p_expected_review_revision: 0,
    p_reason_code: "citation_not_exact",
  });
});

test("returns exact replay and fails closed for an atomic correction conflict", async () => {
  const recoveredDb = {
    async rpc() {
      return {
        data: [
          {
            outcome: "recovered",
            task_status: "running",
            current_step: ids.step,
            cell_id: ids.cell,
            cell_status: "pending",
            review_status: null,
            review_revision: 1,
          },
        ],
        error: null,
      };
    },
  };
  const recovered = await startLitigationEvidenceCellCorrection(
    recoveredDb as never,
    validInput(),
  );
  assert.equal(recovered.outcome, "recovered");

  const conflictDb = {
    async rpc() {
      return {
        data: [
          {
            outcome: "conflict",
            task_status: "waiting_input",
            current_step: ids.step,
            cell_id: ids.cell,
            cell_status: "done",
            review_status: "verified",
            review_revision: 1,
          },
        ],
        error: null,
      };
    },
  };
  await assert.rejects(
    () => startLitigationEvidenceCellCorrection(conflictDb as never, validInput()),
    (error: unknown) =>
      error instanceof LitigationEvidenceCellCorrectionTransitionError &&
      error.outcome === "conflict",
  );
});

test("rejects an open-ended correction reason before calling the database", async () => {
  const db = { async rpc() { throw new Error("must not call database"); } };
  await assert.rejects(
    () =>
      startLitigationEvidenceCellCorrection(db as never, {
        ...validInput(),
        reasonCode: "rewrite_everything",
      }),
    /Invalid enum value/i,
  );
});

test("keeps mirrored correction migrations source-bound and service-role-only", async () => {
  const backend = await readFile(
    new URL(
      "../../migrations/20260808_12_litigation_evidence_cell_correction.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const supabase = await readFile(
    new URL(
      "../../../supabase/migrations/20260808000012_litigation_evidence_cell_correction.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.equal(backend, supabase);
  assert.match(backend, /p_reason_code not in \(/i);
  assert.match(backend, /p_review_status not in \('verified', 'unresolved'\)/i);
  assert.match(backend, /litigation_evidence_inventory_correction/i);
  assert.match(
    backend,
    /litigation_evidence_inventory_cell_correction_v1/i,
  );
  assert.match(backend, /'generation_step_attempt', v_next_attempt/i);
  assert.match(backend, /'source_binding_fingerprint', v_task\.latest_checkpoint/i);
  assert.match(backend, /v_cell\.review_status <> 'needs_correction'/i);
  assert.match(backend, /document_row\.current_version_id = p_version_id/i);
  assert.match(backend, /review_revision = v_cell\.review_revision \+ 1/i);
  assert.match(backend, /status = 'running'/i);
  assert.match(backend, /from public, anon, authenticated/i);
  assert.match(backend, /to service_role/i);
});
