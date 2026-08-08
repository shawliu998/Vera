import assert from "node:assert/strict";
import test from "node:test";

import {
  LITIGATION_EVIDENCE_FIELDS,
  compileLitigationEvidenceInventoryReceipt,
  completeLitigationEvidenceCell,
  litigationEvidenceCellCandidateSchema,
  parseLitigationEvidenceCellCandidate,
  preserveLitigationEvidenceCellGap,
} from "./litigationEvidenceInventoryPack";
import {
  compileLitigationEvidenceCellProviderDraft,
  parseLitigationEvidenceCellProviderDraft,
} from "./litigationEvidenceInventoryProviderContract";

const ids = {
  task: "11111111-1111-4111-8111-111111111111",
  matter: "22222222-2222-4222-8222-222222222222",
  step: "33333333-3333-4333-8333-333333333333",
  document: "44444444-4444-4444-8444-444444444444",
  version: "55555555-5555-4555-8555-555555555555",
};

function receipt(attempt = 1) {
  return compileLitigationEvidenceInventoryReceipt({
    taskId: ids.task,
    matterId: ids.matter,
    stepId: ids.step,
    attempt,
    proceduralStage: "first_instance",
    representedSide: "claimant_plaintiff",
    sourcePins: [{ document_id: ids.document, version_id: ids.version }],
  });
}

function candidate() {
  const fixed = receipt().cells[0]!;
  const citationId = `citation-${"a".repeat(24)}`;
  return litigationEvidenceCellCandidateSchema.parse({
    kind: "litigation_evidence_cell_candidate_v1",
    cell_id: fixed.cell_id,
    document_id: fixed.document_id,
    version_id: fixed.version_id,
    result: {
      field: "evidence_item",
      values: {
        name_or_title: {
          value: "Bluewater supply agreement",
          citation_ids: [citationId],
        },
        document_type: { value: "Agreement", citation_ids: [citationId] },
        date: { value: null, citation_ids: [] },
        author_issuer_sender: { value: null, citation_ids: [] },
        recipient_counterparty: { value: null, citation_ids: [] },
        offering_party: { value: null, citation_ids: [] },
      },
    },
    reasoning: "The pinned record identifies the agreement by title.",
    reasoning_citation_ids: [citationId],
    citations: [
      {
        citation_id: citationId,
        source_type: "record_evidence",
        document_id: ids.document,
        version_id: ids.version,
        locator: { kind: "paragraph", value: "heading" },
        quote: "BLUEWATER SUPPLY AGREEMENT",
      },
    ],
    lawyer_review_status: "unverified",
  });
}

function providerDraft() {
  const citation = {
    locator: { kind: "paragraph" as const, value: "heading" },
    quote: "BLUEWATER SUPPLY AGREEMENT",
  };
  return parseLitigationEvidenceCellProviderDraft(
    JSON.stringify({
      result: {
        field: "evidence_item",
        values: {
          name_or_title: {
            value: "Bluewater supply agreement",
            citations: [citation],
          },
          document_type: { value: "Agreement", citations: [citation] },
          date: { value: null, citations: [] },
          author_issuer_sender: { value: null, citations: [] },
          recipient_counterparty: { value: null, citations: [] },
          offering_party: { value: null, citations: [] },
        },
      },
      reasoning: "The pinned record identifies the agreement by title.",
      reasoning_citations: [citation],
    }),
  );
}

test("fixes five distinct Evidence Inventory semantic axes", () => {
  assert.deepEqual(
    LITIGATION_EVIDENCE_FIELDS.map((field) => field.id),
    [
      "evidence_item",
      "authenticity",
      "admissibility",
      "relevance",
      "purpose_of_proof",
    ],
  );
  assert.equal(
    new Set(LITIGATION_EVIDENCE_FIELDS.map((field) => field.semantic_axis))
      .size,
    5,
  );
});

