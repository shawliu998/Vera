import { createHash } from "node:crypto";
import {
  LegalSourceAdapterError,
  type LegalSourceAdapter,
  type LegalSourceAdapterDeps,
  type LegalSourceDocument,
  type LegalSourceFetchRequest,
  type LegalSourceSearchRequest,
  type LegalSourceSearchResult,
  type LegalSourceSnapshot,
} from "./legalSourceAdapter";

const YUANDIAN_ORIGIN = "https://open.chineselaw.com";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2_000_000;
const MAX_RESPONSE_BYTES = 5_000_000;
const DEFAULT_RESULTS_PER_KIND = 10;
const MAX_RESULTS_PER_KIND = 45;
const MAX_QUERY_LENGTH = 4_000;
const MAX_PROVIDER_STRING_LENGTH = 2_000_000;

const OFFICIAL_DISPLAY_HOSTS = new Set([
  "open.chineselaw.com",
  "www.chineselaw.com",
  "ydzk.chineselaw.com",
]);

export const YUANDIAN_REST_ENDPOINTS = Object.freeze({
  lawSearch: `${YUANDIAN_ORIGIN}/open/law_vector_search`,
  caseSearch: `${YUANDIAN_ORIGIN}/open/case_vector_search`,
  articleDetail: `${YUANDIAN_ORIGIN}/open/rh_ft_detail`,
  regulationDetail: `${YUANDIAN_ORIGIN}/open/rh_fg_detail`,
  caseDetail: `${YUANDIAN_ORIGIN}/open/rh_case_details`,
});

/**
 * Metadata only. The deterministic adapter below uses REST and never connects
 * to an MCP endpoint.
 */
export const YUANDIAN_MCP_METADATA = Object.freeze({
  transport: "streamable-http" as const,
  authentication: "bearer-api-key" as const,
  samplingEnabled: false,
  documentationUrl: `${YUANDIAN_ORIGIN}/mcp-config/`,
  compatibilityUrl: `${YUANDIAN_ORIGIN}/mcp`,
  servers: Object.freeze({
    law: `${YUANDIAN_ORIGIN}/mcp/law/stream`,
    case: `${YUANDIAN_ORIGIN}/mcp/case/stream`,
    company: `${YUANDIAN_ORIGIN}/mcp/company/stream`,
  }),
});

export type YuanDianLegalSourceAdapterConfig = {
  /** Secret-store reference only. Never put the API key itself here. */
  credentialRef: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  resultsPerKind?: number;
};

export type YuanDianLegalRecordType = "law_article" | "law_regulation" | "case";

export type YuanDianLegalSourceSnapshot = LegalSourceSnapshot & {
  sourceType: "yuandian";
  provider: "yuandian";
  recordType: YuanDianLegalRecordType;
  providerRecordId: string;
  transportUrl: string;
  providerSourceUrl?: string;
  regulationId?: string;
  articleNumber?: string;
  validityStatus?: string;
  authorityLevel?: string;
  court?: string;
  judgmentDate?: string;
};

export type YuanDianLegalSourceSearchResult = Omit<
  LegalSourceSearchResult,
  "snapshot"
> & {
  snapshot: YuanDianLegalSourceSnapshot;
};

export type YuanDianLegalSourceDocument = Omit<
  LegalSourceDocument,
  "snapshot"
> & {
  snapshot: YuanDianLegalSourceSnapshot;
};

export interface YuanDianLegalSourceAdapter extends Omit<
  LegalSourceAdapter,
  "provider" | "search" | "fetch"
> {
  readonly provider: "yuandian";
  search(
    request: LegalSourceSearchRequest,
  ): Promise<YuanDianLegalSourceSearchResult[]>;
  fetch(request: LegalSourceFetchRequest): Promise<YuanDianLegalSourceDocument>;
}

type ValidatedConfig = {
  credentialRef: string;
  timeoutMs: number;
  maxResponseBytes: number;
  resultsPerKind: number;
};

type YuanDianDocumentId =
  | { kind: "article"; providerId: string }
  | { kind: "regulation"; providerId: string }
  | {
      kind: "case";
      providerId: string;
      caseType: "auto" | "ptal" | "qwal";
    };

