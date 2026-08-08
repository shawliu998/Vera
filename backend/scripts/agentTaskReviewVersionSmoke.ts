import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  buildAgentReviewVersionState,
  deriveAgentReviewStatus,
} from "../src/lib/agentTaskReviewVersions";
import { approvedArtifactBytesMatch } from "../src/lib/agentTaskReviews";

const memoId = "10000000-0000-4000-8000-000000000001";
const reviewId = "10000000-0000-4000-8000-000000000002";
const memoV1 = "20000000-0000-4000-8000-000000000001";
const memoV2 = "20000000-0000-4000-8000-000000000002";
const exportDocumentId = "30000000-0000-4000-8000-000000000001";
const exportV1 = "40000000-0000-4000-8000-000000000001";
const exportV2 = "40000000-0000-4000-8000-000000000002";
const revisionV1 = "a".repeat(64);
const revisionV2 = "b".repeat(64);

const links = [
  { artifact_type: "draft" as const, artifact_id: memoId, purpose: "Memo" },
  {
    artifact_type: "tabular_review" as const,
    artifact_id: reviewId,
    purpose: "Risk matrix",
  },
];
const versions = [
  [memoV1, memoId, 1, "Memo V1.docx", "docx"],
  [memoV2, memoId, 2, "Memo V2.docx", "docx"],
].map(([id, document_id, version_number, filename, file_type]) => ({
  id: id as string,
  document_id: document_id as string,
  version_number: version_number as number,
  filename: filename as string,
  file_type: file_type as string,
  deleted_at: null,
}));

function digest(value: string) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function approval(input: {
  id: string;
  memoVersionId: string;
  memoVersionNumber: number;
  reviewRevision: string;
  exportVersionId: string;
  exportVersionNumber: number;
}) {
  return {
    id: input.id,
    created_at: "2026-07-21T08:00:00.000Z",
    artifact_snapshot: [
      {
        artifact_type: "draft",
        artifact_id: memoId,
        document_id: memoId,
        purpose: "Memo",
        version_id: input.memoVersionId,
        version_number: input.memoVersionNumber,
        filename: `Memo V${input.memoVersionNumber}.docx`,
        file_type: "docx",
        size_bytes: 7,
        sha256: digest("memo-v1"),
      },
      {
        kind: "agent_approved_tabular_artifact_v1",
        artifact_type: "tabular_review",
        artifact_id: reviewId,
        purpose: "Risk matrix",
        review_id: reviewId,
        row_protocol: "document_rows",
        input_digest: "c".repeat(64),
        revision_fingerprint: input.reviewRevision,
        accepted_view_sha256: `sha256:${"d".repeat(64)}`,
        source_receipt_fingerprint: null,
        decision_fingerprint: null,
        completion_sha256: null,
        export_document_id: exportDocumentId,
        export_version_id: input.exportVersionId,
        version_number: input.exportVersionNumber,
        filename: "Risk matrix - Approved.xlsx",
        file_type: "xlsx",
        size_bytes: 9,
        sha256: digest("matrix-v1"),
      },
    ],
  };
}

function state(
  memoCurrentVersionId: string | null,
  reviewRevision: string | null,
  approved: ReturnType<typeof approval>,
) {
  return buildAgentReviewVersionState(
    links,
    [{ id: memoId, current_version_id: memoCurrentVersionId }],
    versions,
    approved,
    [{ id: reviewId }],
    new Map([[reviewId, reviewRevision]]),
  );
}

function main() {
  const v1 = approval({
    id: "approval-v1",
    memoVersionId: memoV1,
    memoVersionNumber: 1,
    reviewRevision: revisionV1,
    exportVersionId: exportV1,
    exportVersionNumber: 1,
  });
  const exact = state(memoV1, revisionV1, v1);
  assert.equal(exact.has_unapproved_changes, false);
  assert.equal(
    deriveAgentReviewStatus("completed", "approved", exact),
    "approved",
  );

  const wordEdited = state(memoV2, revisionV1, v1);
  assert.equal(wordEdited.current_artifacts[0]?.edited_after_approval, true);
  assert.equal(wordEdited.current_artifacts[1]?.edited_after_approval, false);
  assert.equal(
    deriveAgentReviewStatus("completed", "approved", wordEdited),
    "review_required",
  );

  const bothEdited = state(memoV2, revisionV2, v1);
  assert.equal(
    bothEdited.current_artifacts.filter((item) => item.edited_after_approval)
      .length,
    2,
    "Word Version and Tabular Review revision must be compared independently",
  );
  assert.equal(
    deriveAgentReviewStatus("completed", "changes_requested", bothEdited),
    "changes_requested",
  );

  const v2Approval = approval({
    id: "approval-v2",
    memoVersionId: memoV2,
    memoVersionNumber: 2,
    reviewRevision: revisionV2,
    exportVersionId: exportV2,
    exportVersionNumber: 2,
  });
  const v2 = state(memoV2, revisionV2, v2Approval);
  assert.equal(v2.has_unapproved_changes, false);
  assert.equal(
    deriveAgentReviewStatus("completed", "approved", v2),
    "approved",
  );

  const missing = state("50000000-0000-4000-8000-000000000099", revisionV1, v1);
  assert.equal(missing.current_artifacts[0]?.current_version_available, false);
  assert.equal(missing.has_unapproved_changes, true);

  const legacy = buildAgentReviewVersionState(
    links,
    [{ id: memoId, current_version_id: memoV1 }],
    versions,
    {
      ...v1,
      artifact_snapshot: [
        v1.artifact_snapshot[0],
        {
          artifact_type: "tabular_review",
          artifact_id: reviewId,
          purpose: "Risk matrix",
          review_id: reviewId,
          row_protocol: "document_rows",
          input_digest: "c".repeat(64),
          revision_fingerprint: revisionV1,
        },
      ],
    },
    [{ id: reviewId }],
    new Map([[reviewId, revisionV1]]),
  );
  assert.equal(
    legacy.current_artifacts[1]?.approved_snapshot_state,
    "legacy_tabular",
  );
  assert.equal(legacy.current_artifacts[1]?.review_current_required, true);

  const lockedV1 = v1.artifact_snapshot[0]!;
  assert.equal(
    approvedArtifactBytesMatch(lockedV1, Buffer.from("memo-v1")),
    true,
  );
  assert.equal(
    approvedArtifactBytesMatch(lockedV1, Buffer.from("memo-v2")),
    false,
    "V2 bytes must not pass the locked V1 hash",
  );

  console.log(
    JSON.stringify(
      { ok: true, suite: "agent-task-review-version-smoke-v2" },
      null,
      2,
    ),
  );
}

main();
