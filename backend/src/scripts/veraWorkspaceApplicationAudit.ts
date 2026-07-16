import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { resolve } from "node:path";
import { Router, type Express } from "express";

import type { MikeWorkflowWire } from "../lib/workspace/workflowCompatibility";
import { WorkspaceApiError } from "../lib/workspace/errors";
import type { WorkspaceWorkflowsV1Port } from "../routes/workspaceWorkflowsV1";
import type { WorkspaceChatsV1Port } from "../routes/workspaceChatsV1";
import type { WorkspaceTabularV1RuntimePort } from "../routes/workspaceTabularV1";
import {
  bootstrapVeraApplication,
  createVeraApplication,
  resolveVeraBindConfiguration,
  VeraStartupError,
  type VeraBootstrapDependencies,
  type VeraListeningServer,
  type VeraWorkspaceRuntime,
} from "../veraApplication";

type EventLog = string[];

function fakeWorkflowCrud(): WorkspaceWorkflowsV1Port {
  const system: MikeWorkflowWire = {
    id: "builtin-audit-template",
    user_id: null,
    metadata: {
      title: "固定内置模板",
      description: null,
      type: "assistant" as const,
      contributors: [],
      language: "English",
      version: "e32daad",
      practice: "General Transactions",
      jurisdictions: ["General"],
    },
    skill_md: "Summarize the selected documents.",
    columns_config: null,
    is_system: true,
    created_at: "",
    shared_by_name: null,
    allow_edit: false,
    is_owner: false,
    open_source_submission: null,
  };
  const workflows: MikeWorkflowWire[] = [system];
  const hidden = new Set<string>();
  let nextId = 1;
  const find = (id: string) => {
    const workflow = workflows.find((candidate) => candidate.id === id);
    if (!workflow) throw new Error("Workflow not found.");
    return workflow;
  };
  return {
    async list(_context, input) {
      return input.type
        ? workflows.filter((workflow) => workflow.metadata.type === input.type)
        : workflows;
    },
    async get(_context, workflowId) {
      return find(workflowId);
    },
    async create(_context, input) {
      const workflow = {
        id: `custom-audit-${nextId++}`,
        user_id: "00000000-0000-4000-8000-000000000001",
        metadata: {
          title: input.title,
          description: null,
          type: input.type,
          contributors: [],
          language: input.language,
          version: null,
          practice: input.practice,
          jurisdictions: input.jurisdictions,
        },
        skill_md:
          input.type === "assistant" ? input.skillMarkdown || null : null,
        columns_config:
          input.type === "tabular"
            ? input.columns.map((column, index) => ({
                index,
                name: column.title,
                prompt: column.prompt,
              }))
            : null,
        is_system: false,
        created_at: "2026-07-14T00:00:00.000Z",
        shared_by_name: null,
        allow_edit: true,
        is_owner: true,
        open_source_submission: null,
      };
      workflows.push(workflow);
      return workflow;
    },
    async update(_context, workflowId) {
      const workflow = find(workflowId);
      if (workflow.is_system) {
        throw new WorkspaceApiError(
          403,
          "FORBIDDEN",
          "System workflows are immutable; hide them instead.",
        );
      }
      return workflow;
    },
    async delete(_context, workflowId) {
      const index = workflows.findIndex(
        (workflow) => workflow.id === workflowId,
      );
      if (index < 0) throw new Error("Workflow not found.");
      if (workflows[index]?.is_system) {
        throw new WorkspaceApiError(
          403,
          "FORBIDDEN",
          "System workflows cannot be deleted; hide them instead.",
        );
      }
      workflows.splice(index, 1);
      hidden.delete(workflowId);
    },
    async listHidden() {
      return [...hidden];
    },
    async hide(_context, workflowId) {
      find(workflowId);
      hidden.add(workflowId);
    },
    async unhide(_context, workflowId) {
      find(workflowId);
      hidden.delete(workflowId);
    },
  };
}

function fakeChats(): WorkspaceChatsV1Port {
  const now = "2026-07-14T00:00:00.000Z";
  const chat = (
    id: string,
    projectId: string | null = null,
    title = "Audit chat",
    modelProfileId: string | null = null,
  ) => ({
    id,
    projectId,
    scope: projectId === null ? ("global" as const) : ("project" as const),
    title,
    status: "active" as const,
    modelProfileId,
    createdAt: now,
    updatedAt: now,
  });
  return {
    async listChats() {
      return { items: [], nextCursor: null };
    },
    async listProjectChats() {
      return [];
    },
    async createChat(_context, input) {
      return chat(
        "00000000-0000-4000-8000-000000000090",
        input.projectId,
        input.title,
        input.modelProfileId,
      );
    },
    async getChatDetail(_context, chatId) {
      return { chat: chat(chatId), messages: [] };
    },
    async updateChat(_context, chatId, input) {
      return chat(chatId, null, input.title);
    },
    async deleteChat() {},
  };
}

function fakeTabular(): WorkspaceTabularV1RuntimePort {
  return {
    async listTabularReviews() {
      return [];
    },
    async createTabularReview() {
      return { id: "00000000-0000-4000-8000-000000000091" };
    },
    async getTabularReview(_context, reviewId) {
      return { id: reviewId };
    },
    async updateTabularReview(_context, reviewId) {
      return { id: reviewId };
    },
    async deleteTabularReview() {},
    async clearTabularCells() {},
    async cancelTabularCell() {
      return { cancelled: true };
    },
    async exportTabularReview(_context, _reviewId, format) {
      return {
        filename: format === "csv" ? "review.csv" : "review.xlsx",
        contentType:
          format === "csv"
            ? "text/csv; charset=utf-8"
            : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        body: format === "csv" ? "column\r\n" : new Uint8Array([80, 75, 3, 4]),
      };
    },
  };
}

