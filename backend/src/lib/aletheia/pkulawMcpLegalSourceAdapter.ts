import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  LegalSourceAdapterError,
  type LegalSourceAdapter,
  type LegalSourceFetchRequest,
  type LegalSourceSearchRequest,
  type LegalSourceSearchResult,
  type LegalSourceSnapshot,
} from "./legalSourceAdapter";

const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1_000_000;
const MAX_RESPONSE_BYTES = 2_000_000;
const DEFAULT_MAX_RESULTS = 50;
const MAX_RESULTS = 100;
const MAX_QUERY_LENGTH = 4_000;
const MAX_STRUCTURE_DEPTH = 12;
const MAX_STRUCTURE_NODES = 10_000;
const MAX_OBJECT_KEYS = 128;
const MAX_ARRAY_ITEMS = 500;
const MAX_STRING_BYTES = 1_000_000;
const MAX_REQUEST_BYTES = 64_000;
const PKULAW_GATEWAY_HOST = "apim-gw.pkulaw.com";
const PKULAW_DOCUMENTED_GATEWAY_HOST = "apim-gateway.pkulaw.com";
const PKULAW_DOCUMENTED_LAW_SEMANTIC_PATH = "/mcp-law-search-service";
const SERVICE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const CREDENTIAL_REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export type PkulawMcpEndpointDisposition =
  | "approved_mcp"
  | "invalid_mcp_gateway"
  | "not_mcp";

/**
 * The adapter never calls tools/list and never forwards remote tool schemas to
 * a model. Expanding this allowlist requires a separately reviewed mapping.
 */
export const PKULAW_MCP_TOOL_ALLOWLIST = ["search_article"] as const;
type PkulawAllowedTool = (typeof PKULAW_MCP_TOOL_ALLOWLIST)[number];

export type PkulawMcpLegalSourceAdapterConfig = {
  /** Copy the service URL from the user's PKULaw application detail page. */
  endpoint: string;
  /** Secret-store reference only. A bearer token value is never configuration. */
  credentialRef: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxResults?: number;
};

export type PkulawMcpClientRequestOptions = {
  signal: AbortSignal;
  timeout: number;
  maxTotalTimeout: number;
};

export type PkulawMcpClientSession = {
  connect(options: PkulawMcpClientRequestOptions): Promise<void>;
  callTool(
    request: { name: PkulawAllowedTool; arguments: Record<string, unknown> },
    options: PkulawMcpClientRequestOptions,
  ): Promise<unknown>;
  close(): Promise<void>;
};

export type PkulawMcpClientFactoryInput = {
  endpoint: URL;
  authorizationHeader: string;
  fetch: typeof globalThis.fetch;
  timeoutMs: number;
  maxResponseBytes: number;
};

export type PkulawMcpLegalSourceAdapterDeps = {
  resolveCredential?: (credentialRef: string) => Promise<string | undefined>;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  /** Test seam. Production defaults to the repository MCP SDK client. */
  createClient?: (
    input: PkulawMcpClientFactoryInput,
  ) => PkulawMcpClientSession | Promise<PkulawMcpClientSession>;
};

type ValidatedConfig = {
  endpoint: URL;
  credentialRef: string;
  timeoutMs: number;
  maxResponseBytes: number;
  maxResults: number;
};

type NormalizedSearchItem = {
  providerId?: string;
  title: string;
  summary?: string;
  url: string;
  version?: string;
  effectiveDate?: string;
  effectiveTo?: string;
  publicationDate?: string;
  documentKind?: "statute" | "judicial_interpretation" | "other";
};

