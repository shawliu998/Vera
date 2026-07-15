// Vera local adapter for the Settings structure ported from Mike
// e32daad5a4c64a5561e04c53ee12411e3c5e7238. The wire boundary is Vera-only:
// no Mike user profile, auth session, or stored credential value enters it.
import {
  veraApiRequest,
  VeraApiError,
  type VeraApiRequestOptions,
} from "./veraApi";
import { VERA_MODEL_CREDENTIAL_MAX_UTF8_BYTES } from "./veraCredentialLimits";
import { VeraRuntimeConfigurationError } from "./veraRuntime";

export const VERA_MODEL_PROVIDERS = [
  "openai",
  "deepseek",
  "anthropic",
  "gemini",
  "openai_compatible",
] as const;

export type VeraModelProvider = (typeof VERA_MODEL_PROVIDERS)[number];
export type VeraTheme = "system" | "light" | "dark";
export type VeraSettingsLocale = "zh-CN" | "en-US";

export interface VeraModelSettingsCapabilities {
  schema_version: "vera-workspace-model-settings-v1";
  settings_available: boolean;
  local_only: true;
  loopback_http_allowed: boolean;
  supported_providers: VeraModelProvider[];
  credential_write_enabled: boolean;
  secret_readback_supported: false;
  runtime_wired: boolean;
}

export const VERA_MODEL_CONNECTION_TEST_ERROR_CODES = [
  "authentication_failed",
  "access_denied",
  "model_unavailable",
  "rate_limited",
  "timeout",
  "network_error",
  "provider_unavailable",
  "invalid_response",
  "configuration_error",
  "credential_unavailable",
] as const;

export type VeraModelConnectionTestErrorCode =
  (typeof VERA_MODEL_CONNECTION_TEST_ERROR_CODES)[number];

export type VeraModelConnectionTest =
  | {
      status: "untested";
      error_code: null;
      retryable: false;
      latency_ms: null;
      tested_at: null;
    }
  | {
      status: "passed";
      error_code: null;
      retryable: false;
      latency_ms: number | null;
      tested_at: string;
    }
  | {
      status: "failed";
      error_code: VeraModelConnectionTestErrorCode;
      retryable: boolean;
      latency_ms: number | null;
      tested_at: string;
    }
  | {
      status: "stale";
      error_code: VeraModelConnectionTestErrorCode | null;
      retryable: boolean;
      latency_ms: number | null;
      tested_at: string;
    };

export interface VeraWorkspaceSettings {
  locale: VeraSettingsLocale;
  theme: VeraTheme;
  default_model_profile_id: string | null;
  default_project_id: string | null;
  updated_at: string;
}

export interface VeraModelProfile {
  id: string;
  name: string;
  provider: VeraModelProvider;
  model: string;
  base_url: string | null;
  context_window_tokens: number | null;
  max_output_tokens: number | null;
  enabled: boolean;
  is_default: boolean;
  created_at: string;
  updated_at: string;
  capabilities: VeraModelCapabilities;
  credential: {
    status: "configured" | "missing" | "invalid";
    configured: boolean;
    canonical_origin: string | null;
  };
  endpoint_binding: {
    provider: VeraModelProvider;
    model: string;
    normalized_base_url: string | null;
    canonical_origin: string | null;
    execution_revision: number;
    connection_revision: number;
    profile_updated_at: string;
  };
  availability: {
    status:
      | "ready"
      | "disabled"
      | "missing_credential"
      | "invalid_credential"
      | "credential_unavailable"
      | "origin_unbound"
      | "runtime_unwired";
    selectable: boolean;
  };
  connection_test: VeraModelConnectionTest;
  requires_credential: true;
}

export interface VeraModelCapabilities {
  streaming: boolean;
  toolCalling: boolean;
  structuredOutput: boolean;
  vision: boolean;
}

export interface VeraModelSettingsStatus {
  capabilities: VeraModelSettingsCapabilities;
  settings: VeraWorkspaceSettings;
  models: VeraModelProfile[];
}

