import assert from "node:assert/strict";
import test from "node:test";
import {
  groupAletheiaSearchResults,
  movePaletteSelection,
} from "../src/aletheia/commandPaletteModel.ts";
import type { AletheiaSearchResult } from "../src/app/lib/aletheiaApi.ts";

function result(
  kind: AletheiaSearchResult["kind"],
  id: string,
): AletheiaSearchResult {
  return {
    kind,
    id,
    matterId: "matter-1",
    matterTitle: "Northstar Acquisition",
    title: `${kind} ${id}`,
    snippet: "Relevant search context",
    status: "in_progress",
    updatedAt: "2026-07-11T09:00:00.000Z",
    href: `/aletheia/results/${id}`,
  };
}

test("global search results use a stable kind order", () => {
  const groups = groupAletheiaSearchResults([
    result("task", "task-1"),
    result("deadline", "deadline-1"),
    result("position", "position-1"),
    result("document", "document-1"),
    result("fact", "fact-1"),
    result("matter", "matter-1"),
    result("work_product", "product-1"),
    result("document", "document-2"),
  ]);

  assert.deepEqual(
    groups.map((group) => group.kind),
    [
      "matter",
      "document",
      "fact",
      "position",
      "deadline",
      "task",
      "work_product",
    ],
  );
  assert.deepEqual(
    groups[1]?.results.map((item) => item.id),
    ["document-1", "document-2"],
  );
});

test("keyboard selection wraps in both directions", () => {
  assert.equal(movePaletteSelection(0, 4, -1), 3);
  assert.equal(movePaletteSelection(3, 4, 1), 0);
  assert.equal(movePaletteSelection(0, 0, 1), 0);
});
