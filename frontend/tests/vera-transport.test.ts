import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildVeraApiUrl,
  getVeraApiBase,
  getVeraAuthorizationHeaders,
  normalizeVeraApiBase,
  veraApiPathFromWireUrl,
  VeraRuntimeConfigurationError,
} from "../src/app/lib/veraRuntime.ts";
import { DOCUMENT_UPLOAD_ERROR_CODES } from "../src/app/lib/documentUploadValidation.ts";
import {
  attachVeraProjectDocument,
  displayVeraDocument,
  downloadVeraCapability,
  listVeraDocuments,
  listVeraProjectDocuments,
  moveVeraProjectDocument,
  renameVeraProjectDocument,
  uploadVeraDocument,
  uploadVeraDocumentVersion,
  veraApiErrorFromResponse,
  veraApiRequest,
  VeraApiError,
} from "../src/app/lib/veraApi.ts";
import {
  parseVeraSseEvent,
  parseVeraSseResponse,
  parseVeraSseStream,
  VeraSseProtocolError,
} from "../src/app/lib/veraSse.ts";
import type { VeraSseEventWire } from "../src/app/lib/veraWireTypes.ts";

const id = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";
const validToken = "vdt_1234567890abcdefghijklmnopqrstuvwxyz";

type TestWindow = {
  aletheiaDesktop?: {
    getInfo(): Promise<{ workspaceApiUrl: string }>;
    getAuthToken(): Promise<string>;
  };
};

function setTestWindow(value: TestWindow | undefined): () => void {
  const prior = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    value,
    configurable: true,
    writable: true,
  });
  return () => {
    if (prior) Object.defineProperty(globalThis, "window", prior);
    else Reflect.deleteProperty(globalThis, "window");
  };
}

function utf8Stream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      chunks.forEach((chunk) => controller.enqueue(chunk));
      controller.close();
    },
  });
}

function streamText(value: string): ReadableStream<Uint8Array> {
  return utf8Stream([new TextEncoder().encode(value)]);
}