type NormalizedRecord = {
  documentId: string;
  title: string;
  content: string;
  sourceUrl: string;
  transportUrl: string;
  recordType: YuanDianLegalRecordType;
  providerRecordId: string;
  summary?: string;
  regulationId?: string;
  articleNumber?: string;
  effectiveDate?: string;
  effectiveTo?: string;
  publicationDate?: string;
  validityStatus?: string;
  authorityLevel?: string;
  documentKind: "statute" | "judicial_interpretation" | "case";
  caseNumber?: string;
  caseVerificationStatus?: "verified" | "unverified";
  court?: string;
  judgmentDate?: string;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sha256(value: string) {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function adapterError(
  message: string,
  code: LegalSourceAdapterError["code"],
): never {
  throw new LegalSourceAdapterError(message, code);
}

function requireExactKeys(
  value: unknown,
  allowedKeys: readonly string[],
  label: string,
  code: LegalSourceAdapterError["code"],
) {
  if (!isPlainObject(value)) {
    adapterError(`${label} must be an object.`, code);
  }
  const received = Object.keys(value);
  if (received.some((key) => !allowedKeys.includes(key))) {
    adapterError(`${label} contains unsupported fields.`, code);
  }
}

function requireInputString(value: unknown, label: string, maxLength: number) {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    adapterError(`${label} is invalid.`, "policy_violation");
  }
  return value.trim();
}

function requireProviderString(
  value: unknown,
  label: string,
  maxLength = MAX_PROVIDER_STRING_LENGTH,
) {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    adapterError(`${label} is invalid.`, "response_invalid");
  }
  return value.trim();
}

function optionalProviderString(
  value: unknown,
  label: string,
  maxLength = MAX_PROVIDER_STRING_LENGTH,
) {
  if (value === undefined || value === null || value === "") return undefined;
  return requireProviderString(value, label, maxLength);
}

function validateConfig(
  config: YuanDianLegalSourceAdapterConfig,
): ValidatedConfig {
  requireExactKeys(
    config,
    ["credentialRef", "timeoutMs", "maxResponseBytes", "resultsPerKind"],
    "YuanDian configuration",
    "configuration_error",
  );
  const credentialRef = config.credentialRef;
  if (
    typeof credentialRef !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(credentialRef)
  ) {
    adapterError(
      "YuanDian configuration requires a credential reference, not an API-key value.",
      "configuration_error",
    );
  }
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_TIMEOUT_MS
  ) {
    adapterError("YuanDian timeout is invalid.", "configuration_error");
  }
  const maxResponseBytes =
    config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (
    !Number.isInteger(maxResponseBytes) ||
    maxResponseBytes < 1 ||
    maxResponseBytes > MAX_RESPONSE_BYTES
  ) {
    adapterError(
      "YuanDian response byte limit is invalid.",
      "configuration_error",
    );
  }
  const resultsPerKind = config.resultsPerKind ?? DEFAULT_RESULTS_PER_KIND;
  if (
    !Number.isInteger(resultsPerKind) ||
    resultsPerKind < 1 ||
    resultsPerKind > MAX_RESULTS_PER_KIND
  ) {
    adapterError("YuanDian result limit is invalid.", "configuration_error");
  }
  return { credentialRef, timeoutMs, maxResponseBytes, resultsPerKind };
}

function validateSearchRequest(request: LegalSourceSearchRequest) {
  requireExactKeys(
    request,
    ["query"],
    "YuanDian search request",
    "policy_violation",
  );
  return requireInputString(
    request.query,
    "YuanDian search query",
    MAX_QUERY_LENGTH,
  );
}

function validateFetchRequest(request: LegalSourceFetchRequest) {
  requireExactKeys(
    request,
    ["documentId"],
    "YuanDian fetch request",
    "policy_violation",
  );
  return requireInputString(request.documentId, "YuanDian document ID", 512);
}

function validateProviderId(
  value: string,
  code: LegalSourceAdapterError["code"] = "policy_violation",
) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/.test(value)) {
    adapterError("YuanDian provider record ID is invalid.", code);
  }
  return value;
}

function articleDocumentId(providerId: string) {
  return `yuandian:article:${validateProviderId(providerId)}`;
}

function regulationDocumentId(providerId: string) {
  return `yuandian:regulation:${validateProviderId(providerId)}`;
}

