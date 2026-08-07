import assert from "node:assert/strict";
import test from "node:test";

import {
  queryTabularCell,
  queryTabularColumns,
  tabularFormatPromptSuffix,
} from "./tabularModelGeneration";

test("single-cell recovery normalizes a fenced provider response", async () => {
  const result = await queryTabularCell({
    model: "test-model",
    filename: "Agreement.docx",
    documentText: "The term is twelve months.",
    columnPrompt: "Extract the term.",
    dependencies: {
      complete: (async () =>
        '```json\n{"summary":"12 months","flag":"green","reasoning":"Express term"}\n```') as never,
    },
  });
  assert.deepEqual(result, {
    summary: "12 months",
    flag: "green",
    reasoning: "Express term",
  });
  assert.match(tabularFormatPromptSuffix("yes_no"), /\[\[Yes\]\]/);
});

test("multi-column stream emits each declared column once across chunks", async () => {
  const results: Array<{ index: number; summary: string }> = [];
  await queryTabularColumns({
    model: "test-model",
    filename: "Agreement.docx",
    documentText: "Fixed source text",
    columns: [
      { index: 2, name: "Term", prompt: "Extract term" },
      { index: 7, name: "Law", prompt: "Extract law" },
    ],
    onResult: async (index, result) => {
      results.push({ index, summary: result.summary });
    },
    dependencies: {
      stream: (async (options: {
        callbacks: { onContentDelta: (delta: string) => void };
      }) => {
        options.callbacks.onContentDelta(
          '```json\n{"column_index":2,"summary":"12 months","flag":"green","reasoning":""}\n',
        );
        options.callbacks.onContentDelta(
          '{"column_index":2,"summary":"duplicate","flag":"red","reasoning":""}\n{"column_index":99,"summary":"wrong","flag":"red","reasoning":""}\n',
        );
        options.callbacks.onContentDelta(
          '{"column_index":7,"summary":"PRC law","flag":"grey","reasoning":"source"}\n```',
        );
      }) as never,
    },
  });
  assert.deepEqual(results, [
    { index: 2, summary: "12 months" },
    { index: 7, summary: "PRC law" },
  ]);
});

test("multi-column provider interruption propagates after preserving emitted results", async () => {
  const results: number[] = [];
  await assert.rejects(
    queryTabularColumns({
      model: "test-model",
      filename: "Agreement.docx",
      documentText: "Fixed source text",
      columns: [{ index: 1, name: "Term", prompt: "Extract term" }],
      onResult: async (index) => {
        results.push(index);
      },
      dependencies: {
        stream: (async (options: {
          callbacks: { onContentDelta: (delta: string) => void };
        }) => {
          options.callbacks.onContentDelta(
            '{"column_index":1,"summary":"12 months","flag":"green","reasoning":""}\n',
          );
          throw Object.assign(new Error("service temporarily unavailable"), {
            status: 503,
          });
        }) as never,
      },
    }),
    /temporarily unavailable/,
  );
  assert.deepEqual(results, [1]);
});
