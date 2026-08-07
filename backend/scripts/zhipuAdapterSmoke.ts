import assert from "node:assert/strict";

import { completeZhipuText, streamZhipu } from "../src/lib/llm/kimi";
import { isSupportedModel, providerForModel } from "../src/lib/llm/models";
import { normalizeApiKeyProvider } from "../src/lib/userApiKeys";

type CapturedRequest = {
  url: string;
  init?: RequestInit;
  body: Record<string, unknown>;
};

const requests: CapturedRequest[] = [];
const originalFetch = globalThis.fetch;
let call = 0;

function sse(events: unknown[]) {
  return `${events
    .map((event) => `data: ${JSON.stringify(event)}`)
    .join("\n\n")}\n\ndata: [DONE]\n\n`;
}

globalThis.fetch = async (url, init) => {
  requests.push({
    url: String(url),
    init,
    body: JSON.parse(String(init?.body)) as Record<string, unknown>,
  });
  call += 1;

  if (call === 1) {
    return new Response(
      sse([
        {
          choices: [
            {
              delta: { reasoning_content: "Verify the fixed source. " },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "zhipu_call_1",
                    function: {
                      name: "read_document",
                      arguments: '{"document_id":',
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, function: { arguments: '"doc_1"}' } }],
              },
              finish_reason: "tool_calls",
            },
          ],
        },
      ]),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  }

  if (call === 2) {
    return new Response(
      sse([
        {
          choices: [
            {
              delta: { content: "Source read and checkpoint saved." },
              finish_reason: "stop",
            },
          ],
        },
      ]),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  }

  return new Response(
    JSON.stringify({
      choices: [{ message: { content: "Short Zhipu completion." } }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
};

async function main() {
  try {
    assert.equal(isSupportedModel("glm-5.2"), true);
    assert.equal(isSupportedModel("glm-4.7-flashx"), true);
    assert.equal(providerForModel("glm-5.2"), "zhipu");
    assert.equal(normalizeApiKeyProvider("zhipu"), "zhipu");

    const reasoning: string[] = [];
    const toolCalls: string[] = [];
    const result = await streamZhipu({
      model: "glm-5.2",
      systemPrompt: "Keep legal facts source-linked.",
      messages: [{ role: "user", content: "Read the contract." }],
      tools: [
        {
          type: "function",
          function: {
            name: "read_document",
            description: "Read a document",
            parameters: {
              type: "object",
              properties: { document_id: { type: "string" } },
              required: ["document_id"],
            },
          },
        },
      ],
      apiKeys: { zhipu: "test-zhipu-key" },
      enableThinking: true,
      callbacks: {
        onReasoningDelta: (text) => reasoning.push(text),
        onToolCallStart: (entry) => toolCalls.push(entry.name),
      },
      runTools: async (entries) => {
        assert.deepEqual(entries[0]?.input, { document_id: "doc_1" });
        return [{ tool_use_id: "zhipu_call_1", content: "Contract text" }];
      },
    });

    assert.equal(call, 2);
    assert.equal(result.fullText, "Source read and checkpoint saved.");
    assert.equal(reasoning.join(""), "Verify the fixed source. ");
    assert.deepEqual(toolCalls, ["read_document"]);
    assert.equal(
      requests[0]?.url,
      "https://open.bigmodel.cn/api/paas/v4/chat/completions",
    );
    assert.equal(requests[0]?.body.model, "glm-5.2");
    assert.equal(requests[0]?.body.max_tokens, 32_768);
    assert.deepEqual(requests[0]?.body.thinking, { type: "enabled" });
    assert.equal(requests[0]?.body.tool_stream, true);
    assert.equal(requests[0]?.body.max_completion_tokens, undefined);
    assert.equal(requests[0]?.body.reasoning_effort, undefined);

    const headers = requests[0]?.init?.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer test-zhipu-key");
    const secondMessages = requests[1]?.body.messages as Array<
      Record<string, unknown>
    >;
    assert.equal(secondMessages.at(-2)?.role, "assistant");
    assert.equal(secondMessages.at(-2)?.content, "");
    assert.equal(
      secondMessages.at(-2)?.reasoning_content,
      "Verify the fixed source. ",
    );
    assert.equal(secondMessages.at(-1)?.role, "tool");
    assert.equal(secondMessages.at(-1)?.tool_call_id, "zhipu_call_1");

    const shortCompletion = await completeZhipuText({
      model: "glm-4.7-flashx",
      user: "Create a short title.",
      apiKeys: { zhipu: "test-zhipu-key" },
    });
    assert.equal(shortCompletion, "Short Zhipu completion.");
    assert.equal(requests[2]?.body.stream, false);
    assert.equal(requests[2]?.body.max_tokens, 512);
    assert.deepEqual(requests[2]?.body.thinking, { type: "disabled" });
    assert.equal(requests[2]?.body.tool_stream, undefined);

    console.log(
      JSON.stringify({ ok: true, suite: "zhipu-adapter-smoke-v1" }, null, 2),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