function adapterError(
  message: string,
  code: ConstructorParameters<typeof LegalSourceAdapterError>[1],
) {
  return new LegalSourceAdapterError(message, code);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireExactKeys(
  value: unknown,
  keys: readonly string[],
  label: string,
) {
  if (!isPlainObject(value)) {
    throw adapterError(`${label} must be an object.`, "policy_violation");
  }
  const received = Object.keys(value);
  if (
    received.length !== keys.length ||
    received.some((key) => !keys.includes(key))
  ) {
    throw adapterError(
      `${label} accepts only ${keys.join(", ")}. Matter facts and other context are not accepted.`,
      "policy_violation",
    );
  }
}

function positiveInteger(
  value: unknown,
  fallback: number,
  maximum: number,
  label: string,
) {
  const resolved = value ?? fallback;
  if (
    !Number.isInteger(resolved) ||
    Number(resolved) < 1 ||
    Number(resolved) > maximum
  ) {
    throw adapterError(`${label} is invalid.`, "configuration_error");
  }
  return Number(resolved);
}

/**
 * PKULaw currently documents two equivalent gateway URL shapes. The first is
 * application-specific and therefore validates a bounded, single service-id
 * path segment rather than hard-coding a documentation placeholder. The
 * second is the published law-semantic path used by Streamable HTTP clients.
 */
export function validatePkulawMcpEndpoint(raw: string) {
  if (typeof raw !== "string" || raw.length > 2_048) {
    throw adapterError(
      "PKULaw MCP endpoint must be a bounded HTTPS URL.",
      "configuration_error",
    );
  }
  let endpoint: URL;
  try {
    endpoint = new URL(raw);
  } catch {
    throw adapterError(
      "PKULaw MCP endpoint must be a valid HTTPS URL.",
      "configuration_error",
    );
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.port ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw adapterError(
      "PKULaw MCP endpoint must use HTTPS without credentials, a custom port, query, or fragment.",
      "policy_violation",
    );
  }

  const hostname = endpoint.hostname.toLowerCase();
  const segments = endpoint.pathname.split("/").filter(Boolean);
  const applicationEndpoint =
    hostname === PKULAW_GATEWAY_HOST &&
    segments.length === 2 &&
    SERVICE_ID.test(segments[0] ?? "") &&
    segments[1] === "mcp" &&
    endpoint.pathname === `/${segments[0]}/mcp`;
  const documentedEndpoint =
    hostname === PKULAW_DOCUMENTED_GATEWAY_HOST &&
    (endpoint.pathname === PKULAW_DOCUMENTED_LAW_SEMANTIC_PATH ||
      endpoint.pathname === `${PKULAW_DOCUMENTED_LAW_SEMANTIC_PATH}/mcp`);

  if (!applicationEndpoint && !documentedEndpoint) {
    throw adapterError(
      "PKULaw MCP endpoint is not an approved law-semantic gateway URL. Copy the real URL from the application detail page.",
      "policy_violation",
    );
  }
  return endpoint;
}

/**
 * Distinguish the official MCP gateways from separately contracted PKULaw
 * JSON/API endpoints. An official gateway host with any unapproved URL shape
 * is never eligible for the legacy JSON fallback.
 */
export function classifyPkulawMcpEndpoint(
  raw: string | undefined,
): PkulawMcpEndpointDisposition {
  if (typeof raw !== "string" || !raw.trim()) return "not_mcp";
  let endpoint: URL;
  try {
    endpoint = new URL(raw);
  } catch {
    return "not_mcp";
  }
  const hostname = endpoint.hostname.toLowerCase();
  if (
    hostname !== PKULAW_GATEWAY_HOST &&
    hostname !== PKULAW_DOCUMENTED_GATEWAY_HOST
  ) {
    return "not_mcp";
  }
  try {
    validatePkulawMcpEndpoint(raw);
    return "approved_mcp";
  } catch {
    return "invalid_mcp_gateway";
  }
}

function validateConfig(
  config: PkulawMcpLegalSourceAdapterConfig,
): ValidatedConfig {
  if (!isPlainObject(config)) {
    throw adapterError(
      "PKULaw MCP configuration is required.",
      "configuration_error",
    );
  }
  const allowedConfigKeys = new Set([
    "endpoint",
    "credentialRef",
    "timeoutMs",
    "maxResponseBytes",
    "maxResults",
  ]);
  if (Object.keys(config).some((key) => !allowedConfigKeys.has(key))) {
    throw adapterError(
      "PKULaw MCP configuration contains an unsupported field.",
      "configuration_error",
    );
  }
  if (
    typeof config.credentialRef !== "string" ||
    !CREDENTIAL_REF.test(config.credentialRef)
  ) {
    throw adapterError(
      "PKULaw MCP configuration requires a credential reference, not a bearer token value.",
      "configuration_error",
    );
  }
  return {
    endpoint: validatePkulawMcpEndpoint(config.endpoint),
    credentialRef: config.credentialRef,
    timeoutMs: positiveInteger(
      config.timeoutMs,
      DEFAULT_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
      "PKULaw MCP timeout",
    ),
    maxResponseBytes: positiveInteger(
      config.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
      MAX_RESPONSE_BYTES,
      "PKULaw MCP response byte limit",
    ),
    maxResults: positiveInteger(
      config.maxResults,
      DEFAULT_MAX_RESULTS,
      MAX_RESULTS,
      "PKULaw MCP result limit",
    ),
  };
}

function requestUrl(input: string | URL | Request) {
  if (typeof input === "string") return new URL(input);
  if (input instanceof URL) return input;
  return new URL(input.url);
}

function boundedResponseBody(
  body: ReadableStream<Uint8Array>,
  maximum: number,
) {
  const reader = body.getReader();
  let received = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          controller.close();
          return;
        }
        received += next.value.byteLength;
        if (received > maximum) {
          await reader.cancel();
          controller.error(
            adapterError(
              "PKULaw MCP response exceeded the configured byte limit.",
              "response_invalid",
            ),
          );
          return;
        }
        controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
}

