import assert from "node:assert/strict";
import {
  buildGoalAwareFallbackPlan,
  planAgentTaskFromOutput,
  validateGoalAwarePlan,
  type GoalAwareTaskPlan,
} from "../src/lib/agentTaskPlanner";
import {
  evaluateTaskDeliverables,
  findDeliverableArtifact,
  taskDeliverablePurpose,
} from "../src/lib/agentTaskDeliverables";
import { agentStepCreationKind } from "../src/lib/agentStepExecutor";

function assertPlan(plan: GoalAwareTaskPlan, hasSources: boolean) {
  assert.ok(plan.steps.length >= 3 && plan.steps.length <= 6);
  assert.equal(plan.steps.at(-1)?.title, "Verify deliverables");
  assert.equal(plan.steps.at(-1)?.capability, "verify");
  if (hasSources) assert.equal(plan.steps[0]?.capability, "read_sources");
  assert.ok(plan.deliverables.length > 0);
  validateGoalAwarePlan(plan, {
    goal: "Complete the stated legal work",
    hasSources,
  });
}

async function main() {
  assert.equal(
    agentStepCreationKind({
      title: "Build the risk matrix",
      expected_output: "A clause-by-clause risk matrix linked to sources.",
    }),
    "tabular_review",
    "legacy fixed plans must still invoke the Excel capability",
  );
  assert.equal(
    agentStepCreationKind({
      title: "Draft the review memo",
      expected_output: "A reviewable memo draft with citations.",
    }),
    "draft",
    "legacy fixed plans must still invoke the Word capability",
  );
  assert.equal(
    agentStepCreationKind({
      title: "Compare material positions",
      expected_output: "Identify aligned and divergent terms.",
    }),
    null,
    "analysis steps must not generate duplicate artifacts",
  );
  const contract = buildGoalAwareFallbackPlan({
    goal: "Review contract and prepare a risk matrix and memo",
    hasSources: true,
  });
  assert.equal(contract.deliverables.length, 2);
  assert.deepEqual(
    contract.deliverables.map((item) => item.artifact_type).sort(),
    ["draft", "tabular_review"],
  );
  validateGoalAwarePlan(contract, {
    goal: "Review contract and prepare a risk matrix and memo",
    hasSources: true,
  });

  const compare = buildGoalAwareFallbackPlan({
    goal: "Compare these two documents",
    hasSources: true,
    workflowId: "builtin-compare-documents",
  });
  assert.deepEqual(
    compare.deliverables.map((item) => item.key),
    ["comparison-matrix", "comparison-summary"],
  );
  validateGoalAwarePlan(compare, {
    goal: "Compare these two documents",
    hasSources: true,
    workflowId: "builtin-compare-documents",
  });

  const extractOnly = buildGoalAwareFallbackPlan({
    goal: "Extract key terms only",
    hasSources: true,
    workflowId: "builtin-extract-key-terms",
  });
  assert.deepEqual(
    extractOnly.deliverables.map((item) => item.artifact_type),
    ["tabular_review"],
    "key-terms-only must not create a memo",
  );
  validateGoalAwarePlan(extractOnly, {
    goal: "Extract key terms only",
    hasSources: true,
    workflowId: "builtin-extract-key-terms",
  });

  const draftOnly = buildGoalAwareFallbackPlan({
    goal: "Draft memo only",
    hasSources: false,
  });
  assert.deepEqual(
    draftOnly.deliverables.map((item) => item.artifact_type),
    ["draft"],
    "draft-only must not create a risk matrix",
  );
  validateGoalAwarePlan(draftOnly, {
    goal: "Draft memo only",
    hasSources: false,
  });

  const explicitlyNoTable = buildGoalAwareFallbackPlan({
    goal: "Draft a concise internal memo only. Do not create a risk matrix or spreadsheet.",
    hasSources: true,
    workflowId: "builtin-draft-from-template",
  });
  assert.deepEqual(
    explicitlyNoTable.deliverables.map((item) => item.artifact_type),
    ["draft"],
    "an expressly rejected spreadsheet must not become a deliverable",
  );
  assert.ok(
    explicitlyNoTable.steps.every(
      (item) => item.capability !== "create_tabular",
    ),
  );

  const proofread = buildGoalAwareFallbackPlan({
    goal: "Proofread this document",
    hasSources: true,
    workflowId: "builtin-proofread",
  });
  assert.deepEqual(
    proofread.deliverables.map((item) => item.key),
    ["revised-document"],
  );
  assert.ok(
    proofread.steps.every(
      (item) => !/risk matrix|contract positions/i.test(item.title),
    ),
    "proofread must not inherit the contract-review plan",
  );
  validateGoalAwarePlan(proofread, {
    goal: "Proofread this document",
    hasSources: true,
    workflowId: "builtin-proofread",
  });

  const invalid = planAgentTaskFromOutput("not json", {
    goal: "Extract key terms only",
    hasSources: true,
    workflowId: "builtin-extract-key-terms",
  });
  assert.equal(invalid.source, "fallback");
  assert.deepEqual(
    invalid.plan.deliverables.map((item) => item.key),
    ["key-terms-table"],
  );

  const unsafe = planAgentTaskFromOutput(
    JSON.stringify({
      steps: [
        {
          capability: "analyze",
          title: "Request new permission",
          expected_output: "Request new permission for an external system.",
        },
        {
          capability: "create_draft",
          title: "Draft memo",
          expected_output: "Create the requested Word memo.",
        },
        {
          capability: "verify",
          title: "Verify deliverables",
          expected_output: "Verify all declared deliverables.",
        },
      ],
      deliverables: [
        {
          key: "memo",
          title: "Memo",
          description: "Requested memo document.",
          required: true,
          artifact_type: "draft",
          purpose: "Requested draft",
        },
      ],
    }),
    { goal: "Draft memo only", hasSources: false },
  );
  assert.equal(unsafe.source, "fallback");

  const misalignedComparison = planAgentTaskFromOutput(
    JSON.stringify({
      steps: [
        {
          capability: "read_sources",
          title: "Read source documents",
          expected_output: "Read both selected source documents in full.",
        },
        {
          capability: "create_tabular",
          title: "Create risk matrix",
          expected_output: "Create an Excel risk matrix for the source terms.",
        },
        {
          capability: "create_draft",
          title: "Draft review memo",
          expected_output: "Create a Word review memo for the source terms.",
        },
        {
          capability: "verify",
          title: "Verify deliverables",
          expected_output:
            "Verify all declared deliverables and source support.",
        },
      ],
      deliverables: [
        {
          key: "risk-matrix",
          title: "Risk matrix",
          description: "Contract risks and recommendations.",
          required: true,
          artifact_type: "tabular_review",
          purpose: "Risk matrix",
        },
        {
          key: "review-memo",
          title: "Review memo",
          description: "Contract review findings.",
          required: true,
          artifact_type: "draft",
          purpose: "Review memo",
        },
      ],
    }),
    {
      goal: "Compare these two documents",
      hasSources: true,
      workflowId: "builtin-compare-documents",
    },
  );
  assert.equal(misalignedComparison.source, "fallback");
  assert.deepEqual(
    misalignedComparison.plan.deliverables.map((item) => item.key),
    ["comparison-matrix", "comparison-summary"],
  );

  assert.equal(
    taskDeliverablePurpose({ key: "risk-matrix", title: "Risk matrix" }),
    "Risk matrix",
    "legacy fixed tasks must keep their purpose mapping",
  );
  assert.equal(
    findDeliverableArtifact(
      {
        key: "key-terms-table",
        title: "Key terms table",
        purpose: "Key terms table",
        artifact_type: "tabular_review",
      },
      [
        {
          artifact_type: "tabular_review",
          artifact_id: "table_1",
          purpose: "Key terms table",
        },
      ],
    )?.artifact_id,
    "table_1",
    "dynamic verifier lookup must use the task's declared deliverable",
  );
  const dynamicState = await evaluateTaskDeliverables(
    {
      from: () => ({
        select: () => ({
          in: async () => ({
            data: [{ id: "table_1", project_id: "matter_1" }],
            error: null,
          }),
        }),
      }),
    } as never,
    {
      task: {
        matter_id: "matter_1",
        deliverables: extractOnly.deliverables.map((item) => ({
          ...item,
          artifact_id: "table_1",
        })),
      },
      artifacts: [
        {
          artifact_type: "tabular_review",
          artifact_id: "table_1",
          purpose: "Key terms table",
        },
      ],
    },
  );
  assert.deepEqual(dynamicState.missing, []);
  assert.deepEqual(dynamicState.outsideMatter, []);

  assertPlan(
    buildGoalAwareFallbackPlan({
      goal: "Prepare a concise work product",
      hasSources: false,
    }),
    false,
  );

  console.log(
    JSON.stringify({ ok: true, suite: "agent-task-planner-smoke-v1" }, null, 2),
  );
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
