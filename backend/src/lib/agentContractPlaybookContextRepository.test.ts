import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { ContractPlaybookContextError } from "./agent-packs/contract/contractPlaybookContext";
import { deriveContractPlaybookRuleSet } from "./agentContractPlaybookContextRepository";

const pilot = new Uint8Array(
  readFileSync(
    new URL(
      "../../../scripts/vera-workflows/contract-playbook-review/references/prc-commercial-pilot-v1.json",
      import.meta.url,
    ),
  ),
);

test("fixed Playbook bytes bind digest and exact base plus overlay rule count", () => {
  const result = deriveContractPlaybookRuleSet({
    bytes: pilot,
    reviewMode: "checklist",
    contractType: "services_commission",
  });
  assert.match(result.digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(result.expectedRuleCount, 16);
});

test("compare mode hashes any fixed baseline without treating it as a Playbook", () => {
  const result = deriveContractPlaybookRuleSet({
    bytes: new TextEncoder().encode("fixed baseline bytes"),
    reviewMode: "compare",
    contractType: "not_applicable",
  });
  assert.match(result.digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(result.expectedRuleCount, 0);
});

test("checklist mode fails closed when the fixed rule set is not provable", () => {
  assert.throws(
    () =>
      deriveContractPlaybookRuleSet({
        bytes: new TextEncoder().encode('{"rules":[]}'),
        reviewMode: "checklist",
        contractType: "services_commission",
      }),
    (error) =>
      error instanceof ContractPlaybookContextError &&
      error.code === "contract_playbook_rule_set_invalid",
  );
});
