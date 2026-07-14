import type { StoredModelProfileRecord } from "../repositories/modelProfiles";
import {
  defaultBaseUrlForProvider,
  defaultOriginForProvider,
} from "../modelCompatibility";
import { ProviderStreamingTransport } from "./transport";
import {
  abortError,
  isAbortError,
  ProviderProtocolError,
  type ModelEvent,
  type ModelGenerateRequest,
  type ModelProvider,
  type ModelProviderConfig,
  type ModelProviderDependencies,
  type ModelProviderValidation,
  type ModelToolDefinition,
} from "./types";

const REQUEST_FIELDS = new Set([
  "model",
  "messages",
  "temperature",
  "maxOutputTokens",
  "responseFormat",
  "tools",
  "metadata",
]);
const MESSAGE_FIELDS = new Set(["role", "content"]);
const TOOL_FIELDS = new Set(["name", "description", "parameters", "strict"]);

export const DEFAULT_JSON_OBJECT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: true,
});

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactFields(value: Record<string, unknown>, allowed: Set<string>) {
  return Object.keys(value).every((key) => allowed.has(key));
}

function serializableSize(value: unknown) {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? null : Buffer.byteLength(serialized);
  } catch {
    return null;
  }
}

function invalidRequest(message: string) {
  return new ProviderProtocolError("invalid_request", message, false);
}

export function validateGenerateRequest(
  profile: StoredModelProfileRecord,
  request: ModelGenerateRequest,
): ProviderProtocolError | null {
  if (!record(request) || !exactFields(request, REQUEST_FIELDS)) {
    return invalidRequest("Model generation request is invalid.");
  }
  if (
    typeof request.model !== "string" ||
    request.model !== profile.model ||
    request.model.length > 256
  ) {
    return invalidRequest(
      "Model generation request does not match the profile.",
    );
  }
  if (
    !Array.isArray(request.messages) ||
    request.messages.length < 1 ||
    request.messages.length > 512
  ) {
    return invalidRequest("Model messages are invalid.");
  }
  let contentBytes = 0;
  for (const message of request.messages) {
    if (
      !record(message) ||
      !exactFields(message, MESSAGE_FIELDS) ||
      !["system", "user", "assistant", "tool"].includes(String(message.role)) ||
      typeof message.content !== "string"
    ) {
      return invalidRequest("Model messages are invalid.");
    }
    contentBytes += Buffer.byteLength(message.content);
  }
  if (contentBytes > 220 * 1024) {
    return invalidRequest("Model message content exceeded the allowed size.");
  }
  if (
    request.temperature !== undefined &&
    (typeof request.temperature !== "number" ||
      !Number.isFinite(request.temperature) ||
      request.temperature < 0 ||
      request.temperature > 2)
  ) {
    return invalidRequest("Model temperature is invalid.");
  }
  if (
    request.maxOutputTokens !== undefined &&
    (!Number.isSafeInteger(request.maxOutputTokens) ||
      request.maxOutputTokens < 1 ||
      request.maxOutputTokens > 1_000_000 ||
      (profile.maxOutputTokens !== null &&
        request.maxOutputTokens > profile.maxOutputTokens))
  ) {
    return invalidRequest("Model output token limit is invalid.");
  }
  if (request.responseFormat !== undefined) {
    if (
      !record(request.responseFormat) ||
      !exactFields(request.responseFormat, new Set(["type", "schema"])) ||
      !["text", "json"].includes(String(request.responseFormat.type)) ||
      (request.responseFormat.type === "text" &&
        request.responseFormat.schema !== undefined)
    ) {
      return invalidRequest("Model response format is invalid.");
    }
    if (request.responseFormat.schema !== undefined) {
      if (
        !record(request.responseFormat.schema) ||
        (serializableSize(request.responseFormat.schema) ?? Infinity) >
          64 * 1024
      ) {
        return invalidRequest("Model response schema is invalid.");
      }
    }
    if (
      request.responseFormat.type === "json" &&
      !profile.capabilities.structuredOutput
    ) {
      return new ProviderProtocolError(
        "capability_not_enabled",
        "Structured output is not enabled for this model profile.",
        false,
      );
    }
  }
  if (request.tools !== undefined) {
    if (!Array.isArray(request.tools) || request.tools.length > 128) {
      return invalidRequest("Model tools are invalid.");
    }
    for (const tool of request.tools) {
      if (
        !record(tool) ||
        !exactFields(tool, TOOL_FIELDS) ||
        typeof tool.name !== "string" ||
        !/^[A-Za-z0-9_-]{1,64}$/.test(tool.name) ||
        (tool.description !== undefined &&
          (typeof tool.description !== "string" ||
            tool.description.length > 4096)) ||
        !record(tool.parameters) ||
        (tool.strict !== undefined && typeof tool.strict !== "boolean") ||
        (serializableSize(tool.parameters) ?? Infinity) > 64 * 1024
      ) {
        return invalidRequest("Model tools are invalid.");
      }
    }
    if (request.tools.length > 0 && !profile.capabilities.toolCalling) {
      return new ProviderProtocolError(
        "capability_not_enabled",
        "Tool calling is not enabled for this model profile.",
        false,
      );
    }
  }
  if (request.metadata !== undefined) {
    if (
      !record(request.metadata) ||
      Object.keys(request.metadata).length > 16
    ) {
      return invalidRequest("Model request metadata is invalid.");
    }
    for (const [key, value] of Object.entries(request.metadata)) {
      if (
        !/^[A-Za-z0-9_.:-]{1,64}$/.test(key) ||
        typeof value !== "string" ||
        value.length > 512
      ) {
        return invalidRequest("Model request metadata is invalid.");
      }
    }
  }
  if (!profile.capabilities.streaming) {
    return new ProviderProtocolError(
      "capability_not_enabled",
      "Streaming is not enabled for this model profile.",
      false,
    );
  }
  return null;
}

