#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const {
  _electron: electron,
} = require("../../frontend/node_modules/playwright");

const desktopDir = path.resolve(__dirname, "..");
const repositoryDir = path.resolve(desktopDir, "..");
const appPath =
  process.env.ALETHEIA_PACKAGED_APP_PATH ??
  path.join(desktopDir, "dist", `mac-${process.arch}`, "Vera.app");
const executablePath = path.join(appPath, "Contents", "MacOS", "Vera");
const frontendPort = checkedPort(
  process.env.ALETHEIA_DESKTOP_FRONTEND_PORT ?? "43760",
  "frontend",
);
const backendPort = checkedPort(
  process.env.ALETHEIA_DESKTOP_BACKEND_PORT ?? "43761",
  "backend",
);
const frontendUrl = `http://127.0.0.1:${frontendPort}/assistant`;
const backendBaseUrl = `http://127.0.0.1:${backendPort}`;
const evidencePath = path.join(
  repositoryDir,
  "docs",
  "evidence",
  "vera-p0-packaged-restart.png",
);

const DOCUMENT_ONE =
  "VERA-E2E-ALPHA：甲方应在三十日内支付全部服务费。甲方名称为晨星科技。";
const DOCUMENT_TWO =
  "VERA-E2E-BETA：乙方有权在重大违约后解除协议。乙方名称为远山律师事务所。";
const DOCUMENT_ONE_PAYMENT_QUOTE = "甲方应在三十日内支付全部服务费";
const DOCUMENT_ONE_PARTY_QUOTE = "甲方名称为晨星科技";
const DOCUMENT_TWO_TERMINATION_QUOTE = "乙方有权在重大违约后解除协议";
const DOCUMENT_TWO_PARTY_QUOTE = "乙方名称为远山律师事务所";
const ASSISTANT_VISIBLE_ANSWER =
  "第一份文件约定甲方三十日内付款[1]；第二份文件约定乙方可在重大违约后解除[2]。";
const WORKFLOW_ANSWER = "工作流已完成本地合同审查。";
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const API_TIMEOUT_MS = 180_000;
const POLL_TIMEOUT_MS = 180_000;

const redactionValues = new Set();
let applicationLog = "";

function checkedPort(value, label) {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`The ${label} port is invalid.`);
  }
  return port;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redact(value) {
  let text = String(value);
  for (const secret of redactionValues) {
    if (secret) text = text.replace(new RegExp(escapeRegExp(secret), "g"), "[redacted]");
  }
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\b(?:sk|key)-[A-Za-z0-9_-]{8,}\b/gi, "[redacted]")
    .replace(
      /(?:\/Users\/|\/home\/|\/private\/var\/|[A-Za-z]:\\)[^\r\n"']+/g,
      "[redacted-path]",
    );
}

function bounded(value, limit = 4_000) {
  const text = redact(value);
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

function captureApplicationLog(application) {
  const append = (chunk) => {
    applicationLog = `${applicationLog}${chunk.toString()}`.slice(-16_384);
  };
  application.process().stdout?.on("data", append);
  application.process().stderr?.on("data", append);
}

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const finish = (open) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(500);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function assertPortsFree() {
  assert.notEqual(frontendPort, backendPort, "Desktop ports must be distinct.");
  assert.equal(await portOpen(frontendPort), false, "Frontend port is already in use.");
  assert.equal(await portOpen(backendPort), false, "Backend port is already in use.");
}

async function waitForPortsClosed(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await portOpen(frontendPort)) && !(await portOpen(backendPort))) return;
    await delay(200);
  }
  throw new Error("Packaged Vera did not release its local service ports.");
}

async function waitForHealth(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${backendBaseUrl}/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) return;
    } catch {
      // The packaged backend is still starting.
    }
    await delay(250);
  }
  throw new Error("Packaged Vera backend did not become healthy.");
}

function verifyPrivateWorkspaceDatabase(userDataDir) {
  const databasePath = path.join(userDataDir, "aletheia-data", "aletheia.db");
  const info = fs.lstatSync(databasePath, { throwIfNoEntry: false });
  assert.ok(info?.isFile(), "The isolated profile must contain its workspace database.");
  assert.equal(info.isSymbolicLink(), false, "The workspace database must not be a symlink.");
  assert.ok(info.size > 0, "The isolated workspace database must not be empty.");
  assert.equal(
    info.mode & 0o077,
    0,
    "The isolated workspace database must deny group and world access.",
  );
  assert.notEqual(
    fs.readFileSync(databasePath).subarray(0, 16).toString("utf8"),
    "SQLite format 3\u0000",
    "The packaged workspace database must not expose a plaintext SQLite header.",
  );
  return info.size;
}

async function readRequestJson(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 2 * 1024 * 1024) throw new Error("Mock provider request is too large.");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(text);
}

