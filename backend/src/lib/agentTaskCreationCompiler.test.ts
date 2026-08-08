import assert from "node:assert/strict";
import test from "node:test";

import { buildMatterContextManifest } from "./agent-kernel/context/matterContext";
import { readAgentStepCapabilityGrants } from "./agent-kernel/capability/stepCapability";
import { readAgentStepContracts } from "./agent-kernel/contracts/stepContract";
import { readAgentTaskAssignmentContract } from "./agent-kernel/contracts/taskContract";
import { EPO_OPS_SOURCE_CONNECTOR_PIN } from "./agent-packs/patent/epoOpsSourcePack";
import { compileAgentTaskCreationContract } from "./agentTaskCreationCompiler";
import { AgentTaskSourceAcquisitionInputError } from "./agentTaskSourceAcquisitionCompiler";

const context = buildMatterContextManifest({
  matterId: "11111111-1111-4111-8111-111111111111",
  compiledAt: "2026-08-08T00:00:00.000Z",
  workflow: {
    type: "assistant",
    id: "builtin-patent-prior-art-acquisition",
    title: "Patent Prior Art Acquisition",
    description: "Acquire bounded prior art.",
    instructions: "Preserve coverage limitations.",
    columns: [],
  },
  sources: [
    {
      document_id: "22222222-2222-4222-8222-222222222222",
      version_id: "33333333-3333-4333-8333-333333333333",
      filename: "target-claim.docx",
      file_type: "docx",
      role: "source",
    },
  ],
});

test("compiles one acquisition, one editable Word Artifact and one verifier under fixed EPO scope", () => {
  const compiled = compileAgentTaskCreationContract({
    goal: "Acquire bounded prior art and prepare the acquisition record.",
    workflowId: "builtin-patent-prior-art-acquisition",
    workflowType: "assistant",
    fixedMatterContext: context,
    sourceAcquisitionRequest: {
      query: "ti=optical sensor",
      jurisdiction: "US",
      as_of_date: "2026-08-08",
    },
    createdAt: "2026-08-08T00:01:00.000Z",
  });
  assert.deepEqual(
    compiled.plan.steps.map((step) => step.capability),
    ["read_sources", "create_draft", "verify"],
  );
  assert.deepEqual(
    compiled.artifactContracts.map((artifact) => [
      artifact.key,
      artifact.artifact_type,
      artifact.format,
    ]),
    [["prior-art-acquisition-record", "draft", "docx"]],
  );
  assert.deepEqual(
    compiled.stepContracts.steps.map((step) => step.operation),
    ["source.acquire", "draft.create", "verify"],
  );
  assert.equal(
    compiled.capabilityGrants[0]?.read_only_connector_pins[0]?.connector_id,
    EPO_OPS_SOURCE_CONNECTOR_PIN.connector_id,
  );
  assert.equal(compiled.capabilityGrants[1]?.research_tools_allowed, false);
  assert.deepEqual(compiled.goalSpec.jurisdictions, ["US"]);
  assert.equal(compiled.goalSpec.as_of_date, "2026-08-08");
  assert.equal(compiled.sourceAcquisition?.state.phase, "search_pending");

  const task = {
    goal: "Acquire bounded prior art and prepare the acquisition record.",
    matter_id: context.matter_id,
    latest_checkpoint: compiled.initialCheckpoint,
    current_plan: compiled.plan.steps,
    deliverables: compiled.artifactContracts,
  };
  assert.equal(readAgentTaskAssignmentContract(task).state, "valid");
  assert.equal(readAgentStepContracts(task).state, "valid");
  assert.equal(readAgentStepCapabilityGrants(task).state, "valid");
});

test("ordinary Workflows cannot smuggle a provider request into their Task contract", () => {
  assert.throws(
    () =>
      compileAgentTaskCreationContract({
        goal: "Proofread the target claim.",
        fixedMatterContext: {
          ...context,
          workflow: null,
        },
        sourceAcquisitionRequest: {
          query: "ti=sensor",
          jurisdiction: "US",
          as_of_date: "2026-08-08",
        },
      }),
    (error) =>
      error instanceof AgentTaskSourceAcquisitionInputError &&
      error.code === "source_acquisition_unexpected",
  );
});