function guardedPkulawFetch(
  fetchImpl: typeof globalThis.fetch,
  endpoint: URL,
  authorizationHeader: string,
  maxResponseBytes: number,
): typeof globalThis.fetch {
  return async (input, init) => {
    let target: URL;
    try {
      target = requestUrl(input);
    } catch {
      throw adapterError(
        "PKULaw MCP transport produced an invalid request URL.",
        "policy_violation",
      );
    }
    if (target.toString() !== endpoint.toString()) {
      throw adapterError(
        "PKULaw MCP transport attempted an unapproved URL.",
        "policy_violation",
      );
    }
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    if (headers.get("authorization") !== authorizationHeader) {
      throw adapterError(
        "PKULaw MCP bearer authorization is missing or was changed.",
        "policy_violation",
      );
    }
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    if (method !== "GET" && method !== "POST" && method !== "DELETE") {
      throw adapterError(
        "PKULaw MCP transport attempted an unsupported HTTP method.",
        "policy_violation",
      );
    }
    if (
      typeof init?.body === "string" &&
      Buffer.byteLength(init.body, "utf8") > MAX_REQUEST_BYTES
    ) {
      throw adapterError(
        "PKULaw MCP request exceeded the byte limit.",
        "policy_violation",
      );
    }

    const response = await fetchImpl(input, { ...init, redirect: "manual" });
    if (
      response.redirected ||
      (response.status >= 300 && response.status < 400)
    ) {
      throw adapterError(
        "PKULaw MCP redirects are not permitted.",
        "policy_violation",
      );
    }
    if (response.url) {
      let responseUrl: URL;
      try {
        responseUrl = new URL(response.url);
      } catch {
        throw adapterError(
          "PKULaw MCP returned an invalid response URL.",
          "policy_violation",
        );
      }
      if (responseUrl.toString() !== endpoint.toString()) {
        throw adapterError(
          "PKULaw MCP response URL changed unexpectedly.",
          "policy_violation",
        );
      }
    }
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (Number.isFinite(declared) && declared > maxResponseBytes) {
      throw adapterError(
        "PKULaw MCP response exceeded the configured byte limit.",
        "response_invalid",
      );
    }
    if (!response.body) return response;
    return new Response(boundedResponseBody(response.body, maxResponseBytes), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

function sdkClientFactory(
  input: PkulawMcpClientFactoryInput,
): PkulawMcpClientSession {
  const transport = new StreamableHTTPClientTransport(input.endpoint, {
    fetch: guardedPkulawFetch(
      input.fetch,
      input.endpoint,
      input.authorizationHeader,
      input.maxResponseBytes,
    ),
    requestInit: {
      headers: { Authorization: input.authorizationHeader },
      redirect: "manual",
    },
    reconnectionOptions: {
      initialReconnectionDelay: 100,
      maxReconnectionDelay: 100,
      reconnectionDelayGrowFactor: 1,
      maxRetries: 0,
    },
  });
  const client = new Client(
    { name: "vera-pkulaw-legal-source", version: "1.0.0" },
    { capabilities: {}, enforceStrictCapabilities: true },
  );
  return {
    async connect(options) {
      await client.connect(transport, options);
    },
    async callTool(request, options) {
      return client.callTool(request, undefined, options);
    },
    async close() {
      await client.close();
    },
  };
}

async function closeSession(
  session: PkulawMcpClientSession,
  timeoutMs: number,
) {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      session.close().catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.min(timeoutMs, 1_000));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function withDeadline<T>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
) {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(adapterError("PKULaw MCP request timed out.", "transport_error"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation(controller.signal), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function validateBearerToken(value: unknown) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 8_192 ||
    value !== value.trim() ||
    /^Bearer\s/i.test(value) ||
    !/^[\x21-\x7e]+$/.test(value)
  ) {
    throw adapterError(
      "PKULaw MCP credential is unavailable or invalid.",
      "credential_unavailable",
    );
  }
  return value;
}

function assertBoundedStructure(value: unknown, maximumBytes: number) {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const seen = new WeakSet<object>();
  let nodes = 0;
  let bytes = 0;
  while (stack.length) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > MAX_STRUCTURE_NODES || current.depth > MAX_STRUCTURE_DEPTH) {
      throw adapterError(
        "PKULaw MCP response structure is too complex.",
        "response_invalid",
      );
    }
    if (typeof current.value === "string") {
      const length = Buffer.byteLength(current.value, "utf8");
      if (length > MAX_STRING_BYTES) {
        throw adapterError(
          "PKULaw MCP response contains an oversized string.",
          "response_invalid",
        );
      }
      bytes += length;
    } else if (
      current.value === null ||
      typeof current.value === "number" ||
      typeof current.value === "boolean"
    ) {
      bytes += 16;
    } else if (Array.isArray(current.value)) {
      if (current.value.length > MAX_ARRAY_ITEMS || seen.has(current.value)) {
        throw adapterError(
          "PKULaw MCP response array is invalid.",
          "response_invalid",
        );
      }
      seen.add(current.value);
      for (const item of current.value)
        stack.push({ value: item, depth: current.depth + 1 });
    } else if (isPlainObject(current.value)) {
      if (seen.has(current.value)) {
        throw adapterError(
          "PKULaw MCP response contains a cycle.",
          "response_invalid",
        );
      }
      seen.add(current.value);
      const entries = Object.entries(current.value);
      if (entries.length > MAX_OBJECT_KEYS) {
        throw adapterError(
          "PKULaw MCP response object has too many fields.",
          "response_invalid",
        );
      }
      for (const [key, child] of entries) {
        bytes += Buffer.byteLength(key, "utf8");
        stack.push({ value: child, depth: current.depth + 1 });
      }
    } else {
      throw adapterError(
        "PKULaw MCP response contains an unsupported value.",
        "response_invalid",
      );
    }
    if (bytes > maximumBytes) {
      throw adapterError(
        "PKULaw MCP response exceeded the configured byte limit.",
        "response_invalid",
      );
    }
  }
}

function parseJsonText(text: string, maxResponseBytes: number) {
  if (!text.trim() || Buffer.byteLength(text, "utf8") > maxResponseBytes) {
    throw adapterError(
      "PKULaw MCP text result is empty or oversized.",
      "response_invalid",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw adapterError(
      "PKULaw MCP text result must contain strict JSON.",
      "response_invalid",
    );
  }
  assertBoundedStructure(parsed, maxResponseBytes);
  return parsed;
}

function toolPayload(result: unknown, maxResponseBytes: number) {
  assertBoundedStructure(result, maxResponseBytes);
  if (!isPlainObject(result)) {
    throw adapterError(
      "PKULaw MCP tool result is invalid.",
      "response_invalid",
    );
  }
  if (result.isError === true) {
    throw adapterError(
      "PKULaw MCP tool reported an unsuccessful result.",
      "transport_error",
    );
  }
  if (Object.hasOwn(result, "structuredContent")) {
    if (result.structuredContent === undefined) {
      throw adapterError(
        "PKULaw MCP structured result is missing.",
        "response_invalid",
      );
    }
    return result.structuredContent;
  }
  if (!Array.isArray(result.content) || result.content.length !== 1) {
    throw adapterError(
      "PKULaw MCP tool result must contain one structured or JSON text payload.",
      "response_invalid",
    );
  }
  const block = result.content[0];
  if (
    !isPlainObject(block) ||
    block.type !== "text" ||
    typeof block.text !== "string"
  ) {
    throw adapterError(
      "PKULaw MCP tool returned an unsupported content block.",
      "response_invalid",
    );
  }
  return parseJsonText(block.text, maxResponseBytes);
}

function requireEnvelopeKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw adapterError(
      `${label} contains unsupported fields.`,
      "response_invalid",
    );
  }
}

