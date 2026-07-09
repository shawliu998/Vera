import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildTypedHandoffProvenance,
  evaluateTypedHandoffReadiness,
  sampleAgentOpsWorkspace,
  validateWorkspaceReferences,
} from "../../src/aletheia/agentops";
import type { GateProvenance } from "../../src/aletheia/agentops";
import type { AgentOpsMatterWorkspace } from "../../src/aletheia/agentops/types";

test("validateWorkspaceReferences accepts the sample typed handoff workspace", () => {
  const result = validateWorkspaceReferences(sampleAgentOpsWorkspace);

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.ok(
    result.warnings.some((warning) =>
      warning.includes("supports claim without issue node issue-customer-impact"),
    ),
  );
});

test("validateWorkspaceReferences catches broken cross-artifact links", () => {
  const brokenWorkspace: AgentOpsMatterWorkspace = {
    ...sampleAgentOpsWorkspace,
    evidence: [
      {
        ...sampleAgentOpsWorkspace.evidence[0],
        source_document_id: "missing-document",
        created_by_run_id: "missing-run",
      },
    ],
    issues: [
      {
        ...sampleAgentOpsWorkspace.issues[0],
        related_evidence_ids: ["missing-evidence"],
      },
    ],
    risks: [
      {
        ...sampleAgentOpsWorkspace.risks[0],
        related_issue_ids: ["missing-issue"],
        related_evidence_ids: ["missing-evidence"],
      },
    ],
    draft_memos: [
      {
        ...sampleAgentOpsWorkspace.draft_memos[0],
        sections: [
          {
            ...sampleAgentOpsWorkspace.draft_memos[0].sections[0],
            evidence_reference_ids: ["missing-evidence"],
            issue_reference_ids: ["missing-issue"],
          },
        ],
      },
    ],
    review_comments: [
      {
        ...sampleAgentOpsWorkspace.review_comments[0],
        artifact_id: "missing-memo-section",
      },
    ],
    gate_results: [
      {
        ...sampleAgentOpsWorkspace.gate_results[0],
        affected_artifact_ids: ["missing-gated-artifact"],
      },
    ],
    audit_events: [
      {
        ...sampleAgentOpsWorkspace.audit_events[0],
        artifact_id: "missing-audit-artifact",
      },
    ],
    eval_cases: [
      {
        ...sampleAgentOpsWorkspace.eval_cases[0],
        source_run_id: "missing-source-run",
      },
    ],
    skills: [
      {
        ...sampleAgentOpsWorkspace.skills[0],
        created_from_eval_case_ids: ["missing-eval-case"],
      },
    ],
  };

  const result = validateWorkspaceReferences(brokenWorkspace);

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("missing-document")));
  assert.ok(result.errors.some((error) => error.includes("missing-run")));
  assert.ok(result.errors.some((error) => error.includes("missing-evidence")));
  assert.ok(result.errors.some((error) => error.includes("missing-issue")));
  assert.ok(result.errors.some((error) => error.includes("missing-memo-section")));
  assert.ok(result.errors.some((error) => error.includes("missing-gated-artifact")));
  assert.ok(result.errors.some((error) => error.includes("missing-audit-artifact")));
  assert.ok(result.errors.some((error) => error.includes("missing-source-run")));
  assert.ok(result.errors.some((error) => error.includes("missing-eval-case")));
});

test("buildTypedHandoffProvenance preserves handoff source IDs", () => {
  const provenance = buildTypedHandoffProvenance(sampleAgentOpsWorkspace);
  const memoSection = provenance.find((item) => item.artifactId === "memo-standard");
  const evalCase = provenance.find(
    (item) => item.artifactType === "eval_case" && item.sourceRecordIds.reviewItemIds.length > 0,
  );

  assert.ok(memoSection);
  assert.equal(memoSection.artifactType, "draft_memo");
  assert.deepEqual(memoSection.sourceRecordIds.evidenceItemIds, [
    "evidence-notice-window",
  ]);
  assert.deepEqual(memoSection.sourceRecordIds.issueNodeIds, [
    "issue-notice-timing",
  ]);
  assert.ok(memoSection.sourceRecordIds.workProductIds.includes("memo-standard"));

  assert.ok(evalCase);
  assert.ok(evalCase.sourceRecordIds.agentRunIds.length > 0);
  assert.ok(evalCase.sourceRecordIds.reviewItemIds.includes("review-comment-open-items"));
});

