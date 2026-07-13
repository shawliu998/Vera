import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  LocalControlError,
  type LocalMcpConnectorRepository,
  type LocalMcpAuthConfig,
} from "./localControlRepository";

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/;
const REQUEST_TIMEOUT_MS = 10_000;

function isLoopbackHostname(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "127.0.0.1" || normalized === "::1";
}

export class LocalMcpNetworkPolicy {
  normalizeForStorage(raw: unknown) {
    if (typeof raw !== "string" || raw.length > 2048) {
      throw new LocalControlError(
        "serverUrl must be a URL of at most 2048 characters.",
        "INVALID_INPUT",
        400,
      );
    }
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new LocalControlError(
        "serverUrl must be a valid URL.",
        "INVALID_INPUT",
        400,
      );
    }
    if (url.username || url.password || url.hash) {
      throw new LocalControlError(
        "MCP URLs cannot contain credentials or fragments.",
        "INVALID_INPUT",
        400,
      );
    }
    if (
      !isLoopbackHostname(url.hostname) ||
      (url.protocol !== "http:" && url.protocol !== "https:")
    ) {
      throw new LocalControlError(
        "MCP is loopback-only and requires an IP-literal 127.0.0.1 or ::1 HTTP(S) URL.",
        "INVALID_INPUT",
        400,
      );
    }
    return url.toString();
  }

  async assertConnectionAllowed(raw: string) {
    return this.normalizeForStorage(raw);
  }
}

export function normalizeMcpAuthConfig(
  raw: unknown,
): LocalMcpAuthConfig | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new LocalControlError(
      "auth must be an object or null.",
      "INVALID_INPUT",
      400,
    );
  }
  const input = raw as Record<string, unknown>;
  const allowed = new Set(["bearerToken", "headers", "oauth"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new LocalControlError(
      "auth contains an unknown field.",
      "INVALID_INPUT",
      400,
    );
  }
  const result: LocalMcpAuthConfig = {};
  if (input.bearerToken !== undefined) {
    if (
      typeof input.bearerToken !== "string" ||
      !input.bearerToken.trim() ||
      input.bearerToken.length > 32_768
    ) {
      throw new LocalControlError(
        "bearerToken must be a non-empty string of at most 32768 characters.",
        "INVALID_INPUT",
        400,
      );
    }
    result.bearerToken = input.bearerToken.trim();
  }
  if (input.headers !== undefined) {
    if (
      !input.headers ||
      typeof input.headers !== "object" ||
      Array.isArray(input.headers)
    ) {
      throw new LocalControlError(
        "headers must be an object.",
        "INVALID_INPUT",
        400,
      );
    }
    const entries = Object.entries(input.headers as Record<string, unknown>);
    if (entries.length > 20) {
      throw new LocalControlError(
        "headers may contain at most 20 entries.",
        "INVALID_INPUT",
        400,
      );
    }
    result.headers = {};
    for (const [name, value] of entries) {
      if (
        !HEADER_NAME.test(name) ||
        name.toLowerCase() === "host" ||
        name.toLowerCase() === "authorization" ||
        typeof value !== "string" ||
        value.length > 4096
      ) {
        throw new LocalControlError(
          `Invalid or reserved MCP header: ${name}`,
          "INVALID_INPUT",
          400,
        );
      }
      result.headers[name] = value;
    }
  }
  if (input.oauth !== undefined) {
    if (
      !input.oauth ||
      typeof input.oauth !== "object" ||
      Array.isArray(input.oauth)
    ) {
      throw new LocalControlError(
        "oauth must be an object.",
        "INVALID_INPUT",
        400,
      );
    }
    const oauth = input.oauth as Record<string, unknown>;
    if (
      Object.keys(oauth).some(
        (key) => !["accessToken", "refreshToken", "clientSecret"].includes(key),
      ) ||
      typeof oauth.accessToken !== "string" ||
      !oauth.accessToken ||
      oauth.accessToken.length > 32_768 ||
      (oauth.refreshToken !== undefined &&
        (typeof oauth.refreshToken !== "string" ||
          oauth.refreshToken.length > 32_768)) ||
      (oauth.clientSecret !== undefined &&
        (typeof oauth.clientSecret !== "string" ||
          oauth.clientSecret.length > 32_768))
    ) {
      throw new LocalControlError(
        "oauth requires a bounded accessToken and optional refreshToken/clientSecret.",
        "INVALID_INPUT",
        400,
      );
    }
    result.oauth = {
      accessToken: oauth.accessToken,
      ...(typeof oauth.refreshToken === "string"
        ? { refreshToken: oauth.refreshToken }
        : {}),
      ...(typeof oauth.clientSecret === "string"
        ? { clientSecret: oauth.clientSecret }
        : {}),
    };
  }
  return result;
}

