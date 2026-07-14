import { timingSafeEqual } from "node:crypto";
import type { Request, RequestHandler, Response } from "express";

export const WORKSPACE_API_ROUTE_PREFIX = "/api/v1";
export const WORKSPACE_LOCAL_PRINCIPAL_ID = "workspace-local";
export const WORKSPACE_LOCAL_PRINCIPAL_EMAIL =
  "workspace-local@vera.internal";
export const WORKSPACE_AUTH_KIND = "workspace_bootstrap";
const MINIMUM_BOOTSTRAP_TOKEN_LENGTH = 32;

type WorkspaceAuthFailureCode =
  | "workspace_route_outside_api"
  | "workspace_auth_unauthorized"
  | "workspace_auth_unavailable";

type WorkspaceAuthResponse = {
  error: {
    code: WorkspaceAuthFailureCode;
    message: string;
  };
};

export interface WorkspaceAuthRequestLike {
  originalUrl?: string;
  headers?: {
    authorization?: string | string[] | undefined;
  };
  rawHeaders?: string[];
}

export interface WorkspaceAuthEnvironment {
  ALETHEIA_AUTH_MODE?: string | undefined;
  ALET_HEIA_AUTH_MODE?: string | undefined;
  ALETHEIA_PRIVATE_AUTH_TOKEN?: string | undefined;
  NODE_ENV?: string | undefined;
  VERA_WORKSPACE_ALLOW_SINGLE_USER_DEV?: string | undefined;
}

export type WorkspaceAuthConfiguration =
  | {
      kind: "private_token";
      expectedToken: string;
    }
  | {
      kind: "single_user_dev";
    };

type WorkspaceAuthFailure = {
  ok: false;
  status: 401 | 404 | 500;
  code: WorkspaceAuthFailureCode;
  message: string;
};

type WorkspaceBearerTokenResult =
  | { ok: true; token: string }
  | WorkspaceAuthFailure;

export type WorkspaceAuthResult =
  | { ok: true; authKind: typeof WORKSPACE_AUTH_KIND }
  | WorkspaceAuthFailure;

function authFailure(
  status: 401 | 404 | 500,
  code: WorkspaceAuthFailureCode,
  message: string,
): WorkspaceAuthFailure {
  return { ok: false, status, code, message };
}

function normalizedAuthMode(
  env: WorkspaceAuthEnvironment,
): "private_token" | "single_user" | "invalid" {
  const value =
    env.ALETHEIA_AUTH_MODE?.trim() ?? env.ALET_HEIA_AUTH_MODE?.trim() ?? "";
  if (value === "" || value === "private_token") return "private_token";
  if (value === "single_user") return "single_user";
  return "invalid";
}

export function workspaceRouteAllowed(request: WorkspaceAuthRequestLike): boolean {
  if (typeof request.originalUrl !== "string") return false;
  const path = request.originalUrl.split("?", 1)[0] ?? "";
  return (
    path === WORKSPACE_API_ROUTE_PREFIX ||
    path.startsWith(`${WORKSPACE_API_ROUTE_PREFIX}/`)
  );
}

export function constantTimeTokenEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  const targetLength = Math.max(leftBuffer.length, rightBuffer.length, 1);
  const normalizedLeft = Buffer.alloc(targetLength);
  const normalizedRight = Buffer.alloc(targetLength);
  leftBuffer.copy(normalizedLeft);
  rightBuffer.copy(normalizedRight);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(normalizedLeft, normalizedRight)
  );
}

function authorizationHeaderValues(
  request: WorkspaceAuthRequestLike,
): string[] {
  const rawHeaders = Array.isArray(request.rawHeaders) ? request.rawHeaders : [];
  const values: string[] = [];
  for (let index = 0; index < rawHeaders.length - 1; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === "authorization") {
      values.push(String(rawHeaders[index + 1] ?? ""));
    }
  }
  if (values.length > 0) return values;
  const header = request.headers?.authorization;
  if (Array.isArray(header)) return header.map((value) => String(value));
  return typeof header === "string" ? [header] : [];
}

