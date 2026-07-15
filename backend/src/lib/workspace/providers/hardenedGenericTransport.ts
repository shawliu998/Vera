import { lookup as dnsLookup } from "node:dns/promises";
import http, {
  type IncomingHttpHeaders,
  type RequestOptions,
} from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";

import type { HardenedGenericTransport } from "./types";

export type GenericTransportResolvedAddress = {
  address: string;
  family: 4 | 6;
};

export type HardenedGenericTransportOptions = {
  /** Disabled by default. This only permits exact loopback destinations. */
  allowLoopbackHttp?: boolean;
  /** Resolver seam for deterministic security audits. Production uses lookup(all). */
  resolveHost?: (
    hostname: string,
  ) => Promise<readonly GenericTransportResolvedAddress[]>;
};

export class HardenedGenericTransportPolicyError extends Error {
  constructor(
    readonly code:
      | "invalid_request"
      | "protocol_denied"
      | "resolution_failed"
      | "address_denied"
      | "redirect_mode_denied"
      | "network_failed",
    message: string,
  ) {
    super(message);
    this.name = "HardenedGenericTransportPolicyError";
  }
}

const UNSAFE_IPV4 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.31.196.0", 24],
  ["192.52.193.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["192.175.48.0", 24],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  UNSAFE_IPV4.addSubnet(network, prefix, "ipv4");
}

const UNSAFE_IPV6 = new BlockList();
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  // IPv4-mapped destinations are rejected instead of attempting to classify
  // two address families through one socket boundary.
  ["::ffff:0.0.0.0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
  ["5f00::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  UNSAFE_IPV6.addSubnet(network, prefix, "ipv6");
}

const LOOPBACK_IPV4 = new BlockList();
LOOPBACK_IPV4.addSubnet("127.0.0.0", 8, "ipv4");
const LOOPBACK_IPV6 = new BlockList();
LOOPBACK_IPV6.addAddress("::1", "ipv6");

const FORBIDDEN_OUTBOUND_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function normalizedHostname(hostname: string) {
  const trimmed = hostname.trim().toLowerCase();
  return trimmed.startsWith("[") && trimmed.endsWith("]")
    ? trimmed.slice(1, -1)
    : trimmed;
}

export function isExactGenericTransportLoopback(hostname: string) {
  const value = normalizedHostname(hostname);
  if (value === "localhost") return true;
  const family = isIP(value);
  if (family === 4) return LOOPBACK_IPV4.check(value, "ipv4");
  if (family === 6) return LOOPBACK_IPV6.check(value, "ipv6");
  return false;
}

function isLoopbackAddress(address: string) {
  const family = isIP(address);
  if (family === 4) return LOOPBACK_IPV4.check(address, "ipv4");
  if (family === 6) return LOOPBACK_IPV6.check(address, "ipv6");
  return false;
}

export function isPublicGenericTransportAddress(address: string) {
  const family = isIP(address);
  if (family === 4) return !UNSAFE_IPV4.check(address, "ipv4");
  if (family === 6) return !UNSAFE_IPV6.check(address, "ipv6");
  return false;
}

async function defaultResolveHost(hostname: string) {
  const addresses = await dnsLookup(hostname, {
    all: true,
    verbatim: true,
  });
  return addresses.filter(
    (entry): entry is GenericTransportResolvedAddress =>
      entry.family === 4 || entry.family === 6,
  );
}

async function resolvedAddresses(
  hostname: string,
  resolver: NonNullable<HardenedGenericTransportOptions["resolveHost"]>,
) {
  const literalFamily = isIP(hostname);
  let values: readonly GenericTransportResolvedAddress[];
  try {
    values = literalFamily
      ? [{ address: hostname, family: literalFamily as 4 | 6 }]
      : await resolver(hostname);
  } catch {
    throw new HardenedGenericTransportPolicyError(
      "resolution_failed",
      "Model provider host resolution failed.",
    );
  }
  if (values.length === 0) {
    throw new HardenedGenericTransportPolicyError(
      "resolution_failed",
      "Model provider host did not resolve.",
    );
  }
  const unique = new Map<string, GenericTransportResolvedAddress>();
  for (const entry of values) {
    const family = isIP(entry.address);
    if (
      (family !== 4 && family !== 6) ||
      family !== entry.family ||
      entry.address.includes("%")
    ) {
      throw new HardenedGenericTransportPolicyError(
        "address_denied",
        "Model provider resolved to an invalid address.",
      );
    }
    unique.set(`${family}:${entry.address}`, {
      address: entry.address,
      family,
    });
  }
  return [...unique.values()];
}

async function resolvePinnedAddress(
  url: URL,
  options: Required<
    Pick<HardenedGenericTransportOptions, "allowLoopbackHttp" | "resolveHost">
  >,
) {
  const hostname = normalizedHostname(url.hostname);
  const exactLoopback = isExactGenericTransportLoopback(url.hostname);
  if (url.protocol === "http:") {
    if (!options.allowLoopbackHttp || !exactLoopback) {
      throw new HardenedGenericTransportPolicyError(
        "protocol_denied",
        "Generic model providers require public HTTPS.",
      );
    }
  } else if (url.protocol !== "https:") {
    throw new HardenedGenericTransportPolicyError(
      "protocol_denied",
      "Generic model providers require HTTPS.",
    );
  } else if (exactLoopback && !options.allowLoopbackHttp) {
    throw new HardenedGenericTransportPolicyError(
      "address_denied",
      "Loopback model providers require explicit local test enablement.",
    );
  }

  const addresses = await resolvedAddresses(hostname, options.resolveHost);
  if (exactLoopback && options.allowLoopbackHttp) {
    if (addresses.some((entry) => !isLoopbackAddress(entry.address))) {
      throw new HardenedGenericTransportPolicyError(
        "address_denied",
        "Loopback model provider resolution escaped loopback.",
      );
    }
  } else if (
    addresses.some((entry) => !isPublicGenericTransportAddress(entry.address))
  ) {
    // Reject the whole result set. Selecting one public answer from a mixed
    // public/private set would remain vulnerable to rebinding and resolver
    // order changes.
    throw new HardenedGenericTransportPolicyError(
      "address_denied",
      "Model provider host resolved to a non-public address.",
    );
  }
  return addresses[0];
}

function requestBody(init: RequestInit | undefined) {
  const body = init?.body;
  if (body === undefined || body === null) return Buffer.alloc(0);
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  throw new HardenedGenericTransportPolicyError(
    "invalid_request",
    "Generic model provider request body type is unsupported.",
  );
}

function requestHeaders(init: RequestInit | undefined, body: Buffer) {
  const source = new Headers(init?.headers);
  const headers: Record<string, string> = {};
  for (const [rawName, value] of source) {
    const name = rawName.toLowerCase();
    if (!FORBIDDEN_OUTBOUND_HEADERS.has(name)) headers[name] = value;
  }
  if (body.byteLength > 0) headers["content-length"] = String(body.byteLength);
  return headers;
}

function responseHeaders(source: IncomingHttpHeaders) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(source)) {
    if (typeof value === "string") headers.set(name, value);
    else if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    }
  }
  return headers;
}

