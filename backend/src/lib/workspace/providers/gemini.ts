import {
  array,
  BoundModelProvider,
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

function modelId(value: string) {
  return value.replace(/^models\//, "");
}

const ERROR_FINISH_REASONS = new Set([
  "SAFETY",
  "RECITATION",
  "BLOCKLIST",
  "PROHIBITED_CONTENT",
  "SPII",
  "MALFORMED_FUNCTION_CALL",
  "OTHER",
]);

export class GeminiNativeProvider extends BoundModelProvider {
  constructor(
    config: ModelProviderConfig,
    dependencies: ModelProviderDependencies,
  ) {
    super(config, dependencies);
    if (config.profile.provider !== "gemini") {
      throw new Error("Gemini adapter received the wrong provider.");
    }
  }

  protected validationPath(config: ModelProviderConfig) {
    return `v1beta/models/${encodeURIComponent(modelId(config.profile.model))}`;
  }

  protected validConnectionPayload(
    payload: unknown,
    config: ModelProviderConfig,
  ) {
    return (
      string(object(payload)?.name) ===
      `models/${modelId(config.profile.model)}`
    );
  }

  private payload(request: ModelGenerateRequest) {
    const system = request.messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n");
    const contents = request.messages
      .filter((message) => message.role !== "system")
      .map((message) => ({
        role: message.role === "assistant" ? "model" : "user",
        parts: [
          {
            text:
              message.role === "tool"
                ? normalizedToolMessage(message.content)
                : message.content,
          },
        ],
      }));
    if (contents.length === 0) {
      throw new ProviderProtocolError(
        "invalid_request",
        "Gemini requires at least one user or model message.",
        false,
      );
    }
    const generationConfig = {
      ...(request.temperature !== undefined
        ? { temperature: request.temperature }
        : {}),
      ...(request.maxOutputTokens !== undefined
        ? { maxOutputTokens: request.maxOutputTokens }
        : {}),
      ...(request.responseFormat?.type === "json"
        ? {
            responseMimeType: "application/json",
            ...(request.responseFormat.schema !== undefined
              ? { responseJsonSchema: request.responseFormat.schema }
              : {}),
          }
        : {}),
    };
    return {
      contents,
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
      ...(request.tools?.length
        ? {
            tools: [
              {
                functionDeclarations: request.tools.map((tool) => ({
                  name: tool.name,
                  ...(tool.description
                    ? { description: tool.description }
                    : {}),
                  parameters: tool.parameters,
                })),
              },
            ],
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

    let sawPayload = false;
    let sawNormalFinish = false;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    try {
      const path = `v1beta/models/${encodeURIComponent(
        modelId(request.model),
      )}:streamGenerateContent?alt=sse`;
      for await (const record of this.transport.postJsonSse(
        this.config,
        path,
        this.payload(request),
        signal,
      )) {
        if (record.done) continue;
        sawPayload = true;
        const data = record.data!;
        const providerError = object(data.error);
        if (providerError) {
          yield {
            type: "error",
            code: safeProviderCode(
              providerError.status ?? providerError.code,
              "gemini_generation_failed",
            ),
            message: "Gemini generation failed.",
            retryable: false,
          };
          return;
        }
        const feedback = object(data.promptFeedback);
        const blockReason = string(feedback?.blockReason);
        if (blockReason) {
          yield {
            type: "error",
            code: safeProviderCode(blockReason, "gemini_prompt_blocked"),
            message: "Gemini blocked the generation request.",
            retryable: false,
          };
          return;
        }
        const usage = object(data.usageMetadata);
        inputTokens = integer(usage?.promptTokenCount) ?? inputTokens;
        outputTokens = integer(usage?.candidatesTokenCount) ?? outputTokens;

        const candidates = array(data.candidates);
        if (candidates.length === 0) {
          if (!usage) {
            throw new ProviderProtocolError(
              "invalid_response",
              "Gemini returned an invalid generation event.",
              false,
            );
          }
          continue;
        }
        for (const rawCandidate of candidates) {
          const candidate = object(rawCandidate);
          if (!candidate) {
            throw new ProviderProtocolError(
              "invalid_response",
              "Gemini returned an invalid candidate.",
              false,
            );
          }
          const finishReason = string(candidate.finishReason);
          if (finishReason && ERROR_FINISH_REASONS.has(finishReason)) {
            yield {
              type: "error",
              code: safeProviderCode(finishReason, "gemini_generation_failed"),
              message: "Gemini generation ended with an error.",
              retryable: false,
            };
            return;
          }
          if (finishReason === "MAX_TOKENS") {
            yield {
              type: "error",
              code: "output_limit_reached",
              message: "Gemini stopped at the output token limit.",
              retryable: false,
            };
            return;
          }
          if (finishReason === "STOP") {
            sawNormalFinish = true;
          } else if (finishReason) {
            throw new ProviderProtocolError(
              "invalid_response",
              "Gemini returned an unknown finish reason.",
              false,
            );
          }
          const parts = array(object(candidate.content)?.parts);
          for (const rawPart of parts) {
            const part = object(rawPart);
            if (!part) continue;
            const text = string(part.text);
            if (text) {
              if (part.thought === true) {
                yield { type: "reasoning_delta", text };
              } else {
                yield { type: "text_delta", text };
              }
            }
            const functionCall = object(part.functionCall);
            if (functionCall) {
              const name = string(functionCall.name);
              if (!name) {
                throw new ProviderProtocolError(
                  "invalid_response",
                  "Gemini returned an invalid function call.",
                  false,
                );
              }
              const id = string(functionCall.id) ?? `gemini-${name}`;
              let argumentsDelta: string;
              try {
                argumentsDelta = JSON.stringify(
                  object(functionCall.args) ?? {},
                );
              } catch {
                throw new ProviderProtocolError(
                  "invalid_response",
                  "Gemini returned invalid function arguments.",
                  false,
                );
              }
              yield { type: "tool_call_start", id, name };
              yield { type: "tool_call_delta", id, argumentsDelta };
              yield { type: "tool_call_end", id };
            }
          }
        }
      }
      if (!sawPayload) {
        throw new ProviderProtocolError(
          "invalid_response",
          "Gemini returned an empty stream.",
          false,
        );
      }
      if (!sawNormalFinish) {
        throw new ProviderProtocolError(
          "invalid_response",
          "Gemini stream ended without a normal finish reason.",
          false,
        );
      }
      if (inputTokens !== undefined || outputTokens !== undefined) {
        yield { type: "usage", inputTokens, outputTokens };
      }
      yield { type: "completed" };
    } catch (error) {
      yield* this.failure(error);
    }
  }
}
