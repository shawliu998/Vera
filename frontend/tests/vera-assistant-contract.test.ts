import assert from "node:assert/strict";
import test from "node:test";

import {
  assertNoVeraAssistantSensitiveFields,
  parseVeraAssistantChatDetail,
  parseVeraAssistantGenerationStatus,
  parseVeraAssistantReplay,
  parseVeraAssistantSseResponse,
  parseVeraAssistantStreamEvent,
  streamVeraAssistantJob,
} from "../src/app/lib/veraAssistantApi.ts";
import {
  collectVeraAssistantReplay,
  toUiMessage,
} from "../src/app/hooks/useAssistantChat.ts";
import { VeraApiError } from "../src/app/lib/veraApi.ts";

const chatId = "11111111-1111-4111-8111-111111111111";
const jobId = "22222222-2222-4222-8222-222222222222";
const promptId = "33333333-3333-4333-8333-333333333333";
const outputId = "44444444-4444-4444-8444-444444444444";
const documentId = "55555555-5555-4555-8555-555555555555";
const versionId = "66666666-6666-4666-8666-666666666666";
const localUserId = "00000000-0000-4000-8000-000000000001";
const now = "2026-07-15T01:02:03.004Z";
const token = "vdt_1234567890abcdefghijklmnopqrstuvwxyz";

function status(
  state:
    "queued" | "running" | "complete" | "failed" | "cancelled" | "interrupted",
) {
  const terminal = ["complete", "failed", "cancelled", "interrupted"].includes(
    state,
  );
  return {
    job_id: jobId,
    chat_id: chatId,
    prompt_message_id: promptId,
    output_message_id: outputId,
    status: state,
    attempt: 1,
    active_attempt: 1,
    max_attempts: 3,
    retryable: state === "failed" || state === "interrupted",
    cancel_requested: state === "running",
    terminal,
  };
}

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of stream) values.push(value);
  return values;
}

test("Assistant chat/status contracts require exact canonical local wire data", () => {
  const detail = parseVeraAssistantChatDetail({
    chat: {
      id: chatId,
      project_id: null,
      user_id: localUserId,
      title: "合同分析",
      created_at: now,
    },
    messages: [
      {
        id: promptId,
        chat_id: chatId,
        role: "user",
        content: "请总结。",
        files: [
          {
            filename: "agreement.pdf",
            document_id: documentId,
            version_id: versionId,
            capability: { can_read: true, can_download: true },
          },
        ],
        created_at: now,
      },
      {
        id: outputId,
        chat_id: chatId,
        role: "assistant",
        content: [{ type: "content", text: "结论 [1]。" }],
        citations: [
          {
            type: "citation_data",
            kind: "document",
            ref: 1,
            doc_id: documentId,
            document_id: documentId,
            version_id: versionId,
            filename: "agreement.pdf",
            page: 2,
            quote: "引用内容",
            quotes: [{ page: 2, quote: "引用内容" }],
          },
        ],
        created_at: now,
      },
    ],
  });
  assert.equal(detail.messages.length, 2);
  assert.equal(detail.messages[1].created_at, now);

  for (const state of [
    "queued",
    "running",
    "complete",
    "failed",
    "cancelled",
    "interrupted",
  ] as const) {
    assert.equal(
      parseVeraAssistantGenerationStatus(status(state)).status,
      state,
    );
  }

  for (const malformedTimestamp of [
    "2026-07-15T01:02:03Z",
    "2026-07-15T09:02:03.004+08:00",
    "2026-02-30T01:02:03.004Z",
  ]) {
    assert.throws(
      () =>
        parseVeraAssistantChatDetail({
          chat: {
            id: chatId,
            project_id: null,
            user_id: localUserId,
            title: null,
            created_at: malformedTimestamp,
          },
          messages: [],
        }),
      VeraApiError,
    );
  }

  assert.throws(
    () =>
      parseVeraAssistantGenerationStatus({
        ...status("running"),
        active_attempt: null,
      }),
    VeraApiError,
  );
  assert.throws(
    () =>
      parseVeraAssistantGenerationStatus({
        ...status("failed"),
        terminal: false,
      }),
    VeraApiError,
  );
});

test("legal authority citations expose only bounded title, locator, type, and exact quote", () => {
  const detail = parseVeraAssistantChatDetail({
    chat: {
      id: chatId,
      project_id: chatId,
      user_id: localUserId,
      title: "Matter research",
      created_at: now,
    },
    messages: [
      {
        id: outputId,
        chat_id: chatId,
        role: "assistant",
        content: [{ type: "content", text: "适用规则 [1]。" }],
        citations: [
          {
            type: "citation_data",
            kind: "legal_authority",
            ref: 1,
            title: "中华人民共和国民法典",
            source_type: "statute",
            locator: { article: "第五百零九条", paragraph: "第一款" },
            quote: "当事人应当按照约定全面履行自己的义务。",
          },
        ],
        created_at: now,
      },
    ],
  });
  assert.deepEqual(detail.messages[0].citations?.[0], {
    type: "citation_data",
    kind: "legal_authority",
    ref: 1,
    title: "中华人民共和国民法典",
    source_type: "statute",
    locator: { article: "第五百零九条", paragraph: "第一款" },
    quote: "当事人应当按照约定全面履行自己的义务。",
  });
  assert.equal(toUiMessage(detail.messages[0]).annotations?.[0].kind, "legal_authority");

  for (const forbidden of [
    { url: "blocked endpoint" },
    { snapshot_id: documentId },
    { full_text: "provider full text" },
    { authorization: "credential material" },
  ]) {
    assert.throws(
      () =>
        parseVeraAssistantChatDetail({
          chat: detail.chat,
          messages: [
            {
              id: outputId,
              chat_id: chatId,
              role: "assistant",
              content: "Rule [1].",
              citations: [
                {
                  ...(detail.messages[0].citations?.[0] ?? {}),
                  ...forbidden,
                },
              ],
              created_at: now,
            },
          ],
        }),
      VeraApiError,
    );
  }
});

