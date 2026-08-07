import assert from "node:assert/strict";
import test from "node:test";

import type { BoundWordMemoSourceManifest } from "./wordMemoSourceManifest";
import {
  assertWordMemoTaskBinding,
  loadWordMemoTaskBinding,
  saveBoundWordMemoTaskFile,
  WordMemoTaskApiError,
  type WordMemoTaskApiDependencies,
  type WordMemoTaskBinding,
} from "./wordMemoTaskBinding";

const citation = {
  reference: "C-01-01-F-01",
  documentId: "document-1",
  versionId: "version-7",
  filename: "供应商主协议最终审阅版.docx",
  page: 18,
  locator: "第 18 页",
  quote: "客户应在收到无争议发票后三十日内付款。",
};

const source = {
  documentId: "document-1",
  versionId: "version-7",
  filename: "供应商主协议最终审阅版.docx",
  fileType: "docx",
  role: "source" as const,
};

const manifest: BoundWordMemoSourceManifest = {
  schemaVersion: 1,
  generatorVersion: "tabular-review-word-memo-v1",
  projectId: "matter-1",
  reviewId: "review/1",
  taskId: "task-1",
  memoDocumentId: "memo-1",
  memoVersionId: "version-1",
  inputDigest: "input-digest-1",
  citations: [citation],
};

const binding: WordMemoTaskBinding = {
  taskId: "task-1",
  taskStatus: "completed",
  projectId: "matter-1",
  reviewId: "review/1",
  memoDocumentId: "memo-1",
  memoVersionId: "version-1",
  memoVersionNumber: 1,
  memoFilename: "Review memo.docx",
  executionChatId: "chat-1",
  inputDigest: "input-digest-1",
  reviewTitle: "Long review title",
  matterName: "Matter One",
  verifierStatus: "passed",
  citations: [citation],
  sources: [source],
};

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function dependencies(fetchImpl: typeof fetch): WordMemoTaskApiDependencies {
  return {
    apiBase: "https://vera.test",
    fetch: fetchImpl,
    getAccessToken: async () => "token-1",
  };
}

test("GET sends every untrusted hint to the read-only binding endpoint", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const result = await loadWordMemoTaskBinding(
    manifest,
    dependencies((async (input, init) => {
      requests.push({ url: String(input), init });
      return json(binding);
    }) as typeof fetch),
  );
  assert.deepEqual(result, binding);
  const request = requests[0];
  assert.ok(request);
  const url = new URL(request.url);
  assert.equal(url.pathname, "/tabular-review/review%2F1/memo-context");
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    task_id: "task-1",
    project_id: "matter-1",
    memo_document_id: "memo-1",
    memo_version_id: "version-1",
    input_digest: "input-digest-1",
  });
  assert.equal(request.init?.method, undefined);
  assert.equal(
    new Headers(request.init?.headers).get("authorization"),
    "Bearer token-1",
  );
});

