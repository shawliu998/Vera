import assert from "node:assert/strict";

import { normalizeModelEndpoint } from "../lib/workspace/modelCompatibility";
import type { StoredModelProfileRecord } from "../lib/workspace/repositories/modelProfiles";
import { buildEndpointBindingSnapshot } from "../lib/workspace/services/modelGateway";
import {
  createModelProvider,
  type ModelEvent,
  type ModelGenerateRequest,
  type ModelProviderConfig,
  type ModelProviderCredentialResolver,
} from "../lib/workspace/providers";
import { readBoundedJsonSse } from "../lib/workspace/providers/sse";

const SECRET = "provider-secret-must-never-escape";
const PROFILE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

type Provider = StoredModelProfileRecord["provider"];
type Capture = {
  url: string;
  method: string;
  headers: Headers;
  body: Record<string, unknown> | null;
  signal: AbortSignal | null;
  redirect: RequestRedirect | undefined;
};

const MODELS: Record<Provider, string> = {
  openai: "gpt-5.4",
  deepseek: "deepseek-v4-pro",
  anthropic: "claude-sonnet-4-6",
  gemini: "gemini-3.5-flash",
  openai_compatible: "local-compatible-model",
};

const BASE_URLS: Record<Provider, string | null> = {
  openai: null,
  deepseek: null,
  anthropic: null,
  gemini: null,
  openai_compatible: "https://gateway.example.test/v1",
};

function profile(
  provider: Provider,
  overrides: Partial<StoredModelProfileRecord> = {},
): StoredModelProfileRecord {
  const endpoint = normalizeModelEndpoint({
    provider,
    baseUrl: BASE_URLS[provider],
  });
  return {
    id: PROFILE_ID,
    name: `${provider} profile`,
    provider,
    model: MODELS[provider],
    baseUrl: endpoint.baseUrl,
    credentialStatus: "configured",
    credentialRef: `keychain://vera/model-profile/${PROFILE_ID}/abcdefghijklmnop`,
    credentialOrigin: endpoint.canonicalOrigin,
    credentialState: "configured",
    migrationIssueCode: null,
    executionRevision: 7,
    contextWindowTokens: 128_000,
    maxOutputTokens: 8192,
    enabled: true,
    capabilities: {
      streaming: true,
      toolCalling: true,
      structuredOutput: true,
      vision: false,
    },
    isDefault: false,
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
    ...overrides,
  };
}

function config(
  provider: Provider,
  overrides: Partial<StoredModelProfileRecord> = {},
): ModelProviderConfig {
  const value = profile(provider, overrides);
  return {
    profile: value,
    expectedBinding: buildEndpointBindingSnapshot(value),
  };
}

