import type {
  LlmMessage,
  NormalizedToolCall,
  OpenAIToolSchema,
  StreamChatParams,
  StreamChatResult,
} from "./types";
import { createRawLlmStreamRecorder, logRawLlmStream } from "./rawStreamLog";

const DEEPSEEK_CHAT_URL = "https://api.deepseek.com/chat/completions";
const MAX_OUTPUT_TOKENS = 16_384;

type DeepSeekToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type DeepSeekMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      reasoning_content?: string;
      tool_calls?: DeepSeekToolCall[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

type ToolCallDelta = {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
};

type StreamChunk = {
  error?: { code?: string | number; message?: string };
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: ToolCallDelta[];
    };
    finish_reason?: string | null;
  }>;
};

function apiKey(override?: string | null): string {
  const key = override?.trim() || process.env.DEEPSEEK_API_KEY?.trim() || "";
  if (!key) {
    throw new Error(
      "DeepSeek API key is not configured. Set DEEPSEEK_API_KEY or add a user DeepSeek key.",
    );
  }
  return key;
}

function abortError(): Error {
  const error = new Error("Stream aborted.");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw abortError();
}

function responseError(status: number, body: string) {
  let detail = body.trim();
  try {
    const parsed = JSON.parse(body) as {
      error?: { code?: string | number; message?: string };
    };
    const message = parsed.error?.message?.trim();
    const code = parsed.error?.code;
    if (message)
      detail = code ? `DeepSeek error (${code}): ${message}` : message;
  } catch {
    // Preserve a bounded provider response when it is not JSON.
  }
  return new Error(
    detail.startsWith("DeepSeek error")
      ? detail.slice(0, 2_000)
      : `DeepSeek request failed (${status}): ${detail.slice(0, 2_000) || "Unknown error"}`,
  );
}

function extractSseJson(buffer: string): { events: unknown[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const blocks = normalized.split("\n\n");
  const rest = blocks.pop() ?? "";
  const events: unknown[] = [];
  for (const block of blocks) {
    for (const line of block.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        events.push(JSON.parse(data));
      } catch {
        // A partial JSON event remains in the reader buffer.
      }
    }
  }
  return { events, rest };
}