function caseDocumentId(
  providerId: string,
  caseType: "auto" | "ptal" | "qwal",
) {
  return `yuandian:case:${caseType}:${validateProviderId(providerId)}`;
}

function parseDocumentId(value: string): YuanDianDocumentId {
  const article = /^yuandian:article:([A-Za-z0-9][A-Za-z0-9_-]{0,255})$/.exec(
    value,
  );
  if (article) return { kind: "article", providerId: article[1] };

  const regulation =
    /^yuandian:regulation:([A-Za-z0-9][A-Za-z0-9_-]{0,255})$/.exec(value);
  if (regulation) {
    return { kind: "regulation", providerId: regulation[1] };
  }

  const legalCase =
    /^yuandian:case:(auto|ptal|qwal):([A-Za-z0-9][A-Za-z0-9_-]{0,255})$/.exec(
      value,
    );
  if (legalCase) {
    return {
      kind: "case",
      caseType: legalCase[1] as "auto" | "ptal" | "qwal",
      providerId: legalCase[2],
    };
  }
  adapterError(
    "YuanDian document ID must include a supported record type.",
    "policy_violation",
  );
}

function exactTransportUrl(value: string | URL) {
  let url: URL;
  try {
    url =
      typeof value === "string" ? new URL(value) : new URL(value.toString());
  } catch {
    adapterError("YuanDian transport URL is invalid.", "policy_violation");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "open.chineselaw.com" ||
    url.port ||
    url.username ||
    url.password ||
    url.origin !== YUANDIAN_ORIGIN
  ) {
    adapterError(
      "YuanDian requests require the exact open.chineselaw.com HTTPS host.",
      "policy_violation",
    );
  }
  return url;
}

