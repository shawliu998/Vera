import assert from "node:assert/strict";
import { test } from "node:test";
import {
  calculateCitationCoverage,
  canExportFinal,
  findUnsupportedClaims,
  hasMissingMaterials,
  hasUnresolvedReviewComments,
  runGates,
} from "../../src/aletheia/agentops/gates.ts";
import type {
  DraftMemo,
  EvidenceItem,
  IssueNode,
  Matter,
  ReviewComment,
  RiskItem,
} from "../../src/aletheia/agentops/types.ts";

const now = "2026-07-09T09:00:00.000Z";

const matter = {
  id: "matter-gate-test",
  title: "High Risk Export Review",
  type: "legal_review",
  risk_level: "high",
  status: "review_needed",
  documents: [
    {
      id: "doc-contract",
      matter_id: "matter-gate-test",
      title: "Contract",
      document_type: "contract",
      status: "indexed",
      uploaded_at: now,
    },
  ],
  created_at: now,
  updated_at: now,
} satisfies Matter;

const evidence = [
  {
    id: "ev-notice",
    matter_id: matter.id,
    source_document_id: "doc-contract",
    quote: "Notice must be provided within 48 hours.",
    normalized_fact: "The contract has a 48-hour notice requirement.",
    supports_claim_ids: ["claim-notice"],
    confidence: 0.9,
    review_status: "approved",
  },
] satisfies EvidenceItem[];

const supportedMemo = {
  id: "memo-supported",
  matter_id: matter.id,
  title: "Supported Memo",
  sections: [
    {
      id: "section-standard",
      title: "Standard",
      body: "The applicable notice standard is sourced.",
      evidence_reference_ids: ["ev-notice"],
    },
  ],
  citation_coverage_score: 1,
  unsupported_claim_count: 0,
  review_status: "approved",
  gate_status: "passed",
} satisfies DraftMemo;

const issues = [
  {
    id: "issue-notice",
    matter_id: matter.id,
    title: "Notice timing",
    description: "Whether notice was timely.",
    legal_or_professional_standard: "Contractual notice obligations.",
    related_evidence_ids: ["ev-notice"],
    open_questions: [],
    risk_level: "high",
    review_status: "approved",
  },
] satisfies IssueNode[];

const risks = [
  {
    id: "risk-notice",
    matter_id: matter.id,
    title: "Late notice",
    description: "Potential late notice exposure.",
    severity: "high",
    likelihood: "medium",
    related_issue_ids: ["issue-notice"],
    related_evidence_ids: ["ev-notice"],
    recommendation: "Confirm final position with reviewer.",
    status: "mitigating",
  },
] satisfies RiskItem[];

test("calculateCitationCoverage and findUnsupportedClaims flag uncited memo sections", () => {
  const memo = {
    ...supportedMemo,
    sections: [
      ...supportedMemo.sections,
      {
        id: "section-gap",
        title: "Gap",
        body: "This final conclusion lacks support.",
        evidence_reference_ids: [],
        unsupported_claim_count: 2,
      },
    ],
  } satisfies DraftMemo;

  assert.equal(calculateCitationCoverage(memo, evidence).citation_coverage_score, 0.5);
  assert.deepEqual(
    findUnsupportedClaims(memo, evidence).map((claim) => claim.section_id),
    ["section-gap"],
  );
});

test("review and missing material helpers expose unresolved blockers", () => {
  const comments = [
    {
      id: "comment-open",
      matter_id: matter.id,
      artifact_id: "memo-supported",
      artifact_type: "draft_memo",
      author: "Expert",
      comment: "Resolve before final.",
      severity: "high",
      status: "open",
      created_at: now,
    },
  ] satisfies ReviewComment[];
  const issuesWithQuestion = [
    { ...issues[0], open_questions: ["Obtain the final notice timestamp."] },
  ];

  assert.equal(hasUnresolvedReviewComments(comments, ["memo-supported"]), true);
  assert.equal(
    hasMissingMaterials({ matter, issues: issuesWithQuestion, risks })
      .hasMissingMaterials,
    true,
  );
});

test("runGates blocks high-risk final export until human approval and critical gates pass", () => {
  const gates = runGates({
    matter,
    draftMemo: { ...supportedMemo, review_status: "pending" },
    evidence,
    issues,
    risks,
    reviewComments: [],
    exportIntent: "final",
    now,
  });

  assert.equal(
    gates.find((gate) => gate.gate_type === "human_approval")?.status,
    "failed",
  );
  assert.equal(canExportFinal(gates), false);
});

test("runGates allows approved high-risk final export with warnings only", () => {
  const gates = runGates({
    matter,
    draftMemo: supportedMemo,
    evidence,
    issues,
    risks,
    reviewComments: [
      {
        id: "comment-privilege",
        matter_id: matter.id,
        artifact_id: "memo-supported",
        artifact_type: "draft_memo",
        author: "Expert",
        comment: "Contains confidential business terms.",
        severity: "medium",
        status: "resolved",
        created_at: now,
      },
    ],
    exportIntent: "final",
    humanApproved: true,
    now,
  });

  assert.equal(
    gates.find((gate) => gate.gate_type === "privilege")?.status,
    "warning",
  );
  assert.equal(canExportFinal(gates), true);
});

test("final export fails closed while draft export remains available when a critical gate fails", () => {
  const unsupportedMemo = {
    ...supportedMemo,
    sections: [
      ...supportedMemo.sections,
      {
        id: "section-unsupported-final",
        title: "Unsupported Final Conclusion",
        body: "This final conclusion has no attached evidence.",
        evidence_reference_ids: [],
      },
    ],
  } satisfies DraftMemo;
  const draftGates = runGates({
    matter,
    draftMemo: unsupportedMemo,
    evidence,
    issues,
    risks,
    reviewComments: [],
    exportIntent: "draft",
    humanApproved: true,
    now,
  });
  const finalGates = runGates({
    matter,
    draftMemo: unsupportedMemo,
    evidence,
    issues,
    risks,
    reviewComments: [],
    exportIntent: "final",
    humanApproved: true,
    now,
  });

  assert.equal(
    draftGates.find((gate) => gate.gate_type === "citation")?.status,
    "failed",
  );
  assert.equal(
    draftGates.find((gate) => gate.gate_type === "export")?.status,
    "passed",
  );
  assert.equal(canExportFinal(draftGates), false);
  assert.equal(
    finalGates.find((gate) => gate.gate_type === "citation")?.status,
    "failed",
  );
  assert.equal(
    finalGates.find((gate) => gate.gate_type === "export")?.status,
    "failed",
  );
  assert.equal(canExportFinal(finalGates), false);
});
