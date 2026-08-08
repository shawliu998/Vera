import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAgentTabularAcceptedView,
  isAgentTabularAcceptedViewBuildError,
} from "./agentTabularAcceptedView";

const reviewId = "11111111-1111-4111-8111-111111111111";
const documentA = "22222222-2222-4222-8222-222222222222";
const documentB = "33333333-3333-4333-8333-333333333333";
const cellA0 = "44444444-4444-4444-8444-444444444444";
const cellA1 = "55555555-5555-4555-8555-555555555555";
const cellB0 = "66666666-6666-4666-8666-666666666666";
const cellB1 = "77777777-7777-4777-8777-777777777777";

function materialize(cells = [cellB1, cellA1, cellA0, cellB0]) {
  const ids = new Map<string, [string, number]>([
    [cellA0, [documentA, 0]],
    [cellA1, [documentA, 1]],
    [cellB0, [documentB, 0]],
    [cellB1, [documentB, 1]],
  ]);
  return buildAgentTabularAcceptedView({
      review: {
        id: reviewId,
        title: "Evidence inventory",
        practice: "litigation",
        workflow_id: "workflow-1",
        row_protocol: "document_rows",
        document_ids: [documentA, documentB],
        columns_config: [{ index: 0, name: "Evidence" }, { index: 1, name: "Gap" }],
      },
      input_digest: "a".repeat(64),
      document_ids: [documentA, documentB],
      column_indexes: [0, 1],
      cells: cells.map((id) => {
        const [document_id, column_index] = ids.get(id)!;
        return {
          id,
          document_id,
          row_id: null,
          column_index,
          status: "done",
          content: `content-${id}`,
          citations: [{ quote: "fixed quote" }],
          review_status: "verified",
          reviewed_at: "2026-08-08T00:00:00.123456+00:00",
          review_revision: 1,
        };
      }),
    });
}

test("Tabular accepted view is complete and independent of database row order", () => {
  const unordered = materialize();
  const ordered = materialize([cellA0, cellA1, cellB0, cellB1]);
  assert.deepEqual(
    unordered.accepted_view.cells.map((cell) => cell.cell_id),
    [cellA0, cellA1, cellB0, cellB1],
  );
  assert.equal(unordered.accepted_view_text, ordered.accepted_view_text);
  assert.equal(unordered.accepted_view_sha256, ordered.accepted_view_sha256);
});

test("Tabular accepted view fails closed for missing or duplicated fixed cells", () => {
  assert.throws(() => materialize([cellA0, cellA1, cellB0]), /incomplete/);
  assert.throws(
    () => materialize([cellA0, cellA1, cellB0, cellB0]),
    /invalid fixed cell coordinate/,
  );
});

test("Tabular accepted view refuses more than 500 fixed cells", () => {
  const documents = Array.from({ length: 501 }, (_, index) =>
    `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  );
  let caught: unknown = null;
  assert.throws(
    () =>
      buildAgentTabularAcceptedView({
        review: {
          id: reviewId,
          title: "Large review",
          practice: null,
          workflow_id: null,
          row_protocol: "document_rows",
          document_ids: documents,
          columns_config: [{ index: 0, name: "Evidence" }],
        },
        input_digest: "a".repeat(64),
        document_ids: documents,
        column_indexes: [0],
        cells: documents.map((document_id, index) => ({
          id: `00000000-0000-4000-9000-${String(index).padStart(12, "0")}`,
          document_id,
          row_id: null,
          column_index: 0,
          status: "done",
          content: "fixed",
          citations: [],
          review_status: "verified",
          reviewed_at: "2026-08-08T00:00:00.000Z",
          review_revision: 1,
        })),
      }),
    (error) => {
      caught = error;
      return isAgentTabularAcceptedViewBuildError(error);
    },
  );
  assert.ok(isAgentTabularAcceptedViewBuildError(caught));
  if (isAgentTabularAcceptedViewBuildError(caught)) {
    assert.equal(caught.code, "cell_scope_exceeded");
  }
});