/** Provider display links are inert provenance metadata and are never fetched. */
function providerSourceUrl(value: unknown, fallbackUrl: string) {
  if (value === undefined || value === null || value === "") return fallbackUrl;
  const raw = requireProviderString(value, "YuanDian source URL", 4_000);
  let url: URL;
  try {
    url = new URL(raw, "https://www.chineselaw.com");
  } catch {
    adapterError("YuanDian source URL is invalid.", "response_invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.port ||
    url.username ||
    url.password ||
    !OFFICIAL_DISPLAY_HOSTS.has(url.hostname)
  ) {
    adapterError(
      "YuanDian source URL is not an official HTTPS URL.",
      "response_invalid",
    );
  }
  return url.toString();
}

function validCalendarDate(year: number, month: number, day: number) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function dateParts(value: unknown, label: string, openEnded = false) {
  if (value === undefined || value === null || value === "") return undefined;
  if (openEnded && (value === 99999999 || value === "99999999"))
    return undefined;
  const raw = typeof value === "number" ? String(value) : value;
  if (typeof raw !== "string") {
    adapterError(`${label} is invalid.`, "response_invalid");
  }
  const trimmed = raw.trim();
  const match =
    /^(\d{4})(\d{2})(\d{2})$/.exec(trimmed) ??
    /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed) ??
    /^(\d{4})年(\d{1,2})月(\d{1,2})日$/.exec(trimmed);
  if (!match) adapterError(`${label} is invalid.`, "response_invalid");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!validCalendarDate(year, month, day)) {
    adapterError(`${label} is invalid.`, "response_invalid");
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function plausibleChineseCaseNumber(value: string) {
  return /^[（(]\d{4}[）)][^\s]{1,80}号$/u.test(value);
}

function truncate(value: string, maxLength: number) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1)}…`;
}

function regulationTitle(value: unknown) {
  if (typeof value === "string") {
    return requireProviderString(value, "YuanDian regulation title", 20_000);
  }
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 20 &&
    value.every((entry) => typeof entry === "string" && entry.trim())
  ) {
    return value.map((entry) => entry.trim()).join(" / ");
  }
  adapterError("YuanDian regulation title is invalid.", "response_invalid");
}

function documentKind(authorityLevel: string | undefined) {
  return authorityLevel === "司法解释"
    ? ("judicial_interpretation" as const)
    : ("statute" as const);
}

function requireSuccessEnvelope(value: unknown, label: string) {
  if (!isPlainObject(value)) {
    adapterError(`${label} is invalid.`, "response_invalid");
  }
  if (value.code === 401 || value.code === 403) {
    adapterError(
      "YuanDian rejected the API credential.",
      "credential_unavailable",
    );
  }
  if (typeof value.code !== "number") {
    adapterError(`${label} code is invalid.`, "response_invalid");
  }
  if (value.code !== 200 && value.code !== 201) {
    adapterError(`${label} reported a business failure.`, "transport_error");
  }
  if (value.status !== undefined && value.status !== "success") {
    adapterError(`${label} status is not successful.`, "transport_error");
  }
  return value;
}

async function resolveApiKey(
  config: ValidatedConfig,
  deps: LegalSourceAdapterDeps,
) {
  const resolver = deps.resolveCredential;
  if (typeof resolver !== "function") {
    adapterError(
      "YuanDian credential resolver is unavailable.",
      "credential_unavailable",
    );
  }
  const value = await resolver(config.credentialRef);
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 4_096 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    adapterError(
      "YuanDian API credential is unavailable.",
      "credential_unavailable",
    );
  }
  return value;
}

async function readLimitedBody(response: Response, maxBytes: number) {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && /^\d+$/.test(contentLength)) {
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared > maxBytes) {
      adapterError(
        "YuanDian response exceeds the configured byte limit.",
        "response_invalid",
      );
    }
  }
  if (!response.body) {
    adapterError("YuanDian response body is missing.", "response_invalid");
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
        adapterError(
          "YuanDian response exceeds the configured byte limit.",
          "response_invalid",
        );
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

async function requestJson(
  config: ValidatedConfig,
  deps: LegalSourceAdapterDeps,
  apiKey: string,
  request: {
    url: URL;
    method: "GET" | "POST";
    body?: Record<string, unknown>;
  },
) {
  const url = exactTransportUrl(request.url);
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    adapterError("YuanDian transport is unavailable.", "configuration_error");
  }
  const controller = new AbortController();
  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeoutFailure = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      controller.abort();
      reject(
        new LegalSourceAdapterError(
          "YuanDian request timed out.",
          "transport_error",
        ),
      );
    }, config.timeoutMs);
  });

  try {
    const response = await Promise.race([
      fetchImpl(url, {
        method: request.method,
        redirect: "manual",
        signal: controller.signal,
        headers: {
          accept: "application/json",
          "x-api-key": apiKey,
          ...(request.method === "POST"
            ? { "content-type": "application/json; charset=utf-8" }
            : {}),
        },
        ...(request.method === "POST"
          ? { body: JSON.stringify(request.body ?? {}) }
          : {}),
      }),
      timeoutFailure,
    ]);

    if (
      response.redirected ||
      (response.status >= 300 && response.status < 400)
    ) {
      adapterError("YuanDian redirects are not permitted.", "policy_violation");
    }
    if (response.status === 401 || response.status === 403) {
      adapterError(
        "YuanDian rejected the API credential.",
        "credential_unavailable",
      );
    }
    if (!response.ok) {
      adapterError(
        "YuanDian API returned an unsuccessful response.",
        "transport_error",
      );
    }
    const responseUrl = response.url ? exactTransportUrl(response.url) : url;
    if (responseUrl.toString() !== url.toString()) {
      adapterError(
        "YuanDian response URL does not match the requested endpoint.",
        "policy_violation",
      );
    }
    const contentType = response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      .trim()
      .toLowerCase();
    if (contentType !== "application/json") {
      adapterError(
        "YuanDian response must be application/json.",
        "response_invalid",
      );
    }
    const raw = await Promise.race([
      readLimitedBody(response, config.maxResponseBytes),
      timeoutFailure,
    ]);
    try {
      return JSON.parse(raw.toString("utf8")) as unknown;
    } catch {
      adapterError("YuanDian response is invalid JSON.", "response_invalid");
    }
  } catch (error) {
    if (error instanceof LegalSourceAdapterError) throw error;
    adapterError("YuanDian request failed.", "transport_error");
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

function inferCaseType(item: Record<string, unknown>) {
  if (
    item.type !== undefined &&
    typeof item.type !== "string" &&
    !(typeof item.type === "number" && Number.isInteger(item.type))
  ) {
    adapterError("YuanDian case type is invalid.", "response_invalid");
  }
  const type =
    typeof item.type === "string"
      ? optionalProviderString(item.type, "YuanDian case type", 100)
      : undefined;
  const authority = optionalProviderString(
    item.authority,
    "YuanDian case authority",
    1_000,
  );
  const database = optionalProviderString(
    item.db,
    "YuanDian case database",
    1_000,
  );
  const descriptor = `${type ?? ""} ${authority ?? ""} ${database ?? ""}`;
  if (/权威|指导|公报|典型|参考/u.test(descriptor)) return "qwal" as const;
  if (/普通案例/u.test(descriptor)) return "ptal" as const;
  return "auto" as const;
}

function searchLawRecords(value: unknown, fetchedAt: string, limit: number) {
  const envelope = requireSuccessEnvelope(
    value,
    "YuanDian law-search response",
  );
  if (!isPlainObject(envelope.extra) || !Array.isArray(envelope.extra.fatiao)) {
    adapterError(
      "YuanDian law-search results are invalid.",
      "response_invalid",
    );
  }
  if (envelope.extra.fatiao.length > limit) {
    adapterError(
      "YuanDian law-search returned more records than requested.",
      "response_invalid",
    );
  }
  return envelope.extra.fatiao.map((raw): YuanDianLegalSourceSearchResult => {
    if (!isPlainObject(raw)) {
      adapterError(
        "YuanDian law-search record is invalid.",
        "response_invalid",
      );
    }
    const providerId = validateProviderId(
      requireProviderString(raw.ftid, "YuanDian article ID", 256),
      "response_invalid",
    );
    const regulationId = validateProviderId(
      requireProviderString(raw.fgid, "YuanDian regulation ID", 256),
      "response_invalid",
    );
    const title = regulationTitle(raw.fgtitle);
    const articleNumber = requireProviderString(
      raw.num,
      "YuanDian article number",
      1_000,
    );
    const content = requireProviderString(
      raw.content,
      "YuanDian article content",
    );
    const validityStatus = requireProviderString(
      raw.sxx,
      "YuanDian validity status",
      1_000,
    );
    const authorityLevel = requireProviderString(
      raw.effect1,
      "YuanDian authority level",
      1_000,
    );
    const effectiveDate = dateParts(
      raw.start,
      "YuanDian article effective date",
    );
    const effectiveTo = dateParts(
      raw.end,
      "YuanDian article effective-to date",
      true,
    );
    if (effectiveDate && effectiveTo && effectiveTo < effectiveDate) {
      adapterError(
        "YuanDian article effective interval is invalid.",
        "response_invalid",
      );
    }
    const suffix = providerId.startsWith(`${regulationId}_`)
      ? providerId.slice(regulationId.length + 1)
      : "";
    const displayUrl = new URL(
      `/zxt/statuteDetail/detailPage/${encodeURIComponent(regulationId)}`,
      "https://www.chineselaw.com",
    );
    if (suffix) displayUrl.searchParams.set("text", suffix);
    const transportUrl = YUANDIAN_REST_ENDPOINTS.articleDetail;
    return {
      documentId: articleDocumentId(providerId),
      title: `${title}${articleNumber}`,
      summary: truncate(content, 800),
      snapshot: makeSnapshot(
        {
          documentId: articleDocumentId(providerId),
          title: `${title}${articleNumber}`,
          content,
          sourceUrl: displayUrl.toString(),
          transportUrl,
          recordType: "law_article",
          providerRecordId: providerId,
          regulationId,
          articleNumber,
          effectiveDate,
          effectiveTo,
          validityStatus,
          authorityLevel,
          documentKind: documentKind(authorityLevel),
        },
        fetchedAt,
      ),
    };
  });
}

function searchCaseRecords(value: unknown, fetchedAt: string, limit: number) {
  const envelope = requireSuccessEnvelope(
    value,
    "YuanDian case-search response",
  );
  if (!isPlainObject(envelope.extra) || !Array.isArray(envelope.extra.wenshu)) {
    adapterError(
      "YuanDian case-search results are invalid.",
      "response_invalid",
    );
  }
  if (envelope.extra.wenshu.length > limit) {
    adapterError(
      "YuanDian case-search returned more records than requested.",
      "response_invalid",
    );
  }
  return envelope.extra.wenshu.map((raw): YuanDianLegalSourceSearchResult => {
    if (!isPlainObject(raw)) {
      adapterError(
        "YuanDian case-search record is invalid.",
        "response_invalid",
      );
    }
    const providerId = validateProviderId(
      requireProviderString(raw.scid, "YuanDian case ID", 256),
      "response_invalid",
    );
    const title = requireProviderString(
      raw.title,
      "YuanDian case title",
      20_000,
    );
    const content = requireProviderString(raw.content, "YuanDian case content");
    const caseNumber = requireProviderString(
      raw.ah,
      "YuanDian case number",
      1_000,
    );
    const court = optionalProviderString(
      raw.jbdw,
      "YuanDian case court",
      20_000,
    );
    const judgmentDate = dateParts(raw.jaDate, "YuanDian case judgment date");
    const caseType = inferCaseType(raw);
    const transport = exactTransportUrl(YUANDIAN_REST_ENDPOINTS.caseDetail);
    transport.searchParams.set("id", providerId);
    if (caseType !== "auto") transport.searchParams.set("type", caseType);
    const typedId = caseDocumentId(providerId, caseType);
    return {
      documentId: typedId,
      title,
      summary: truncate(content, 800),
      snapshot: makeSnapshot(
        {
          documentId: typedId,
          title,
          content,
          sourceUrl: transport.toString(),
          transportUrl: transport.toString(),
          recordType: "case",
          providerRecordId: providerId,
          publicationDate: judgmentDate,
          documentKind: "case",
          caseNumber,
          caseVerificationStatus: "unverified",
          court,
          judgmentDate,
        },
        fetchedAt,
      ),
    };
  });
}

function makeSnapshot(
  item: NormalizedRecord,
  fetchedAt: string,
): YuanDianLegalSourceSnapshot {
  if (Number.isNaN(Date.parse(fetchedAt))) {
    adapterError("YuanDian fetch timestamp is invalid.", "response_invalid");
  }
  return {
    url: item.sourceUrl,
    fetchedAt,
    contentHash: sha256(item.content),
    sourceType: "yuandian",
    provider: "yuandian",
    recordType: item.recordType,
    providerRecordId: item.providerRecordId,
    transportUrl: item.transportUrl,
    ...(item.sourceUrl === item.transportUrl
      ? {}
      : { providerSourceUrl: item.sourceUrl }),
    ...(item.regulationId ? { regulationId: item.regulationId } : {}),
    ...(item.articleNumber ? { articleNumber: item.articleNumber } : {}),
    ...(item.effectiveDate ? { effectiveDate: item.effectiveDate } : {}),
    ...(item.effectiveTo ? { effectiveTo: item.effectiveTo } : {}),
    ...(item.publicationDate ? { publicationDate: item.publicationDate } : {}),
    ...(item.validityStatus ? { validityStatus: item.validityStatus } : {}),
    ...(item.authorityLevel ? { authorityLevel: item.authorityLevel } : {}),
    documentKind: item.documentKind,
    ...(item.caseNumber
      ? {
          caseNumber: item.caseNumber,
          caseNumberFormatValid: plausibleChineseCaseNumber(item.caseNumber),
          caseVerificationStatus:
            item.caseVerificationStatus ?? ("unverified" as const),
        }
      : {}),
    ...(item.court ? { court: item.court } : {}),
    ...(item.judgmentDate ? { judgmentDate: item.judgmentDate } : {}),
  };
}

function parseArticleDocument(
  value: unknown,
  typedId: string,
  expectedProviderId: string,
  transportUrl: string,
  fetchedAt: string,
) {
  const envelope = requireSuccessEnvelope(
    value,
    "YuanDian article-detail response",
  );
  if (!isPlainObject(envelope.data)) {
    adapterError(
      "YuanDian article-detail data is invalid.",
      "response_invalid",
    );
  }
  const data = envelope.data;
  const providerId = validateProviderId(
    requireProviderString(data.id, "YuanDian article ID", 256),
    "response_invalid",
  );
  if (providerId !== expectedProviderId) {
    adapterError(
      "YuanDian article-detail ID does not match.",
      "response_invalid",
    );
  }
  const regulationId = validateProviderId(
    requireProviderString(data.fgid, "YuanDian regulation ID", 256),
    "response_invalid",
  );
  const articleNumber = requireProviderString(
    data.ft_num,
    "YuanDian article number",
    1_000,
  );
  const title = requireProviderString(
    data.title,
    "YuanDian article title",
    20_000,
  );
  const content = requireProviderString(
    data.content,
    "YuanDian article content",
  );
  const validityStatus = requireProviderString(
    data.sxx,
    "YuanDian validity status",
    1_000,
  );
  const authorityLevel = optionalProviderString(
    data.xljb_1,
    "YuanDian authority level",
    1_000,
  );
  const effectiveDate = dateParts(data.ssrq, "YuanDian article effective date");
  const publicationDate = dateParts(
    data.fbrq,
    "YuanDian article publication date",
  );
  const sourceUrl = providerSourceUrl(data.url, transportUrl);
  const normalized: NormalizedRecord = {
    documentId: typedId,
    title,
    content,
    sourceUrl,
    transportUrl,
    recordType: "law_article",
    providerRecordId: providerId,
    regulationId,
    articleNumber,
    effectiveDate,
    publicationDate,
    validityStatus,
    authorityLevel,
    documentKind: documentKind(authorityLevel),
  };
  return {
    documentId: typedId,
    title,
    content,
    snapshot: makeSnapshot(normalized, fetchedAt),
  } satisfies YuanDianLegalSourceDocument;
}

function parseRegulationDocument(
  value: unknown,
  typedId: string,
  expectedProviderId: string,
  transportUrl: string,
  fetchedAt: string,
) {
  const envelope = requireSuccessEnvelope(
    value,
    "YuanDian regulation-detail response",
  );
  if (!isPlainObject(envelope.data)) {
    adapterError(
      "YuanDian regulation-detail data is invalid.",
      "response_invalid",
    );
  }
  const data = envelope.data;
  const providerId = validateProviderId(
    requireProviderString(data.id, "YuanDian regulation ID", 256),
    "response_invalid",
  );
  if (providerId !== expectedProviderId) {
    adapterError(
      "YuanDian regulation-detail ID does not match.",
      "response_invalid",
    );
  }
  const title = requireProviderString(
    data.title,
    "YuanDian regulation title",
    20_000,
  );
  const content = requireProviderString(
    data.content,
    "YuanDian regulation content",
  );
  const validityStatus = requireProviderString(
    data.sxx,
    "YuanDian validity status",
    1_000,
  );
  const authorityLevel = optionalProviderString(
    data.xljb_1,
    "YuanDian authority level",
    1_000,
  );
  const effectiveDate = dateParts(
    data.ssrq,
    "YuanDian regulation effective date",
  );
  const publicationDate = dateParts(
    data.fbrq,
    "YuanDian regulation publication date",
  );
  const sourceUrl = providerSourceUrl(data.url, transportUrl);
  const normalized: NormalizedRecord = {
    documentId: typedId,
    title,
    content,
    sourceUrl,
    transportUrl,
    recordType: "law_regulation",
    providerRecordId: providerId,
    regulationId: providerId,
    effectiveDate,
    publicationDate,
    validityStatus,
    authorityLevel,
    documentKind: documentKind(authorityLevel),
  };
  return {
    documentId: typedId,
    title,
    content,
    snapshot: makeSnapshot(normalized, fetchedAt),
  } satisfies YuanDianLegalSourceDocument;
}

function parseCaseDocument(
  value: unknown,
  typedId: string,
  expected: Extract<YuanDianDocumentId, { kind: "case" }>,
  transportUrl: string,
  fetchedAt: string,
) {
  const envelope = requireSuccessEnvelope(
    value,
    "YuanDian case-detail response",
  );
  if (!Array.isArray(envelope.data) || envelope.data.length > 10) {
    adapterError("YuanDian case-detail data is invalid.", "response_invalid");
  }
  const matches = envelope.data.filter(
    (item) => isPlainObject(item) && item.id === expected.providerId,
  );
  if (matches.length !== 1 || !isPlainObject(matches[0])) {
    adapterError(
      "YuanDian case-detail result does not uniquely match the requested ID.",
      "response_invalid",
    );
  }
  const data = matches[0];
  const returnedType = requireProviderString(
    data.type,
    "YuanDian case-detail type",
    100,
  );
  if (
    (expected.caseType === "ptal" && returnedType !== "普通案例") ||
    (expected.caseType === "qwal" && returnedType !== "权威案例")
  ) {
    adapterError(
      "YuanDian case-detail type does not match.",
      "response_invalid",
    );
  }
  const title = requireProviderString(
    data.title,
    "YuanDian case title",
    20_000,
  );
  const content = requireProviderString(data.content, "YuanDian case content");
  const caseNumber = requireProviderString(
    data.ah,
    "YuanDian case number",
    1_000,
  );
  const court = optionalProviderString(
    data.jbdw,
    "YuanDian case court",
    20_000,
  );
  const judgmentDate = dateParts(data.cprq, "YuanDian case judgment date");
  const sourceUrl = providerSourceUrl(data.url, transportUrl);
  const normalized: NormalizedRecord = {
    documentId: typedId,
    title,
    content,
    sourceUrl,
    transportUrl,
    recordType: "case",
    providerRecordId: expected.providerId,
    publicationDate: judgmentDate,
    documentKind: "case",
    caseNumber,
    caseVerificationStatus: "verified",
    court,
    judgmentDate,
  };
  return {
    documentId: typedId,
    title,
    content,
    snapshot: makeSnapshot(normalized, fetchedAt),
  } satisfies YuanDianLegalSourceDocument;
}

function currentTimestamp(deps: LegalSourceAdapterDeps) {
  const date = (deps.now ?? (() => new Date()))();
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    adapterError(
      "YuanDian clock returned an invalid date.",
      "response_invalid",
    );
  }
  return date.toISOString();
}

export function createYuanDianLegalSourceAdapter(
  config: YuanDianLegalSourceAdapterConfig,
  deps: LegalSourceAdapterDeps = {},
): YuanDianLegalSourceAdapter {
  const validated = validateConfig(config);
  return {
    provider: "yuandian",

    async search(request) {
      const query = validateSearchRequest(request);
      const apiKey = await resolveApiKey(validated, deps);
      const lawUrl = exactTransportUrl(YUANDIAN_REST_ENDPOINTS.lawSearch);
      const caseUrl = exactTransportUrl(YUANDIAN_REST_ENDPOINTS.caseSearch);
      const [lawResponse, caseResponse] = await Promise.all([
        requestJson(validated, deps, apiKey, {
          url: lawUrl,
          method: "POST",
          body: {
            query,
            rewrite_flag: false,
            return_num: validated.resultsPerKind,
          },
        }),
        requestJson(validated, deps, apiKey, {
          url: caseUrl,
          method: "POST",
          body: {
            query,
            rewrite_flag: false,
            wenshu_filter: { dianxing: false },
            return_num: validated.resultsPerKind,
          },
        }),
      ]);
      const fetchedAt = currentTimestamp(deps);
      return [
        ...searchLawRecords(lawResponse, fetchedAt, validated.resultsPerKind),
        ...searchCaseRecords(caseResponse, fetchedAt, validated.resultsPerKind),
      ];
    },

    async fetch(request) {
      const typedId = validateFetchRequest(request);
      const parsed = parseDocumentId(typedId);
      const apiKey = await resolveApiKey(validated, deps);
      if (parsed.kind === "article") {
        const url = exactTransportUrl(YUANDIAN_REST_ENDPOINTS.articleDetail);
        const response = await requestJson(validated, deps, apiKey, {
          url,
          method: "POST",
          body: { id: parsed.providerId },
        });
        return parseArticleDocument(
          response,
          typedId,
          parsed.providerId,
          url.toString(),
          currentTimestamp(deps),
        );
      }

      if (parsed.kind === "regulation") {
        const url = exactTransportUrl(YUANDIAN_REST_ENDPOINTS.regulationDetail);
        const response = await requestJson(validated, deps, apiKey, {
          url,
          method: "POST",
          body: { id: parsed.providerId },
        });
        return parseRegulationDocument(
          response,
          typedId,
          parsed.providerId,
          url.toString(),
          currentTimestamp(deps),
        );
      }

      const url = exactTransportUrl(YUANDIAN_REST_ENDPOINTS.caseDetail);
      url.searchParams.set("id", parsed.providerId);
      if (parsed.caseType !== "auto") {
        url.searchParams.set("type", parsed.caseType);
      }
      const response = await requestJson(validated, deps, apiKey, {
        url,
        method: "GET",
      });
      return parseCaseDocument(
        response,
        typedId,
        parsed,
        url.toString(),
        currentTimestamp(deps),
      );
    },
  };
}
