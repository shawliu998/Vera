import assert from "node:assert/strict";
import test from "node:test";

import { buildGeneratedLitigationEvidenceCellContent } from "./litigationEvidenceInventoryCellContent";
import {
  compileLitigationEvidenceInventoryReceipt,
  litigationEvidenceCellCandidateSchema,
} from "./litigationEvidenceInventoryPack";
import {
  compileLitigationEvidenceReviewCompletionReceipt,
  inspectLitigationEvidenceInventoryReview,
  type LitigationEvidenceStoredCellV1,
} from "./litigationEvidenceInventoryReview";

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

function completedCell(
  index: number,
  decision: "verified" | "unresolved" | "needs_correction" | null,
): LitigationEvidenceStoredCellV1 {
  const fixed = receipt.cells[index]!;
  const citation = {
    citation_id: `citation-${String(index).padStart(24, "0")}`,
    source_type: "record_evidence" as const,
    document_id: fixed.document_id,
    version_id: fixed.version_id,
    locator: { kind: "page" as const, value: "1" },
    quote: "Exact source quote",
  };
  const candidate = litigationEvidenceCellCandidateSchema.parse({
    kind: "litigation_evidence_cell_candidate_v1",
    cell_id: fixed.cell_id,
    document_id: fixed.document_id,
    version_id: fixed.version_id,
    result:
      fixed.field === "relevance"
        ? {
            field: "relevance",
            values: {
              source_stated_fact: {
                value: "Fact",
                citation_ids: [citation.citation_id],
              },
              source_to_fact_connection: {
                value: "Connection",
                citation_ids: [citation.citation_id],
              },
              dispute_status: "unknown",
            },
          }
        : fixed.field === "purpose_of_proof"
          ? {
              field: "purpose_of_proof",
              values: {
                potential_purpose: {
                  value: "Purpose",
                  citation_ids: [citation.citation_id],
                },
                proposition_scope: "document_records_assertion",
              },
            }
          : fixed.field === "authenticity"
            ? {
                field: "authenticity",
                values: {
                  origin: {
                    value: "Origin",
                    citation_ids: [citation.citation_id],
                  },
                  signature_or_seal: { value: null, citation_ids: [] },
                  chain_of_custody: { value: null, citation_ids: [] },
                  express_authenticity_challenge: {
                    value: null,
                    citation_ids: [],
                  },
                },
              }
            : fixed.field === "admissibility"
              ? {
                  field: "admissibility",
                  values: {
                    form: {
                      value: "Document",
                      citation_ids: [citation.citation_id],
                    },
                    acquisition_method: { value: null, citation_ids: [] },
                    express_objection: { value: null, citation_ids: [] },
                  },
                }
              : {
                  field: "evidence_item",
                  values: {
                    name_or_title: {
                      value: "Record",
                      citation_ids: [citation.citation_id],
                    },
                    document_type: { value: null, citation_ids: [] },
                    date: { value: null, citation_ids: [] },
                    author_issuer_sender: { value: null, citation_ids: [] },
                    recipient_counterparty: { value: null, citation_ids: [] },
                    offering_party: { value: null, citation_ids: [] },
                  },
                },
    reasoning: "Reasoning",
    reasoning_citation_ids: [citation.citation_id],
    citations: [citation],
    lawyer_review_status: "unverified",
  });
  const content = buildGeneratedLitigationEvidenceCellContent(candidate);
  return {
    id: fixed.cell_id,
    review_id: receipt.review_id,
    document_id: fixed.document_id,
    row_id: null,
    column_index: fixed.field_index,
    status: "done",
    content: JSON.stringify(content),
    citations: candidate.citations,
    review_status: decision,
    reviewed_at: decision ? "2026-08-08T12:00:00.000Z" : null,
    review_revision: decision ? 1 : 0,
  };
}

test("reports the first incomplete Cell instead of trusting a client counter", () => {
  const cells = receipt.cells.map((_, index) =>
    completedCell(index, "verified"),
  );
  cells[2] = completedCell(2, null);
  const inspection = inspectLitigationEvidenceInventoryReview({
    receipt,
    cells,
  });
  assert.equal(inspection.complete, false);
  assert.equal(inspection.progress.remaining, 1);
  assert.equal(inspection.progress.first_incomplete_cell_id, cells[2]!.id);
});

test("allows a pending source-bound gap to be explicitly kept unresolved", () => {
  const cells = receipt.cells.map((_, index) =>
    completedCell(index, "verified"),
  );
  cells[3] = {
    ...cells[3]!,
    status: "pending",
    content: null,
    citations: null,
    review_status: "unresolved",
  };
  const completion = compileLitigationEvidenceReviewCompletionReceipt({
    receipt,
    cells,
    completedAt: "2026-08-08T12:01:00.000Z",
  });
  assert.equal(completion.verified_cells, 4);
  assert.equal(completion.unresolved_cells, 1);
});

test("never accepts a pending gap as verified", () => {
  const cells = receipt.cells.map((_, index) =>
    completedCell(index, "verified"),
  );
  cells[1] = {
    ...cells[1]!,
    status: "pending",
    content: null,
    citations: null,
  };
  assert.throws(
    () => inspectLitigationEvidenceInventoryReview({ receipt, cells }),
    /cannot be marked verified/,
  );
});