function resolver(calls: unknown[]): ModelProviderCredentialResolver {
  return {
    async resolve(input) {
      calls.push(input);
      return SECRET;
    },
  };
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sse(blocks: Array<Record<string, unknown> | "[DONE]">) {
  const body = blocks
    .map((block) =>
      block === "[DONE]"
        ? "data: [DONE]\n\n"
        : `data: ${JSON.stringify(block)}\n\n`,
    )
    .join("");
  return new Response(body, {
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  });
}

function anthropicSse(blocks: Record<string, unknown>[]) {
  return new Response(
    blocks
      .map(
        (block) =>
          `event: ${String(block.type)}\ndata: ${JSON.stringify(block)}\n\n`,
      )
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function validationPayload(provider: Provider) {
  if (provider === "deepseek" || provider === "openai_compatible") {
    return { data: [{ id: MODELS[provider] }] };
  }
  if (provider === "gemini") return { name: `models/${MODELS[provider]}` };
  return { id: MODELS[provider] };
}

function request(
  provider: Provider,
  options: { schema?: boolean } = {},
): ModelGenerateRequest {
  return {
    model: MODELS[provider],
    messages: [
      { role: "system", content: "Be precise." },
      { role: "user", content: "Summarize the contract." },
      { role: "tool", content: "Document lookup completed." },
    ],
    temperature: 0.2,
    maxOutputTokens: 1024,
    responseFormat: {
      type: "json",
      ...(options.schema
        ? {
            schema: {
              type: "object",
              properties: { answer: { type: "string" } },
              required: ["answer"],
              additionalProperties: false,
            },
          }
        : {}),
    },
    tools: [
      {
        name: "lookup_document",
        description: "Read a Project document.",
        parameters: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
        strict: true,
      },
    ],
    metadata: { surface: "assistant" },
  };
}

async function collect(iterable: AsyncIterable<ModelEvent>) {
  const events: ModelEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function captureFetch(
  captures: Capture[],
  streamResponse: () => Response,
): typeof fetch {
  return async (input, init) => {
    const method = String(init?.method ?? "GET");
    const rawBody = typeof init?.body === "string" ? init.body : null;
    captures.push({
      url: String(input),
      method,
      headers: new Headers(init?.headers),
      body: rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : null,
      signal: init?.signal instanceof AbortSignal ? init.signal : null,
      redirect: init?.redirect,
    });
    if (method === "GET") {
      const provider = providerFromUrl(String(input));
      return json(validationPayload(provider));
    }
    return streamResponse();
  };
}

function providerFromUrl(url: string): Provider {
  if (url.startsWith("https://api.openai.com/")) return "openai";
  if (url.startsWith("https://api.deepseek.com/")) return "deepseek";
  if (url.startsWith("https://api.anthropic.com/")) return "anthropic";
  if (url.startsWith("https://generativelanguage.googleapis.com/")) {
    return "gemini";
  }
  return "openai_compatible";
}

function assertStandardTransport(capture: Capture) {
  assert.equal(capture.method, "POST");
  assert.equal(capture.redirect, "manual");
  assert.ok(capture.signal instanceof AbortSignal);
  assert.equal(capture.headers.get("content-type"), "application/json");
  assert.equal(capture.headers.get("accept"), "text/event-stream");
}

async function auditOpenAI() {
  const captures: Capture[] = [];
  const resolverCalls: unknown[] = [];
  const adapterConfig = config("openai");
  const adapter = createModelProvider(adapterConfig, {
    credentialResolver: resolver(resolverCalls),
    fetchImpl: captureFetch(captures, () =>
      sse([
        { type: "response.output_text.delta", delta: '{"answer":' },
        {
          type: "response.output_item.added",
          item: {
            type: "function_call",
            id: "item_1",
            call_id: "call_1",
            name: "lookup_document",
          },
        },
        {
          type: "response.function_call_arguments.delta",
          item_id: "item_1",
          delta: '{"id":"doc"}',
        },
        {
          type: "response.output_item.done",
          item: {
            type: "function_call",
            id: "item_1",
            call_id: "call_1",
            name: "lookup_document",
            arguments: '{"id":"doc"}',
          },
        },
        {
          type: "response.completed",
          response: { usage: { input_tokens: 12, output_tokens: 7 } },
        },
      ]),
    ),
  });

  const disabled = {
    ...adapterConfig,
    profile: { ...adapterConfig.profile, enabled: false },
  };
  assert.deepEqual(await adapter.validateConfiguration(disabled), {
    valid: true,
  });
  const customEndpoint = normalizeModelEndpoint({
    provider: "openai",
    baseUrl: "https://gateway.example.test/v1",
  });
  const customConfig = config("openai", {
    baseUrl: customEndpoint.baseUrl,
    credentialOrigin: customEndpoint.canonicalOrigin,
  });
  const customProbeCapturesBefore = captures.length;
  assert.deepEqual(await adapter.validateConfiguration(customConfig), {
    valid: false,
    code: "configuration_error",
    message: "Official provider requires its pinned official endpoint.",
    retryable: false,
  });
  assert.equal(captures.length, customProbeCapturesBefore);
  const wrongModel = createModelProvider(adapterConfig, {
    credentialResolver: resolver([]),
    fetchImpl: async () => json({ id: "different-model" }),
  });
  assert.equal(
    (await wrongModel.validateConfiguration(adapterConfig)).valid,
    false,
  );
  const events = await collect(
    adapter.generate(
      request("openai", { schema: true }),
      new AbortController().signal,
    ),
  );
  assert.deepEqual(events.at(-2), {
    type: "usage",
    inputTokens: 12,
    outputTokens: 7,
  });
  assert.deepEqual(events.at(-1), { type: "completed" });
  assert.ok(events.some((event) => event.type === "tool_call_start"));

  assert.equal(captures[0].url, "https://api.openai.com/v1/models/gpt-5.4");
  const generation = captures[1];
  assertStandardTransport(generation);
  assert.equal(generation.url, "https://api.openai.com/v1/responses");
  assert.equal(generation.headers.get("authorization"), `Bearer ${SECRET}`);
  assert.deepEqual(generation.body?.text, {
    format: {
      type: "json_schema",
      name: "vera_response",
      strict: true,
      schema: request("openai", { schema: true }).responseFormat?.schema,
    },
  });
  assert.equal(generation.body?.stream, true);
  assert.ok(Array.isArray(generation.body?.tools));
  assert.equal(resolverCalls.length, 2);
}

async function auditDeepSeek() {
  const captures: Capture[] = [];
  const adapter = createModelProvider(config("deepseek"), {
    credentialResolver: resolver([]),
    fetchImpl: captureFetch(captures, () =>
      sse([
        {
          choices: [
            {
              index: 0,
              delta: {
                reasoning_content: "Reasoning",
                content: '{"answer":"ok"}',
              },
              finish_reason: "stop",
            },
          ],
          usage: null,
        },
        {
          choices: [],
          usage: { prompt_tokens: 10, completion_tokens: 4 },
        },
        "[DONE]",
      ]),
    ),
  });
  assert.deepEqual(await adapter.validateConfiguration(config("deepseek")), {
    valid: true,
  });

  const wrongModel = createModelProvider(config("deepseek"), {
    credentialResolver: resolver([]),
    fetchImpl: async () => json({ data: [{ id: "different-model" }] }),
  });
  assert.deepEqual(await wrongModel.validateConfiguration(config("deepseek")), {
    valid: false,
    code: "invalid_response",
    message: "Model provider returned invalid connection data.",
    retryable: false,
  });
  const events = await collect(
    adapter.generate(request("deepseek"), new AbortController().signal),
  );
  assert.ok(events.some((event) => event.type === "reasoning_delta"));
  assert.deepEqual(events.at(-1), { type: "completed" });
  const generation = captures[1];
  assertStandardTransport(generation);
  assert.equal(generation.url, "https://api.deepseek.com/chat/completions");
  assert.equal(generation.body?.stream, true);
  assert.deepEqual(generation.body?.stream_options, { include_usage: true });
  assert.deepEqual(generation.body?.response_format, { type: "json_object" });
}

async function auditAnthropic() {
  const captures: Capture[] = [];
  const adapter = createModelProvider(config("anthropic"), {
    credentialResolver: resolver([]),
    fetchImpl: captureFetch(captures, () =>
      anthropicSse([
        {
          type: "message_start",
          message: { usage: { input_tokens: 9, output_tokens: 1 } },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: '{"answer":"ok"}' },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 5 },
        },
        { type: "message_stop" },
      ]),
    ),
  });
  assert.deepEqual(await adapter.validateConfiguration(config("anthropic")), {
    valid: true,
  });
  const wrongModel = createModelProvider(config("anthropic"), {
    credentialResolver: resolver([]),
    fetchImpl: async () => json({ id: "different-model" }),
  });
  assert.equal(
    (await wrongModel.validateConfiguration(config("anthropic"))).valid,
    false,
  );
  const events = await collect(
    adapter.generate(
      request("anthropic", { schema: true }),
      new AbortController().signal,
    ),
  );
  assert.deepEqual(events.at(-2), {
    type: "usage",
    inputTokens: 9,
    outputTokens: 5,
  });
  assert.deepEqual(events.at(-1), { type: "completed" });
  const generation = captures[1];
  assertStandardTransport(generation);
  assert.equal(generation.url, "https://api.anthropic.com/v1/messages");
  assert.equal(generation.headers.get("x-api-key"), SECRET);
  assert.equal(generation.headers.get("anthropic-version"), "2023-06-01");
  assert.equal(generation.body?.system, "Be precise.");
  assert.deepEqual(objectAt(generation.body, "output_config"), {
    format: {
      type: "json_schema",
      schema: request("anthropic", { schema: true }).responseFormat?.schema,
    },
  });
}

function objectAt(value: Record<string, unknown> | null, key: string) {
  const item = value?.[key];
  assert.ok(item && typeof item === "object" && !Array.isArray(item));
  return item as Record<string, unknown>;
}

async function auditGemini() {
  const captures: Capture[] = [];
  const adapter = createModelProvider(config("gemini"), {
    credentialResolver: resolver([]),
    fetchImpl: captureFetch(captures, () =>
      sse([
        {
          candidates: [
            {
              content: {
                parts: [
                  { text: '{"answer":"ok"}' },
                  {
                    functionCall: {
                      id: "gem_call",
                      name: "lookup_document",
                      args: { id: "doc" },
                    },
                  },
                ],
              },
              finishReason: "STOP",
            },
          ],
          usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 6 },
        },
      ]),
    ),
  });
  assert.deepEqual(await adapter.validateConfiguration(config("gemini")), {
    valid: true,
  });
  const wrongModel = createModelProvider(config("gemini"), {
    credentialResolver: resolver([]),
    fetchImpl: async () => json({ name: "models/different-model" }),
  });
  assert.equal(
    (await wrongModel.validateConfiguration(config("gemini"))).valid,
    false,
  );
  const events = await collect(
    adapter.generate(
      request("gemini", { schema: true }),
      new AbortController().signal,
    ),
  );
  assert.ok(events.some((event) => event.type === "tool_call_delta"));
  assert.deepEqual(events.at(-1), { type: "completed" });
  const generation = captures[1];
  assertStandardTransport(generation);
  assert.equal(
    generation.url,
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:streamGenerateContent?alt=sse",
  );
  assert.equal(generation.headers.get("x-goog-api-key"), SECRET);
  const generationConfig = objectAt(generation.body, "generationConfig");
  assert.equal(generationConfig.responseMimeType, "application/json");
  assert.deepEqual(
    generationConfig.responseJsonSchema,
    request("gemini", { schema: true }).responseFormat?.schema,
  );
  assert.ok(Array.isArray(generation.body?.tools));
}

async function auditGeneric() {
  const captures: Capture[] = [];
  let plainFetchCalled = false;
  const adapterConfig = config("openai_compatible");
  const adapter = createModelProvider(adapterConfig, {
    credentialResolver: resolver([]),
    fetchImpl: async () => {
      plainFetchCalled = true;
      throw new Error("Generic providers must not use the plain transport.");
    },
    hardenedGenericTransport: {
      attestation: "dns-pinned-and-revalidated-v1",
      fetchImpl: captureFetch(captures, () =>
        sse([
          {
            choices: [
              {
                index: 0,
                delta: { content: '{"answer":"ok"}' },
                finish_reason: "stop",
              },
            ],
          },
          { choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } },
          "[DONE]",
        ]),
      ),
    },
  });
  assert.deepEqual(
    await adapter.validateConfiguration(config("openai_compatible")),
    { valid: true },
  );
  const events = await collect(
    adapter.generate(
      request("openai_compatible", { schema: true }),
      new AbortController().signal,
    ),
  );
  assert.deepEqual(events.at(-1), { type: "completed" });
  assert.equal(plainFetchCalled, false);
  const generation = captures[1];
  assert.equal(
    generation.url,
    "https://gateway.example.test/v1/chat/completions",
  );
  assert.equal(
    objectAt(generation.body, "response_format").type,
    "json_schema",
  );

  let unsafeFetchCalled = false;
  const unsafeResolverCalls: unknown[] = [];
  const failClosed = createModelProvider(adapterConfig, {
    credentialResolver: resolver(unsafeResolverCalls),
    fetchImpl: async () => {
      unsafeFetchCalled = true;
      return json({ data: [{ id: MODELS.openai_compatible }] });
    },
  });
  assert.deepEqual(await failClosed.validateConfiguration(adapterConfig), {
    valid: false,
    code: "hardened_transport_required",
    message: "Generic provider requires a DNS-pinned transport.",
    retryable: false,
  });
  assert.equal(unsafeFetchCalled, false);
  assert.equal(unsafeResolverCalls.length, 0);

  const customOfficialEndpoint = normalizeModelEndpoint({
    provider: "openai",
    baseUrl: "https://gateway.example.test/v1",
  });
  assert.throws(
    () =>
      createModelProvider(
        config("openai", {
          baseUrl: customOfficialEndpoint.baseUrl,
          credentialOrigin: customOfficialEndpoint.canonicalOrigin,
        }),
        { credentialResolver: resolver([]) },
      ),
    /pinned official endpoint/i,
  );

  let fetched = false;
  const tampered: ModelProviderConfig = {
    ...adapterConfig,
    expectedBinding: {
      ...adapterConfig.expectedBinding,
      normalizedBaseUrl: "https://attacker.example/v1",
      canonicalOrigin: "https://attacker.example",
    },
  };
  const fenced = createModelProvider(tampered, {
    credentialResolver: resolver([]),
    fetchImpl: async () => {
      fetched = true;
      return sse([]);
    },
  });
  const fencedEvents = await collect(
    fenced.generate(
      request("openai_compatible", { schema: true }),
      new AbortController().signal,
    ),
  );
  assert.equal(fetched, false);
  assert.equal(fencedEvents[0]?.type, "error");
  assert.equal(
    fencedEvents[0]?.type === "error" ? fencedEvents[0].code : null,
    "configuration_error",
  );
}

