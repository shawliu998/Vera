import assert from "node:assert/strict";
import test from "node:test";

import { compileLitigationEvidenceInventoryReceipt } from "./agent-packs/litigation/litigationEvidenceInventoryPack";
import {
  buildLitigationEvidenceInventoryArtifact,
  buildLitigationEvidenceEffectLayout,
  buildLitigationEvidenceReviewSpec,
} from "./agentLitigationEvidenceInventoryExecutor";

test("maps the fixed Litigation receipt to one existing document-row Review layout", () => {
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
  const spec = buildLitigationEvidenceReviewSpec(receipt);
  assert.equal(spec.id, receipt.review_id);
  assert.equal(spec.row_protocol, "document_rows");
  assert.equal(spec.workflow_id, null);
  assert.equal(spec.columns_config.length, 5);
  assert.equal(spec.cells.length, 5);
  assert.deepEqual(
    spec.columns_config.map((column) => column.tags[0]),
    [
      "evidence_item",
      "authenticity",
      "admissibility",
      "relevance",
      "purpose_of_proof",
    ],
  );
  assert.deepEqual(buildLitigationEvidenceEffectLayout(spec), {
    document_ids: ["44444444-4444-4444-8444-444444444444"],
    columns_config: spec.columns_config,
    cells: spec.cells.map((cell) => ({
      id: cell.id,
      document_id: cell.document_id,
      column_index: cell.column_index,
    })),
  });
});

test("uses the caller's declared Task deliverable purpose for the linked Review", () => {
  assert.deepEqual(
    buildLitigationEvidenceInventoryArtifact({
      reviewId: "44444444-4444-4444-8444-444444444444",
      declaredTaskDeliverablePurpose: "Fixed evidence inventory deliverable",
    }),
    {
      artifact_type: "tabular_review",
      artifact_id: "44444444-4444-4444-8444-444444444444",
      purpose: "Fixed evidence inventory deliverable",
    },
  );
  assert.throws(
    () =>
      buildLitigationEvidenceInventoryArtifact({
        reviewId: "44444444-4444-4444-8444-444444444444",
        declaredTaskDeliverablePurpose: "  ",
      }),
    /declared Task deliverable purpose/,
  );
});