function fakeRuntime(
  options: {
    events?: EventLog;
    startError?: Error;
    health?: ReturnType<VeraWorkspaceRuntime["health"]>;
    onListProjects?: () => void;
    matterProfiles?: VeraWorkspaceRuntime["matterProfiles"];
  } = {},
): VeraWorkspaceRuntime {
  const base = {
    async start() {
      options.events?.push("runtime.start");
      if (options.startError) throw options.startError;
    },
    async stop() {
      options.events?.push("runtime.stop");
    },
    health() {
      return (
        options.health ?? {
          started: true,
          draining: false,
          worker: {
            documentParse: true,
            assistantGenerate: false,
            tabularCell: false,
          },
        }
      );
    },
    assistantGenerationAvailable() {
      return false;
    },
    tabularGenerationAvailable() {
      return false;
    },
    chats: fakeChats(),
    tabular: fakeTabular(),
    async listProjects() {
      options.onListProjects?.();
      return { items: [], nextCursor: null };
    },
    modelSettings: new Proxy(
      {},
      {
        get(_target, property) {
          return async () => {
            throw new Error(
              `Unexpected fake model settings call: ${String(property)}`,
            );
          };
        },
      },
    ),
    workflowCrud: fakeWorkflowCrud(),
    ...(options.matterProfiles
      ? { matterProfiles: options.matterProfiles }
      : {}),
  };
  return new Proxy(base, {
    get(target, property, receiver) {
      if (Reflect.has(target, property)) {
        return Reflect.get(target, property, receiver);
      }
      return async () => {
        throw new Error(`Unexpected fake runtime call: ${String(property)}`);
      };
    },
  }) as unknown as VeraWorkspaceRuntime;
}

function fakeServer(
  events: EventLog,
  options: { hangOnClose?: boolean } = {},
): VeraListeningServer {
  const server = {
    listening: true,
    close(callback?: (error?: Error) => void) {
      events.push("server.close");
      if (!options.hangOnClose) callback?.();
      return server;
    },
    closeAllConnections() {
      events.push("server.closeAllConnections");
    },
    address() {
      return { address: "127.0.0.1", family: "IPv4", port: 43210 };
    },
  };
  return server as unknown as VeraListeningServer;
}

function fakeDependencies(
  events: EventLog,
  options: {
    runtime?: VeraWorkspaceRuntime;
    server?: VeraListeningServer;
    listenError?: Error;
    authFailure?: boolean;
    demo?: () => Promise<unknown>;
  } = {},
): VeraBootstrapDependencies {
  const runtime = options.runtime ?? fakeRuntime({ events });
  const server = options.server ?? fakeServer(events);
  return {
    assertCompliancePolicy() {
      events.push("compliance");
    },
    assertEncryptionPolicy() {
      events.push("encryption");
    },
    resolveAuthConfiguration() {
      events.push("auth.preflight");
      return options.authFailure
        ? {
            ok: false as const,
            status: 500 as const,
            code: "INTERNAL_ERROR" as const,
            message: "sensitive auth configuration detail",
          }
        : { kind: "single_user_dev" as const };
    },
    startAuditAnchor() {
      events.push("audit.start");
      return {
        close: () => {
          events.push("audit.close");
        },
      };
    },
    auditAnchorStatus() {
      return {
        enabled: true,
        healthy: true,
        protection_active: true,
        key_id: "must-not-leak",
        last_error: "/private/database/path",
      };
    },
    auditWriteBlocked() {
      return false;
    },
    createRuntime() {
      events.push("runtime.create");
      return runtime;
    },
    configureDurableRuntime() {
      events.push("durable.start");
      return {
        close: () => {
          events.push("durable.close");
        },
      };
    },
    async closeLocalModelRuntime() {
      events.push("model.close");
    },
    async closeLocalVoiceRuntime() {
      events.push("voice.close");
    },
    runDemoSeed:
      options.demo ??
      (async () => {
        events.push("demo.seed");
      }),
    listen(_app, port, host) {
      events.push(`listen:${host}:${port}`);
      return {
        server,
        ready: options.listenError
          ? Promise.reject(options.listenError)
          : Promise.resolve(),
      };
    },
  };
}

async function withHttpServer(
  app: Express,
  callback: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = await new Promise<Server>((resolveListening, reject) => {
    const listening = app.listen(0, "127.0.0.1", () =>
      resolveListening(listening),
    );
    listening.once("error", reject);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  try {
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolveClose, reject) => {
      server.close((error) => (error ? reject(error) : resolveClose()));
    });
  }
}

function testEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    ALETHEIA_AUTH_MODE: "single_user",
    VERA_WORKSPACE_ALLOW_SINGLE_USER_DEV: "true",
    RATE_LIMIT_GENERAL_MAX: "1000",
    TRUST_PROXY_HOPS: "0",
    FRONTEND_URL: "http://127.0.0.1:3000",
    ...overrides,
  };
}

function assertWorkspaceNoStore(response: Response) {
  assert.match(response.headers.get("cache-control") ?? "", /private/);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  assert.equal(response.headers.get("pragma"), "no-cache");
  assert.equal(response.headers.get("expires"), "0");
}

function assertWorkspaceNoStoreAbsent(response: Response) {
  assert.doesNotMatch(
    response.headers.get("cache-control") ?? "",
    /(?:private|no-store)/,
  );
  assert.notEqual(response.headers.get("pragma"), "no-cache");
  assert.notEqual(response.headers.get("expires"), "0");
}

