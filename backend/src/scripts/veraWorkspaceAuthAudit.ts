import { strict as assert } from "node:assert";
import type { NextFunction, Request, Response } from "express";

import {
  WORKSPACE_API_ROUTE_PREFIX,
  WORKSPACE_AUTH_KIND,
  WORKSPACE_LOCAL_PRINCIPAL_ID,
  authenticateWorkspaceRequest,
  constantTimeTokenEqual,
  createWorkspaceAuthMiddleware,
  parseWorkspaceBearerToken,
  resolveWorkspaceAuthConfiguration,
} from "../middleware/workspaceAuth";

const VALID_TOKEN = "vera-workspace-bootstrap-token-0123456789";

type FakeResponse = Response & {
  statusCode: number;
  body: unknown | null;
  locals: Record<string, unknown>;
};

function fakeRequest(
  overrides: Partial<Request> & {
    authorization?: string | string[];
    rawHeaders?: string[];
  } = {},
): Request {
  return {
    originalUrl: overrides.originalUrl ?? `${WORKSPACE_API_ROUTE_PREFIX}/projects`,
    headers: {
      authorization: overrides.authorization,
    },
    rawHeaders: overrides.rawHeaders ?? [],
    query: overrides.query ?? {},
    cookies: (overrides as Request & { cookies?: Record<string, string> }).cookies ?? {},
    body: overrides.body ?? {},
  } as unknown as Request;
}

function fakeResponse(): FakeResponse {
  const response = {
    statusCode: 200,
    body: null as unknown | null,
    locals: {},
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return response as unknown as FakeResponse;
}

function invokeMiddleware(
  middleware: ReturnType<typeof createWorkspaceAuthMiddleware>,
  request: Request,
) {
  const response = fakeResponse();
  let nextCalled = false;
  const next: NextFunction = () => {
    nextCalled = true;
  };
  middleware(request, response, next);
  return { response, nextCalled };
}

function assertNoSecret(value: unknown, secret: string) {
  assert.equal(JSON.stringify(value).includes(secret), false);
}

function assertConfigurationAndConstantTimeHelpers() {
  assert.equal(constantTimeTokenEqual(VALID_TOKEN, VALID_TOKEN), true);
  assert.equal(constantTimeTokenEqual(VALID_TOKEN, `${VALID_TOKEN}-wrong`), false);
  assert.doesNotThrow(() =>
    constantTimeTokenEqual("short", "a-token-with-different-length"),
  );

  const defaultConfiguration = resolveWorkspaceAuthConfiguration({
    ALETHEIA_PRIVATE_AUTH_TOKEN: VALID_TOKEN,
  });
  assert.equal("kind" in defaultConfiguration && defaultConfiguration.kind, "private_token");

  const devSingleUser = resolveWorkspaceAuthConfiguration({
    ALETHEIA_AUTH_MODE: "single_user",
    NODE_ENV: "development",
    VERA_WORKSPACE_ALLOW_SINGLE_USER_DEV: "true",
  });
  assert.equal("kind" in devSingleUser && devSingleUser.kind, "single_user_dev");

  const deniedSingleUser = resolveWorkspaceAuthConfiguration({
    ALETHEIA_AUTH_MODE: "single_user",
    NODE_ENV: "development",
  });
  assert.equal("ok" in deniedSingleUser && deniedSingleUser.ok, false);

  const productionSingleUser = resolveWorkspaceAuthConfiguration({
    ALETHEIA_AUTH_MODE: "single_user",
    NODE_ENV: "production",
    VERA_WORKSPACE_ALLOW_SINGLE_USER_DEV: "true",
  });
  assert.equal("ok" in productionSingleUser && productionSingleUser.ok, false);
}

function assertBearerParsingAndFailures() {
  const parsed = parseWorkspaceBearerToken(
    fakeRequest({ authorization: `Bearer ${VALID_TOKEN}` }),
  );
  assert.deepEqual(parsed, { ok: true, token: VALID_TOKEN });

  for (const request of [
    fakeRequest(),
    fakeRequest({ authorization: "Basic abc123" }),
    fakeRequest({ authorization: "Bearer " }),
    fakeRequest({ authorization: "Bearer token with spaces" }),
    fakeRequest({ authorization: `Bearer ${VALID_TOKEN},extra` }),
    fakeRequest({
      rawHeaders: [
        "Authorization",
        `Bearer ${VALID_TOKEN}`,
        "Authorization",
        "Bearer another-token-0123456789012345678901234",
      ],
    }),
  ]) {
    const result = parseWorkspaceBearerToken(request);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 401);
      assertNoSecret(result, VALID_TOKEN);
    }
  }
}