function assertSuccessfulBusinessStatus(value: Record<string, unknown>) {
  const hasSuccess = Object.hasOwn(value, "success");
  const hasCode = Object.hasOwn(value, "code");
  if (hasSuccess) {
    if (typeof value.success !== "boolean") {
      throw adapterError(
        "PKULaw MCP success status must be a boolean.",
        "response_invalid",
      );
    }
    if (!value.success) {
      throw adapterError(
        "PKULaw MCP search reported an unsuccessful result.",
        "transport_error",
      );
    }
  }

  if (hasCode) {
    const businessCode = value.code;
    if (typeof businessCode !== "number" || !Number.isInteger(businessCode)) {
      throw adapterError(
        "PKULaw MCP business code must be an integer.",
        "response_invalid",
      );
    }
    if (businessCode !== 200) {
      throw adapterError(
        businessCode >= 400
          ? "PKULaw MCP search reported an unsuccessful result."
          : "PKULaw MCP business code is not an audited success value.",
        businessCode >= 400 ? "transport_error" : "response_invalid",
      );
    }
  }

  if (hasSuccess !== hasCode) {
    throw adapterError(
      "PKULaw MCP business status must contain the audited success and code pair.",
      "response_invalid",
    );
  }
}

function boundedSearchItems(value: unknown, maximum: number) {
  if (!Array.isArray(value)) {
    throw adapterError(
      "PKULaw MCP search result list is invalid.",
      "response_invalid",
    );
  }
  if (value.length > maximum) {
    throw adapterError(
      "PKULaw MCP returned too many search results.",
      "response_invalid",
    );
  }
  return value;
}

