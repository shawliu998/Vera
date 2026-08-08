import assert from "node:assert/strict";
import test from "node:test";

import { compileLitigationEvidenceInventoryReceipt } from "./litigationEvidenceInventoryPack";
import {
  compileLitigationEvidenceInventoryCorrectionReceipt,
  litigationEvidenceInventoryBindingFingerprint,
  preserveLitigationEvidenceInventoryCorrectionGap,
  readLitigationEvidenceInventoryCorrectionReceipt,
} from "./litigationEvidenceInventoryCorrection";
import { mergeImmutableAgentTaskCheckpoint } from "../../agent-kernel/context/matterContext";
import { mergeAgentTaskProviderPauseCheckpoint } from "../../agent-kernel/outcomes/executionOutcome";

const receipt = compileLitigationEvidenceInventoryReceipt({
  taskId: "11111111-1111-4111-8111-111111111111",
  matterId: "22222222-2222-4222-8222-222222222222",
  stepId: "33333333-3333-4333-8333-333333333333",
  attempt: 1,
  proceduralStage: "first_instance",
  representedSide: "claimant_plaintiff",
  sourcePins: [
    {
      document_id: "44444444-4444-4444-8444-444444444444",
      version_id: "55555555-5555-4555-8555-555555555555",
    },
  ],
});

test("binds one correction to one current source Cell and one new Step attempt", () => {
  const correction = compileLitigationEvidenceInventoryCorrectionReceipt({
    correctionId: "66666666-6666-4666-8666-666666666666",
    receipt,
    cellId: receipt.cells[2]!.cell_id,
    expectedReviewRevision: 4,
    reasonCode: "source_conflict",
    generationStepAttempt: 2,
    requestedAt: "2026-08-08T12:00:00.000Z",
  });
  assert.equal(correction.max_attempts, 1);
  assert.equal(correction.field, receipt.cells[2]!.field);
  assert.equal(correction.reason_code, "source_conflict");
  assert.deepEqual(
    readLitigationEvidenceInventoryCorrectionReceipt({
      value: correction,
      receipt: { ...receipt, attempt: 2 },
      currentStepAttempt: 2,
    }),
    correction,
  );
});

test("rejects a correction when source binding, target Cell, or Step attempt drifts", () => {
  const correction = compileLitigationEvidenceInventoryCorrectionReceipt({
    correctionId: "66666666-6666-4666-8666-666666666666",
    receipt,
    cellId: receipt.cells[2]!.cell_id,
    expectedReviewRevision: 0,
    reasonCode: "citation_not_exact",
    generationStepAttempt: 2,
  });
  assert.throws(
    () =>
      readLitigationEvidenceInventoryCorrectionReceipt({
        value: correction,
        receipt: {
          ...receipt,
          source_pins: [
            {
              ...receipt.source_pins[0]!,
              version_id: "77777777-7777-4777-8777-777777777777",
            },
          ],
        },
        currentStepAttempt: 2,
      }),
    /no longer matches/i,
  );
  assert.throws(
    () =>
      readLitigationEvidenceInventoryCorrectionReceipt({
        value: correction,
        receipt,
        currentStepAttempt: 3,
      }),
    /no longer matches/i,
  );
  assert.throws(
    () =>
      readLitigationEvidenceInventoryCorrectionReceipt({
        value: { correction_id: correction.correction_id },
        receipt,
        currentStepAttempt: 2,
      }),
    /receipt is malformed/i,
  );
});

test("records one structured exhausted correction issue without transforming the finding", () => {
  const correction = compileLitigationEvidenceInventoryCorrectionReceipt({
    correctionId: "66666666-6666-4666-8666-666666666666",
    receipt,
    cellId: receipt.cells[0]!.cell_id,
    expectedReviewRevision: 0,
    reasonCode: "material_omission",
    generationStepAttempt: 2,
  });
  assert.deepEqual(preserveLitigationEvidenceInventoryCorrectionGap({ correction }), {
    code: "source_bound_correction_incomplete",
    correction_id: correction.correction_id,
    cell_id: correction.cell_id,
    document_id: correction.document_id,
    version_id: correction.version_id,
    field: correction.field,
    reason_code: "material_omission",
    attempts_exhausted: 1,
  });
  assert.match(litigationEvidenceInventoryBindingFingerprint(receipt), /^sha256:/);
});

test("settling one correction releases its active receipt before another fixed Cell can be corrected", () => {
  const first = compileLitigationEvidenceInventoryCorrectionReceipt({
    correctionId: "66666666-6666-4666-8666-666666666666",
    receipt,
    cellId: receipt.cells[0]!.cell_id,
    expectedReviewRevision: 0,
    reasonCode: "citation_not_exact",
    generationStepAttempt: 2,
  });
  const settled = mergeImmutableAgentTaskCheckpoint(
    { litigation_evidence_inventory_correction: first },
    {
      litigation_evidence_inventory_generation_issues: [
        preserveLitigationEvidenceInventoryCorrectionGap({ correction: first }),
      ],
    },
  ) as Record<string, unknown>;
  assert.equal(settled.litigation_evidence_inventory_correction, undefined);
  const next = compileLitigationEvidenceInventoryCorrectionReceipt({
    correctionId: "77777777-7777-4777-8777-777777777777",
    receipt: { ...receipt, attempt: 2 },
    cellId: receipt.cells[1]!.cell_id,
    expectedReviewRevision: 0,
    reasonCode: "material_omission",
    generationStepAttempt: 3,
  });
  assert.equal(next.cell_id, receipt.cells[1]!.cell_id);
  // A later retry of the same Cell is possible only through a new explicit
  // lawyer request and still carries exactly one provider attempt.
  const repeated = compileLitigationEvidenceInventoryCorrectionReceipt({
    correctionId: "88888888-8888-4888-8888-888888888888",
    receipt: { ...receipt, attempt: 3 },
    cellId: receipt.cells[0]!.cell_id,
    expectedReviewRevision: 2,
    reasonCode: "source_conflict",
    generationStepAttempt: 4,
  });
  assert.equal(repeated.max_attempts, 1);
  assert.notEqual(repeated.correction_id, first.correction_id);
});

test("a provider pause preserves the active correction and its sole remaining attempt", () => {
  const correction = compileLitigationEvidenceInventoryCorrectionReceipt({
    correctionId: "66666666-6666-4666-8666-666666666666",
    receipt: { ...receipt, attempt: 2 },
    cellId: receipt.cells[0]!.cell_id,
    expectedReviewRevision: 1,
    reasonCode: "source_conflict",
    generationStepAttempt: 2,
  });
  const paused = mergeAgentTaskProviderPauseCheckpoint({
    previous: {
      litigation_evidence_inventory_receipt: { ...receipt, attempt: 2 },
      litigation_evidence_inventory_correction: correction,
    },
    currentStep: { id: receipt.step_id, attempt: 2 },
    classification: "provider_timeout",
    summary: "Provider timed out.",
    createdAt: "2026-08-08T12:00:00.000Z",
  }) as Record<string, unknown>;
  assert.deepEqual(
    readLitigationEvidenceInventoryCorrectionReceipt({
      value: paused.litigation_evidence_inventory_correction,
      receipt: { ...receipt, attempt: 2 },
      currentStepAttempt: 2,
    }),
    correction,
  );
  assert.equal(
    (paused.execution_pause as { attempt: number }).attempt,
    correction.generation_step_attempt,
  );
});
