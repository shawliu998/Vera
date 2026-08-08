import assert from "node:assert/strict";
import test from "node:test";

import { validateAgentStepContractSet } from "./agent-kernel/contracts/stepContract";
import { isLitigationEvidenceInventoryCreationStep } from "./agentLitigationEvidenceInventoryStepExecutor";

const contract = validateAgentStepContractSet({
  kind: "agent_step_contract_set_v1",
  steps: [
    {
      schema_version: "agent_step_contract_v1",
      position: 0,
      capability: "read_sources",
      operation: "read",
      output_expectation: { kind: "checkpoint" },
      source_requirement: {
        mode: "pinned",
        citations_required: true,
        authority_as_of_required: false,
        jurisdictions: [],
        as_of_date: null,
      },
      deterministic_postconditions: [
        "summary_present",
        "source_versions_recorded",
      ],
    },
    {
      schema_version: "agent_step_contract_v1",
      position: 1,
      capability: "create_tabular",
      operation: "table.create",
      output_expectation: {
        kind: "artifact",
        deliverable_key: "evidence-inventory",
        artifact_type: "tabular_review",
      },
      source_requirement: {
        mode: "pinned",
        citations_required: true,
        authority_as_of_required: false,
        jurisdictions: [],
        as_of_date: null,
      },
      deterministic_postconditions: [
        "summary_present",
        "source_versions_recorded",
        "artifact_created",
        "artifact_current_version",
      ],
    },
    {
      schema_version: "agent_step_contract_v1",
      position: 2,
      capability: "verify",
      operation: "verify",
      output_expectation: { kind: "verification" },
      source_requirement: {
        mode: "pinned",
        citations_required: true,
        authority_as_of_required: false,
        jurisdictions: [],
        as_of_date: null,
      },
      deterministic_postconditions: [
        "summary_present",
        "source_versions_recorded",
        "required_deliverables_current",
        "source_requirement_satisfied",
        "verifier_passed",
      ],
    },
  ],
}).steps[1]!;

test("routes only the fixed hearing-preparation Evidence Inventory Step", () => {
  assert.equal(
    isLitigationEvidenceInventoryCreationStep({
      workflowId: "builtin-litigation-hearing-preparation",
      contract,
    }),
    true,
  );
  assert.equal(
    isLitigationEvidenceInventoryCreationStep({
      workflowId: "some-other-tabular-workflow",
      contract,
    }),
    false,
  );
  assert.equal(
    isLitigationEvidenceInventoryCreationStep({
      workflowId: "builtin-litigation-hearing-preparation",
      contract: {
        ...contract,
        output_expectation: {
          kind: "artifact",
          deliverable_key: "other-table",
          artifact_type: "tabular_review",
        },
      },
    }),
    false,
  );
});
