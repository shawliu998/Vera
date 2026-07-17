import assert from "node:assert/strict";

import {
  createStudioDraftFromTabular,
  reduceTabularStudioHandoff,
} from "../lib/workspace/tabularStudioHandoff";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const REVIEW = "22222222-2222-4222-8222-222222222222";
const DOCUMENT = "33333333-3333-4333-8333-333333333333";
const VERSION = "44444444-4444-4444-8444-444444444444";

function markerNumbers(content: string) {
  return [...content.matchAll(/\[(\d+)\]/gu)].map((match) => Number(match[1]));
}

function assertBoundedMarkers(content: string, sourceCount: number) {
  const markers = markerNumbers(content);
  assert.ok(content.length <= 90_000);
  assert.ok(markers.length > 0);
  assert.ok(markers.length < sourceCount);
  assert.deepEqual(
    markers,
    Array.from({ length: markers.length }, (_, index) => index + 1),
  );
}

async function main() {
  // 100 cleaned quotes at roughly 2 KB each exceed the 90 KB draft limit.
  const sources = Array.from({ length: 100 }, (_, index) => {
    const quote = `Evidence ${index + 1}: Section [12]. ${"x".repeat(1_950)}`;
    const startOffset = index * 2_000;
    return {
      documentId: DOCUMENT,
      versionId: VERSION,
      chunkId: `chunk-${index}`,
      quote,
      startOffset,
      endOffset: startOffset + quote.length,
    };
  });
  const detail = {
    review: {
      id: REVIEW,
      projectId: PROJECT,
      title: "Review [12]",
      documentIds: [DOCUMENT],
    },
    columns: [],
    cells: [],
  };
  const customPrepared = {
    kind: "custom_extraction_summary",
    detail,
    source: { orderedUniqueSources: sources },
  } as any;
  const custom = reduceTabularStudioHandoff(customPrepared, {
    projectId: PROJECT,
    title: "Long memo [12]",
  });
  assertBoundedMarkers(custom.content, sources.length);
  assert.match(custom.content, /Section ［12］/u);
  assert.equal(custom.content.includes("Review [12]"), false);

  let created:
    | { content: string; citations: readonly { citationOrdinal: number }[] }
    | undefined;
  await createStudioDraftFromTabular({
    prepared: customPrepared,
    projectId: PROJECT,
    create: async (draft, citations) => {
      created = { content: draft.content, citations };
      return undefined;
    },
  });
  assert.ok(created);
  assert.deepEqual(
    created.citations.map((citation) => citation.citationOrdinal),
    markerNumbers(created.content).map((_, index) => index),
  );

  const timeline = reduceTabularStudioHandoff(
    { ...customPrepared, kind: "case_fact_summary" },
    { projectId: PROJECT, title: "Timeline [12]" },
  );
  assertBoundedMarkers(timeline.content, sources.length);
  assert.match(timeline.content, /Section ［12］/u);

  console.log(
    "veraWorkspaceTabularStudioHandoffBoundaryAudit passed: bounded evidence prefixes and ordinary bracketed text.",
  );
}

void main();