async function auditAbort() {
  const adapterConfig = config("openai");
  let streamController: ReadableStreamDefaultController<Uint8Array> | null =
    null;
  const encoder = new TextEncoder();
  const adapter = createModelProvider(adapterConfig, {
    credentialResolver: resolver([]),
    fetchImpl: async (_input, init) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                type: "response.output_text.delta",
                delta: "first",
              })}\n\n`,
            ),
          );
          init?.signal?.addEventListener(
            "abort",
            () =>
              controller.error(
                Object.assign(new Error("cancelled"), { name: "AbortError" }),
              ),
            { once: true },
          );
        },
      });
      return new Response(stream, {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  const controller = new AbortController();
  const iterator = adapter
    .generate(request("openai", { schema: true }), controller.signal)
    [Symbol.asyncIterator]();
  assert.deepEqual(await iterator.next(), {
    done: false,
    value: { type: "text_delta", text: "first" },
  });
  assert.ok(streamController);
  controller.abort();
  await assert.rejects(iterator.next(), (error: unknown) => {
    return error instanceof Error && error.name === "AbortError";
  });
}

async function auditHttpErrorsAndRedaction() {
  for (const [status, code, message, retryable] of [
    [
      401,
      "authentication_failed",
      "Model provider authentication failed.",
      false,
    ],
    [
      403,
      "access_denied",
      "Model provider denied access to the requested resource.",
      false,
    ],
    [
      404,
      "model_unavailable",
      "Configured model is unavailable from the provider.",
      false,
    ],
    [429, "rate_limited", "Model provider rate limit was reached.", true],
    [
      503,
      "provider_unavailable",
      "Model provider is temporarily unavailable.",
      true,
    ],
  ] as const) {
    const adapter = createModelProvider(config("openai"), {
      credentialResolver: resolver([]),
      fetchImpl: async () =>
        new Response(`sensitive body ${SECRET}`, { status }),
    });
    assert.deepEqual(await adapter.validateConfiguration(config("openai")), {
      valid: false,
      code,
      message,
      retryable,
    });
    const events = await collect(
      adapter.generate(
        request("openai", { schema: true }),
        new AbortController().signal,
      ),
    );
    assert.deepEqual(events, [
      {
        type: "error",
        code,
        message,
        retryable,
      },
    ]);
    assert.equal(JSON.stringify(events).includes(SECRET), false);
  }

  const network = createModelProvider(config("openai"), {
    credentialResolver: resolver([]),
    fetchImpl: async () => {
      throw new Error(`network leaked ${SECRET}`);
    },
  });
  const events = await collect(
    network.generate(
      request("openai", { schema: true }),
      new AbortController().signal,
    ),
  );
  assert.equal(JSON.stringify(events).includes(SECRET), false);
  assert.equal(
    events[0]?.type === "error" ? events[0].code : null,
    "network_error",
  );
}

async function auditMalformedAndBoundedStreams() {
  const malformed = createModelProvider(config("openai"), {
    credentialResolver: resolver([]),
    fetchImpl: async () =>
      new Response(`data: {not-json-${SECRET}}\n\n`, {
        headers: { "content-type": "text/event-stream" },
      }),
  });
  const malformedEvents = await collect(
    malformed.generate(
      request("openai", { schema: true }),
      new AbortController().signal,
    ),
  );
  assert.equal(
    malformedEvents[0]?.type === "error" ? malformedEvents[0].code : null,
    "invalid_response",
  );
  assert.equal(JSON.stringify(malformedEvents).includes(SECRET), false);

  const oversized = createModelProvider(config("openai"), {
    credentialResolver: resolver([]),
    fetchImpl: async () =>
      new Response("data: {}\n\n", {
        headers: {
          "content-type": "text/event-stream",
          "content-length": String(5 * 1024 * 1024),
        },
      }),
  });
  const oversizedEvents = await collect(
    oversized.generate(
      request("openai", { schema: true }),
      new AbortController().signal,
    ),
  );
  assert.equal(
    oversizedEvents[0]?.type === "error" ? oversizedEvents[0].code : null,
    "response_too_large",
  );

  const singleOversizedEvent = createModelProvider(config("openai"), {
    credentialResolver: resolver([]),
    fetchImpl: async () =>
      new Response(
        `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "x".repeat(300 * 1024) })}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      ),
  });
  const oversizedEventResult = await collect(
    singleOversizedEvent.generate(
      request("openai", { schema: true }),
      new AbortController().signal,
    ),
  );
  assert.equal(
    oversizedEventResult[0]?.type === "error"
      ? oversizedEventResult[0].code
      : null,
    "response_too_large",
  );

  const smallEventCount = 4_000;
  const combinedEvents = Array.from(
    { length: smallEventCount },
    (_, index) =>
      `data: ${JSON.stringify({ index, text: "x".repeat(64) })}\n\n`,
  ).join("");
  assert.ok(Buffer.byteLength(combinedEvents) > 256 * 1024);
  let parsedEvents = 0;
  for await (const record of readBoundedJsonSse(
    new Response(combinedEvents, {
      headers: { "content-type": "text/event-stream" },
    }),
    new AbortController().signal,
  )) {
    assert.equal(record.done, false);
    parsedEvents += 1;
  }
  assert.equal(parsedEvents, smallEventCount);
}

