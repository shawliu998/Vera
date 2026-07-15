import { createHash } from "node:crypto";

const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1_000_000;
const MAX_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 5_000_000;
const MAX_QUERY_LENGTH = 4_000;

export type LegalSourceProvider =
  | "pkulaw"
  | "yuandian"
  | "wolters"
  | "official";
export type LegalSourceType = LegalSourceProvider | "manual_import";

export type LegalSourceSnapshot = {
  url: string;
  fetchedAt: string;
  contentHash: string;
  sourceType: LegalSourceType;
  version?: string;
  effectiveDate?: string;
  effectiveTo?: string;
  publicationDate?: string;
  documentKind?: "statute" | "judicial_interpretation" | "case" | "other";
  caseNumber?: string;
  caseNumberFormatValid?: boolean;
  caseVerificationStatus?: "verified" | "unverified";
};

export type LegalSourceSearchRequest = {
  query: string;
};

export type LegalSourceFetchRequest = {
  documentId: string;
};

export type LegalSourceSearchResult = {
  documentId: string;
  title: string;
  summary?: string;
  snapshot: LegalSourceSnapshot;
};

export type LegalSourceDocument = {
  documentId: string;
  title: string;
  content: string;
  snapshot: LegalSourceSnapshot;
};

export interface LegalSourceAdapter {
  readonly provider: LegalSourceProvider;
  search(request: LegalSourceSearchRequest): Promise<LegalSourceSearchResult[]>;
  fetch(request: LegalSourceFetchRequest): Promise<LegalSourceDocument>;
}

/**
 * This configuration intentionally contains a credential reference, never a
 * credential value. Resolve the reference from the deployment secret store.
 */
export type OfficialLegalSourceAdapterConfig = {
  endpoint: string;
  allowedHosts: readonly string[];
  credentialRef: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
};

export type OfficialPublicLegalSourceAdapterConfig = Omit<
  OfficialLegalSourceAdapterConfig,
  "credentialRef"
>;

export type LegalSourceAdapterDeps = {
  resolveCredential?: (credentialRef: string) => Promise<string | undefined>;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
};

export class LegalSourceAdapterError extends Error {
  constructor(
    message: string,
    readonly code:
      | "configuration_error"
      | "credential_unavailable"
      | "policy_violation"
      | "transport_error"
      | "response_invalid",
  ) {
    super(message);
    this.name = "LegalSourceAdapterError";
  }
}

type ValidatedConfig = {
  endpoint: URL;
  allowedHosts: string[];
  credentialRef?: string;
  timeoutMs: number;
  maxResponseBytes: number;
};

type ApiSearchItem = {
  id: string;
  title?: string;
  summary?: string;
  content?: string;
  url: string;
  version?: string;
  effectiveDate?: string;
  effectiveTo?: string;
  publicationDate?: string;
  documentKind?: "statute" | "judicial_interpretation" | "case" | "other";
  caseNumber?: string;
  caseVerificationStatus?: "verified" | "unverified";
};

type ApiDocument = {
  id: string;
  title?: string;
  content: string;
  url: string;
  version?: string;
  effectiveDate?: string;
  effectiveTo?: string;
  publicationDate?: string;
  documentKind?: "statute" | "judicial_interpretation" | "case" | "other";
  caseNumber?: string;
  caseVerificationStatus?: "verified" | "unverified";
};

function sha256(value: string) {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireExactKeys(value: unknown, keys: readonly string[], label: string) {
  if (!isPlainObject(value)) {
    throw new LegalSourceAdapterError(`${label} must be an object.`, "policy_violation");
  }
  const received = Object.keys(value);
  if (received.length !== keys.length || received.some((key) => !keys.includes(key))) {
    throw new LegalSourceAdapterError(
      `${label} accepts only ${keys.join(", ")}. Matter, facts, and other context fields are not accepted.`,
      "policy_violation",
    );
  }
}

function requireNonEmptyString(value: unknown, label: string, maxLength = 2_000_000) {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new LegalSourceAdapterError(`${label} is invalid.`, "response_invalid");
  }
  return value;
}

function normalizeAllowedHosts(hosts: readonly string[]) {
  const normalized = [...new Set(hosts.map((host) => host.trim().toLowerCase()))];
  if (
    normalized.length === 0 ||
    normalized.some(
      (host) => !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host),
    )
  ) {
    throw new LegalSourceAdapterError(
      "Official legal-source configuration requires one or more valid allowlisted hosts.",
      "configuration_error",
    );
  }
  return normalized;
}

