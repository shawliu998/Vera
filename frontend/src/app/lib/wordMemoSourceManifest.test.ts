import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyWordMemoSourceManifest,
  decodeWordMemoSourceManifest,
  encodeWordMemoSourceManifest,
  WORD_MEMO_SOURCE_MANIFEST_COUNT,
  type WordMemoSourceManifest,
} from "./wordMemoSourceManifest";

function manifestProperties(manifest: WordMemoSourceManifest) {
  return Object.fromEntries(
    encodeWordMemoSourceManifest(manifest).map((property) => [
      property.name,
      property.value,
    ]),
  );
}

test("round-trips a chunked source manifest without splitting long Chinese text", () => {
  const manifest: WordMemoSourceManifest = {
    schemaVersion: 1,
    projectId: "matter-1",
    reviewId: "review-1",
    taskId: "task-1",
    memoDocumentId: "memo-document-1",
    memoVersionId: "memo-version-1",
    inputDigest: "input-digest-1",
    citations: [
      {
        reference: "C-01-01-F-01",
        documentId: "document-1",
        versionId: "version-7",
        filename: "供应商主协议最终审阅版.docx",
        page: 18,
        locator: "第 18 页",
        quote: `客户应在收到无争议发票后三十日内付款。${"长期中文证据。".repeat(80)}`,
      },
    ],
  };
  const properties = encodeWordMemoSourceManifest(manifest);
  assert.ok(properties.length > 2);
  assert.ok(properties.every((property) => property.value.length <= 200));
  assert.deepEqual(
    decodeWordMemoSourceManifest(
      Object.fromEntries(
        properties.map((property) => [property.name, property.value]),
      ),
    ),
    manifest,
  );
});

test("preserves an exact quote when DOCX custom-property chunks trim boundary whitespace", () => {
  const manifest: WordMemoSourceManifest = {
    schemaVersion: 1,
    generatorVersion: "tabular-review-word-memo-v1",
    projectId: "945c44e1-93f0-41da-a94f-c5139df4678a",
    reviewId: "b80803e7-908c-12fa-ace4-d77d8df857df",
    taskId: "11111111-1111-4111-8111-111111111111",
    memoDocumentId: "22222222-2222-4222-8222-222222222222",
    inputDigest: "a".repeat(64),
    citations: [
      {
        reference: "1",
        documentId: "ab991966-bab9-4603-9894-724d100d78e3",
        versionId: "309da0b4-7388-4e86-b93f-251f129c269d",
        filename: "synthetic-major-commercial-case.docx",
        page: null,
        locator: "Full document",
        quote: "F-01 2025-02-01 Annual supply agreement signed Contract A",
      },
    ],
  };
  const properties = encodeWordMemoSourceManifest(manifest);
  const trimmedByTransport = Object.fromEntries(
    properties.map(({ name, value }) => [name, value.trim()]),
  );

  assert.ok(
    properties
      .slice(1)
      .every(({ value }) => value.length <= 200 && !/^\s|\s$/.test(value)),
  );
  assert.deepEqual(decodeWordMemoSourceManifest(trimmedByTransport), manifest);
});

test("rejects incomplete, malformed, or unsupported manifests", () => {
  assert.equal(decodeWordMemoSourceManifest({}), null);
  assert.equal(
    decodeWordMemoSourceManifest({
      [WORD_MEMO_SOURCE_MANIFEST_COUNT]: "2",
      VeraMemoSourceManifest001: "{}",
    }),
    null,
  );
  const unsupported = encodeWordMemoSourceManifest({
    schemaVersion: 1,
    projectId: "matter-1",
    reviewId: "review-1",
    citations: [],
  });
  const properties = Object.fromEntries(
    unsupported.map((property) => [property.name, property.value]),
  );
  properties.VeraMemoSourceManifest001 =
    properties.VeraMemoSourceManifest001.replace(
      '"schemaVersion":1',
      '"schemaVersion":2',
    );
  assert.equal(decodeWordMemoSourceManifest(properties), null);
});

test("classifies absent, legacy, and fully task-bound manifests", () => {
  assert.deepEqual(classifyWordMemoSourceManifest({ Unrelated: "value" }), {
    kind: "absent",
  });

  const legacy: WordMemoSourceManifest = {
    schemaVersion: 1,
    projectId: "matter-1",
    reviewId: "review-1",
    citations: [],
  };
  assert.deepEqual(classifyWordMemoSourceManifest(manifestProperties(legacy)), {
    kind: "legacy",
    manifest: legacy,
  });

  const bound: WordMemoSourceManifest = {
    ...legacy,
    generatorVersion: "tabular-review-word-memo-v1",
    taskId: "task-1",
    memoDocumentId: "memo-document-1",
    memoVersionId: "memo-version-1",
    inputDigest: "input-digest-1",
  };
  assert.deepEqual(classifyWordMemoSourceManifest(manifestProperties(bound)), {
    kind: "bound",
    manifest: bound,
  });
});

test("bound classification requires the tabular-review-word-memo-v1 generatorVersion", () => {
  const base: WordMemoSourceManifest = {
    schemaVersion: 1,
    projectId: "matter-1",
    reviewId: "review-1",
    taskId: "task-1",
    memoDocumentId: "memo-document-1",
    memoVersionId: "memo-version-1",
    inputDigest: "input-digest-1",
    citations: [],
  };
  assert.deepEqual(classifyWordMemoSourceManifest(manifestProperties(base)), {
    kind: "invalid",
  });

  const withUnsupportedVersion = {
    ...base,
    generatorVersion: "unsupported",
  } as unknown as WordMemoSourceManifest;
  assert.deepEqual(
    classifyWordMemoSourceManifest(manifestProperties(withUnsupportedVersion)),
    { kind: "invalid" },
  );
});

test("classifies partial task hints as invalid without changing legacy decode behavior", () => {
  const base: WordMemoSourceManifest = {
    schemaVersion: 1,
    projectId: "matter-1",
    reviewId: "review-1",
    citations: [],
  };
  const partialHints: Array<Partial<WordMemoSourceManifest>> = [
    { taskId: "task-1" },
    { memoDocumentId: "memo-document-1" },
    { memoVersionId: "memo-version-1" },
    { inputDigest: "input-digest-1" },
    { taskId: "task-1", memoDocumentId: "memo-document-1" },
    { taskId: "task-1", memoVersionId: "memo-version-1" },
    { taskId: "task-1", inputDigest: "input-digest-1" },
    {
      memoDocumentId: "memo-document-1",
      inputDigest: "input-digest-1",
    },
    {
      taskId: "task-1",
      memoDocumentId: "memo-document-1",
      inputDigest: "input-digest-1",
    },
  ];

  for (const hints of partialHints) {
    const partial = { ...base, ...hints };
    const properties = manifestProperties(partial);
    assert.deepEqual(
      decodeWordMemoSourceManifest(properties),
      partial,
      "the backward-compatible decoder must keep accepting optional hints",
    );
    assert.deepEqual(classifyWordMemoSourceManifest(properties), {
      kind: "invalid",
    });
  }
});

test("classifies malformed manifest properties as invalid", () => {
  assert.deepEqual(
    classifyWordMemoSourceManifest({
      [WORD_MEMO_SOURCE_MANIFEST_COUNT]: "2",
      VeraMemoSourceManifest001: "{}",
    }),
    { kind: "invalid" },
  );
});
