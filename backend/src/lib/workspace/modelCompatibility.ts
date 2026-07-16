import { isIP } from "node:net";

import { WorkspaceApiError } from "./errors";
import type { ModelProfile } from "./types";

export type ModelProvider = ModelProfile["provider"];
export type CredentialState = "configured" | "missing" | "invalid";
export type RuntimeModelCapabilities = ModelProfile["capabilities"];
export type ModelAvailabilityStatus =
  | "ready"
  | "disabled"
  | "missing_credential"
  | "invalid_credential"
  | "credential_unavailable"
  | "origin_unbound"
  | "runtime_unwired";

export interface ModelProviderAdapterRegistryPort {
  runtimeWired(): boolean;
  lookup(input: {
    provider: ModelProvider;
    model: string;
    normalizedBaseUrl: string | null;
    canonicalOrigin: string | null;
  }): {
    runtimeWired: true;
    capabilities: RuntimeModelCapabilities;
  } | null;
}

export const DISABLED_RUNTIME_MODEL_CAPABILITIES: RuntimeModelCapabilities =
  Object.freeze({
    streaming: false,
    toolCalling: false,
    structuredOutput: false,
    vision: false,
  });

export type NormalizedModelEndpoint = {
  baseUrl: string | null;
  canonicalOrigin: string | null;
  requiresCredential: true;
};

const DEFAULT_PROVIDER_ORIGINS: Record<
  Exclude<ModelProvider, "openai_compatible">,
  string
> = {
  openai: "https://api.openai.com",
  deepseek: "https://api.deepseek.com",
  anthropic: "https://api.anthropic.com",
  gemini: "https://generativelanguage.googleapis.com",
};

const DEFAULT_PROVIDER_BASE_URLS: Record<
  Exclude<ModelProvider, "openai_compatible">,
  string
> = {
  openai: "https://api.openai.com/v1",
  deepseek: "https://api.deepseek.com",
  anthropic: "https://api.anthropic.com",
  gemini: "https://generativelanguage.googleapis.com",
};

function normalizedPathname(pathname: string) {
  if (pathname === "/") return "";
  const trimmed = pathname.replace(/\/+$/g, "");
  return trimmed || "";
}

function normalizeHostnameLiteral(hostname: string) {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/g, "");
}

function normalizeParsedUrl(url: URL) {
  return `${url.protocol}//${url.host}${normalizedPathname(url.pathname)}`;
}

export function defaultOriginForProvider(provider: ModelProvider) {
  if (provider === "openai_compatible") return null;
  return DEFAULT_PROVIDER_ORIGINS[provider];
}

export function defaultBaseUrlForProvider(provider: ModelProvider) {
  if (provider === "openai_compatible") return null;
  return DEFAULT_PROVIDER_BASE_URLS[provider];
}

export function credentialStateFromPublicStatus(
  status: ModelProfile["credentialStatus"] | string | null | undefined,
): CredentialState {
  if (status === "configured") return "configured";
  if (status === "unavailable") return "invalid";
  return "missing";
}

export function publicStatusFromCredentialState(
  state: CredentialState,
): ModelProfile["credentialStatus"] {
  if (state === "configured") return "configured";
  if (state === "invalid") return "unavailable";
  return "not_configured";
}

export function isLoopbackHostname(hostname: string) {
  const value = normalizeHostnameLiteral(hostname);
  if (value.startsWith("::ffff:")) {
    return isLoopbackHostname(value.slice("::ffff:".length));
  }
  return (
    value === "localhost" ||
    value.endsWith(".localhost") ||
    value === "::" ||
    value === "::1" ||
    value === "0.0.0.0" ||
    /^127(?:\.\d{1,3}){3}$/.test(value)
  );
}

function isPrivateIpv4Hostname(hostname: string) {
  const value = normalizeHostnameLiteral(hostname);
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return false;
  const [a, b] = value.split(".").map((part) => Number(part));
  if (
    [a, b].some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51) ||
    (a === 203 && b === 0) ||
    a >= 224
  );
}

function mappedIpv4Hostname(hostname: string) {
  const value = normalizeHostnameLiteral(hostname);
  if (!value.startsWith("::ffff:")) return null;
  const mapped = value.slice("::ffff:".length);
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(mapped)) {
    return mapped;
  }
  const groups = mapped.split(":").filter((part) => part.length > 0);
  if (groups.length === 0 || groups.length > 2) return null;
  if (groups.some((part) => !/^[0-9a-f]{1,4}$/i.test(part))) return null;
  const [high, low] =
    groups.length === 1
      ? [0, Number.parseInt(groups[0], 16)]
      : groups.map((part) => Number.parseInt(part, 16));
  if (
    !Number.isInteger(high) ||
    !Number.isInteger(low) ||
    high < 0 ||
    high > 0xffff ||
    low < 0 ||
    low > 0xffff
  ) {
    return null;
  }
  return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
}