function hostIsAllowed(hostname: string, allowedHosts: readonly string[]) {
  const normalizedHost = hostname.toLowerCase();
  return allowedHosts.some(
    (allowedHost) =>
      normalizedHost === allowedHost || normalizedHost.endsWith(`.${allowedHost}`),
  );
}

function validateOfficialUrl(value: string | URL, allowedHosts: readonly string[], label: string) {
  let url: URL;
  try {
    url = typeof value === "string" ? new URL(value) : value;
  } catch {
    throw new LegalSourceAdapterError(`${label} must be a valid HTTPS URL.`, "configuration_error");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !hostIsAllowed(url.hostname, allowedHosts)
  ) {
    throw new LegalSourceAdapterError(
      `${label} must use an allowlisted HTTPS host without credentials or a custom port.`,
      "policy_violation",
    );
  }
  return url;
}

function validateConfig(
  config: OfficialPublicLegalSourceAdapterConfig | OfficialLegalSourceAdapterConfig,
  requireCredential: boolean,
): ValidatedConfig {
  if (!isPlainObject(config)) {
    throw new LegalSourceAdapterError("Official legal-source configuration is required.", "configuration_error");
  }
  const allowedHosts = normalizeAllowedHosts(config.allowedHosts);
  const credentialRef = "credentialRef" in config ? config.credentialRef : undefined;
  if (requireCredential && (
    typeof credentialRef !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(credentialRef)
  )) {
    throw new LegalSourceAdapterError(
      "Official legal-source configuration requires a credential reference, not a credential value.",
      "configuration_error",
    );
  }
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new LegalSourceAdapterError("Official legal-source timeout is invalid.", "configuration_error");
  }
  if (
    !Number.isInteger(maxResponseBytes) ||
    maxResponseBytes < 1 ||
    maxResponseBytes > MAX_RESPONSE_BYTES
  ) {
    throw new LegalSourceAdapterError("Official legal-source byte limit is invalid.", "configuration_error");
  }
  return {
    endpoint: validateOfficialUrl(config.endpoint, allowedHosts, "Official legal-source endpoint"),
    allowedHosts,
    ...(typeof credentialRef === "string" ? { credentialRef } : {}),
    timeoutMs,
    maxResponseBytes,
  };
}

function validateSearchRequest(request: LegalSourceSearchRequest) {
  requireExactKeys(request, ["query"], "Legal-source search request");
  const query = requireNonEmptyString(request.query, "Legal-source query", MAX_QUERY_LENGTH);
  return query.trim();
}

function validateFetchRequest(request: LegalSourceFetchRequest) {
  requireExactKeys(request, ["documentId"], "Legal-source fetch request");
  return requireNonEmptyString(request.documentId, "Legal-source document ID", 512).trim();
}

function parseOptionalString(value: unknown, label: string) {
  if (value === undefined) return undefined;
  return requireNonEmptyString(value, label, 20_000);
}

function parseEffectiveDate(value: unknown) {
  const effectiveDate = parseOptionalString(value, "Provider effective date");
  if (effectiveDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)) {
    throw new LegalSourceAdapterError("Provider effective date is invalid.", "response_invalid");
  }
  return effectiveDate;
}

function parseDate(value: unknown, label: string) {
  const date = parseOptionalString(value, label);
  if (date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new LegalSourceAdapterError(`${label} is invalid.`, "response_invalid");
  }
  return date;
}

function plausibleChineseCaseNumber(value: string) {
  return /^[（(]\d{4}[）)][^\s]{1,80}号$/u.test(value);
}

function parseDocumentKind(value: unknown) {
  if (value === undefined) return undefined;
  if (value === "statute" || value === "judicial_interpretation" || value === "case" || value === "other") {
    return value;
  }
  throw new LegalSourceAdapterError("Provider document kind is invalid.", "response_invalid");
}

function parseCaseVerificationStatus(value: unknown) {
  if (value === undefined) return undefined;
  if (value === "verified" || value === "unverified") return value;
  throw new LegalSourceAdapterError("Provider case verification status is invalid.", "response_invalid");
}