export interface VeraWorkspaceSettingsPatch {
  locale?: VeraSettingsLocale;
  theme?: VeraTheme;
  default_model_profile_id?: string | null;
}

export interface VeraModelProfileMutation {
  name?: string;
  provider?: VeraModelProvider;
  model?: string;
  base_url?: string | null;
  context_window_tokens?: number | null;
  max_output_tokens?: number | null;
  capabilities?: VeraModelCapabilities;
}

const PROVIDERS = new Set<string>(VERA_MODEL_PROVIDERS);
const CONNECTION_TEST_ERROR_CODES = new Set<string>(
  VERA_MODEL_CONNECTION_TEST_ERROR_CODES,
);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STRICT_UTC_ISO_MILLISECONDS_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_MODEL_CONNECTION_REVISION = 2_147_483_647;
const MAX_MODEL_CONNECTION_TEST_LATENCY_MS = 600_000;
const MAX_MODEL_TOKEN_LIMIT = 10_000_000;

function invalidWire(label: string): never {
  throw new VeraApiError({
    status: 200,
    code: "INVALID_RESPONSE",
    message: `The Vera API returned invalid ${label}.`,
  });
}

function snakeCaseWireKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toLowerCase();
}

function isSensitiveWireKey(key: string): boolean {
  const normalized = snakeCaseWireKey(key);
  return (
    normalized === "secret" ||
    normalized === "secrets" ||
    normalized.endsWith("_secret") ||
    normalized.endsWith("_secrets") ||
    normalized === "api_key" ||
    normalized === "api_keys" ||
    normalized.endsWith("_api_key") ||
    normalized.endsWith("_api_keys") ||
    normalized === "credential_ref" ||
    normalized === "credential_refs" ||
    normalized.endsWith("_credential_ref") ||
    normalized.endsWith("_credential_refs") ||
    normalized === "credential_reference" ||
    normalized === "credential_references" ||
    normalized.endsWith("_credential_reference") ||
    normalized.endsWith("_credential_references")
  );
}

/** Reject sensitive response fields before interpreting any other wire data. */
export function assertNoVeraModelSecretFields(
  value: unknown,
  label = "model settings response",
): void {
  const seen = new Set<object>();
  const visit = (candidate: unknown): void => {
    if (typeof candidate !== "object" || candidate === null) return;
    if (seen.has(candidate)) return;
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    for (const [key, nested] of Object.entries(candidate)) {
      if (isSensitiveWireKey(key)) invalidWire(label);
      visit(nested);
    }
  };
  visit(value);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalidWire(label);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    invalidWire(label);
  }
}

function stringValue(
  value: unknown,
  label: string,
  options: { min?: number; max?: number } = {},
): string {
  if (typeof value !== "string") return invalidWire(label);
  const min = options.min ?? 0;
  const max = options.max ?? 10_000;
  if (
    value.length < min ||
    value.length > max ||
    (min > 0 && value.trim().length === 0)
  ) {
    return invalidWire(label);
  }
  return value;
}

function nullableString(
  value: unknown,
  label: string,
  options: { min?: number; max?: number } = {},
): string | null {
  return value === null ? null : stringValue(value, label, options);
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") return invalidWire(label);
  return value;
}

function literalBoolean<T extends boolean>(
  value: unknown,
  expected: T,
  label: string,
): T {
  if (value !== expected) return invalidWire(label);
  return expected;
}

function uuid(value: unknown, label: string): string {
  const parsed = stringValue(value, label, { min: 36, max: 36 });
  if (!UUID_PATTERN.test(parsed)) return invalidWire(label);
  return parsed;
}

function nullableUuid(value: unknown, label: string): string | null {
  return value === null ? null : uuid(value, label);
}

function timestamp(value: unknown, label: string): string {
  const parsed = stringValue(value, label, { min: 20, max: 40 });
  const milliseconds = Date.parse(parsed);
  if (
    !STRICT_UTC_ISO_MILLISECONDS_PATTERN.test(parsed) ||
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== parsed
  ) {
    return invalidWire(label);
  }
  return parsed;
}

