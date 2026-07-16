import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  listVeraProjectDocuments,
  VeraApiError,
} from "../src/app/lib/veraApi.ts";
import {
  acceptVeraStudioSuggestion,
  createVeraStudioDraftFromAssistant,
  createVeraStudioDraftFromWorkflow,
  createVeraStudioDocument,
  exportVeraStudioDocx,
  getVeraStudioDocument,
  getVeraStudioSuggestion,
  importVeraStudioDocx,
  listVeraStudioDrafts,
  listVeraStudioVersions,
  listVeraStudioSuggestions,
  parseVeraStudioDraftPage,
  parseVeraStudioSuggestion,
  parseVeraStudioSuggestionPreview,
  parseVeraStudioDocument,
  parseVeraStudioDocxImport,
  parseVeraStudioVersions,
  restoreVeraStudioVersion,
  rejectVeraStudioSuggestion,
  saveVeraStudioDocument,
  VERA_STUDIO_DOCX_MIME_TYPE,
} from "../src/app/lib/veraDocumentStudioApi.ts";
import {
  getVeraProjectSourceContent,
  parseVeraProjectSourceContent,
  resolveVeraProjectCitation,
} from "../src/app/lib/veraProjectSourceApi.ts";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const DOCUMENT_ID = "22222222-2222-4222-8222-222222222222";
const CURRENT_VERSION_ID = "33333333-3333-4333-8333-333333333333";
const HISTORY_VERSION_ID = "44444444-4444-4444-8444-444444444444";
const IMPORT_VERSION_ID = "77777777-7777-4777-8777-777777777777";
const ANCHOR_ID = "55555555-5555-4555-8555-555555555555";
const SNAPSHOT_ID = "66666666-6666-4666-8666-666666666666";
const SOURCE_DOCUMENT_ID = "88888888-8888-4888-8888-888888888888";
const SOURCE_VERSION_ID = "99999999-9999-4999-8999-999999999999";
const SOURCE_CHUNK_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CHAT_ID = "88888888-8888-4888-8888-888888888888";
const MESSAGE_ID = "99999999-9999-4999-8999-999999999999";
const WORKFLOW_RUN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SUGGESTION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const RESULT_VERSION_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TOKEN = "vdt_1234567890abcdefghijklmnopqrstuvwxyz";
const HASH = "a".repeat(64);

function studioDraftPage(overrides: Record<string, unknown> = {}) {
  return {
    items: [
      {
        draft_id: DOCUMENT_ID,
        project_id: PROJECT_ID,
        title: "Contract review memo",
        document_type: "contract_review_memo",
        current_version_id: CURRENT_VERSION_ID,
        current_version_number: 2,
        updated_at: "2026-07-15T10:00:00.000Z",
        source_count: 3,
        pending_suggestion_count: 1,
        origin_type: "assistant",
      },
    ],
    has_more: true,
    next_cursor: "draft-cursor-2",
    ...overrides,
  };
}

