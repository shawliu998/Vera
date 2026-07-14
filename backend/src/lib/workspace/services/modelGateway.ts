import { WorkspaceApiError } from "../errors";
import {
  BoundedResponseBodyError,
  readBoundedResponseBody,
} from "../../network/readBoundedResponseBody";
import {
  defaultBaseUrlForProvider,
  normalizeModelEndpoint,
} from "../modelCompatibility";
import type { StoredModelProfileRecord } from "../repositories/modelProfiles";
import type { CredentialResolverPort } from "./credentialStore";
import type { EndpointBindingSnapshot } from "./modelProfiles";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;
export const MODEL_GATEWAY_HARD_MAX_REQUEST_BYTES = 256 * 1024;
export const MODEL_GATEWAY_HARD_MAX_RESPONSE_BYTES = 256 * 1024;
const SAFE_REQUEST_HEADERS = new Set([
  "accept",
  "content-type",
  "anthropic-version",
  "anthropic-beta",
  "openai-beta",
]);
const BLOCKED_REQUEST_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "x-goog-api-key",
  "cookie",
  "set-cookie",
  "host",
  "connection",
  "content-length",
  "proxy-authorization",
  "transfer-encoding",
  "upgrade",
]);

export type ModelGatewayRequest = {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  pathOrUrl: string;
  headers?: Record<string, string>;
  body?: BodyInit | null;
  contentType?: string | null;
  accept?: string | null;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxRedirects?: number;
  maxResponseBytes?: number;
  expectedBinding: EndpointBindingSnapshot;
};

export type ModelGatewayResponseHeaders = {
  contentType: string | null;
  contentLength: number | null;
  retryAfter: string | null;
  requestId: string | null;
};

export type ModelGatewayResponse = {
  status: number;
  headers: ModelGatewayResponseHeaders;
  bodyText: string;
};

export type ModelGatewayOptions = {
  fetchImpl?: typeof fetch;
  allowLocalDevelopmentBaseUrl?: boolean;
};

function normalizeRequestTarget(
  profile: StoredModelProfileRecord,
  pathOrUrl: string,
) {
  const baseUrl =
    profile.baseUrl ?? defaultBaseUrlForProvider(profile.provider) ?? null;
  if (!baseUrl) {
    throw new WorkspaceApiError(
      409,
      "CONFLICT",
      "Model profile base URL is unavailable.",
    );
  }
  let parsedBase: URL;
  try {
    parsedBase = new URL(baseUrl);
  } catch {
    throw new WorkspaceApiError(
      409,
      "CONFLICT",
      "Model profile base URL is invalid.",
    );
  }
  if (/^https?:\/\//i.test(pathOrUrl)) {
    try {
      return new URL(pathOrUrl);
    } catch {
      throw new WorkspaceApiError(
        400,
        "VALIDATION_ERROR",
        "Model request URL is invalid.",
      );
    }
  }
  const baseWithSlash = new URL(
    parsedBase.pathname.endsWith("/")
      ? parsedBase.toString()
      : `${parsedBase.toString()}/`,
  );
  return new URL(pathOrUrl.replace(/^\/+/g, ""), baseWithSlash);
}

function providerCredentialHeaders(
  profile: StoredModelProfileRecord,
  secret: string,
): Record<string, string> {
  if (
    profile.provider === "openai" ||
    profile.provider === "deepseek" ||
    profile.provider === "openai_compatible"
  ) {
    return { authorization: `Bearer ${secret}` };
  }
  if (profile.provider === "anthropic") {
    return {
      "x-api-key": secret,
      "anthropic-version": "2023-06-01",
    };
  }
  return { "x-goog-api-key": secret };
}

function safeResponseHeaders(headers: Headers): ModelGatewayResponseHeaders {
  const rawContentLength = headers.get("content-length");
  const contentLength =
    rawContentLength === null ? null : Number(rawContentLength);
  return {
    contentType: headers.get("content-type"),
    contentLength:
      contentLength !== null &&
      Number.isFinite(contentLength) &&
      contentLength >= 0
        ? contentLength
        : null,
    retryAfter: headers.get("retry-after"),
    requestId:
      headers.get("x-request-id") ??
      headers.get("request-id") ??
      headers.get("anthropic-request-id"),
  };
}

