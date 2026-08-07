import assert from "node:assert/strict";
import test from "node:test";

import {
  mapWithConcurrency,
  parseTabularGenerationLine,
  planTabularRecovery,
} from "./tabularGeneration";

test("parses only a declared column result and normalizes bounded fields", () => {
  assert.deepEqual(
    parseTabularGenerationLine(
      JSON.stringify({
        column_index: 3,
        summary: "  Found [1]  ",
        flag: "red",
        reasoning: "Source text",
      }),
      new Set([3]),
    ),
    {
      kind: "result",
      columnIndex: 3,
      result: {
        summary: "Found [1]",
        flag: "red",
        reasoning: "Source text",
      },
    },
  );
  assert.equal(
    parseTabularGenerationLine('{"column_index":9}', new Set([3])).kind,
    "malformed",
  );
  assert.equal(
    parseTabularGenerationLine("```json", new Set([3])).kind,
    "ignorable",
  );
});

test("bounds concurrent tabular document work", async () => {
  let active = 0;
  let maximum = 0;
  const completed: number[] = [];
  await mapWithConcurrency([0, 1, 2, 3, 4], 2, async (value) => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, value % 2));
    completed.push(value);
    active -= 1;
  });
  assert.equal(maximum, 2);
  assert.deepEqual(completed.sort(), [0, 1, 2, 3, 4]);
});

test("recovers only a bounded missing subset and never fans out after stream failure", () => {
  const columns = [0, 1, 2, 3].map((index) => ({
    index,
    name: `Column ${index}`,
    prompt: `Extract ${index}`,
  }));
  const partial = planTabularRecovery(columns, new Set([0]), {
    streamFailed: false,
    automaticRecoveryLimit: 2,
  });
  assert.deepEqual(
    partial.recover.map((column) => column.index),
    [1, 2],
  );
  assert.deepEqual(
    partial.pending.map((column) => column.index),
    [3],
  );

  const interrupted = planTabularRecovery(columns, new Set([0]), {
    streamFailed: true,
    automaticRecoveryLimit: 2,
  });
  assert.deepEqual(interrupted.recover, []);
  assert.deepEqual(
    interrupted.pending.map((column) => column.index),
    [1, 2, 3],
  );
});