async function collect(
  stream: AsyncIterable<VeraSseEventWire>,
): Promise<VeraSseEventWire[]> {
  const events: VeraSseEventWire[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

test("Vera runtime accepts only the canonical loopback API boundary", async () => {
  assert.equal(
    normalizeVeraApiBase("http://127.0.0.1:43123/api/v1/"),
    "http://127.0.0.1:43123/api/v1",
  );
  assert.equal(
    normalizeVeraApiBase("https://localhost:43123/api/v1"),
    "https://localhost:43123/api/v1",
  );
  for (const unsafe of [
    "https://api.example.test/api/v1",
    "http://api.example.test/api/v1",
    "http://127.0.0.1:43123",
    "http://127.0.0.1:43123/api/v10",
    "http://user:password@127.0.0.1:43123/api/v1",
    "http://127.0.0.1:43123/api/v1?token=secret",
    "http://127.0.0.1:43123/api/v1#fragment",
  ]) {
    assert.throws(
      () => normalizeVeraApiBase(unsafe),
      VeraRuntimeConfigurationError,
    );
  }

  const restoreWindow = setTestWindow({
    aletheiaDesktop: {
      async getInfo() {
        return { workspaceApiUrl: "https://attacker.example/api/v1" };
      },
      async getAuthToken() {
        return validToken;
      },
    },
  });
  try {
    await assert.rejects(getVeraApiBase(), VeraRuntimeConfigurationError);
  } finally {
    restoreWindow();
  }

  for (const path of [
    "https://example.test/projects",
    "//example.test/projects",
    "/../outside",
    "/%2e%2e/outside",
    "/projects?token=secret",
    "/projects\\outside",
    "/downloads/a%2Foutside",
  ]) {
    await assert.rejects(buildVeraApiUrl(path), VeraRuntimeConfigurationError);
  }
  for (const key of [
    "token",
    "access_token",
    "myAuthValue",
    "authorization_hint",
    "credential_id",
    "clientSecret",
    "api_key",
    "providerApiKey",
  ]) {
    await assert.rejects(
      buildVeraApiUrl("/projects", { [key]: "must-not-enter-url" }),
      VeraRuntimeConfigurationError,
    );
  }
  assert.equal(
    veraApiPathFromWireUrl("/api/v1/downloads/1234567890abcdef"),
    "/downloads/1234567890abcdef",
  );
  assert.throws(
    () => veraApiPathFromWireUrl("https://example.test/api/v1/downloads/x"),
    VeraRuntimeConfigurationError,
  );
});

test("desktop bearer stays in memory, is cached, and cannot be overridden", async () => {
  let tokenCalls = 0;
  let infoCalls = 0;
  const restoreShortWindow = setTestWindow({
    aletheiaDesktop: {
      async getInfo() {
        return { workspaceApiUrl: "http://127.0.0.1:43123/api/v1" };
      },
      async getAuthToken() {
        return "1234567890abcdef";
      },
    },
  });
  try {
    await assert.rejects(
      getVeraAuthorizationHeaders(),
      VeraRuntimeConfigurationError,
      "the old 16-byte minimum is rejected",
    );
  } finally {
    restoreShortWindow();
  }

  const restoreWhitespaceWindow = setTestWindow({
    aletheiaDesktop: {
      async getInfo() {
        return { workspaceApiUrl: "http://127.0.0.1:43123/api/v1" };
      },
      async getAuthToken() {
        return "vdt_1234567890abcdefghijk lmnopqrstuvwxyz";
      },
    },
  });
  try {
    await assert.rejects(
      getVeraAuthorizationHeaders(),
      VeraRuntimeConfigurationError,
      "tokens rejected by the backend bearer grammar fail before fetch",
    );
  } finally {
    restoreWhitespaceWindow();
  }

  const restoreWindow = setTestWindow({
    aletheiaDesktop: {
      async getInfo() {
        infoCalls += 1;
        return { workspaceApiUrl: "http://127.0.0.1:43123/api/v1" };
      },
      async getAuthToken() {
        tokenCalls += 1;
        return validToken;
      },
    },
  });
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/void")) return new Response(null, { status: 204 });
    if (url.includes("/downloads/")) {
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition":
            "attachment; filename=\"fallback.pdf\"; filename*=UTF-8''Vera%20file.pdf",
        },
      });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  };

  try {
    const abortController = new AbortController();
    assert.deepEqual(
      await veraApiRequest("/projects", {
        method: "POST",
        json: { name: "Local project" },
        signal: abortController.signal,
      }),
      { ok: true },
    );
    assert.equal(
      await veraApiRequest<void>("/void", { method: "POST" }),
      undefined,
    );
    const downloaded = await downloadVeraCapability({
      url: "/api/v1/downloads/1234567890abcdef",
      document_id: id,
      filename: "Vera file.pdf",
      version_id: otherId,
      has_pdf_rendition: true,
    });
    assert.equal(downloaded.blob.size, 3);
    assert.equal(downloaded.filename, "Vera file.pdf");

    assert.equal(infoCalls, 1, "desktop API base is one in-memory Promise");
    assert.equal(tokenCalls, 1, "desktop token is one in-memory Promise");
    assert.equal(calls.length, 3);
    for (const call of calls) {
      const headers = new Headers(call.init?.headers);
      assert.equal(headers.get("authorization"), `Bearer ${validToken}`);
      assert.equal(
        call.url.includes(validToken),
        false,
        "token never enters a URL",
      );
      assert.equal(call.init?.cache, "no-store");
      assert.equal(call.init?.credentials, "omit");
      assert.equal(call.init?.redirect, "error");
      assert.equal(call.init?.referrerPolicy, "no-referrer");
    }
    assert.equal(calls[0].url, "http://127.0.0.1:43123/api/v1/projects");
    assert.equal(calls[0].init?.signal, abortController.signal);
    assert.equal(
      calls[0].init?.body,
      JSON.stringify({ name: "Local project" }),
    );
    assert.equal(
      calls[2].url,
      "http://127.0.0.1:43123/api/v1/downloads/1234567890abcdef",
    );

    await assert.rejects(
      veraApiRequest("/projects", {
        headers: { Authorization: "Bearer caller-controlled" },
      }),
      VeraRuntimeConfigurationError,
    );
  } finally {
    globalThis.fetch = originalFetch;
    restoreWindow();
  }
});