function digest(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const SOURCE_QUOTE = "Payment is due on 1 September 2026.";
const SOURCE_CHUNK_TEXT = `Recital. ${SOURCE_QUOTE} Signed.`;

function sourceContent(overrides: Record<string, unknown> = {}) {
  return {
    snapshot_id: SNAPSHOT_ID,
    document: {
      document_id: SOURCE_DOCUMENT_ID,
      version_id: SOURCE_VERSION_ID,
      title: "Scanned contract",
      filename: "scanned-contract.pdf",
      mime_type: "application/pdf",
      content_sha256: "b".repeat(64),
      page_count: 3,
    },
    chunks: [
      {
        id: SOURCE_CHUNK_ID,
        ordinal: 0,
        text: SOURCE_CHUNK_TEXT,
        content_sha256: digest(SOURCE_CHUNK_TEXT),
        start_offset: 0,
        end_offset: SOURCE_CHUNK_TEXT.length,
        page_start: 2,
        page_end: 2,
      },
    ],
    next_cursor: null,
    ...overrides,
  };
}

function studioDocument(overrides: Record<string, unknown> = {}) {
  return {
    document_id: DOCUMENT_ID,
    project_id: PROJECT_ID,
    title: "Contract review memo",
    filename: "contract-review-memo.md",
    format: "markdown",
    current_version_id: CURRENT_VERSION_ID,
    version: {
      id: CURRENT_VERSION_ID,
      version_number: 2,
      source: "user_upload",
      filename: "contract-review-memo.md",
      mime_type: "text/markdown",
      size_bytes: 120,
      content_sha256: HASH,
      created_at: "2026-07-15T10:00:00.000Z",
      citation_anchor_ids: [ANCHOR_ID],
    },
    content: "# Contract review\n\nCurrent draft.",
    citation_anchors: [
      {
        id: ANCHOR_ID,
        snapshot_id: SNAPSHOT_ID,
        ordinal: 0,
        exact_quote: "Payment is due on 1 September 2026.",
        quote_sha256: HASH,
        locator: {
          page: 2,
          boundingBox: { x: 0.1, y: 0.2, width: 0.5, height: 0.08 },
        },
      },
    ],
    capabilities: { docx_import: true, docx_export: true },
    ...overrides,
  };
}

function versions() {
  return {
    current_version_id: CURRENT_VERSION_ID,
    versions: [
      {
        id: CURRENT_VERSION_ID,
        version_number: 2,
        source: "user_upload",
        filename: "contract-review-memo.md",
        mime_type: "text/markdown",
        size_bytes: 120,
        content_sha256: HASH,
        created_at: "2026-07-15T10:00:00.000Z",
        citation_anchor_ids: [ANCHOR_ID],
      },
      {
        id: HISTORY_VERSION_ID,
        version_number: 1,
        source: "assistant_edit",
        filename: "contract-review-memo.md",
        mime_type: "text/markdown",
        size_bytes: 80,
        content_sha256: "b".repeat(64),
        created_at: "2026-07-15T09:00:00.000Z",
        citation_anchor_ids: [],
      },
    ],
  };
}

function suggestionPreview(overrides: Record<string, unknown> = {}) {
  return {
    id: SUGGESTION_ID,
    project_id: PROJECT_ID,
    document_id: DOCUMENT_ID,
    base_version_id: CURRENT_VERSION_ID,
    message_id: MESSAGE_ID,
    start_offset: 6,
    end_offset: 9,
    offset_scope: "raw_markdown_v1",
    offset_unit: "utf16_code_unit",
    deleted_preview: "old",
    inserted_preview: "new",
    deleted_truncated: false,
    inserted_truncated: false,
    context_before: "Hello ",
    context_after: " world.",
    summary: "Replace old with new",
    status: "pending",
    created_at: "2026-07-15T10:30:00.000Z",
    ...overrides,
  };
}

function suggestionDetail(overrides: Record<string, unknown> = {}) {
  return {
    id: SUGGESTION_ID,
    project_id: PROJECT_ID,
    document_id: DOCUMENT_ID,
    base_version_id: CURRENT_VERSION_ID,
    message_id: MESSAGE_ID,
    change_id: `assistant-tool:${"d".repeat(64)}`,
    start_offset: 6,
    end_offset: 9,
    offset_scope: "raw_markdown_v1",
    offset_unit: "utf16_code_unit",
    deleted_text: "old",
    inserted_text: "new",
    context_before: "Hello ",
    context_after: " world.",
    summary: "Replace old with new",
    status: "pending",
    created_at: "2026-07-15T10:30:00.000Z",
    resolved_at: null,
    result_version_id: null,
    ...overrides,
  };
}

function installDesktop() {
  const prior = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: {
      aletheiaDesktop: {
        async getInfo() {
          return { workspaceApiUrl: "http://127.0.0.1:43123/api/v1" };
        },
        async getAuthToken() {
          return TOKEN;
        },
      },
    },
  });
  return () => {
    if (prior) Object.defineProperty(globalThis, "window", prior);
    else Reflect.deleteProperty(globalThis, "window");
  };
}

test("Studio parser accepts current and historical immutable versions with real citations", () => {
  const current = parseVeraStudioDocument(studioDocument());
  assert.equal(current.version.id, current.current_version_id);
  assert.equal(current.citation_anchors[0]?.locator.page, 2);
  assert.deepEqual(current.capabilities, {
    docx_import: true,
    docx_export: true,
  });

  const historical = parseVeraStudioDocument(
    studioDocument({
      version: {
        id: HISTORY_VERSION_ID,
        version_number: 1,
        source: "assistant_edit",
        filename: "contract-review-memo.md",
        mime_type: "text/markdown",
        size_bytes: 80,
        content_sha256: "b".repeat(64),
        created_at: "2026-07-15T09:00:00.000Z",
        citation_anchor_ids: [],
      },
      content: "# Historical draft",
      citation_anchors: [],
    }),
  );
  assert.equal(historical.current_version_id, CURRENT_VERSION_ID);
  assert.equal(historical.version.id, HISTORY_VERSION_ID);
  assert.equal(parseVeraStudioVersions(versions()).versions.length, 2);
});

test("Studio parser fails closed on extra fields, invalid provenance, and unsafe locator depth", () => {
  assert.throws(
    () => parseVeraStudioDocument(studioDocument({ storage_path: "/private" })),
    VeraApiError,
  );
  assert.throws(
    () =>
      parseVeraStudioDocument(
        studioDocument({
          version: {
            ...studioDocument().version,
            source: "unknown_source",
          },
        }),
      ),
    VeraApiError,
  );
  assert.throws(
    () =>
      parseVeraStudioDocument(
        studioDocument({
          version: {
            ...studioDocument().version,
            mime_type: "text/plain",
          },
        }),
      ),
    VeraApiError,
  );
  assert.throws(
    () =>
      parseVeraStudioDocument(
        studioDocument({
          capabilities: { docx_import: false, docx_export: true },
        }),
      ),
    VeraApiError,
  );
  assert.throws(
    () =>
      parseVeraStudioDocument(
        studioDocument({
          citation_anchors: [
            {
              ...studioDocument().citation_anchors[0],
              quote_sha256: HASH.toUpperCase(),
            },
          ],
        }),
      ),
    VeraApiError,
  );
  let nested: Record<string, unknown> = { page: 1 };
  for (let index = 0; index < 10; index += 1) nested = { child: nested };
  assert.throws(
    () =>
      parseVeraStudioDocument(
        studioDocument({
          citation_anchors: [
            { ...studioDocument().citation_anchors[0], locator: nested },
          ],
        }),
      ),
    VeraApiError,
  );
});