test("task-bound PUT sends the base and DOCX without using generic DMS upload", async () => {
  const captured: {
    request: { url: string; init?: RequestInit } | null;
  } = { request: null };
  const file = new File(["edited"], "Review memo.docx", {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
  const result = await saveBoundWordMemoTaskFile(
    {
      manifest,
      baseVersionId: "version-1",
      file,
    },
    dependencies((async (input, init) => {
      captured.request = { url: String(input), init };
      return json({
        ...binding,
        taskStatus: "verifying",
        memoVersionId: "version-2",
        memoVersionNumber: 2,
        verifierStatus: "running",
      });
    }) as typeof fetch),
  );
  assert.equal(result.memoVersionId, "version-2");
  if (!captured.request) throw new Error("Request not captured");
  assert.equal(
    captured.request.url,
    "https://vera.test/tabular-review/review%2F1/memo-task/word-file",
  );
  assert.equal(captured.request.init?.method, "PUT");
  const headers = new Headers(captured.request.init?.headers);
  assert.equal(headers.get("content-type"), null);
  assert.ok(captured.request.init?.body instanceof FormData);
  const body = captured.request.init.body;
  assert.equal(body.get("task_id"), "task-1");
  assert.equal(body.get("project_id"), "matter-1");
  assert.equal(body.get("memo_document_id"), "memo-1");
  assert.equal(body.get("memo_version_id"), "version-1");
  assert.equal(body.get("input_digest"), "input-digest-1");
  assert.equal(body.get("base_version_id"), "version-1");
  assert.ok(body.get("file") instanceof Blob);
});

test("forged server identity and stale base errors remain fail-closed", async () => {
  assert.throws(
    () =>
      assertWordMemoTaskBinding(manifest, {
        ...binding,
        memoDocumentId: "other-memo",
      }),
    /does not match/,
  );
  await assert.rejects(
    saveBoundWordMemoTaskFile(
      {
        manifest,
        baseVersionId: "version-1",
        file: new File(["stale"], "Review memo.docx"),
      },
      dependencies((async () =>
        json(
          { detail: "The Memo Document has a newer current Version" },
          409,
        )) as typeof fetch),
    ),
    (error: unknown) =>
      error instanceof WordMemoTaskApiError &&
      error.status === 409 &&
      /newer current Version/.test(error.message),
  );
});

test("binding with mismatched identity is rejected fail-closed", () => {
  assert.throws(
    () =>
      assertWordMemoTaskBinding({ ...manifest, taskId: "task-other" }, binding),
    /does not match/,
    "taskId mismatch must fail closed",
  );
  assert.throws(
    () =>
      assertWordMemoTaskBinding(
        { ...manifest, projectId: "matter-other" },
        binding,
      ),
    /does not match/,
    "projectId mismatch must fail closed",
  );
  assert.throws(
    () =>
      assertWordMemoTaskBinding(
        { ...manifest, memoDocumentId: "memo-other" },
        binding,
      ),
    /does not match/,
    "memoDocumentId mismatch must fail closed",
  );
  assert.throws(
    () =>
      assertWordMemoTaskBinding(
        { ...manifest, inputDigest: "digest-other" },
        binding,
      ),
    /does not match/,
    "inputDigest mismatch must fail closed",
  );
});

test("binding citations must exactly match the manifest citations", () => {
  assert.deepEqual(
    assertWordMemoTaskBinding(manifest, binding).citations,
    manifest.citations,
  );
  assert.throws(
    () =>
      assertWordMemoTaskBinding(manifest, {
        ...binding,
        citations: [{ ...citation, quote: "altered quote" }],
      }),
    /citations do not match/,
    "citation mismatch must fail closed",
  );
  assert.throws(
    () =>
      assertWordMemoTaskBinding(manifest, {
        ...binding,
        citations: [],
      }),
    /citations do not match/,
    "missing citations must fail closed",
  );
});

test("binding fixed sources must be complete, pinned, and unique", () => {
  assert.throws(
    () =>
      assertWordMemoTaskBinding(manifest, {
        ...binding,
        sources: [],
      }),
    /malformed Memo binding/,
  );
  assert.throws(
    () =>
      assertWordMemoTaskBinding(manifest, {
        ...binding,
        sources: [source, { ...source, filename: "duplicate.docx" }],
      }),
    /malformed Memo binding/,
  );
  assert.throws(
    () =>
      assertWordMemoTaskBinding(manifest, {
        ...binding,
        sources: [{ ...source, versionId: "" }],
      }),
    /malformed Memo binding/,
  );
});

test("a binding for a newer server Version rejects an older open Word receipt", () => {
  assert.throws(
    () =>
      assertWordMemoTaskBinding(manifest, {
        ...binding,
        memoVersionId: "version-2",
        memoVersionNumber: 2,
      }),
    /not the current Memo Version/,
  );
});

test("task-bound PUT rejects a base that differs from the open Word receipt before fetch", async () => {
  let fetchCount = 0;
  await assert.rejects(
    saveBoundWordMemoTaskFile(
      {
        manifest,
        baseVersionId: "version-2",
        file: new File(["stale"], "Review memo.docx"),
      },
      dependencies((async () => {
        fetchCount += 1;
        return json(binding);
      }) as typeof fetch),
    ),
    /open Word file Version/,
  );
  assert.equal(fetchCount, 0);
});

test("malformed 2xx binding payloads are rejected fail-closed", () => {
  const base = { ...binding };
  const cases: Array<{ _label: string } & Record<string, unknown>> = [
    { ...base, taskId: "", _label: "empty taskId" },
    { ...base, taskStatus: "unknown", _label: "invalid taskStatus" },
    { ...base, projectId: "", _label: "empty projectId" },
    { ...base, reviewId: "", _label: "empty reviewId" },
    { ...base, memoDocumentId: "", _label: "empty memoDocumentId" },
    { ...base, memoVersionId: "", _label: "empty memoVersionId" },
    { ...base, memoVersionNumber: 0, _label: "zero memoVersionNumber" },
    { ...base, memoVersionNumber: -1, _label: "negative memoVersionNumber" },
    {
      ...base,
      memoVersionNumber: 1.5,
      _label: "non-integer memoVersionNumber",
    },
    { ...base, memoFilename: "", _label: "empty memoFilename" },
    { ...base, executionChatId: "", _label: "empty executionChatId" },
    { ...base, inputDigest: "", _label: "empty inputDigest" },
    { ...base, reviewTitle: "", _label: "empty reviewTitle" },
    { ...base, matterName: "", _label: "empty matterName" },
    { ...base, verifierStatus: "unknown", _label: "invalid verifierStatus" },
    { ...base, citations: undefined, _label: "missing citations" },
    {
      ...base,
      citations: [{ ...citation, reference: "" }],
      _label: "invalid citation",
    },
    { ...base, citations: "not-array", _label: "non-array citations" },
    {
      ...base,
      sources: [
        ...binding.sources,
        { ...binding.sources[0], versionId: "version-8" },
      ],
      _label: "same source document with multiple versions",
    },
  ];

  for (const malformed of cases) {
    const { _label, ...payload } = malformed;
    assert.throws(
      () => assertWordMemoTaskBinding(manifest, payload),
      /malformed/,
      `${_label} must be rejected as malformed`,
    );
  }

  assert.throws(
    () => assertWordMemoTaskBinding(manifest, null),
    /malformed/,
    "null payload must be rejected",
  );
  assert.throws(
    () => assertWordMemoTaskBinding(manifest, "binding"),
    /malformed/,
    "non-object payload must be rejected",
  );
});

test("malformed 2xx response from the network fails closed", async () => {
  await assert.rejects(
    loadWordMemoTaskBinding(
      manifest,
      dependencies((async () => json({ taskId: "task-1" })) as typeof fetch),
    ),
    /malformed/,
  );
});
