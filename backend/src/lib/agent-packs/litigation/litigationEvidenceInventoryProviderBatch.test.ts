import assert from "node:assert/strict";
import test from "node:test";

import {
  LITIGATION_EVIDENCE_FIELDS,
  type LitigationEvidenceField,
} from "./litigationEvidenceInventoryPack";
import { parseLitigationEvidenceInventoryProviderBatch } from "./litigationEvidenceInventoryProviderBatch";

const citation = {
  locator: { kind: "paragraph" as const, value: "heading" },
  quote: "BLUEWATER SUPPLY AGREEMENT",
};
const unknown = () => ({ value: null, citations: [] });

function draft(field: LitigationEvidenceField) {
  const common = {
    reasoning: `Reasoning for ${field}`,
    reasoning_citations: [citation],
  };
  switch (field) {
    case "evidence_item":
      return {
        ...common,
        result: {
          field,
          values: {
            name_or_title: {
              value: "Bluewater supply agreement",
              citations: [citation],
            },
            document_type: unknown(),
            date: unknown(),
            author_issuer_sender: unknown(),
            recipient_counterparty: unknown(),
            offering_party: unknown(),
          },
        },
      };
    case "authenticity":
      return {
        ...common,
        result: {
          field,
          values: {
            origin: unknown(),
            signature_or_seal: unknown(),
            chain_of_custody: unknown(),
            express_authenticity_challenge: unknown(),
          },
        },
      };
    case "admissibility":
      return {
        ...common,
        result: {
          field,
          values: {
            form: unknown(),
            acquisition_method: unknown(),
            express_objection: unknown(),
          },
        },
      };
    case "relevance":
      return {
        ...common,
        result: {
          field,
          values: {
            source_stated_fact: unknown(),
            source_to_fact_connection: unknown(),
            dispute_status: "unknown" as const,
          },
        },
      };
    case "purpose_of_proof":
      return {
        ...common,
        result: {
          field,
          values: {
            potential_purpose: unknown(),
            proposition_scope: "unknown" as const,
          },
        },
      };
  }
}

const fields = LITIGATION_EVIDENCE_FIELDS.map((field) => field.id);

test("classifies a malformed top-level batch without inventing cells", () => {
  for (const raw of ["{not-json", JSON.stringify([])]) {
    const parsed = parseLitigationEvidenceInventoryProviderBatch(raw);
    assert.deepEqual(parsed.completed, []);
    assert.equal(parsed.completedByField.size, 0);
    assert.deepEqual(parsed.missingFields, []);
    assert.deepEqual(parsed.invalidFields, fields);
  }
});

test("rejects a duplicate field instead of choosing between legal outputs", () => {
  const first = draft("evidence_item");
  const second = {
    ...draft("evidence_item"),
    reasoning: "A competing interpretation",
  };
  const parsed = parseLitigationEvidenceInventoryProviderBatch(
    JSON.stringify({ cells: [first, second] }),
  );

  assert.deepEqual(parsed.completed, []);
  assert.equal(parsed.completedByField.has("evidence_item"), false);
  assert.deepEqual(parsed.invalidFields, ["evidence_item"]);
  assert.deepEqual(parsed.missingFields, fields.slice(1));
});

test("preserves valid fields while separately reporting invalid and missing fields", () => {
  const accepted = draft("evidence_item");
  const invalid = draft("authenticity") as Record<string, unknown>;
  delete invalid.reasoning_citations;
  const parsed = parseLitigationEvidenceInventoryProviderBatch(
    JSON.stringify({ cells: [accepted, invalid] }),
  );

  assert.deepEqual(parsed.completed, [accepted]);
  assert.deepEqual(parsed.completedByField.get("evidence_item"), accepted);
  assert.deepEqual(parsed.invalidFields, ["authenticity"]);
  assert.deepEqual(parsed.missingFields, fields.slice(2));
});

test("accepts all five independently valid fields from one JSON fence", () => {
  const cells = fields.map(draft);
  const parsed = parseLitigationEvidenceInventoryProviderBatch(
    `\`\`\`json\n${JSON.stringify({ cells })}\n\`\`\``,
  );

  assert.deepEqual(parsed.completed, cells);
  assert.deepEqual([...parsed.completedByField.keys()], fields);
  assert.deepEqual(parsed.missingFields, []);
  assert.deepEqual(parsed.invalidFields, []);
});
