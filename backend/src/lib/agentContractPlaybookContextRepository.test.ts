import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Document, Packer, Paragraph } from "docx";

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

test("fixed Playbook bytes bind digest and exact base plus overlay rule identities", async () => {
  const result = await deriveContractPlaybookRuleSet({
    bytes: pilot,
    reviewMode: "checklist",
    contractType: "services_commission",
  });
  assert.match(result.digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(result.expectedRuleCount, 16);
  assert.deepEqual(result.expectedRules[0], {
    rule_id: "PRC-BASE-001",
    rule_version: "1.0.0",
  });
  assert.deepEqual(result.expectedRules.at(-1), {
    rule_id: "PRC-SVC-006",
    rule_version: "1.0.0",
  });
});

test("compare mode hashes any fixed baseline without treating it as a Playbook", async () => {
  const result = await deriveContractPlaybookRuleSet({
    bytes: new TextEncoder().encode("fixed baseline bytes"),
    reviewMode: "compare",
    contractType: "not_applicable",
  });
  assert.match(result.digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(result.expectedRuleCount, 0);
  assert.deepEqual(result.expectedRules, []);
});

test("checklist mode fails closed when the fixed rule set is not provable", async () => {
  await assert.rejects(
    async () =>
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

test("fixed Playbook DOCX binds the visible overlay and exact rule identities", async () => {
  const bytes = await Packer.toBuffer(
    new Document({
      sections: [
        {
          children: [
            new Paragraph("规则包 ID"),
            new Paragraph("prc-confidentiality"),
            new Paragraph("PRC-BASE-001@1.0.0  ·  主体与授权"),
            new Paragraph("PRC-NDA-001@1.0.0  ·  定义"),
          ],
        },
      ],
    }),
  );
  const result = await deriveContractPlaybookRuleSet({
    bytes,
    reviewMode: "checklist",
    contractType: "nda",
  });
  assert.equal(result.expectedRuleCount, 2);
  assert.deepEqual(result.expectedRules, [
    { rule_id: "PRC-BASE-001", rule_version: "1.0.0" },
    { rule_id: "PRC-NDA-001", rule_version: "1.0.0" },
  ]);
});

test("fixed Playbook DOCX rejects a contract-family overlay mismatch", async () => {
  const bytes = await Packer.toBuffer(
    new Document({
      sections: [
        {
          children: [
            new Paragraph("prc-confidentiality"),
            new Paragraph("PRC-NDA-001@1.0.0  ·  定义"),
          ],
        },
      ],
    }),
  );
  await assert.rejects(
    () =>
      deriveContractPlaybookRuleSet({
        bytes,
        reviewMode: "checklist",
        contractType: "services_commission",
      }),
    (error) =>
      error instanceof ContractPlaybookContextError &&
      error.code === "contract_playbook_rule_set_invalid",
  );
});
