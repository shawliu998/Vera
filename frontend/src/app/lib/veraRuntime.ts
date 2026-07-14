const VERA_API_PATH = "/api/v1" as const;
const DEFAULT_VERA_API_BASE = `http://127.0.0.1:3001${VERA_API_PATH}`;
const CONFIGURED_VERA_API_BASE =
  process.env.NEXT_PUBLIC_VERA_API_BASE_URL ?? DEFAULT_VERA_API_BASE;

type VeraDesktopBridge = Pick<
  NonNullable<Window["aletheiaDesktop"]>,
  "getInfo" | "getAuthToken"
>;

export type VeraQueryValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly (string | number | boolean)[];

export type VeraQuery = Readonly<Record<string, VeraQueryValue>>;

export class VeraRuntimeConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VeraRuntimeConfigurationError";
  }
}

let desktopApiBasePromise: Promise<string> | null = null;
let desktopAuthTokenPromise: Promise<string> | null = null;

function desktopBridge(): VeraDesktopBridge | null {
  const candidate =
    typeof window === "undefined" ? undefined : window.aletheiaDesktop;
  if (candidate === undefined) return null;
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    !("getInfo" in candidate) ||
    typeof candidate.getInfo !== "function" ||
    !("getAuthToken" in candidate) ||
    typeof candidate.getAuthToken !== "function"
  ) {
    throw new VeraRuntimeConfigurationError(
      "The Vera desktop bridge is incomplete.",
    );
  }
  return candidate as VeraDesktopBridge;
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}

export function normalizeVeraApiBase(value: string): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length > 2048
  ) {
    throw new VeraRuntimeConfigurationError("The Vera API base is invalid.");
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new VeraRuntimeConfigurationError("The Vera API base is invalid.");
  }

  const pathname = url.pathname.replace(/\/+$/, "");
  const safeTransport =
    (url.protocol === "http:" || url.protocol === "https:") &&
    isLoopbackHostname(url.hostname);
  if (
    !safeTransport ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    pathname !== VERA_API_PATH
  ) {
    throw new VeraRuntimeConfigurationError("The Vera API base is invalid.");
  }

  return `${url.origin}${VERA_API_PATH}`;
}

export function getConfiguredVeraApiBase(): string {
  return normalizeVeraApiBase(CONFIGURED_VERA_API_BASE);
}

export async function getVeraApiBase(): Promise<string> {
  const bridge = desktopBridge();
  if (!bridge) return getConfiguredVeraApiBase();

  desktopApiBasePromise ??= bridge.getInfo().then((info) => {
    if (
      !info ||
      typeof info !== "object" ||
      typeof info.workspaceApiUrl !== "string"
    ) {
      throw new VeraRuntimeConfigurationError(
        "The Vera desktop runtime information is invalid.",
      );
    }
    return normalizeVeraApiBase(info.workspaceApiUrl);
  });
  const pending = desktopApiBasePromise;
  try {
    return await pending;
  } catch (error) {
    if (desktopApiBasePromise === pending) desktopApiBasePromise = null;
    throw error;
  }
}

function validateToken(token: string): string {
  if (
    typeof token !== "string" ||
    token.length < 32 ||
    token.length > 4096 ||
    token.trim() !== token ||
    /[\s,\u0000-\u001f\u007f]/.test(token)
  ) {
    throw new VeraRuntimeConfigurationError(
      "The Vera desktop authentication token is invalid.",
    );
  }
  return token;
}

/**
 * Returns the desktop bearer header without persisting the token outside this
 * module's in-memory Promise. Browser-only development has no implicit token.
 */
export async function getVeraAuthorizationHeaders(): Promise<
  Record<string, string>
> {
  const bridge = desktopBridge();
  if (!bridge) return {};

  desktopAuthTokenPromise ??= bridge.getAuthToken().then(validateToken);
  const pending = desktopAuthTokenPromise;
  try {
    return { Authorization: `Bearer ${await pending}` };
  } catch (error) {
    if (desktopAuthTokenPromise === pending) desktopAuthTokenPromise = null;
    throw error;
  }
}

function assertVeraApiPath(path: string): void {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.length > 4096 ||
    !path.startsWith("/") ||
    path.startsWith("//") ||
    /[\\?#\u0000-\u001f\u007f]/.test(path) ||
    /%(?:2f|5c)/i.test(path)
  ) {
    throw new VeraRuntimeConfigurationError("The Vera API path is invalid.");
  }

  const segments = path.split("/");
  for (const segment of segments) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new VeraRuntimeConfigurationError("The Vera API path is invalid.");
    }
    if (decoded === "." || decoded === "..") {
      throw new VeraRuntimeConfigurationError("The Vera API path is invalid.");
    }
  }
}

function queryEntries(query: VeraQuery): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  for (const [key, rawValue] of Object.entries(query)) {
    if (
      !/^[A-Za-z][A-Za-z0-9_]*$/.test(key) ||
      /(?:token|auth|authorization|credential|secret|api[_-]?key)/i.test(key)
    ) {
      throw new VeraRuntimeConfigurationError("The Vera API query is invalid.");
    }
    if (rawValue === undefined || rawValue === null) continue;
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const value of values) {
      if (
        (typeof value !== "string" &&
          typeof value !== "number" &&
          typeof value !== "boolean") ||
        (typeof value === "number" && !Number.isFinite(value))
      ) {
        throw new VeraRuntimeConfigurationError(
          "The Vera API query is invalid.",
        );
      }
      entries.push([key, String(value)]);
    }
  }
  return entries;
}

export async function buildVeraApiUrl(
  path: string,
  query: VeraQuery = {},
): Promise<string> {
  assertVeraApiPath(path);
  const url = new URL(`${await getVeraApiBase()}${path}`);
  for (const [key, value] of queryEntries(query)) {
    url.searchParams.append(key, value);
  }
  return url.toString();
}

/** Convert an opaque same-API URL from the wire into a request path. */
export function veraApiPathFromWireUrl(value: string): string {
  if (
    typeof value !== "string" ||
    !value.startsWith(`${VERA_API_PATH}/`) ||
    value.includes("?") ||
    value.includes("#")
  ) {
    throw new VeraRuntimeConfigurationError(
      "The Vera wire download URL is invalid.",
    );
  }
  const path = value.slice(VERA_API_PATH.length);
  assertVeraApiPath(path);
  return path;
}
