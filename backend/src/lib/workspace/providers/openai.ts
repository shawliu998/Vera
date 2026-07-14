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

type ToolState = {
  id: string;
  name: string;
  started: boolean;
  sawDelta: boolean;
};

export class OpenAIResponsesProvider extends BoundModelProvider {
  constructor(
    config: ModelProviderConfig,
    dependencies: ModelProviderDependencies,
  ) {
    super(config, dependencies);
    if (config.profile.provider !== "openai") {
      throw new Error("OpenAI adapter received the wrong provider.");
    }
  }

  protected validationPath(config: ModelProviderConfig) {
    return `models/${encodeURIComponent(config.profile.model)}`;
  }

  protected validConnectionPayload(
    payload: unknown,
    config: ModelProviderConfig,
  ) {
    return string(object(payload)?.id) === config.profile.model;
  }

  private payload(request: ModelGenerateRequest) {
    const format = request.responseFormat;
    const text =
      format?.type === "json"
        ? {
            format:
              format.schema === undefined
                ? { type: "json_object" }
                : {
                    type: "json_schema",
                    name: "vera_response",
                    strict: true,
                    schema: format.schema ?? DEFAULT_JSON_OBJECT_SCHEMA,
                  },
          }
        : undefined;
    return {
      model: request.model,
      input: request.messages.map((message) => ({
        role: message.role === "tool" ? "user" : message.role,
        content:
          message.role === "tool"
            ? normalizedToolMessage(message.content)
            : message.content,
      })),
      stream: true,
      ...(request.temperature !== undefined
        ? { temperature: request.temperature }
        : {}),
      ...(request.maxOutputTokens !== undefined
        ? { max_output_tokens: request.maxOutputTokens }
        : {}),
      ...(text ? { text } : {}),
      ...(request.tools?.length
        ? {
            tools: request.tools.map((tool) => ({
              type: "function",
              name: tool.name,
              ...(tool.description ? { description: tool.description } : {}),
              parameters: tool.parameters,
              ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
            })),
            tool_choice: "auto",
          }
        : {}),
      ...(request.metadata ? { metadata: request.metadata } : {}),
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

    const tools = new Map<string, ToolState>();
    let terminal = false;
    try {
      for await (const record of this.transport.postJsonSse(
        this.config,
        "responses",
        this.payload(request),
        signal,
      )) {
        if (record.done) continue;
        const data = record.data!;
        const type = string(data.type) ?? record.event;
        if (type === "response.output_text.delta") {
          const text = string(data.delta);
          if (text === undefined) {
            throw new ProviderProtocolError(
              "invalid_response",
              "OpenAI returned an invalid text delta.",
              false,
            );
          }
          if (text) yield { type: "text_delta", text };
          continue;
        }
        if (type === "response.refusal.delta") {
          const text = string(data.delta);
          if (text) yield { type: "text_delta", text };
          continue;
        }
        if (type === "response.reasoning_summary_text.delta") {
          const text = string(data.delta);
          if (text) yield { type: "reasoning_delta", text };
          continue;
        }
        if (type === "response.output_item.added") {
          const item = object(data.item);
          if (string(item?.type) !== "function_call") continue;
          const itemId = string(item?.id);
          const id = string(item?.call_id) ?? itemId;
          const name = string(item?.name);
          if (!itemId || !id || !name) {
            throw new ProviderProtocolError(
              "invalid_response",
              "OpenAI returned an invalid tool call.",
              false,
            );
          }
          tools.set(itemId, {
            id,
            name,
            started: true,
            sawDelta: false,
          });
          yield { type: "tool_call_start", id, name };
          continue;
        }
        if (type === "response.function_call_arguments.delta") {
          const itemId = string(data.item_id);
          const delta = string(data.delta);
          const tool = itemId ? tools.get(itemId) : undefined;
          if (!tool || delta === undefined) {
            throw new ProviderProtocolError(
              "invalid_response",
              "OpenAI returned an invalid tool argument delta.",
              false,
            );
          }
          tool.sawDelta = true;
          if (delta) {
            yield {
              type: "tool_call_delta",
              id: tool.id,
              argumentsDelta: delta,
            };
          }
          continue;
        }
        if (type === "response.output_item.done") {
          const item = object(data.item);
          if (string(item?.type) !== "function_call") continue;
          const itemId = string(item?.id);
          const tool = itemId ? tools.get(itemId) : undefined;
          const id = tool?.id ?? string(item?.call_id) ?? itemId;
          const name = tool?.name ?? string(item?.name);
          if (!id || !name) {
            throw new ProviderProtocolError(
              "invalid_response",
              "OpenAI returned an invalid completed tool call.",
              false,
            );
          }
          if (!tool) yield { type: "tool_call_start", id, name };
          const args = string(item?.arguments);
          if (args && !tool?.sawDelta) {
            yield {
              type: "tool_call_delta",
              id,
              argumentsDelta: args,
            };
          }
          yield { type: "tool_call_end", id };
          if (itemId) tools.delete(itemId);
          continue;
        }
        if (type === "response.completed") {
          const response = object(data.response);
          const usage = object(response?.usage);
          const inputTokens = integer(usage?.input_tokens);
          const outputTokens = integer(usage?.output_tokens);
          if (inputTokens !== undefined || outputTokens !== undefined) {
            yield { type: "usage", inputTokens, outputTokens };
          }
          for (const tool of tools.values()) {
            if (tool.started) yield { type: "tool_call_end", id: tool.id };
          }
          terminal = true;
          yield { type: "completed" };
          return;
        }
        if (
          type === "response.failed" ||
          type === "response.incomplete" ||
          type === "error"
        ) {
          const response = object(data.response);
          const error = object(response?.error) ?? object(data.error);
          yield {
            type: "error",
            code: safeProviderCode(error?.code, "openai_generation_failed"),
            message: "OpenAI generation failed.",
            retryable: false,
          };
          return;
        }
        // OpenAI may add event types; unknown events are forward-compatible.
      }
      if (!terminal) {
        throw new ProviderProtocolError(
          "invalid_response",
          "OpenAI stream ended before response.completed.",
          false,
        );
      }
    } catch (error) {
      yield* this.failure(error);
    }
  }
}
