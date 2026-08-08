import assert from "node:assert/strict";
import test from "node:test";

import { compileLitigationEvidenceInventoryReceipt } from "./litigationEvidenceInventoryPack";
import {
  compileLitigationEvidenceCellProviderDraft,
  parseLitigationEvidenceCellProviderDraft,
} from "./litigationEvidenceInventoryProviderContract";
import {
  buildGeneratedLitigationEvidenceCellContent,
  litigationEvidenceInventoryCellContentSchema,
} from "./litigationEvidenceInventoryCellContent";

function generatedContent() {
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
  const citation = {
    locator: { kind: "page", value: "1" },
    quote: "BLUEWATER SUPPLY AGREEMENT",
  };
  const draft = parseLitigationEvidenceCellProviderDraft(
    JSON.stringify({
      result: {
        field: "evidence_item",
        values: {
          name_or_title: {
            value: "Bluewater agreement",
            citations: [citation],
          },
          document_type: { value: "Agreement", citations: [citation] },
          date: { value: null, citations: [] },
          author_issuer_sender: { value: null, citations: [] },
          recipient_counterparty: { value: null, citations: [] },
          offering_party: { value: null, citations: [] },
        },
      },
      reasoning: "The source heading identifies the agreement.",
      reasoning_citations: [citation],
    }),
  );
  return buildGeneratedLitigationEvidenceCellContent(
    compileLitigationEvidenceCellProviderDraft({
      receipt,
      cellId: receipt.cells[0]!.cell_id,
      draft,
    }),
  );
}

test("projects one server-bound candidate into existing Tabular display fields", () => {
  const content = generatedContent();
  assert.match(content.summary, /Name Or Title: Bluewater agreement/);
  assert.match(content.summary, /Date: Unknown/);
  assert.equal(content.flag, "grey");
  assert.equal(content.model_review_status, "unverified");
  assert.equal(content.candidate.citations.length, 1);
});

test("provider display content cannot claim a lawyer review decision", () => {
  assert.throws(
    () =>
      litigationEvidenceInventoryCellContentSchema.parse({
        ...generatedContent(),
        model_review_status: "verified",
      }),
    /Invalid literal value|Invalid input/i,
  );
});