function nullableTimestamp(value: unknown, label: string): string | null {
  return value === null ? null : timestamp(value, label);
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    return invalidWire(label);
  }
  return Number(value);
}

function positiveNullableInteger(value: unknown, label: string): number | null {
  if (value === null) return null;
  const parsed = nonNegativeInteger(value, label);
  if (parsed === 0) return invalidWire(label);
  return parsed;
}

function boundedNullableInteger(
  value: unknown,
  maximum: number,
  label: string,
): number | null {
  if (value === null) return null;
  const parsed = nonNegativeInteger(value, label);
  if (parsed > maximum) return invalidWire(label);
  return parsed;
}

function enumValue<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  label: string,
): Values[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    return invalidWire(label);
  }
  return value as Values[number];
}

function provider(value: unknown, label: string): VeraModelProvider {
  if (typeof value !== "string" || !PROVIDERS.has(value)) {
    return invalidWire(label);
  }
  return value as VeraModelProvider;
}

function connectionTestErrorCode(
  value: unknown,
  label: string,
): VeraModelConnectionTestErrorCode {
  if (typeof value !== "string" || !CONNECTION_TEST_ERROR_CODES.has(value)) {
    return invalidWire(label);
  }
  return value as VeraModelConnectionTestErrorCode;
}

function nullableConnectionTestErrorCode(
  value: unknown,
  label: string,
): VeraModelConnectionTestErrorCode | null {
  return value === null ? null : connectionTestErrorCode(value, label);
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}

function safeEndpoint(value: unknown, label: string): string | null {
  const parsed = nullableString(value, label, { min: 8, max: 500 });
  if (parsed === null) return null;
  let url: URL;
  try {
    url = new URL(parsed);
  } catch {
    return invalidWire(label);
  }
  if (
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && isLoopbackHostname(url.hostname))) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    return invalidWire(label);
  }
  return parsed;
}

function canonicalOrigin(value: unknown, label: string): string | null {
  const parsed = safeEndpoint(value, label);
  if (parsed === null) return null;
  const url = new URL(parsed);
  if (parsed !== url.origin) return invalidWire(label);
  return parsed;
}

function parseConnectionTest(value: unknown): VeraModelConnectionTest {
  const raw = record(value, "connection test");
  exactKeys(
    raw,
    ["status", "error_code", "retryable", "latency_ms", "tested_at"],
    "connection test",
  );
  const status = enumValue(
    raw.status,
    ["untested", "passed", "failed", "stale"] as const,
    "connection test status",
  );
  const errorCode = nullableConnectionTestErrorCode(
    raw.error_code,
    "connection test error code",
  );
  const retryable = booleanValue(raw.retryable, "connection test retryability");
  const latencyMs = boundedNullableInteger(
    raw.latency_ms,
    MAX_MODEL_CONNECTION_TEST_LATENCY_MS,
    "connection test latency",
  );
  const testedAt = nullableTimestamp(
    raw.tested_at,
    "connection test timestamp",
  );

  if (status === "untested") {
    if (
      errorCode !== null ||
      retryable ||
      latencyMs !== null ||
      testedAt !== null
    ) {
      return invalidWire("connection test");
    }
    return {
      status,
      error_code: null,
      retryable: false,
      latency_ms: null,
      tested_at: null,
    };
  }
  if (testedAt === null) return invalidWire("connection test");
  if (status === "passed") {
    if (errorCode !== null || retryable) return invalidWire("connection test");
    return {
      status,
      error_code: null,
      retryable: false,
      latency_ms: latencyMs,
      tested_at: testedAt,
    };
  }
  if (status === "failed") {
    if (errorCode === null) return invalidWire("connection test");
    return {
      status,
      error_code: errorCode,
      retryable,
      latency_ms: latencyMs,
      tested_at: testedAt,
    };
  }
  if (errorCode === null && retryable) return invalidWire("connection test");
  return {
    status,
    error_code: errorCode,
    retryable,
    latency_ms: latencyMs,
    tested_at: testedAt,
  };
}