function requestHeaders(config: LocalMcpAuthConfig) {
  const headers: Record<string, string> = { ...(config.headers ?? {}) };
  const token = config.oauth?.accessToken ?? config.bearerToken;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function redactConnectorSecrets(message: string, config: LocalMcpAuthConfig) {
  const values = [
    config.bearerToken,
    config.oauth?.accessToken,
    config.oauth?.refreshToken,
    config.oauth?.clientSecret,
    ...Object.values(config.headers ?? {}),
  ].filter((value): value is string => Boolean(value));
  return values.reduce(
    (redacted, value) => redacted.split(value).join("[REDACTED]"),
    message,
  );
}

function safeTool(tool: Record<string, unknown>) {
  return {
    name: String(tool.name ?? "").slice(0, 256),
    title: typeof tool.title === "string" ? tool.title.slice(0, 512) : null,
    description:
      typeof tool.description === "string"
        ? tool.description.slice(0, 4000)
        : null,
    inputSchema:
      tool.inputSchema &&
      typeof tool.inputSchema === "object" &&
      !Array.isArray(tool.inputSchema)
        ? tool.inputSchema
        : { type: "object", properties: {} },
    annotations:
      tool.annotations &&
      typeof tool.annotations === "object" &&
      !Array.isArray(tool.annotations)
        ? tool.annotations
        : {},
    enabled: false,
  };
}

export async function refreshLocalMcpConnector(args: {
  repository: LocalMcpConnectorRepository;
  userId: string;
  connectorId: string;
  policy?: LocalMcpNetworkPolicy;
}) {
  const policy = args.policy ?? new LocalMcpNetworkPolicy();
  const connector = args.repository.mcpConnectorForConnection(
    args.userId,
    args.connectorId,
  );
  if (!connector.enabled) {
    throw new LocalControlError(
      "MCP connector is disabled.",
      "INVALID_INPUT",
      409,
    );
  }
  try {
    const serverUrl = await policy.assertConnectionAllowed(connector.serverUrl);
    const guardedFetch: typeof fetch = async (input, init) => {
      const target =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      await policy.assertConnectionAllowed(target);
      return fetch(input, { ...init, redirect: "manual" });
    };
    const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
      fetch: guardedFetch,
      requestInit: {
        headers: requestHeaders(connector.authConfig),
        redirect: "manual",
      },
    });
    const client = new Client(
      { name: "aletheia-local-mcp-client", version: "1.0.0" },
      { capabilities: {}, enforceStrictCapabilities: true },
    );
    try {
      await client.connect(transport, { timeout: REQUEST_TIMEOUT_MS });
      const result = await client.listTools(
        {},
        { timeout: REQUEST_TIMEOUT_MS },
      );
      if (result.tools.length > 256) {
        throw new Error("MCP server returned more than 256 tools.");
      }
      return args.repository.recordMcpRefresh(args.userId, args.connectorId, {
        ok: true,
        tools: result.tools.map((tool) => safeTool(tool)),
      });
    } finally {
      await client.close().catch(() => undefined);
    }
  } catch (error) {
    if (error instanceof LocalControlError) {
      args.repository.recordMcpRefresh(args.userId, args.connectorId, {
        ok: false,
        error: error.message,
      });
      throw error;
    }
    const message = redactConnectorSecrets(
      error instanceof Error ? error.message : String(error),
      connector.authConfig,
    ).slice(0, 1000);
    args.repository.recordMcpRefresh(args.userId, args.connectorId, {
      ok: false,
      error: message,
    });
    throw new LocalControlError(
      `MCP connection failed: ${message}`,
      "CONNECTION_FAILED",
      502,
    );
  }
}