test("completed chat detail restores its bounded durable Draft projection on refresh", () => {
  const draftEvent = {
    type: "draft_created" as const,
    draft_id: documentId,
    version_id: versionId,
    title: "Legal opinion",
    route: `/projects/${chatId}/documents/${documentId}/studio`,
  };
  const detail = parseVeraAssistantChatDetail({
    chat: {
      id: chatId,
      project_id: chatId,
      user_id: localUserId,
      title: "Matter chat",
      created_at: now,
    },
    messages: [
      {
        id: outputId,
        chat_id: chatId,
        role: "assistant",
        content: [{ type: "content", text: "Draft complete." }],
        events: [draftEvent],
        created_at: now,
      },
    ],
  });
  const restored = toUiMessage(detail.messages[0]);
  assert.deepEqual(restored.events, [
    { type: "content", text: "Draft complete." },
    draftEvent,
  ]);

  assert.throws(
    () =>
      parseVeraAssistantChatDetail({
        chat: detail.chat,
        messages: [
          {
            id: promptId,
            chat_id: chatId,
            role: "user",
            content: "Prompt",
            events: [draftEvent],
            created_at: now,
          },
        ],
      }),
    VeraApiError,
  );
  assert.throws(
    () =>
      parseVeraAssistantChatDetail({
        chat: detail.chat,
        messages: [
          {
            id: outputId,
            chat_id: chatId,
            role: "assistant",
            content: "Done",
            events: [{ type: "content_done" }],
            created_at: now,
          },
        ],
      }),
    VeraApiError,
  );
  for (const projectId of [null, jobId]) {
    assert.throws(
      () =>
        parseVeraAssistantChatDetail({
          chat: { ...detail.chat, project_id: projectId },
          messages: [
            {
              id: outputId,
              chat_id: chatId,
              role: "assistant",
              content: "Done",
              events: [draftEvent],
              created_at: now,
            },
          ],
        }),
      VeraApiError,
    );
  }
});

test("JSON recovery drains more than 100 durable events through the terminal event", async () => {
  const firstPageEvents = Array.from({ length: 100 }, (_, index) => ({
    cursor: index + 1,
    attempt: 1,
    event: { type: "reasoning_delta" as const, text: `r${index}` },
    terminal: false,
    created_at: now,
  }));
  const draftEvent = {
    type: "draft_created" as const,
    draft_id: documentId,
    version_id: versionId,
    title: "Legal opinion",
    route: `/projects/${chatId}/documents/${documentId}/studio`,
  };
  const cursors: number[] = [];
  const replay = await collectVeraAssistantReplay(
    jobId,
    undefined,
    async (_requestedJobId, cursor) => {
      cursors.push(cursor);
      if (cursor === 0) {
        return {
          job_id: jobId,
          status: "running",
          attempt: 1,
          terminal: false,
          events: firstPageEvents,
          next_cursor: 100,
        };
      }
      return {
        job_id: jobId,
        status: "complete",
        attempt: 1,
        terminal: true,
        events: [
          {
            cursor: 101,
            attempt: 1,
            event: draftEvent,
            terminal: false,
            created_at: now,
          },
          {
            cursor: 102,
            attempt: 1,
            event: { type: "complete", message_id: outputId, job_id: jobId },
            terminal: true,
            created_at: now,
          },
        ],
        next_cursor: 102,
      };
    },
  );
  assert.deepEqual(cursors, [0, 100]);
  assert.equal(replay.events.length, 102);
  assert.equal(replay.nextCursor, 102);
  assert.equal(replay.terminalEventSeen, true);
  assert.deepEqual(replay.events[100].event, draftEvent);

  await assert.rejects(
    collectVeraAssistantReplay(jobId, undefined, async () => ({
      job_id: jobId,
      status: "running",
      attempt: 1,
      terminal: false,
      events: firstPageEvents,
      next_cursor: 0,
    })),
    /cursor did not advance canonically/,
  );
});