function parseSearchItem(value: unknown, allowedHosts: readonly string[]): ApiSearchItem {
  if (!isPlainObject(value)) {
    throw new LegalSourceAdapterError("Provider search result is invalid.", "response_invalid");
  }
  const id = requireNonEmptyString(value.id, "Provider document ID", 512);
  const title = parseOptionalString(value.title, "Provider title");
  const summary = parseOptionalString(value.summary, "Provider summary");
  const content = parseOptionalString(value.content, "Provider content");
  const url = validateOfficialUrl(
    requireNonEmptyString(value.url, "Provider source URL", 4_000),
    allowedHosts,
    "Provider source URL",
  ).toString();
  const effectiveDate = parseEffectiveDate(value.effectiveDate);
  const effectiveTo = parseDate(value.effectiveTo, "Provider effective-to date");
  if (effectiveDate && effectiveTo && effectiveTo < effectiveDate) {
    throw new LegalSourceAdapterError("Provider effective date interval is invalid.", "response_invalid");
  }
  const documentKind = parseDocumentKind(value.documentKind);
  const caseNumber = parseOptionalString(value.caseNumber, "Provider case number");
  const caseVerificationStatus = parseCaseVerificationStatus(value.caseVerificationStatus);
  if (caseVerificationStatus && !caseNumber) {
    throw new LegalSourceAdapterError("Provider case verification requires a case number.", "response_invalid");
  }
  return {
    id,
    title,
    summary,
    content,
    url,
    version: parseOptionalString(value.version, "Provider version"),
    effectiveDate,
    effectiveTo,
    publicationDate: parseDate(value.publicationDate, "Provider publication date"),
    documentKind,
    caseNumber,
    caseVerificationStatus,
  };
}

function parseDocument(value: unknown, allowedHosts: readonly string[]): ApiDocument {
  const item = parseSearchItem(value, allowedHosts);
  if (item.content === undefined) {
    throw new LegalSourceAdapterError("Provider document content is missing.", "response_invalid");
  }
  return { ...item, content: item.content };
}

function snapshot(
  sourceType: LegalSourceType,
  item: Pick<ApiSearchItem, "url" | "content" | "id" | "title" | "summary" | "version" | "effectiveDate" | "effectiveTo" | "publicationDate" | "documentKind" | "caseNumber" | "caseVerificationStatus">,
  fetchedAt: string,
): LegalSourceSnapshot {
  const hashedContent = item.content ?? JSON.stringify({
    id: item.id,
    title: item.title ?? "",
    summary: item.summary ?? "",
    url: item.url,
    version: item.version ?? "",
    effectiveDate: item.effectiveDate ?? "",
  });
  return {
    url: item.url,
    fetchedAt,
    contentHash: sha256(hashedContent),
    sourceType,
    ...(item.version === undefined ? {} : { version: item.version }),
    ...(item.effectiveDate === undefined ? {} : { effectiveDate: item.effectiveDate }),
    ...(item.effectiveTo === undefined ? {} : { effectiveTo: item.effectiveTo }),
    ...(item.publicationDate === undefined ? {} : { publicationDate: item.publicationDate }),
    ...(item.documentKind === undefined ? {} : { documentKind: item.documentKind }),
    ...(item.caseNumber === undefined ? {} : {
      caseNumber: item.caseNumber,
      caseNumberFormatValid: plausibleChineseCaseNumber(item.caseNumber),
      caseVerificationStatus: item.caseVerificationStatus ?? "unverified",
    }),
  };
}

async function readLimitedBody(response: Response, maxBytes: number) {
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new LegalSourceAdapterError("Provider response exceeds the configured byte limit.", "response_invalid");
  }
  if (!response.body) {
    throw new LegalSourceAdapterError("Provider response body is missing.", "response_invalid");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      received += next.value.byteLength;
      if (received > maxBytes) {
        await reader.cancel();
        throw new LegalSourceAdapterError("Provider response exceeds the configured byte limit.", "response_invalid");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

async function requestOfficialApi(
  config: ValidatedConfig,
  body: Record<string, string>,
  deps: LegalSourceAdapterDeps,
) {
  const credential = config.credentialRef
    ? await (deps.resolveCredential ?? (async () => undefined))(config.credentialRef)
    : undefined;
  if (config.credentialRef && (typeof credential !== "string" || credential.length === 0)) {
    throw new LegalSourceAdapterError("Official legal-source credential is unavailable.", "credential_unavailable");
  }
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new LegalSourceAdapterError("Official legal-source transport is unavailable.", "configuration_error");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  const timeoutFailure = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener(
      "abort",
      () => reject(new LegalSourceAdapterError("Official legal-source request timed out.", "transport_error")),
      { once: true },
    );
  });
  try {
    const response = await Promise.race([
      fetchImpl(config.endpoint, {
        method: "POST",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          accept: "application/json",
          ...(credential ? { authorization: `Bearer ${credential}` } : {}),
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      }),
      timeoutFailure,
    ]);
    if (response.redirected || response.status >= 300 && response.status < 400) {
      throw new LegalSourceAdapterError("Official legal-source redirects are not permitted.", "policy_violation");
    }
    if (!response.ok) {
      throw new LegalSourceAdapterError("Official legal-source API returned an unsuccessful response.", "transport_error");
    }
    const responseUrl = response.url || config.endpoint.toString();
    const validatedResponseUrl = validateOfficialUrl(
      responseUrl,
      config.allowedHosts,
      "Official legal-source response URL",
    );
    if (validatedResponseUrl.toString() !== config.endpoint.toString()) {
      throw new LegalSourceAdapterError("Official legal-source redirects are not permitted.", "policy_violation");
    }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
    if (contentType !== "application/json") {
      throw new LegalSourceAdapterError("Official legal-source response must be JSON.", "response_invalid");
    }
    const raw = await Promise.race([
      readLimitedBody(response, config.maxResponseBytes),
      timeoutFailure,
    ]);
    try {
      return JSON.parse(raw.toString("utf8")) as unknown;
    } catch {
      throw new LegalSourceAdapterError("Official legal-source response is invalid JSON.", "response_invalid");
    }
  } catch (error) {
    if (error instanceof LegalSourceAdapterError) throw error;
    throw new LegalSourceAdapterError("Official legal-source request failed.", "transport_error");
  } finally {
    clearTimeout(timeout);
  }
}