export function normalizedToolMessage(content: string) {
  // The attachment's unified message contract has no tool-call correlation
  // id. Preserve the result as explicit user context instead of inventing an
  // invalid provider-native tool_result/function_call_output object.
  return `[Tool result]\n${content}`;
}

export function openAiStyleTools(tools: ModelToolDefinition[] | undefined) {
  return tools?.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: tool.parameters,
      ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
    },
  }));
}

export function integer(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Number(value)
    : undefined;
}

export function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function object(value: unknown): Record<string, unknown> | null {
  return record(value) ? value : null;
}

export function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function safeProviderCode(value: unknown, fallback: string) {
  return typeof value === "string" && /^[a-z0-9_.-]{1,80}$/i.test(value)
    ? value.toLowerCase()
    : fallback;
}

export abstract class BoundModelProvider implements ModelProvider {
  readonly id: StoredModelProfileRecord["provider"];
  protected readonly transport: ProviderStreamingTransport;

  protected constructor(
    protected readonly config: ModelProviderConfig,
    dependencies: ModelProviderDependencies,
  ) {
    this.id = config.profile.provider;
    if (
      this.id !== "openai_compatible" &&
      (config.expectedBinding.normalizedBaseUrl !==
        defaultBaseUrlForProvider(this.id) ||
        config.expectedBinding.canonicalOrigin !==
          defaultOriginForProvider(this.id))
    ) {
      throw new Error(
        "Official provider adapters require the pinned official endpoint.",
      );
    }
    this.transport = new ProviderStreamingTransport(
      dependencies.credentialResolver,
      dependencies.fetchImpl,
      dependencies.hardenedGenericTransport,
    );
  }

  protected abstract validationPath(config: ModelProviderConfig): string;
  protected abstract validConnectionPayload(
    payload: unknown,
    config: ModelProviderConfig,
  ): boolean;

  async validateConfiguration(
    config: ModelProviderConfig,
  ): Promise<ModelProviderValidation> {
    if (config.profile.provider !== this.id) {
      return {
        valid: false,
        code: "configuration_error",
        message: "Model provider configuration does not match the adapter.",
        retryable: false,
      };
    }
    try {
      const payload = await this.transport.getJson(
        config,
        this.validationPath(config),
      );
      if (!this.validConnectionPayload(payload, config)) {
        return {
          valid: false,
          code: "invalid_response",
          message: "Model provider returned invalid connection data.",
          retryable: false,
        };
      }
      return { valid: true };
    } catch (error) {
      if (error instanceof ProviderProtocolError) {
        return {
          valid: false,
          code: error.code,
          message: error.message,
          retryable: error.retryable,
        };
      }
      return {
        valid: false,
        code: "configuration_error",
        message: "Model provider configuration is invalid.",
        retryable: false,
      };
    }
  }

  protected requestError(request: ModelGenerateRequest) {
    return validateGenerateRequest(this.config.profile, request);
  }

  protected async *failure(error: unknown): AsyncIterable<ModelEvent> {
    if (isAbortError(error)) throw abortError();
    if (error instanceof ProviderProtocolError) {
      yield error.toEvent();
      return;
    }
    yield {
      type: "error",
      code: "provider_failure",
      message: "Model provider generation failed.",
      retryable: false,
    };
  }

  abstract generate(
    request: ModelGenerateRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelEvent>;
}
