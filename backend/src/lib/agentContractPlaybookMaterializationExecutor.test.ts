import assert from "node:assert/strict";
import test from "node:test";

import {
  buildContractPlaybookMaterializationEffectInput,
  isContractPlaybookMaterializedDeliverableKey,
} from "./agentContractPlaybookMaterializationExecutor";
import type { ContractPlaybookMaterializationPlanV1 } from "./agent-packs/contract/contractPlaybookMaterialization";
import { canonicalEffectInput } from "./agent-kernel/effects/stepEffect";

const plan = {
  kind: "contract_playbook_materialization_plan_v1",
  receipt_fingerprint: "a".repeat(64),
  status: "ready",
  source: {
    document_id: "22222222-2222-4222-8222-222222222222",
    version_id: "33333333-3333-4333-8333-333333333333",
  },
  revision_actions: [],
  unresolved_finding_ids: [],
  issues: [],
  opinion: { title: "Contract Review Opinion", sections: [] },
} satisfies ContractPlaybookMaterializationPlanV1;

test("only the three fixed Contract deliverables use server materialization", () => {
  assert.equal(isContractPlaybookMaterializedDeliverableKey("contract-revision"), true);
  assert.equal(isContractPlaybookMaterializedDeliverableKey("contract-clean"), true);
  assert.equal(isContractPlaybookMaterializedDeliverableKey("review-opinion"), true);
  assert.equal(isContractPlaybookMaterializedDeliverableKey("hearing-outline"), false);
});

test("effect identity binds the fixed receipt, source Version, and one deliverable", () => {
  const effectInput = buildContractPlaybookMaterializationEffectInput({
    plan,
    deliverableKey: "contract-revision",
  });
  assert.deepEqual(effectInput, {
    kind: "contract_playbook_server_materialization_v1",
    materialization_plan_fingerprint: "a".repeat(64),
    source_document_id: plan.source.document_id,
    source_version_id: plan.source.version_id,
    deliverable_key: "contract-revision",
  });
  assert.doesNotMatch(canonicalEffectInput(effectInput), /prompt|model|tool_call/i);
});