function addAllowedHeaders(
  target: Headers,
  extra: Record<string, string> | undefined,
) {
  for (const [rawKey, value] of Object.entries(extra ?? {})) {
    const key = rawKey.toLowerCase();
    if (BLOCKED_REQUEST_HEADERS.has(key) || !SAFE_REQUEST_HEADERS.has(key)) {
      throw new WorkspaceApiError(
        400,
        "VALIDATION_ERROR",
        "Model request headers contain unsupported fields.",
      );
    }
    target.set(key, value);
  }
}

function boundedResponseLimit(value: number | undefined) {
  const candidate = value ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (!Number.isSafeInteger(candidate) || candidate <= 0) {
    throw new WorkspaceApiError(
      400,
      "VALIDATION_ERROR",
      "Model response size limit is invalid.",
    );
  }
  return Math.min(candidate, MODEL_GATEWAY_HARD_MAX_RESPONSE_BYTES);
}

function normalizedRequestBody(body: BodyInit | null | undefined) {
  if (body == null) {
    return { body: null, bytes: 0 };
  }
  if (typeof body === "string") {
    return { body, bytes: Buffer.byteLength(body) };
  }
  if (body instanceof URLSearchParams) {
    return { body, bytes: Buffer.byteLength(body.toString()) };
  }
  if (body instanceof Blob) {
    return { body, bytes: body.size };
  }
  if (body instanceof ArrayBuffer) {
    return { body: new Uint8Array(body), bytes: body.byteLength };
  }
  if (ArrayBuffer.isView(body)) {
    return { body, bytes: body.byteLength };
  }
  throw new WorkspaceApiError(
    400,
    "VALIDATION_ERROR",
    "Model request body type is unsupported.",
  );
}

function createRequestSignal(request: {
  signal?: AbortSignal;
  timeoutMs?: number;
}) {
  const timeoutMs = Math.min(
    Math.max(1, request.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    3_600_000,
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let abortListener: (() => void) | null = null;
  if (request.signal) {
    if (request.signal.aborted) {
      controller.abort(request.signal.reason);
    } else {
      abortListener = () => controller.abort(request.signal?.reason);
      request.signal.addEventListener("abort", abortListener, { once: true });
    }
  }
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timeout);
      if (abortListener && request.signal) {
        request.signal.removeEventListener("abort", abortListener);
      }
    },
  };
}

export function buildEndpointBindingSnapshot(
  profile: StoredModelProfileRecord,
  allowLocalDevelopmentBaseUrl = false,
): EndpointBindingSnapshot {
  const normalized = normalizeModelEndpoint({
    provider: profile.provider,
    baseUrl: profile.baseUrl,
    allowLocalDevelopmentBaseUrl,
  });
  return {
    provider: profile.provider,
    model: profile.model,
    normalizedBaseUrl:
      normalized.baseUrl ?? defaultBaseUrlForProvider(profile.provider) ?? null,
    canonicalOrigin: normalized.canonicalOrigin,
    executionRevision: profile.executionRevision,
    profileUpdatedAt: profile.updatedAt,
  };
}

export class ModelGateway {
  private readonly fetchImpl: typeof fetch;
  private readonly allowLocalDevelopmentBaseUrl: boolean;

  constructor(
    private readonly resolver: CredentialResolverPort,
    options: ModelGatewayOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.allowLocalDevelopmentBaseUrl =
      options.allowLocalDevelopmentBaseUrl ?? false;
  }

