import assert from "node:assert/strict";
import test from "node:test";

import type { MatterContextManifestV1 } from "../../agent-kernel/context/matterContext";
import {
  compileContractPlaybookContext,
  ContractPlaybookContextError,
} from "./contractPlaybookContext";

const ids = {
  matter: "11111111-1111-4111-8111-111111111111",
  contract: "22222222-2222-4222-8222-222222222222",
  contractVersion: "33333333-3333-4333-8333-333333333333",
  reference: "44444444-4444-4444-8444-444444444444",
  referenceVersion: "55555555-5555-4555-8555-555555555555",
};

function matter(): MatterContextManifestV1 {
  return {
    kind: "matter_context_v1",
    matter_id: ids.matter,
    workflow: {
      id: "builtin-contract-playbook-review",
      title: "Contract Playbook Review",
      description: "Fixed workflow",
      type: "assistant",
      instructions: "Use fixed sources.",
      columns: [],
    },
    sources: [
      {
        document_id: ids.contract,
        version_id: ids.contractVersion,
        filename: "Agreement.docx",
        file_type: "docx",
        role: "source",
      },
      {
        document_id: ids.reference,
        version_id: ids.referenceVersion,
        filename: "Playbook.json",
        file_type: "json",
        role: "source",
      },
    ],
    compiled_at: "2026-08-08T00:00:00.000Z",
  };
}

function packInput() {
  return {
    contract_document_id: ids.contract,
    reference_document_id: ids.reference,
    reference_role: "playbook" as const,
    review_mode: "deep" as const,
    contract_type: "services",
    represented_side: "customer",
    negotiation_posture: "balanced" as const,
    jurisdiction: "China (PRC)",
    language: "zh" as const,
    background_facts: "No additional facts supplied.",
  };
}

test("compiler binds explicit roles to exact current Matter Versions", () => {
  const context = compileContractPlaybookContext({
    matter: matter(),
    packInput: packInput(),
    referenceRuleSet: {
      digest: `sha256:${"a".repeat(64)}`,
      expectedRuleCount: 16,
    },
  });
  assert.deepEqual(context.contract, {
    document_id: ids.contract,
    version_id: ids.contractVersion,
    filename: "Agreement.docx",
    file_type: "docx",
  });
  assert.equal(context.reference.role, "playbook");
  assert.equal(context.reference.expected_rule_count, 16);
});

test("compiler never guesses a missing or same-document reference", () => {
  assert.throws(
    () =>
      compileContractPlaybookContext({
        matter: matter(),
        packInput: {
          ...packInput(),
          reference_document_id: ids.contract,
        },
        referenceRuleSet: {
          digest: `sha256:${"b".repeat(64)}`,
          expectedRuleCount: 10,
        },
      }),
    (error) =>
      error instanceof ContractPlaybookContextError &&
      error.code === "contract_playbook_input_invalid",
  );
});

test("compare mode cannot treat a baseline as a Playbook or negotiating position", () => {
  assert.throws(
    () =>
      compileContractPlaybookContext({
        matter: matter(),
        packInput: { ...packInput(), review_mode: "compare" },
        referenceRuleSet: {
          digest: `sha256:${"c".repeat(64)}`,
          expectedRuleCount: 0,
        },
      }),
    (error) =>
      error instanceof ContractPlaybookContextError &&
      error.code === "contract_playbook_input_invalid",
  );
});

test("compiler rejects a contract Version that is not DOCX", () => {
  const fixed = matter();
  fixed.sources[0] = { ...fixed.sources[0]!, file_type: "pdf" };
  assert.throws(
    () =>
      compileContractPlaybookContext({
        matter: fixed,
        packInput: packInput(),
        referenceRuleSet: {
          digest: `sha256:${"d".repeat(64)}`,
          expectedRuleCount: 10,
        },
      }),
    (error) =>
      error instanceof ContractPlaybookContextError &&
      error.code === "contract_playbook_contract_not_docx",
  );
});
