import assert from "node:assert/strict";
import test from "node:test";

import type { MatterContextManifestV1 } from "../../agent-kernel/context/matterContext";
import {
  compileLitigationEvidenceInventoryContext,
  createLitigationEvidenceInventoryContextRequiredInput,
  parseLitigationEvidenceInventoryContextRequiredInput,
} from "./litigationEvidenceInventoryContext";

const matter: MatterContextManifestV1 = {
  kind: "matter_context_v1",
  matter_id: "11111111-1111-4111-8111-111111111111",
  sources: [
    {
      document_id: "22222222-2222-4222-8222-222222222222",
      version_id: "33333333-3333-4333-8333-333333333333",
      filename: "case-record.docx",
      file_type: "docx",
      role: "source",
    },
    {
      document_id: "44444444-4444-4444-8444-444444444444",
      version_id: "55555555-5555-4555-8555-555555555555",
      filename: "authority.txt",
      file_type: "txt",
      role: "authority",
    },
  ],
  workflow: {
    id: "builtin-litigation-hearing-preparation",
    title: "Litigation Hearing Preparation",
    description: "Prepare a fixed first-instance hearing work product.",
    type: "assistant",
    instructions: "Use only fixed Matter sources.",
    columns: [],
  },
  compiled_at: "2026-08-08T00:00:00.000Z",
};

test("requires first-instance stage, represented side and output language", () => {
  const required = createLitigationEvidenceInventoryContextRequiredInput({
    matter,
    stepId: "66666666-6666-4666-8666-666666666666",
    createdAt: "2026-08-08T00:00:00.000Z",
  });
  const parsed = parseLitigationEvidenceInventoryContextRequiredInput({
    matter,
    requiredInput: required,
    responses: [
      {
        kind: "choice",
        id: "litigation-procedural-stage",
        answer: "first_instance",
      },
      {
        kind: "choice",
        id: "litigation-represented-side",
        answer: "claimant_plaintiff",
      },
      { kind: "choice", id: "litigation-output-language", answer: "zh" },
    ],
  });
  assert.deepEqual(parsed, {
    procedural_stage: "first_instance",
    represented_side: "claimant_plaintiff",
    output_language: "zh",
  });
});

test("binds only fixed case-record sources and keeps authority out of evidence rows", () => {
  const context = compileLitigationEvidenceInventoryContext({
    matter,
    packInput: {
      procedural_stage: "first_instance",
      represented_side: "defendant_respondent",
      output_language: "en",
    },
  });
  assert.equal(context.record_sources.length, 1);
  assert.equal(context.record_sources[0]?.filename, "case-record.docx");
  assert.equal(context.represented_side, "defendant_respondent");
});

test("rejects an appeal posture instead of reusing first-instance hearing tasks", () => {
  assert.throws(
    () =>
      compileLitigationEvidenceInventoryContext({
        matter,
        packInput: {
          procedural_stage: "appeal",
          represented_side: "appellant",
          output_language: "zh",
        },
      }),
    /explicit and structurally valid/i,
  );
});