function completionChunk(delta, finishReason = null) {
  return {
    id: "vera-packaged-workspace-e2e",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function writeSseRecord(response, value) {
  response.write(`data: ${JSON.stringify(value)}\n\n`);
}

function sendTextCompletion(response, text) {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-store",
    connection: "close",
  });
  const split = Math.max(1, Math.floor(text.length / 2));
  writeSseRecord(response, completionChunk({ content: text.slice(0, split) }));
  writeSseRecord(
    response,
    completionChunk({ content: text.slice(split) }, "stop"),
  );
  writeSseRecord(response, {
    choices: [],
    usage: { prompt_tokens: 32, completion_tokens: 16 },
  });
  response.end("data: [DONE]\n\n");
}

function sendFetchDocumentsCall(response) {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-store",
    connection: "close",
  });
  writeSseRecord(
    response,
    completionChunk(
      {
        tool_calls: [
          {
            index: 0,
            id: "vera-e2e-fetch-documents",
            type: "function",
            function: {
              name: "fetch_documents",
              arguments: JSON.stringify({ doc_ids: ["doc-0", "doc-1"] }),
            },
          },
        ],
      },
      "tool_calls",
    ),
  );
  writeSseRecord(response, {
    choices: [],
    usage: { prompt_tokens: 24, completion_tokens: 8 },
  });
  response.end("data: [DONE]\n\n");
}

function assistantAnswer(messages) {
  const toolMessage = [...messages]
    .reverse()
    .find(
      (message) =>
        typeof message?.content === "string" &&
        message.content.startsWith("[Tool result]\n"),
    );
  assert.ok(toolMessage, "Assistant final turn must receive a real tool result.");
  const result = JSON.parse(toolMessage.content.slice("[Tool result]\n".length));
  assert.ok(Array.isArray(result.documents));
  const findDocument = (marker) =>
    result.documents.find((entry) =>
      entry?.evidence?.some(
        (evidence) =>
          typeof evidence?.text === "string" && evidence.text.includes(marker),
      ),
    );
  const first = findDocument("VERA-E2E-ALPHA");
  const second = findDocument("VERA-E2E-BETA");
  assert.ok(first?.document?.doc_id, "First tool document is missing.");
  assert.ok(second?.document?.doc_id, "Second tool document is missing.");
  assert.ok(
    first.evidence.some((item) => item.text.includes(DOCUMENT_ONE_PAYMENT_QUOTE)),
  );
  assert.ok(
    second.evidence.some((item) =>
      item.text.includes(DOCUMENT_TWO_TERMINATION_QUOTE),
    ),
  );
  return `${ASSISTANT_VISIBLE_ANSWER}<CITATIONS>${JSON.stringify([
    {
      ref: 1,
      doc_id: first.document.doc_id,
      quotes: [{ quote: DOCUMENT_ONE_PAYMENT_QUOTE }],
    },
    {
      ref: 2,
      doc_id: second.document.doc_id,
      quotes: [{ quote: DOCUMENT_TWO_TERMINATION_QUOTE }],
    },
  ])}</CITATIONS>`;
}

function tabularAnswer(request, calls) {
  const userContent = request.messages
    .filter((message) => message.role === "user")
    .map((message) => message.content)
    .join("\n");
  const first = userContent.includes("VERA-E2E-ALPHA");
  const second = userContent.includes("VERA-E2E-BETA");
  const party = userContent.includes("Column title: 当事方");
  const clause = userContent.includes("Column title: 核心条款");
  assert.equal(first || second, true, "Tabular request omitted authoritative text.");
  assert.equal(first && second, false, "A Tabular cell must bind one document.");
  assert.equal(party || clause, true, "Tabular request omitted the column title.");
  assert.equal(party && clause, false, "A Tabular cell must bind one column.");
  const key = `${first ? "alpha" : "beta"}:${party ? "party" : "clause"}`;
  assert.equal(calls.tabularCells.has(key), false, `Duplicate Tabular cell ${key}.`);
  calls.tabularCells.add(key);
  let value;
  let quote;
  if (first && party) {
    value = "晨星科技";
    quote = DOCUMENT_ONE_PARTY_QUOTE;
  } else if (first) {
    value = DOCUMENT_ONE_PAYMENT_QUOTE;
    quote = DOCUMENT_ONE_PAYMENT_QUOTE;
  } else if (party) {
    value = "远山律师事务所";
    quote = DOCUMENT_TWO_PARTY_QUOTE;
  } else {
    value = DOCUMENT_TWO_TERMINATION_QUOTE;
    quote = DOCUMENT_TWO_TERMINATION_QUOTE;
  }
  assert.ok(userContent.includes(quote), "Tabular quote must be exact evidence.");
  return JSON.stringify({
    value,
    reasoning: "该结果来自当前文档中的精确文本。",
    flag: "green",
    quotes: [quote],
  });
}

