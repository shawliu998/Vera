import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildFinalMemoApprovalRequestedPayload,
  buildFinalMemoGateSnapshotContent,
} from "../../src/aletheia/agentops/finalMemoApprovalPayload.ts";
import {
  buildFeedbackDataset,
  buildFinalMemoGateInput,
} from "../../src/aletheia/remoteMatterTransforms.ts";
import {
  calculateCitationCoverage,
  canExportFinal,
  findUnsupportedClaims,
  hasMissingMaterials,
  isApprovalResolvableFinalExportGate,
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
import type { AletheiaMatterDetail } from "../../src/app/lib/aletheiaApi.ts";

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

test("Remote Matter gate input preserves source-linked review comment anchors", () => {
  const draftMemo = {
    id: "wp-remote-memo",
    matter_id: matter.id,
    user_id: "user-test",
    kind: "draft_memo",
    title: "Remote Draft Memo",
    status: "needs_review",
    schema_version: "aletheia-draft-memo-v0",
    content: {
      title: "Remote Draft Memo",
      sections: [
        {
          id: "section-standard",
          title: "Standard",
          body: ["The applicable notice standard is sourced."],
          evidenceIds: ["ev-notice"],
          unsupported_claim_count: 0,
        },
      ],
    },
    validation_errors: [],
    generated_by: "agent",
    model: "deterministic-local",
    created_at: now,
    updated_at: now,
  } satisfies AletheiaMatterDetail["workProducts"][number];
  const detail = {
    matter: {
      id: matter.id,
      user_id: "user-test",
      title: matter.title,
      template: "legal_matter_review",
      status: "needs_review",
      client_or_project: "Client",
      objective: "Check review comment anchors.",
      risk_level: matter.risk_level,
      source_project_id: null,
      shared_with: [],
      metadata: {},
      created_at: now,
      updated_at: now,
    },
    documents: [],
    workProducts: [draftMemo],
    evidence: [
      {
        id: "ev-notice",
        matter_id: matter.id,
        work_product_id: draftMemo.id,
        document_id: "doc-contract",
        source_chunk_id: "chunk-notice",
        claim_id: "claim-notice",
        document_name: "Contract",
        page: 1,
        section: "Notice",
        quote: "Notice must be provided within 48 hours.",
        quote_start: 0,
        quote_end: 44,
        relevance: "direct",
        support_status: "supports",
        confidence: "high",
        metadata: {},
        created_at: now,
      },
    ],
    reviews: [
      {
        id: "review-section-source",
        matter_id: matter.id,
        work_product_id: draftMemo.id,
        evidence_item_id: "ev-notice",
        target_type: "memo_section",
        target_id: "section-standard",
        tag: "citation_not_supporting",
        comment: "Verify the memo section citation before final export.",
        reviewer_user_id: "reviewer-1",
        reviewer_name: "Expert Reviewer",
        created_at: now,
      },
    ],
    auditEvents: [],
    agentRuns: [],
    matterMemory: [],
    playbooks: [],
  } satisfies AletheiaMatterDetail;

  const gateInput = buildFinalMemoGateInput({
    detail,
    draftMemo,
    issueMap: null,
    exportIntent: "final",
    humanApproved: false,
  });
  const comment = gateInput.reviewComments[0];

  assert.equal(comment?.artifact_type, "draft_memo");
  assert.equal(comment?.target_type, "memo_section");
  assert.equal(comment?.target_id, "section-standard");
  assert.equal(comment?.tag, "citation_not_supporting");
  assert.equal(comment?.work_product_id, draftMemo.id);
  assert.equal(comment?.evidence_item_id, "ev-notice");
  assert.deepEqual(comment?.referenced_artifacts, [
    {
      id: "section-standard",
      type: "draft_memo",
      title: "memo_section:section-standard",
    },
    {
      id: "ev-notice",
      type: "evidence_item",
      title: "evidence:ev-notice",
    },
  ]);

  const feedbackDataset = buildFeedbackDataset(detail);
  const v1EvalCaseFixture = feedbackDataset.v1EvalCaseFixture as {
    schema_version: string;
    source_review_comment_ids: string[];
    source_gate_result_ids: string[];
    eval_cases: { source_run_id: string }[];
    local_only_limitations: string[];
  };
  assert.equal(
    v1EvalCaseFixture.schema_version,
    "aletheia-v1-eval-case-fixture-v1",
  );
  assert.deepEqual(v1EvalCaseFixture.source_review_comment_ids, [
    "review-section-source",
  ]);
  assert.deepEqual(v1EvalCaseFixture.source_gate_result_ids, []);
  assert.equal(v1EvalCaseFixture.eval_cases[0]?.source_run_id, "run-unavailable");
  assert.ok(
    v1EvalCaseFixture.local_only_limitations.some((limitation) =>
      limitation.includes("durable review-resolution status"),
    ),
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

test("runGates blocks unapproved final export when external sources are present", () => {
  const gates = runGates({
    matter: {
      ...matter,
      risk_level: "medium",
      documents: [
        {
          ...matter.documents[0],
          source_uri: "https://example.com/public-filing",
        },
      ],
    },
    draftMemo: { ...supportedMemo, review_status: "pending" },
    evidence: [
      {
        ...evidence[0],
        metadata: {
          externalSource: true,
          source_url: "https://example.com/public-filing",
        },
      },
    ],
    issues,
    risks,
    reviewComments: [],
    exportIntent: "final",
    now,
  });

  assert.equal(
    gates.find((gate) => gate.gate_type === "external_source")?.status,
    "failed",
  );
  assert.equal(
    gates.some(
      (gate) =>
        gate.gate_type === "external_source" &&
        isApprovalResolvableFinalExportGate(gate),
    ),
    true,
  );
  assert.equal(canExportFinal(gates), false);
});

test("final memo approval payload carries persisted gate snapshot audit id", () => {
  const gates = runGates({
    matter: {
      ...matter,
      risk_level: "medium",
      documents: [
        {
          ...matter.documents[0],
          source_uri: "https://example.com/public-filing",
        },
      ],
    },
    draftMemo: { ...supportedMemo, review_status: "pending" },
    evidence: [
      {
        ...evidence[0],
        metadata: { externalSource: true },
      },
    ],
    issues,
    risks,
    reviewComments: [],
    exportIntent: "final",
    now,
  });
  const snapshotContent = buildFinalMemoGateSnapshotContent({
    matterTitle: matter.title,
    sourceDraftMemoId: supportedMemo.id,
    gateSummary: {
      failed: gates.filter((gate) => gate.status === "failed").length,
    },
    gateResults: gates,
    gateProvenance: [
      {
        gate_id: "gate-matter-gate-test-external_source",
        source_record_refs: [{ type: "document", id: "doc-contract" }],
      },
    ],
  });
  const requestedPayload = buildFinalMemoApprovalRequestedPayload({
    gateSnapshotContent: snapshotContent,
    gateSnapshotAuditEventId: "audit-gate-snapshot-external-source",
  });

  assert.equal(canExportFinal(gates), false);
  assert.equal(
    requestedPayload.gateSnapshotAuditEventId,
    "audit-gate-snapshot-external-source",
  );
  assert.equal(requestedPayload.workProductKind, "final_memo");
  assert.ok(
    requestedPayload.gateResults.some(
      (gate) => gate.gate_type === "external_source" && gate.status === "failed",
    ),
  );
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