function searchItems(payload: unknown, maximum: number) {
  if (Array.isArray(payload)) return boundedSearchItems(payload, maximum);
  if (!isPlainObject(payload)) {
    throw adapterError(
      "PKULaw MCP search payload has an unsupported structure.",
      "response_invalid",
    );
  }

  assertSuccessfulBusinessStatus(payload);
  if (Object.hasOwn(payload, "results")) {
    requireEnvelopeKeys(
      payload,
      ["results", "success", "code"],
      "PKULaw MCP results envelope",
    );
    return boundedSearchItems(payload.results, maximum);
  }

  if (Object.hasOwn(payload, "data")) {
    requireEnvelopeKeys(
      payload,
      ["data", "success", "code"],
      "PKULaw MCP data envelope",
    );
    if (!isPlainObject(payload.data)) {
      throw adapterError(
        "PKULaw MCP data envelope is invalid.",
        "response_invalid",
      );
    }
    requireEnvelopeKeys(
      payload.data,
      ["items"],
      "PKULaw MCP data items envelope",
    );
    if (!Object.hasOwn(payload.data, "items")) {
      throw adapterError(
        "PKULaw MCP data items envelope is missing.",
        "response_invalid",
      );
    }
    return boundedSearchItems(payload.data.items, maximum);
  }

  throw adapterError(
    "PKULaw MCP search payload has an unsupported structure.",
    "response_invalid",
  );
}

function optionalString(
  item: Record<string, unknown>,
  aliases: readonly string[],
  label: string,
  maxLength: number,
) {
  const key = aliases.find((candidate) => item[candidate] !== undefined);
  if (!key) return undefined;
  const value = item[key];
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw adapterError(`${label} is invalid.`, "response_invalid");
  }
  return value.trim();
}

function optionalDate(
  item: Record<string, unknown>,
  aliases: readonly string[],
  label: string,
) {
  const value = optionalString(item, aliases, label, 32);
  if (value !== undefined) {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (
      !ISO_DATE.test(value) ||
      Number.isNaN(parsed.getTime()) ||
      parsed.toISOString().slice(0, 10) !== value
    ) {
      throw adapterError(`${label} is invalid.`, "response_invalid");
    }
  }
  return value;
}