test("buildTypedHandoffProvenance surfaces gate checkpoints and Big @ blockers", () => {
  const workspace: AgentOpsMatterWorkspace = {
    ...sampleAgentOpsWorkspace,
    draft_memos: [
      {
        ...sampleAgentOpsWorkspace.draft_memos[0],
        sections: [
          {
            ...sampleAgentOpsWorkspace.draft_memos[0].sections[0],
            big_at_resolution_records: [
              {
                raw: "@Evidence:missing",
                type: "Evidence",
                status: "missing",
                resolved_artifact_refs: [],
              },
              {
                raw: "@Document.pdf",
                type: "Document",
                status: "ambiguous",
                resolved_artifact_refs: [],
                candidate_artifact_refs: [
                  { id: "doc-master-services-agreement", type: "document" },
                ],
              },
            ],
          },
        ],
      },
    ],
    gate_results: [
      ...sampleAgentOpsWorkspace.gate_results,
      {
        id: "gate-checkpoint-final-review",
        matter_id: sampleAgentOpsWorkspace.matter.id,
        gate_type: "human_approval",
        status: "failed",
        reason: "Final review checkpoint remains open.",
        affected_artifact_ids: [sampleAgentOpsWorkspace.draft_memos[0].id],
        required_action: "Resolve checkpoint before export.",
        created_at: "2026-07-09T10:00:00.000Z",
      },
    ],
  };

  const provenance = buildTypedHandoffProvenance(workspace);
  const memo = provenance.find(
    (item) => item.artifactId === sampleAgentOpsWorkspace.draft_memos[0].id,
  );

  assert.ok(memo);
  assert.ok(memo.gateResultIds.includes("gate-checkpoint-final-review"));
  assert.ok(memo.sourceRecordIds.checkpointIds.includes("final-review"));
  assert.ok(memo.unresolvedReferenceIds.includes("@Evidence:missing"));
  assert.ok(memo.ambiguousReferenceIds.includes("@Document.pdf"));
});

test("buildTypedHandoffProvenance folds read-only gate provenance into source IDs", () => {
  const provenance = buildTypedHandoffProvenance(sampleAgentOpsWorkspace, {
    gateProvenance: [
      {
        gateId: "gate-human-approval",
        gateType: "human_approval",
        status: "failed",
        sourceType: "human_checkpoint",
        sourceId: "checkpoint-final",
        sourceStatus: "open",
        relatedWorkProductIds: [sampleAgentOpsWorkspace.draft_memos[0].id],
        relatedReviewIds: ["review-comment-open-items"],
        relatedAuditEventIds: ["audit-memo-generated"],
      },
    ],
  });
  const memo = provenance.find(
    (item) => item.artifactId === sampleAgentOpsWorkspace.draft_memos[0].id,
  );

  assert.ok(memo);
  assert.ok(memo.gateResultIds.includes("gate-human-approval"));
  assert.ok(memo.sourceRecordIds.checkpointIds.includes("checkpoint-final"));
  assert.ok(memo.sourceRecordIds.reviewItemIds.includes("review-comment-open-items"));
  assert.ok(memo.sourceRecordIds.auditEventIds.includes("audit-memo-generated"));
});

test("buildTypedHandoffProvenance warns when gate provenance has no persisted source", () => {
  const provenance = buildTypedHandoffProvenance(sampleAgentOpsWorkspace, {
    gateProvenance: [
      {
        gateId: "gate-human-approval",
        gateType: "human_approval",
        status: "failed",
        sourceType: "unknown",
        sourceId: null,
        sourceStatus: "missing",
        relatedWorkProductIds: [sampleAgentOpsWorkspace.draft_memos[0].id],
        relatedReviewIds: [],
        relatedAuditEventIds: [],
      },
    ],
  });
  const memo = provenance.find(
    (item) => item.artifactId === sampleAgentOpsWorkspace.draft_memos[0].id,
  );

  assert.ok(memo);
  assert.ok(
    memo.warnings.includes(
      "gate-human-approval lacks persisted gate provenance source",
    ),
  );
});