export function parseVeraWorkspaceSettings(
  value: unknown,
): VeraWorkspaceSettings {
  assertNoVeraModelSecretFields(value, "workspace settings response");
  const raw = record(value, "workspace settings response");
  exactKeys(
    raw,
    [
      "locale",
      "theme",
      "default_model_profile_id",
      "default_project_id",
      "updated_at",
    ],
    "workspace settings response",
  );
  return {
    locale: enumValue(raw.locale, ["zh-CN", "en-US"] as const, "locale"),
    theme: enumValue(raw.theme, ["system", "light", "dark"] as const, "theme"),
    default_model_profile_id: nullableUuid(
      raw.default_model_profile_id,
      "default model profile",
    ),
    default_project_id: nullableUuid(raw.default_project_id, "default project"),
    updated_at: timestamp(raw.updated_at, "settings timestamp"),
  };
}

export function parseVeraModelSettingsCapabilities(
  value: unknown,
): VeraModelSettingsCapabilities {
  assertNoVeraModelSecretFields(value, "model settings capabilities");
  const raw = record(value, "model settings capabilities");
  exactKeys(
    raw,
    [
      "schema_version",
      "settings_available",
      "local_only",
      "loopback_http_allowed",
      "supported_providers",
      "credential_write_enabled",
      "secret_readback_supported",
      "runtime_wired",
    ],
    "model settings capabilities",
  );
  if (raw.schema_version !== "vera-workspace-model-settings-v1") {
    invalidWire("model settings capabilities");
  }
  if (!Array.isArray(raw.supported_providers)) {
    invalidWire("supported providers");
  }
  const supported = raw.supported_providers.map((item) =>
    provider(item, "supported provider"),
  );
  if (new Set(supported).size !== supported.length) {
    invalidWire("supported providers");
  }
  return {
    schema_version: "vera-workspace-model-settings-v1",
    settings_available: booleanValue(
      raw.settings_available,
      "settings availability",
    ),
    local_only: literalBoolean(raw.local_only, true, "local-only capability"),
    loopback_http_allowed: booleanValue(
      raw.loopback_http_allowed,
      "loopback capability",
    ),
    supported_providers: supported,
    credential_write_enabled: booleanValue(
      raw.credential_write_enabled,
      "credential write capability",
    ),
    secret_readback_supported: literalBoolean(
      raw.secret_readback_supported,
      false,
      "secret readback capability",
    ),
    runtime_wired: booleanValue(raw.runtime_wired, "runtime capability"),
  };
}