function validateSourceUrl(raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw adapterError("PKULaw source URL is invalid.", "response_invalid");
  }
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    (hostname !== "pkulaw.com" && !hostname.endsWith(".pkulaw.com"))
  ) {
    throw adapterError(
      "PKULaw source URL is not an approved HTTPS URL.",
      "response_invalid",
    );
  }
  return url.toString();
}

function documentKind(value: unknown) {
  if (value === undefined) return undefined;
  if (
    value === "statute" ||
    value === "judicial_interpretation" ||
    value === "other"
  ) {
    return value;
  }
  throw adapterError("PKULaw document kind is invalid.", "response_invalid");
}

function normalizeSearchItem(value: unknown): NormalizedSearchItem {
  if (!isPlainObject(value)) {
    throw adapterError("PKULaw search result is invalid.", "response_invalid");
  }
  const title = optionalString(
    value,
    ["title", "lawName", "regulationName", "name"],
    "PKULaw result title",
    20_000,
  );
  const url = optionalString(
    value,
    ["url", "sourceUrl", "detailUrl", "link"],
    "PKULaw result source URL",
    4_000,
  );
  if (!title || !url) {
    throw adapterError(
      "PKULaw search result requires a title and source URL.",
      "response_invalid",
    );
  }
  const effectiveDate = optionalDate(
    value,
    ["effectiveDate"],
    "PKULaw effective date",
  );
  const effectiveTo = optionalDate(
    value,
    ["effectiveTo"],
    "PKULaw effective-to date",
  );
  if (effectiveDate && effectiveTo && effectiveTo < effectiveDate) {
    throw adapterError(
      "PKULaw effective date interval is invalid.",
      "response_invalid",
    );
  }
  const explicitSummary = optionalString(
    value,
    ["summary", "snippet", "abstract"],
    "PKULaw result summary",
    20_000,
  );
  // The public MCP material does not establish that generic text/content (or
  // similarly named fields) is the complete, licensed source document. Keep a
  // bounded preview for search UX only; it must never make fetch() available.
  const unverifiedText = explicitSummary
    ? undefined
    : optionalString(
        value,
        ["text", "content", "articleContent", "fullText"],
        "PKULaw unverified result text",
        1_000_000,
      );
  return {
    providerId: optionalString(
      value,
      ["id", "documentId", "articleId", "gid"],
      "PKULaw provider document ID",
      512,
    ),
    title,
    summary: explicitSummary ?? unverifiedText?.slice(0, 4_000),
    url: validateSourceUrl(url),
    version: optionalString(
      value,
      ["version"],
      "PKULaw result version",
      20_000,
    ),
    effectiveDate,
    effectiveTo,
    publicationDate: optionalDate(
      value,
      ["publicationDate", "publishDate"],
      "PKULaw publication date",
    ),
    documentKind: documentKind(value.documentKind),
  };
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sourceSnapshot(
  item: NormalizedSearchItem,
  fetchedAt: string,
): LegalSourceSnapshot {
  const hashInput = JSON.stringify({
    providerId: item.providerId ?? "",
    title: item.title,
    summary: item.summary ?? "",
    url: item.url,
    version: item.version ?? "",
    effectiveDate: item.effectiveDate ?? "",
  });
  return {
    url: item.url,
    fetchedAt,
    contentHash: `sha256:${sha256(hashInput)}`,
    sourceType: "pkulaw",
    ...(item.version ? { version: item.version } : {}),
    ...(item.effectiveDate ? { effectiveDate: item.effectiveDate } : {}),
    ...(item.effectiveTo ? { effectiveTo: item.effectiveTo } : {}),
    ...(item.publicationDate ? { publicationDate: item.publicationDate } : {}),
    ...(item.documentKind ? { documentKind: item.documentKind } : {}),
  };
}

function stableDocumentId(item: NormalizedSearchItem) {
  return `pkulaw:mcp:${sha256(
    JSON.stringify({
      id: item.providerId ?? "",
      title: item.title,
      url: item.url,
    }),
  )}`;
}

function validateSearchRequest(request: LegalSourceSearchRequest) {
  requireExactKeys(request, ["query"], "PKULaw legal-source search request");
  if (
    typeof request.query !== "string" ||
    !request.query.trim() ||
    request.query.length > MAX_QUERY_LENGTH
  ) {
    throw adapterError(
      "PKULaw legal-source query is invalid.",
      "policy_violation",
    );
  }
  return request.query.trim();
}

function validateFetchRequest(request: LegalSourceFetchRequest) {
  requireExactKeys(
    request,
    ["documentId"],
    "PKULaw legal-source fetch request",
  );
  if (
    typeof request.documentId !== "string" ||
    !/^pkulaw:mcp:[a-f0-9]{64}$/.test(request.documentId)
  ) {
    throw adapterError(
      "PKULaw legal-source document ID is invalid.",
      "policy_violation",
    );
  }
  return request.documentId;
}

function timestamp(now: () => Date) {
  const value = now();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw adapterError(
      "PKULaw retrieval clock is invalid.",
      "configuration_error",
    );
  }
  return value.toISOString();
}