function assertAuthenticationHelper() {
  const config = resolveWorkspaceAuthConfiguration({
    ALETHEIA_PRIVATE_AUTH_TOKEN: VALID_TOKEN,
  });
  assert.equal("kind" in config, true);
  if (!("kind" in config)) throw new Error("missing config");

  const ok = authenticateWorkspaceRequest(
    fakeRequest({ authorization: `Bearer ${VALID_TOKEN}` }),
    config,
  );
  assert.deepEqual(ok, { ok: true, authKind: WORKSPACE_AUTH_KIND });

  const wrongToken = authenticateWorkspaceRequest(
    fakeRequest({ authorization: "Bearer wrong-token-01234567890123456789012345" }),
    config,
  );
  assert.equal(wrongToken.ok, false);
  if (!wrongToken.ok) assert.equal(wrongToken.status, 401);

  const outsideRoute = authenticateWorkspaceRequest(
    fakeRequest({
      originalUrl: "/aletheia/matters",
      authorization: `Bearer ${VALID_TOKEN}`,
    }),
    config,
  );
  assert.equal(outsideRoute.ok, false);
  if (!outsideRoute.ok) assert.equal(outsideRoute.status, 404);

  const evilPrefix = authenticateWorkspaceRequest(
    fakeRequest({
      originalUrl: "/api/v1evil",
      authorization: `Bearer ${VALID_TOKEN}`,
    }),
    config,
  );
  assert.equal(evilPrefix.ok, false);
  if (!evilPrefix.ok) assert.equal(evilPrefix.status, 404);

  const versionTen = authenticateWorkspaceRequest(
    fakeRequest({
      originalUrl: "/api/v10/projects",
      authorization: `Bearer ${VALID_TOKEN}`,
    }),
    config,
  );
  assert.equal(versionTen.ok, false);
  if (!versionTen.ok) assert.equal(versionTen.status, 404);

  const queryPath = authenticateWorkspaceRequest(
    fakeRequest({
      originalUrl: "/api/v1/projects?x=1",
      authorization: `Bearer ${VALID_TOKEN}`,
    }),
    config,
  );
  assert.deepEqual(queryPath, { ok: true, authKind: WORKSPACE_AUTH_KIND });
}

function assertMiddlewarePrivateTokenMode() {
  const middleware = createWorkspaceAuthMiddleware({
    ALETHEIA_AUTH_MODE: "private_token",
    ALETHEIA_PRIVATE_AUTH_TOKEN: VALID_TOKEN,
  });
  const success = invokeMiddleware(
    middleware,
    fakeRequest({ authorization: `Bearer ${VALID_TOKEN}` }),
  );
  assert.equal(success.nextCalled, true);
  assert.equal(success.response.statusCode, 200);
  assert.equal(success.response.locals.userId, WORKSPACE_LOCAL_PRINCIPAL_ID);
  assert.equal(success.response.locals.authKind, WORKSPACE_AUTH_KIND);
  assertNoSecret(success.response.locals, VALID_TOKEN);

  for (const request of [
    fakeRequest(),
    fakeRequest({ authorization: "Basic abc123" }),
    fakeRequest({ authorization: "Bearer " }),
    fakeRequest({ authorization: "Bearer wrong-token-01234567890123456789012345" }),
    fakeRequest({
      query: { token: VALID_TOKEN },
      cookies: { token: VALID_TOKEN },
      body: { token: VALID_TOKEN },
    }),
  ]) {
    const result = invokeMiddleware(middleware, request);
    assert.equal(result.nextCalled, false);
    assert.equal(result.response.statusCode, 401);
    assertNoSecret(result.response.body, VALID_TOKEN);
  }
}

