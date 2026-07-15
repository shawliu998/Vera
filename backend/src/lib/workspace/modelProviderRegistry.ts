import { randomUUID } from "node:crypto";

import { WorkspaceApiError } from "./errors";
import {
  defaultBaseUrlForProvider,
  defaultOriginForProvider,
  type ModelProviderAdapterRegistryPort,
  type RuntimeModelCapabilities,
} from "./modelCompatibility";
import { createModelProvider } from "./providers";
import { createHardenedGenericTransport } from "./providers/hardenedGenericTransport";
import type {
  HardenedGenericTransport,
  ModelGenerateRequest,
  ModelProvider,
  ModelProviderConfig,
} from "./providers";
import type { StoredModelProfileRecord } from "./repositories/modelProfiles";
import type { CredentialStorePort } from "./services/credentialStore";
import type { EndpointBindingSnapshot } from "./services/modelProfiles";
import {
  instrumentModelProvider,
  type ModelCallDiagnosticsPort,
} from "./modelCallDiagnostics";

const OFFICIAL_PROVIDERS = [
  "openai",
  "deepseek",
  "anthropic",
  "gemini",
] as const;

const PROVIDER_CAPABILITIES: RuntimeModelCapabilities = Object.freeze({
  streaming: true,
  toolCalling: true,
  structuredOutput: true,
  // The unified request contract currently carries text parts only. Advertising
  // image input before that contract exists would make vision a fake feature.
  vision: false,
});

