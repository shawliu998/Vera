import { WorkspaceApiError } from "../errors";
import {
  defaultBaseUrlForProvider,
  defaultOriginForProvider,
} from "../modelCompatibility";
import {
  BoundedResponseBodyError,
  readBoundedResponseBody,
} from "../../network/readBoundedResponseBody";
import {
  buildEndpointBindingSnapshot,
  MODEL_GATEWAY_HARD_MAX_REQUEST_BYTES,
} from "../services/modelGateway";
import {
  CredentialWorkerCredentialNotFoundError,
  CredentialWorkerUnavailableError,
} from "../services/credentialWorkerClient";
import { readBoundedJsonSse } from "./sse";
import {
  abortError,
  type HardenedGenericTransport,
  isAbortError,
  type ModelProviderCredentialResolver,
  ProviderProtocolError,
  type ModelProviderConfig,
  type SseRecord,
} from "./types";

const PROVIDER_PROBE_TIMEOUT_MS = 15_000;
const PROVIDER_GENERATION_TIMEOUT_MS = 5 * 60_000;

function runtimeSignal(external: AbortSignal | null, timeoutMs: number) {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onExternalAbort = () => controller.abort(external?.reason);
  if (external?.aborted) onExternalAbort();
  else external?.addEventListener("abort", onExternalAbort, { once: true });
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup() {
      clearTimeout(timeout);
      external?.removeEventListener("abort", onExternalAbort);
    },
  };
}

function assertSameBinding(
  config: ModelProviderConfig,
  options: { requireEnabled: boolean },
) {
  const actual = buildEndpointBindingSnapshot(
    config.profile,
    config.allowLocalDevelopmentBaseUrl ?? false,
  );
  const expected = config.expectedBinding;
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
  if (
    (options.requireEnabled && !config.profile.enabled) ||
    config.profile.credentialState !== "configured" ||
    !config.profile.credentialRef ||
    !config.profile.credentialOrigin ||
    !expected.normalizedBaseUrl ||
    !expected.canonicalOrigin ||
    config.profile.credentialOrigin !== expected.canonicalOrigin
  ) {
    throw new WorkspaceApiError(
      409,
      "CONFLICT",
      "Model provider configuration is unavailable.",
    );
  }
  return expected;
}

function providerError(status: number): ProviderProtocolError {
  if (status === 401) {
    return new ProviderProtocolError(
      "authentication_failed",
      "Model provider authentication failed.",
      false,
    );
  }
  if (status === 403) {
    return new ProviderProtocolError(
      "access_denied",
      "Model provider denied access to the requested resource.",
      false,
    );
  }
  if (status === 404) {
    return new ProviderProtocolError(
      "model_unavailable",
      "Configured model is unavailable from the provider.",
      false,
    );
  }
  if (status === 429) {
    return new ProviderProtocolError(
      "rate_limited",
      "Model provider rate limit was reached.",
      true,
    );
  }
  if (status === 408 || status === 425) {
    return new ProviderProtocolError(
      "provider_timeout",
      "Model provider request timed out.",
      true,
    );
  }
  if (status >= 500) {
    return new ProviderProtocolError(
      "provider_unavailable",
      "Model provider is temporarily unavailable.",
      true,
    );
  }
  return new ProviderProtocolError(
    "provider_request_failed",
    "Model provider rejected the request.",
    false,
  );
}

function requestUrl(
  config: ModelProviderConfig,
  path: string,
  options: { requireEnabled: boolean },
) {
  const binding = assertSameBinding(config, options);
  const base = new URL(
    binding.normalizedBaseUrl!.endsWith("/")
      ? binding.normalizedBaseUrl!
      : `${binding.normalizedBaseUrl!}/`,
  );
  const target = new URL(path.replace(/^\/+/, ""), base);
  if (target.origin !== binding.canonicalOrigin) {
    throw new WorkspaceApiError(
      409,
      "CONFLICT",
      "Model request origin does not match the configured credential origin.",
    );
  }
  return target;
}

function authorizationHeaders(
  config: ModelProviderConfig,
  secret: string,
  accept: string,
) {
  const headers = new Headers({
    accept,
    "content-type": "application/json",
  });
  if (
    config.profile.provider === "openai" ||
    config.profile.provider === "deepseek" ||
    config.profile.provider === "openai_compatible"
  ) {
    headers.set("authorization", `Bearer ${secret}`);
  } else if (config.profile.provider === "anthropic") {
    headers.set("x-api-key", secret);
    headers.set("anthropic-version", "2023-06-01");
  } else {
    headers.set("x-goog-api-key", secret);
  }
  return headers;
}