export function parseVeraModelProfile(value: unknown): VeraModelProfile {
  assertNoVeraModelSecretFields(value, "model profile response");
  const raw = record(value, "model profile response");
  exactKeys(
    raw,
    [
      "id",
      "name",
      "provider",
      "model",
      "base_url",
      "context_window_tokens",
      "max_output_tokens",
      "enabled",
      "is_default",
      "created_at",
      "updated_at",
      "capabilities",
      "credential",
      "endpoint_binding",
      "availability",
      "connection_test",
      "requires_credential",
    ],
    "model profile response",
  );

  const modelCapabilities = record(raw.capabilities, "model capabilities");
  exactKeys(
    modelCapabilities,
    ["streaming", "toolCalling", "structuredOutput", "vision"],
    "model capabilities",
  );
  const credential = record(raw.credential, "credential status");
  exactKeys(
    credential,
    ["status", "configured", "canonical_origin"],
    "credential status",
  );
  const credentialStatus = enumValue(
    credential.status,
    ["configured", "missing", "invalid"] as const,
    "credential status",
  );
  const configured = booleanValue(
    credential.configured,
    "credential configured status",
  );
  if (configured !== (credentialStatus === "configured")) {
    invalidWire("credential status");
  }

  const endpoint = record(raw.endpoint_binding, "endpoint binding");
  exactKeys(
    endpoint,
    [
      "provider",
      "model",
      "normalized_base_url",
      "canonical_origin",
      "execution_revision",
      "connection_revision",
      "profile_updated_at",
    ],
    "endpoint binding",
  );
  const availability = record(raw.availability, "model availability");
  exactKeys(availability, ["status", "selectable"], "model availability");
  const connectionTest = parseConnectionTest(raw.connection_test);

  const parsedProvider = provider(raw.provider, "model provider");
  const endpointProvider = provider(endpoint.provider, "endpoint provider");
  const model = stringValue(raw.model, "model identifier", {
    min: 1,
    max: 200,
  });
  const endpointModel = stringValue(endpoint.model, "endpoint model", {
    min: 1,
    max: 200,
  });
  if (parsedProvider !== endpointProvider || model !== endpointModel) {
    invalidWire("endpoint binding");
  }

  const id = uuid(raw.id, "model profile id");
  const name = stringValue(raw.name, "model profile name", {
    min: 1,
    max: 120,
  });
  const baseUrl = safeEndpoint(raw.base_url, "model base URL");
  const contextWindowTokens = positiveNullableInteger(
    raw.context_window_tokens,
    "context window",
  );
  const maxOutputTokens = positiveNullableInteger(
    raw.max_output_tokens,
    "maximum output tokens",
  );
  if (
    (contextWindowTokens !== null &&
      contextWindowTokens > MAX_MODEL_TOKEN_LIMIT) ||
    (maxOutputTokens !== null && maxOutputTokens > MAX_MODEL_TOKEN_LIMIT)
  ) {
    invalidWire("model token limits");
  }
  const enabled = booleanValue(raw.enabled, "model enabled status");
  const isDefault = booleanValue(raw.is_default, "default model status");
  const createdAt = timestamp(raw.created_at, "model created timestamp");
  const updatedAt = timestamp(raw.updated_at, "model updated timestamp");
  const credentialOrigin = canonicalOrigin(
    credential.canonical_origin,
    "credential origin",
  );
  const normalizedBaseUrl = safeEndpoint(
    endpoint.normalized_base_url,
    "normalized base URL",
  );
  const endpointOrigin = canonicalOrigin(
    endpoint.canonical_origin,
    "canonical origin",
  );
  const executionRevision = nonNegativeInteger(
    endpoint.execution_revision,
    "execution revision",
  );
  const connectionRevision = nonNegativeInteger(
    endpoint.connection_revision,
    "connection revision",
  );
  if (connectionRevision > MAX_MODEL_CONNECTION_REVISION) {
    invalidWire("connection revision");
  }
  const profileUpdatedAt = timestamp(
    endpoint.profile_updated_at,
    "profile binding timestamp",
  );
  const availabilityStatus = enumValue(
    availability.status,
    [
      "ready",
      "disabled",
      "missing_credential",
      "invalid_credential",
      "credential_unavailable",
      "origin_unbound",
      "runtime_unwired",
    ] as const,
    "model availability",
  );
  const selectable = booleanValue(
    availability.selectable,
    "model selectability",
  );

  if (
    credentialOrigin !== endpointOrigin ||
    (configured && credentialOrigin === null) ||
    (normalizedBaseUrl === null) !== (endpointOrigin === null) ||
    profileUpdatedAt !== updatedAt ||
    (baseUrl !== null && baseUrl !== normalizedBaseUrl) ||
    (normalizedBaseUrl !== null &&
      new URL(normalizedBaseUrl).origin !== endpointOrigin) ||
    selectable !== (availabilityStatus === "ready") ||
    (!enabled && availabilityStatus !== "disabled") ||
    (enabled && availabilityStatus === "disabled") ||
    (enabled && connectionTest.status !== "passed") ||
    (isDefault && (!enabled || connectionTest.status !== "passed"))
  ) {
    invalidWire("model profile consistency");
  }

  return {
    id,
    name,
    provider: parsedProvider,
    model,
    base_url: baseUrl,
    context_window_tokens: contextWindowTokens,
    max_output_tokens: maxOutputTokens,
    enabled,
    is_default: isDefault,
    created_at: createdAt,
    updated_at: updatedAt,
    capabilities: {
      streaming: booleanValue(
        modelCapabilities.streaming,
        "streaming capability",
      ),
      toolCalling: booleanValue(
        modelCapabilities.toolCalling,
        "tool calling capability",
      ),
      structuredOutput: booleanValue(
        modelCapabilities.structuredOutput,
        "structured output capability",
      ),
      vision: booleanValue(modelCapabilities.vision, "vision capability"),
    },
    credential: {
      status: credentialStatus,
      configured,
      canonical_origin: credentialOrigin,
    },
    endpoint_binding: {
      provider: endpointProvider,
      model: endpointModel,
      normalized_base_url: normalizedBaseUrl,
      canonical_origin: endpointOrigin,
      execution_revision: executionRevision,
      connection_revision: connectionRevision,
      profile_updated_at: profileUpdatedAt,
    },
    availability: {
      status: availabilityStatus,
      selectable,
    },
    connection_test: connectionTest,
    requires_credential: literalBoolean(
      raw.requires_credential,
      true,
      "credential requirement",
    ),
  };
}