test("derives one stable Task-owned Review and fixed cells across retry attempts", () => {
  const first = receipt(1);
  const retried = receipt(2);
  assert.equal(first.review_id, retried.review_id);
  assert.deepEqual(first.cells, retried.cells);
  assert.equal(first.cells.length, 5);
  assert.notEqual(first.layout_digest, "");
});

test("requires every stated value and reasoning to use the fixed record citation", () => {
  const parsed = parseLitigationEvidenceCellCandidate(
    `\`\`\`json\n${JSON.stringify(candidate())}\n\`\`\``,
  );
  assert.equal(parsed.result.field, "evidence_item");
  assert.throws(
    () =>
      litigationEvidenceCellCandidateSchema.parse({
        ...candidate(),
        document_id: ids.matter,
      }),
    /fixed row DocumentVersion/i,
  );
  const value = candidate();
  if (value.result.field !== "evidence_item") throw new Error("fixture drift");
  assert.throws(
    () =>
      litigationEvidenceCellCandidateSchema.parse({
        ...value,
        result: {
          ...value.result,
          values: {
            ...value.result.values,
            date: { value: "2026-08-03", citation_ids: [] },
          },
        },
      }),
    /stated value requires a source citation/i,
  );
});

test("keeps server identities out of provider output and binds them deterministically", () => {
  const fixed = receipt().cells[0]!;
  const compiled = compileLitigationEvidenceCellProviderDraft({
    receipt: receipt(),
    cellId: fixed.cell_id,
    draft: providerDraft(),
  });
  assert.equal(compiled.cell_id, fixed.cell_id);
  assert.equal(compiled.document_id, ids.document);
  assert.equal(compiled.version_id, ids.version);
  assert.equal(compiled.lawyer_review_status, "unverified");
  assert.equal(compiled.citations.length, 1);
  assert.match(compiled.citations[0]!.citation_id, /^citation-[a-f0-9]{24}$/);
  assert.deepEqual(
    compileLitigationEvidenceCellProviderDraft({
      receipt: receipt(2),
      cellId: fixed.cell_id,
      draft: providerDraft(),
    }),
    compiled,
  );
});

test("provider output cannot cite an unknown value or cross a semantic field", () => {
  const invalid = providerDraft();
  if (invalid.result.field !== "evidence_item")
    throw new Error("fixture drift");
  assert.throws(
    () =>
      parseLitigationEvidenceCellProviderDraft(
        JSON.stringify({
          ...invalid,
          result: {
            ...invalid.result,
            values: {
              ...invalid.result.values,
              date: {
                value: null,
                citations: [invalid.reasoning_citations[0]],
              },
            },
          },
        }),
      ),
    /invalid structured cell/i,
  );
  assert.throws(
    () =>
      compileLitigationEvidenceCellProviderDraft({
        receipt: receipt(),
        cellId: receipt().cells[1]!.cell_id,
        draft: providerDraft(),
      }),
    /field boundary/i,
  );
});

test("accepts only a candidate matching the fixed row, Version, cell, and field", () => {
  const completed = completeLitigationEvidenceCell({
    receipt: receipt(),
    candidate: candidate(),
  });
  assert.equal(completed.outcome, "completed");
  assert.throws(
    () =>
      completeLitigationEvidenceCell({
        receipt: receipt(),
        candidate: {
          ...candidate(),
          cell_id: receipt().cells[1]!.cell_id,
        },
      }),
    /fixed Review layout/i,
  );
});

test("exhausted generation preserves completed cells and the same pending Review cell", () => {
  const fixed = receipt();
  const gap = preserveLitigationEvidenceCellGap({
    receipt: fixed,
    cellId: fixed.cells[3]!.cell_id,
    reason: "citation_unrelocatable",
    attemptsExhausted: 2,
    completedCellsPreserved: 3,
  });
  assert.equal(gap.outcome, "review_required");
  assert.equal(gap.review_id, fixed.review_id);
  assert.equal(gap.preservation.current_cell_status, "pending");
  assert.equal(gap.preservation.completed_cells_preserved, 3);
  assert.equal(gap.preservation.duplicate_review_created, false);
});