function parseSearchResponse(value: unknown, allowedHosts: readonly string[]) {
  if (!isPlainObject(value) || !Array.isArray(value.results) || value.results.length > 1_000) {
    throw new LegalSourceAdapterError("Official legal-source search response is invalid.", "response_invalid");
  }
  return value.results.map((item) => parseSearchItem(item, allowedHosts));
}

function parseFetchResponse(value: unknown, allowedHosts: readonly string[]) {
  if (!isPlainObject(value) || !Object.hasOwn(value, "document")) {
    throw new LegalSourceAdapterError("Official legal-source fetch response is invalid.", "response_invalid");
  }
  return parseDocument(value.document, allowedHosts);
}

function createOfficialAdapter(
  provider: LegalSourceProvider,
  config: OfficialPublicLegalSourceAdapterConfig | OfficialLegalSourceAdapterConfig,
  deps: LegalSourceAdapterDeps = {},
  requireCredential = true,
): LegalSourceAdapter {
  const validatedConfig = validateConfig(config, requireCredential);
  const now = deps.now ?? (() => new Date());
  return {
    provider,
    async search(request) {
      const query = validateSearchRequest(request);
      const response = await requestOfficialApi(validatedConfig, { operation: "search", query }, deps);
      const fetchedAt = now().toISOString();
      return parseSearchResponse(response, validatedConfig.allowedHosts).map((item) => ({
        documentId: item.id,
        title: item.title ?? item.id,
        ...(item.summary === undefined ? {} : { summary: item.summary }),
        snapshot: snapshot(provider, item, fetchedAt),
      }));
    },
    async fetch(request) {
      const documentId = validateFetchRequest(request);
      const response = await requestOfficialApi(validatedConfig, { operation: "fetch", documentId }, deps);
      const item = parseFetchResponse(response, validatedConfig.allowedHosts);
      if (item.id !== documentId) {
        throw new LegalSourceAdapterError(
          "Provider document ID does not match the requested source.",
          "response_invalid",
        );
      }
      return {
        documentId: item.id,
        title: item.title ?? item.id,
        content: item.content,
        snapshot: snapshot(provider, item, now().toISOString()),
      };
    },
  };
}

export function createPkulawLegalSourceAdapter(
  config: OfficialLegalSourceAdapterConfig,
  deps: LegalSourceAdapterDeps = {},
) {
  return createOfficialAdapter("pkulaw", config, deps);
}

export function createWoltersLegalSourceAdapter(
  config: OfficialLegalSourceAdapterConfig,
  deps: LegalSourceAdapterDeps = {},
) {
  return createOfficialAdapter("wolters", config, deps);
}

export function createOfficialPublicLegalSourceAdapter(
  config: OfficialPublicLegalSourceAdapterConfig,
  deps: LegalSourceAdapterDeps = {},
) {
  return createOfficialAdapter("official", config, deps, false);
}

export function createManualLegalSourceImport(input: {
  documentId: string;
  title: string;
  content: string;
  version?: string;
  effectiveDate?: string;
  importedAt?: string;
}): LegalSourceDocument {
  requireExactKeys(input, ["documentId", "title", "content", "version", "effectiveDate", "importedAt"].filter(
    (key) => input[key as keyof typeof input] !== undefined,
  ), "Manual legal-source import");
  const documentId = requireNonEmptyString(input.documentId, "Manual import document ID", 512).trim();
  const title = requireNonEmptyString(input.title, "Manual import title", 20_000).trim();
  const content = requireNonEmptyString(input.content, "Manual import content");
  const version = parseOptionalString(input.version, "Manual import version");
  const effectiveDate = parseEffectiveDate(input.effectiveDate);
  const importedAt = input.importedAt ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(importedAt))) {
    throw new LegalSourceAdapterError("Manual import timestamp is invalid.", "response_invalid");
  }
  const url = `manual-import://${encodeURIComponent(documentId)}`;
  return {
    documentId,
    title,
    content,
    snapshot: {
      url,
      fetchedAt: importedAt,
      contentHash: sha256(content),
      sourceType: "manual_import",
      ...(version === undefined ? {} : { version }),
      ...(effectiveDate === undefined ? {} : { effectiveDate }),
    },
  };
}