export function parseVeraModelProfiles(value: unknown): VeraModelProfile[] {
  assertNoVeraModelSecretFields(value, "model profile list");
  if (!Array.isArray(value)) return invalidWire("model profile list");
  const profiles = value.map(parseVeraModelProfile);
  if (new Set(profiles.map((profile) => profile.id)).size !== profiles.length) {
    invalidWire("model profile list");
  }
  return profiles;
}

export function parseVeraModelSettingsStatus(
  value: unknown,
): VeraModelSettingsStatus {
  assertNoVeraModelSecretFields(value, "model settings status");
  const raw = record(value, "model settings status");
  exactKeys(
    raw,
    ["capabilities", "settings", "models"],
    "model settings status",
  );
  const capabilities = parseVeraModelSettingsCapabilities(raw.capabilities);
  const settings = parseVeraWorkspaceSettings(raw.settings);
  const models = parseVeraModelProfiles(raw.models);
  const defaults = models.filter((profile) => profile.is_default);
  if (
    defaults.length > 1 ||
    (settings.default_model_profile_id === null) !== (defaults.length === 0) ||
    (defaults[0]?.id ?? null) !== settings.default_model_profile_id
  ) {
    invalidWire("model settings default selection");
  }
  return {
    capabilities,
    settings,
    models,
  };
}

function invalidRequest(message: string): never {
  throw new VeraRuntimeConfigurationError(message);
}

function inputRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalidRequest(`The Vera ${label} is invalid.`);
  }
  return value as Record<string, unknown>;
}

function assertInputKeys(
  raw: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedKeys = new Set(allowed);
  if (
    Object.keys(raw).length === 0 ||
    Object.keys(raw).some((key) => !allowedKeys.has(key))
  ) {
    invalidRequest(`The Vera ${label} is invalid.`);
  }
}

function inputTrimmedString(
  value: unknown,
  maximum: number,
  label: string,
): string {
  if (typeof value !== "string")
    return invalidRequest(`The Vera ${label} is invalid.`);
  const parsed = value.trim();
  if (parsed.length === 0 || parsed.length > maximum) {
    return invalidRequest(`The Vera ${label} is invalid.`);
  }
  return parsed;
}

function inputNullablePositiveInteger(
  value: unknown,
  label: string,
): number | null {
  if (value === null) return null;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > MAX_MODEL_TOKEN_LIMIT
  ) {
    return invalidRequest(`The Vera ${label} is invalid.`);
  }
  return value;
}

function inputBaseUrl(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 500) {
    return invalidRequest("The Vera model base URL is invalid.");
  }
  const normalized = value.trim();
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    return invalidRequest("The Vera model base URL is invalid.");
  }
  const loopback = isLoopbackHostname(url.hostname);
  if (
    normalized.length === 0 ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
  ) {
    return invalidRequest("The Vera model base URL is invalid.");
  }
  return normalized;
}