test("Assistant parser rejects secrets and raw provider payloads recursively", () => {
  for (const unsafe of [
    { nested: { api_key: "never" } },
    { items: [{ credential_ref: "keychain-account" }] },
    { event: { raw_provider_response: { id: "provider-object" } } },
    { provider_response_body: "raw upstream body" },
  ]) {
    assert.throws(
      () => assertNoVeraAssistantSensitiveFields(unsafe),
      VeraApiError,
    );
  }

  assert.doesNotThrow(() =>
    assertNoVeraAssistantSensitiveFields({
      type: "citation_data",
      ref: 1,
      document_id: documentId,
    }),
  );
  assert.throws(
    () =>
      parseVeraAssistantStreamEvent({
        type: "content_delta",
        text: "ok",
        extra: true,
      }),
    VeraApiError,
  );
  for (const name of [
    "read_studio_document",
    "suggest_studio_edit",
    "create_draft",
    "read_draft",
    "suggest_draft_edit",
    "run_workflow",
    "get_workflow_run",
    "search_legal_sources",
    "read_legal_source",
  ] as const) {
    assert.deepEqual(
      parseVeraAssistantStreamEvent({ type: "tool_call_start", name }),
      {
        type: "tool_call_start",
        name,
      },
    );
  }
  const draftEvent = {
    type: "draft_created" as const,
    draft_id: documentId,
    version_id: versionId,
    title: "Legal opinion",
    route: `/projects/${chatId}/documents/${documentId}/studio`,
  };
  assert.deepEqual(parseVeraAssistantStreamEvent(draftEvent), draftEvent);
  assert.throws(
    () =>
      parseVeraAssistantStreamEvent({
        ...draftEvent,
        route: `/projects/${chatId}/documents/${versionId}/studio`,
      }),
    VeraApiError,
  );
});

test("durable replay validates terminal attempts, ordered cursors, and exact events", () => {
  const replay = parseVeraAssistantReplay({
    job_id: jobId,
    status: "failed",
    attempt: 1,
    terminal: true,
    events: [
      {
        cursor: 1,
        attempt: 1,
        event: { type: "status", job_id: jobId, status: "running" },
        terminal: false,
        created_at: now,
      },
      {
        cursor: 2,
        attempt: 1,
        event: {
          type: "error",
          code: "assistant_model_failed",
          message: "failed",
        },
        terminal: true,
        created_at: now,
      },
    ],
    next_cursor: 2,
  });
  assert.equal(replay.events[1].terminal, true);
  assert.equal(replay.next_cursor, 2);

  assert.throws(
    () =>
      parseVeraAssistantReplay({
        ...replay,
        events: [replay.events[1], replay.events[0]],
      }),
    VeraApiError,
  );
});

test("Assistant SSE accepts durable ids and heartbeat frames but fails closed", async () => {
  const body = [
    ": keep-alive\n\n",
    `id: 1\ndata: ${JSON.stringify({ type: "chat_id", chatId })}\n\n`,
    `id: 2\ndata: ${JSON.stringify({ type: "content_delta", text: "你好" })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
  const items = await collect(
    parseVeraAssistantSseResponse(
      new Response(body, {
        headers: { "Content-Type": "text/event-stream; charset=utf-8" },
      }),
    ),
  );
  assert.deepEqual(items, [
    { kind: "event", cursor: 1, event: { type: "chat_id", chatId } },
    {
      kind: "event",
      cursor: 2,
      event: { type: "content_delta", text: "你好" },
    },
    { kind: "done" },
  ]);

  await assert.rejects(
    async () =>
      collect(
        parseVeraAssistantSseResponse(
          new Response('id: 1\ndata: {"type":"unknown"}\n\n', {
            headers: { "Content-Type": "text/event-stream" },
          }),
        ),
      ),
    VeraApiError,
  );
});

test("idle SSE EOF checks authoritative status, backs off, and resumes from cursor", async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      aletheiaDesktop: {
        async getInfo() {
          return { workspaceApiUrl: "http://127.0.0.1:43123/api/v1" };
        },
        async getAuthToken() {
          return token;
        },
      },
    },
  });

  const calls: Array<{ url: string; headers: Headers }> = [];
  let eventCalls = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, headers });
    if (url.endsWith(`/assistant/jobs/${jobId}/events`)) {
      eventCalls += 1;
      return new Response(
        eventCalls === 1 ? ": keep-alive\n\n" : "data: [DONE]\n\n",
        { headers: { "Content-Type": "text/event-stream" } },
      );
    }
    if (url.endsWith(`/assistant/jobs/${jobId}`)) {
      return Response.json(status("running"));
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    const events = await collect(streamVeraAssistantJob(jobId, { cursor: 7 }));
    assert.deepEqual(events, []);
    assert.equal(eventCalls, 2);
    const eventRequests = calls.filter((call) => call.url.endsWith("/events"));
    assert.equal(eventRequests[0].headers.get("Last-Event-ID"), "7");
    assert.equal(eventRequests[1].headers.get("Last-Event-ID"), "7");
    assert.ok(
      calls.some((call) => call.url.endsWith(`/assistant/jobs/${jobId}`)),
    );
    assert.ok(
      calls.every(
        (call) => call.headers.get("Authorization") === `Bearer ${token}`,
      ),
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow) {
      Object.defineProperty(globalThis, "window", originalWindow);
    } else {
      Reflect.deleteProperty(globalThis, "window");
    }
  }
});
