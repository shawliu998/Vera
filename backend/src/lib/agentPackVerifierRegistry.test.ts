import assert from "node:assert/strict";
import test from "node:test";

import {
  compileContractPlaybookReceipt,
  deriveContractPlaybookFindingId,
} from "./agent-packs/contract/contractPlaybookPack";
import {
  buildAgentPackDeterministicChecks,
  resolveAgentVerifierProfile,
} from "./agentPackVerifierRegistry";

const profile = resolveAgentVerifierProfile("builtin-contract-playbook-review");

test("workflow manifest selects the Contract Pack verifier profile", () => {
  assert.equal(profile.id, "work_task_contract_docx_v1");
  assert.equal(profile.version, "1.0.0");
  assert.equal(profile.repair_policy, "one_bound_artifact");
  assert.equal(
    resolveAgentVerifierProfile("builtin-litigation-hearing-preparation")
      .repair_policy,
    "one_bound_artifact",
  );
  assert.equal(resolveAgentVerifierProfile(null).repair_policy, "none");
});

test("missing structured receipt becomes one review gap and preserves artifacts", () => {
  const checks = buildAgentPackDeterministicChecks({
    profile,
    currentPlan: [],
    deliverables: [],
  });
  assert.equal(checks.length, 1);
  assert.equal(checks[0]?.status, "gap");
  assert.equal(checks[0]?.issue?.code, "pack_check_gap");
  assert.deepEqual((checks[0]?.issue as { facts?: unknown })?.facts, {
    issues: [{ code: "receipt_missing", finding_id: null, rule_id: null }],
  });
});

test("registry passes a fixed receipt and matching current opinion", () => {
  const ids = [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
    "33333333-3333-4333-8333-333333333333",
    "44444444-4444-4444-8444-444444444444",
    "55555555-5555-4555-8555-555555555555",
    "66666666-6666-4666-8666-666666666666",
  ];
  const finding = {
    material: true,
    rule_id: "NDA-001",
    rule_version: "1",
    rule_outcome: "deviation" as const,
    issue_type: "scope",
    risk_level: "high" as const,
    priority: "must" as const,
    confidence: 0.9,
    target_position: null,
    fallback_position: null,
    walk_away_position: null,
    contract_anchor: "Clause 2",
    contract_quote: "All information is confidential.",
    contract_citation_refs: [1],
    playbook_citation_refs: [2],
    recommendation: "Narrow the definition.",
    proposed_text: null,
  };
  const findingId = deriveContractPlaybookFindingId(finding);
  const receipt = compileContractPlaybookReceipt({
    reviewMode: "deep",
    opinionLanguage: "en",
    analyzeStepId: ids[0]!,
    analyzeAttempt: 1,
    contract: { document_id: ids[1]!, version_id: ids[2]! },
    reference: {
      role: "playbook",
      document_id: ids[3]!,
      version_id: ids[4]!,
      rule_set_digest: `sha256:${"d".repeat(64)}`,
      expected_rule_count: 1,
    },
    citationSnapshotArtifactId: ids[5]!,
    findings: [finding],
    decisions: {
      [findingId]: {
        disposition: "comment",
        direction: "Narrow to disclosed project information.",
      },
    },
  });
  const checks = buildAgentPackDeterministicChecks({
    profile,
    currentPlan: [{ result_data: { contract_playbook_pack_receipt: receipt } }],
    deliverables: [
      {
        key: "review-opinion",
        artifact_type: "draft",
        artifact_id: ids[1]!,
        document_id: ids[1]!,
        current_version_id: ids[2]!,
        accepted_view_sha256: `sha256:${"e".repeat(64)}`,
        accepted_view_text:
          "NDA-001 Lawyer decision: preserve the operative text and add a comment. Narrow to disclosed project information.",
        accepted_view_complete: true,
      },
    ],
  });
  assert.equal(checks[0]?.status, "pass");

  const checkpointChecks = buildAgentPackDeterministicChecks({
    profile,
    currentPlan: [],
    checkpoint: { contract_playbook_pack_receipt: receipt },
    deliverables:
      checks[0]?.status === "pass"
        ? [
            {
              key: "review-opinion",
              artifact_type: "draft",
              artifact_id: ids[1]!,
              document_id: ids[1]!,
              current_version_id: ids[2]!,
              accepted_view_sha256: `sha256:${"e".repeat(64)}`,
              accepted_view_text:
                "NDA-001 Lawyer decision: preserve the operative text and add a comment. Narrow to disclosed project information.",
              accepted_view_complete: true,
            },
          ]
        : [],
  });
  assert.equal(checkpointChecks[0]?.status, "pass");
});
