import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildAuditPack,
  buildFeedbackEvalDataset,
} from "../src/aletheia/exports.ts";
import { legalWorkspace } from "../src/aletheia/mockData.ts";
import {
  defaultReviewStudioState,
  deriveReviewStudioModel,
} from "../src/aletheia/reviewStudio.ts";

test("deriveReviewStudioModel links evidence to issues, risks, red flags, and memo sections", () => {
  const model = deriveReviewStudioModel(
    legalWorkspace,
    defaultReviewStudioState,
  );

  assert.equal(model.issues.length, legalWorkspace.issues.length);
  assert.equal(model.risks.length, legalWorkspace.issues.length);
  assert.ok(model.redFlags.some((flag) => flag.severity === "high"));
  assert.ok(model.obligations.some((item) => item.status === "blocked"));
  assert.ok(model.openQuestions.includes("Actual loss proof"));

  const analysisLink = model.memoLinks.find(
    (link) => link.sectionId === "memo-analysis",
  );
  assert.ok(analysisLink);
  assert.ok(analysisLink.evidenceIds.includes("ev-1"));
  assert.ok(analysisLink.issueIds.includes("claim-breach"));
  assert.ok(analysisLink.riskIds.includes("risk-claim-breach"));

  const missingLink = model.memoLinks.find(
    (link) => link.sectionId === "memo-missing",
  );
  assert.ok(missingLink);
  assert.equal(missingLink.unsupported, true);
  assert.ok(missingLink.issueIds.length > 0);
  assert.ok(missingLink.riskIds.length > 0);
});

test("deriveReviewStudioModel exposes unresolved source-linked review comments", () => {
  const model = deriveReviewStudioModel(
    {
      ...legalWorkspace,
      reviews: [
        ...legalWorkspace.reviews,
        {
          id: "review-memo-analysis",
          matterId: legalWorkspace.matter.id,
          targetType: "memo_section",
          targetId: "memo-analysis",
          tag: "unsupported_claim",
          comment: "Analysis section overstates damages without tying the caveat to loss proof.",
          reviewer: "Senior Reviewer",
          createdAt: "2026-07-08T09:11:00.000Z",
        },
      ],
    },
    {
      ...defaultReviewStudioState,
      finalExportApproved: true,
    },
  );

  const claimComment = model.unresolvedComments.find(
    (comment) => comment.id === "review-1",
  );
  assert.ok(claimComment);
  assert.equal(claimComment.severity, "medium");
  assert.deepEqual(claimComment.sourceEvidenceIds, ["ev-5", "ev-7"]);

  const evidenceComment = model.unresolvedComments.find(
    (comment) => comment.id === "review-2",
  );
  assert.ok(evidenceComment);
  assert.equal(evidenceComment.severity, "high");
  assert.deepEqual(evidenceComment.sourceEvidenceIds, ["ev-7"]);

  const analysisLink = model.memoLinks.find(
    (link) => link.sectionId === "memo-analysis",
  );
  assert.ok(analysisLink);
  assert.deepEqual(analysisLink.unresolvedReviewIds, ["review-memo-analysis"]);
  assert.equal(model.gate.status, "blocked");
  assert.ok(
    model.gate.reasons.some((reason) =>
      reason.includes("Unresolved review on memo_section memo-analysis"),
    ),
  );
});

test("human review actions update risk, gate, review log, and eval records", () => {
  const model = deriveReviewStudioModel(legalWorkspace, {
    ...defaultReviewStudioState,
    evidenceDecisions: {
      "ev-7": "rejected",
    },
    factOverrides: {
      "ev-7": "Demand letter reserves loss proof and does not establish actual loss.",
    },
    riskOverrides: {
      "claim-loss-proof": "high",
    },
    omittedIssueIds: ["claim-notice"],
    supplementalMaterialRequests: ["Request acceptance testing records."],
    finalExportApproved: true,
  });

  assert.equal(
    model.issues.find((issue) => issue.id === "claim-loss-proof")?.riskLevel,
    "high",
  );
  assert.equal(
    model.issues.find((issue) => issue.id === "claim-notice")?.reviewState,
    "blocked",
  );
  assert.ok(
    model.reviewLog.some((entry) => entry.action === "fact_modified"),
  );
  assert.ok(
    model.evalRecords.some((record) => record.failureType === "wrong_risk_level"),
  );
  assert.equal(model.gate.status, "blocked");
  assert.ok(
    model.gate.reasons.some((reason) => reason.includes("Review blocker")),
  );
});

test("audit pack and feedback dataset include review studio review log and eval records", () => {
  const model = deriveReviewStudioModel(legalWorkspace, {
    ...defaultReviewStudioState,
    evidenceDecisions: {
      "ev-7": "rejected",
    },
    factOverrides: {
      "ev-7": "Demand letter reserves loss proof and does not establish actual loss.",
    },
    finalExportApproved: true,
  });

  const auditPack = buildAuditPack(
    legalWorkspace,
    legalWorkspace.reviews,
    legalWorkspace.auditEvents,
    { reviewStudio: model },
  );
  const feedbackDataset = buildFeedbackEvalDataset(
    legalWorkspace,
    legalWorkspace.reviews,
    { reviewStudio: model },
  );

  assert.ok(auditPack.workflow.riskRegister.length > 0);
  assert.ok(auditPack.workflow.redFlagRegister.length > 0);
  assert.ok(auditPack.workflow.draftMemoTraceability.length > 0);
  assert.ok(auditPack.reviewStudioLog.length > 0);
  assert.ok(auditPack.reviewStudioAuditTrail.length > 0);
  assert.ok(auditPack.evalRecords.length > 0);
  assert.ok(feedbackDataset.reviewStudioRecords.length > 0);
  assert.ok(
    feedbackDataset.reviewStudioRecords.some(
      (record) => record.source === "review_studio",
    ),
  );
});
