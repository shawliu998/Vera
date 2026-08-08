import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_STEP_CAPABILITY_GRANT_VERSION,
  readAgentStepCapabilityGrants,
  resolveBoundedRepairToolNames,
  resolveAgentStepCapabilityGrant,
  WORK_TASK_HOST_TOOL_NAMES,
} from "../capability/stepCapability";
import { buildMatterContextManifest } from "../context/matterContext";
import {
  buildAgentTaskContractCheckpoint,
  compileAgentGoalSpec,
  normalizeAgentTaskArtifactContracts,
  readAgentTaskAssignmentContract,
} from "./taskContract";
import {
  buildAgentStepReceipt,
  buildAgentStepReviewReceipt,
  compileAgentStepContracts,
  readAgentStepReceipts,
  readAgentStepContracts,
} from "./stepContract";
import {
  createDocumentsRequiredInput,
  readResolvedRequiredInputIds,
  requiredInputFromAssistantEvents,
  validateRequiredInputSubmission,
} from "./requiredInput";
import { selectActiveTools } from "../../chat/streaming";
import { buildServerOwnedTaskPlan } from "../../agentTaskPlanner";
import { EPO_OPS_SOURCE_CONNECTOR_PIN } from "../../agent-packs/patent/epoOpsSourcePack";

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