test("Matter draft page parser is strict, bounded, and preserves typed provenance", () => {
  const parsed = parseVeraStudioDraftPage(studioDraftPage());
  assert.equal(parsed.items[0]?.document_type, "contract_review_memo");
  assert.equal(parsed.items[0]?.origin_type, "assistant");
  assert.equal(parsed.items[0]?.source_count, 3);
  assert.equal(parsed.next_cursor, "draft-cursor-2");

  assert.throws(
    () => parseVeraStudioDraftPage(studioDraftPage({ storage_key: "/tmp/x" })),
    VeraApiError,
  );
  assert.throws(
    () =>
      parseVeraStudioDraftPage(
        studioDraftPage({
          items: [
            {
              ...((
                studioDraftPage().items as Array<Record<string, unknown>>
              )[0] ?? {}),
              origin_type: "model_guess",
            },
          ],
        }),
      ),
    VeraApiError,
  );
  assert.throws(
    () =>
      parseVeraStudioDraftPage(
        studioDraftPage({ has_more: false, next_cursor: "unexpected" }),
      ),
    VeraApiError,
  );
  assert.throws(
    () =>
      parseVeraStudioDraftPage(
        studioDraftPage({
          items: Array.from(
            { length: 101 },
            () =>
              (studioDraftPage().items as Array<Record<string, unknown>>)[0] ??
              {},
          ),
        }),
      ),
    VeraApiError,
  );
});

test("Matter draft list and blank creation remain Project-scoped", async () => {
  const restoreDesktop = installDesktop();
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: URL; init?: RequestInit; body: unknown }> = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ url, init, body });
    const value =
      init?.method === "POST"
        ? studioDocument()
        : studioDraftPage({ has_more: false, next_cursor: null });
    return new Response(JSON.stringify(value), {
      status: init?.method === "POST" ? 201 : 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    const page = await listVeraStudioDrafts(PROJECT_ID, { limit: 100 });
    assert.equal(page.items.length, 1);
    await createVeraStudioDocument(PROJECT_ID, {
      title: "Legal opinion",
      document_type: "legal_opinion",
    });
    assert.equal(
      calls[0]?.url.pathname,
      `/api/v1/projects/${PROJECT_ID}/studio/drafts`,
    );
    assert.equal(calls[0]?.url.searchParams.get("limit"), "100");
    assert.equal(calls[0]?.init?.method, "GET");
    assert.equal(
      calls[1]?.url.pathname,
      `/api/v1/projects/${PROJECT_ID}/studio/documents`,
    );
    assert.equal(calls[1]?.init?.method, "POST");
    assert.deepEqual(calls[1]?.body, {
      title: "Legal opinion",
      document_type: "legal_opinion",
    });
  } finally {
    globalThis.fetch = originalFetch;
    restoreDesktop();
  }
});

test("Project source content parser enforces a bounded path-free chunk wire", () => {
  const parsed = parseVeraProjectSourceContent(sourceContent());
  assert.equal(parsed.snapshot_id, SNAPSHOT_ID);
  assert.equal(parsed.document.version_id, SOURCE_VERSION_ID);
  assert.equal(parsed.chunks[0]?.text, SOURCE_CHUNK_TEXT);

  assert.throws(
    () =>
      parseVeraProjectSourceContent(
        sourceContent({ storage_key: "/private/vera/source.pdf" }),
      ),
    VeraApiError,
  );
  assert.throws(
    () =>
      parseVeraProjectSourceContent(
        sourceContent({
          chunks: [
            {
              ...sourceContent().chunks[0],
              content_sha256: digest(SOURCE_CHUNK_TEXT).toUpperCase(),
            },
          ],
        }),
      ),
    VeraApiError,
  );
  assert.throws(
    () =>
      parseVeraProjectSourceContent(
        sourceContent({
          document: {
            ...sourceContent().document,
            filename: "../../source.pdf",
          },
        }),
      ),
    VeraApiError,
  );
});

