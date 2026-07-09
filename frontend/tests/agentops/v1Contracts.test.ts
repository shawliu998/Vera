import assert from "node:assert/strict";
import { test } from "node:test";

import {
  calculateCitationCoverage,
  canExportFinal,
  countUnsupportedClaims,
  createAuditEvent,
  createEvalCaseFromGateFailure,
  createEvalCaseFromReviewComment,
  createSkillCandidateFromEvalCases,
  createV1EvalCaseFixture,
  createV1CompactFixture,
  hashArtifact,
  parseBigAtReferences,
  summarizeGateResults,
  validateV1ArtifactShape,
  V1_CONTRACT_VERSION,
  type EvalCase,
} from "../../src/aletheia/agentops/v1Contracts";
import type { ReviewComment } from "../../src/aletheia/agentops/types";

test("V1 compact fixture validates the shared product-chain contracts", () => {
  const fixture = createV1CompactFixture();

  assert.equal(fixture.contract_version, V1_CONTRACT_VERSION);
  assert.equal(validateV1ArtifactShape("matter", fixture.matter).ok, true);
  assert.equal(validateV1ArtifactShape("document_record", fixture.documents[0]).ok, true);
  assert.equal(validateV1ArtifactShape("document_chunk", fixture.chunks[0]).ok, true);
  assert.equal(
    validateV1ArtifactShape("retrieval_result", fixture.retrieval_results[0]).ok,
    true,
  );
  assert.equal(validateV1ArtifactShape("evidence_item", fixture.evidence[0]).ok, true);
  assert.equal(validateV1ArtifactShape("claim", fixture.claims[0]).ok, true);
  assert.equal(validateV1ArtifactShape("issue_node", fixture.issues[0]).ok, true);
  assert.equal(
    validateV1ArtifactShape("obligation_item", fixture.obligations[0]).ok,
    true,
  );
  assert.equal(validateV1ArtifactShape("risk_item", fixture.risks[0]).ok, true);
  assert.equal(validateV1ArtifactShape("draft_memo", fixture.draft_memo).ok, true);
  assert.equal(validateV1ArtifactShape("gate_result", fixture.gate_results[0]).ok, true);
});

test("V1 shared helpers preserve gate, citation, audit, eval, skill, BigAt, and hash contracts", () => {
  const fixture = createV1CompactFixture();
  const coverage = calculateCitationCoverage(fixture.draft_memo, fixture.evidence);
  const gateSummary = summarizeGateResults(fixture.gate_results);

  assert.equal(coverage.citation_coverage_score, 1);
  assert.equal(countUnsupportedClaims(fixture.draft_memo, fixture.evidence), 0);
  assert.equal(gateSummary.total, 2);
  assert.equal(gateSummary.passed, 1);
  assert.equal(gateSummary.warning, 1);
  assert.equal(gateSummary.export_ready, false);
  assert.equal(canExportFinal(fixture.gate_results), false);
  assert.match(hashArtifact(fixture), /^fnv1a32:[a-f0-9]{8}$/);
  assert.deepEqual(
    parseBigAtReferences("Review @Matter and @Evidence:evidence-v1-notice-window").map(
      (reference) => reference.raw,
    ),
    ["@Matter", "@Evidence:evidence-v1-notice-window"],
  );

  const auditEvent = createAuditEvent({
    matter_id: fixture.matter.id,
    action: "v1_contract_fixture_validated",
    artifact_id: fixture.draft_memo.id,
    artifact_type: "draft_memo",
    timestamp: "2026-07-09T09:30:00.000Z",
  });
  assert.equal(auditEvent.actor_type, "system");
  assert.equal(auditEvent.actor_id, "v1-contracts");
  assert.equal(auditEvent.artifact_type, "draft_memo");

  const reviewComment = {
    id: "review-comment-v1-citation",
    matter_id: fixture.matter.id,
    artifact_id: fixture.draft_memo.id,
    artifact_type: "draft_memo",
    tag: "missing_citation",
    author: "Expert",
    comment: "Add a source citation before final export.",
    severity: "high",
    status: "open",
    created_at: "2026-07-09T09:31:00.000Z",
  } satisfies ReviewComment;
  const evalCase: EvalCase = createEvalCaseFromReviewComment(
    reviewComment,
    "run-v1-contract-fixture",
  );
  assert.equal(evalCase.failure_type, "missing_citation");

  const skill = createSkillCandidateFromEvalCases([evalCase]);
  assert.equal(skill.approval_status, "candidate");
  assert.deepEqual(skill.created_from_eval_case_ids, [evalCase.id]);
});