async function createMockProvider(secret) {
  const failures = [];
  const calls = {
    probes: 0,
    assistantTurns: 0,
    assistantToolCalls: 0,
    workflowTurns: 0,
    tabularTurns: 0,
    tabularCells: new Set(),
  };
  const server = http.createServer((request, response) => {
    void (async () => {
      assert.equal(
        request.headers.authorization,
        `Bearer ${secret}`,
        "Mock provider requires the configured credential.",
      );
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && requestUrl.pathname === "/v1/models") {
        calls.probes += 1;
        response.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          connection: "close",
        });
        response.end(
          JSON.stringify({
            object: "list",
            data: [{ id: "vera-packaged-e2e-model", object: "model" }],
          }),
        );
        return;
      }
      assert.equal(request.method, "POST");
      assert.equal(requestUrl.pathname, "/v1/chat/completions");
      const body = await readRequestJson(request);
      assert.equal(body.model, "vera-packaged-e2e-model");
      assert.equal(body.stream, true);
      assert.deepEqual(body.stream_options, { include_usage: true });
      assert.ok(Array.isArray(body.messages));

      if (body.response_format?.type === "json_schema") {
        calls.tabularTurns += 1;
        assert.equal(body.tools, undefined);
        assert.equal(
          body.response_format.json_schema?.schema?.properties?.value?.type,
          "string",
        );
        sendTextCompletion(response, tabularAnswer(body, calls));
        return;
      }

      if (Array.isArray(body.tools) && body.tools.length > 0) {
        calls.assistantTurns += 1;
        assert.ok(
          body.tools.some((tool) => tool?.function?.name === "fetch_documents"),
          "Assistant must register fetch_documents.",
        );
        const hasToolResult = body.messages.some(
          (message) =>
            typeof message?.content === "string" &&
            message.content.startsWith("[Tool result]\n"),
        );
        if (!hasToolResult) {
          calls.assistantToolCalls += 1;
          const system = body.messages.find((message) => message.role === "system");
          assert.match(system?.content ?? "", /doc-0/);
          assert.match(system?.content ?? "", /doc-1/);
          sendFetchDocumentsCall(response);
        } else {
          sendTextCompletion(response, assistantAnswer(body.messages));
        }
        return;
      }

      calls.workflowTurns += 1;
      const system = body.messages.find((message) => message.role === "system");
      assert.match(system?.content ?? "", /workflow executor/i);
      assert.equal(body.response_format, undefined);
      sendTextCompletion(response, WORKFLOW_ANSWER);
    })().catch((error) => {
      failures.push(bounded(error instanceof Error ? error.stack : error));
      if (!response.headersSent) {
        response.writeHead(500, {
          "content-type": "application/json; charset=utf-8",
          connection: "close",
        });
      }
      if (!response.writableEnded) {
        response.end(JSON.stringify({ error: { message: "mock_provider_failed" } }));
      }
    });
  });
  server.keepAliveTimeout = 1;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  let closed = false;
  return {
    port: address.port,
    calls,
    failures,
    async close() {
      if (closed) return;
      closed = true;
      const closing = new Promise((resolve) => server.close(resolve));
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
      await closing;
    },
  };
}

async function apiResponse(token, route, options = {}) {
  const headers = new Headers(options.headers ?? {});
  headers.set("authorization", `Bearer ${token}`);
  let body = options.body;
  if (options.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(options.json);
  }
  const response = await fetch(`${backendBaseUrl}/api/v1${route}`, {
    method: options.method ?? "GET",
    headers,
    body,
    signal: AbortSignal.timeout(options.timeoutMs ?? API_TIMEOUT_MS),
  });
  const expected = options.expected ?? [200];
  if (!expected.includes(response.status)) {
    const message = bounded(await response.text(), 2_000);
    throw new Error(
      `Local API ${options.method ?? "GET"} ${route} failed (${response.status}): ${message}`,
    );
  }
  return response;
}

