import {
  BoundModelProvider,
  DEFAULT_JSON_OBJECT_SCHEMA,
  integer,
  normalizedToolMessage,
  object,
  safeProviderCode,
  string,
} from "./base";
import {
  ProviderProtocolError,
  type ModelEvent,
  type ModelGenerateRequest,
  type ModelProviderConfig,
  type ModelProviderDependencies,
} from "./types";

type ToolState = { id: string; name: string };

export class AnthropicMessagesProvider extends BoundModelProvider {
  constructor(
    config: ModelProviderConfig,
    dependencies: ModelProviderDependencies,
  ) {
    super(config, dependencies);
    if (config.profile.provider !== "anthropic") {
      throw new Error("Anthropic adapter received the wrong provider.");
    }
  }

  protected validationPath(config: ModelProviderConfig) {
    return `v1/models/${encodeURIComponent(config.profile.model)}`;
  }

  protected validConnectionPayload(
    payload: unknown,
    config: ModelProviderConfig,
  ) {
    return string(object(payload)?.id) === config.profile.model;
  }

  private payload(request: ModelGenerateRequest) {
    const system = request.messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n");
    const messages = request.messages
      .filter((message) => message.role !== "system")
      .map((message) => ({
        role: message.role === "assistant" ? "assistant" : "user",
        content:
          message.role === "tool"
            ? normalizedToolMessage(message.content)
            : message.content,
      }));
    if (messages.length === 0) {
      throw new ProviderProtocolError(
        "invalid_request",
        "Anthropic requires at least one user or assistant message.",
        false,
      );
    }
    const schema = request.responseFormat?.schema ?? DEFAULT_JSON_OBJECT_SCHEMA;
    return {
      model: request.model,
      messages,
      max_tokens: request.maxOutputTokens ?? 4096,
      stream: true,
      ...(system ? { system } : {}),
      ...(request.temperature !== undefined
        ? { temperature: request.temperature }
        : {}),
      ...(request.responseFormat?.type === "json"
        ? {
            output_config: {
              format: { type: "json_schema", schema },
            },
          }
        : {}),
      ...(request.tools?.length
        ? {
            tools: request.tools.map((tool) => ({
              name: tool.name,
              ...(tool.description ? { description: tool.description } : {}),
              input_schema: tool.parameters,
              ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
            })),
          }
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
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let stopReason: string | null = null;
    let terminal = false;
    try {
      const payload = this.payload(request);
      for await (const record of this.transport.postJsonSse(
        this.config,
        "v1/messages",
        payload,
        signal,
      )) {
        if (record.done) {
          throw new ProviderProtocolError(
            "invalid_response",
            "Anthropic returned an unexpected completion marker.",
            false,
          );
        }
        const data = record.data!;
        const type = string(data.type) ?? record.event;
        if (type === "message_start") {
          const usage = object(object(data.message)?.usage);
          inputTokens = integer(usage?.input_tokens) ?? inputTokens;
          outputTokens = integer(usage?.output_tokens) ?? outputTokens;
          continue;
        }
        if (type === "content_block_start") {
          const index = Number(data.index);
          const block = object(data.content_block);
          if (!Number.isSafeInteger(index) || index < 0 || !block) {
            throw new ProviderProtocolError(
              "invalid_response",
              "Anthropic returned an invalid content block.",
              false,
            );
          }
          if (string(block.type) === "tool_use") {
            const id = string(block.id);
            const name = string(block.name);
            if (!id || !name) {
              throw new ProviderProtocolError(
                "invalid_response",
                "Anthropic returned an invalid tool call.",
                false,
              );
            }
            tools.set(index, { id, name });
            yield { type: "tool_call_start", id, name };
          }
          continue;
        }
        if (type === "content_block_delta") {
          const index = Number(data.index);
          const delta = object(data.delta);
          if (!Number.isSafeInteger(index) || index < 0 || !delta) {
            throw new ProviderProtocolError(
              "invalid_response",
              "Anthropic returned an invalid content delta.",
              false,
            );
          }
          if (string(delta.type) === "text_delta") {
            const text = string(delta.text);
            if (text) yield { type: "text_delta", text };
          } else if (string(delta.type) === "thinking_delta") {
            const text = string(delta.thinking);
            if (text) yield { type: "reasoning_delta", text };
          } else if (string(delta.type) === "input_json_delta") {
            const tool = tools.get(index);
            const argumentsDelta = string(delta.partial_json);
            if (!tool || argumentsDelta === undefined) {
              throw new ProviderProtocolError(
                "invalid_response",
                "Anthropic returned an invalid tool argument delta.",
                false,
              );
            }
            if (argumentsDelta) {
              yield {
                type: "tool_call_delta",
                id: tool.id,
                argumentsDelta,
              };
            }
          }
          continue;
        }
        if (type === "content_block_stop") {
          const index = Number(data.index);
          const tool = tools.get(index);
          if (tool) {
            yield { type: "tool_call_end", id: tool.id };
            tools.delete(index);
          }
          continue;
        }
        if (type === "message_delta") {
          const delta = object(data.delta);
          const usage = object(data.usage);
          outputTokens = integer(usage?.output_tokens) ?? outputTokens;
          stopReason = string(delta?.stop_reason) ?? stopReason;
          if (
            stopReason === "max_tokens" ||
            stopReason === "model_context_window_exceeded"
          ) {
            if (inputTokens !== undefined || outputTokens !== undefined) {
              yield { type: "usage", inputTokens, outputTokens };
            }
            yield {
              type: "error",
              code: "output_limit_reached",
              message: "Anthropic stopped at the output token limit.",
              retryable: false,
            };
            return;
          }
          if (stopReason === "pause_turn") {
            yield {
              type: "error",
              code: "provider_paused",
              message: "Anthropic paused the generation turn.",
              retryable: true,
            };
            return;
          }
          continue;
        }
        if (type === "message_stop") {
          if (
            !stopReason ||
            !["end_turn", "stop_sequence", "tool_use", "refusal"].includes(
              stopReason,
            )
          ) {
            throw new ProviderProtocolError(
              "invalid_response",
              "Anthropic returned an invalid stop reason.",
              false,
            );
          }
          for (const tool of tools.values()) {
            yield { type: "tool_call_end", id: tool.id };
          }
          if (inputTokens !== undefined || outputTokens !== undefined) {
            yield { type: "usage", inputTokens, outputTokens };
          }
          terminal = true;
          yield { type: "completed" };
          return;
        }
        if (type === "error") {
          const error = object(data.error);
          yield {
            type: "error",
            code: safeProviderCode(error?.type, "anthropic_generation_failed"),
            message: "Anthropic generation failed.",
            retryable:
              string(error?.type) === "overloaded_error" ||
              string(error?.type) === "rate_limit_error",
          };
          return;
        }
        if (type === "ping") continue;
        // Unknown events are ignored per Anthropic's versioning guidance.
      }
      if (!terminal) {
        throw new ProviderProtocolError(
          "invalid_response",
          "Anthropic stream ended before message_stop.",
          false,
        );
      }
    } catch (error) {
      yield* this.failure(error);
    }
  }
}