test("V1 gate failures convert into replayable eval cases without activating skills", () => {
  const fixture = createV1CompactFixture();
  const failedGate = {
    id: "gate-v1-external-source-failed",
    matter_id: fixture.matter.id,
    gate_type: "external_source",
    status: "failed",
    reason: "External-source material was used without expert approval.",
    affected_artifact_ids: [fixture.evidence[0].id],
    required_action:
      "Confirm external-source reliability, licensing, and disclosure before final export.",
    created_at: "2026-07-09T09:45:00.000Z",
  } satisfies typeof fixture.gate_results[number];

  const evalCase = createEvalCaseFromGateFailure(
    failedGate,
    "run-v1-gate-replay",
  );
  assert.equal(evalCase.failure_type, "missing_citation");
  assert.equal(evalCase.status, "open");
  assert.deepEqual(evalCase.input_snapshot, {
    gate_id: failedGate.id,
    gate_type: "external_source",
    gate_status: "failed",
    affected_artifact_ids: [fixture.evidence[0].id],
    required_action:
      "Confirm external-source reliability, licensing, and disclosure before final export.",
  });

  const skill = createSkillCandidateFromEvalCases([evalCase], {
    name: "External source review candidate",
  });
  assert.equal(skill.name, "External source review candidate");
  assert.equal(skill.approval_status, "candidate");
  assert.deepEqual(skill.created_from_eval_case_ids, [evalCase.id]);
});

test("V1 eval case fixture bundles open reviews and failed gates conservatively", () => {
  const fixture = createV1CompactFixture();
  const openReview = {
    id: "review-comment-v1-open-missing-material",
    matter_id: fixture.matter.id,
    artifact_id: fixture.draft_memo.id,
    artifact_type: "draft_memo",
    target_type: "memo_section",
    target_id: fixture.draft_memo.sections[0].id,
    tag: "missing issue",
    author: "Expert",
    comment: "Missing issue: confirm the incident timeline before export.",
    severity: "medium",
    status: "open",
    created_at: "2026-07-09T09:50:00.000Z",
  } satisfies ReviewComment;
  const resolvedReview = {
    ...openReview,
    id: "review-comment-v1-resolved",
    status: "resolved",
  } satisfies ReviewComment;
  const failedGate = {
    id: "gate-v1-missing-material-failed",
    matter_id: fixture.matter.id,
    gate_type: "missing_material",
    status: "failed",
    reason: "Open incident timeline question remains.",
    affected_artifact_ids: [fixture.issues[0].id],
    required_action: "Resolve open questions before final export.",
    created_at: "2026-07-09T09:51:00.000Z",
  } satisfies typeof fixture.gate_results[number];
  const warningGate = {
    ...fixture.gate_results[1],
    id: "gate-v1-human-approval-warning",
    status: "warning",
  } satisfies typeof fixture.gate_results[number];

  const evalFixture = createV1EvalCaseFixture({
    matter_id: fixture.matter.id,
    source_run_id: "run-v1-eval-fixture",
    review_comments: [openReview, resolvedReview],
    gate_results: [failedGate, warningGate],
  });
  assert.equal(evalFixture.schema_version, "aletheia-v1-eval-case-fixture-v1");
  assert.deepEqual(evalFixture.source_review_comment_ids, [openReview.id]);
  assert.deepEqual(evalFixture.source_gate_result_ids, [failedGate.id]);
  assert.equal(evalFixture.eval_cases.length, 2);
  assert.deepEqual(
    evalFixture.eval_cases.map((item) => item.failure_type).sort(),
    ["missed_issue", "missed_issue"],
  );
  assert.match(evalFixture.local_only_limitations[0] ?? "", /local contract outputs/);

  const candidate = createSkillCandidateFromEvalCases(evalFixture.eval_cases);
  assert.equal(candidate.approval_status, "candidate");
});