function versionedTask() {
  const artifacts = normalizeAgentTaskArtifactContracts([
    {
      key: "risk-matrix",
      title: "Risk matrix",
      description: "Fixed source-linked risk findings.",
      required: true,
      artifact_type: "tabular_review",
      purpose: "Risk matrix",
    },
    {
      key: "review-memo",
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
    artifactContracts: artifacts,
    hasSources: true,
  });
  const steps = [
    { capability: "read_sources" as const },
    { capability: "analyze" as const },
    { capability: "create_tabular" as const },
    { capability: "create_draft" as const },
    { capability: "verify" as const },
  ];
  const stepContracts = compileAgentStepContracts({
    steps,
    goalSpec: goal,
    artifactContracts: artifacts,
    contextManifest: context,
  });
  const grants = stepContracts.steps.map((contract) =>
    resolveAgentStepCapabilityGrant({
      contract,
      availableToolNames: WORK_TASK_HOST_TOOL_NAMES,
    }),
  );
  return {
    goal: "Review the agreement.",
    matter_id: "matter-1",
    deliverables: artifacts,
    current_plan: steps.map((_, position) => ({ id: `step-${position}` })),
    latest_checkpoint: buildAgentTaskContractCheckpoint({
      goalSpec: goal,
      contextManifest: context,
      stepContracts,
      capabilityGrants: grants,
      createdAt: "2026-08-07T00:00:00.000Z",
    }),
  };
}

test("server compiles one fixed Step and capability grant per Artifact", () => {
  const task = versionedTask();
  assert.equal(readAgentTaskAssignmentContract(task).state, "valid");
  const steps = readAgentStepContracts(task);
  const grants = readAgentStepCapabilityGrants(task);
  assert.equal(steps.state, "valid");
  assert.equal(grants.state, "valid");
  if (steps.state !== "valid" || grants.state !== "valid") return;
  assert.deepEqual(
    steps.contracts.map((contract) => contract.operation),
    ["read", "classify", "table.create", "draft.create", "verify"],
  );
  assert.deepEqual(
    steps.contracts
      .filter((contract) => contract.output_expectation.kind === "artifact")
      .map((contract) =>
        contract.output_expectation.kind === "artifact"
          ? contract.output_expectation.deliverable_key
          : null,
      ),
    ["risk-matrix", "review-memo"],
  );
  assert.deepEqual(grants.grants[1]?.allowed_tool_names, [
    "ask_inputs",
    "read_document",
    "find_in_document",
  ]);
  assert.deepEqual(
    grants.grants[2]?.allowed_tool_names.at(-1),
    "generate_excel",
  );
  assert.deepEqual(
    grants.grants[3]?.allowed_tool_names.at(-1),
    "generate_docx",
  );
  assert.deepEqual(grants.grants[4]?.allowed_tool_names, []);
});

test("Workflow Manifest fixes multi-Artifact contract and litigation plans without model planning", () => {
  const contract = buildServerOwnedTaskPlan({
    goal: "Review the agreement under the fixed Playbook.",
    hasSources: true,
    workflowId: "builtin-contract-playbook-review",
    workflowType: "assistant",
  });
  assert.deepEqual(
    contract.plan.deliverables.map((item) => item.key),
    ["contract-revision", "contract-clean", "review-opinion"],
  );
  assert.equal(contract.plan.steps.length, 6);
  assert.equal(contract.plan.steps.at(-1)?.capability, "verify");

  const litigation = buildServerOwnedTaskPlan({
    goal: "Prepare the evidence inventory, objection opinion and hearing outline.",
    hasSources: true,
    workflowId: "builtin-litigation-hearing-preparation",
    workflowType: "assistant",
  });
  assert.deepEqual(
    litigation.plan.deliverables.map((item) => item.key),
    ["evidence-inventory", "evidence-objection-opinion", "hearing-outline"],
  );
  assert.equal(litigation.plan.steps.length, 6);

  const acquisition = buildServerOwnedTaskPlan({
    goal: "Acquire bounded prior art and create the search record.",
    hasSources: true,
    workflowId: "builtin-patent-prior-art-acquisition",
    workflowType: "assistant",
  });
  assert.deepEqual(
    acquisition.plan.deliverables.map((item) => item.key),
    ["prior-art-acquisition-record"],
  );
  assert.deepEqual(
    acquisition.plan.steps.map((item) => item.capability),
    ["read_sources", "create_draft", "verify"],
  );
  assert.equal(acquisition.plan.steps[0]?.title, "Acquire bounded prior art");
  assert.deepEqual(acquisition.stepOperations, [
    "source.acquire",
    undefined,
    undefined,
  ]);

  const acquisitionArtifacts = normalizeAgentTaskArtifactContracts(
    acquisition.plan.deliverables,
  );
  const acquisitionGoal = compileAgentGoalSpec({
    objective: "Acquire bounded prior art and create the search record.",
    taskFamily: acquisition.taskFamily,
    artifactContracts: acquisitionArtifacts,
    hasSources: true,
    jurisdictions: ["US"],
    asOfDate: "2026-08-08",
  });
  const acquisitionContracts = compileAgentStepContracts({
    steps: acquisition.plan.steps.map((plannedStep, position) => ({
      ...plannedStep,
      operation: acquisition.stepOperations[position],
    })),
    goalSpec: acquisitionGoal,
    artifactContracts: acquisitionArtifacts,
    contextManifest: context,
  });
  const acquisitionGrant = resolveAgentStepCapabilityGrant({
    contract: acquisitionContracts.steps[0]!,
    availableToolNames: WORK_TASK_HOST_TOOL_NAMES,
    readOnlyConnectorPins: [EPO_OPS_SOURCE_CONNECTOR_PIN],
  });
  assert.equal(acquisitionContracts.steps[0]?.operation, "source.acquire");
  assert.equal(acquisitionGrant.allowed_tool_names.length, 0);
  assert.equal(acquisitionGrant.research_tools_allowed, true);
  assert.deepEqual(acquisitionGrant.read_only_connector_pins, [
    EPO_OPS_SOURCE_CONNECTOR_PIN,
  ]);
});

test("capability intersection cannot widen tools, MCP, research, or consequence scope", () => {
  const task = versionedTask();
  const steps = readAgentStepContracts(task);
  assert.equal(steps.state, "valid");
  if (steps.state !== "valid") return;
  const grant = resolveAgentStepCapabilityGrant({
    contract: steps.contracts[3]!,
    availableToolNames: [...WORK_TASK_HOST_TOOL_NAMES, "generate_ppt"],
    requestedToolNames: ["generate_docx", "generate_ppt", "external_send"],
  });
  assert.deepEqual(grant.allowed_tool_names, ["generate_docx"]);
  assert.equal(grant.mcp_tools_allowed, false);
  assert.equal(grant.research_tools_allowed, false);
  assert.equal(grant.consequential_actions_allowed, false);

  const tools = (name: string) => ({ type: "function", function: { name } });
  assert.deepEqual(
    selectActiveTools({
      disableTools: false,
      baseTools: [tools("read_document"), tools("generate_docx")],
      mcpTools: [tools("external_send")],
      allowedToolNames: ["generate_docx"],
    }),
    [tools("generate_docx")],
  );
  assert.throws(
    () =>
      selectActiveTools({
        disableTools: false,
        baseTools: [tools("read_document")],
        mcpTools: [],
        allowedToolNames: ["generate_docx"],
      }),
    /schema is unavailable/,
  );
  assert.deepEqual(
    resolveBoundedRepairToolNames({
      artifactType: "draft",
      availableToolNames: [
        ...WORK_TASK_HOST_TOOL_NAMES,
        "generate_ppt",
        "external_send",
      ],
    }),
    ["ask_inputs", "read_document", "find_in_document", "generate_docx"],
  );
});

test("a Step receipt is emitted only after every fixed postcondition passes", () => {
  const task = versionedTask();
  const steps = readAgentStepContracts(task);
  assert.equal(steps.state, "valid");
  if (steps.state !== "valid") return;
  const contract = steps.contracts[3]!;
  assert.throws(
    () =>
      buildAgentStepReceipt({
        contract,
        attempt: 1,
        summary: "Draft created.",
        sourceVersionIds: ["version-1"],
        artifactIds: ["draft-1"],
        satisfiedPostconditions: [
          "summary_present",
          "source_versions_recorded",
          "artifact_created",
        ],
      }),
    /artifact_current_version/,
  );
  const receipt = buildAgentStepReceipt({
    contract,
    attempt: 1,
    summary: "Draft created.",
    sourceVersionIds: ["version-1"],
    artifactIds: ["draft-1"],
    satisfiedPostconditions: [
      "summary_present",
      "source_versions_recorded",
      "artifact_created",
      "artifact_current_version",
    ],
  });
  assert.deepEqual(readAgentStepReceipts({ step_receipts: [receipt] }), [
    receipt,
  ]);
  assert.deepEqual(
    receipt.postconditions.map((postcondition) => postcondition.code),
    contract.deterministic_postconditions,
  );
});

test("a verifier gap produces a review receipt without claiming a clean pass", () => {
  const task = versionedTask();
  const steps = readAgentStepContracts(task);
  assert.equal(steps.state, "valid");
  if (steps.state !== "valid") return;
  const receipt = buildAgentStepReviewReceipt({
    contract: steps.contracts.at(-1)!,
    attempt: 1,
    summary: "Citation relocation requires lawyer review.",
    sourceVersionIds: ["version-1"],
    artifactIds: [],
    satisfiedPostconditions: [
      "summary_present",
      "source_versions_recorded",
      "required_deliverables_current",
    ],
  });
  assert.equal(receipt.outcome, "review_required");
  assert.deepEqual(
    receipt.postconditions
      .filter((postcondition) => postcondition.status === "fail")
      .map((postcondition) => postcondition.code),
    ["source_requirement_satisfied", "verifier_passed"],
  );
});

test("malformed or missing versioned Step/grant contracts fail closed", () => {
  const missing = structuredClone(versionedTask());
  delete missing.latest_checkpoint.contract.step_contracts;
  assert.equal(readAgentStepContracts(missing).state, "invalid");

  const mismatched = structuredClone(versionedTask());
  mismatched.latest_checkpoint.contract.capability_grants[2]!.operation =
    "draft.create";
  const grants = readAgentStepCapabilityGrants(mismatched);
  assert.equal(
    grants.state,
    "valid",
    "schema-valid drift is checked against Step at execution",
  );

  const badPosition = structuredClone(versionedTask());
  badPosition.latest_checkpoint.contract.capability_grants[2]!.step_position = 4;
  assert.equal(readAgentStepCapabilityGrants(badPosition).state, "invalid");

  const incompleteV2 = structuredClone(versionedTask());
  delete (
    incompleteV2.latest_checkpoint.contract
      .capability_grants[0] as unknown as Record<string, unknown>
  ).read_only_connector_pins;
  assert.equal(readAgentStepCapabilityGrants(incompleteV2).state, "invalid");

  const legacy = structuredClone(versionedTask());
  for (const grant of legacy.latest_checkpoint.contract.capability_grants) {
    const mutable = grant as unknown as Record<string, unknown>;
    mutable.schema_version = "agent_step_capability_grant_v1";
    delete mutable.read_only_connector_pins;
  }
  const normalizedLegacy = readAgentStepCapabilityGrants(legacy);
  assert.equal(normalizedLegacy.state, "valid");
  if (normalizedLegacy.state === "valid") {
    assert.equal(
      normalizedLegacy.grants[0]?.schema_version,
      AGENT_STEP_CAPABILITY_GRANT_VERSION,
    );
    assert.deepEqual(normalizedLegacy.grants[0]?.read_only_connector_pins, []);
  }
});

test("required input is structured, validated, and replay-suppressed", () => {
  const required = requiredInputFromAssistantEvents(
    [
      {
        type: "ask_inputs",
        items: [
          {
            id: "represented-side",
            kind: "choice",
            question: "Which party do you represent?",
            options: [{ value: "Buyer" }, { value: "Seller" }],
            allow_other: true,
            other_label: "Other",
          },
        ],
      },
    ],
    { stepId: "step-1", createdAt: "2026-08-07T00:00:00.000Z" },
  );
  assert.ok(required);
  assert.throws(
    () => validateRequiredInputSubmission(required!, {}),
    /lawyer choice/,
  );
  assert.equal(
    validateRequiredInputSubmission(required!, { message: "Buyer" }).requestId,
    required?.request_id,
  );
  assert.deepEqual(
    validateRequiredInputSubmission(required!, {
      responses: [{ id: "represented-side", kind: "choice", answer: "Buyer" }],
    }).responses,
    [{ id: "represented-side", kind: "choice", answer: "Buyer" }],
  );
  assert.equal(
    requiredInputFromAssistantEvents(
      [{ type: "ask_inputs", items: required?.items }],
      {
        stepId: "step-1",
        resolvedRequestIds: [required!.request_id],
      },
    ),
    null,
  );

  const documents = createDocumentsRequiredInput({ stepId: "step-2" });
  assert.throws(
    () => validateRequiredInputSubmission(documents, { message: "Continue" }),
    /Matter document/,
  );
  assert.throws(
    () =>
      validateRequiredInputSubmission(documents, {
        responses: [
          {
            id: "required-source-documents",
            kind: "documents",
            document_ids: ["forged-document"],
          },
        ],
      }),
    /does not match the submitted documents/,
  );
  assert.doesNotThrow(() =>
    validateRequiredInputSubmission(documents, {
      documentIds: ["matter-document-1"],
      responses: [
        {
          id: "required-source-documents",
          kind: "documents",
          document_ids: ["matter-document-1"],
        },
      ],
    }),
  );

  const optionalDocuments = requiredInputFromAssistantEvents(
    [
      {
        type: "ask_inputs",
        items: [
          {
            id: "background-facts",
            kind: "choice",
            question: "Should unknown background facts remain unresolved?",
            options: [{ value: "Keep unresolved" }],
            allow_other: false,
            other_label: "Other",
          },
          {
            id: "supporting-facts",
            kind: "documents",
            document_types: ["Optional background materials"],
            required: false,
          },
        ],
      },
    ],
    { stepId: "step-3", createdAt: "2026-08-07T00:00:00.000Z" },
  );
  assert.ok(optionalDocuments);
  assert.equal(optionalDocuments.reason_code, "lawyer_choice");
  assert.match(optionalDocuments.prompt, /Optionally attach/);
  assert.doesNotThrow(() =>
    validateRequiredInputSubmission(optionalDocuments, {
      message: "Keep unresolved",
    }),
  );
  assert.throws(
    () =>
      validateRequiredInputSubmission(optionalDocuments!, {
        responses: [
          {
            id: "background-facts",
            kind: "choice",
            answer: "Invented fixed option",
          },
          {
            id: "supporting-facts",
            kind: "documents",
            document_ids: [],
          },
        ],
      }),
    /outside the fixed options/i,
  );
  assert.deepEqual(
    readResolvedRequiredInputIds({
      resolved_required_input_ids: [required?.request_id, 3, null],
    }),
    [required?.request_id],
  );
});