function environmentConfig(provider: "PKULAW" | "WOLTERS"): OfficialLegalSourceAdapterConfig {
  const endpoint = process.env[`VERA_${provider}_API_ENDPOINT`];
  const credentialRef = process.env[`VERA_${provider}_API_CREDENTIAL_REF`];
  const allowedHosts = process.env[`VERA_${provider}_API_ALLOWED_HOSTS`]
    ?.split(",")
    .map((host) => host.trim())
    .filter(Boolean);
  if (!endpoint || !credentialRef || !allowedHosts?.length) {
    throw new LegalSourceAdapterError(
      `Official ${provider.toLowerCase()} API configuration is incomplete.`,
      "configuration_error",
    );
  }
  return { endpoint, credentialRef, allowedHosts };
}

export type LegalSourceDeploymentStatus = {
  endpointConfigured: boolean;
  allowlisted: boolean;
  credentialReferenceConfigured: boolean;
};

/**
 * Project the deployment prerequisites without exposing an endpoint, host list,
 * credential reference, or credential value to the local client. A configured
 * credentialed source is still unusable until the local encrypted credential
 * is present; the credentialless official gateway still requires its endpoint
 * and allowlist.
 */
export function legalSourceDeploymentStatus(
  provider: LegalSourceProvider,
): LegalSourceDeploymentStatus {
  const environmentPrefix = provider === "official" ? "OFFICIAL_LEGAL" : provider.toUpperCase();
  const endpoint = process.env[`VERA_${environmentPrefix}_API_ENDPOINT`]?.trim();
  const credentialRef = process.env[
    `VERA_${environmentPrefix}_API_CREDENTIAL_REF`
  ]?.trim();
  const rawAllowedHosts = process.env[`VERA_${environmentPrefix}_API_ALLOWED_HOSTS`]
    ?.split(",")
    .map((host) => host.trim())
    .filter(Boolean);

  let allowlisted = false;
  if (endpoint && rawAllowedHosts?.length) {
    try {
      const allowedHosts = normalizeAllowedHosts(rawAllowedHosts);
      const validatedEndpoint = validateOfficialUrl(
        endpoint,
        allowedHosts,
        "Authorized legal-source endpoint",
      );
      allowlisted =
        provider !== "yuandian" ||
        (allowedHosts.length === 1 &&
          allowedHosts[0] === "open.chineselaw.com" &&
          validatedEndpoint.origin === "https://open.chineselaw.com" &&
          validatedEndpoint.pathname === "/" &&
          !validatedEndpoint.search &&
          !validatedEndpoint.hash);
    } catch {
      allowlisted = false;
    }
  }

  return {
    endpointConfigured: Boolean(endpoint),
    allowlisted,
    credentialReferenceConfigured: Boolean(
      credentialRef && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(credentialRef),
    ),
  };
}

export function createPkulawLegalSourceAdapterFromEnvironment(deps: LegalSourceAdapterDeps = {}) {
  return createPkulawLegalSourceAdapter(environmentConfig("PKULAW"), deps);
}

export function createWoltersLegalSourceAdapterFromEnvironment(deps: LegalSourceAdapterDeps = {}) {
  return createWoltersLegalSourceAdapter(environmentConfig("WOLTERS"), deps);
}

export function createOfficialPublicLegalSourceAdapterFromEnvironment(
  deps: LegalSourceAdapterDeps = {},
) {
  const endpoint = process.env.VERA_OFFICIAL_LEGAL_API_ENDPOINT;
  const allowedHosts = process.env.VERA_OFFICIAL_LEGAL_API_ALLOWED_HOSTS
    ?.split(",")
    .map((host) => host.trim())
    .filter(Boolean);
  if (!endpoint || !allowedHosts?.length) {
    throw new LegalSourceAdapterError(
      "Official public legal-source API configuration is incomplete.",
      "configuration_error",
    );
  }
  return createOfficialPublicLegalSourceAdapter({ endpoint, allowedHosts }, deps);
}