function inputModelCapabilities(value: unknown): VeraModelCapabilities {
  const raw = inputRecord(value, "model capabilities");
  const keys = [
    "streaming",
    "toolCalling",
    "structuredOutput",
    "vision",
  ] as const;
  if (
    Object.keys(raw).length !== keys.length ||
    keys.some(
      (key) => !Object.hasOwn(raw, key) || typeof raw[key] !== "boolean",
    )
  ) {
    return invalidRequest("The Vera model capabilities are invalid.");
  }
  return {
    streaming: raw.streaming as boolean,
    toolCalling: raw.toolCalling as boolean,
    structuredOutput: raw.structuredOutput as boolean,
    vision: raw.vision as boolean,
  };
}

function validatedSettingsPatch(
  value: VeraWorkspaceSettingsPatch,
): VeraWorkspaceSettingsPatch {
  const raw = inputRecord(value, "settings update");
  assertInputKeys(
    raw,
    ["locale", "theme", "default_model_profile_id"],
    "settings update",
  );
  const patch: VeraWorkspaceSettingsPatch = {};
  if (Object.hasOwn(raw, "locale")) {
    if (raw.locale !== "zh-CN" && raw.locale !== "en-US") {
      return invalidRequest("The Vera settings locale is invalid.");
    }
    patch.locale = raw.locale;
  }
  if (Object.hasOwn(raw, "theme")) {
    if (
      raw.theme !== "system" &&
      raw.theme !== "light" &&
      raw.theme !== "dark"
    ) {
      return invalidRequest("The Vera settings theme is invalid.");
    }
    patch.theme = raw.theme;
  }
  if (Object.hasOwn(raw, "default_model_profile_id")) {
    if (
      raw.default_model_profile_id !== null &&
      (typeof raw.default_model_profile_id !== "string" ||
        !UUID_PATTERN.test(raw.default_model_profile_id))
    ) {
      return invalidRequest("The Vera default model profile is invalid.");
    }
    patch.default_model_profile_id = raw.default_model_profile_id;
  }
  return patch;
}

function validatedModelMutation(
  value: VeraModelProfileMutation,
  requireIdentity: boolean,
): VeraModelProfileMutation {
  const raw = inputRecord(value, "model profile request");
  const allowed = [
    "name",
    "provider",
    "model",
    "base_url",
    "context_window_tokens",
    "max_output_tokens",
    "capabilities",
  ] as const;
  assertInputKeys(raw, allowed, "model profile request");
  if (
    requireIdentity &&
    (!Object.hasOwn(raw, "name") ||
      !Object.hasOwn(raw, "provider") ||
      !Object.hasOwn(raw, "model"))
  ) {
    return invalidRequest("The Vera model profile request is incomplete.");
  }

  const mutation: VeraModelProfileMutation = {};
  if (Object.hasOwn(raw, "name")) {
    mutation.name = inputTrimmedString(raw.name, 120, "model profile name");
  }
  if (Object.hasOwn(raw, "provider")) {
    if (typeof raw.provider !== "string" || !PROVIDERS.has(raw.provider)) {
      return invalidRequest("The Vera model provider is invalid.");
    }
    mutation.provider = raw.provider as VeraModelProvider;
  }
  if (Object.hasOwn(raw, "model")) {
    mutation.model = inputTrimmedString(raw.model, 200, "model identifier");
  }
  if (Object.hasOwn(raw, "base_url")) {
    mutation.base_url = inputBaseUrl(raw.base_url);
  }
  if (Object.hasOwn(raw, "context_window_tokens")) {
    mutation.context_window_tokens = inputNullablePositiveInteger(
      raw.context_window_tokens,
      "context window",
    );
  }
  if (Object.hasOwn(raw, "max_output_tokens")) {
    mutation.max_output_tokens = inputNullablePositiveInteger(
      raw.max_output_tokens,
      "maximum output tokens",
    );
  }
  if (Object.hasOwn(raw, "capabilities")) {
    mutation.capabilities = inputModelCapabilities(raw.capabilities);
  }
  return mutation;
}

function modelPath(id: string, suffix = ""): string {
  if (!UUID_PATTERN.test(id)) {
    throw new VeraRuntimeConfigurationError(
      "The Vera model profile id is invalid.",
    );
  }
  return `/model-profiles/${id}${suffix}`;
}