function isDocumentationIpv6Hostname(hostname: string) {
  return /^2001:0*db8(?::|$)/i.test(normalizeHostnameLiteral(hostname));
}

function isPrivateIpv6Hostname(hostname: string) {
  const value = normalizeHostnameLiteral(hostname);
  if (value === "::" || value === "::1") return true;
  const mappedIpv4 = mappedIpv4Hostname(value);
  if (mappedIpv4) {
    return isLoopbackHostname(mappedIpv4) || isPrivateIpv4Hostname(mappedIpv4);
  }
  return (
    isDocumentationIpv6Hostname(value) ||
    /^f[c-d]/.test(value) ||
    /^fe[89ab]/.test(value) ||
    /^ff/i.test(value)
  );
}

export function isLocalDevelopmentHostname(hostname: string) {
  const value = normalizeHostnameLiteral(hostname);
  if (value === "localhost" || value.endsWith(".localhost")) return true;
  const family = isIP(value);
  if (family === 4) {
    return isLoopbackHostname(value) || isPrivateIpv4Hostname(value);
  }
  if (family === 6) {
    return isLoopbackHostname(value) || isPrivateIpv6Hostname(value);
  }
  return false;
}

export function normalizeModelEndpoint(input: {
  provider: ModelProvider;
  baseUrl: string | null | undefined;
  allowLocalDevelopmentBaseUrl?: boolean;
}): NormalizedModelEndpoint {
  // This is only a lexical prefilter. Custom remote runtimes remain fail-closed
  // until the future transport resolves, pins, and revalidates DNS on every hop.
  const rawBaseUrl = input.baseUrl?.trim() ? input.baseUrl.trim() : null;
  if (!rawBaseUrl) {
    return {
      baseUrl: null,
      canonicalOrigin: defaultOriginForProvider(input.provider),
      requiresCredential: true,
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(rawBaseUrl);
  } catch {
    throw new WorkspaceApiError(
      400,
      "VALIDATION_ERROR",
      "Model base URL is invalid.",
    );
  }

  if (parsed.username || parsed.password) {
    throw new WorkspaceApiError(
      400,
      "VALIDATION_ERROR",
      "Model base URL must not include user credentials.",
    );
  }

  const localHostname = isLocalDevelopmentHostname(parsed.hostname);
  if (parsed.protocol === "http:") {
    if (!input.allowLocalDevelopmentBaseUrl || !localHostname) {
      throw new WorkspaceApiError(
        403,
        "FORBIDDEN",
        "Loopback and private model endpoints require explicit local-development enablement.",
      );
    }
  } else if (parsed.protocol !== "https:") {
    throw new WorkspaceApiError(
      400,
      "VALIDATION_ERROR",
      "Model base URL must use HTTPS.",
    );
  } else if (localHostname && !input.allowLocalDevelopmentBaseUrl) {
    throw new WorkspaceApiError(
      403,
      "FORBIDDEN",
      "Loopback and private model endpoints require explicit local-development enablement.",
    );
  }

  return {
    baseUrl: normalizeParsedUrl(parsed),
    canonicalOrigin: `${parsed.protocol}//${parsed.host}`,
    requiresCredential: true,
  };
}

export function tryNormalizeModelEndpoint(input: {
  provider: ModelProvider;
  baseUrl: string | null | undefined;
  allowLocalDevelopmentBaseUrl?: boolean;
}): NormalizedModelEndpoint | null {
  try {
    return normalizeModelEndpoint(input);
  } catch {
    return null;
  }
}

export function availabilityForModelProfile(input: {
  enabled: boolean;
  credentialState: CredentialState;
  canonicalOrigin: string | null;
  adapterReady?: boolean;
  credentialResolverReady?: boolean;
  requiresCredential?: boolean;
}) {
  if (!input.enabled) {
    return { status: "disabled" as const, selectable: false };
  }
  if (input.canonicalOrigin === null) {
    return { status: "origin_unbound" as const, selectable: false };
  }
  if (!input.adapterReady) {
    return { status: "runtime_unwired" as const, selectable: false };
  }
  if (input.requiresCredential !== false) {
    if (!input.credentialResolverReady) {
      return { status: "credential_unavailable" as const, selectable: false };
    }
    if (input.credentialState === "missing") {
      return { status: "missing_credential" as const, selectable: false };
    }
    if (input.credentialState === "invalid") {
      return { status: "invalid_credential" as const, selectable: false };
    }
  }
  return { status: "ready" as const, selectable: true };
}