  private binding(profile: StoredModelProfileRecord) {
    const snapshot = buildEndpointBindingSnapshot(
      profile,
      this.allowLocalDevelopmentBaseUrl,
    );
    if (!profile.credentialOrigin || !snapshot.canonicalOrigin) {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Model profile origin is unavailable.",
      );
    }
    if (snapshot.canonicalOrigin !== profile.credentialOrigin) {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Model profile origin binding is stale.",
      );
    }
    return {
      resolverInput: {
        reference: profile.credentialRef!,
        binding: {
          profileId: profile.id,
          provider: profile.provider,
          canonicalOrigin: profile.credentialOrigin,
        },
      },
      snapshot,
    };
  }

  private assertExpectedBinding(
    actual: EndpointBindingSnapshot,
    expected: EndpointBindingSnapshot,
  ) {
    if (
      actual.provider !== expected.provider ||
      actual.model !== expected.model ||
      actual.normalizedBaseUrl !== expected.normalizedBaseUrl ||
      actual.canonicalOrigin !== expected.canonicalOrigin ||
      actual.executionRevision !== expected.executionRevision
    ) {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Model profile binding changed before the provider request.",
      );
    }
  }

  private async execute(
    url: URL,
    request: ModelGatewayRequest,
    headers: Headers,
    signal: AbortSignal,
  ): Promise<Response> {
    const response = await this.fetchImpl(url, {
      method: request.method,
      headers,
      body: request.body ?? null,
      signal,
      redirect: "manual",
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      throw new WorkspaceApiError(
        502,
        "JOB_FAILED",
        "Model provider request failed.",
      );
    }
    return response;
  }

  async request(
    profile: StoredModelProfileRecord,
    request: ModelGatewayRequest,
  ): Promise<ModelGatewayResponse> {
    if (!profile.enabled) {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Model profile is disabled.",
      );
    }
    if (profile.credentialState !== "configured" || !profile.credentialRef) {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Model credential is not configured.",
      );
    }
    const { resolverInput, snapshot } = this.binding(profile);
    this.assertExpectedBinding(snapshot, request.expectedBinding);
    const target = normalizeRequestTarget(profile, request.pathOrUrl);
    if (target.origin !== resolverInput.binding.canonicalOrigin) {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Model request origin does not match the configured credential origin.",
      );
    }
    const requestBody = normalizedRequestBody(request.body ?? null);
    if (requestBody.bytes > MODEL_GATEWAY_HARD_MAX_REQUEST_BYTES) {
      throw new WorkspaceApiError(
        400,
        "VALIDATION_ERROR",
        "Model request body exceeded the allowed size.",
      );
    }
    const responseLimit = boundedResponseLimit(request.maxResponseBytes);
    const runtime = createRequestSignal(request);
    let secret = "";
    try {
      const headers = new Headers();
      if (request.contentType) headers.set("content-type", request.contentType);
      if (request.accept) headers.set("accept", request.accept);
      addAllowedHeaders(headers, request.headers);
      secret = this.resolver.resolve(resolverInput);
      for (const [key, value] of Object.entries(
        providerCredentialHeaders(profile, secret),
      )) {
        headers.set(key, value);
      }
      const response = await this.execute(
        target,
        {
          ...request,
          body: requestBody.body,
        },
        headers,
        runtime.signal,
      );
      const bodyText = await readBoundedResponseBody(response, responseLimit, {
        signal: runtime.signal,
      });
      if (!response.ok) {
        throw new WorkspaceApiError(
          502,
          "JOB_FAILED",
          "Model provider request failed.",
        );
      }
      return {
        status: response.status,
        headers: safeResponseHeaders(response.headers),
        bodyText,
      };
    } catch (error) {
      if (
        error instanceof BoundedResponseBodyError &&
        (error.reason === "content_length" || error.reason === "limit_exceeded")
      ) {
        throw new WorkspaceApiError(
          502,
          "JOB_FAILED",
          "Model provider response exceeded the allowed size.",
        );
      }
      if (error instanceof WorkspaceApiError) throw error;
      throw new WorkspaceApiError(
        502,
        "JOB_FAILED",
        "Model provider request failed.",
      );
    } finally {
      secret = "";
      runtime.cleanup();
    }
  }

  async requestJson<T>(
    profile: StoredModelProfileRecord,
    request: ModelGatewayRequest,
  ) {
    const response = await this.request(profile, request);
    try {
      return {
        ...response,
        body: JSON.parse(response.bodyText) as T,
      };
    } catch {
      throw new WorkspaceApiError(
        502,
        "JOB_FAILED",
        "Model provider response was invalid.",
      );
    }
  }
}
