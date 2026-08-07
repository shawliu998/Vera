import assert from "node:assert/strict";
import test from "node:test";

import {
  prepareTabularCellsForGeneration,
  readTabularGenerationStream,
} from "./tabularGenerationClient";

test("prepares only unfinished cells and preserves completed work", () => {
  const cells = prepareTabularCellsForGeneration({
    cells: [
      {
        id: "done",
        review_id: "review",
        document_id: "doc",
        column_index: 0,
        content: { summary: "kept" },
        status: "done",
        created_at: "before",
      },
    ],
    documents: [
      {
        id: "doc",
        project_id: "project",
        filename: "Agreement.docx",
        file_type: "docx",
        storage_path: "documents/Agreement.docx",
        pdf_storage_path: null,
        size_bytes: 100,
        page_count: 1,
        structure_tree: null,
        status: "ready",
        created_at: "before",
      },
    ],
    columns: [
      { index: 0, name: "Term", prompt: "Extract term" },
      { index: 1, name: "Law", prompt: "Extract law" },
    ],
    reviewId: "review",
    createdAt: "now",
  });
  assert.equal(cells[0].status, "done");
  assert.deepEqual(cells[0].content, { summary: "kept" });
  assert.equal(cells[1].status, "generating");
  assert.equal(cells[1].content, null);
});

test("reads split SSE updates and preserves them before reporting a stream error", async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          'data: {"type":"cell_update","document_id":"doc","column_index":0,"content":{"summary":"kept"},"status":"done"}\n',
        ),
      );
      controller.enqueue(
        encoder.encode(
          '\ndata: {"type":"cell_update","document_id":"doc","column_index":1,"content":null,"status":"pending","issue_code":"timeout"}\n\ndata: {"type":"error","message":"Provider timed out"}\n\ndata: [DONE]\n\n',
        ),
      );
      controller.close();
    },
  });
  const updates: Array<{ columnIndex: number; status: string }> = [];
  await assert.rejects(
    readTabularGenerationStream(new Response(stream), (update) => {
      updates.push({
        columnIndex: update.columnIndex,
        status: update.status,
      });
    }),
    /Provider timed out/,
  );
  assert.deepEqual(updates, [
    { columnIndex: 0, status: "done" },
    { columnIndex: 1, status: "pending" },
  ]);
});

test("ignores a done event whose cell content is structurally invalid", async () => {
  const updates: number[] = [];
  await readTabularGenerationStream(
    new Response(
      'data: {"type":"cell_update","document_id":"doc","column_index":0,"content":"not-a-cell","status":"done"}\n\ndata: [DONE]\n\n',
    ),
    (update) => updates.push(update.columnIndex),
  );
  assert.deepEqual(updates, []);
});
