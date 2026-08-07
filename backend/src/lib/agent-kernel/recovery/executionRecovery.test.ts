import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveAgentStepCapabilityGrant,
  WORK_TASK_HOST_TOOL_NAMES,
} from "../capability/stepCapability";
import { buildMatterContextManifest } from "../context/matterContext";
import {
  buildAgentTaskContractCheckpoint,
  compileAgentGoalSpec,
  normalizeAgentTaskArtifactContracts,
} from "../contracts/taskContract";
import { compileAgentStepContracts } from "../contracts/stepContract";
import { evaluateAgentTaskExecutionRecovery } from "./executionRecovery";

function versionedTask() {
  const deliverables = normalizeAgentTaskArtifactContracts([
    {
      key: "memo",
      title: "Review memo",
      description: "Fixed source-linked review memo.",
      required: true,
      artifact_type: "draft",
      purpose: "Review memo",
    },
  ]);
  const goal = compileAgentGoalSpec({
    objective: "Review the agreement.",
    taskFamily: "contract_review",
    artifactContracts: deliverables,
    hasSources: true,
  });
  const context = buildMatterContextManifest({
    matterId: "matter-1",
    compiledAt: "2026-08-07T00:00:00.000Z",
    sources: [
      {
        document_id: "document-1",
        version_id: "version-1",
        filename: "agreement.docx",
        file_type: "docx",
        role: "source",
      },
    ],
  });
  const steps = [
    { capability: "read_sources" as const },
    { capability: "analyze" as const },
    { capability: "create_draft" as const },
    { capability: "verify" as const },
  ];
  const stepContracts = compileAgentStepContracts({
    steps,
    goalSpec: goal,
    artifactContracts: deliverables,
    contextManifest: context,
  });
  const capabilityGrants = stepContracts.steps.map((contract) =>
    resolveAgentStepCapabilityGrant({
      contract,
      availableToolNames: WORK_TASK_HOST_TOOL_NAMES,
    }),
  );
  return {
    goal: "Review the agreement.",
    matter_id: "matter-1",
    deliverables,
    current_plan: steps.map((_, position) => ({ id: `step-${position}` })),
    latest_checkpoint: buildAgentTaskContractCheckpoint({
      goalSpec: goal,
      contextManifest: context,
      stepContracts,
      capabilityGrants,
      createdAt: "2026-08-07T00:00:00.000Z",
    }),
  };
}

test("allows legacy and complete versioned tasks", () => {
  assert.equal(
    evaluateAgentTaskExecutionRecovery({ latest_checkpoint: null }).allowed,
    true,
  );
  assert.equal(
    evaluateAgentTaskExecutionRecovery(versionedTask()).allowed,
    true,
  );
});

test("blocks a versioned task with missing capability grants", () => {
  const task = versionedTask();
  delete (task.latest_checkpoint.contract as Record<string, unknown>)
    .capability_grants;
  const recovery = evaluateAgentTaskExecutionRecovery(task);
  assert.equal(recovery.allowed, false);
  assert.equal(recovery.issue_code, "capability_grant_invalid");
  assert.match(recovery.detail, /Existing work is preserved/);
});

test("blocks a versioned task with a malformed Step Contract", () => {
  const task = versionedTask();
  (task.latest_checkpoint.contract as Record<string, unknown>).step_contracts =
    null;
  const recovery = evaluateAgentTaskExecutionRecovery(task);
  assert.equal(recovery.allowed, false);
  assert.equal(recovery.issue_code, "step_contract_invalid");
});
