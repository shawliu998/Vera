import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentVerifierStructuredOutputError,
  AGENT_VERIFICATION_RECORD_KEY,
  buildAgentVerificationPacketV1,
  buildAgentVerificationRecordV1,
  buildAgentSemanticVerifierProjectionV1,
  cleanSemanticVerifierResult,
  detectArtifactIncompleteEnding,
  mergeAgentVerificationResultV1,
  parseAgentSemanticVerifierResult,
  readAgentVerificationRecordV1,
  type AgentVerificationPacketV1,
} from "./verifierCore";
import {
  ARTIFACT_INCOMPLETE_ENDING_REPAIR_INSTRUCTION,
  buildAgentVerificationRepairReceiptV1,
  canStartDeterministicAgentVerificationRepairV1,
  coordinateOneAgentVerificationRepairV1,
  decideAgentVerificationRepairV1,
} from "./repairEligibility";

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
        accepted_view_complete: true,
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

test("semantic verification excludes incomplete projections and cannot turn them into omissions", () => {
  const full = packet({
    deliverables: [
      packet().deliverables[0],
      {
        key: "evidence-inventory",
        artifact_type: "tabular_review",
        artifact_id: "88888888-8888-4888-8888-888888888888",
        document_id: null,
        current_version_id: null,
        accepted_view_sha256: `sha256:${"b".repeat(64)}`,
        accepted_view_text: "status=pending review_status=unresolved",
        accepted_view_complete: false,
      },
    ],
    deterministic_checks: [
      {
        code: "verification-scope:evidence-inventory",
        dimension: "goal_coverage",
        status: "gap",
        detail: "The complete Review is outside the bounded semantic projection.",
        issue: {
          code: "verification_scope_exceeded",
          deliverable_key: "evidence-inventory",
          accepted_view_characters: 120_000,
          projected_characters: 0,
        },
      },
    ],
  });
  const projected = buildAgentSemanticVerifierProjectionV1(full);
  assert.deepEqual(
    projected.deliverables.map((deliverable) => deliverable.key),
    ["opinion"],
  );
  assert.deepEqual(projected.source_versions, []);
  assert.deepEqual(projected.deterministic_checks, []);
  assert.throws(
    () =>
      mergeAgentVerificationResultV1({
        packet: full,
        semanticResult: {
          kind: "agent_semantic_verifier_result_v1",
          goal_coverage: "gap",
          issues: [
            {
              code: "semantic_goal_omission",
              deliverable_key: "evidence-inventory",
              goal_excerpt: "an opinion",
              detail: "Pending and unresolved cells were treated as incomplete.",
            },
          ],
        },
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
      issueCode: "semantic_goal_omission",
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

test("a bounded-projection observation does not hide one semantic repair target", () => {
  const fixed = packet({
    deterministic_checks: [
      {
        code: "bounded-view",
        dimension: "goal_coverage",
        status: "gap",
        detail: "The complete accepted-view needs lawyer review.",
        issue: {
          code: "verification_scope_exceeded",
          deliverable_key: "opinion",
          accepted_view_characters: 120_000,
          projected_characters: 80_000,
        },
      },
    ],
  });
  const result = mergeAgentVerificationResultV1({
    packet: fixed,
    semanticResult: {
      kind: "agent_semantic_verifier_result_v1",
      goal_coverage: "gap",
      issues: [
        {
          code: "semantic_goal_omission",
          deliverable_key: "opinion",
          goal_excerpt: "automatic renewal",
          detail: "The opinion does not address automatic renewal.",
        },
      ],
    },
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
      issueCode: "semantic_goal_omission",
      goalExcerpt: "automatic renewal",
    },
  );
});

test("detects only explicit high-confidence abrupt prose endings", () => {
  const truncated =
    "本意见书依据本案固定证据源文件编制。凡源文件未予确立的真实性、可采性、关联性及款项分配等事项，均明确标注为";
  assert.equal(detectArtifactIncompleteEnding(truncated), truncated);
  assert.equal(detectArtifactIncompleteEnding(`${truncated}未解决。`), null);
  assert.equal(detectArtifactIncompleteEnding("结论如下"), null);
  assert.equal(
    detectArtifactIncompleteEnding(
      "This opinion preserves every supported proposition and expressly identifies unresolved matters, including",
    ),
    "This opinion preserves every supported proposition and expressly identifies unresolved matters, including",
  );
  assert.equal(
    detectArtifactIncompleteEnding(
      "This opinion preserves every supported proposition and identifies unresolved matters.",
    ),
    null,
  );
});

test("one exact incomplete ending can repair only its complete bound draft", () => {
  const acceptedView =
    "本意见书依据本案固定证据源文件编制。凡源文件未予确立的真实性、可采性、关联性及款项分配等事项，均明确标注为";
  const acceptedHash = `sha256:${"b".repeat(64)}`;
  const fixed = packet({
    deliverables: [
      {
        ...packet().deliverables[0],
        accepted_view_sha256: acceptedHash,
        accepted_view_text: acceptedView,
      },
    ],
    deterministic_checks: [
      {
        code: "artifact-ending:opinion",
        dimension: "artifact_integrity",
        status: "gap",
        detail: "The final sentence ends at an explicit continuation marker.",
        issue: {
          code: "artifact_incomplete_ending",
          deliverable_key: "opinion",
          document_id: ids.document,
          version_id: ids.version,
          accepted_view_sha256: acceptedHash,
          ending_excerpt: acceptedView,
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
    {
      kind: "bounded_artifact_edit",
      deliverableKey: "opinion",
      documentId: ids.document,
      versionId: ids.version,
      issueCode: "artifact_incomplete_ending",
      goalExcerpt: ARTIFACT_INCOMPLETE_ENDING_REPAIR_INSTRUCTION,
    },
  );
  assert.deepEqual(
    decideAgentVerificationRepairV1({
      packet: {
        ...fixed,
        deliverables: [
          { ...fixed.deliverables[0], accepted_view_complete: false },
        ],
      },
      result,
      repairAlreadyAttempted: false,
    }),
    { kind: "review_required", reason: "unbound_artifact" },
  );
  assert.equal(
    buildAgentVerificationRepairReceiptV1({
      kind: "agent_verification_repair_v1",
      task_id: ids.task,
      step_id: "step-verify",
      step_attempt: 1,
      issue_code: "artifact_incomplete_ending",
      deliverable_key: "opinion",
      document_id: ids.document,
      base_version_id: ids.version,
      target_version_id: "88888888-8888-4888-8888-888888888888",
      accepted_view_sha256: acceptedHash,
      goal_excerpt: ARTIFACT_INCOMPLETE_ENDING_REPAIR_INSTRUCTION,
    }).issue_code,
    "artifact_incomplete_ending",
  );
  assert.equal(canStartDeterministicAgentVerificationRepairV1(fixed), true);
  assert.equal(
    canStartDeterministicAgentVerificationRepairV1({
      ...fixed,
      deterministic_checks: [
        ...fixed.deterministic_checks,
        {
          code: "citation-relocation",
          dimension: "source_support",
          status: "gap",
          detail: "One citation cannot be relocated.",
          issue: {
            code: "citation_relocation_gap",
            deliverable_key: "opinion",
            total: 1,
            missing: 1,
            statuses: ["missing"],
          },
        },
      ],
    }),
    false,
  );
});

test("a persisted verifier record is bound to the exact Task, Step, and attempt", () => {
  const fixed = packet();
  const result = mergeAgentVerificationResultV1({
    packet: fixed,
    semanticResult: cleanSemanticVerifierResult(),
  });
  const record = buildAgentVerificationRecordV1({ packet: fixed, result });
  assert.deepEqual(
    readAgentVerificationRecordV1({
      [AGENT_VERIFICATION_RECORD_KEY]: record,
    }),
    { state: "valid", record },
  );
  assert.deepEqual(
    readAgentVerificationRecordV1({
      [AGENT_VERIFICATION_RECORD_KEY]: {
        ...record,
        result: { ...record.result, outcome: "review_required" },
      },
    }),
    { state: "invalid" },
  );
});

test("repair coordinator executes once, rechecks once, then requires review", async () => {
  const fixed = packet();
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
  const gap = mergeAgentVerificationResultV1({
    packet: fixed,
    semanticResult: semantic,
  });
  let repairs = 0;
  let rechecks = 0;
  const coordinated = await coordinateOneAgentVerificationRepairV1({
    packet: fixed,
    result: gap,
    repairAlreadyAttempted: false,
    executeRepair: async () => {
      repairs += 1;
    },
    recheck: async () => {
      rechecks += 1;
      return { packet: fixed, result: gap };
    },
  });
  assert.equal(repairs, 1);
  assert.equal(rechecks, 1);
  assert.deepEqual(coordinated.decision, {
    kind: "review_required",
    reason: "repair_already_attempted",
  });
});
