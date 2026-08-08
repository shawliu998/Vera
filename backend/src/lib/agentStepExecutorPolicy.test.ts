import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentModelRequestTimeoutError,
  agentStepThinkingEnabled,
  authoritativeTaskCitationSnapshotIds,
  shouldRetryAgentStepModelError,
} from "./agentStepExecutor";
import { compileContractPlaybookReceipt } from "./agent-packs/contract/contractPlaybookPack";

test("a server deadline pauses instead of replaying the same model payload", () => {
  assert.equal(
    shouldRetryAgentStepModelError(
      new AgentModelRequestTimeoutError("glm-5.2"),
    ),
    false,
  );
  assert.equal(
    shouldRetryAgentStepModelError(
      Object.assign(new Error("provider overloaded"), { status: 503 }),
    ),
    true,
  );
  assert.equal(
    shouldRetryAgentStepModelError(new Error("invalid legal finding")),
    false,
  );
});

test("bounded Contract extraction disables provider thinking only for that step", () => {
  assert.equal(agentStepThinkingEnabled(true), false);
  assert.equal(agentStepThinkingEnabled(false), true);
});

test("a fixed Contract receipt excludes unrelated earlier citation snapshots", () => {
  const authoritativeId = "66666666-6666-4666-8666-666666666666";
  const receipt = compileContractPlaybookReceipt({
    reviewMode: "deep",
    opinionLanguage: "en",
    analyzeStepId: "11111111-1111-4111-8111-111111111111",
    analyzeAttempt: 1,
    contract: {
      document_id: "22222222-2222-4222-8222-222222222222",
      version_id: "33333333-3333-4333-8333-333333333333",
    },
    reference: {
      role: "playbook",
      document_id: "44444444-4444-4444-8444-444444444444",
      version_id: "55555555-5555-4555-8555-555555555555",
      rule_set_digest: `sha256:${"a".repeat(64)}`,
      expected_rule_count: 1,
    },
    citationSnapshotArtifactId: authoritativeId,
    findings: [
      {
        material: true,
        rule_id: "RULE-1",
        rule_version: "1.0.0",
        rule_outcome: "missing",
        issue_type: "missing_clause",
        risk_level: "high",
        priority: "must",
        confidence: null,
        target_position: null,
        fallback_position: null,
        walk_away_position: null,
        contract_anchor: null,
        contract_quote: null,
        contract_citation_refs: [],
        playbook_citation_refs: [1],
        recommendation: "Add the clause.",
        proposed_text: null,
      },
    ],
    decisions: {},
  });
  assert.deepEqual(
    authoritativeTaskCitationSnapshotIds(
      {
        latest_checkpoint: { contract_playbook_pack_receipt: receipt },
      },
      [
        { artifact_type: "citation_snapshot", artifact_id: "old-model-read" },
        { artifact_type: "citation_snapshot", artifact_id: authoritativeId },
      ],
    ),
    [authoritativeId],
  );
  assert.deepEqual(
    authoritativeTaskCitationSnapshotIds({ latest_checkpoint: null }, [
      { artifact_type: "citation_snapshot", artifact_id: "generic-1" },
      { artifact_type: "citation_snapshot", artifact_id: "generic-2" },
    ]),
    ["generic-1", "generic-2"],
  );
});