function requestOptions(
  options?: Pick<VeraApiRequestOptions, "signal">,
): Pick<VeraApiRequestOptions, "signal"> {
  return options?.signal ? { signal: options.signal } : {};
}

export async function getVeraModelSettingsStatus(
  options?: Pick<VeraApiRequestOptions, "signal">,
): Promise<VeraModelSettingsStatus> {
  const raw = await veraApiRequest<unknown>("/settings/status", {
    ...requestOptions(options),
  });
  return parseVeraModelSettingsStatus(raw);
}

export async function getVeraWorkspaceSettings(
  options?: Pick<VeraApiRequestOptions, "signal">,
): Promise<VeraWorkspaceSettings> {
  const raw = await veraApiRequest<unknown>("/settings", {
    ...requestOptions(options),
  });
  return parseVeraWorkspaceSettings(raw);
}

export async function patchVeraWorkspaceSettings(
  patch: VeraWorkspaceSettingsPatch,
): Promise<VeraWorkspaceSettings> {
  const validated = validatedSettingsPatch(patch);
  const raw = await veraApiRequest<unknown>("/settings", {
    method: "PATCH",
    json: validated,
  });
  return parseVeraWorkspaceSettings(raw);
}

export async function listVeraModelProfiles(
  options?: Pick<VeraApiRequestOptions, "signal">,
): Promise<VeraModelProfile[]> {
  const raw = await veraApiRequest<unknown>("/model-profiles", {
    ...requestOptions(options),
  });
  return parseVeraModelProfiles(raw);
}

export async function createVeraModelProfile(
  input: VeraModelProfileMutation,
): Promise<VeraModelProfile> {
  const validated = validatedModelMutation(input, true);
  const raw = await veraApiRequest<unknown>("/model-profiles", {
    method: "POST",
    json: validated,
  });
  return parseVeraModelProfile(raw);
}

export async function updateVeraModelProfile(
  id: string,
  input: VeraModelProfileMutation,
): Promise<VeraModelProfile> {
  const validated = validatedModelMutation(input, false);
  const raw = await veraApiRequest<unknown>(modelPath(id), {
    method: "PATCH",
    json: validated,
  });
  return parseVeraModelProfile(raw);
}

export async function deleteVeraModelProfile(id: string): Promise<void> {
  await veraApiRequest<void>(modelPath(id), { method: "DELETE" });
}

export async function putVeraModelCredential(
  id: string,
  secret: string,
): Promise<VeraModelProfile> {
  if (
    typeof secret !== "string" ||
    secret.length === 0 ||
    /[\r\n]/.test(secret) ||
    new TextEncoder().encode(secret).byteLength >
      VERA_MODEL_CREDENTIAL_MAX_UTF8_BYTES
  ) {
    throw new VeraRuntimeConfigurationError(
      "The Vera model credential is invalid.",
    );
  }
  const raw = await veraApiRequest<unknown>(modelPath(id, "/credential"), {
    method: "PUT",
    json: { secret },
  });
  return parseVeraModelProfile(raw);
}

export async function deleteVeraModelCredential(
  id: string,
): Promise<VeraModelProfile> {
  const raw = await veraApiRequest<unknown>(modelPath(id, "/credential"), {
    method: "DELETE",
  });
  return parseVeraModelProfile(raw);
}

async function modelAction(
  id: string,
  action: "test" | "enable" | "disable" | "default",
): Promise<VeraModelProfile> {
  const raw = await veraApiRequest<unknown>(modelPath(id, `/${action}`), {
    method: "POST",
    json: {},
  });
  return parseVeraModelProfile(raw);
}

export function testVeraModelProfile(id: string): Promise<VeraModelProfile> {
  return modelAction(id, "test");
}

export function enableVeraModelProfile(id: string): Promise<VeraModelProfile> {
  return modelAction(id, "enable");
}

export function disableVeraModelProfile(id: string): Promise<VeraModelProfile> {
  return modelAction(id, "disable");
}

export function setDefaultVeraModelProfile(
  id: string,
): Promise<VeraModelProfile> {
  return modelAction(id, "default");
}