function safeAbortError() {
  const error = new Error("Model provider request was cancelled.");
  error.name = "AbortError";
  return error;
}

export function pinnedGenericRequestOptions(
  url: URL,
  resolved: GenericTransportResolvedAddress,
  method: "GET" | "POST",
  headers: Record<string, string>,
): RequestOptions & {
  rejectUnauthorized?: boolean;
  servername?: string;
} {
  const originalHostname = normalizedHostname(url.hostname);
  return {
    protocol: url.protocol,
    hostname: resolved.address,
    family: resolved.family,
    port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
    path: `${url.pathname}${url.search}`,
    method,
    headers: {
      ...headers,
      host: url.host,
    },
    // Disable connection pooling so each call's freshly validated DNS result
    // is also the address used to open that call's socket.
    agent: false,
    ...(url.protocol === "https:"
      ? {
          rejectUnauthorized: true,
          servername: isIP(originalHostname) ? undefined : originalHostname,
        }
      : {}),
  };
}

function responseBodyStream(
  response: http.IncomingMessage,
  signal: AbortSignal | null,
) {
  let finished = false;
  let cleanup = () => undefined;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      cleanup = () => {
        signal?.removeEventListener("abort", onAbort);
        response.off("data", onData);
        response.off("end", onEnd);
        response.off("error", onError);
      };
      const complete = (operation: () => void) => {
        if (finished) return;
        finished = true;
        cleanup();
        operation();
      };
      const onData = (chunk: Buffer) => {
        if (finished) return;
        controller.enqueue(Buffer.from(chunk));
        if ((controller.desiredSize ?? 1) <= 0) response.pause();
      };
      const onEnd = () => complete(() => controller.close());
      const onError = (error: Error) =>
        complete(() =>
          controller.error(
            signal?.aborted || error.name === "AbortError"
              ? safeAbortError()
              : new HardenedGenericTransportPolicyError(
                  "network_failed",
                  "Model provider response stream failed.",
                ),
          ),
        );
      const onAbort = () => {
        complete(() => controller.error(safeAbortError()));
        response.destroy(safeAbortError());
      };
      response.on("data", onData);
      response.once("end", onEnd);
      response.once("error", onError);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    },
    pull() {
      response.resume();
    },
    cancel() {
      finished = true;
      cleanup();
      response.destroy();
    },
  });
}