test("Project citation resolution uses only the scoped content route and rechecks exact hashes and offsets", async () => {
  const restoreDesktop = installDesktop();
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  let sourceResponse = sourceContent();
  globalThis.fetch = async (input, init) => {
    calls.push({ url: new URL(String(input)), init });
    return new Response(JSON.stringify(sourceResponse), {
      headers: { "Content-Type": "application/json" },
    });
  };
  const quoteStart = SOURCE_CHUNK_TEXT.indexOf(SOURCE_QUOTE);
  const citation = {
    snapshot_id: SNAPSHOT_ID,
    exact_quote: SOURCE_QUOTE,
    quote_sha256: digest(SOURCE_QUOTE),
    locator: {
      documentVersionId: SOURCE_VERSION_ID,
      chunkId: SOURCE_CHUNK_ID,
      chunkContentSha256: digest(SOURCE_CHUNK_TEXT),
      startOffset: quoteStart,
      endOffset: quoteStart + SOURCE_QUOTE.length,
      pageStart: 2,
      pageEnd: 2,
      ocr: { page: 2 },
    },
  };

  try {
    const direct = await getVeraProjectSourceContent(PROJECT_ID, SNAPSHOT_ID, {
      chunkId: SOURCE_CHUNK_ID,
    });
    assert.equal(direct.chunks[0]?.id, SOURCE_CHUNK_ID);
    const resolved = await resolveVeraProjectCitation(PROJECT_ID, citation);
    assert.equal(resolved.exact_quote, SOURCE_QUOTE);
    assert.equal(resolved.page, 2);
    assert.equal(
      resolved.chunk.text.slice(resolved.quote_start, resolved.quote_end),
      SOURCE_QUOTE,
    );
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.equal(
        call.url.pathname,
        `/api/v1/projects/${PROJECT_ID}/sources/${SNAPSHOT_ID}/content`,
      );
      assert.equal(call.url.searchParams.get("chunk_id"), SOURCE_CHUNK_ID);
      assert.equal(
        new Headers(call.init?.headers).get("Authorization"),
        `Bearer ${TOKEN}`,
      );
    }

    await assert.rejects(
      resolveVeraProjectCitation(PROJECT_ID, {
        ...citation,
        exact_quote: "A guessed replacement quote.",
      }),
      (error: unknown) =>
        error instanceof VeraApiError && error.code === "INVALID_RESPONSE",
    );

    sourceResponse = sourceContent({
      document: { ...sourceContent().document, page_count: 1 },
    });
    await assert.rejects(
      resolveVeraProjectCitation(PROJECT_ID, citation),
      (error: unknown) =>
        error instanceof VeraApiError && error.code === "INVALID_RESPONSE",
      "a poisoned chunk page must not exceed the authoritative document page count",
    );
  } finally {
    globalThis.fetch = originalFetch;
    restoreDesktop();
  }
});

test("Studio transport uses only Project-scoped create, load, CAS save, list, and restore routes", async () => {
  const restoreDesktop = installDesktop();
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: URL; init?: RequestInit; body: unknown }> = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ url, init, body });
    const value = url.pathname.endsWith("/versions")
      ? versions()
      : url.searchParams.get("version_id") === HISTORY_VERSION_ID
        ? studioDocument({
            version: {
              id: HISTORY_VERSION_ID,
              version_number: 1,
              source: "assistant_edit",
              filename: "contract-review-memo.md",
              mime_type: "text/markdown",
              size_bytes: 80,
              content_sha256: "b".repeat(64),
              created_at: "2026-07-15T09:00:00.000Z",
              citation_anchor_ids: [],
            },
            content: "# Historical draft",
            citation_anchors: [],
          })
        : studioDocument();
    return new Response(JSON.stringify(value), {
      status: init?.method === "POST" ? 201 : 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    await createVeraStudioDocument(PROJECT_ID, {
      title: "  Contract review memo  ",
      folder_id: null,
    });
    await getVeraStudioDocument(PROJECT_ID, DOCUMENT_ID);
    const history = await getVeraStudioDocument(
      PROJECT_ID,
      DOCUMENT_ID,
      HISTORY_VERSION_ID,
    );
    assert.equal(history.version.id, HISTORY_VERSION_ID);
    await saveVeraStudioDocument(PROJECT_ID, DOCUMENT_ID, {
      expected_version_id: CURRENT_VERSION_ID,
      content: "# Updated contract review",
      source: "user_upload",
      citation_anchor_ids: [ANCHOR_ID],
      summary: "Counsel edit",
    });
    await listVeraStudioVersions(PROJECT_ID, DOCUMENT_ID);
    await restoreVeraStudioVersion(
      PROJECT_ID,
      DOCUMENT_ID,
      HISTORY_VERSION_ID,
      { expected_current_version_id: CURRENT_VERSION_ID },
    );

    assert.equal(calls.length, 6);
    const root = `/api/v1/projects/${PROJECT_ID}/studio/documents`;
    assert.equal(calls[0]?.url.pathname, root);
    assert.equal(calls[0]?.init?.method, "POST");
    assert.deepEqual(calls[0]?.body, {
      title: "Contract review memo",
      folder_id: null,
    });
    assert.equal(calls[1]?.url.pathname, `${root}/${DOCUMENT_ID}`);
    assert.equal(calls[1]?.url.search, "");
    assert.equal(
      calls[2]?.url.searchParams.get("version_id"),
      HISTORY_VERSION_ID,
    );
    assert.equal(calls[3]?.init?.method, "PUT");
    assert.deepEqual(calls[3]?.body, {
      expected_version_id: CURRENT_VERSION_ID,
      content: "# Updated contract review",
      source: "user_upload",
      citation_anchor_ids: [ANCHOR_ID],
      summary: "Counsel edit",
    });
    assert.equal(calls[4]?.url.pathname, `${root}/${DOCUMENT_ID}/versions`);
    assert.equal(
      calls[5]?.url.pathname,
      `${root}/${DOCUMENT_ID}/versions/${HISTORY_VERSION_ID}/restore`,
    );
    assert.deepEqual(calls[5]?.body, {
      expected_current_version_id: CURRENT_VERSION_ID,
    });
    for (const call of calls) {
      const headers = new Headers(call.init?.headers);
      assert.equal(headers.get("Authorization"), `Bearer ${TOKEN}`);
      assert.equal(call.url.hostname, "127.0.0.1");
    }
  } finally {
    globalThis.fetch = originalFetch;
    restoreDesktop();
  }
});

