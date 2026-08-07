import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentVerifierStructuredOutputError,
  buildAgentVerificationPacketV1,
  cleanSemanticVerifierResult,
  mergeAgentVerificationResultV1,
  parseAgentSemanticVerifierResult,
  type AgentVerificationPacketV1,
} from "./verifierCore";
import { decideAgentVerificationRepairV1 } from "./repairEligibility";

const ids = {
  task: "11111111-1111-4111-8111-111111111111",
  matter: "22222222-2222-4222-8222-222222222222",
  artifact: "33333333-3333-4333-8333-333333333333",
  document: "44444444-4444-4444-8444-444444444444",
  version: "55555555-5555-4555-8555-555555555555",
  sourceDocument: "66666666-6666-4666-8666-666666666666",
  sourceVersion: "77777777-7777-4777-8777-777777777777",
};

function packet(
  overrides: Partial<AgentVerificationPacketV1> = {},
): AgentVerificationPacketV1 {
  return {
    kind: "agent_verification_packet_v1",
    version: 1,
    task_id: ids.task,
    step_id: "step-verify",
    step_attempt: 1,
    matter_id: ids.matter,
    goal: "Draft an opinion that addresses automatic renewal.",
    profile: {
      kind: "agent_verifier_profile_v1",
      id: "generic-draft",
      version: "1",
      semantic_goal_check: true,
      repair_policy: "one_bound_artifact",
    },
    deliverables: [
      {
        key: "opinion",
        artifact_type: "draft",
        artifact_id: ids.artifact,
        document_id: ids.document,
        current_version_id: ids.version,
        accepted_view_sha256: `sha256:${"a".repeat(64)}`,
        accepted_view_text: "The agreement renews automatically.",
      },
    ],
    source_versions: [
      {
        document_id: ids.sourceDocument,
        version_id: ids.sourceVersion,
        role: "source",
      },
    ],
    deterministic_checks: [],
    ...overrides,
  };
}

test("verification packet requires unique, completely bound current Artifacts", () => {
  assert.throws(
    () =>
      buildAgentVerificationPacketV1(
        packet({
          deliverables: [
            ...packet().deliverables,
            { ...packet().deliverables[0], artifact_id: null },
          ],
        }),
      ),
    /unique|complete/i,
  );
});

test("deterministic gaps cannot be cleared by a semantic pass", () => {
  const fixed = packet({
    deterministic_checks: [
      {
        code: "current-version",
        dimension: "artifact_integrity",
        status: "gap",
        detail: "The current Version changed.",
        issue: {
          code: "artifact_version_changed",
          deliverable_key: "opinion",
          document_id: ids.document,
          expected_version_id: ids.version,
          current_version_id: null,
        },
      },
    ],
  });
  const result = mergeAgentVerificationResultV1({
    packet: fixed,
    semanticResult: cleanSemanticVerifierResult(),
  });
  assert.equal(result.outcome, "review_required");
  assert.equal(result.dimensions.artifact_integrity, "gap");
  assert.equal(result.dimensions.goal_coverage, "pass");
});

test("semantic issues must bind an exact goal excerpt and declared deliverable", () => {
  const invalid = {
    kind: "agent_semantic_verifier_result_v1" as const,
    goal_coverage: "gap" as const,
    issues: [
      {
        code: "semantic_goal_omission" as const,
        deliverable_key: "opinion",
        goal_excerpt: "a requirement the user never supplied",
        detail: "Missing item.",
      },
    ],
  };
  assert.throws(
    () =>
      mergeAgentVerificationResultV1({
        packet: packet(),
        semanticResult: invalid,
      }),
    AgentVerifierStructuredOutputError,
  );
});

test("only a single exact JSON fence is mechanically normalized", () => {
  assert.deepEqual(
    parseAgentSemanticVerifierResult(
      '```json\n{"kind":"agent_semantic_verifier_result_v1","goal_coverage":"pass","issues":[]}\n```',
    ),
    cleanSemanticVerifierResult(),
  );
  assert.throws(
    () =>
      parseAgentSemanticVerifierResult(
        'Result: {"kind":"agent_semantic_verifier_result_v1","goal_coverage":"pass","issues":[]}',
      ),
    AgentVerifierStructuredOutputError,
  );
});

test("clean verification has no approval or export state", () => {
  const result = mergeAgentVerificationResultV1({
    packet: packet(),
    semanticResult: cleanSemanticVerifierResult(),
  });
  assert.equal(result.outcome, "clean_pass");
  assert.equal("approved" in result, false);
  assert.equal("export_ready" in result, false);
});

test("citation-only gaps never authorize a whole-document rewrite", () => {
  const fixed = packet({
    deterministic_checks: [
      {
        code: "citation-relocation",
        dimension: "source_support",
        status: "gap",
        detail: "One citation drifted.",
        issue: {
          code: "citation_relocation_gap",
          deliverable_key: "opinion",
          total: 1,
          missing: 1,
          statuses: ["drifted"],
        },
      },
    ],
  });
  const result = mergeAgentVerificationResultV1({
    packet: fixed,
    semanticResult: cleanSemanticVerifierResult(),
  });
  assert.deepEqual(
    decideAgentVerificationRepairV1({
      packet: fixed,
      result,
      repairAlreadyAttempted: false,
    }),
    { kind: "review_required", reason: "multiple_or_unrepairable_gaps" },
  );
});

test("one exact semantic omission can use only its bound current Artifact", () => {
  const semantic = {
    kind: "agent_semantic_verifier_result_v1" as const,
    goal_coverage: "gap" as const,
    issues: [
      {
        code: "semantic_goal_omission" as const,
        deliverable_key: "opinion",
        goal_excerpt: "automatic renewal",
        detail: "The opinion does not address automatic renewal.",
      },
    ],
  };
  const fixed = packet();
  const result = mergeAgentVerificationResultV1({
    packet: fixed,
    semanticResult: semantic,
  });
  assert.deepEqual(
    decideAgentVerificationRepairV1({
      packet: fixed,
      result,
      repairAlreadyAttempted: false,
    }),
    {
      kind: "bounded_artifact_edit",
      deliverableKey: "opinion",
      documentId: ids.document,
      versionId: ids.version,
      goalExcerpt: "automatic renewal",
    },
  );
  assert.deepEqual(
    decideAgentVerificationRepairV1({
      packet: fixed,
      result,
      repairAlreadyAttempted: true,
    }),
    { kind: "review_required", reason: "repair_already_attempted" },
  );
});
