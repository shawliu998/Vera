import assert from "node:assert/strict";
import test from "node:test";

import type { ContractPlaybookContextV1 } from "./agent-packs/contract/contractPlaybookContext";
import { ContractPlaybookStructuredOutputError } from "./agent-packs/contract/contractPlaybookPack";
import { compileContractPlaybookAnalysisReceipt } from "./agentContractPlaybookAnalysis";

const ids = {
  contract: "11111111-1111-4111-8111-111111111111",
  contractVersion: "22222222-2222-4222-8222-222222222222",
  reference: "33333333-3333-4333-8333-333333333333",
  referenceVersion: "44444444-4444-4444-8444-444444444444",
  step: "55555555-5555-4555-8555-555555555555",
  message: "66666666-6666-4666-8666-666666666666",
};

const context: ContractPlaybookContextV1 = {
  kind: "contract_playbook_context_v1",
  context_version: "1.0.0",
  workflow_id: "builtin-contract-playbook-review",
  contract: {
    document_id: ids.contract,
    version_id: ids.contractVersion,
    filename: "Agreement.docx",
    file_type: "docx",
  },
  reference: {
    role: "playbook",
    document_id: ids.reference,
    version_id: ids.referenceVersion,
    filename: "Playbook.json",
    file_type: "json",
    rule_set_digest: `sha256:${"a".repeat(64)}`,
    expected_rule_count: 16,
  },
  review: {
    mode: "deep",
    contract_type: "services_commission",
    represented_side: "buyer_customer",
    negotiation_posture: "balanced",
    jurisdiction: "China (PRC)",
    language: "zh",
    background_facts: "No additional facts supplied.",
  },
};

const finding = {
  material: true,
  rule_id: "PRC-SVC-001",
  rule_version: "1.0.0",
  rule_outcome: "deviation",
  issue_type: "scope",
  risk_level: "high",
  priority: "must",
  confidence: 0.9,
  target_position: "Fixed scope",
  fallback_position: null,
  walk_away_position: null,
  contract_anchor: "Clause 2",
  contract_quote: "Supplier may change the scope at any time.",
  contract_citation_refs: [1],
  playbook_citation_refs: [2],
  recommendation: "Require written change control.",
  proposed_text: "Scope changes require written agreement.",
};

function citation(
  ref: number,
  documentId: string,
  versionId: string,
  quote: string,
) {
  return {
    kind: "document",
    ref,
    document_id: documentId,
    version_id: versionId,
    quote,
    quotes: [{ page: 1, quote }],
  };
}

test("analysis receipt binds every finding citation to exact fixed Versions", () => {
  const receipt = compileContractPlaybookAnalysisReceipt({
    context,
    rawOutput: JSON.stringify({
      kind: "contract_playbook_analysis_v1",
      findings: [finding],
    }),
    citations: [
      citation(1, ids.contract, ids.contractVersion, finding.contract_quote),
      citation(
        2,
        ids.reference,
        ids.referenceVersion,
        "Every scope change requires written agreement.",
      ),
    ],
    analyzeStepId: ids.step,
    analyzeAttempt: 1,
    citationSnapshotArtifactId: ids.message,
  });
  assert.equal(receipt.findings.length, 1);
  assert.equal(receipt.findings[0]?.lawyer_disposition, null);
  assert.equal(receipt.contract.version_id, ids.contractVersion);
});

test("analysis receipt rejects a citation rebound to the wrong document", () => {
  assert.throws(
    () =>
      compileContractPlaybookAnalysisReceipt({
        context,
        rawOutput: JSON.stringify({
          kind: "contract_playbook_analysis_v1",
          findings: [finding],
        }),
        citations: [
          citation(
            1,
            ids.reference,
            ids.referenceVersion,
            finding.contract_quote,
          ),
          citation(
            2,
            ids.reference,
            ids.referenceVersion,
            "Every scope change requires written agreement.",
          ),
        ],
        analyzeStepId: ids.step,
        analyzeAttempt: 1,
        citationSnapshotArtifactId: ids.message,
      }),
    ContractPlaybookStructuredOutputError,
  );
});

test("analysis receipt rejects an unproven or unused citation", () => {
  assert.throws(
    () =>
      compileContractPlaybookAnalysisReceipt({
        context,
        rawOutput: JSON.stringify({
          kind: "contract_playbook_analysis_v1",
          findings: [finding],
        }),
        citations: [
          citation(1, ids.contract, ids.contractVersion, "Different quote"),
          citation(
            2,
            ids.reference,
            ids.referenceVersion,
            "Every scope change requires written agreement.",
          ),
        ],
        analyzeStepId: ids.step,
        analyzeAttempt: 1,
        citationSnapshotArtifactId: ids.message,
      }),
    ContractPlaybookStructuredOutputError,
  );
});