test("Assistant and Workflow handoffs submit identity only and accept a real immutable Studio document", async () => {
  const restoreDesktop = installDesktop();
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: URL; init?: RequestInit; body: unknown }> = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ url, init, body });
    return new Response(
      JSON.stringify(
        studioDocument({
          version: {
            ...studioDocument().version,
            version_number: 1,
            source: "assistant_edit",
            citation_anchor_ids: [],
          },
          citation_anchors: [],
        }),
      ),
      { status: 201, headers: { "Content-Type": "application/json" } },
    );
  };
  try {
    const assistantDraft = await createVeraStudioDraftFromAssistant(
      PROJECT_ID,
      { chat_id: CHAT_ID, assistant_message_id: MESSAGE_ID },
    );
    const workflowDraft = await createVeraStudioDraftFromWorkflow(PROJECT_ID, {
      workflow_run_id: WORKFLOW_RUN_ID,
    });
    assert.equal(assistantDraft.version.version_number, 1);
    assert.equal(assistantDraft.version.source, "assistant_edit");
    assert.equal(workflowDraft.version.source, "assistant_edit");
    assert.equal(calls.length, 2);
    assert.equal(
      calls[0]?.url.pathname,
      `/api/v1/projects/${PROJECT_ID}/studio/drafts/from-assistant`,
    );
    assert.deepEqual(calls[0]?.body, {
      chat_id: CHAT_ID,
      assistant_message_id: MESSAGE_ID,
    });
    assert.equal(
      calls[1]?.url.pathname,
      `/api/v1/projects/${PROJECT_ID}/studio/drafts/from-workflow`,
    );
    assert.deepEqual(calls[1]?.body, { workflow_run_id: WORKFLOW_RUN_ID });
    for (const call of calls) {
      assert.equal(call.init?.method, "POST");
      assert.deepEqual(
        Object.keys(call.body as object).sort(),
        call === calls[0]
          ? ["assistant_message_id", "chat_id"]
          : ["workflow_run_id"],
      );
      assert.equal(
        new Headers(call.init?.headers).get("Authorization"),
        `Bearer ${TOKEN}`,
      );
    }
    await assert.rejects(
      createVeraStudioDraftFromAssistant(PROJECT_ID, {
        chat_id: CHAT_ID,
        assistant_message_id: "not-a-message-id",
      }),
    );
    assert.equal(calls.length, 2, "invalid identity never reaches fetch");
  } finally {
    globalThis.fetch = originalFetch;
    restoreDesktop();
  }
});

test("Studio current load rejects a historical version as the editable CAS baseline", async () => {
  const restoreDesktop = installDesktop();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify(
        studioDocument({
          version: {
            ...studioDocument().version,
            id: HISTORY_VERSION_ID,
            version_number: 1,
          },
          content: "# Historical response presented as current",
        }),
      ),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );

  try {
    await assert.rejects(
      getVeraStudioDocument(PROJECT_ID, DOCUMENT_ID),
      VeraApiError,
    );
    const historical = await getVeraStudioDocument(
      PROJECT_ID,
      DOCUMENT_ID,
      HISTORY_VERSION_ID,
    );
    assert.equal(historical.version.id, HISTORY_VERSION_ID);
    assert.equal(historical.current_version_id, CURRENT_VERSION_ID);
  } finally {
    globalThis.fetch = originalFetch;
    restoreDesktop();
  }
});

test("Studio CAS conflict remains an explicit 409 and invalid citation writes never reach fetch", async () => {
  const restoreDesktop = installDesktop();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(
      JSON.stringify({
        code: "CONFLICT",
        detail: "Document has changed since the expected version.",
      }),
      {
        status: 409,
        headers: { "Content-Type": "application/json" },
      },
    );
  };
  try {
    await assert.rejects(
      saveVeraStudioDocument(PROJECT_ID, DOCUMENT_ID, {
        expected_version_id: CURRENT_VERSION_ID,
        content: "local edits",
        source: "user_upload",
      }),
      (error) =>
        error instanceof VeraApiError &&
        error.status === 409 &&
        error.code === "CONFLICT",
    );
    assert.equal(calls, 1);
    await assert.rejects(
      saveVeraStudioDocument(PROJECT_ID, DOCUMENT_ID, {
        expected_version_id: CURRENT_VERSION_ID,
        content: "local edits",
        source: "user_upload",
        citation_anchor_ids: [ANCHOR_ID, ANCHOR_ID],
      }),
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    restoreDesktop();
  }
});

