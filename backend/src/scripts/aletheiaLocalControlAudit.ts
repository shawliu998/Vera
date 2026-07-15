import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import express, { type RequestHandler } from "express";
import {
  getAuthoritativeRuntimeSettings,
  LocalControlRepository,
  resolveAuthoritativeModelRouting,
} from "../lib/aletheia/localControlRepository";
import { LocalMcpNetworkPolicy } from "../lib/aletheia/localMcpConnectorClient";
import { createAletheiaLocalControlRouter } from "../routes/aletheiaLocalControl";
import { selectDurableTaskModel } from "../lib/aletheia/durableAgentRuntime";

type ApiResult = {
  status: number;
  headers: Headers;
  body: any;
};

async function api(
  base: string,
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<ApiResult> {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text ? JSON.parse(text) : null,
  };
}

function assertSecretsAbsent(directory: string, secrets: string[]) {
  for (const name of readdirSync(directory)) {
    if (!name.startsWith("aletheia.db")) continue;
    const contents = readFileSync(path.join(directory, name)).toString("utf8");
    for (const secret of secrets) {
      assert.equal(
        contents.includes(secret),
        false,
        `${secret} must not appear in ${name}`,
      );
    }
  }
}

async function main() {
  const directory = mkdtempSync(
    path.join(os.tmpdir(), "aletheia-local-control-audit-"),
  );
  const databasePath = path.join(directory, "aletheia.db");
  process.env.ALETHEIA_DATA_DIR = directory;
  process.env.ALETHEIA_APPLICATION_ENCRYPTION = "required";
  process.env.ALETHEIA_MASTER_KEY_SOURCE = "env";
  process.env.ALETHEIA_MASTER_KEY_BASE64 = Buffer.alloc(32, 37).toString(
    "base64",
  );
  process.env.ALETHEIA_SEMANTIC_INDEX_ENABLED = "false";
  process.env.ALETHEIA_SEMANTIC_INDEX_DRIVER = "disabled";

  let repo = new LocalControlRepository({ databasePath });
  const auth: RequestHandler = (_req, res, next) => {
    res.locals.userId = "local-control-audit-user";
    res.locals.userEmail = "local-control-audit@aletheia.local";
    next();
  };
  const runtimeModels = () => [
    {
      id: "sol-local",
      state: "ready",
      contextWindowTokens: 32768,
      maxOutputTokens: 4096,
    },
    {
      id: "terra-local",
      state: "ready",
      contextWindowTokens: 8192,
      maxOutputTokens: 1024,
    },
  ];
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(
    "/aletheia",
    createAletheiaLocalControlRouter({
      repository: repo,
      auth,
      runtimeModels,
      mcpNetworkPolicy: new LocalMcpNetworkPolicy(),
    }),
  );
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  let redirectTargetHits = 0;
  const redirectTarget = createServer((_req, res) => {
    redirectTargetHits += 1;
    res.statusCode = 200;
    res.end("unexpected redirect follow");
  });
  await new Promise<void>((resolve) =>
    redirectTarget.listen(0, "127.0.0.1", resolve),
  );
  const targetAddress = redirectTarget.address();
  assert(targetAddress && typeof targetAddress === "object");
  const redirectSource = createServer((_req, res) => {
    res.statusCode = 307;
    res.setHeader(
      "Location",
      `http://127.0.0.1:${targetAddress.port}/redirect-target`,
    );
    res.end();
  });
  await new Promise<void>((resolve) =>
    redirectSource.listen(0, "127.0.0.1", resolve),
  );
  const sourceAddress = redirectSource.address();
  assert(sourceAddress && typeof sourceAddress === "object");

  try {
    const initial = await api(base, "GET", "/aletheia/client-settings");
    assert.equal(initial.status, 200);
    assert.equal(initial.body.schemaVersion, "aletheia-client-settings-v1");
    assert.equal(initial.body.settings.defaultTemplate, "Civil Litigation");
    assert.equal(initial.body.runtimeConfig.fields.demoDataEnabled, undefined);
    assert.equal(
      initial.body.runtimeConfig.fields.reasoning.status,
      "available",
    );
    assert.equal(
      initial.body.runtimeConfig.fields.defaultModel.status,
      "available",
    );
    assert.equal(
      initial.body.runtimeConfig.fields.externalProviderSecrets.status,
      "unsupported",
    );
    assert.equal(
      initial.body.runtimeConfig.fields.matterMemory.status,
      "available",
    );
    assert.equal(
      initial.body.runtimeConfig.fields.auxiliaryModels.status,
      "unavailable",
    );
    assert.equal(
      initial.body.runtimeConfig.fields.contextCompression.status,
      "unavailable",
    );
    const initialEtag = initial.headers.get("etag");
    assert(initialEtag);

    const missingPrecondition = await api(
      base,
      "PATCH",
      "/aletheia/client-settings",
      { theme: "Dark" },
    );
    assert.equal(missingPrecondition.status, 428);

    const updated = await api(
      base,
      "PATCH",
      "/aletheia/client-settings",
      {
        theme: "Dark",
        density: "Compact",
        defaultModel: "sol-local",
        litigationModelId: "sol-local",
        routineModelId: "terra-local",
        contextBudgetTokens: 4096,
      },
      { "If-Match": initialEtag },
    );
    assert.equal(updated.status, 200);
    assert.equal(updated.body.version, 2);
    assert.equal(updated.body.settings.defaultModel, "sol-local");
    assert.equal(updated.body.settings.litigationModelId, "sol-local");
    assert.equal(updated.body.settings.routineModelId, "terra-local");
    assert.deepEqual(updated.body.runtimeConfig.runtime.modelRouting, {
      litigationModelId: "sol-local",
      routineModelId: "terra-local",
    });
    assert.equal(updated.body.runtimeConfig.runtime.contextBudgetTokens, 4096);
    const updatedEtag = updated.headers.get("etag");
    assert(updatedEtag);

    const stale = await api(
      base,
      "PATCH",
      "/aletheia/client-settings",
      { theme: "Light" },
      { "If-Match": initialEtag },
    );
    assert.equal(stale.status, 412);

    const reasoning = await api(
      base,
      "PATCH",
      "/aletheia/client-settings",
      { reasoning: "High", fastMode: true, notifications: false },
      { "If-Match": updatedEtag },
    );
    assert.equal(reasoning.status, 200);
    assert.equal(reasoning.body.settings.reasoning, "High");
    assert.equal(reasoning.body.settings.fastMode, true);
    assert.equal(reasoning.body.settings.notifications, false);
    const reasoningEtag = reasoning.headers.get("etag");
    assert(reasoningEtag);

    const unavailableIndex = await api(
      base,
      "PATCH",
      "/aletheia/client-settings",
      { evidenceIndex: "Semantic" },
      { "If-Match": reasoningEtag },
    );
    assert.equal(unavailableIndex.status, 422);

    const unknown = await api(
      base,
      "PATCH",
      "/aletheia/client-settings",
      { untrustedField: true },
      { "If-Match": reasoningEtag },
    );
    assert.equal(unknown.status, 400);

    const reset = await api(
      base,
      "DELETE",
      "/aletheia/client-settings",
      undefined,
      { "If-Match": reasoningEtag },
    );
    assert.equal(reset.status, 200);
    assert.equal(reset.body.settings.theme, "System");
    assert.equal(reset.body.settings.defaultTemplate, "Civil Litigation");
    const resetEtag = reset.headers.get("etag");
    assert(resetEtag);
    const restoredForPersistence = await api(
      base,
      "PATCH",
      "/aletheia/client-settings",
      {
        theme: "Dark",
        density: "Compact",
        defaultModel: "sol-local",
        litigationModelId: "sol-local",
        routineModelId: "terra-local",
        contextBudgetTokens: 4096,
      },
      { "If-Match": resetEtag },
    );
    assert.equal(restoredForPersistence.status, 200);

    const providerRejected = await api(
      base,
      "PUT",
      "/aletheia/providers/gemini/secret",
      { secret: "must-not-be-written" },
    );
    assert.equal(providerRejected.status, 422);
    assert.equal(providerRejected.body.code, "UNSUPPORTED_SETTING");
    const providerTestRejected = await api(
      base,
      "POST",
      "/aletheia/providers/openai/test",
    );
    assert.equal(providerTestRejected.status, 422);
    const providerList = await api(base, "GET", "/aletheia/providers");
    assert.equal(providerList.status, 200);
    assert.deepEqual(
      providerList.body.providers.map((provider: any) => provider.provider),
      ["pkulaw", "yuandian", "wolters"],
    );
    assert.equal(
      providerList.body.providers.every(
        (provider: any) => provider.hasSecret === false,
      ),
      true,
    );

    const bearer = "mcp-bearer-audit-secret";
    const headerSecret = "mcp-header-audit-secret";
    const oauthToken = "mcp-oauth-audit-token";
    const connectorCreated = await api(
      base,
      "POST",
      "/aletheia/mcp-connectors",
      {
        name: "Unavailable loopback test",
        serverUrl: "http://127.0.0.1:9/mcp",
        auth: {
          bearerToken: bearer,
          headers: { "X-Aletheia-Secret": headerSecret },
          oauth: {
            accessToken: oauthToken,
            refreshToken: "oauth-refresh-secret",
          },
        },
      },
    );
    assert.equal(connectorCreated.status, 201);
    const connectorJson = JSON.stringify(connectorCreated.body);
    assert.equal(connectorJson.includes(bearer), false);
    assert.equal(connectorJson.includes(headerSecret), false);
    assert.equal(connectorJson.includes(oauthToken), false);
    assert.equal(connectorCreated.body.auth.hasBearerToken, true);
    assert.equal(connectorCreated.body.auth.oauthConnected, true);

    const refresh = await api(
      base,
      "POST",
      `/aletheia/mcp-connectors/${connectorCreated.body.id}/refresh-tools`,
    );
    assert.equal(refresh.status, 502);
    const afterFailure = await api(
      base,
      "GET",
      `/aletheia/mcp-connectors/${connectorCreated.body.id}`,
    );
    assert.equal(afterFailure.status, 200);
    assert.equal(afterFailure.body.status, "error");
    assert(afterFailure.body.lastError);
    assert.equal(afterFailure.body.toolCount, 0);

    const remote = await api(base, "POST", "/aletheia/mcp-connectors", {
      name: "Remote capability test",
      serverUrl: "https://example.com/mcp",
    });
    assert.equal(remote.status, 400);
    const hostnameLoopback = await api(
      base,
      "POST",
      "/aletheia/mcp-connectors",
      { name: "DNS loopback test", serverUrl: "http://localhost:3000/mcp" },
    );
    assert.equal(hostnameLoopback.status, 400);
    const redirectConnector = await api(
      base,
      "POST",
      "/aletheia/mcp-connectors",
      {
        name: "Redirect must not follow",
        serverUrl: `http://127.0.0.1:${sourceAddress.port}/mcp`,
      },
    );
    assert.equal(redirectConnector.status, 201);
    const redirectedRefresh = await api(
      base,
      "POST",
      `/aletheia/mcp-connectors/${redirectConnector.body.id}/refresh-tools`,
    );
    assert.equal(redirectedRefresh.status, 502);
    assert.equal(redirectTargetHits, 0);

    assertSecretsAbsent(directory, [
      "must-not-be-written",
      bearer,
      headerSecret,
      oauthToken,
      "oauth-refresh-secret",
    ]);

    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    repo.close();
    repo = new LocalControlRepository({ databasePath });
    const persisted = repo.getSettings("local-control-audit-user");
    assert.equal(persisted.version, 5);
    assert.equal(persisted.settings.defaultModel, "sol-local");
    assert.equal(persisted.settings.litigationModelId, "sol-local");
    assert.equal(persisted.settings.routineModelId, "terra-local");
    assert.equal(
      getAuthoritativeRuntimeSettings("local-control-audit-user").defaultModel,
      "sol-local",
    );
    assert.deepEqual(
      resolveAuthoritativeModelRouting(persisted.settings, "fallback-model"),
      { litigationModelId: "sol-local", routineModelId: "terra-local" },
    );
    assert.deepEqual(
      selectDurableTaskModel(persisted.settings, "fallback-model", {
        workflow: "aletheia-civil-litigation-harness-v1",
        handler: "local_model.litigation_grounded",
      }),
      { role: "litigation_analysis", modelId: "sol-local" },
    );
    assert.deepEqual(
      selectDurableTaskModel(persisted.settings, "fallback-model", {
        workflow: "legal_matter_review",
        handler: "local_model.generate",
      }),
      { role: "routine_analysis", modelId: "terra-local" },
    );
    assert.equal(repo.listMcpConnectors("local-control-audit-user").length, 2);

    console.log(
      JSON.stringify(
        {
          ok: true,
          suite: "aletheia-local-control-audit-v1",
          checks: [
            "strict settings schema",
            "ETag optimistic concurrency",
            "secure reset baseline",
            "authoritative durable-runtime model",
            "server-owned legal and routine model routing",
            "remote provider secrets and tests disabled in pure-local mode",
            "MCP bearer/header/OAuth encryption",
            "loopback connection failure is persisted",
            "remote and hostname MCP are rejected fail-closed",
            "MCP redirects are not followed",
            "restart persistence",
          ],
        },
        null,
        2,
      ),
    );
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (redirectSource.listening) {
      await new Promise<void>((resolve) =>
        redirectSource.close(() => resolve()),
      );
    }
    if (redirectTarget.listening) {
      await new Promise<void>((resolve) =>
        redirectTarget.close(() => resolve()),
      );
    }
    try {
      repo.close();
    } catch {
      // Already closed during the restart-persistence check.
    }
    rmSync(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("[aletheia-local-control-audit] failed", error);
  process.exitCode = 1;
});