export function parseWorkspaceBearerToken(
  request: WorkspaceAuthRequestLike,
): WorkspaceBearerTokenResult {
  const values = authorizationHeaderValues(request);
  if (values.length === 0) {
    return authFailure(
      401,
      "workspace_auth_unauthorized",
      "Workspace API authentication failed.",
    );
  }
  if (values.length !== 1) {
    return authFailure(
      401,
      "workspace_auth_unauthorized",
      "Workspace API authentication failed.",
    );
  }
  const header = values[0];
  if (
    header.trim() !== header ||
    header.includes("\n") ||
    header.includes("\r") ||
    !header.startsWith("Bearer ")
  ) {
    return authFailure(
      401,
      "workspace_auth_unauthorized",
      "Workspace API authentication failed.",
    );
  }
  const token = header.slice("Bearer ".length);
  if (
    token === "" ||
    token.trim() !== token ||
    /\s/.test(token) ||
    token.includes(",")
  ) {
    return authFailure(
      401,
      "workspace_auth_unauthorized",
      "Workspace API authentication failed.",
    );
  }
  return { ok: true, token };
}

export function resolveWorkspaceAuthConfiguration(
  env: WorkspaceAuthEnvironment = process.env,
): WorkspaceAuthConfiguration | WorkspaceAuthFailure {
  const mode = normalizedAuthMode(env);
  if (mode === "invalid") {
    return authFailure(
      500,
      "workspace_auth_unavailable",
      "Workspace API authentication is not configured.",
    );
  }
  if (mode === "single_user") {
    if (env.NODE_ENV === "production") {
      return authFailure(
        500,
        "workspace_auth_unavailable",
        "Workspace API authentication is not configured.",
      );
    }
    if (env.VERA_WORKSPACE_ALLOW_SINGLE_USER_DEV !== "true") {
      return authFailure(
        500,
        "workspace_auth_unavailable",
        "Workspace API authentication is not configured.",
      );
    }
    return { kind: "single_user_dev" };
  }
  const expectedToken = env.ALETHEIA_PRIVATE_AUTH_TOKEN?.trim() ?? "";
  if (expectedToken.length < MINIMUM_BOOTSTRAP_TOKEN_LENGTH) {
    return authFailure(
      500,
      "workspace_auth_unavailable",
      "Workspace API authentication is not configured.",
    );
  }
  return { kind: "private_token", expectedToken };
}

export function authenticateWorkspaceRequest(
  request: WorkspaceAuthRequestLike,
  config: WorkspaceAuthConfiguration,
): WorkspaceAuthResult {
  if (!workspaceRouteAllowed(request)) {
    return authFailure(
      404,
      "workspace_route_outside_api",
      "Route is outside the Workspace API.",
    );
  }
  if (config.kind === "single_user_dev") {
    return { ok: true, authKind: WORKSPACE_AUTH_KIND };
  }
  const token = parseWorkspaceBearerToken(request);
  if (!token.ok) return token;
  if (!constantTimeTokenEqual(token.token, config.expectedToken)) {
    return authFailure(
      401,
      "workspace_auth_unauthorized",
      "Workspace API authentication failed.",
    );
  }
  return { ok: true, authKind: WORKSPACE_AUTH_KIND };
}

function writeWorkspaceAuthFailure(
  res: Response,
  failure: WorkspaceAuthFailure,
): void {
  const body: WorkspaceAuthResponse = {
    error: {
      code: failure.code,
      message: failure.message,
    },
  };
  res.status(failure.status).json(body);
}

function setWorkspaceLocalPrincipal(res: Response): void {
  res.locals.userId = WORKSPACE_LOCAL_PRINCIPAL_ID;
  res.locals.userEmail = WORKSPACE_LOCAL_PRINCIPAL_EMAIL;
  res.locals.authKind = WORKSPACE_AUTH_KIND;
  res.locals.workspacePrincipal = {
    id: WORKSPACE_LOCAL_PRINCIPAL_ID,
    email: WORKSPACE_LOCAL_PRINCIPAL_EMAIL,
    kind: "local_single_user",
  };
}

export function createWorkspaceAuthMiddleware(
  env: WorkspaceAuthEnvironment = process.env,
): RequestHandler {
  return function workspaceAuth(req, res, next): void {
    const configuration = resolveWorkspaceAuthConfiguration(env);
    if ("ok" in configuration) {
      writeWorkspaceAuthFailure(res, configuration);
      return;
    }
    const authentication = authenticateWorkspaceRequest(req, configuration);
    if (!authentication.ok) {
      writeWorkspaceAuthFailure(res, authentication);
      return;
    }
    setWorkspaceLocalPrincipal(res);
    next();
  };
}

export const requireWorkspaceAuth = createWorkspaceAuthMiddleware();
