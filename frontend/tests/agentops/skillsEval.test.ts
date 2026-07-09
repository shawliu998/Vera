import assert from "node:assert/strict";
import { test } from "node:test";
import { computeProfessionalEvalMetrics } from "../../src/lib/agentops/eval";
import {
  mapSkillsToPlaybookApprovalState,
  suggestProfessionalSkillCandidates,
} from "../../src/lib/agentops/skills";
import type {
  DraftMemo,
  EvalCase,
  GateResult,
  IssueNode,
  ProfessionalSkill,
  ReviewComment,
} from "../../src/aletheia/agentops/types";

const now = "2026-07-09T09:00:00.000Z";

const memo = {
  id: "memo-skills-eval",
  matter_id: "matter-skills-eval",
  title: "Skills Eval Memo",
  sections: [
    {
      id: "section-supported",
      title: "Supported",
      body: "This section is grounded.",
      evidence_reference_ids: ["ev-1"],
      unsupported_claim_count: 0,
    },
    {
      id: "section-gap",
      title: "Open Gap",
      body: "This section needs a source.",
      evidence_reference_ids: [],
      unsupported_claim_count: 2,
    },
  ],
  citation_coverage_score: 0,
  unsupported_claim_count: 2,
  review_status: "pending",
  gate_status: "failed",
} satisfies DraftMemo;

const reviewComments = [
  {
    id: "review-citation",
    matter_id: memo.matter_id,
    artifact_id: memo.id,
    artifact_type: "draft_memo",
    author: "Expert Reviewer",
    comment: "Add a citation before relying on this section.",
    severity: "high",
    status: "open",
    created_at: now,
  },
] satisfies ReviewComment[];

const gateResults = [
  {
    id: "gate-citation",
    matter_id: memo.matter_id,
    gate_type: "citation",
    status: "failed",
    reason: "One section lacks evidence.",
    affected_artifact_ids: [memo.id],
    required_action: "Add evidence or mark as an open item.",
    created_at: now,
  },
] satisfies GateResult[];

const evalCases = [
  {
    id: "eval-missing-citation-a",
    matter_id: memo.matter_id,
    source_run_id: "run-eval",
    failure_type: "missing_citation",
    input_snapshot: { section_id: "section-gap" },
    expected_behavior: "Uncited memo sections must remain blocked.",
    expert_feedback: "The section needs a source.",
    status: "open",
  },
  {
    id: "eval-human-override",
    matter_id: memo.matter_id,
    source_run_id: "run-review",
    failure_type: "expert_override",
    input_snapshot: { artifact_id: memo.id },
    expected_behavior: "Expert overrides must remain auditable.",
    expert_feedback: "Reviewer blocked export.",
    status: "triaged",
  },
] satisfies EvalCase[];

const issues = [
  {
    id: "issue-covered",
    matter_id: memo.matter_id,
    title: "Covered Issue",
    description: "Has evidence.",
    legal_or_professional_standard: "Source-linked professional review.",
    related_evidence_ids: ["ev-1"],
    open_questions: [],
    risk_level: "medium",
    review_status: "pending",
  },
  {
    id: "issue-open",
    matter_id: memo.matter_id,
    title: "Open Issue",
    description: "Has an open question.",
    legal_or_professional_standard: "Source-linked professional review.",
    related_evidence_ids: [],
    open_questions: ["Find source support."],
    risk_level: "high",
    review_status: "needs_revision",
  },
] satisfies IssueNode[];

test("computeProfessionalEvalMetrics returns deterministic professional review metrics", () => {
  const metrics = computeProfessionalEvalMetrics({
    draft_memos: [memo],
    review_comments: reviewComments,
    gate_results: gateResults,
    eval_cases: evalCases,
    issues,
  });

  assert.equal(metrics.citation_coverage, 0.5);
  assert.equal(metrics.unsupported_claim_count, 2);
  assert.equal(metrics.unresolved_review_comments, 1);
  assert.equal(metrics.human_override_count, 1);
  assert.equal(metrics.gate_failure_count, 1);
  assert.deepEqual(metrics.issue_coverage, {
    covered_issue_count: 2,
    total_issue_count: 2,
    score: 1,
  });
});

test("suggestProfessionalSkillCandidates never auto-approves repeated feedback", () => {
  const candidates = suggestProfessionalSkillCandidates(
    {
      eval_cases: evalCases,
      review_comments: reviewComments,
      gate_results: gateResults,
    },
    {
      matter_id: memo.matter_id,
      min_occurrences: 2,
    },
  );

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.name, "Missing citation remediation gate");
  assert.equal(candidates[0]?.approval_status, "candidate");
  assert.deepEqual(candidates[0]?.created_from_eval_case_ids, [
    "eval-missing-citation-a",
  ]);
});

test("mapSkillsToPlaybookApprovalState only activates human-approved playbook skills", () => {
  const skills = [
    {
      id: "skill-candidate",
      name: "Candidate Citation Skill",
      description: "Candidate only.",
      trigger_conditions: ["failure_type == missing_citation"],
      required_inputs: ["draft_memo"],
      expected_outputs: ["review_comment"],
      evidence_requirements: ["Preserve source evidence IDs."],
      approval_status: "candidate",
      created_from_eval_case_ids: ["eval-missing-citation-a"],
      version: "0.1.0",
    },
    {
      id: "skill-approved",
      name: "Approved Export Gate Skill",
      description: "Approved by a reviewer.",
      trigger_conditions: ["action == export"],
      required_inputs: ["draft_memo", "gate_result"],
      expected_outputs: ["gate_result"],
      evidence_requirements: ["Preserve approval checkpoint IDs."],
      approval_status: "approved",
      created_from_eval_case_ids: ["eval-human-override"],
      version: "1.0.0",
    },
  ] satisfies ProfessionalSkill[];

  const states = mapSkillsToPlaybookApprovalState(skills, [
    {
      id: "playbook-approved",
      status: "approved",
      approved_by: "reviewer-1",
      approved_at: now,
      content: { professionalSkillId: "skill-approved" },
    },
  ]);

  assert.equal(states[0]?.active, false);
  assert.equal(states[0]?.requires_human_approval, true);
  assert.match(states[0]?.warnings[0] ?? "", /Candidate skills are inactive/);

  assert.equal(states[1]?.active, true);
  assert.equal(states[1]?.requires_human_approval, false);
  assert.equal(states[1]?.playbook_id, "playbook-approved");
  assert.deepEqual(states[1]?.warnings, []);
});