async function apiJson(token, route, options = {}) {
  const response = await apiResponse(token, route, options);
  if (response.status === 204) return null;
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) {
    throw new Error(`Local API response for ${route} exceeded the test budget.`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Local API response for ${route} was not JSON.`);
  }
}

async function apiText(token, route, options = {}) {
  const response = await apiResponse(token, route, options);
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) {
    throw new Error(`Local API response for ${route} exceeded the test budget.`);
  }
  return { response, text };
}

async function apiBytes(token, route, options = {}) {
  const response = await apiResponse(token, route, options);
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > MAX_RESPONSE_BYTES) {
    throw new Error(`Local API response for ${route} exceeded the test budget.`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_RESPONSE_BYTES) {
    throw new Error(`Local API response for ${route} exceeded the test budget.`);
  }
  return { response, bytes };
}

async function pollUntil(label, operation, timeoutMs = POLL_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await operation();
    if (value !== undefined) return value;
    await delay(250);
  }
  throw new Error(`${label} did not reach a terminal state.`);
}

async function assertVeraUi(page) {
  await page.locator("#vera-sidebar").waitFor({
    state: "visible",
    timeout: 90_000,
  });
  await page.locator('a[aria-label="Vera"]').waitFor({
    state: "visible",
    timeout: 90_000,
  });
  assert.equal(new URL(page.url()).pathname, "/assistant");
  await page.waitForFunction(() => {
    const sidebar = document.querySelector("#vera-sidebar");
    if (!sidebar) return false;
    const text = sidebar.textContent ?? "";
    const labels = [
      ["助手", "Assistant"],
      ["项目", "Projects"],
      ["表格", "Tabular"],
      ["工作流", "Workflows"],
      ["设置", "Settings"],
    ];
    return labels.every((variants) => variants.some((label) => text.includes(label)));
  });
  const sidebarText = await page.locator("#vera-sidebar").innerText();
  assert.match(sidebarText, /Vera/);
  for (const variants of [
    ["助手", "Assistant"],
    ["项目", "Projects"],
    ["表格", "Tabular"],
    ["工作流", "Workflows"],
    ["设置", "Settings"],
  ]) {
    assert.ok(
      variants.some((label) => sidebarText.includes(label)),
      `Missing Vera navigation item ${variants.join("/")}.`,
    );
  }
}

async function navigateAndAssertVisibleText(page, route, expectedTexts) {
  const target = `http://127.0.0.1:${frontendPort}${route}`;
  await page.goto(target, {
    waitUntil: "domcontentloaded",
    timeout: 90_000,
  });
  await page.waitForURL(target, { timeout: 90_000 });
  await page.waitForFunction(
    (texts) => {
      const visible = document.body?.innerText ?? "";
      return texts.every((text) => visible.includes(text));
    },
    expectedTexts,
    { timeout: 90_000 },
  );
}

async function assertProjectRenderer(page, projectId) {
  await navigateAndAssertVisibleText(page, `/projects/${projectId}`, [
    "Vera 打包客户端通用项目",
    "alpha-contract.txt",
    "beta-contract.txt",
  ]);
}

async function assertAssistantRenderer(page, projectId, chatId) {
  await navigateAndAssertVisibleText(
    page,
    `/projects/${projectId}/assistant/chat/${chatId}`,
    [
      "第一份文件约定甲方三十日内付款",
      "第二份文件约定乙方可在重大违约后解除",
      "alpha-contract.txt",
      "beta-contract.txt",
    ],
  );
  const firstSource = page.getByRole("button", {
    name: /\[1\].*alpha-contract\.txt/,
  });
  await firstSource.waitFor({ state: "visible", timeout: 90_000 });
  await firstSource.click();
  await page.getByText(DOCUMENT_ONE_PAYMENT_QUOTE, { exact: true }).waitFor({
    state: "visible",
    timeout: 90_000,
  });
}

async function assertWorkflowRenderer(page, workflowId) {
  await navigateAndAssertVisibleText(page, `/workflows/${workflowId}`, [
    "Vera 本地合同审查",
    "生成审查结论",
    "文本结果",
    WORKFLOW_ANSWER,
  ]);
  await page.waitForFunction(
    (values) => {
      const controls = [...document.querySelectorAll("input, textarea, select")];
      return values.every((value) =>
        controls.some((control) => control.value === value),
      );
    },
    ["生成审查结论", "文本结果"],
    { timeout: 90_000 },
  );
}

async function assertTabularRenderer(page, projectId, reviewId) {
  await navigateAndAssertVisibleText(
    page,
    `/projects/${projectId}/tabular-reviews/${reviewId}`,
    [
      "Vera 2x2 合同提取",
      "alpha-contract.txt",
      "beta-contract.txt",
      "晨星科技",
      DOCUMENT_ONE_PAYMENT_QUOTE,
      "远山律师事务所",
      DOCUMENT_TWO_TERMINATION_QUOTE,
    ],
  );
  const actions = page.getByRole("button", {
    name: /表格审阅操作|Tabular review actions/,
  });
  await actions.waitFor({ state: "visible", timeout: 90_000 });
  await actions.click();
  await page
    .getByRole("menuitem", { name: /导出 CSV|Export CSV/ })
    .waitFor({ state: "visible", timeout: 30_000 });
  await page
    .getByRole("menuitem", { name: /导出 XLSX|Export XLSX/ })
    .waitFor({ state: "visible", timeout: 30_000 });
  await page.keyboard.press("Escape");
}

async function assertModelRenderer(page) {
  await navigateAndAssertVisibleText(page, "/settings/models", [
    "Vera packaged E2E model",
    "vera-packaged-e2e-model",
    "OpenAI-compatible",
  ]);
  const visible = await page.locator("body").innerText();
  assert.match(visible, /默认模型|Default model/);
  assert.match(visible, /已配置|Configured/);
}

function launchEnvironment(userDataDir, applicationMasterKey, databaseKey) {
  return {
    ...process.env,
    VERA_DESKTOP_PROFILE_DIR: userDataDir,
    ALETHEIA_DEMO_SEED_ENABLED: "false",
    ALETHEIA_REQUIRE_ENCRYPTED_VOLUME: "false",
    ALETHEIA_APPLICATION_ENCRYPTION: "required",
    ALETHEIA_MASTER_KEY_SOURCE: "env",
    ALETHEIA_MASTER_KEY_BASE64: applicationMasterKey.toString("base64"),
    ALETHEIA_DATABASE_ENCRYPTION: "sqlcipher_required",
    ALETHEIA_DATABASE_KEY_SOURCE: "env",
    ALETHEIA_DATABASE_KEY_BASE64: databaseKey.toString("base64"),
    ALETHEIA_MODEL_PROVIDER_ALLOW_LOOPBACK_HTTP: "true",
    ALETHEIA_DESKTOP_FRONTEND_PORT: String(frontendPort),
    ALETHEIA_DESKTOP_BACKEND_PORT: String(backendPort),
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
  };
}

async function launchPackagedVera(userDataDir, applicationMasterKey, databaseKey) {
  const app = await electron.launch({
    executablePath,
    env: launchEnvironment(userDataDir, applicationMasterKey, databaseKey),
    timeout: 180_000,
  });
  try {
    captureApplicationLog(app);
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.waitForURL(frontendUrl, { timeout: 180_000 });
    await waitForHealth();
    const workspaceDatabaseBytes = verifyPrivateWorkspaceDatabase(userDataDir);
    await assertVeraUi(page);
    const token = await page.evaluate(() =>
      window.aletheiaDesktop.getAuthToken(),
    );
    assert.equal(typeof token, "string");
    assert.ok(token.length >= 32);
    redactionValues.add(token);
    return { app, page, token, workspaceDatabaseBytes };
  } catch (error) {
    await app.close().catch(() => undefined);
    await waitForPortsClosed().catch(() => undefined);
    throw error;
  }
}

async function closePackagedVera(application) {
  if (!application) return;
  await application.close();
  await waitForPortsClosed();
}

async function uploadTextDocument(token, projectId, filename, content) {
  const form = new FormData();
  form.append("file", new Blob([content], { type: "text/plain" }), filename);
  return apiJson(token, `/projects/${projectId}/documents`, {
    method: "POST",
    body: form,
    expected: [201],
  });
}

function assistantMessageText(message) {
  assert.ok(Array.isArray(message.content));
  return message.content
    .filter((part) => part?.type === "content" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

function parseSseData(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice("data: ".length))
    .filter((value) => value !== "[DONE]")
    .map((value) => JSON.parse(value));
}

async function assertMockUnavailable(port) {
  await assert.rejects(
    fetch(`http://127.0.0.1:${port}/v1/models`, {
      signal: AbortSignal.timeout(1_000),
    }),
  );
}

async function main() {
  if (process.platform !== "darwin") throw new Error("This audit requires macOS.");
  fs.accessSync(executablePath, fs.constants.X_OK);
  await assertPortsFree();
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  fs.rmSync(evidencePath, { force: true });

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vera-packaged-workspace-e2e-"));
  fs.chmodSync(root, 0o700);
  const userDataDir = path.join(root, "user-data");
  fs.mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
  const applicationMasterKey = crypto.randomBytes(32);
  const databaseKey = crypto.randomBytes(32);
  const providerSecret = crypto.randomBytes(32).toString("base64url");
  redactionValues.add(applicationMasterKey.toString("base64"));
  redactionValues.add(databaseKey.toString("base64"));
  redactionValues.add(providerSecret);
  redactionValues.add(root);

  let packaged = null;
  let mock = null;
  let mockSummary = null;
  let modelProfileId = null;
  let credentialDeleted = false;
  let completed = false;
  try {
    mock = await createMockProvider(providerSecret);
    const providerPort = mock.port;
    const providerBaseUrl = `http://127.0.0.1:${providerPort}/v1`;

    packaged = await launchPackagedVera(
      userDataDir,
      applicationMasterKey,
      databaseKey,
    );
    let { token } = packaged;
    const status = await apiJson(token, "/settings/status");
    assert.equal(status.capabilities.settings_available, true);
    assert.equal(status.capabilities.loopback_http_allowed, true);
    assert.equal(status.capabilities.runtime_wired, true);

    let model = await apiJson(token, "/model-profiles", {
      method: "POST",
      json: {
        name: "Vera packaged E2E model",
        provider: "openai_compatible",
        model: "vera-packaged-e2e-model",
        base_url: providerBaseUrl,
        context_window_tokens: 32_768,
        max_output_tokens: 4_096,
        capabilities: {
          streaming: true,
          toolCalling: true,
          structuredOutput: true,
          vision: false,
        },
      },
      expected: [201],
    });
    modelProfileId = model.id;
    model = await apiJson(token, `/model-profiles/${modelProfileId}/credential`, {
      method: "PUT",
      json: { secret: providerSecret },
    });
    assert.equal(model.credential.status, "configured");
    model = await apiJson(token, `/model-profiles/${modelProfileId}/test`, {
      method: "POST",
      json: {},
    });
    assert.equal(
      model.connection_test.status,
      "passed",
      `Model connection test failed: ${bounded(JSON.stringify(model.connection_test), 2_000)}`,
    );
    model = await apiJson(token, `/model-profiles/${modelProfileId}/enable`, {
      method: "POST",
      json: {},
    });
    assert.equal(model.availability.status, "ready");
    model = await apiJson(token, `/model-profiles/${modelProfileId}/default`, {
      method: "POST",
      json: {},
    });
    assert.equal(model.enabled, true);
    assert.equal(model.is_default, true);

    const project = await apiJson(token, "/projects", {
      method: "POST",
      json: {
        name: "Vera 打包客户端通用项目",
        description: "验证 Project 作为文档、助手、工作流和表格的通用本地容器。",
        cm_number: null,
        practice: null,
        shared_with: [],
      },
      expected: [201],
    });
    assert.equal(project.name, "Vera 打包客户端通用项目");

    const firstUpload = await uploadTextDocument(
      token,
      project.id,
      "alpha-contract.txt",
      DOCUMENT_ONE,
    );
    const secondUpload = await uploadTextDocument(
      token,
      project.id,
      "beta-contract.txt",
      DOCUMENT_TWO,
    );
    const documentIds = [firstUpload.document.id, secondUpload.document.id];
    const readyDocuments = await pollUntil("Project documents", async () => {
      const documents = await apiJson(
        token,
        `/projects/${project.id}/documents?limit=100`,
      );
      for (const document of documents.filter((item) => documentIds.includes(item.id))) {
        if (document.status === "error") {
          throw new Error("A packaged TXT document failed local parsing.");
        }
      }
      return documentIds.every(
        (id) => documents.find((document) => document.id === id)?.status === "ready",
      )
        ? documents.filter((document) => documentIds.includes(document.id))
        : undefined;
    });
    assert.equal(readyDocuments.length, 2);

    const acceptedAssistant = await apiJson(token, `/projects/${project.id}/chat`, {
      method: "POST",
      json: {
        messages: [
          {
            role: "user",
            content: "请比较两份合同中的核心付款或解除约定，并给出精确引用。",
          },
        ],
        model_profile_id: modelProfileId,
        attached_documents: [
          {
            filename: "alpha-contract.txt",
            document_id: documentIds[0],
          },
          {
            filename: "beta-contract.txt",
            document_id: documentIds[1],
          },
        ],
      },
      expected: [202],
    });
    await pollUntil("Assistant generation", async () => {
      const job = await apiJson(
        token,
        `/assistant/jobs/${acceptedAssistant.job_id}`,
      );
      if (!job.terminal) return undefined;
      assert.equal(job.status, "complete", "Assistant generation did not complete.");
      return job;
    });
    const chat = await apiJson(token, `/chat/${acceptedAssistant.chat_id}`);
    const assistantMessage = chat.messages.find((message) => message.role === "assistant");
    assert.ok(assistantMessage);
    assert.equal(assistantMessageText(assistantMessage), ASSISTANT_VISIBLE_ANSWER);
    assert.equal(assistantMessage.citations.length, 2);
    assert.deepEqual(
      assistantMessage.citations.map((citation) => citation.document_id).sort(),
      [...documentIds].sort(),
    );
    assert.deepEqual(
      assistantMessage.citations.map((citation) => citation.quote),
      [DOCUMENT_ONE_PAYMENT_QUOTE, DOCUMENT_TWO_TERMINATION_QUOTE],
    );

    const workflow = await apiJson(token, "/workflows", {
      method: "POST",
      json: {
        metadata: {
          title: "Vera 本地合同审查",
          type: "assistant",
          language: "zh-CN",
          practice: null,
          jurisdictions: [],
        },
        skill_md: "仅执行当前本地步骤并返回简洁结果。",
      },
      expected: [201],
    });
    const promptStepId = crypto.randomUUID();
    const outputStepId = crypto.randomUUID();
    const definitionInput = {
      name: "Vera 本地合同审查",
      description: "一个提示步骤和一个文本输出步骤。",
      project_id: project.id,
      steps: [
        {
          id: promptStepId,
          type: "prompt",
          name: "生成审查结论",
          prompt: `请严格输出：${WORKFLOW_ANSWER}`,
          model_profile_id: modelProfileId,
        },
        {
          id: outputStepId,
          type: "output",
          name: "文本结果",
          format: "text",
        },
      ],
    };
    const definition = await apiJson(token, `/workflows/${workflow.id}/definition`, {
      method: "PUT",
      json: definitionInput,
    });
    assert.equal(definition.type, "assistant");
    assert.deepEqual(definition.steps, definitionInput.steps);
    const preparedRun = await apiJson(token, `/workflows/${workflow.id}/runs`, {
      method: "POST",
      json: {
        idempotency_key: `packaged-e2e-${crypto.randomUUID()}`,
        project_id: project.id,
        model_profile_id: modelProfileId,
        input_binding: { instruction: "验证真实执行输入输出" },
      },
      expected: [202],
    });
    assert.equal(preparedRun.reused, false);
    const workflowRun = await pollUntil("Workflow run", async () => {
      const detail = await apiJson(
        token,
        `/workflow-runs/${preparedRun.run.id}`,
      );
      if (["queued", "waiting", "running"].includes(detail.run.status)) {
        return undefined;
      }
      assert.equal(detail.run.status, "complete", "Workflow run did not complete.");
      return detail;
    });
    assert.equal(workflowRun.steps.length, 2);
    assert.deepEqual(
      workflowRun.steps.map((step) => [step.step.id, step.step.kind, step.status]),
      [
        [promptStepId, "prompt", "complete"],
        [outputStepId, "output", "complete"],
      ],
    );
    assert.equal(workflowRun.run.output.content, WORKFLOW_ANSWER);
    assert.equal(workflowRun.run.output.modelCallCount, 1);

    const tabular = await apiJson(token, "/tabular-review", {
      method: "POST",
      json: {
        title: "Vera 2x2 合同提取",
        project_id: project.id,
        document_ids: documentIds,
        model_profile_id: modelProfileId,
        workflow_id: null,
        columns_config: [
          {
            index: 0,
            name: "当事方",
            prompt: "提取该文档中明确出现的当事方名称。",
            format: "text",
            tags: [],
          },
          {
            index: 1,
            name: "核心条款",
            prompt: "提取该文档中的核心付款或解除条款。",
            format: "text",
            tags: [],
          },
        ],
        shared_with: [],
      },
      expected: [201],
    });
    const generated = await apiText(token, `/tabular-review/${tabular.id}/generate`, {
      method: "POST",
      json: {},
      timeoutMs: POLL_TIMEOUT_MS,
    });
    assert.match(generated.text, /data: \[DONE\]/);
    const tabularEvents = parseSseData(generated.text).filter(
      (event) => event.type === "cell_update" && event.status === "done",
    );
    assert.equal(
      new Set(
        tabularEvents.map(
          (event) => `${event.document_id}:${event.column_index}`,
        ),
      ).size,
      4,
    );
    const tabularDetail = await apiJson(token, `/tabular-review/${tabular.id}`);
    assert.equal(tabularDetail.cells.length, 4);
    assert.ok(tabularDetail.cells.every((cell) => cell.status === "done"));
    assert.ok(tabularDetail.cells.every((cell) => cell.sources.length >= 1));
    assert.ok(
      tabularDetail.cells.every((cell) =>
        cell.sources.every(
          (source) => typeof source.quote === "string" && source.quote.length > 0,
        ),
      ),
    );

    const csv = await apiBytes(token, `/tabular-review/${tabular.id}/export.csv`);
    assert.match(csv.response.headers.get("content-type") ?? "", /^text\/csv/);
    assert.match(csv.response.headers.get("content-disposition") ?? "", /\.csv/);
    const csvText = csv.bytes.toString("utf8");
    assert.match(csvText, /晨星科技/);
    assert.match(csvText, /远山律师事务所/);
    const xlsx = await apiBytes(token, `/tabular-review/${tabular.id}/export.xlsx`);
    assert.match(
      xlsx.response.headers.get("content-type") ?? "",
      /spreadsheetml\.sheet/,
    );
    assert.match(xlsx.response.headers.get("content-disposition") ?? "", /\.xlsx/);
    assert.equal(xlsx.bytes.subarray(0, 4).toString("hex"), "504b0304");

    await assertProjectRenderer(packaged.page, project.id);
    await assertAssistantRenderer(
      packaged.page,
      project.id,
      acceptedAssistant.chat_id,
    );
    await assertWorkflowRenderer(packaged.page, workflow.id);
    await assertTabularRenderer(packaged.page, project.id, tabular.id);
    await assertModelRenderer(packaged.page);

    assert.deepEqual(mock.failures, []);
    assert.equal(mock.calls.probes, 1);
    assert.equal(mock.calls.assistantTurns, 2);
    assert.equal(mock.calls.assistantToolCalls, 1);
    assert.equal(mock.calls.workflowTurns, 1);
    assert.equal(mock.calls.tabularTurns, 4);
    assert.deepEqual(
      [...mock.calls.tabularCells].sort(),
      ["alpha:clause", "alpha:party", "beta:clause", "beta:party"],
    );
    mockSummary = mock.calls;
    await mock.close();
    mock = null;
    await assertMockUnavailable(providerPort);

    const clearedModel = await apiJson(
      token,
      `/model-profiles/${modelProfileId}/credential`,
      { method: "DELETE" },
    );
    assert.equal(clearedModel.credential.status, "missing");
    assert.equal(clearedModel.enabled, false);
    assert.equal(clearedModel.is_default, false);
    credentialDeleted = true;

    await closePackagedVera(packaged.app);
    packaged = null;
    await assertPortsFree();

    packaged = await launchPackagedVera(
      userDataDir,
      applicationMasterKey,
      databaseKey,
    );
    token = packaged.token;
    await assertMockUnavailable(providerPort);

    const persistedModel = await apiJson(token, `/model-profiles/${modelProfileId}`);
    assert.equal(persistedModel.enabled, false);
    assert.equal(persistedModel.is_default, false);
    assert.equal(persistedModel.credential.status, "missing");
    const persistedProject = await apiJson(token, `/projects/${project.id}`);
    assert.equal(persistedProject.name, project.name);
    assert.deepEqual(
      persistedProject.documents.map((document) => document.id).sort(),
      [...documentIds].sort(),
    );
    assert.ok(persistedProject.documents.every((document) => document.status === "ready"));
    const persistedChat = await apiJson(token, `/chat/${acceptedAssistant.chat_id}`);
    const persistedAssistant = persistedChat.messages.find(
      (message) => message.role === "assistant",
    );
    assert.equal(assistantMessageText(persistedAssistant), ASSISTANT_VISIBLE_ANSWER);
    assert.equal(persistedAssistant.citations.length, 2);
    const persistedWorkflow = await apiJson(token, `/workflows/${workflow.id}`);
    assert.equal(persistedWorkflow.metadata.title, "Vera 本地合同审查");
    const persistedDefinition = await apiJson(
      token,
      `/workflows/${workflow.id}/definition`,
    );
    assert.deepEqual(persistedDefinition.steps, definitionInput.steps);
    const persistedRun = await apiJson(
      token,
      `/workflow-runs/${preparedRun.run.id}`,
    );
    assert.equal(persistedRun.run.status, "complete");
    assert.equal(persistedRun.run.output.content, WORKFLOW_ANSWER);
    const persistedTabular = await apiJson(token, `/tabular-review/${tabular.id}`);
    assert.equal(persistedTabular.cells.length, 4);
    assert.ok(persistedTabular.cells.every((cell) => cell.status === "done"));
    assert.ok(persistedTabular.cells.every((cell) => cell.sources.length >= 1));

    await assertAssistantRenderer(
      packaged.page,
      project.id,
      acceptedAssistant.chat_id,
    );
    await assertWorkflowRenderer(packaged.page, workflow.id);
    await assertTabularRenderer(packaged.page, project.id, tabular.id);
    await navigateAndAssertVisibleText(packaged.page, "/assistant", []);
    await assertVeraUi(packaged.page);
    const visibleText = await packaged.page.locator("body").innerText();
    assert.equal(visibleText.includes(providerSecret), false);
    assert.equal(visibleText.includes(DOCUMENT_ONE), false);
    assert.equal(visibleText.includes(DOCUMENT_TWO), false);
    await packaged.page.screenshot({ path: evidencePath, fullPage: false });
    assert.ok(fs.statSync(evidencePath).size > 10_000);

    completed = true;
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          suite: "vera-packaged-workspace-e2e-v1",
          evidence: "docs/evidence/vera-p0-packaged-restart.png",
          isolated_workspace_database_bytes: packaged.workspaceDatabaseBytes,
          provider_calls: {
            connection_probes: mockSummary.probes,
            assistant_turns: mockSummary.assistantTurns,
            assistant_document_tool_calls: mockSummary.assistantToolCalls,
            workflow_turns: mockSummary.workflowTurns,
            tabular_turns: mockSummary.tabularTurns,
          },
          checks: [
            "packaged Vera default Assistant and five-item navigation",
            "generic OpenAI-compatible profile credential test enable default",
            "generic Project with two locally parsed TXT documents",
            "Assistant streaming fetch_documents and exact persisted citations",
            "prompt plus output Workflow definition with real durable execution I/O",
            "2x2 Tabular structured generation with exact sources and CSV/XLSX export",
            "same SQLCipher data and blob keys across an offline second launch",
            "private non-plaintext SQLCipher database inside the isolated profile",
            "persisted project documents chat messages workflow run and Tabular results",
            "redacted second-launch Vera UI screenshot evidence",
          ],
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    if (!credentialDeleted && modelProfileId && packaged?.token) {
      await apiJson(
        packaged.token,
        `/model-profiles/${modelProfileId}/credential`,
        { method: "DELETE" },
      ).catch(() => undefined);
    }
    if (mock) await mock.close().catch(() => undefined);
    if (packaged?.app) await packaged.app.close().catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
    applicationMasterKey.fill(0);
    databaseKey.fill(0);
    if (!completed) fs.rmSync(evidencePath, { force: true });
  }
}

main().catch((error) => {
  const primary = bounded(error instanceof Error ? error.stack : error, 12_000);
  const logs = applicationLog ? `\nPackaged application log (redacted):\n${bounded(applicationLog, 8_000)}` : "";
  process.stderr.write(`${primary}${logs}\n`);
  process.exitCode = 1;
});
