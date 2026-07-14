import {
  array,
  BoundModelProvider,
  object,
  openAiStyleTools,
  string,
  normalizedToolMessage,
} from "./base";
import {
  ProviderProtocolError,
  type ModelEvent,
  type ModelGenerateRequest,
  type ModelProviderConfig,
  type ModelProviderDependencies,
} from "./types";

type ToolState = { id: string; name: string; started: boolean };

export class ChatCompletionsProvider extends BoundModelProvider {
  constructor(
    config: ModelProviderConfig,
    dependencies: ModelProviderDependencies,
  ) {
    super(config, dependencies);
    if (
      config.profile.provider !== "deepseek" &&
      config.profile.provider !== "openai_compatible"
    ) {
      throw new Error("Chat Completions adapter received the wrong provider.");
    }
  }

  protected validationPath() {
    return "models";
  }

  protected validConnectionPayload(
    payload: unknown,
    config: ModelProviderConfig,
  ) {
    const root = object(payload);
    if (!root || !Array.isArray(root.data)) return false;
    if (config.profile.provider === "openai_compatible") return true;
    return root.data.some(
      (item) => string(object(item)?.id) === config.profile.model,
    );
  }

  private payload(request: ModelGenerateRequest) {
    if (
      this.id === "deepseek" &&
      request.responseFormat?.type === "json" &&
      request.responseFormat.schema !== undefined
    ) {
      throw new ProviderProtocolError(
        "unsupported_response_schema",
        "DeepSeek JSON mode does not support a response schema.",
        false,
      );
    }
    const messages = request.messages.map((message) => ({
      role: message.role === "tool" ? "user" : message.role,
      content:
        message.role === "tool"
          ? normalizedToolMessage(message.content)
          : message.content,
    }));
    const responseFormat =
      request.responseFormat?.type === "json"
        ? request.responseFormat.schema === undefined
          ? { type: "json_object" }
          : {
              type: "json_schema",
              json_schema: {
                name: "vera_response",
                strict: true,
                schema: request.responseFormat.schema,
              },
            }
        : undefined;
    return {
      model: request.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      ...(request.temperature !== undefined
        ? { temperature: request.temperature }
        : {}),
      ...(request.maxOutputTokens !== undefined
        ? { max_tokens: request.maxOutputTokens }
        : {}),
      ...(responseFormat ? { response_format: responseFormat } : {}),
      ...(request.tools?.length
        ? { tools: openAiStyleTools(request.tools), tool_choice: "auto" }
        : {}),
    };
  }

  async *generate(
    request: ModelGenerateRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelEvent> {
    const requestError = this.requestError(request);
    if (requestError) {
      yield requestError.toEvent();
      return;
    }

    const tools = new Map<number, ToolState>();
    let sawNormalFinish = false;
    try {
      const payload = this.payload(request);
      for await (const record of this.transport.postJsonSse(
        this.config,
        "chat/completions",
        payload,
        signal,
      )) {
        if (record.done) {
          if (!sawNormalFinish) {
            throw new ProviderProtocolError(
              "invalid_response",
              "Model provider completed without a finish reason.",
              false,
            );
          }
          for (const tool of tools.values()) {
            if (tool.started) yield { type: "tool_call_end", id: tool.id };
          }
          yield { type: "completed" };
          return;
        }
        const data = record.data!;
        if (object(data.error)) {
          yield {
            type: "error",
            code: "provider_stream_error",
            message: "Model provider reported a generation error.",
            retryable: false,
          };
          return;
        }
        const usage = object(data.usage);
        if (usage) {
          const inputTokens = Number.isSafeInteger(usage.prompt_tokens)
            ? Number(usage.prompt_tokens)
            : undefined;
          const outputTokens = Number.isSafeInteger(usage.completion_tokens)
            ? Number(usage.completion_tokens)
            : undefined;
          if (inputTokens !== undefined || outputTokens !== undefined) {
            yield { type: "usage", inputTokens, outputTokens };
          }
        }
        const choices = array(data.choices);
        if (choices.length === 0) {
          if (!usage) {
            throw new ProviderProtocolError(
              "invalid_response",
              "Model provider returned an invalid completion event.",
              false,
            );
          }
          continue;
        }
        for (const rawChoice of choices) {
          const choice = object(rawChoice);
          const delta = object(choice?.delta);
          if (!choice || !delta) {
            throw new ProviderProtocolError(
              "invalid_response",
              "Model provider returned an invalid completion delta.",
              false,
            );
          }
          const text = string(delta.content);
          if (text) yield { type: "text_delta", text };
          const reasoning = string(delta.reasoning_content);
          if (reasoning) yield { type: "reasoning_delta", text: reasoning };
          const finishReason = string(choice.finish_reason);
          if (finishReason === "length") {
            yield {
              type: "error",
              code: "output_limit_reached",
              message: "Model provider stopped at the output token limit.",
              retryable: false,
            };
            return;
          }
          if (finishReason === "content_filter") {
            yield {
              type: "error",
              code: "content_filtered",
              message: "Model provider filtered the generated content.",
              retryable: false,
            };
            return;
          }
          if (finishReason === "insufficient_system_resource") {
            yield {
              type: "error",
              code: "provider_unavailable",
              message: "Model provider could not complete the request.",
              retryable: true,
            };
            return;
          }
          if (finishReason === "stop" || finishReason === "tool_calls") {
            sawNormalFinish = true;
          } else if (finishReason) {
            throw new ProviderProtocolError(
              "invalid_response",
              "Model provider returned an unknown finish reason.",
              false,
            );
          }
          for (const rawCall of array(delta.tool_calls)) {
            const call = object(rawCall);
            const index = Number(call?.index);
            const fn = object(call?.function);
            if (!call || !Number.isSafeInteger(index) || index < 0 || !fn) {
              throw new ProviderProtocolError(
                "invalid_response",
                "Model provider returned an invalid tool call delta.",
                false,
              );
            }
            const existing = tools.get(index);
            const id = string(call.id) ?? existing?.id ?? `tool-${index}`;
            const name = string(fn.name) ?? existing?.name ?? "";
            const next = existing ?? { id, name, started: false };
            next.id = id;
            next.name = name;
            if (!next.started && next.name) {
              next.started = true;
              yield {
                type: "tool_call_start",
                id: next.id,
                name: next.name,
              };
            }
            const argumentsDelta = string(fn.arguments);
            if (argumentsDelta) {
              if (!next.started) {
                throw new ProviderProtocolError(
                  "invalid_response",
                  "Model provider emitted tool arguments before a tool name.",
                  false,
                );
              }
              yield {
                type: "tool_call_delta",
                id: next.id,
                argumentsDelta,
              };
            }
            tools.set(index, next);
          }
        }
      }
      throw new ProviderProtocolError(
        "invalid_response",
        "Model provider stream ended before completion.",
        false,
      );
    } catch (error) {
      yield* this.failure(error);
    }
  }
}