async function auditApplicationSurface(): Promise<void> {
  let listProjectCalls = 0;
  let disabledLegacyFactoryCalls = 0;
  const runtime = fakeRuntime({
    onListProjects: () => {
      listProjectCalls += 1;
    },
  });
  const app = createVeraApplication({
    runtime,
    env: testEnvironment(),
    auditAnchorStatus: () => ({
      enabled: true,
      healthy: true,
      protection_active: true,
      key_id: "secret-key-id",
      last_error: "/Users/private/workspace.db",
      token: "secret-token",
    }),
    legacyRouterFactory: () => {
      disabledLegacyFactoryCalls += 1;
      throw new Error("disabled Legacy router factory must not run");
    },
  });

  await withHttpServer(app, async (baseUrl) => {
    const projects = await fetch(`${baseUrl}/api/v1/projects`, {
      headers: { origin: "http://127.0.0.1:3000" },
    });
    assert.equal(projects.status, 200);
    assert.equal(listProjectCalls, 1, "/api/v1 must dispatch exactly once");
    assertWorkspaceNoStore(projects);
    assert.equal(
      projects.headers.get("access-control-allow-origin"),
      "http://127.0.0.1:3000",
    );

    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200);
    assertWorkspaceNoStoreAbsent(health);
    const healthText = await health.text();
    assert(!healthText.includes("secret-key-id"));
    assert(!healthText.includes("workspace.db"));
    assert(!healthText.includes("secret-token"));
    const healthBody = JSON.parse(healthText) as {
      vera: {
        workspace: {
          pump: {
            documentParse: boolean;
            assistantGenerate: boolean;
            tabularCell: boolean;
          };
        };
        matter: { status: string };
        conversation: { status: string };
        legacy: {
          status: string;
          routesEnabled: boolean;
          runtimeEnabled: boolean;
        };
      };
    };
    assert.equal(healthBody.vera.workspace.pump.documentParse, true);
    assert.equal(healthBody.vera.workspace.pump.assistantGenerate, false);
    assert.equal(healthBody.vera.workspace.pump.tabularCell, false);
    assert.deepEqual(healthBody.vera.matter, { status: "not_configured" });
    assert.deepEqual(healthBody.vera.conversation, {
      status: "not_configured",
    });
    assert.deepEqual(healthBody.vera.legacy, {
      status: "disabled",
      routesEnabled: false,
      runtimeEnabled: false,
    });

    const disabledLegacy = await fetch(`${baseUrl}/aletheia/security-policy`);
    assert.equal(disabledLegacy.status, 404);
    assert.equal(disabledLegacyFactoryCalls, 0);

    const malformed = await fetch(`${baseUrl}/api/v1/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    });
    assert.equal(malformed.status, 400);
    assertWorkspaceNoStore(malformed);
    assert.deepEqual(await malformed.json(), {
      detail: "The request body is not valid JSON.",
      code: "VALIDATION_ERROR",
      error: {
        code: "VALIDATION_ERROR",
        message: "The request body is not valid JSON.",
        retryable: false,
      },
    });
  });

  let matterListCalls = 0;
  let matterCreateCalls = 0;
  const matterRouter = Router();
  matterRouter.get("/matters", (_request, response) => {
    matterListCalls += 1;
    response.json({ items: [], next_cursor: null });
  });
  matterRouter.post("/matters", (_request, response) => {
    matterCreateCalls += 1;
    response.status(201).json({ created: true });
  });
  const matterProfiles = {
    createRouter: () => matterRouter,
    health: () => ({
      status: "ready" as const,
      schemaVersion: 17 as const,
      inferencePolicy: "minimal_unified" as const,
      internalPath: "/private/matter.db",
    }),
  } as NonNullable<VeraWorkspaceRuntime["matterProfiles"]>;
  const matterToken = "m".repeat(64);
  const matterApp = createVeraApplication({
    runtime: fakeRuntime({ matterProfiles }),
    env: testEnvironment({
      ALETHEIA_AUTH_MODE: "private_token",
      ALETHEIA_PRIVATE_AUTH_TOKEN: matterToken,
    }),
    auditAnchorStatus: () => ({ enabled: false, healthy: true }),
  });
  await withHttpServer(matterApp, async (baseUrl) => {
    const unauthenticated = await fetch(`${baseUrl}/api/v1/matters`);
    assert.equal(unauthenticated.status, 401);
    assert.equal(matterListCalls, 0, "Matter router must run after auth");
    const list = await fetch(`${baseUrl}/api/v1/matters`, {
      headers: { authorization: `Bearer ${matterToken}` },
    });
    assert.equal(list.status, 200);
    assert.equal(matterListCalls, 1, "Matter route must dispatch exactly once");
    assertWorkspaceNoStore(list);
    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200);
    const payload = (await health.json()) as {
      vera: { matter: Record<string, unknown> };
    };
    assert.deepEqual(payload.vera.matter, {
      status: "ready",
      schemaVersion: 17,
      inferencePolicy: "minimal_unified",
    });
  });

  const blockedMatterApp = createVeraApplication({
    runtime: fakeRuntime({ matterProfiles }),
    env: testEnvironment(),
    auditAnchorStatus: () => ({ enabled: true, healthy: false }),
    auditWriteBlocked: () => true,
  });
  await withHttpServer(blockedMatterApp, async (baseUrl) => {
    const blocked = await fetch(`${baseUrl}/api/v1/matters`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(blocked.status, 503);
    assert.equal(matterCreateCalls, 0, "audit guard must precede Matter routes");
    const readable = await fetch(`${baseUrl}/api/v1/matters`);
    assert.equal(readable.status, 200);
    assert.equal(matterListCalls, 2);
  });

  const unavailableMatterApp = createVeraApplication({
    runtime: fakeRuntime({
      matterProfiles: {
        createRouter: () => matterRouter,
        health: () => {
          throw new Error("/private/matter.db secret");
        },
      } as NonNullable<VeraWorkspaceRuntime["matterProfiles"]>,
    }),
    env: testEnvironment(),
    auditAnchorStatus: () => ({ enabled: false, healthy: true }),
  });
  await withHttpServer(unavailableMatterApp, async (baseUrl) => {
    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 503);
    const text = await health.text();
    assert(!text.includes("matter.db"));
    assert(!text.includes("secret"));
    assert.equal(
      (JSON.parse(text) as { vera: { matter: { status: string } } }).vera
        .matter.status,
      "unavailable",
    );
  });

  let enabledLegacyFactoryCalls = 0;
  const legacyProbeRouter = Router();
  legacyProbeRouter.get("/enabled-probe", (_request, response) => {
    response.json({ enabled: true });
  });
  legacyProbeRouter.post("/guard-audit", (_request, response) => {
    response.status(204).end();
  });
  const enabledLegacyApp = createVeraApplication({
    runtime: fakeRuntime(),
    env: testEnvironment({
      VERA_ENABLE_LEGACY_ROUTES: "true",
      VERA_ENABLE_LEGACY_RUNTIME: "true",
    }),
    auditAnchorStatus: () => ({ enabled: false, healthy: true }),
    legacyRuntimeConfigured: () => true,
    legacyRouterFactory: () => {
      enabledLegacyFactoryCalls += 1;
      return [legacyProbeRouter];
    },
  });
  assert.equal(enabledLegacyFactoryCalls, 1);
  await withHttpServer(enabledLegacyApp, async (baseUrl) => {
    const probe = await fetch(`${baseUrl}/aletheia/enabled-probe`);
    assert.equal(probe.status, 200);
    assert.deepEqual(await probe.json(), { enabled: true });
    const health = (await (await fetch(`${baseUrl}/health`)).json()) as {
      vera: {
        legacy: {
          status: string;
          routesEnabled: boolean;
          runtimeEnabled: boolean;
        };
      };
    };
    assert.deepEqual(health.vera.legacy, {
      status: "configured",
      routesEnabled: true,
      runtimeEnabled: true,
    });
  });

  let inexactLegacyFactoryCalls = 0;
  const inexactLegacyApp = createVeraApplication({
    runtime: fakeRuntime(),
    env: testEnvironment({ VERA_ENABLE_LEGACY_ROUTES: "TRUE" }),
    auditAnchorStatus: () => ({ enabled: false, healthy: true }),
    legacyRouterFactory: () => {
      inexactLegacyFactoryCalls += 1;
      return [Router()];
    },
  });
  await withHttpServer(inexactLegacyApp, async (baseUrl) => {
    assert.equal(
      (await fetch(`${baseUrl}/aletheia/enabled-probe`)).status,
      404,
    );
  });
  assert.equal(inexactLegacyFactoryCalls, 0);

  const workflowToken = "vera-workflow-http-audit-token-0123456789";
  const workflowApp = createVeraApplication({
    runtime: fakeRuntime(),
    env: testEnvironment({
      ALETHEIA_AUTH_MODE: "private_token",
      ALETHEIA_PRIVATE_AUTH_TOKEN: workflowToken,
    }),
    auditAnchorStatus: () => ({ enabled: false, healthy: true }),
  });
  await withHttpServer(workflowApp, async (baseUrl) => {
    const workflowsUrl = `${baseUrl}/api/v1/workflows`;
    const tabularUrl = `${baseUrl}/api/v1/tabular-review`;
    for (const authorization of [undefined, "Bearer wrong-workflow-token"]) {
      for (const url of [workflowsUrl, tabularUrl]) {
        const response = await fetch(url, {
          headers: authorization ? { authorization } : undefined,
        });
        assert.equal(
          response.status,
          401,
          "workspace capability routes require a valid token",
        );
        assertWorkspaceNoStore(response);
      }
    }
    const headers = {
      authorization: `Bearer ${workflowToken}`,
      "content-type": "application/json",
    };
    const list = await fetch(workflowsUrl, { headers });
    assert.equal(list.status, 200);
    const system = (await list.json()) as Array<{
      id: string;
      is_system: boolean;
    }>;
    assert.equal(system.length, 1);
    assert.equal(system[0]?.is_system, true);
    const systemId = system[0]?.id;
    assert.ok(systemId);

    const create = await fetch(workflowsUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        metadata: { title: "HTTP custom workflow", type: "assistant" },
        skill_md: "Summarize selected documents.",
      }),
    });
    assert.equal(create.status, 201);
    const custom = (await create.json()) as { id: string };
    assert.ok(custom.id);
    const update = await fetch(`${workflowsUrl}/${custom.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ skill_md: "Revise the summary." }),
    });
    assert.equal(update.status, 200);
    const hide = await fetch(`${workflowsUrl}/hidden`, {
      method: "POST",
      headers,
      body: JSON.stringify({ workflow_id: systemId }),
    });
    assert.equal(hide.status, 204);
    const hidden = await fetch(`${workflowsUrl}/hidden`, { headers });
    assert.deepEqual(await hidden.json(), [systemId]);
    const immutable = await fetch(`${workflowsUrl}/${systemId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ skill_md: "not allowed" }),
    });
    assert.equal(immutable.status, 403);
    const remove = await fetch(`${workflowsUrl}/${custom.id}`, {
      method: "DELETE",
      headers,
    });
    assert.equal(remove.status, 204);

    const dormantProjectId = "00000000-0000-4000-8000-000000000001";
    const dormantChatId = "00000000-0000-4000-8000-000000000002";
    const routeExpectations = [
      { method: "GET", path: "/api/v1/chat", status: 200 },
      { method: "POST", path: "/api/v1/chat/create", status: 201 },
      {
        method: "GET",
        path: `/api/v1/projects/${dormantProjectId}/chats`,
        status: 200,
      },
      { method: "GET", path: `/api/v1/chat/${dormantChatId}`, status: 200 },
      {
        method: "PATCH",
        path: `/api/v1/chat/${dormantChatId}`,
        body: { title: "Dormant chat" },
        status: 204,
      },
      {
        method: "DELETE",
        path: `/api/v1/chat/${dormantChatId}`,
        status: 204,
      },
      { method: "POST", path: "/api/v1/chat", status: 404 },
      {
        method: "POST",
        path: `/api/v1/projects/${dormantProjectId}/chat`,
        status: 404,
      },
      {
        method: "POST",
        path: `/api/v1/workflows/${systemId}/runs`,
        body: { idempotency_key: "application-audit-workflow-run" },
        status: 503,
      },
      { method: "GET", path: "/api/v1/tabular-review", status: 200 },
      { method: "POST", path: "/api/v1/tabular-review", status: 201 },
      {
        method: "GET",
        path: "/api/v1/tabular-review/capabilities",
        status: 200,
      },
      {
        method: "POST",
        path: "/api/v1/tabular-review/00000000-0000-4000-8000-000000000091/generate",
        status: 404,
      },
      { method: "GET", path: "/api/v1/models", status: 404 },
      { method: "POST", path: "/api/v1/models", status: 404 },
      { method: "GET", path: "/api/v1/providers", status: 404 },
      { method: "POST", path: "/api/v1/credentials", status: 404 },
    ] as const;
    for (const route of routeExpectations) {
      const response = await fetch(`${baseUrl}${route.path}`, {
        method: route.method,
        headers,
        ...(route.method === "GET" || route.method === "DELETE"
          ? {}
          : {
              body: JSON.stringify("body" in route ? route.body : {}),
            }),
      });
      assert.equal(
        response.status,
        route.status,
        `${route.method} ${route.path} matches composed capabilities`,
      );
      assertWorkspaceNoStore(response);
    }
  });

  const blockedWorkflowApp = createVeraApplication({
    runtime: fakeRuntime(),
    env: testEnvironment({
      ALETHEIA_AUTH_MODE: "private_token",
      ALETHEIA_PRIVATE_AUTH_TOKEN: workflowToken,
    }),
    auditAnchorStatus: () => ({ enabled: true, healthy: false }),
    auditWriteBlocked: () => true,
  });
  await withHttpServer(blockedWorkflowApp, async (baseUrl) => {
    for (const pathName of ["/api/v1/workflows", "/api/v1/tabular-review"]) {
      const url = `${baseUrl}${pathName}`;
      const unauthenticated = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(
        unauthenticated.status,
        401,
        "authentication runs before the mutation audit guard",
      );
      assertWorkspaceNoStore(unauthenticated);
      const blocked = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${workflowToken}`,
          "content-type": "application/json",
        },
        body: "{}",
      });
      assert.equal(blocked.status, 503);
      assertWorkspaceNoStore(blocked);
    }
  });

  const blockedApp = createVeraApplication({
    runtime,
    env: testEnvironment(),
    auditAnchorStatus: () => ({ enabled: true, healthy: false }),
    auditWriteBlocked: () => true,
  });
  await withHttpServer(blockedApp, async (baseUrl) => {
    for (const path of ["/api/v1/projects"]) {
      const response = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(response.status, 503, `${path} mutation must fail closed`);
      const body = (await response.json()) as {
        detail: string;
        code: string;
        error: { code: string; message: string; retryable: boolean };
      };
      assert.equal(body.code, "INTERNAL_ERROR");
      assert.equal(body.detail, body.error.message);
      assert.equal(body.error.retryable, false);
    }
    const read = await fetch(`${baseUrl}/api/v1/projects`);
    assert.equal(read.status, 200, "read-only requests remain available");
    const disabledLegacyMutation = await fetch(
      `${baseUrl}/aletheia/guard-audit`,
      { method: "POST" },
    );
    assert.equal(
      disabledLegacyMutation.status,
      404,
      "disabled Legacy routes are absent rather than guarded handlers",
    );
    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 503);
  });

  const blockedLegacyRouter = Router();
  blockedLegacyRouter.get("/guard-audit", (_request, response) => {
    response.status(200).json({ readable: true });
  });
  blockedLegacyRouter.post("/guard-audit", (_request, response) => {
    response.status(204).end();
  });
  const blockedLegacyApp = createVeraApplication({
    runtime,
    env: testEnvironment({
      VERA_ENABLE_LEGACY_ROUTES: "true",
      VERA_ENABLE_LEGACY_RUNTIME: "true",
    }),
    auditAnchorStatus: () => ({ enabled: true, healthy: false }),
    auditWriteBlocked: () => true,
    legacyRuntimeConfigured: () => true,
    legacyRouterFactory: () => [blockedLegacyRouter],
  });
  await withHttpServer(blockedLegacyApp, async (baseUrl) => {
    const blocked = await fetch(`${baseUrl}/aletheia/guard-audit`, {
      method: "POST",
    });
    assert.equal(blocked.status, 503);
    const read = await fetch(`${baseUrl}/aletheia/guard-audit`);
    assert.equal(read.status, 200);
  });

  const drainingApp = createVeraApplication({
    runtime,
    env: testEnvironment(),
    auditAnchorStatus: () => ({ enabled: false, healthy: true }),
    isDraining: () => true,
  });
  await withHttpServer(drainingApp, async (baseUrl) => {
    const request = await fetch(`${baseUrl}/api/v1/projects`);
    assert.equal(request.status, 503);
    assertWorkspaceNoStore(request);
    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 503);
    assertWorkspaceNoStoreAbsent(health);
    const body = (await health.json()) as {
      vera: { workspace: { draining: boolean } };
    };
    assert.equal(body.vera.workspace.draining, true);
  });

  const invalidAuthApp = createVeraApplication({
    runtime: fakeRuntime(),
    env: testEnvironment({
      ALETHEIA_AUTH_MODE: "private_token",
      ALETHEIA_PRIVATE_AUTH_TOKEN: "short",
    }),
    auditAnchorStatus: () => ({ enabled: false, healthy: true }),
  });
  await withHttpServer(invalidAuthApp, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/projects`);
    assert.equal(response.status, 500);
    assertWorkspaceNoStore(response);
  });

  const rateLimitedApp = createVeraApplication({
    runtime: fakeRuntime(),
    env: testEnvironment({ RATE_LIMIT_GENERAL_MAX: "1" }),
    auditAnchorStatus: () => ({ enabled: false, healthy: true }),
  });
  await withHttpServer(rateLimitedApp, async (baseUrl) => {
    const first = await fetch(`${baseUrl}/api/v1/projects`);
    assert.equal(first.status, 200);
    assertWorkspaceNoStore(first);
    const limited = await fetch(`${baseUrl}/api/v1/projects`);
    assert.equal(limited.status, 429);
    assertWorkspaceNoStore(limited);
  });

  const preflightApp = createVeraApplication({
    runtime: fakeRuntime(),
    env: testEnvironment(),
    auditAnchorStatus: () => ({ enabled: false, healthy: true }),
  });
  await withHttpServer(preflightApp, async (baseUrl) => {
    const preflight = await fetch(`${baseUrl}/api/v1/projects`, {
      method: "OPTIONS",
      headers: {
        origin: "http://127.0.0.1:3000",
        "access-control-request-method": "GET",
      },
    });
    assert.equal(preflight.status, 204);
    assertWorkspaceNoStore(preflight);
    const prefixBypass = await fetch(`${baseUrl}/api/v1evil`);
    assert.equal(prefixBypass.status, 404);
    assertWorkspaceNoStoreAbsent(prefixBypass);
  });

  const id = "00000000-0000-4000-8000-000000000001";
  for (const uploadPath of [
    `/api/v1/documents`,
    `/api/v1/single-documents`,
    `/api/v1/documents/${id}/versions`,
    `/api/v1/projects/${id}/documents`,
    `/api/v1/projects/${id}/documents/${id}/versions`,
  ]) {
    const uploadLimitedApp = createVeraApplication({
      runtime,
      env: testEnvironment({ RATE_LIMIT_UPLOAD_MAX: "1" }),
      auditAnchorStatus: () => ({ enabled: false, healthy: true }),
    });
    await withHttpServer(uploadLimitedApp, async (baseUrl) => {
      const uploadUrl = `${baseUrl}${uploadPath}`;
      const first = await fetch(uploadUrl, { method: "POST" });
      assert.notEqual(first.status, 429);
      const second = await fetch(uploadUrl, { method: "POST" });
      assert.equal(second.status, 429, uploadPath);
      const body = (await second.json()) as { code: string };
      assert.equal(body.code, "RATE_LIMITED");
    });
  }

  assert.throws(
    () =>
      createVeraApplication({
        runtime,
        env: testEnvironment({ TRUST_PROXY_HOPS: "1" }),
      }),
    /TRUST_PROXY_HOPS must be 0/,
  );
}

async function auditBootstrapFailures(): Promise<void> {
  const authEvents: EventLog = [];
  await assert.rejects(
    bootstrapVeraApplication({
      env: testEnvironment(),
      dependencies: fakeDependencies(authEvents, { authFailure: true }),
    }),
    (error: unknown) =>
      error instanceof VeraStartupError &&
      !error.message.includes("sensitive auth configuration detail"),
  );
  assert.deepEqual(authEvents, ["compliance", "encryption", "auth.preflight"]);
  assert(!authEvents.some((event) => event.startsWith("listen:")));

  for (const hostOverride of [
    { HOST: "0.0.0.0" },
    { ALETHEIA_BACKEND_HOST: "::1" },
    { ALETHEIA_BACKEND_HOST: "127.0.0.1", HOST: "localhost" },
  ]) {
    const hostEvents: EventLog = [];
    await assert.rejects(
      bootstrapVeraApplication({
        env: testEnvironment(hostOverride),
        dependencies: fakeDependencies(hostEvents),
      }),
      VeraStartupError,
    );
    assert.equal(hostEvents.length, 0);
  }
  for (const invalidPort of ["NaN", "1.5", "-1", "65536", "0"]) {
    assert.throws(
      () =>
        resolveVeraBindConfiguration(testEnvironment({ PORT: invalidPort })),
      VeraStartupError,
    );
  }
  assert.deepEqual(
    resolveVeraBindConfiguration(testEnvironment(), {
      port: 0,
      allowPortZero: true,
    }),
    { host: "127.0.0.1", port: 0 },
  );
  assert.equal(
    resolveVeraBindConfiguration(testEnvironment({ PORT: "65535" })).port,
    65_535,
  );
  const proxyEvents: EventLog = [];
  await assert.rejects(
    bootstrapVeraApplication({
      env: testEnvironment({ TRUST_PROXY_HOPS: "1" }),
      dependencies: fakeDependencies(proxyEvents),
    }),
    /TRUST_PROXY_HOPS must be 0/,
  );
  assert.equal(proxyEvents.length, 0);

  const runtimeEvents: EventLog = [];
  const failedRuntime = fakeRuntime({
    events: runtimeEvents,
    startError: new Error("/private/workspace.db failed"),
  });
  await assert.rejects(
    bootstrapVeraApplication({
      env: testEnvironment(),
      dependencies: fakeDependencies(runtimeEvents, {
        runtime: failedRuntime,
      }),
    }),
  );
  assert.deepEqual(runtimeEvents, [
    "compliance",
    "encryption",
    "auth.preflight",
    "audit.start",
    "runtime.create",
    "runtime.start",
    "runtime.stop",
    "audit.close",
  ]);
  assert(!runtimeEvents.some((event) => event.startsWith("listen:")));

  const listenEvents: EventLog = [];
  await assert.rejects(
    bootstrapVeraApplication({
      env: testEnvironment(),
      dependencies: fakeDependencies(listenEvents, {
        listenError: new Error("EADDRINUSE /private/path"),
      }),
    }),
  );
  assert.deepEqual(listenEvents.slice(-3), [
    "server.close",
    "runtime.stop",
    "audit.close",
  ]);
  assert(!listenEvents.includes("durable.start"));
  assert(!listenEvents.includes("model.close"));
  assert(!listenEvents.includes("voice.close"));
}

async function auditShutdownAndDemo(): Promise<void> {
  const events: EventLog = [];
  const server = fakeServer(events, { hangOnClose: true });
  const application = await bootstrapVeraApplication({
    env: testEnvironment(),
    closeTimeoutMs: 10,
    dependencies: fakeDependencies(events, { server }),
  });
  assert.deepEqual(events.slice(0, 7), [
    "compliance",
    "encryption",
    "auth.preflight",
    "audit.start",
    "runtime.create",
    "runtime.start",
    "listen:127.0.0.1:3001",
  ]);
  assert(!events.includes("demo.seed"), "demo seed must be off by default");
  assert(!events.includes("durable.start"));

  const firstShutdown = application.shutdown();
  const secondShutdown = application.shutdown();
  assert.strictEqual(firstShutdown, secondShutdown, "shutdown is idempotent");
  await firstShutdown;
  assert.deepEqual(events.slice(-4), [
    "server.close",
    "server.closeAllConnections",
    "runtime.stop",
    "audit.close",
  ]);
  assert(!events.includes("model.close"));
  assert(!events.includes("voice.close"));

  const legacyEvents: EventLog = [];
  const legacyApplication = await bootstrapVeraApplication({
    env: testEnvironment({ VERA_ENABLE_LEGACY_RUNTIME: "true" }),
    dependencies: fakeDependencies(legacyEvents),
  });
  assert.deepEqual(legacyEvents.slice(0, 8), [
    "compliance",
    "encryption",
    "auth.preflight",
    "audit.start",
    "runtime.create",
    "runtime.start",
    "durable.start",
    "listen:127.0.0.1:3001",
  ]);
  await legacyApplication.shutdown();
  assert.deepEqual(legacyEvents.slice(-6), [
    "server.close",
    "runtime.stop",
    "durable.close",
    "model.close",
    "voice.close",
    "audit.close",
  ]);

  const gatedDemoEvents: EventLog = [];
  const gatedDemoApplication = await bootstrapVeraApplication({
    env: testEnvironment({ ALETHEIA_ENABLE_DEMO_SEED: "true" }),
    dependencies: fakeDependencies(gatedDemoEvents),
  });
  assert(!gatedDemoEvents.includes("demo.seed"));
  assert(!gatedDemoEvents.includes("durable.start"));
  await gatedDemoApplication.shutdown();

  const demoEvents: EventLog = [];
  const demoApplication = await bootstrapVeraApplication({
    env: testEnvironment({
      VERA_ENABLE_LEGACY_RUNTIME: "true",
      ALETHEIA_ENABLE_DEMO_SEED: "true",
    }),
    dependencies: fakeDependencies(demoEvents),
  });
  assert(demoEvents.includes("demo.seed"));
  assert(
    demoEvents.indexOf("demo.seed") <
      demoEvents.findIndex((event) => event.startsWith("listen:")),
    "explicit demo seeding must finish before listen",
  );
  await demoApplication.shutdown();

  const failedDemoEvents: EventLog = [];
  await assert.rejects(
    bootstrapVeraApplication({
      env: testEnvironment({
        VERA_ENABLE_LEGACY_RUNTIME: "true",
        ALETHEIA_ENABLE_DEMO_SEED: "true",
      }),
      dependencies: fakeDependencies(failedDemoEvents, {
        demo: async () => {
          failedDemoEvents.push("demo.seed");
          throw new Error("/private/demo-seed.db");
        },
      }),
    }),
  );
  assert(!failedDemoEvents.some((event) => event.startsWith("listen:")));
  assert.deepEqual(failedDemoEvents.slice(-5), [
    "runtime.stop",
    "durable.close",
    "model.close",
    "voice.close",
    "audit.close",
  ]);

  const productionEvents: EventLog = [];
  const productionApplication = await bootstrapVeraApplication({
    env: testEnvironment({
      NODE_ENV: "production",
      VERA_ENABLE_LEGACY_RUNTIME: "true",
      ALETHEIA_ENABLE_DEMO_SEED: "true",
    }),
    dependencies: fakeDependencies(productionEvents),
  });
  assert(!productionEvents.includes("demo.seed"));
  await productionApplication.shutdown();
}

async function auditStaticOwnership(): Promise<void> {
  const sourceRoot = resolve(__dirname, "..");
  const applicationSource = readFileSync(
    resolve(sourceRoot, "veraApplication.ts"),
    "utf8",
  );
  const indexSource = readFileSync(resolve(sourceRoot, "index.ts"), "utf8");

  assert(!/process\.(?:on|once)\s*\(/.test(applicationSource));
  assert(!applicationSource.includes("createWorkspaceRuntime()"));
  assert.equal((indexSource.match(/process\.once\(/g) ?? []).length, 2);
  assert(indexSource.includes('process.once("SIGINT"'));
  assert(indexSource.includes('process.once("SIGTERM"'));
  assert(indexSource.includes("if (require.main === module)"));
  assert(!indexSource.includes("Aletheia backend"));
  assert.equal(
    (applicationSource.match(/createWorkspaceV1Router\(/g) ?? []).length,
    1,
    "Workspace router must be constructed exactly once",
  );
  assert.equal(
    (applicationSource.match(/app\.use\(\s*"\/api\/v1"/g) ?? []).length,
    1,
    "Workspace API prefix must be mounted exactly once",
  );
  const workspaceNoStoreIndex = applicationSource.indexOf(
    "if (workspaceRouteAllowed(request))",
  );
  assert.notEqual(workspaceNoStoreIndex, -1);
  for (const terminatingBoundary of [
    "app.use(generalLimiter)",
    "express.json({ limit:",
    "workspaceApi.use(createWorkspaceAuthMiddleware(env))",
  ]) {
    const boundaryIndex = applicationSource.indexOf(terminatingBoundary);
    assert.notEqual(boundaryIndex, -1);
    assert.ok(
      workspaceNoStoreIndex < boundaryIndex,
      `Workspace no-store policy must precede ${terminatingBoundary}`,
    );
  }
  assert.match(
    applicationSource,
    /workspaceApi\.use\(createWorkspaceAuthMiddleware\(env\)\);[\s\S]*?workspaceApi\.use\(mutationGuard\);/,
    "workspace authentication must run before mutation audit protection",
  );
  assert.match(
    applicationSource,
    /workspaceApi\.use\(\s*"\/workflows",\s*createWorkspaceWorkflowsV1Router\(options\.runtime\.workflowCrud\),/,
    "Mike workflow CRUD is mounted beneath the sole /api/v1 composition root",
  );
  assert.equal(
    (applicationSource.match(/createWorkspaceTabularV1Router\(/g) ?? []).length,
    1,
    "Mike tabular runtime must be mounted exactly once",
  );
  assert.match(
    applicationSource,
    /createWorkspaceTabularV1Router\(options\.runtime\.tabular,[\s\S]*?generation:\s*options\.runtime\.tabularGenerationAvailable\(\),[\s\S]*?chat:\s*false/,
    "Mike tabular uses the real generation gate and keeps chat disabled",
  );
  const healthSource = applicationSource.slice(
    applicationSource.indexOf('app.get("/health"'),
    applicationSource.indexOf("app.use(safeApplicationErrorHandler"),
  );
  assert.equal((healthSource.match(/\btry\s*\{/g) ?? []).length, 1);
  assert.equal((healthSource.match(/\bcatch\s*\{/g) ?? []).length, 1);

  const signalCountsBefore = {
    sigint: process.listenerCount("SIGINT"),
    sigterm: process.listenerCount("SIGTERM"),
  };
  await import("../index");
  assert.deepEqual(
    {
      sigint: process.listenerCount("SIGINT"),
      sigterm: process.listenerCount("SIGTERM"),
    },
    signalCountsBefore,
    "importing the process entry point must not register signals or bootstrap",
  );
  assert(
    applicationSource.includes(
      'return env.VERA_ENABLE_LEGACY_ROUTES === "true";',
    ),
  );
  assert(
    applicationSource.includes(
      'return env.VERA_ENABLE_LEGACY_RUNTIME === "true";',
    ),
  );
  assert.match(
    applicationSource,
    /if \(legacyRoutesAreEnabled\) \{[\s\S]*?app\.use\("\/aletheia", mutationGuard\);[\s\S]*?options\.legacyRouterFactory \?\? loadLegacyRouters/,
    "Legacy limiters and routers are mounted only inside the explicit route gate",
  );
  assert.match(
    applicationSource,
    /if \(legacyRuntimeIsEnabled\) \{[\s\S]*?dependencies\.configureDurableRuntime\(\);/,
    "Legacy runtime configuration is behind the explicit runtime gate",
  );
  assert(
    applicationSource.includes(
      "if (legacyRuntimeIsEnabled && demoSeedEnabled(env))",
    ),
  );

  const staticImports = applicationSource.slice(
    0,
    applicationSource.indexOf("const LOOPBACK_HOST"),
  );
  const lazyLegacyModules = [
    "./routes/aletheia",
    "./routes/legalResearch",
    "./routes/legalResearchIssues",
    "./routes/legalOpinions",
    "./routes/litigation",
    "./routes/durableAgentRuns",
    "./routes/localGovernance",
    "./routes/localModels",
    "./routes/localVoice",
    "./routes/aletheiaLocalControl",
    "./lib/aletheia/durableAgentRuntime",
    "./lib/aletheia/localModelRuntime",
    "./lib/aletheia/localVoiceRuntime",
    "./lib/aletheia/demoSeed",
  ] as const;
  for (const modulePath of lazyLegacyModules) {
    assert(
      !staticImports.includes(modulePath),
      `Legacy module must not be statically imported: ${modulePath}`,
    );
    assert(
      applicationSource.includes(`require(\"${modulePath}\")`),
      `Legacy module must be loaded through a fixed lazy require: ${modulePath}`,
    );
  }
}

async function main(): Promise<void> {
  await auditApplicationSurface();
  await auditBootstrapFailures();
  await auditShutdownAndDemo();
  await auditStaticOwnership();
  console.log("Vera workspace application audit passed.");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
