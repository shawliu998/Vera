import assert from "node:assert/strict";
import test from "node:test";

import {
  APPROVED_TABULAR_ARTIFACT_SNAPSHOT_KIND,
  readApprovedArtifactSnapshot,
  verifiedTabularArtifactIdentitySchema,
} from "./agentApprovedArtifactSnapshot";
import { assertLitigationVerifiedTabularArtifact } from "./agent-packs/litigation/litigationEvidenceInventoryVerifiedArtifact";

const reviewId = "11111111-1111-4111-8111-111111111111";

test("new approved Tabular snapshots require one fixed exported xlsx identity", () => {
  const input = {
    kind: APPROVED_TABULAR_ARTIFACT_SNAPSHOT_KIND,
    artifact_type: "tabular_review",
    artifact_id: reviewId,
    purpose: "Evidence inventory",
    review_id: reviewId,
    row_protocol: "document_rows",
    input_digest: "a".repeat(64),
    revision_fingerprint: "b".repeat(64),
    accepted_view_sha256: `sha256:${"c".repeat(64)}`,
    source_receipt_fingerprint: "d".repeat(64),
    decision_fingerprint: "e".repeat(64),
    completion_sha256: `sha256:${"f".repeat(64)}`,
    export_document_id: "22222222-2222-4222-8222-222222222222",
    export_version_id: "33333333-3333-4333-8333-333333333333",
    version_number: 1,
    filename: "Evidence inventory.xlsx",
    file_type: "xlsx",
    size_bytes: 42,
    sha256: `sha256:${"0".repeat(64)}`,
  };
  const result = readApprovedArtifactSnapshot(input);
  assert.equal(result.state, "current");
  assert.equal(
    readApprovedArtifactSnapshot({ ...input, purpose: "  " }).state,
    "invalid",
  );
  assert.equal(
    readApprovedArtifactSnapshot({ ...input, purpose: "x".repeat(301) }).state,
    "invalid",
  );
  assert.equal(
    readApprovedArtifactSnapshot({ ...input, size_bytes: 0 }).state,
    "invalid",
  );
  assert.equal(
    readApprovedArtifactSnapshot({ ...input, size_bytes: 100 * 1024 * 1024 + 1 })
      .state,
    "invalid",
  );
});

test("the old seven-field Tabular snapshot is readable but explicitly legacy", () => {
  const result = readApprovedArtifactSnapshot({
    artifact_type: "tabular_review",
    artifact_id: reviewId,
    purpose: "Evidence inventory",
    review_id: reviewId,
    row_protocol: "document_rows",
    input_digest: "a".repeat(64),
    revision_fingerprint: "b".repeat(64),
  });
  assert.equal(result.state, "legacy_tabular");
});

test("Litigation verified identities require current completion provenance", () => {
  const identity = verifiedTabularArtifactIdentitySchema.parse({
    kind: "agent_verified_tabular_artifact_v1",
    review_id: reviewId,
    row_protocol: "document_rows",
    input_digest: "a".repeat(64),
    revision_fingerprint: "b".repeat(64),
    accepted_view_sha256: `sha256:${"c".repeat(64)}`,
    source_receipt_fingerprint: null,
    decision_fingerprint: null,
    completion_sha256: null,
  });
  assert.throws(() => assertLitigationVerifiedTabularArtifact(identity));
});
