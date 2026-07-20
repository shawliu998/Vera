import assert from "node:assert/strict";
import { streamDeepSeek } from "../src/lib/llm/deepseek";

const requests: Array<Record<string, unknown>> = [];
const originalFetch = globalThis.fetch;
let call = 0;

function sse(events: unknown[]) {
  return `${events.map((event) => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\ndata: [DONE]\n\n`;
}

globalThis.fetch = async (_url, init) => {
  requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
  call += 1;
  if (call === 1) {
    return new Response(
      sse([
        {
          choices: [
            {
              delta: { reasoning_content: "Check the source. " },
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
                    id: "call_1",
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
};

async function main() {
  try {
    const reasoning: string[] = [];
    const toolCalls: string[] = [];
    const result = await streamDeepSeek({
      model: "deepseek-v4-flash",
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
      apiKeys: { deepseek: "test-key" },
      enableThinking: true,
      callbacks: {
        onReasoningDelta: (text) => reasoning.push(text),
        onToolCallStart: (entry) => toolCalls.push(entry.name),
      },
      runTools: async (entries) => {
        assert.deepEqual(entries[0]?.input, { document_id: "doc_1" });
        return [{ tool_use_id: "call_1", content: "Contract text" }];
      },
    });

    assert.equal(call, 2);
    assert.equal(result.fullText, "Source read and checkpoint saved.");
    assert.equal(reasoning.join(""), "Check the source. ");
    assert.deepEqual(toolCalls, ["read_document"]);
    assert.equal(requests[0]?.model, "deepseek-v4-flash");
    assert.deepEqual(requests[0]?.thinking, { type: "enabled" });
    const secondMessages = requests[1]?.messages as Array<
      Record<string, unknown>
    >;
    assert.equal(secondMessages.at(-2)?.role, "assistant");
    assert.equal(
      secondMessages.at(-2)?.reasoning_content,
      "Check the source. ",
    );
    assert.equal(secondMessages.at(-1)?.role, "tool");
    assert.equal(secondMessages.at(-1)?.tool_call_id, "call_1");
    console.log(
      JSON.stringify({ ok: true, suite: "deepseek-adapter-smoke-v1" }, null, 2),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
