import assert from "node:assert/strict";
import test from "node:test";

import type { MatterContextManifestV1 } from "../../agent-kernel/context/matterContext";
import {
  compileContractPlaybookContext,
  ContractPlaybookContextError,
  createContractPlaybookContextRequiredInput,
  parseContractPlaybookContextRequiredInput,
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

test("compare mode requires a distinct fixed DOCX baseline", () => {
  assert.throws(
    () =>
      compileContractPlaybookContext({
        matter: matter(),
        packInput: {
          ...packInput(),
          review_mode: "compare",
          reference_role: "baseline",
        },
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

test("server requests explicit Contract context with display labels and stable values", () => {
  const required = createContractPlaybookContextRequiredInput({
    matter: matter(),
    stepId: "step-read",
    createdAt: "2026-08-08T01:00:00.000Z",
  });
  const contractChoice = required.items.find(
    (item) => item.id === "contract-document-id",
  );
  assert.equal(contractChoice?.kind, "choice");
  if (contractChoice?.kind !== "choice") return;
  assert.deepEqual(contractChoice.options[0], {
    value: ids.contract,
    label: "Agreement.docx",
  });

  const contextInput = parseContractPlaybookContextRequiredInput({
    matter: matter(),
    requiredInput: required,
    responses: [
      { id: "contract-document-id", kind: "choice", answer: ids.contract },
      {
        id: "reference-document-id",
        kind: "choice",
        answer: ids.reference,
      },
      { id: "review-mode", kind: "choice", answer: "deep" },
      { id: "contract-type", kind: "choice", answer: "services_commission" },
      { id: "represented-side", kind: "choice", answer: "buyer_customer" },
      { id: "negotiation-posture", kind: "choice", answer: "balanced" },
      { id: "jurisdiction", kind: "choice", answer: "China (PRC)" },
      { id: "review-language", kind: "choice", answer: "zh" },
      { id: "background-facts", kind: "choice", answer: "keep_unresolved" },
    ],
  });
  assert.deepEqual(contextInput, {
    contract_document_id: ids.contract,
    reference_document_id: ids.reference,
    reference_role: "playbook",
    review_mode: "deep",
    contract_type: "services_commission",
    represented_side: "buyer_customer",
    negotiation_posture: "balanced",
    jurisdiction: "China (PRC)",
    language: "zh",
    background_facts:
      "No additional facts supplied; preserve unknown facts as unresolved.",
  });
});

test("Contract context request rejects an ambiguous oversized source scope", () => {
  const oversized = matter();
  oversized.sources.push(
    ...Array.from({ length: 15 }, (_, index) => ({
      ...oversized.sources[1]!,
      document_id: `${String(index + 10).padStart(8, "0")}-4444-4444-8444-444444444444`,
      version_id: `${String(index + 10).padStart(8, "0")}-5555-4555-8555-555555555555`,
      filename: `Reference-${index + 2}.json`,
    })),
  );
  assert.throws(
    () =>
      createContractPlaybookContextRequiredInput({
        matter: oversized,
        stepId: "step-read",
      }),
    (error) =>
      error instanceof ContractPlaybookContextError &&
      error.code === "contract_playbook_source_scope_too_large",
  );
});