async function auditFinishSemantics() {
  const outputLimit = createModelProvider(config("deepseek"), {
    credentialResolver: resolver([]),
    fetchImpl: async () =>
      sse([
        {
          choices: [
            {
              index: 0,
              delta: { content: "partial" },
              finish_reason: "length",
            },
          ],
        },
        "[DONE]",
      ]),
  });
  const outputLimitEvents = await collect(
    outputLimit.generate(request("deepseek"), new AbortController().signal),
  );
  const outputLimitLast = outputLimitEvents.at(-1);
  assert.equal(outputLimitLast?.type, "error");
  assert.equal(
    outputLimitLast?.type === "error" ? outputLimitLast.code : null,
    "output_limit_reached",
  );
  assert.equal(
    outputLimitEvents.some((event) => event.type === "completed"),
    false,
  );

  const anthropicOutputLimit = createModelProvider(config("anthropic"), {
    credentialResolver: resolver([]),
    fetchImpl: async () =>
      anthropicSse([
        {
          type: "message_start",
          message: { usage: { input_tokens: 5, output_tokens: 0 } },
        },
        {
          type: "message_delta",
          delta: { stop_reason: "max_tokens" },
          usage: { output_tokens: 10 },
        },
        { type: "message_stop" },
      ]),
  });
  const anthropicLimitEvents = await collect(
    anthropicOutputLimit.generate(
      request("anthropic"),
      new AbortController().signal,
    ),
  );
  const anthropicLimitLast = anthropicLimitEvents.at(-1);
  assert.equal(anthropicLimitLast?.type, "error");
  assert.equal(
    anthropicLimitLast?.type === "error" ? anthropicLimitLast.code : null,
    "output_limit_reached",
  );
  assert.equal(
    anthropicLimitEvents.some((event) => event.type === "completed"),
    false,
  );

  const geminiOutputLimit = createModelProvider(config("gemini"), {
    credentialResolver: resolver([]),
    fetchImpl: async () =>
      sse([
        {
          candidates: [
            {
              content: { parts: [{ text: "partial" }] },
              finishReason: "MAX_TOKENS",
            },
          ],
        },
      ]),
  });
  const geminiLimitEvents = await collect(
    geminiOutputLimit.generate(request("gemini"), new AbortController().signal),
  );
  assert.deepEqual(geminiLimitEvents.at(-1), {
    type: "error",
    code: "output_limit_reached",
    message: "Gemini stopped at the output token limit.",
    retryable: false,
  });

  const noGeminiFinish = createModelProvider(config("gemini"), {
    credentialResolver: resolver([]),
    fetchImpl: async () =>
      sse([
        {
          candidates: [{ content: { parts: [{ text: "partial" }] } }],
        },
      ]),
  });
  const noGeminiFinishEvents = await collect(
    noGeminiFinish.generate(request("gemini"), new AbortController().signal),
  );
  const noGeminiFinishLast = noGeminiFinishEvents.at(-1);
  assert.equal(
    noGeminiFinishLast?.type === "error" ? noGeminiFinishLast.code : null,
    "invalid_response",
  );
  assert.equal(
    noGeminiFinishEvents.some((event) => event.type === "completed"),
    false,
  );
}

async function main() {
  await auditOpenAI();
  await auditDeepSeek();
  await auditAnthropic();
  await auditGemini();
  await auditGeneric();
  await auditAbort();
  await auditHttpErrorsAndRedaction();
  await auditMalformedAndBoundedStreams();
  await auditFinishSemantics();
  console.log("Vera workspace provider adapters audit passed.");
}

void main().catch((error) => {
  console.error(
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : "Audit failed.",
  );
  process.exitCode = 1;
});