/**
 * Read-only PKULaw law-semantic adapter. MCP semantic-search output is never
 * retained as licensed full text. fetch() stays fail-closed until a separately
 * audited precise-article service and response contract are configured.
 */
export function createPkulawMcpLegalSourceAdapter(
  config: PkulawMcpLegalSourceAdapterConfig,
  deps: PkulawMcpLegalSourceAdapterDeps = {},
): LegalSourceAdapter {
  const validated = validateConfig(config);
  const now = deps.now ?? (() => new Date());

  const search = async (
    request: LegalSourceSearchRequest,
  ): Promise<LegalSourceSearchResult[]> => {
    const query = validateSearchRequest(request);
    return withDeadline(validated.timeoutMs, async (signal) => {
      if (!deps.resolveCredential) {
        throw adapterError(
          "PKULaw MCP credential resolver is unavailable.",
          "credential_unavailable",
        );
      }
      let token: string;
      try {
        token = validateBearerToken(
          await deps.resolveCredential(validated.credentialRef),
        );
      } catch (error) {
        if (error instanceof LegalSourceAdapterError) throw error;
        throw adapterError(
          "PKULaw MCP credential could not be resolved.",
          "credential_unavailable",
        );
      }
      const fetchImpl = deps.fetch ?? globalThis.fetch;
      if (typeof fetchImpl !== "function") {
        throw adapterError(
          "PKULaw MCP transport is unavailable.",
          "configuration_error",
        );
      }
      const authorizationHeader = `Bearer ${token}`;
      let session: PkulawMcpClientSession | undefined;
      try {
        const factory = deps.createClient ?? sdkClientFactory;
        session = await factory({
          endpoint: validated.endpoint,
          authorizationHeader,
          fetch: fetchImpl,
          timeoutMs: validated.timeoutMs,
          maxResponseBytes: validated.maxResponseBytes,
        });
        const options: PkulawMcpClientRequestOptions = {
          signal,
          timeout: validated.timeoutMs,
          maxTotalTimeout: validated.timeoutMs,
        };
        await session.connect(options);
        const raw = await session.callTool(
          { name: "search_article", arguments: { text: query } },
          options,
        );
        const payload = toolPayload(raw, validated.maxResponseBytes);
        const fetchedAt = timestamp(now);
        return searchItems(payload, validated.maxResults).map((rawItem) => {
          const item = normalizeSearchItem(rawItem);
          const documentId = stableDocumentId(item);
          const snapshot = sourceSnapshot(item, fetchedAt);
          return {
            documentId,
            title: item.title,
            ...(item.summary ? { summary: item.summary } : {}),
            snapshot,
          };
        });
      } catch (error) {
        if (error instanceof LegalSourceAdapterError) throw error;
        throw adapterError("PKULaw MCP request failed.", "transport_error");
      } finally {
        if (session) await closeSession(session, validated.timeoutMs);
      }
    });
  };

  return {
    provider: "pkulaw",
    search,
    async fetch(request) {
      validateFetchRequest(request);
      throw adapterError(
        "PKULaw full text retrieval is disabled until a separately audited precise-article endpoint and response contract are configured.",
        "response_invalid",
      );
    },
  };
}