function parseToolInput(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function toMessages(
  systemPrompt: string,
  messages: LlmMessage[],
): DeepSeekMessage[] {
  return [
    ...(systemPrompt
      ? ([{ role: "system", content: systemPrompt }] as DeepSeekMessage[])
      : []),
    ...messages.map(
      (message): DeepSeekMessage => ({
        role: message.role,
        content: message.content,
      }),
    ),
  ];
}

async function createChatCompletion(input: {
  model: string;
  messages: DeepSeekMessage[];
  tools?: OpenAIToolSchema[];
  stream: boolean;
  maxTokens: number;
  enableThinking: boolean;
  key: string;
  signal?: AbortSignal;
}) {
  let response: Response;
  try {
    response = await fetch(DEEPSEEK_CHAT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: input.model,
        messages: input.messages,
        tools: input.tools?.length ? input.tools : undefined,
        tool_choice: input.tools?.length ? "auto" : undefined,
        stream: input.stream,
        max_tokens: input.maxTokens,
        thinking: {
          type: input.enableThinking ? "enabled" : "disabled",
        },
      }),
      signal: input.signal,
    });
  } catch (error) {
    if (input.signal?.aborted) throw abortError();
    throw new Error(
      `DeepSeek network error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    throw responseError(response.status, await response.text().catch(() => ""));
  }
  return response;
}

export async function streamDeepSeek(
  params: StreamChatParams,
): Promise<StreamChatResult> {
  const {
    model,
    systemPrompt,
    tools = [],
    callbacks = {},
    runTools,
    apiKeys,
    enableThinking = false,
  } = params;
  const maxIterations = params.maxIterations ?? 10;
  const messages = toMessages(systemPrompt, params.messages);
  const key = apiKey(apiKeys?.deepseek);
  let fullText = "";
  const rawStreamRecorder = createRawLlmStreamRecorder({
    provider: "deepseek",
    model,
  });

  try {
    for (let iteration = 0; iteration < maxIterations; iteration++) {
      throwIfAborted(params.abortSignal);
      const response = await createChatCompletion({
        model,
        messages,
        tools,
        stream: true,
        maxTokens: MAX_OUTPUT_TOKENS,
        enableThinking,
        key,
        signal: params.abortSignal,
      });
      if (!response.body) throw new Error("DeepSeek response had no body");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const toolCallParts = new Map<
        number,
        { id: string; name: string; arguments: string }
      >();
      let content = "";
      let reasoning = "";
      let finishReason: string | null = null;
      let buffer = "";

      while (true) {
        throwIfAborted(params.abortSignal);
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const parsed = extractSseJson(buffer);
        buffer = parsed.rest;
        for (const event of parsed.events) {
          logRawLlmStream({
            provider: "deepseek",
            model,
            iteration,
            label: "chunk",
            payload: event,
          });
          rawStreamRecorder?.record({
            iteration,
            label: "chunk",
            payload: event,
          });
          const chunk = event as StreamChunk;
          if (chunk.error) {
            throw responseError(200, JSON.stringify(chunk));
          }
          const choice = chunk.choices?.[0];
          if (!choice) continue;
          if (typeof choice.finish_reason === "string") {
            finishReason = choice.finish_reason;
          }
          const delta = choice.delta;
          if (typeof delta?.reasoning_content === "string") {
            reasoning += delta.reasoning_content;
            callbacks.onReasoningDelta?.(delta.reasoning_content);
          }
          if (typeof delta?.content === "string") {
            content += delta.content;
            fullText += delta.content;
            callbacks.onContentDelta?.(delta.content);
          }
          for (const part of delta?.tool_calls ?? []) {
            const index = Number.isInteger(part.index) ? Number(part.index) : 0;
            const current = toolCallParts.get(index) ?? {
              id: "",
              name: "",
              arguments: "",
            };
            if (part.id) current.id = part.id;
            if (part.function?.name) current.name += part.function.name;
            if (part.function?.arguments) {
              current.arguments += part.function.arguments;
            }
            toolCallParts.set(index, current);
          }
        }
        if (done) break;
      }

      if (reasoning) callbacks.onReasoningBlockEnd?.();
      if (
        finishReason === "length" ||
        finishReason === "content_filter" ||
        finishReason === "insufficient_system_resource"
      ) {
        throw new Error(`DeepSeek stream stopped (${finishReason})`);
      }

      const nativeToolCalls: DeepSeekToolCall[] = [...toolCallParts.entries()]
        .sort(([left], [right]) => left - right)
        .map(([index, call]) => ({
          id: call.id || `deepseek_call_${iteration}_${index}`,
          type: "function" as const,
          function: { name: call.name, arguments: call.arguments || "{}" },
        }))
        .filter((call) => call.function.name);
      const normalizedCalls: NormalizedToolCall[] = nativeToolCalls.map(
        (call) => ({
          id: call.id,
          name: call.function.name,
          input: parseToolInput(call.function.arguments),
        }),
      );
      for (const call of normalizedCalls) callbacks.onToolCallStart?.(call);

      if (!normalizedCalls.length || !runTools) break;
      const results = await runTools(normalizedCalls);
      throwIfAborted(params.abortSignal);
      messages.push({
        role: "assistant",
        content: content || null,
        ...(reasoning ? { reasoning_content: reasoning } : {}),
        tool_calls: nativeToolCalls,
      });
      messages.push(
        ...results.map(
          (result): DeepSeekMessage => ({
            role: "tool",
            tool_call_id: result.tool_use_id,
            content: result.content,
          }),
        ),
      );
    }

    await rawStreamRecorder?.flush("completed");
    return { fullText };
  } catch (error) {
    await rawStreamRecorder?.flush("error", error);
    throw error;
  }
}

export async function completeDeepSeekText(params: {
  model: string;
  systemPrompt?: string;
  user: string;
  maxTokens?: number;
  apiKeys?: { deepseek?: string | null };
}): Promise<string> {
  const response = await createChatCompletion({
    model: params.model,
    messages: toMessages(params.systemPrompt ?? "", [
      { role: "user", content: params.user },
    ]),
    stream: false,
    maxTokens: params.maxTokens ?? 512,
    enableThinking: false,
    key: apiKey(params.apiKeys?.deepseek),
  });
  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string | null } }>;
  };
  return payload.choices?.[0]?.message?.content ?? "";
}