function dispatchPinnedRequest(
  url: URL,
  resolved: GenericTransportResolvedAddress,
  init: RequestInit | undefined,
): Promise<Response> {
  const method = String(init?.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "POST") {
    throw new HardenedGenericTransportPolicyError(
      "invalid_request",
      "Generic model provider request method is unsupported.",
    );
  }
  const body = requestBody(init);
  if (method === "GET" && body.byteLength > 0) {
    throw new HardenedGenericTransportPolicyError(
      "invalid_request",
      "Generic model provider GET requests cannot include a body.",
    );
  }
  const headers = requestHeaders(init, body);
  const options = pinnedGenericRequestOptions(url, resolved, method, headers);
  const signal = init?.signal ?? null;

  return new Promise((resolve, reject) => {
    let settled = false;
    const client = url.protocol === "https:" ? https : http;
    const request = client.request(options, (response) => {
      const status = response.statusCode ?? 0;
      if (status < 200 || status > 599) {
        response.resume();
        request.destroy();
        if (!settled) {
          settled = true;
          reject(
            new HardenedGenericTransportPolicyError(
              "network_failed",
              "Model provider returned an invalid HTTP response.",
            ),
          );
        }
        return;
      }
      const noBody = status === 204 || status === 205 || status === 304;
      const stream = noBody ? null : responseBodyStream(response, signal);
      if (noBody) response.resume();
      settled = true;
      resolve(
        new Response(stream, {
          status,
          headers: responseHeaders(response.headers),
        }),
      );
    });
    const abort = () => {
      const error = safeAbortError();
      if (!settled) {
        settled = true;
        reject(error);
      }
      request.destroy(error);
    };
    signal?.addEventListener("abort", abort, { once: true });
    request.once("close", () => signal?.removeEventListener("abort", abort));
    request.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(
        error instanceof Error && error.name === "AbortError"
          ? safeAbortError()
          : new HardenedGenericTransportPolicyError(
              "network_failed",
              "Model provider network request failed.",
            ),
      );
    });
    if (signal?.aborted) {
      abort();
      return;
    }
    request.end(body.byteLength > 0 ? body : undefined);
  });
}

function requestUrl(input: string | URL | Request) {
  if (typeof input !== "string" && !(input instanceof URL)) {
    throw new HardenedGenericTransportPolicyError(
      "invalid_request",
      "Generic model provider transport requires an explicit URL.",
    );
  }
  let url: URL;
  try {
    url = input instanceof URL ? new URL(input.toString()) : new URL(input);
  } catch {
    throw new HardenedGenericTransportPolicyError(
      "invalid_request",
      "Generic model provider request URL is invalid.",
    );
  }
  if (url.username || url.password || url.hash) {
    throw new HardenedGenericTransportPolicyError(
      "invalid_request",
      "Generic model provider request URL is not permitted.",
    );
  }
  return url;
}

/**
 * Fetch-compatible transport for generic OpenAI endpoints. It resolves and
 * validates every DNS answer on every request, then connects to the selected
 * address directly while preserving the original Host, TLS SNI and certificate
 * identity. It never follows redirects or consults ambient proxy settings.
 */
export function createHardenedGenericTransport(
  options: HardenedGenericTransportOptions = {},
): HardenedGenericTransport {
  const policy = {
    allowLoopbackHttp: options.allowLoopbackHttp ?? false,
    resolveHost: options.resolveHost ?? defaultResolveHost,
  };
  const fetchImpl = (async (input, init) => {
    if (init?.redirect !== undefined && init.redirect !== "manual") {
      throw new HardenedGenericTransportPolicyError(
        "redirect_mode_denied",
        "Generic model provider redirects are disabled.",
      );
    }
    const url = requestUrl(input);
    const resolved = await resolvePinnedAddress(url, policy);
    return dispatchPinnedRequest(url, resolved, init);
  }) as typeof fetch;
  return {
    attestation: "dns-pinned-and-revalidated-v1",
    fetchImpl,
  };
}
