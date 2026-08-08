import assert from "node:assert/strict";
import test from "node:test";

import { approvedDocumentVersionPairs } from "./agentTasks";

test("document-version drift checks ignore approved Tabular Review snapshots", () => {
  assert.deepEqual(
    approvedDocumentVersionPairs([
      {
        artifact_type: "draft",
        document_id: "11111111-1111-4111-8111-111111111111",
        version_id: "22222222-2222-4222-8222-222222222222",
      },
      {
        artifact_type: "tabular_review",
        artifact_id: "33333333-3333-4333-8333-333333333333",
        review_id: "33333333-3333-4333-8333-333333333333",
        revision_fingerprint: "a".repeat(64),
      },
    ]),
    [
      {
        documentId: "11111111-1111-4111-8111-111111111111",
        approvedVersionId: "22222222-2222-4222-8222-222222222222",
      },
    ],
  );
});

test("malformed historical approval entries cannot become undefined UUID queries", () => {
  assert.deepEqual(
    approvedDocumentVersionPairs([
      null,
      {},
      { artifact_type: "draft", document_id: "", version_id: "version" },
      { artifact_type: "draft", document_id: "document" },
    ]),
    [],
  );
});
