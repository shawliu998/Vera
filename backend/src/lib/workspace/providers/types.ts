import type { StoredModelProfileRecord } from "../repositories/modelProfiles";
import type { CredentialResolutionInput } from "../services/credentialStore";
import type { EndpointBindingSnapshot } from "../services/modelProfiles";

export type ModelMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
};

export type ModelToolDefinition = {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
  strict?: boolean;
};

export type ModelGenerateRequest = {
  model: string;
  messages: ModelMessage[];
  temperature?: number;
  maxOutputTokens?: number;
  responseFormat?: {
    type: "text" | "json";
    schema?: unknown;
  };
  tools?: ModelToolDefinition[];
  metadata?: Record<string, string>;
};

export type ModelEvent =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "tool_call_start"; id: string; name: string }
  | { type: "tool_call_delta"; id: string; argumentsDelta: string }
  | { type: "tool_call_end"; id: string }
  | { type: "usage"; inputTokens?: number; outputTokens?: number }
  | { type: "completed" }
  | {
      type: "error";
      code: string;
      message: string;
      retryable: boolean;
    };

export type ModelProviderValidation =
  | { valid: true }
  | {
      valid: false;
      code: string;
      message: string;
      retryable: boolean;
    };

/**
 * A profile and the endpoint/revision attestation captured by the existing
 * model-settings boundary. Adapters never accept a free-form request URL.
 */
export type ModelProviderConfig = {
  profile: StoredModelProfileRecord;
  expectedBinding: EndpointBindingSnapshot;
  allowLocalDevelopmentBaseUrl?: boolean;
};

export interface ModelProvider {
  readonly id: StoredModelProfileRecord["provider"];

  validateConfiguration(
    config: ModelProviderConfig,
  ): Promise<ModelProviderValidation>;

  generate(
    request: ModelGenerateRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelEvent>;
}

/** Sync today; Promise-compatible so the desktop credential worker can replace it. */
export type ModelProviderCredentialResolver = {
  resolve(input: CredentialResolutionInput): string | Promise<string>;
};

export type HardenedGenericTransport = {
  /** Caller attests DNS resolution is pinned and revalidated for every hop. */
  attestation: "dns-pinned-and-revalidated-v1";
  fetchImpl: typeof fetch;
};

export type ModelProviderDependencies = {
  credentialResolver: ModelProviderCredentialResolver;
  fetchImpl?: typeof fetch;
  hardenedGenericTransport?: HardenedGenericTransport;
};

export type SseRecord = {
  event: string | null;
  data: Record<string, unknown> | null;
  done: boolean;
};

export class ProviderProtocolError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.name = "ProviderProtocolError";
    this.code = code;
    this.retryable = retryable;
  }

  toEvent(): Extract<ModelEvent, { type: "error" }> {
    return {
      type: "error",
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    };
  }
}

export function isAbortError(error: unknown) {
  return (
    (error instanceof Error && error.name === "AbortError") ||
    (typeof DOMException !== "undefined" &&
      error instanceof DOMException &&
      error.name === "AbortError")
  );
}

export function abortError(): Error {
  const error = new Error("Model generation was cancelled.");
  error.name = "AbortError";
  return error;
}
