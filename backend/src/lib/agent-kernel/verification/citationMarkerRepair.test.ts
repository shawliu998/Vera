import assert from "node:assert/strict";
import test from "node:test";

import {
  citationMarkerPatchPreservesBody,
  planExactCitationMarkerPatch,
} from "./citationMarkerRepair";

const source = (marker: number, quote: string) => ({
  marker,
  sourceDocumentId: `source-${marker}`,
  sourceVersionId: `version-${marker}`,
  quote,
});

test("plans one deterministic marker-only patch without changing Word prose", () => {
  const draft = [
    "FINDINGS",
    "The first source fact is established. [1]",
    "The second source fact is established.",
  ].join("\n");
  const input = {
    draftText: draft,
    sourceCitations: [
      source(1, "first source fact is established"),
      source(2, "second source fact is established"),
    ],
  };
  const first = planExactCitationMarkerPatch(input);
  assert.deepEqual(planExactCitationMarkerPatch(input), first);
  assert.equal(first.kind, "repaired");
  if (first.kind !== "repaired") return;
  const after = draft.replace(first.patch.find, first.patch.replace);
  assert.equal(after, `${draft} [2]`);
  assert.equal(citationMarkerPatchPreservesBody(draft, after), true);
  assert.equal(
    planExactCitationMarkerPatch({ ...input, draftText: after }).kind,
    "no-repair",
  );
});

test("rejects duplicate or out-of-order markers", () => {
  assert.deepEqual(
    planExactCitationMarkerPatch({
      draftText: [
        "The first source fact is established. [1]",
        "The first source fact is repeated. [1]",
        "The second source fact is established.",
      ].join("\n"),
      sourceCitations: [
        source(1, "first source fact"),
        source(2, "second source fact is established"),
      ],
    }),
    { kind: "no-repair", reason: "non-contiguous-marker-sequence" },
  );
  assert.deepEqual(
    planExactCitationMarkerPatch({
      draftText: [
        "The second source fact is established. [2]",
        "The first source fact is established.",
      ].join("\n"),
      sourceCitations: [
        source(1, "first source fact is established"),
        source(2, "second source fact is established"),
      ],
    }),
    { kind: "no-repair", reason: "non-contiguous-marker-sequence" },
  );
});

test("rejects multiple possible material anchors", () => {
  assert.deepEqual(
    planExactCitationMarkerPatch({
      draftText: [
        "The first source fact is established. [1]",
        "The second source fact is established.",
        "The second source fact is established.",
      ].join("\n"),
      sourceCitations: [
        source(1, "first source fact is established"),
        source(2, "second source fact is established"),
      ],
    }),
    { kind: "no-repair", reason: "multiple-missing-markers" },
  );
});