type ProviderRuntimeRequest =
  | {
      operation: "validate";
      profile: StoredModelProfileRecord;
      expectedBinding: EndpointBindingSnapshot;
    }
  | {
      operation: "generate";
      profile: StoredModelProfileRecord;
      expectedBinding: EndpointBindingSnapshot;
      request: ModelGenerateRequest;
      signal: AbortSignal;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function providerRuntimeRequest(value: unknown): ProviderRuntimeRequest {
  if (
    !isRecord(value) ||
    (value.operation !== "validate" && value.operation !== "generate")
  ) {
    throw new WorkspaceApiError(
      400,
      "VALIDATION_ERROR",
      "Model provider runtime request is invalid.",
    );
  }
  const profile = value.profile as StoredModelProfileRecord;
  const expectedBinding = value.expectedBinding as EndpointBindingSnapshot;
  if (
    !isRecord(profile) ||
    !isRecord(expectedBinding) ||
    profile.provider !== expectedBinding.provider ||
    profile.model !== expectedBinding.model
  ) {
    throw new WorkspaceApiError(
      409,
      "CONFLICT",
      "Model provider binding is invalid.",
    );
  }
  if (value.operation === "validate") {
    return { operation: "validate", profile, expectedBinding };
  }
  if (!isRecord(value.request) || !(value.signal instanceof AbortSignal)) {
    throw new WorkspaceApiError(
      400,
      "VALIDATION_ERROR",
      "Model generation runtime request is invalid.",
    );
  }
  return {
    operation: "generate",
    profile,
    expectedBinding,
    request: value.request as ModelGenerateRequest,
    signal: value.signal,
  };
}

export type WorkspaceModelProviderRegistryOptions = {
  fetchImpl?: typeof fetch;
  hardenedGenericTransport?: HardenedGenericTransport;
  allowLocalDevelopmentBaseUrl?: boolean;
  modelCallDiagnostics?: ModelCallDiagnosticsPort;
  modelCallRequestId?: () => string;
  modelCallClock?: () => Date;
};

/**
 * A registry of concrete provider adapters. Its compatibility port is consumed
 * by ModelProfilesService for availability, while createProvider() is the same
 * factory used by connection probes and later generation runtimes.
 */
export class WorkspaceModelProviderRegistry implements ModelProviderAdapterRegistryPort {
  private readonly fetchImpl: typeof fetch;
  private readonly hardenedGenericTransport:
    | HardenedGenericTransport
    | undefined;
  private readonly allowLocalDevelopmentBaseUrl: boolean;
  private readonly modelCallDiagnostics: ModelCallDiagnosticsPort | null;
  private readonly modelCallRequestId: () => string;
  private readonly modelCallClock: () => Date;

  constructor(
    private readonly credentialStore: CredentialStorePort,
    options: WorkspaceModelProviderRegistryOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.allowLocalDevelopmentBaseUrl =
      options.allowLocalDevelopmentBaseUrl ?? false;
    this.modelCallDiagnostics = options.modelCallDiagnostics ?? null;
    this.modelCallRequestId = options.modelCallRequestId ?? randomUUID;
    this.modelCallClock = options.modelCallClock ?? (() => new Date());
    this.hardenedGenericTransport =
      options.hardenedGenericTransport ??
      createHardenedGenericTransport({
        allowLoopbackHttp: this.allowLocalDevelopmentBaseUrl,
      });
  }

  supportedProviders(): StoredModelProfileRecord["provider"][] {
    return [
      ...OFFICIAL_PROVIDERS,
      ...(this.hardenedGenericTransport?.attestation ===
      "dns-pinned-and-revalidated-v1"
        ? (["openai_compatible"] as const)
        : []),
    ];
  }

  runtimeWired(): boolean {
    try {
      return (
        this.credentialStore.isAvailable() &&
        this.supportedProviders().length > 0
      );
    } catch {
      return false;
    }
  }

  capabilitiesFor(provider: StoredModelProfileRecord["provider"]) {
    return this.supportedProviders().includes(provider)
      ? PROVIDER_CAPABILITIES
      : null;
  }

  lookup(input: {
    provider: StoredModelProfileRecord["provider"];
    model: string;
    normalizedBaseUrl: string | null;
    canonicalOrigin: string | null;
  }) {
    const capabilities = this.capabilitiesFor(input.provider);
    if (!capabilities || !this.runtimeWired()) return null;
    if (
      input.provider !== "openai_compatible" &&
      (input.normalizedBaseUrl !== defaultBaseUrlForProvider(input.provider) ||
        input.canonicalOrigin !== defaultOriginForProvider(input.provider))
    ) {
      return null;
    }
    if (
      input.provider === "openai_compatible" &&
      (!input.normalizedBaseUrl || !input.canonicalOrigin)
    ) {
      return null;
    }
    return {
      runtimeWired: true as const,
      capabilities,
      handleRequest: (value: unknown) => {
        const request = providerRuntimeRequest(value);
        if (
          request.profile.provider !== input.provider ||
          request.profile.model !== input.model ||
          request.expectedBinding.normalizedBaseUrl !==
            input.normalizedBaseUrl ||
          request.expectedBinding.canonicalOrigin !== input.canonicalOrigin
        ) {
          throw new WorkspaceApiError(
            409,
            "CONFLICT",
            "Model provider binding changed before execution.",
          );
        }
        const provider = this.createProvider({
          profile: request.profile,
          expectedBinding: request.expectedBinding,
          allowLocalDevelopmentBaseUrl: this.allowLocalDevelopmentBaseUrl,
        });
        return request.operation === "validate"
          ? provider.validateConfiguration({
              profile: request.profile,
              expectedBinding: request.expectedBinding,
              allowLocalDevelopmentBaseUrl: this.allowLocalDevelopmentBaseUrl,
            })
          : provider.generate(request.request, request.signal);
      },
    };
  }

  createProvider(config: ModelProviderConfig): ModelProvider {
    const provider = createModelProvider(config, {
      credentialResolver: this.credentialStore,
      fetchImpl: this.fetchImpl,
      ...(this.hardenedGenericTransport
        ? { hardenedGenericTransport: this.hardenedGenericTransport }
        : {}),
    });
    return this.modelCallDiagnostics
      ? instrumentModelProvider({
          provider,
          config,
          diagnostics: this.modelCallDiagnostics,
          requestId: this.modelCallRequestId,
          clock: this.modelCallClock,
        })
      : provider;
  }
}

export { OFFICIAL_PROVIDERS, PROVIDER_CAPABILITIES };