test("buildTypedHandoffProvenance carries adapter gate source records into handoff IDs", () => {
  const gateProvenance: GateProvenance[] = [
    {
      gateId: "gate-human-approval",
      gateType: "human_approval",
      status: "failed",
      sourceType: "human_checkpoint",
      sourceId: "checkpoint-final-approval",
      sourceStatus: "open",
      relatedWorkProductIds: ["draft-memo-vendor-security-breach"],
      relatedReviewIds: ["review-comment-open-items"],
      relatedAuditEventIds: ["audit-memo-generated"],
    },
  ];

  const provenance = buildTypedHandoffProvenance(sampleAgentOpsWorkspace, {
    gateProvenance,
  });
  const memo = provenance.find(
    (item) => item.artifactId === "draft-memo-vendor-security-breach",
  );
  const openItems = provenance.find((item) => item.artifactId === "memo-open-items");

  assert.ok(memo);
  assert.ok(memo.gateResultIds.includes("gate-human-approval"));
  assert.ok(memo.sourceRecordIds.checkpointIds.includes("checkpoint-final-approval"));
  assert.ok(memo.sourceRecordIds.reviewItemIds.includes("review-comment-open-items"));
  assert.ok(memo.sourceRecordIds.auditEventIds.includes("audit-memo-generated"));

  assert.ok(openItems);
  assert.ok(openItems.sourceRecordIds.checkpointIds.includes("checkpoint-final-approval"));
  assert.ok(openItems.sourceRecordIds.reviewItemIds.includes("review-comment-open-items"));
  assert.ok(openItems.sourceRecordIds.auditEventIds.includes("audit-memo-generated"));
});

test("evaluateTypedHandoffReadiness summarizes a ready preview chain with warnings", () => {
  const readiness = evaluateTypedHandoffReadiness(sampleAgentOpsWorkspace);

  assert.equal(readiness.status, "ready");
  assert.equal(readiness.artifactCounts.documents, 3);
  assert.equal(readiness.artifactCounts.evidenceItems, 3);
  assert.equal(readiness.artifactCounts.issues, 2);
  assert.equal(readiness.artifactCounts.risks, 2);
  assert.equal(readiness.artifactCounts.draftMemoSections, 4);
  assert.equal(readiness.blockers.length, 0);
  assert.ok(
    readiness.warnings.some((warning) =>
      warning.includes("supports claim without issue node issue-customer-impact"),
    ),
  );
});

test("evaluateTypedHandoffReadiness blocks missing references and unbacked gates", () => {
  const workspace: AgentOpsMatterWorkspace = {
    ...sampleAgentOpsWorkspace,
    draft_memos: [
      {
        ...sampleAgentOpsWorkspace.draft_memos[0],
        sections: [
          {
            ...sampleAgentOpsWorkspace.draft_memos[0].sections[0],
            big_at_resolution_records: [
              {
                raw: "@Evidence:missing",
                type: "Evidence",
                status: "missing",
                resolved_artifact_refs: [],
              },
            ],
          },
        ],
      },
    ],
  };

  const readiness = evaluateTypedHandoffReadiness(workspace, {
    gateProvenance: [
      {
        gateId: "gate-human-approval",
        gateType: "human_approval",
        status: "failed",
        sourceType: "unknown",
        sourceId: null,
        sourceStatus: "missing",
        relatedWorkProductIds: [sampleAgentOpsWorkspace.draft_memos[0].id],
        relatedReviewIds: [],
        relatedAuditEventIds: [],
      },
    ],
  });

  assert.equal(readiness.status, "blocked");
  assert.ok(
    readiness.blockers.some((blocker) =>
      blocker.includes("has unresolved reference @Evidence:missing"),
    ),
  );
  assert.ok(
    readiness.blockers.some((blocker) =>
      blocker.includes("lacks persisted gate provenance source"),
    ),
  );
});
