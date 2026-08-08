import assert from "node:assert/strict";
import test from "node:test";

import { compileLitigationEvidenceInventoryReceipt } from "./agent-packs/litigation/litigationEvidenceInventoryPack";
import {
  buildLitigationEvidenceInventoryBatchPrompt,
  executeLitigationEvidenceProviderBatchAttempt,
  generateLitigationEvidenceDocumentCells,
} from "./agentLitigationEvidenceInventoryGeneration";

const ids = {
  task: "11111111-1111-4111-8111-111111111111",
  matter: "22222222-2222-4222-8222-222222222222",
  step: "33333333-3333-4333-8333-333333333333",
  document: "44444444-4444-4444-8444-444444444444",
  version: "55555555-5555-4555-8555-555555555555",
};

function receipt() {
  return compileLitigationEvidenceInventoryReceipt({
    taskId: ids.task,
    matterId: ids.matter,
    stepId: ids.step,
    attempt: 1,
    proceduralStage: "first_instance",
    representedSide: "claimant_plaintiff",
    sourcePins: [{ document_id: ids.document, version_id: ids.version }],
  });
}

function citation(quote = "Bluewater delivered the pumps on 3 March 2026.") {
  return { locator: { kind: "page", value: "1" }, quote };
}

function sourced(value: string | null, quote?: string) {
  return {
    value,
    citations: value === null ? [] : [citation(quote)],
  };
}

function relevanceDraft() {
  return {
    result: {
      field: "relevance",
      values: {
        source_stated_fact: sourced(
          "Bluewater delivered the pumps on 3 March 2026.",
        ),
        source_to_fact_connection: sourced(
          "The record states the delivery event relevant to performance.",
          "Bluewater delivered the pumps on 3 March 2026.",
        ),
        dispute_status: "unknown",
      },
    },
    reasoning:
      "The source records delivery; it does not state whether disputed.",
    reasoning_citations: [citation()],
  };
}

function purposeDraft(
  quote = "Bluewater delivered the pumps on 3 March 2026.",
) {
  return {
    result: {
      field: "purpose_of_proof",
      values: {
        potential_purpose: sourced("Potential proof of delivery.", quote),
        proposition_scope: "document_records_assertion",
      },
    },
    reasoning: "The document itself records a delivery assertion.",
    reasoning_citations: [citation(quote)],
  };
}

test("builds one provider-neutral batch prompt for only the requested fields", () => {
  const prompt = buildLitigationEvidenceInventoryBatchPrompt({
    receipt: receipt(),
    documentId: ids.document,
    fields: ["relevance", "purpose_of_proof"],
    sourceText: "Bluewater delivered the pumps on 3 March 2026.",
    outputLanguage: "zh",
  });
  assert.match(prompt.systemPrompt, /FIELD relevance/);
  assert.match(prompt.systemPrompt, /FIELD purpose_of_proof/);
  assert.doesNotMatch(prompt.systemPrompt, /FIELD authenticity/);
  assert.doesNotMatch(prompt.systemPrompt, /read_document|tool call/i);
});

test("preserves an exact valid Cell while isolating one unrelocatable Cell", async () => {
  let calls = 0;
  const result = await executeLitigationEvidenceProviderBatchAttempt({
    receipt: receipt(),
    documentId: ids.document,
    fields: ["relevance", "purpose_of_proof"],
    source: {
      text: "[Page 1]\nBluewater delivered the pumps on 3 March 2026.",
      pdf: true,
      spreadsheet: null,
    },
    currentVersionId: ids.version,
    outputLanguage: "en",
    model: "test-model",
    complete: async () => {
      calls += 1;
      return JSON.stringify({
        cells: [
          relevanceDraft(),
          purposeDraft("The source never says this sentence."),
        ],
      });
    },
  });

  assert.equal(calls, 1);
  assert.deepEqual(
    result.completed.map((cell) => cell.field),
    ["relevance"],
  );
  assert.equal(result.completed[0]?.content.model_review_status, "unverified");
  assert.deepEqual(result.gaps, [
    {
      field: "purpose_of_proof",
      cellId: receipt().cells.find((cell) => cell.field === "purpose_of_proof")!
        .cell_id,
      reason: "citation_unrelocatable",
    },
  ]);
});

test("classifies duplicate and missing requested fields without discarding a valid peer", async () => {
  const result = await executeLitigationEvidenceProviderBatchAttempt({
    receipt: receipt(),
    documentId: ids.document,
    fields: ["relevance", "purpose_of_proof", "authenticity"],
    source: {
      text: "[Page 1]\nBluewater delivered the pumps on 3 March 2026.",
      pdf: true,
      spreadsheet: null,
    },
    currentVersionId: ids.version,
    outputLanguage: "en",
    model: "test-model",
    complete: async () =>
      JSON.stringify({
        cells: [relevanceDraft(), purposeDraft(), purposeDraft()],
      }),
  });
  assert.deepEqual(
    result.completed.map((cell) => cell.field),
    ["relevance"],
  );
  assert.deepEqual(
    result.gaps.map(({ field, reason }) => ({ field, reason })),
    [
      { field: "purpose_of_proof", reason: "structured_output_invalid" },
      { field: "authenticity", reason: "structured_output_invalid" },
    ],
  );
});

test("rejects Version drift before spending a provider request", async () => {
  let called = false;
  await assert.rejects(
    executeLitigationEvidenceProviderBatchAttempt({
      receipt: receipt(),
      documentId: ids.document,
      fields: ["relevance"],
      source: { text: "text", pdf: false, spreadsheet: null },
      currentVersionId: "66666666-6666-4666-8666-666666666666",
      outputLanguage: "en",
      model: "test-model",
      complete: async () => {
        called = true;
        return "{}";
      },
    }),
    /source Version changed/,
  );
  assert.equal(called, false);
});

test("commits valid Cells immediately and retries only remaining fields", async () => {
  const requestedFields: string[][] = [];
  const committed: string[] = [];
  let attempt = 0;
  const result = await generateLitigationEvidenceDocumentCells({
    receipt: receipt(),
    documentId: ids.document,
    fields: ["relevance", "purpose_of_proof", "authenticity"],
    source: {
      text: "[Page 1]\nBluewater delivered the pumps on 3 March 2026.",
      pdf: true,
      spreadsheet: null,
    },
    currentVersionId: ids.version,
    outputLanguage: "en",
    model: "test-model",
    complete: async ({ systemPrompt }) => {
      requestedFields.push(
        [...systemPrompt.matchAll(/^FIELD (\S+)$/gm)].map((match) => match[1]!),
      );
      attempt += 1;
      return JSON.stringify({
        cells:
          attempt === 1
            ? [relevanceDraft()]
            : attempt === 2
              ? [purposeDraft()]
              : [],
      });
    },
    commit: async (cell) => {
      committed.push(cell.field);
    },
  });

  assert.deepEqual(requestedFields, [
    ["relevance", "purpose_of_proof", "authenticity"],
    ["purpose_of_proof", "authenticity"],
    ["authenticity"],
  ]);
  assert.deepEqual(committed, ["relevance", "purpose_of_proof"]);
  assert.deepEqual(result.completedFields, ["relevance", "purpose_of_proof"]);
  assert.deepEqual(
    result.gaps.map(({ field, attemptsExhausted }) => ({
      field,
      attemptsExhausted,
    })),
    [{ field: "authenticity", attemptsExhausted: 3 }],
  );
});
