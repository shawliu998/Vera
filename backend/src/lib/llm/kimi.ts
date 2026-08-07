import type {
  LlmMessage,
  NormalizedToolCall,
  OpenAIToolSchema,
  StreamChatParams,
  StreamChatResult,
} from "./types";
import { createRawLlmStreamRecorder, logRawLlmStream } from "./rawStreamLog";

// Kimi and Zhipu use the OpenAI-compatible Chat Completions protocol. Keep
// this shared adapter separate from the OpenAI Responses adapter: their
// streaming and tool-continuation payloads are different contracts.
const KIMI_CHAT_URL = "https://api.moonshot.ai/v1/chat/completions";
const ZHIPU_CHAT_URL = "https://open.bigmodel.cn/api/paas/v4/chat/completions";

type CompatibleProvider = "kimi" | "zhipu";

type CompatibleProviderConfig = {
  provider: CompatibleProvider;
  label: "Kimi" | "Zhipu";
  chatUrl: string;
  key: string;
  maxOutputTokens: number;
};

type KimiToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type KimiMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      reasoning_content?: string;
      tool_calls?: KimiToolCall[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

type ToolCallDelta = {
  index?: number;
  id?: string;
  type?: "function";
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

function providerConfig(
  provider: CompatibleProvider,
  override?: string | null,
): CompatibleProviderConfig {
  const isZhipu = provider === "zhipu";
  const key =
    override?.trim() ||
    (isZhipu
      ? process.env.ZHIPU_API_KEY?.trim() ||
        process.env.BIGMODEL_API_KEY?.trim()
      : process.env.MOONSHOT_API_KEY?.trim()) ||
    "";
  if (!key) {
    throw new Error(
      isZhipu
        ? "Zhipu API key is not configured. Set ZHIPU_API_KEY or add a user Zhipu key."
        : "Kimi API key is not configured. Set MOONSHOT_API_KEY or add a user Kimi key.",
    );
  }
  return {
    provider,
    label: isZhipu ? "Zhipu" : "Kimi",
    chatUrl: isZhipu ? ZHIPU_CHAT_URL : KIMI_CHAT_URL,
    key,
    maxOutputTokens: isZhipu ? 32_768 : 16_384,
  };
}

function abortError(): Error {
  const error = new Error("Stream aborted.");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw abortError();
}

function responseError(
  status: number,
  body: string,
  label: CompatibleProviderConfig["label"],
  retryAfter?: string | null,
) {
  let detail = body.trim();
  try {
    const parsed = JSON.parse(body) as {
      error?: { code?: string | number; message?: string };
    };
    const message = parsed.error?.message?.trim();
    const code = parsed.error?.code;
    if (message)
      detail = code ? `${label} error (${code}): ${message}` : message;
  } catch {
    // Preserve a bounded provider response when it is not JSON.
  }
  const error = new Error(
    detail.startsWith(`${label} error`)
      ? detail.slice(0, 2_000)
      : `${label} request failed (${status}): ${detail.slice(0, 2_000) || "Unknown error"}`,
  );
  (error as Error & { status?: number; retryAfter?: string }).status = status;
  if (retryAfter) {
    (error as Error & { retryAfter?: string }).retryAfter = retryAfter;
  }
  return error;
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
): KimiMessage[] {
  return [
    ...(systemPrompt
      ? ([{ role: "system", content: systemPrompt }] as KimiMessage[])
      : []),
    ...messages.map(
      (message): KimiMessage => ({
        role: message.role,
        content: message.content,
      }),
    ),
  ];
}

async function createChatCompletion(input: {
  model: string;
  messages: KimiMessage[];
  tools?: OpenAIToolSchema[];
  stream: boolean;
  maxTokens: number;
  enableThinking: boolean;
  config: CompatibleProviderConfig;
  signal?: AbortSignal;
}) {
  let response: Response;
  try {
    response = await fetch(input.config.chatUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.config.key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: input.model,
        messages: input.messages,
        tools: input.tools?.length ? input.tools : undefined,
        tool_choice: input.tools?.length ? "auto" : undefined,
        stream: input.stream,
        ...(input.config.provider === "zhipu"
          ? {
              max_tokens: input.maxTokens,
              thinking: {
                type: input.enableThinking ? "enabled" : "disabled",
              },
              tool_stream:
                input.stream && input.tools?.length ? true : undefined,
            }
          : {
              // Kimi K3 documents max_completion_tokens, not OpenAI's
              // legacy max_tokens. K3 always reasons; lower effort keeps
              // normal chat bounded while Work Tasks can request more.
              max_completion_tokens: input.maxTokens,
              reasoning_effort: input.enableThinking ? "high" : "low",
            }),
      }),
      signal: input.signal,
    });
  } catch (error) {
    if (input.signal?.aborted) throw abortError();
    throw new Error(
      `${input.config.label} network error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    throw responseError(
      response.status,
      await response.text().catch(() => ""),
      input.config.label,
      response.headers.get("retry-after"),
    );
  }
  return response;
}

async function streamOpenAiCompatible(
  params: StreamChatParams,
  provider: CompatibleProvider,
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
  const config = providerConfig(provider, apiKeys?.[provider]);
  let fullText = "";
  const rawStreamRecorder = createRawLlmStreamRecorder({
    provider: config.provider,
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
        maxTokens: config.maxOutputTokens,
        enableThinking,
        config,
        signal: params.abortSignal,
      });
      if (!response.body) {
        throw new Error(`${config.label} response had no body`);
      }

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
            provider: config.provider,
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
            throw responseError(200, JSON.stringify(chunk), config.label);
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
        throw new Error(`${config.label} stream stopped (${finishReason})`);
      }

      const nativeToolCalls: KimiToolCall[] = [...toolCallParts.entries()]
        .sort(([left], [right]) => left - right)
        .map(([index, call]) => ({
          id: call.id || `${config.provider}_call_${iteration}_${index}`,
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
      // Both providers require the complete assistant message (including
      // reasoning and tool calls) before matching tool messages.
      messages.push({
        role: "assistant",
        content,
        ...(reasoning ? { reasoning_content: reasoning } : {}),
        tool_calls: nativeToolCalls,
      });
      messages.push(
        ...results.map(
          (result): KimiMessage => ({
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

async function completeOpenAiCompatibleText(
  provider: CompatibleProvider,
  params: {
    model: string;
    systemPrompt?: string;
    user: string;
    maxTokens?: number;
    apiKeys?: { kimi?: string | null; zhipu?: string | null };
  },
): Promise<string> {
  const config = providerConfig(provider, params.apiKeys?.[provider]);
  const response = await createChatCompletion({
    model: params.model,
    messages: toMessages(params.systemPrompt ?? "", [
      { role: "user", content: params.user },
    ]),
    stream: false,
    maxTokens: params.maxTokens ?? 512,
    enableThinking: false,
    config,
  });
  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string | null } }>;
  };
  return payload.choices?.[0]?.message?.content ?? "";
}

export function streamKimi(params: StreamChatParams) {
  return streamOpenAiCompatible(params, "kimi");
}

export function streamZhipu(params: StreamChatParams) {
  return streamOpenAiCompatible(params, "zhipu");
}

export function completeKimiText(params: {
  model: string;
  systemPrompt?: string;
  user: string;
  maxTokens?: number;
  apiKeys?: { kimi?: string | null };
}) {
  return completeOpenAiCompatibleText("kimi", params);
}

export function completeZhipuText(params: {
  model: string;
  systemPrompt?: string;
  user: string;
  maxTokens?: number;
  apiKeys?: { zhipu?: string | null };
}) {
  return completeOpenAiCompatibleText("zhipu", params);
}