export class ProviderStreamingTransport {
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly resolver: ModelProviderCredentialResolver,
    fetchImpl?: typeof fetch,
    private readonly hardenedGenericTransport?: HardenedGenericTransport,
  ) {
    this.fetchImpl = fetchImpl ?? fetch;
  }

  private fetchFor(config: ModelProviderConfig) {
    if (config.profile.provider !== "openai_compatible") {
      if (
        config.expectedBinding.normalizedBaseUrl !==
          defaultBaseUrlForProvider(config.profile.provider) ||
        config.expectedBinding.canonicalOrigin !==
          defaultOriginForProvider(config.profile.provider)
      ) {
        throw new ProviderProtocolError(
          "configuration_error",
          "Official provider requires its pinned official endpoint.",
          false,
        );
      }
      return this.fetchImpl;
    }
    if (
      this.hardenedGenericTransport?.attestation !==
      "dns-pinned-and-revalidated-v1"
    ) {
      throw new ProviderProtocolError(
        "hardened_transport_required",
        "Generic provider requires a DNS-pinned transport.",
        false,
      );
    }
    return this.hardenedGenericTransport.fetchImpl;
  }

  private credential(
    config: ModelProviderConfig,
    binding: ReturnType<typeof assertSameBinding>,
  ) {
    return this.resolver.resolve({
      reference: config.profile.credentialRef!,
      binding: {
        profileId: config.profile.id,
        provider: config.profile.provider,
        canonicalOrigin: binding.canonicalOrigin!,
      },
    });
  }

  /** A real, credentialed probe. Disabled profiles may be tested explicitly. */
  async getJson(config: ModelProviderConfig, path: string): Promise<unknown> {
    const runtime = runtimeSignal(null, PROVIDER_PROBE_TIMEOUT_MS);
    let secret = "";
    try {
      const binding = assertSameBinding(config, { requireEnabled: false });
      const url = requestUrl(config, path, { requireEnabled: false });
      const fetchImpl = this.fetchFor(config);
      secret = await Promise.resolve(this.credential(config, binding));
      const response = await fetchImpl(url, {
        method: "GET",
        headers: authorizationHeaders(config, secret, "application/json"),
        signal: runtime.signal,
        redirect: "manual",
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        throw new ProviderProtocolError(
          "provider_redirect_rejected",
          "Model provider redirect was rejected.",
          false,
        );
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw providerError(response.status);
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
        await response.body?.cancel();
        throw new ProviderProtocolError(
          "invalid_response",
          "Model provider returned an invalid connection response.",
          false,
        );
      }
      const text = await readBoundedResponseBody(response, 64 * 1024, {
        signal: runtime.signal,
      });
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new ProviderProtocolError(
          "invalid_response",
          "Model provider returned invalid connection data.",
          false,
        );
      }
    } catch (error) {
      if (runtime.timedOut()) {
        throw new ProviderProtocolError(
          "provider_timeout",
          "Model provider connection test timed out.",
          true,
        );
      }
      if (error instanceof ProviderProtocolError) throw error;
      if (error instanceof BoundedResponseBodyError) {
        throw new ProviderProtocolError(
          "response_too_large",
          "Model provider connection response exceeded the allowed size.",
          false,
        );
      }
      if (error instanceof CredentialWorkerCredentialNotFoundError) {
        throw new ProviderProtocolError(
          "credential_not_found",
          "The configured model credential was not found.",
          false,
        );
      }
      if (error instanceof CredentialWorkerUnavailableError) {
        throw new ProviderProtocolError(
          "credential_unavailable",
          "The local credential store is unavailable.",
          true,
        );
      }
      if (error instanceof WorkspaceApiError) {
        throw new ProviderProtocolError(
          "configuration_error",
          "Model provider configuration is invalid.",
          false,
        );
      }
      throw new ProviderProtocolError(
        "network_error",
        "Model provider could not be reached.",
        true,
      );
    } finally {
      secret = "";
      runtime.cleanup();
    }
  }

  async *postJsonSse(
    config: ModelProviderConfig,
    path: string,
    payload: unknown,
    signal: AbortSignal,
  ): AsyncIterable<SseRecord> {
    if (signal.aborted) throw abortError();
    let binding: ReturnType<typeof assertSameBinding>;
    let url: URL;
    try {
      binding = assertSameBinding(config, { requireEnabled: true });
      url = requestUrl(config, path, { requireEnabled: true });
    } catch {
      throw new ProviderProtocolError(
        "configuration_error",
        "Model provider configuration is invalid.",
        false,
      );
    }
    let body: string;
    try {
      body = JSON.stringify(payload);
    } catch {
      throw new ProviderProtocolError(
        "invalid_request",
        "Model request could not be serialized.",
        false,
      );
    }
    if (Buffer.byteLength(body) > MODEL_GATEWAY_HARD_MAX_REQUEST_BYTES) {
      throw new ProviderProtocolError(
        "request_too_large",
        "Model request exceeded the allowed size.",
        false,
      );
    }

    const runtime = runtimeSignal(signal, PROVIDER_GENERATION_TIMEOUT_MS);
    let secret = "";
    try {
      const fetchImpl = this.fetchFor(config);
      secret = await Promise.resolve(this.credential(config, binding));
      const headers = authorizationHeaders(config, secret, "text/event-stream");
      const response = await fetchImpl(url, {
        method: "POST",
        headers,
        body,
        signal: runtime.signal,
        redirect: "manual",
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        throw new ProviderProtocolError(
          "provider_redirect_rejected",
          "Model provider redirect was rejected.",
          false,
        );
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw providerError(response.status);
      }
      yield* readBoundedJsonSse(response, runtime.signal);
    } catch (error) {
      if (signal.aborted) throw abortError();
      if (runtime.timedOut()) {
        throw new ProviderProtocolError(
          "provider_timeout",
          "Model provider generation timed out.",
          true,
        );
      }
      if (isAbortError(error)) throw abortError();
      if (error instanceof ProviderProtocolError) throw error;
      if (error instanceof CredentialWorkerCredentialNotFoundError) {
        throw new ProviderProtocolError(
          "credential_not_found",
          "The configured model credential was not found.",
          false,
        );
      }
      if (error instanceof CredentialWorkerUnavailableError) {
        throw new ProviderProtocolError(
          "credential_unavailable",
          "The local credential store is unavailable.",
          true,
        );
      }
      if (error instanceof WorkspaceApiError) {
        throw new ProviderProtocolError(
          "configuration_error",
          "Model provider configuration is invalid.",
          false,
        );
      }
      throw new ProviderProtocolError(
        "network_error",
        "Model provider could not be reached.",
        true,
      );
    } finally {
      secret = "";
      runtime.cleanup();
    }
  }
}