test("Studio DOCX transport sends strict multipart CAS input and exports the exact immutable version", async () => {
  const restoreDesktop = installDesktop();
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    if (url.pathname.endsWith("/import-docx")) {
      return new Response(
        JSON.stringify({
          document: studioDocument({
            current_version_id: IMPORT_VERSION_ID,
            version: {
              ...studioDocument().version,
              id: IMPORT_VERSION_ID,
              version_number: 3,
              source: "user_upload",
            },
            content: "# Imported DOCX",
          }),
          warnings: ["DOCX_FORMATTING_SIMPLIFIED"],
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(new Uint8Array([80, 75, 3, 4]), {
      status: 200,
      headers: {
        "Content-Type": VERA_STUDIO_DOCX_MIME_TYPE,
        "Content-Disposition": 'attachment; filename="route-audit.docx"',
        "X-Vera-Warning-Codes":
          "MARKDOWN_HTML_AS_TEXT,MARKDOWN_BLOCKQUOTE_SIMPLIFIED",
      },
    });
  };

  try {
    const file = new File([new Uint8Array([80, 75, 3, 4])], "motion.docx", {
      type: VERA_STUDIO_DOCX_MIME_TYPE,
    });
    const imported = await importVeraStudioDocx(
      PROJECT_ID,
      DOCUMENT_ID,
      CURRENT_VERSION_ID,
      file,
    );
    assert.equal(imported.document.current_version_id, IMPORT_VERSION_ID);
    assert.deepEqual(imported.warnings, ["DOCX_FORMATTING_SIMPLIFIED"]);

    const downloaded = await exportVeraStudioDocx(
      PROJECT_ID,
      DOCUMENT_ID,
      HISTORY_VERSION_ID,
    );
    assert.equal(downloaded.filename, "route-audit.docx");
    assert.equal(downloaded.blob.type, VERA_STUDIO_DOCX_MIME_TYPE);
    assert.deepEqual(downloaded.warningCodes, [
      "MARKDOWN_HTML_AS_TEXT",
      "MARKDOWN_BLOCKQUOTE_SIMPLIFIED",
    ]);

    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.init?.method, "POST");
    assert.equal(
      calls[0]?.url.pathname,
      `/api/v1/projects/${PROJECT_ID}/studio/documents/${DOCUMENT_ID}/import-docx`,
    );
    const form = calls[0]?.init?.body;
    assert.ok(form instanceof FormData);
    assert.deepEqual([...form.keys()], ["expected_version_id", "file"]);
    assert.equal(form.get("expected_version_id"), CURRENT_VERSION_ID);
    const uploaded = form.get("file");
    assert.ok(uploaded instanceof File);
    assert.equal(uploaded.name, "motion.docx");
    assert.equal(
      new Headers(calls[0]?.init?.headers).has("content-type"),
      false,
    );
    assert.equal(
      calls[1]?.url.pathname,
      `/api/v1/projects/${PROJECT_ID}/studio/documents/${DOCUMENT_ID}/export-docx`,
    );
    assert.equal(
      calls[1]?.url.searchParams.get("version_id"),
      HISTORY_VERSION_ID,
    );
    for (const call of calls) {
      assert.equal(
        new Headers(call.init?.headers).get("Authorization"),
        `Bearer ${TOKEN}`,
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
    restoreDesktop();
  }
});

test("Studio DOCX client fails closed on poisoned import bodies, files, and warning headers", async () => {
  assert.throws(
    () =>
      parseVeraStudioDocxImport({
        document: studioDocument(),
        warnings: ["UNKNOWN_WARNING"],
      }),
    VeraApiError,
  );
  assert.throws(
    () =>
      parseVeraStudioDocxImport({
        document: studioDocument(),
        warnings: [],
        storage_path: "/private/secret",
      }),
    VeraApiError,
  );

  const restoreDesktop = installDesktop();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(new Uint8Array([80, 75, 3, 4]), {
      status: 200,
      headers: {
        "Content-Type": VERA_STUDIO_DOCX_MIME_TYPE,
        "Content-Disposition": 'attachment; filename="safe.docx"',
        "X-Vera-Warning-Codes": "MARKDOWN_HTML_AS_TEXT,MARKDOWN_HTML_AS_TEXT",
      },
    });
  };
  try {
    await assert.rejects(
      exportVeraStudioDocx(PROJECT_ID, DOCUMENT_ID, CURRENT_VERSION_ID),
      (error) =>
        error instanceof VeraApiError && error.code === "INVALID_RESPONSE",
    );
    assert.equal(calls, 1);
    await assert.rejects(
      importVeraStudioDocx(
        PROJECT_ID,
        DOCUMENT_ID,
        CURRENT_VERSION_ID,
        new File([], "empty.docx", { type: VERA_STUDIO_DOCX_MIME_TYPE }),
      ),
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    restoreDesktop();
  }
});

test("Project document parser accepts only coherent real Studio capability combinations", async () => {
  const restoreDesktop = installDesktop();
  const originalFetch = globalThis.fetch;
  let capability: Record<string, unknown> = {
    editable: true,
    format: "markdown",
    docx_import: true,
    docx_export: true,
  };
  const projectedDocument = () => ({
    id: DOCUMENT_ID,
    user_id: "00000000-0000-4000-8000-000000000001",
    project_id: PROJECT_ID,
    folder_id: null,
    filename: "contract-review-memo.md",
    owner_email: null,
    owner_display_name: "Local User",
    file_type: "md",
    storage_path: null,
    pdf_storage_path: null,
    size_bytes: 120,
    page_count: null,
    structure_tree: null,
    status: "ready",
    created_at: "2026-07-15T10:00:00.000Z",
    updated_at: "2026-07-15T10:00:00.000Z",
    active_version_number: 2,
    latest_version_number: 2,
    ocr_summary: null,
    studio_capability: capability,
  });
  globalThis.fetch = async () =>
    new Response(JSON.stringify([projectedDocument()]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  try {
    assert.equal((await listVeraProjectDocuments(PROJECT_ID)).length, 1);
    capability = {
      editable: false,
      format: null,
      docx_import: false,
      docx_export: false,
    };
    assert.equal((await listVeraProjectDocuments(PROJECT_ID)).length, 1);
    for (const poisoned of [
      {
        editable: true,
        format: "markdown",
        docx_import: false,
        docx_export: true,
      },
      {
        editable: false,
        format: "markdown",
        docx_import: false,
        docx_export: false,
      },
      {
        editable: false,
        format: null,
        docx_import: true,
        docx_export: false,
      },
    ]) {
      capability = poisoned;
      await assert.rejects(listVeraProjectDocuments(PROJECT_ID), VeraApiError);
    }
  } finally {
    globalThis.fetch = originalFetch;
    restoreDesktop();
  }
});

test("Studio suggestion preview/detail and explicit decisions use strict empty-body scoped transport", async () => {
  assert.equal(
    parseVeraStudioSuggestionPreview(suggestionPreview()).status,
    "pending",
  );
  assert.equal(
    parseVeraStudioSuggestion(suggestionDetail()).deleted_text,
    "old",
  );
  assert.equal(
    [
      ...parseVeraStudioSuggestionPreview(
        suggestionPreview({ summary: "😀".repeat(500) }),
      ).summary,
    ].length,
    500,
  );
  assert.throws(
    () =>
      parseVeraStudioSuggestionPreview(
        suggestionPreview({ summary: "😀".repeat(501) }),
      ),
    VeraApiError,
  );

  const restoreDesktop = installDesktop();
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: URL; method: string; body: unknown }> = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ url, method, body });
    let payload: unknown;
    if (url.pathname.endsWith(`/${SUGGESTION_ID}/accept`)) {
      payload = {
        suggestion: suggestionDetail({
          status: "accepted",
          resolved_at: "2026-07-15T10:31:00.000Z",
          result_version_id: RESULT_VERSION_ID,
        }),
        document: studioDocument({
          current_version_id: RESULT_VERSION_ID,
          version: {
            ...studioDocument().version,
            id: RESULT_VERSION_ID,
            version_number: 3,
            source: "user_accept",
          },
          content: "Hello new world.",
        }),
      };
    } else if (url.pathname.endsWith(`/${SUGGESTION_ID}/reject`)) {
      payload = {
        suggestion: suggestionDetail({
          status: "rejected",
          resolved_at: "2026-07-15T10:31:00.000Z",
        }),
      };
    } else if (url.pathname.endsWith(`/${SUGGESTION_ID}`)) {
      payload = { suggestion: suggestionDetail() };
    } else {
      payload = { suggestions: [suggestionPreview()], has_more: false };
    }
    return new Response(JSON.stringify(payload), {
      status: method === "POST" ? 201 : 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const page = await listVeraStudioSuggestions(PROJECT_ID, DOCUMENT_ID);
    assert.equal(page.suggestions[0]?.id, SUGGESTION_ID);
    assert.equal(page.has_more, false);
    assert.equal(
      (await getVeraStudioSuggestion(PROJECT_ID, DOCUMENT_ID, SUGGESTION_ID))
        .inserted_text,
      "new",
    );
    const accepted = await acceptVeraStudioSuggestion(PROJECT_ID, DOCUMENT_ID, {
      reviewedSuggestion: parseVeraStudioSuggestion(suggestionDetail()),
      baseDocument: parseVeraStudioDocument(
        studioDocument({ content: "Hello old world." }),
      ),
    });
    assert.equal(accepted.document.version.source, "user_accept");
    assert.equal(accepted.suggestion.result_version_id, RESULT_VERSION_ID);
    assert.equal(
      (await rejectVeraStudioSuggestion(PROJECT_ID, DOCUMENT_ID, SUGGESTION_ID))
        .status,
      "rejected",
    );
    assert.equal(calls.length, 4);
    const root = `/api/v1/projects/${PROJECT_ID}/studio/documents/${DOCUMENT_ID}/suggestions`;
    assert.equal(calls[0]?.url.pathname, root);
    assert.equal(calls[1]?.url.pathname, `${root}/${SUGGESTION_ID}`);
    assert.equal(calls[2]?.url.pathname, `${root}/${SUGGESTION_ID}/accept`);
    assert.equal(calls[3]?.url.pathname, `${root}/${SUGGESTION_ID}/reject`);
    assert.deepEqual(calls[2]?.body, {});
    assert.deepEqual(calls[3]?.body, {});
    assert.equal(calls[2]?.method, "POST");
    assert.equal(calls[3]?.method, "POST");
  } finally {
    globalThis.fetch = originalFetch;
    restoreDesktop();
  }
});

test("Studio suggestion clients reject duplicate and poisoned cross-scope bindings", async () => {
  const restoreDesktop = installDesktop();
  const originalFetch = globalThis.fetch;
  let payload: unknown = {};
  globalThis.fetch = async () =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  try {
    const acceptanceExpectation = {
      reviewedSuggestion: parseVeraStudioSuggestion(suggestionDetail()),
      baseDocument: parseVeraStudioDocument(
        studioDocument({ content: "Hello old world." }),
      ),
    };
    const acceptReviewedSuggestion = () =>
      acceptVeraStudioSuggestion(
        PROJECT_ID,
        DOCUMENT_ID,
        acceptanceExpectation,
      );
    payload = {
      suggestions: [suggestionPreview(), suggestionPreview()],
      has_more: false,
    };
    await assert.rejects(
      listVeraStudioSuggestions(PROJECT_ID, DOCUMENT_ID),
      VeraApiError,
    );

    payload = {
      suggestions: [suggestionPreview({ project_id: SOURCE_DOCUMENT_ID })],
      has_more: false,
    };
    await assert.rejects(
      listVeraStudioSuggestions(PROJECT_ID, DOCUMENT_ID),
      VeraApiError,
    );

    payload = {
      suggestion: suggestionDetail({ document_id: SOURCE_DOCUMENT_ID }),
    };
    await assert.rejects(
      getVeraStudioSuggestion(PROJECT_ID, DOCUMENT_ID, SUGGESTION_ID),
      VeraApiError,
    );

    payload = {
      suggestion: suggestionDetail({
        id: SOURCE_CHUNK_ID,
        status: "accepted",
        resolved_at: "2026-07-15T10:31:00.000Z",
        result_version_id: RESULT_VERSION_ID,
      }),
      document: studioDocument({
        current_version_id: RESULT_VERSION_ID,
        version: {
          ...studioDocument().version,
          id: RESULT_VERSION_ID,
          version_number: 3,
          source: "user_accept",
        },
      }),
    };
    await assert.rejects(acceptReviewedSuggestion(), VeraApiError);

    const acceptedSuggestion = {
      status: "accepted",
      resolved_at: "2026-07-15T10:31:00.000Z",
      result_version_id: RESULT_VERSION_ID,
    };
    const acceptedVersion = {
      ...studioDocument().version,
      id: RESULT_VERSION_ID,
      version_number: 3,
      source: "user_accept",
    };
    payload = {
      suggestion: suggestionDetail(acceptedSuggestion),
      document: studioDocument({
        current_version_id: RESULT_VERSION_ID,
        version: acceptedVersion,
        content: "poisoned accepted content",
      }),
    };
    await assert.rejects(acceptReviewedSuggestion(), VeraApiError);

    payload = {
      suggestion: suggestionDetail(acceptedSuggestion),
      document: studioDocument({
        current_version_id: RESULT_VERSION_ID,
        version: { ...acceptedVersion, citation_anchor_ids: [] },
        citation_anchors: [],
        content: "Hello new world.",
      }),
    };
    await assert.rejects(acceptReviewedSuggestion(), VeraApiError);

    payload = {
      suggestion: suggestionDetail(acceptedSuggestion),
      document: studioDocument({
        current_version_id: RESULT_VERSION_ID,
        version: { ...acceptedVersion, source: "user_upload" },
        content: "Hello new world.",
      }),
    };
    await assert.rejects(acceptReviewedSuggestion(), VeraApiError);

    payload = {
      suggestion: suggestionDetail({
        ...acceptedSuggestion,
        inserted_text: "poison",
      }),
      document: studioDocument({
        current_version_id: RESULT_VERSION_ID,
        version: acceptedVersion,
        content: "Hello poison world.",
      }),
    };
    await assert.rejects(acceptReviewedSuggestion(), VeraApiError);

    payload = {
      suggestion: suggestionDetail({
        project_id: SOURCE_DOCUMENT_ID,
        status: "rejected",
        resolved_at: "2026-07-15T10:31:00.000Z",
      }),
    };
    await assert.rejects(
      rejectVeraStudioSuggestion(PROJECT_ID, DOCUMENT_ID, SUGGESTION_ID),
      VeraApiError,
    );
  } finally {
    globalThis.fetch = originalFetch;
    restoreDesktop();
  }
});