function assertMiddlewareConfigurationFailures() {
  const shortToken = invokeMiddleware(
    createWorkspaceAuthMiddleware({
      ALETHEIA_AUTH_MODE: "private_token",
      ALETHEIA_PRIVATE_AUTH_TOKEN: "short-token",
    }),
    fakeRequest({ authorization: `Bearer ${VALID_TOKEN}` }),
  );
  assert.equal(shortToken.nextCalled, false);
  assert.equal(shortToken.response.statusCode, 500);
  assertNoSecret(shortToken.response.body, "short-token");

  const missingToken = invokeMiddleware(
    createWorkspaceAuthMiddleware({
      ALETHEIA_AUTH_MODE: "private_token",
    }),
    fakeRequest({ authorization: `Bearer ${VALID_TOKEN}` }),
  );
  assert.equal(missingToken.response.statusCode, 500);

  const unsupportedMode = invokeMiddleware(
    createWorkspaceAuthMiddleware({
      ALETHEIA_AUTH_MODE: "unexpected_mode",
      ALETHEIA_PRIVATE_AUTH_TOKEN: VALID_TOKEN,
    }),
    fakeRequest({ authorization: `Bearer ${VALID_TOKEN}` }),
  );
  assert.equal(unsupportedMode.response.statusCode, 500);
}

function assertSingleUserDevGate() {
  const allowed = invokeMiddleware(
    createWorkspaceAuthMiddleware({
      ALETHEIA_AUTH_MODE: "single_user",
      NODE_ENV: "development",
      VERA_WORKSPACE_ALLOW_SINGLE_USER_DEV: "true",
    }),
    fakeRequest(),
  );
  assert.equal(allowed.nextCalled, true);
  assert.equal(allowed.response.locals.authKind, WORKSPACE_AUTH_KIND);

  const deniedWithoutFlag = invokeMiddleware(
    createWorkspaceAuthMiddleware({
      ALETHEIA_AUTH_MODE: "single_user",
      NODE_ENV: "development",
    }),
    fakeRequest(),
  );
  assert.equal(deniedWithoutFlag.nextCalled, false);
  assert.equal(deniedWithoutFlag.response.statusCode, 500);

  const deniedInProduction = invokeMiddleware(
    createWorkspaceAuthMiddleware({
      ALETHEIA_AUTH_MODE: "single_user",
      NODE_ENV: "production",
      VERA_WORKSPACE_ALLOW_SINGLE_USER_DEV: "true",
    }),
    fakeRequest(),
  );
  assert.equal(deniedInProduction.nextCalled, false);
  assert.equal(deniedInProduction.response.statusCode, 500);
}

function assertRouteBoundaryAndSerialization() {
  const middleware = createWorkspaceAuthMiddleware({
    ALETHEIA_PRIVATE_AUTH_TOKEN: VALID_TOKEN,
  });
  const outside = invokeMiddleware(
    middleware,
    fakeRequest({
      originalUrl: "/health",
      authorization: `Bearer ${VALID_TOKEN}`,
    }),
  );
  assert.equal(outside.nextCalled, false);
  assert.equal(outside.response.statusCode, 404);
  assertNoSecret(outside.response.body, VALID_TOKEN);

  const evilPrefix = invokeMiddleware(
    middleware,
    fakeRequest({
      originalUrl: "/api/v1evil",
      authorization: `Bearer ${VALID_TOKEN}`,
    }),
  );
  assert.equal(evilPrefix.nextCalled, false);
  assert.equal(evilPrefix.response.statusCode, 404);

  const versionTen = invokeMiddleware(
    middleware,
    fakeRequest({
      originalUrl: "/api/v10/projects",
      authorization: `Bearer ${VALID_TOKEN}`,
    }),
  );
  assert.equal(versionTen.nextCalled, false);
  assert.equal(versionTen.response.statusCode, 404);

  const queryAllowed = invokeMiddleware(
    middleware,
    fakeRequest({
      originalUrl: "/api/v1/projects?x=1",
      authorization: `Bearer ${VALID_TOKEN}`,
    }),
  );
  assert.equal(queryAllowed.nextCalled, true);
  assert.equal(queryAllowed.response.statusCode, 200);
}

assertConfigurationAndConstantTimeHelpers();
assertBearerParsingAndFailures();
assertAuthenticationHelper();
assertMiddlewarePrivateTokenMode();
assertMiddlewareConfigurationFailures();
assertSingleUserDevGate();
assertRouteBoundaryAndSerialization();

console.log(
  JSON.stringify(
    {
      ok: true,
      suite: "vera-workspace-auth-v1",
      checks: [
        "private token bearer authentication and local principal assignment",
        "missing malformed wrong and duplicate authorization rejection",
        "query cookie and body token bypass rejection",
        "route boundary rejection outside /api/v1",
        "single_user dev-only explicit allow gate and production prohibition",
        "short or missing bootstrap token fails closed",
        "responses and locals do not serialize bootstrap secrets",
      ],
    },
    null,
    2,
  ),
);
