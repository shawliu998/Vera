import assert from "node:assert/strict";
import test from "node:test";
import { buildAgentTaskCreationBody } from "./agentTaskCreationRequest";

test("serializes only the lawyer-supplied source acquisition scope", () => {
  assert.deepEqual(
    buildAgentTaskCreationBody({
      goal: "Acquire prior art",
      matterId: "matter-1",
      model: "model-1",
      documentIds: ["document-1"],
      workflowId: "builtin-patent-prior-art-acquisition",
      sourceAcquisition: {
        query: 'ti=("optical sensor" AND calibration)',
        jurisdiction: "CN",
        asOfDate: "2026-08-08",
      },
    }),
    {
      goal: "Acquire prior art",
      matter_id: "matter-1",
      model: "model-1",
      document_ids: ["document-1"],
      workflow_id: "builtin-patent-prior-art-acquisition",
      source_acquisition: {
        query: 'ti=("optical sensor" AND calibration)',
        jurisdiction: "CN",
        as_of_date: "2026-08-08",
      },
    },
  );
});

test("ordinary Tasks omit the source acquisition object", () => {
  const body = buildAgentTaskCreationBody({
    goal: "Review the contract",
    matterId: "matter-1",
    model: "model-1",
    workflowId: "builtin-contract-playbook-review",
  });

  assert.equal(Object.hasOwn(body, "source_acquisition"), false);
  assert.deepEqual(body.document_ids, []);
});