test("API errors parse top-level and nested contracts without reflecting raw bodies", async () => {
  const top = await veraApiErrorFromResponse(
    new Response(
      JSON.stringify({
        detail: "Project is archived.",
        code: "CONFLICT",
        error: {
          code: "NESTED_CONFLICT",
          message: "Nested message",
          retryable: true,
        },
      }),
      { status: 409, headers: { "Content-Type": "application/json" } },
    ),
  );
  assert(top instanceof VeraApiError);
  assert.equal(top.message, "Project is archived.");
  assert.equal(top.code, "CONFLICT");
  assert.equal(top.retryable, true);

  const nested = await veraApiErrorFromResponse(
    new Response(
      JSON.stringify({
        error: { code: "NOT_FOUND", message: "Document not found." },
      }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    ),
  );
  assert.equal(nested.message, "Document not found.");
  assert.equal(nested.code, "NOT_FOUND");

  const rawSecret = "vdt_should_never_be_reflected";
  const opaque = await veraApiErrorFromResponse(
    new Response(`upstream failure ${rawSecret}`, { status: 502 }),
  );
  assert.equal(opaque.message.includes(rawSecret), false);
  assert.equal(opaque.code, null);
});

test("typed document APIs follow the project/catalog routes and binary display contract", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const documentWire = {
    id: otherId,
    user_id: "00000000-0000-4000-8000-000000000001",
    project_id: id,
    folder_id: null,
    filename: "renamed.pdf",
    owner_email: null,
    owner_display_name: "Local User",
    file_type: "pdf",
    storage_path: null,
    pdf_storage_path: null,
    size_bytes: 2,
    page_count: 1,
    structure_tree: null,
    status: "ready",
    created_at: "2026-07-14T00:00:00.000Z",
    updated_at: "2026-07-14T00:00:00.000Z",
    active_version_number: 1,
    latest_version_number: 1,
  };
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    if (url.pathname.endsWith("/display")) {
      return new Response(new Uint8Array([7, 8]), {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": 'inline; filename="preview.pdf"',
        },
      });
    }
    if (
      url.pathname === `/api/v1/projects/${id}/documents/${otherId}` ||
      url.pathname === `/api/v1/projects/${id}/documents/${otherId}/folder`
    ) {
      return new Response(JSON.stringify(documentWire), {
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify([]), {
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    await listVeraDocuments({
      project_id: id,
      folder_id: otherId,
      status: "ready",
      limit: 25,
    });
    await listVeraProjectDocuments(id, { limit: 10 });
    await attachVeraProjectDocument(id, otherId);
    await renameVeraProjectDocument(id, otherId, "renamed.pdf");
    await moveVeraProjectDocument(id, otherId, null);
    const preview = await displayVeraDocument(otherId, id);
    assert.equal(preview.blob.size, 2);

    assert.equal(calls[0].url.pathname, "/api/v1/documents");
    assert.equal(calls[0].url.searchParams.get("project_id"), id);
    assert.equal(calls[0].url.searchParams.get("folder_id"), otherId);
    assert.equal(calls[0].url.searchParams.get("status"), "ready");
    assert.equal(calls[0].url.searchParams.get("limit"), "25");
    assert.equal(calls[1].url.pathname, `/api/v1/projects/${id}/documents`);
    assert.equal(calls[1].url.searchParams.get("limit"), "10");
    assert.equal(calls[2].init?.method, "POST");
    assert.equal(calls[3].init?.method, "PATCH");
    assert.equal(
      calls[3].init?.body,
      JSON.stringify({ filename: "renamed.pdf" }),
    );
    assert.equal(calls[4].init?.method, "PATCH");
    assert.equal(calls[4].init?.body, JSON.stringify({ folder_id: null }));
    assert.equal(calls[5].url.pathname, `/api/v1/documents/${otherId}/display`);
    assert.equal(calls[5].url.searchParams.get("version_id"), id);
    assert.equal(
      new Headers(calls[5].init?.headers).get("accept"),
      "application/octet-stream",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("document uploads reject unsupported extensions before network access", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("fetch must not run");
  };

  try {
    for (const name of ["legacy.doc", "sheet.xlsm", "slides.pptx", ".pdf"]) {
      const secret = `secret-${name}`;
      const file = Object.assign(new Blob([secret]), { name }) as File;
      await assert.rejects(
        uploadVeraDocument({ file, projectId: id }),
        (error: unknown) => {
          assert.ok(error instanceof VeraRuntimeConfigurationError);
          assert.equal(
            (error as { code?: unknown }).code,
            DOCUMENT_UPLOAD_ERROR_CODES.unsupportedType,
          );
          assert.equal(error.message.includes(name), false);
          assert.equal(error.message.includes(secret), false);
          return true;
        },
      );
      await assert.rejects(
        uploadVeraDocumentVersion(otherId, file, { projectId: id }),
        (error: unknown) => {
          assert.equal(
            (error as { code?: unknown }).code,
            DOCUMENT_UPLOAD_ERROR_CODES.unsupportedType,
          );
          return true;
        },
      );
    }
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("document uploads accept FormData-compatible files across Blob realms", async () => {
  const originalFetch = globalThis.fetch;
  const originalBlob = Object.getOwnPropertyDescriptor(globalThis, "Blob");
  const file = Object.assign(new Blob(["cross-realm"]), {
    name: " evidence.pdf ",
  }) as File;
  let fetchCalls = 0;

  Object.defineProperty(globalThis, "Blob", {
    value: class ForeignRealmBlob {},
    configurable: true,
    writable: true,
  });
  assert.equal(file instanceof Blob, false);
  globalThis.fetch = async (_input, init) => {
    fetchCalls += 1;
    assert.ok(init?.body instanceof FormData);
    assert.equal((init.body.get("file") as File).name, "evidence.pdf");
    return new Response("{}", {
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    await assert.rejects(
      uploadVeraDocument({ file, projectId: id }),
      (error: unknown) => {
        assert.equal(error instanceof VeraRuntimeConfigurationError, false);
        return true;
      },
    );
    assert.equal(fetchCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalBlob) Object.defineProperty(globalThis, "Blob", originalBlob);
    else Reflect.deleteProperty(globalThis, "Blob");
  }
});

test("document uploads fail closed for File lookalikes without reflecting secrets", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("fetch must not run");
  };
  const secret = "client-confidential-material";
  const lookalike = {
    name: `${secret}.pdf`,
    size: 1,
    type: "application/pdf",
    arrayBuffer: async () => new ArrayBuffer(1),
    stream: () => new ReadableStream(),
    text: async () => secret,
    slice: () => lookalike,
    [Symbol.toStringTag]: "File",
  } as unknown as File;
  const oversizedName = `${"x".repeat(237)}.pdf`;
  const oversized = Object.assign(new Blob([secret]), {
    name: oversizedName,
  }) as File;

  try {
    await assert.rejects(
      uploadVeraDocument({ file: lookalike, projectId: id }),
      (error: unknown) => {
        assert.ok(error instanceof VeraRuntimeConfigurationError);
        assert.equal(
          (error as { code?: unknown }).code,
          DOCUMENT_UPLOAD_ERROR_CODES.invalidFile,
        );
        assert.equal(error.message.includes(secret), false);
        return true;
      },
    );
    await assert.rejects(
      uploadVeraDocument({ file: oversized, projectId: id }),
      (error: unknown) => {
        assert.ok(error instanceof VeraRuntimeConfigurationError);
        assert.equal(
          (error as { code?: unknown }).code,
          DOCUMENT_UPLOAD_ERROR_CODES.invalidFile,
        );
        assert.equal(error.message.includes(oversizedName), false);
        assert.equal(error.message.includes(secret), false);
        return true;
      },
    );
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("locked Mike SSE is UTF-8 chunk-safe and validates every exact event", async () => {
  const events: VeraSseEventWire[] = [
    { type: "chat_id", chatId: id },
    { type: "reasoning_delta", text: "分析" },
    { type: "reasoning_block_end" },
    { type: "tool_call_start", name: "read_document" },
    { type: "workflow_applied", workflow_id: otherId, title: "Extract" },
    {
      type: "citations",
      status: "final",
      citations: [
        {
          type: "citation_data",
          kind: "document",
          ref: 1,
          doc_id: "Document 1",
          document_id: id,
          filename: "source.pdf",
          page: 1,
          quote: "Evidence",
          version_id: otherId,
          version_number: 1,
          quotes: [{ page: 1, quote: "Evidence" }],
        },
      ],
    },
    { type: "content_delta", text: "结论 🧭" },
    { type: "content_done" },
    {
      type: "cell_update",
      document_id: id,
      column_index: 0,
      content: { summary: "Done", flag: "green", reasoning: "Checked" },
      status: "done",
    },
    { type: "chat_title", chatId: id, title: "Local analysis" },
  ];
  events.forEach((event) => assert.deepEqual(parseVeraSseEvent(event), event));

  const body =
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") +
    "data: [DONE]\n\n";
  const encoded = new TextEncoder().encode(body);
  const emojiStart = new TextEncoder().encode(
    body.slice(0, body.indexOf("🧭")),
  ).length;
  const parsed = await collect(
    parseVeraSseStream(
      utf8Stream([
        encoded.slice(0, emojiStart + 1),
        encoded.slice(emojiStart + 1, emojiStart + 3),
        encoded.slice(emojiStart + 3),
      ]),
    ),
  );
  assert.deepEqual(parsed, events);

  const aggregate =
    Array.from(
      { length: 128 },
      (_, index) =>
        `data: ${JSON.stringify({ type: "content_delta", text: String(index) })}\n\n`,
    ).join("") + "data: [DONE]\n\n";
  assert.equal(
    (await collect(parseVeraSseStream(streamText(aggregate)))).length,
    128,
    "one network chunk may aggregate many bounded frames",
  );

  const responseEvents = await collect(
    parseVeraSseResponse(
      new Response(streamText("data: [DONE]\n\n"), {
        headers: { "Content-Type": "text/event-stream; charset=utf-8" },
      }),
    ),
  );
  assert.deepEqual(responseEvents, []);
});

test("SSE fails closed on legacy, malformed, unterminated, and post-DONE data", async () => {
  const invalidEvents: unknown[] = [
    { type: "unknown" },
    { type: "content_delta", content_delta: "legacy" },
    { type: "content_delta", text: "ok", chat_id: id },
    { type: "error", detail: "legacy" },
    {
      type: "cell_update",
      review_id: otherId,
      document_id: id,
      column_index: 0,
      content: null,
      status: "done",
    },
    {
      type: "citations",
      status: "final",
      citations: [
        {
          type: "citation_data",
          kind: "document",
          ref: 0,
          doc_id: "Document 1",
          document_id: id,
          filename: "source.pdf",
          quote: "Evidence",
          page: 1,
        },
      ],
    },
  ];
  invalidEvents.forEach((event) =>
    assert.throws(() => parseVeraSseEvent(event), VeraSseProtocolError),
  );

  for (const body of [
    'data: {"type":"content_delta","text":"missing done"}\n\n',
    "event: content\ndata: {}\n\ndata: [DONE]\n\n",
    "data: not-json\n\ndata: [DONE]\n\n",
    'data: [DONE]\n\ndata: {"type":"content_done"}\n\n',
    "data:[DONE]\n\n",
  ]) {
    await assert.rejects(
      collect(parseVeraSseStream(streamText(body))),
      VeraSseProtocolError,
    );
  }

  await assert.rejects(
    collect(
      parseVeraSseResponse(
        new Response("data: [DONE]\n\n", {
          headers: { "Content-Type": "application/json" },
        }),
      ),
    ),
    VeraSseProtocolError,
  );
});

test("transport source contains no persistent secret or legacy-client coupling", () => {
  const files = ["veraRuntime.ts", "veraApi.ts", "veraSse.ts"];
  for (const file of files) {
    const source = readFileSync(
      new URL(`../src/app/lib/${file}`, import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(source, /localStorage|sessionStorage/);
    assert.doesNotMatch(source, /console\.(?:log|debug|info|warn|error)/);
    assert.doesNotMatch(source, /aletheiaApi|components\/shared\/types/);
    assert.doesNotMatch(source, /NEXT_PUBLIC_[A-Z0-9_]*(?:TOKEN|SECRET|KEY)/);
  }
});
