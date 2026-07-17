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
let evidencePath = null;

const DOCUMENT_ONE =
  "VERA-E2E-ALPHA：甲方应在三十日内支付全部服务费。甲方名称为晨星科技。";
const DOCUMENT_TWO =
  "VERA-E2E-BETA：乙方有权在重大违约后解除协议。乙方名称为远山律师事务所。";
const DOCUMENT_THREE =
  "VERA-FLAGSHIP-GAMMA: Gamma Services Ltd may terminate for material breach. This Agreement is governed by English law.";
const FLAGSHIP_DOCUMENTS = Object.freeze([
  "alpha-contract.txt",
  "beta-contract.txt",
  "gamma-contract.txt",
]);
const FLAGSHIP_PROMPT =
  "请审查我选择的合同，比较控制权变更、责任上限、自动续期和适用法条款；生成一份比较表，并起草一份风险备忘录。";
const CUSTOM_EXTRACTION_COLUMNS = Object.freeze([
  "当事人",
  "签署日期",
  "合同金额",
  "付款期限",
  "解除权",
  "管辖法院",
]);
const TIMELINE_COLUMNS = Object.freeze([
  "Date",
  "Event",
  "Participants",
  "Source file",
  "Original evidence",
  "Potential significance",
  "Open questions",
]);
const DOCUMENT_ONE_PAYMENT_QUOTE = "甲方应在三十日内支付全部服务费";
const DOCUMENT_ONE_PARTY_QUOTE = "甲方名称为晨星科技";
const DOCUMENT_TWO_TERMINATION_QUOTE = "乙方有权在重大违约后解除协议";
const DOCUMENT_TWO_PARTY_QUOTE = "乙方名称为远山律师事务所";
const ASSISTANT_VISIBLE_ANSWER =
  "第一份文件约定甲方三十日内付款[1]；第二份文件约定乙方可在重大违约后解除[2]。";
const WORKFLOW_ANSWER = "工作流已完成本地合同审查。";
const GATE1_MATTER = Object.freeze({
  name: "Vera Gate 1 跨重启交易事项",
  description:
    "验证显式 Matter Profile、真实聚合计数与加密工作区跨重启持久化。",
  workspace_type: "transaction",
  client_name: "晨星科技有限公司",
  jurisdiction: "中华人民共和国",
  represented_role: "买方律师",
  objective: "审阅本地交易材料并保留可追溯的人工复核边界。",
  cm_number: "VERA-G1-2026-001",
  practice: "公司与并购",
});
const GATE1_MATTER_HEALTH = Object.freeze({
  status: "ready",
  schemaVersion: 17,
  inferencePolicy: "minimal_unified",
});
const MATTER_VIEW_KEYS = [
  "capabilities",
  "matter_profile",
  "profile_state",
  "project",
];
const MATTER_PROJECT_KEYS = [
  "archived_at",
  "chat_count",
  "cm_number",
  "created_at",
  "default_model_profile_id",
  "description",
  "document_count",
  "id",
  "name",
  "practice",
  "status",
  "tabular_review_count",
  "updated_at",
  "workflow_count",
];
const MATTER_PROFILE_KEYS = [
  "client_name",
  "created_at",
  "jurisdiction",
  "objective",
  "project_id",
  "represented_role",
  "updated_at",
  "workspace_type",
];
const MATTER_CAPABILITY_KEYS = [
  "assistant",
  "drafts",
  "matter_profile",
  "review",
  "tabular",
  "workflows",
];
const MODEL_PRIVACY_KEYS = [
  "configured",
  "created_at",
  "declaration_basis",
  "execution_location",
  "model_profile_enabled",
  "model_profile_id",
  "retention",
  "sensitive_data_allowed",
  "training_use",
  "updated_at",
];
const MATTER_POLICY_KEYS = [
  "allow_external_legal_sources",
  "allow_word_bridge",
  "created_at",
  "execution_locations",
  "external_egress_mode",
  "project_id",
  "updated_at",
];
const MATTER_AVAILABLE_CAPABILITIES = Object.freeze({
  matter_profile: "edit",
  assistant: "available",
  workflows: "available",
  tabular: "available",
  review: "unavailable",
  drafts: "document_scoped",
});
const MATTER_CLOSED_CAPABILITIES = Object.freeze({
  matter_profile: "edit",
  assistant: "policy_gate_closed",
  workflows: "non_inference_only",
  tabular: "policy_gate_closed",
  review: "unavailable",
  drafts: "document_scoped",
});
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
    if (secret)
      text = text.replace(new RegExp(escapeRegExp(secret), "g"), "[redacted]");
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

function assertExactKeys(value, expected, label) {
  assert.ok(
    value && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object.`,
  );
  assert.deepEqual(
    Object.keys(value).sort(),
    [...expected].sort(),
    `${label} keys drifted.`,
  );
}

function assertIsoTimestamp(value, label) {
  assert.equal(typeof value, "string", `${label} must be a timestamp string.`);
  assert.equal(
    Number.isNaN(Date.parse(value)),
    false,
    `${label} must be a valid timestamp.`,
  );
}

function assertMatterCounts(project, expected) {
  for (const [field, count] of Object.entries(expected)) {
    assert.equal(
      project[field],
      count,
      `Unexpected Matter projection ${field}.`,
    );
  }
}

function assertGate1MatterProjection(
  view,
  projectId,
  counts,
  capabilities = MATTER_AVAILABLE_CAPABILITIES,
) {
  assertExactKeys(view, MATTER_VIEW_KEYS, "Matter view");
  assertExactKeys(
    view.project,
    MATTER_PROJECT_KEYS,
    "Matter project projection",
  );
  assertExactKeys(view.matter_profile, MATTER_PROFILE_KEYS, "Matter Profile");
  assertExactKeys(
    view.capabilities,
    MATTER_CAPABILITY_KEYS,
    "Matter capabilities",
  );

  assert.equal(view.project.id, projectId);
  assert.equal(view.project.name, GATE1_MATTER.name);
  assert.equal(view.project.description, GATE1_MATTER.description);
  assert.equal(view.project.cm_number, GATE1_MATTER.cm_number);
  assert.equal(view.project.practice, GATE1_MATTER.practice);
  assert.equal(view.project.status, "active");
  assert.equal(view.project.default_model_profile_id, null);
  assert.equal(view.project.archived_at, null);
  assertIsoTimestamp(view.project.created_at, "Matter project created_at");
  assertIsoTimestamp(view.project.updated_at, "Matter project updated_at");
  assertMatterCounts(view.project, counts);

  assert.equal(view.matter_profile.project_id, projectId);
  assert.equal(view.matter_profile.workspace_type, GATE1_MATTER.workspace_type);
  assert.equal(view.matter_profile.client_name, GATE1_MATTER.client_name);
  assert.equal(view.matter_profile.jurisdiction, GATE1_MATTER.jurisdiction);
  assert.equal(
    view.matter_profile.represented_role,
    GATE1_MATTER.represented_role,
  );
  assert.equal(view.matter_profile.objective, GATE1_MATTER.objective);
  assertIsoTimestamp(
    view.matter_profile.created_at,
    "Matter Profile created_at",
  );
  assertIsoTimestamp(
    view.matter_profile.updated_at,
    "Matter Profile updated_at",
  );
  assert.equal(view.profile_state, "ready");
  assert.deepEqual(view.capabilities, capabilities);
}

function assertGenericProjectMatterProjection(view, projectId, counts) {
  assertExactKeys(view, MATTER_VIEW_KEYS, "generic Project Matter projection");
  assertExactKeys(
    view.project,
    MATTER_PROJECT_KEYS,
    "generic Project projection",
  );
  assertExactKeys(
    view.capabilities,
    MATTER_CAPABILITY_KEYS,
    "generic Project capabilities",
  );
  assert.equal(view.project.id, projectId);
  assert.equal(view.project.name, "Vera 打包客户端通用项目");
  assert.equal(view.project.status, "active");
  assertMatterCounts(view.project, counts);
  assert.equal(view.matter_profile, null);
  assert.equal(view.profile_state, "absent");
  assert.deepEqual(view.capabilities, {
    matter_profile: "create",
    assistant: "available",
    workflows: "available",
    tabular: "available",
    review: "unavailable",
    drafts: "document_scoped",
  });
}

function assertModelPrivacy(value, modelProfileId) {
  assertExactKeys(value, MODEL_PRIVACY_KEYS, "model privacy declaration");
  assert.equal(value.model_profile_id, modelProfileId);
  assert.equal(value.configured, true);
  assert.equal(value.declaration_basis, "user_or_admin_declared");
  assert.equal(value.model_profile_enabled, true);
  assert.equal(value.execution_location, "confidential_remote");
  assert.equal(value.retention, "zero");
  assert.equal(value.training_use, "prohibited");
  assert.equal(value.sensitive_data_allowed, true);
  assertIsoTimestamp(value.created_at, "model privacy created_at");
  assertIsoTimestamp(value.updated_at, "model privacy updated_at");
}

function assertMatterPolicy(value, projectId) {
  assertExactKeys(value, MATTER_POLICY_KEYS, "Matter Policy");
  assert.equal(value.project_id, projectId);
  assert.equal(value.external_egress_mode, "allowed_by_policy");
  assert.deepEqual(value.execution_locations, ["confidential_remote"]);
  assert.equal(value.allow_external_legal_sources, false);
  assert.equal(value.allow_word_bridge, false);
  assertIsoTimestamp(value.created_at, "Matter Policy created_at");
  assertIsoTimestamp(value.updated_at, "Matter Policy updated_at");
}

function providerCallSnapshot(calls) {
  return {
    probes: calls.probes,
    assistantTurns: calls.assistantTurns,
    assistantToolCalls: calls.assistantToolCalls,
    workflowTurns: calls.workflowTurns,
    tabularTurns: calls.tabularTurns,
    tabularCells: [...calls.tabularCells].sort(),
  };
}

function assertMatterListPage(
  page,
  genericProjectId,
  matterProjectId,
  matterCounts,
) {
  assertExactKeys(page, ["items", "next_cursor"], "Matter list page");
  assert.ok(Array.isArray(page.items), "Matter list items must be an array.");
  assert.equal(
    page.items.length,
    2,
    "The isolated packaged profile must list exactly the created Project and Matter.",
  );
  assert.equal(page.next_cursor, null);
  const generic = page.items.find(
    (item) => item?.project?.id === genericProjectId,
  );
  const matter = page.items.find(
    (item) => item?.project?.id === matterProjectId,
  );
  assert.ok(generic, "Matter list omitted the generic Project projection.");
  assert.ok(matter, "Matter list omitted the classified Matter projection.");
  assertGenericProjectMatterProjection(generic, genericProjectId, {
    document_count: 2,
    chat_count: 1,
    tabular_review_count: 1,
    workflow_count: 1,
  });
  assertGate1MatterProjection(matter, matterProjectId, matterCounts);
  return { generic, matter };
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
  assert.equal(
    await portOpen(frontendPort),
    false,
    "Frontend port is already in use.",
  );
  assert.equal(
    await portOpen(backendPort),
    false,
    "Backend port is already in use.",
  );
}

async function waitForPortsClosed(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await portOpen(frontendPort)) && !(await portOpen(backendPort)))
      return;
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

async function assertGate1MatterHealth() {
  const response = await fetch(`${backendBaseUrl}/health`, {
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(response.status, 200, "Packaged Vera health must be ready.");
  const body = await response.json();
  assert.equal(body?.ok, true);
  assert.deepEqual(
    body?.vera?.matter,
    GATE1_MATTER_HEALTH,
    "Packaged production health must expose the exact Gate 1 Matter contract.",
  );
}

function verifyPrivateWorkspaceDatabase(userDataDir) {
  const databasePath = path.join(userDataDir, "aletheia-data", "aletheia.db");
  const info = fs.lstatSync(databasePath, { throwIfNoEntry: false });
  assert.ok(
    info?.isFile(),
    "The isolated profile must contain its workspace database.",
  );
  assert.equal(
    info.isSymbolicLink(),
    false,
    "The workspace database must not be a symlink.",
  );
  assert.ok(
    info.size > 0,
    "The isolated workspace database must not be empty.",
  );
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
    if (bytes > 2 * 1024 * 1024)
      throw new Error("Mock provider request is too large.");
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

function sendFetchDocumentsCall(response, docIds = ["doc-0", "doc-1"]) {
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
              arguments: JSON.stringify({ doc_ids: docIds }),
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

function sendContractReviewCall(response) {
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
            id: "vera-e2e-run-contract-review",
            type: "function",
            function: {
              name: "run_contract_review",
              arguments: JSON.stringify({ preset: "commercial_agreement" }),
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

function sendToolCall(response, id, name, argumentsValue) {
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
            id,
            type: "function",
            function: { name, arguments: JSON.stringify(argumentsValue) },
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
  assert.ok(
    toolMessage,
    "Assistant final turn must receive a real tool result.",
  );
  const result = JSON.parse(
    toolMessage.content.slice("[Tool result]\n".length),
  );
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
    first.evidence.some((item) =>
      item.text.includes(DOCUMENT_ONE_PAYMENT_QUOTE),
    ),
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
  assert.equal(
    first || second,
    true,
    "Tabular request omitted authoritative text.",
  );
  assert.equal(
    first && second,
    false,
    "A Tabular cell must bind one document.",
  );
  assert.equal(
    party || clause,
    true,
    "Tabular request omitted the column title.",
  );
  assert.equal(party && clause, false, "A Tabular cell must bind one column.");
  const key = `${first ? "alpha" : "beta"}:${party ? "party" : "clause"}`;
  assert.equal(
    calls.tabularCells.has(key),
    false,
    `Duplicate Tabular cell ${key}.`,
  );
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
  assert.ok(
    userContent.includes(quote),
    "Tabular quote must be exact evidence.",
  );
  return JSON.stringify({
    value,
    reasoning: "该结果来自当前文档中的精确文本。",
    flag: "green",
    quotes: [quote],
  });
}

function flagshipTabularAnswer(request, calls) {
  const userContent = request.messages
    .filter((message) => message.role === "user")
    .map((message) => message.content)
    .join("\n");
  const documentKey = userContent.includes("VERA-E2E-ALPHA")
    ? "alpha"
    : userContent.includes("VERA-E2E-BETA")
      ? "beta"
      : userContent.includes("VERA-FLAGSHIP-GAMMA")
        ? "gamma"
        : null;
  assert.ok(documentKey, "Flagship cell omitted its authoritative document.");
  const column = /Column title: ([^\n]+)/.exec(userContent)?.[1]?.trim();
  assert.ok(column, "Flagship cell omitted its preset column title.");
  const key = `${documentKey}:${column}`;
  assert.equal(
    calls.flagshipTabularCells.has(key),
    false,
    `Duplicate flagship Tabular cell ${key}.`,
  );
  calls.flagshipTabularCells.add(key);
  const quote =
    documentKey === "alpha"
      ? DOCUMENT_ONE_PAYMENT_QUOTE
      : documentKey === "beta"
        ? DOCUMENT_TWO_TERMINATION_QUOTE
        : "This Agreement is governed by English law";
  assert.ok(
    userContent.includes(quote),
    "Flagship cell quote must be exact evidence.",
  );
  const valueSchema =
    request.response_format.json_schema?.schema?.properties?.value;
  const value =
    valueSchema?.type === "boolean"
      ? false
      : valueSchema?.type === "number"
        ? 0
        : Array.isArray(valueSchema?.enum)
          ? valueSchema.enum[0]
          : `${documentKey} ${column}: captured from the agreement.`;
  return JSON.stringify({
    value,
    reasoning: "The value is limited to exact reviewed agreement text.",
    flag: "grey",
    quotes: [quote],
  });
}

function generalTabularAnswer(request, calls) {
  const userContent = request.messages
    .filter((message) => message.role === "user")
    .map((message) => message.content)
    .join("\n");
  const documentKey = userContent.includes("VERA-E2E-ALPHA")
    ? "alpha"
    : userContent.includes("VERA-E2E-BETA")
      ? "beta"
      : null;
  assert.ok(
    documentKey,
    "General extraction cell omitted its authoritative document.",
  );
  const column = /Column title: ([^\n]+)/.exec(userContent)?.[1]?.trim();
  assert.ok(column, "General extraction cell omitted its column title.");
  const key = `${documentKey}:${column}`;
  assert.equal(
    calls.generalTabularCells.has(key),
    false,
    `Duplicate general cell ${key}.`,
  );
  calls.generalTabularCells.add(key);
  const quote =
    documentKey === "alpha"
      ? DOCUMENT_ONE_PAYMENT_QUOTE
      : DOCUMENT_TWO_TERMINATION_QUOTE;
  assert.ok(
    userContent.includes(quote),
    "General extraction quote must be exact evidence.",
  );
  return JSON.stringify({
    value: `${documentKey} ${column}: captured from the agreement.`,
    reasoning: "The value is limited to exact reviewed agreement text.",
    flag: "grey",
    quotes: [quote],
  });
}

function generalReviewId(messages) {
  for (const message of messages) {
    if (typeof message?.content !== "string") continue;
    if (!message.content.startsWith("[Tool result]\n")) continue;
    try {
      const result = JSON.parse(
        message.content.slice("[Tool result]\n".length),
      );
      if (typeof result?.review?.review_id === "string")
        return result.review.review_id;
    } catch {
      // Ignore unrelated tool results.
    }
  }
  throw new Error("Timeline memo call did not receive the durable Review ID.");
}

async function createMockProvider(secret) {
  const failures = [];
  const control = {
    holdFlagshipTabular: false,
    holdGeneralTabular: false,
  };
  const heldReleases = new Set();
  const calls = {
    probes: 0,
    assistantTurns: 0,
    assistantToolCalls: 0,
    contractAssistantTurns: 0,
    contractToolCalls: 0,
    workflowTurns: 0,
    tabularTurns: 0,
    tabularCells: new Set(),
    flagshipTabularCells: new Set(),
    generalTabularCells: new Set(),
    flagshipTabularTurns: 0,
    generalTabularTurns: 0,
    heldFlagshipTabularTurns: 0,
    heldGeneralTabularTurns: 0,
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
        const userContent = body.messages
          .filter((message) => message.role === "user")
          .map((message) => message.content)
          .join("\n");
        const requestedColumn =
          /Column title: ([^\n]+)/.exec(userContent)?.[1]?.trim() ?? "";
        const general = [
          ...CUSTOM_EXTRACTION_COLUMNS,
          ...TIMELINE_COLUMNS,
        ].includes(requestedColumn);
        const flagship =
          !general && !["当事方", "核心条款"].includes(requestedColumn);
        if (flagship) calls.flagshipTabularTurns += 1;
        if (general) calls.generalTabularTurns += 1;
        if (
          (flagship && control.holdFlagshipTabular) ||
          (general && control.holdGeneralTabular)
        ) {
          if (flagship) calls.heldFlagshipTabularTurns += 1;
          if (general) calls.heldGeneralTabularTurns += 1;
          await new Promise((resolve) => {
            const release = () => {
              heldReleases.delete(release);
              resolve();
            };
            heldReleases.add(release);
            request.once("aborted", release);
            response.once("close", release);
            setTimeout(release, 30_000);
          });
          if (request.aborted || response.destroyed) return;
        }
        sendTextCompletion(
          response,
          general
            ? generalTabularAnswer(body, calls)
            : flagship
              ? flagshipTabularAnswer(body, calls)
              : tabularAnswer(body, calls),
        );
        return;
      }

      if (Array.isArray(body.tools) && body.tools.length > 0) {
        calls.assistantTurns += 1;
        assert.ok(
          body.tools.some((tool) => tool?.function?.name === "fetch_documents"),
          "Assistant must register fetch_documents.",
        );
        const contractReview = body.messages.some(
          (message) =>
            typeof message?.content === "string" &&
            message.content.includes(FLAGSHIP_PROMPT),
        );
        const timeline = body.messages.some(
          (message) =>
            typeof message?.content === "string" &&
            message.content.includes("事件时间线"),
        );
        const customExtraction = body.messages.some(
          (message) =>
            typeof message?.content === "string" &&
            message.content.includes("字段（名称 | 格式 | 提取说明）："),
        );
        const toolResults = body.messages.filter(
          (message) =>
            typeof message?.content === "string" &&
            message.content.startsWith("[Tool result]\n"),
        );
        if (contractReview) calls.contractAssistantTurns += 1;
        if (contractReview && toolResults.length === 0) {
          calls.assistantToolCalls += 1;
          calls.contractToolCalls += 1;
          assert.ok(
            body.tools.some(
              (tool) => tool?.function?.name === "run_contract_review",
            ),
            "Matter Assistant must register run_contract_review.",
          );
          const system = body.messages.find(
            (message) => message.role === "system",
          );
          assert.match(system?.content ?? "", /doc-0/);
          assert.match(system?.content ?? "", /doc-1/);
          assert.match(system?.content ?? "", /doc-2/);
          sendFetchDocumentsCall(response, ["doc-0", "doc-1", "doc-2"]);
        } else if (contractReview && toolResults.length === 1) {
          calls.assistantToolCalls += 1;
          calls.contractToolCalls += 1;
          const result = JSON.parse(
            toolResults[0].content.slice("[Tool result]\n".length),
          );
          assert.equal(result.documents.length, 3);
          sendContractReviewCall(response);
        } else if (contractReview) {
          const result = JSON.parse(
            toolResults.at(-1).content.slice("[Tool result]\n".length),
          );
          assert.equal(result.review.status, "complete");
          assert.ok(
            result.memo?.draft_id,
            "Completed review must create a Studio memo.",
          );
          sendTextCompletion(response, "合同审阅与风险备忘录已完成。");
        } else if ((timeline || customExtraction) && toolResults.length === 0) {
          calls.assistantToolCalls += 1;
          assert.ok(
            body.tools.some(
              (tool) => tool?.function?.name === "run_custom_extraction",
            ),
            "General Assistant must register run_custom_extraction.",
          );
          sendFetchDocumentsCall(response, ["doc-0", "doc-1"]);
        } else if ((timeline || customExtraction) && toolResults.length === 1) {
          calls.assistantToolCalls += 1;
          if (timeline) {
            sendToolCall(
              response,
              "vera-e2e-timeline",
              "run_custom_extraction",
              {
                mode: "timeline",
                title: "Matter Timeline",
              },
            );
          } else {
            sendToolCall(response, "vera-e2e-custom", "run_custom_extraction", {
              mode: "custom",
              title: "Matter Custom Extraction",
              columns: CUSTOM_EXTRACTION_COLUMNS.map((name) => ({
                name,
                instruction: `Extract ${name} only from the attached evidence.`,
              })),
            });
          }
        } else if (timeline && toolResults.length === 2) {
          calls.assistantToolCalls += 1;
          const reviewId = generalReviewId(toolResults);
          sendToolCall(
            response,
            "vera-e2e-timeline-memo",
            "create_memo_from_tabular_review",
            { review_id: reviewId, title: "Matter Timeline Facts Memo" },
          );
        } else if (timeline) {
          const result = JSON.parse(
            toolResults.at(-1).content.slice("[Tool result]\n".length),
          );
          assert.ok(
            result.memo?.draft_id,
            "Timeline must create a Draft from its Review.",
          );
          sendTextCompletion(response, "案件时间线和事实摘要已完成。");
        } else if (customExtraction) {
          sendTextCompletion(
            response,
            "自定义信息提取已完成，可查看并导出结构化表格。",
          );
        } else if (toolResults.length === 0) {
          calls.assistantToolCalls += 1;
          const system = body.messages.find(
            (message) => message.role === "system",
          );
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
        response.end(
          JSON.stringify({ error: { message: "mock_provider_failed" } }),
        );
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
    setHoldFlagshipTabular(value) {
      control.holdFlagshipTabular = value === true;
      if (!control.holdFlagshipTabular) {
        for (const release of [...heldReleases]) release();
      }
    },
    setHoldGeneralTabular(value) {
      control.holdGeneralTabular = value === true;
      if (!control.holdGeneralTabular) {
        for (const release of [...heldReleases]) release();
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      control.holdFlagshipTabular = false;
      control.holdGeneralTabular = false;
      for (const release of [...heldReleases]) release();
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
    throw new Error(
      `Local API response for ${route} exceeded the test budget.`,
    );
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
    throw new Error(
      `Local API response for ${route} exceeded the test budget.`,
    );
  }
  return { response, text };
}

async function apiBytes(token, route, options = {}) {
  const response = await apiResponse(token, route, options);
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > MAX_RESPONSE_BYTES) {
    throw new Error(
      `Local API response for ${route} exceeded the test budget.`,
    );
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_RESPONSE_BYTES) {
    throw new Error(
      `Local API response for ${route} exceeded the test budget.`,
    );
  }
  return { response, bytes };
}

async function waitForCompletedReview(token, reviewId, label) {
  return pollUntil(label, async () => {
    const detail = await apiJson(token, `/tabular-review/${reviewId}`);
    const status = detail.review.status;
    if (status === "queued" || status === "running") return undefined;
    assert.equal(status, "complete", `${label} reached ${status}.`);
    return detail;
  });
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

async function assertTopNavigation(page) {
  const navigation = await page.locator("#vera-sidebar").evaluate((sidebar) => {
    const variants = [
      ["助手", "Assistant"],
      ["事项", "Matters"],
      ["工作流", "Workflows"],
      ["复核", "Review"],
      ["设置", "Settings"],
    ];
    const oldTopLevelLabels = new Set(["项目", "Projects", "表格", "Tabular"]);
    const buttons = [...sidebar.querySelectorAll(":scope > div > button")];
    const entries = buttons
      .map((button) => {
        const text = (button.textContent ?? "").replace(/\s+/g, " ").trim();
        const title = (button.getAttribute("title") ?? "").trim();
        const label = text || title;
        const index = variants.findIndex((labels) => labels.includes(label));
        return {
          index,
          label,
          disabled: button.disabled,
          ariaDisabled: button.getAttribute("aria-disabled"),
        };
      })
      .filter((entry) => entry.index >= 0);
    return {
      entries,
      oldTopLevelLabels: buttons
        .map(
          (button) =>
            (button.textContent ?? "").replace(/\s+/g, " ").trim() ||
            (button.getAttribute("title") ?? "").trim(),
        )
        .filter((label) => oldTopLevelLabels.has(label)),
    };
  });
  assert.deepEqual(
    navigation.entries.map((entry) => entry.index),
    [0, 1, 2, 3, 4],
    "The packaged top-level navigation must be Assistant, Matters, Workflows, Review, Settings in exact order.",
  );
  assert.deepEqual(
    navigation.oldTopLevelLabels,
    [],
    "Projects and Tabular must not remain top-level navigation items.",
  );
  const review = navigation.entries[3];
  assert.equal(review.disabled, true, "Gate 1 Review must remain disabled.");
  assert.equal(
    review.ariaDisabled,
    "true",
    "Gate 1 Review must expose truthful disabled semantics.",
  );
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
  assert.match(await page.locator("#vera-sidebar").innerText(), /Vera/);
  await assertTopNavigation(page);
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

async function assertMattersListRenderer(page) {
  await navigateAndAssertVisibleText(page, "/matters", [
    "Vera 打包客户端通用项目",
    GATE1_MATTER.name,
    GATE1_MATTER.client_name,
    GATE1_MATTER.jurisdiction,
    GATE1_MATTER.cm_number,
    GATE1_MATTER.practice,
  ]);
  const visible = await page.locator("body").innerText();
  assert.match(visible, /法律事项|Legal Matters/);
  assert.match(visible, /普通项目|Generic Projects/);
  await assertTopNavigation(page);
}

async function assertMatterNavigation(page, projectId) {
  const navigation = page.locator(
    'nav[aria-label="事项工作区"], nav[aria-label="Matter workspace"]',
  );
  await navigation.waitFor({ state: "visible", timeout: 90_000 });
  const entries = await navigation.evaluate((element) => {
    const variants = [
      ["概览", "Overview"],
      ["文档", "Documents"],
      ["助手", "Assistant"],
      ["复核", "Review"],
      ["工作流", "Workflows"],
      ["草稿", "Drafts"],
      ["设置", "Settings"],
    ];
    return [...element.children].map((child) => {
      const text = (child.textContent ?? "").replace(/\s+/g, " ").trim();
      const index = variants.findIndex((labels) =>
        labels.some((label) => text.startsWith(label)),
      );
      return {
        index,
        tag: child.tagName,
        disabled: "disabled" in child ? child.disabled : false,
        ariaDisabled: child.getAttribute("aria-disabled"),
        ariaCurrent: child.getAttribute("aria-current"),
        href: child.getAttribute("href"),
        title: child.getAttribute("title") ?? "",
      };
    });
  });
  assert.deepEqual(
    entries.map((entry) => entry.index),
    [0, 1, 2, 3, 4, 5, 6],
    "Matter navigation must be Overview, Documents, Assistant, Review, Workflows, Drafts, Settings in exact order.",
  );
  assert.equal(entries[0].tag, "A");
  assert.equal(entries[0].ariaCurrent, "page");
  assert.equal(entries[0].href, `/matters/${projectId}`);
  assert.equal(entries[1].tag, "A");
  assert.equal(entries[1].href, `/matters/${projectId}/documents`);
  assert.equal(entries[2].tag, "A");
  assert.equal(entries[2].href, `/matters/${projectId}/assistant`);
  assert.equal(entries[3].tag, "A");
  assert.equal(entries[3].href, `/matters/${projectId}/review`);
  assert.equal(entries[4].tag, "A");
  assert.equal(entries[4].href, `/matters/${projectId}/workflows`);
  assert.equal(entries[5].tag, "A");
  assert.equal(entries[5].href, `/matters/${projectId}/drafts`);
  assert.equal(entries[6].tag, "A");
  assert.equal(entries[6].href, `/matters/${projectId}/settings`);
}

async function assertMatterRenderer(page, projectId) {
  await navigateAndAssertVisibleText(page, `/matters/${projectId}`, [
    GATE1_MATTER.name,
    GATE1_MATTER.description,
    GATE1_MATTER.client_name,
    GATE1_MATTER.jurisdiction,
    GATE1_MATTER.represented_role,
    GATE1_MATTER.objective,
    GATE1_MATTER.cm_number,
    GATE1_MATTER.practice,
  ]);
  const visible = await page.locator("body").innerText();
  assert.doesNotMatch(
    visible,
    /事项推理策略尚未配置|Matter inference policy is not configured/,
  );
  await assertMatterNavigation(page, projectId);
  await assertTopNavigation(page);
}

async function assertAssistantRenderer(
  page,
  projectId,
  chatId,
  kind = "project",
) {
  const route =
    kind === "matter"
      ? `/matters/${projectId}/assistant/chat/${chatId}`
      : `/projects/${projectId}/assistant/chat/${chatId}`;
  await navigateAndAssertVisibleText(page, route, [
    "第一份文件约定甲方三十日内付款",
    "第二份文件约定乙方可在重大违约后解除",
    "alpha-contract.txt",
    "beta-contract.txt",
  ]);
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
      const controls = [
        ...document.querySelectorAll("input, textarea, select"),
      ];
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

async function startFlagshipContractReviewInUi(page, projectId) {
  await navigateAndAssertVisibleText(page, `/matters/${projectId}/assistant`, [
    "新建对话",
  ]);
  const emptyChatNavigation = page.waitForURL(
    (url) => url.pathname.startsWith(`/matters/${projectId}/assistant/chat/`),
    { timeout: 90_000 },
  );
  await page.getByRole("button", { name: /新建对话|New chat/ }).click();
  await emptyChatNavigation;
  await page
    .getByRole("button", { name: /审查一批合同|Review contracts/ })
    .waitFor({
      state: "visible",
      timeout: 90_000,
    });
  await page
    .getByRole("button", { name: /审查一批合同|Review contracts/ })
    .click();
  const textarea = page.locator("textarea");
  await textarea.waitFor({ state: "visible", timeout: 90_000 });
  assert.equal(await textarea.inputValue(), FLAGSHIP_PROMPT);
  for (const filename of FLAGSHIP_DOCUMENTS) {
    const checkbox = page
      .locator("label", { hasText: filename })
      .locator('input[type="checkbox"]');
    await checkbox.check();
  }
  await page.getByRole("button", { name: /添加.*3|Add \(3\)/ }).click();
  for (const filename of FLAGSHIP_DOCUMENTS) {
    await page.getByText(filename, { exact: true }).last().waitFor({
      state: "visible",
      timeout: 30_000,
    });
  }
  const chatNavigation = page.waitForURL(
    (url) => url.pathname.startsWith(`/matters/${projectId}/assistant/chat/`),
    { timeout: 90_000 },
  );
  await page.getByRole("button", { name: /发送|Send/ }).click();
  await chatNavigation;
  const chatId = new URL(page.url()).pathname.split("/").at(-1);
  assert.match(chatId ?? "", /^[0-9a-f-]{36}$/i);
  return chatId;
}

async function selectAssistantDocuments(page, filenames) {
  for (const filename of filenames) {
    await page
      .locator("label", { hasText: filename })
      .locator('input[type="checkbox"]')
      .check();
  }
  await page
    .getByRole("button", {
      name: new RegExp(
        `添加.*${filenames.length}|Add \\(${filenames.length}\\)`,
      ),
    })
    .click();
  for (const filename of filenames) {
    await page.getByText(filename, { exact: true }).last().waitFor({
      state: "visible",
      timeout: 30_000,
    });
  }
}

async function startGeneralExtractionInUi(page, projectId, kind) {
  await navigateAndAssertVisibleText(page, `/matters/${projectId}/assistant`, [
    "新建对话",
  ]);
  const emptyChatNavigation = page.waitForURL(
    (url) => url.pathname.startsWith(`/matters/${projectId}/assistant/chat/`),
    { timeout: 90_000 },
  );
  await page.getByRole("button", { name: /新建对话|New chat/ }).click();
  await emptyChatNavigation;
  const timeline = kind === "timeline";
  await page
    .getByRole("button", {
      name: timeline
        ? /整理案件时间线|Build a case timeline/
        : /自定义信息提取|Extract information/,
    })
    .click();
  if (!timeline) {
    await page
      .getByRole("dialog")
      .waitFor({ state: "visible", timeout: 30_000 });
    await page
      .getByRole("button", { name: /生成提取提示|Prepare extraction/ })
      .click();
  }
  const textarea = page.locator("textarea");
  await textarea.waitFor({ state: "visible", timeout: 30_000 });
  const prompt = await textarea.inputValue();
  assert.match(
    prompt,
    timeline
      ? /事件时间线|case timeline/i
      : /字段（名称 \| 格式 \| 提取说明）：|Fields \(name \| format \| instruction\):/,
  );
  await selectAssistantDocuments(page, FLAGSHIP_DOCUMENTS.slice(0, 2));
  const chatNavigation = page.waitForURL(
    (url) => url.pathname.startsWith(`/matters/${projectId}/assistant/chat/`),
    { timeout: 90_000 },
  );
  await page.getByRole("button", { name: /发送|Send/ }).click();
  await chatNavigation;
  const chatId = new URL(page.url()).pathname.split("/").at(-1);
  assert.match(chatId ?? "", /^[0-9a-f-]{36}$/i);
  return chatId;
}

async function assertGeneralTaskPlan(page, expectDraft) {
  const steps = [
    "Inspect the relevant sources",
    "Create the tabular review",
    ...(expectDraft ? ["Create the legal draft"] : []),
    "Check deliverables and report results",
  ];
  for (const title of steps) {
    await page.getByText(title, { exact: true }).waitFor({
      state: "visible",
      timeout: 30_000,
    });
  }
}

async function assertUiDownload(page, responseMatch, click, extension, mime) {
  await page.evaluate(() => {
    window.__veraPackagedE2eDownloads = [];
    window.__veraPackagedE2eDownloadBlobs = [];
    if (window.__veraPackagedE2eDownloadCaptureInstalled) return;
    window.__veraPackagedE2eDownloadCaptureInstalled = true;
    const originalCreateObjectUrl = URL.createObjectURL;
    URL.createObjectURL = function veraPackagedE2eCreateObjectUrl(value) {
      const href = originalCreateObjectUrl.call(URL, value);
      if (value instanceof Blob) {
        const capture = {
          href,
          mime: value.type,
          size: value.size,
          signature: null,
        };
        window.__veraPackagedE2eDownloadBlobs.push(capture);
        void value
          .slice(0, 4)
          .arrayBuffer()
          .then((buffer) => {
            capture.signature = [...new Uint8Array(buffer)]
              .map((byte) => byte.toString(16).padStart(2, "0"))
              .join("");
          });
      }
      return href;
    };
    const originalClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function veraPackagedE2eClick() {
      window.__veraPackagedE2eDownloads.push({
        filename: this.download,
        href: this.href,
      });
      return originalClick.call(this);
    };
  });
  const [response] = await Promise.all([
    page.waitForResponse(responseMatch, { timeout: 90_000 }),
    click(),
  ]);
  assert.match(response.headers()["content-type"] ?? "", mime);
  assert.match(response.headers()["content-disposition"] ?? "", extension);
  await page.waitForFunction(
    () =>
      window.__veraPackagedE2eDownloads.length > 0 &&
      window.__veraPackagedE2eDownloadBlobs.at(-1)?.signature !== null,
    null,
    { timeout: 30_000 },
  );
  const captured = await page.evaluate(() => ({
    download: window.__veraPackagedE2eDownloads.at(-1),
    blob: window.__veraPackagedE2eDownloadBlobs.at(-1),
  }));
  assert.match(captured.download.filename, extension);
  assert.match(captured.download.href, /^blob:/);
  assert.equal(captured.download.href, captured.blob.href);
  assert.ok(captured.blob.size > 4);
  assert.match(captured.blob.mime, mime);
  assert.equal(captured.blob.signature, "504b0304");
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
    VERA_ENABLE_LEGACY_ROUTES: "false",
    VERA_ENABLE_LEGACY_RUNTIME: "false",
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

async function launchPackagedVera(
  userDataDir,
  applicationMasterKey,
  databaseKey,
) {
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
  if (process.platform !== "darwin")
    throw new Error("This audit requires macOS.");
  fs.accessSync(executablePath, fs.constants.X_OK);
  await assertPortsFree();
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "vera-packaged-workspace-e2e-"),
  );
  fs.chmodSync(root, 0o700);
  evidencePath =
    process.env.VERA_PACKAGED_E2E_EVIDENCE_PATH ??
    path.join(root, "evidence.png");
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  fs.rmSync(evidencePath, { force: true });
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
  let gate1MatterId = null;
  let gate1MatterChatId = null;
  let gate1MatterDocumentIds = [];
  let gate1MatterAssistantDocumentIds = [];
  let gate1MatterSourceIds = [];
  let gate1MatterChatBeforeRestart = null;
  let flagshipReviewId = null;
  let flagshipMemoDocumentId = null;
  let flagshipReviewBeforeRestart = null;
  let flagshipMemoBeforeRestart = null;
  let customExtractionReviewId = null;
  let customExtractionReviewBeforeRestart = null;
  let timelineReviewId = null;
  let timelineReviewBeforeRestart = null;
  let timelineMemoDocumentId = null;
  let timelineMemoBeforeRestart = null;
  let cancelledCustomExtractionReviewId = null;
  let gate1MatterSourcesBeforeRestart = null;
  let gate1MatterBeforeRestart = null;
  let gate1MatterPolicyBeforeRestart = null;
  let modelPrivacyBeforeRestart = null;
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
    await assertGate1MatterHealth();
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
    model = await apiJson(
      token,
      `/model-profiles/${modelProfileId}/credential`,
      {
        method: "PUT",
        json: { secret: providerSecret },
      },
    );
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
    modelPrivacyBeforeRestart = await apiJson(
      token,
      `/model-profiles/${modelProfileId}/privacy`,
      {
        method: "PATCH",
        json: {
          // The policy declaration is explicit. It deliberately does not infer
          // execution locality from this test's loopback mock provider URL.
          execution_location: "confidential_remote",
          retention: "zero",
          training_use: "prohibited",
          sensitive_data_allowed: true,
        },
      },
    );
    assertModelPrivacy(modelPrivacyBeforeRestart, modelProfileId);

    const project = await apiJson(token, "/projects", {
      method: "POST",
      json: {
        name: "Vera 打包客户端通用项目",
        description:
          "验证 Project 作为文档、助手、工作流和表格的通用本地容器。",
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
      for (const document of documents.filter((item) =>
        documentIds.includes(item.id),
      )) {
        if (document.status === "error") {
          throw new Error("A packaged TXT document failed local parsing.");
        }
      }
      return documentIds.every(
        (id) =>
          documents.find((document) => document.id === id)?.status === "ready",
      )
        ? documents.filter((document) => documentIds.includes(document.id))
        : undefined;
    });
    assert.equal(readyDocuments.length, 2);

    const acceptedAssistant = await apiJson(
      token,
      `/projects/${project.id}/chat`,
      {
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
      },
    );
    await pollUntil("Assistant generation", async () => {
      const job = await apiJson(
        token,
        `/assistant/jobs/${acceptedAssistant.job_id}`,
      );
      if (!job.terminal) return undefined;
      assert.equal(
        job.status,
        "complete",
        "Assistant generation did not complete.",
      );
      return job;
    });
    const chat = await apiJson(token, `/chat/${acceptedAssistant.chat_id}`);
    const assistantMessage = chat.messages.find(
      (message) => message.role === "assistant",
    );
    assert.ok(assistantMessage);
    assert.equal(
      assistantMessageText(assistantMessage),
      ASSISTANT_VISIBLE_ANSWER,
    );
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
    const definition = await apiJson(
      token,
      `/workflows/${workflow.id}/definition`,
      {
        method: "PUT",
        json: definitionInput,
      },
    );
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
      assert.equal(
        detail.run.status,
        "complete",
        "Workflow run did not complete.",
      );
      return detail;
    });
    assert.equal(workflowRun.steps.length, 2);
    assert.deepEqual(
      workflowRun.steps.map((step) => [
        step.step.id,
        step.step.kind,
        step.status,
      ]),
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
    const generated = await apiText(
      token,
      `/tabular-review/${tabular.id}/generate`,
      {
        method: "POST",
        json: {},
        timeoutMs: POLL_TIMEOUT_MS,
      },
    );
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
          (source) =>
            typeof source.quote === "string" && source.quote.length > 0,
        ),
      ),
    );

    const csv = await apiBytes(
      token,
      `/tabular-review/${tabular.id}/export.csv`,
    );
    assert.match(csv.response.headers.get("content-type") ?? "", /^text\/csv/);
    assert.match(
      csv.response.headers.get("content-disposition") ?? "",
      /\.csv/,
    );
    const csvText = csv.bytes.toString("utf8");
    assert.match(csvText, /晨星科技/);
    assert.match(csvText, /远山律师事务所/);
    const xlsx = await apiBytes(
      token,
      `/tabular-review/${tabular.id}/export.xlsx`,
    );
    assert.match(
      xlsx.response.headers.get("content-type") ?? "",
      /spreadsheetml\.sheet/,
    );
    assert.match(
      xlsx.response.headers.get("content-disposition") ?? "",
      /\.xlsx/,
    );
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

    const gate1Matter = await apiJson(token, "/matters", {
      method: "POST",
      json: GATE1_MATTER,
      expected: [201],
    });
    gate1MatterId = gate1Matter.project.id;
    assertGate1MatterProjection(
      gate1Matter,
      gate1Matter.project.id,
      {
        document_count: 0,
        chat_count: 0,
        tabular_review_count: 0,
        workflow_count: 0,
      },
      MATTER_CLOSED_CAPABILITIES,
    );

    const matterDefaults = await apiJson(token, "/settings", {
      method: "PATCH",
      json: {
        default_model_profile_id: modelProfileId,
        default_project_id: gate1MatterId,
      },
    });
    assert.equal(matterDefaults.default_model_profile_id, modelProfileId);
    assert.equal(matterDefaults.default_project_id, gate1MatterId);

    gate1MatterPolicyBeforeRestart = await apiJson(
      token,
      `/matters/${gate1MatterId}/policy`,
      {
        method: "PATCH",
        json: {
          external_egress_mode: "allowed_by_policy",
          execution_locations: ["confidential_remote"],
          allow_external_legal_sources: false,
          allow_word_bridge: false,
        },
      },
    );
    assertMatterPolicy(gate1MatterPolicyBeforeRestart, gate1MatterId);

    const enabledGate1Matter = await apiJson(
      token,
      `/matters/${gate1MatterId}`,
    );
    assertGate1MatterProjection(enabledGate1Matter, gate1MatterId, {
      document_count: 0,
      chat_count: 0,
      tabular_review_count: 0,
      workflow_count: 0,
    });
    assert.equal(
      enabledGate1Matter.project.default_model_profile_id,
      null,
      "The Matter projection keeps the Project override null while the existing Settings owner supplies the effective Workspace default.",
    );

    const matterFirstUpload = await uploadTextDocument(
      token,
      gate1MatterId,
      "alpha-contract.txt",
      DOCUMENT_ONE,
    );
    const matterSecondUpload = await uploadTextDocument(
      token,
      gate1MatterId,
      "beta-contract.txt",
      DOCUMENT_TWO,
    );
    const matterThirdUpload = await uploadTextDocument(
      token,
      gate1MatterId,
      "gamma-contract.txt",
      DOCUMENT_THREE,
    );
    gate1MatterDocumentIds = [
      matterFirstUpload.document.id,
      matterSecondUpload.document.id,
      matterThirdUpload.document.id,
    ];
    gate1MatterAssistantDocumentIds = gate1MatterDocumentIds.slice(0, 2);
    await pollUntil("Matter documents", async () => {
      const documents = await apiJson(
        token,
        `/projects/${gate1MatterId}/documents?limit=100`,
      );
      for (const document of documents.filter((item) =>
        gate1MatterDocumentIds.includes(item.id),
      )) {
        if (document.status === "error") {
          throw new Error(
            "A packaged Matter TXT document failed local parsing.",
          );
        }
      }
      return gate1MatterDocumentIds.every(
        (id) =>
          documents.find((document) => document.id === id)?.status === "ready",
      )
        ? documents
        : undefined;
    });
    for (const documentId of gate1MatterDocumentIds) {
      const captured = await apiJson(
        token,
        `/projects/${gate1MatterId}/sources/document-snapshots`,
        {
          method: "POST",
          json: { document_id: documentId },
          expected: [200, 201],
        },
      );
      assert.equal(captured.snapshot.project_id, gate1MatterId);
      assert.equal(captured.snapshot.kind, "project_document");
      assert.equal(captured.snapshot.source_record_id, documentId);
      assert.equal(captured.snapshot.license.basis, "user_provided");
      assert.equal(captured.snapshot.license.model_use, "permitted");
      gate1MatterSourceIds.push(captured.snapshot.id);
    }

    const callsBeforeMatterInference = providerCallSnapshot(mock.calls);
    const acceptedMatterAssistant = await apiJson(
      token,
      `/projects/${gate1MatterId}/chat`,
      {
        method: "POST",
        json: {
          messages: [
            {
              role: "user",
              content:
                "请为当前事项比较两份合同中的付款和解除约定，并给出精确引用。",
            },
          ],
          model_profile_id: modelProfileId,
          attached_documents: [
            {
              filename: "alpha-contract.txt",
              document_id: gate1MatterAssistantDocumentIds[0],
            },
            {
              filename: "beta-contract.txt",
              document_id: gate1MatterAssistantDocumentIds[1],
            },
          ],
        },
        expected: [202],
      },
    );
    gate1MatterChatId = acceptedMatterAssistant.chat_id;
    await pollUntil("Matter Assistant generation", async () => {
      const job = await apiJson(
        token,
        `/assistant/jobs/${acceptedMatterAssistant.job_id}`,
      );
      if (!job.terminal) return undefined;
      assert.equal(
        job.status,
        "complete",
        "Matter Assistant generation did not complete.",
      );
      return job;
    });
    assert.equal(
      mock.calls.assistantTurns,
      callsBeforeMatterInference.assistantTurns + 2,
      "Matter Assistant must reach the provider for its tool and final turns.",
    );
    assert.equal(
      mock.calls.assistantToolCalls,
      callsBeforeMatterInference.assistantToolCalls + 1,
      "Matter Assistant must execute a real document tool call.",
    );
    const matterChat = await apiJson(token, `/chat/${gate1MatterChatId}`);
    gate1MatterChatBeforeRestart = matterChat;
    const matterAssistantMessage = matterChat.messages.find(
      (message) => message.role === "assistant",
    );
    assert.ok(matterAssistantMessage);
    assert.equal(
      assistantMessageText(matterAssistantMessage),
      ASSISTANT_VISIBLE_ANSWER,
    );
    assert.deepEqual(
      matterAssistantMessage.citations
        .map((citation) => citation.document_id)
        .sort(),
      [...gate1MatterAssistantDocumentIds].sort(),
    );
    assert.deepEqual(
      matterAssistantMessage.citations.map((citation) => citation.quote),
      [DOCUMENT_ONE_PAYMENT_QUOTE, DOCUMENT_TWO_TERMINATION_QUOTE],
    );
    gate1MatterSourcesBeforeRestart = await apiJson(
      token,
      `/projects/${gate1MatterId}/sources?limit=100`,
    );
    assert.deepEqual(
      gate1MatterSourcesBeforeRestart.sources.map((source) => source.id).sort(),
      [...gate1MatterSourceIds].sort(),
    );

    gate1MatterBeforeRestart = await apiJson(
      token,
      `/matters/${gate1MatterId}`,
    );
    assertGate1MatterProjection(gate1MatterBeforeRestart, gate1MatterId, {
      document_count: 3,
      chat_count: 1,
      tabular_review_count: 0,
      workflow_count: 0,
    });
    const matterListBeforeRestart = await apiJson(token, "/matters?limit=100");
    const listedBeforeRestart = assertMatterListPage(
      matterListBeforeRestart,
      project.id,
      gate1MatterId,
      {
        document_count: 3,
        chat_count: 1,
        tabular_review_count: 0,
        workflow_count: 0,
      },
    );
    assert.deepEqual(listedBeforeRestart.matter, gate1MatterBeforeRestart);
    await assertMattersListRenderer(packaged.page);
    await assertMatterRenderer(packaged.page, gate1MatterId);
    await assertAssistantRenderer(
      packaged.page,
      gate1MatterId,
      gate1MatterChatId,
      "matter",
    );

    const flagshipChatId = await startFlagshipContractReviewInUi(
      packaged.page,
      gate1MatterId,
    );
    const reviewCard = packaged.page.locator(
      '[data-testid^="assistant-review-result-"]',
    );
    const draftCard = packaged.page.locator(
      '[data-testid^="assistant-draft-result-"]',
    );
    await reviewCard.waitFor({ state: "visible", timeout: POLL_TIMEOUT_MS });
    await draftCard.waitFor({ state: "visible", timeout: POLL_TIMEOUT_MS });
    flagshipReviewId = (await reviewCard.getAttribute("data-testid"))?.replace(
      "assistant-review-result-",
      "",
    );
    flagshipMemoDocumentId = (
      await draftCard.getAttribute("data-testid")
    )?.replace("assistant-draft-result-", "");
    assert.match(flagshipReviewId ?? "", /^[0-9a-f-]{36}$/i);
    assert.match(flagshipMemoDocumentId ?? "", /^[0-9a-f-]{36}$/i);
    const flagshipReview = await waitForCompletedReview(
      token,
      flagshipReviewId,
      "Flagship contract Review",
    );
    assert.equal(flagshipReview.review.document_ids.length, 3);
    assert.equal(flagshipReview.cells.length, 54);
    assert.ok(flagshipReview.cells.every((cell) => cell.status === "done"));
    assert.ok(flagshipReview.cells.every((cell) => cell.sources.length >= 1));
    flagshipReviewBeforeRestart = flagshipReview;
    flagshipMemoBeforeRestart = await apiJson(
      token,
      `/projects/${gate1MatterId}/studio/documents/${flagshipMemoDocumentId}`,
    );

    await reviewCard
      .getByRole("button", { name: /打开 Review|Open Review/ })
      .click();
    await packaged.page.waitForURL(
      (url) =>
        url.pathname ===
          `/matters/${gate1MatterId}/review/${flagshipReviewId}` ||
        url.pathname ===
          `/projects/${gate1MatterId}/tabular-reviews/${flagshipReviewId}`,
      { timeout: 90_000 },
    );
    const actions = packaged.page.getByRole("button", {
      name: /表格审阅操作|Tabular review actions/,
    });
    await actions.click();
    await assertUiDownload(
      packaged.page,
      (response) =>
        response
          .url()
          .includes(`/tabular-review/${flagshipReviewId}/export.xlsx`) &&
        response.status() === 200,
      () =>
        packaged.page
          .getByRole("menuitem", { name: /导出 XLSX|Export XLSX/ })
          .click(),
      /\.xlsx$/i,
      /spreadsheetml\.sheet/,
    );

    await navigateAndAssertVisibleText(
      packaged.page,
      `/matters/${gate1MatterId}/assistant/chat/${flagshipChatId}`,
      ["合同审阅与风险备忘录已完成。"],
    );
    await packaged.page
      .locator(
        `[data-testid="assistant-draft-result-${flagshipMemoDocumentId}"]`,
      )
      .getByRole("button", { name: /打开文稿|Open Draft/ })
      .click();
    await packaged.page.waitForURL(
      (url) =>
        url.pathname.includes(`/documents/${flagshipMemoDocumentId}/studio`),
      { timeout: 90_000 },
    );
    await assertUiDownload(
      packaged.page,
      (response) =>
        response
          .url()
          .includes(
            `/projects/${gate1MatterId}/studio/documents/${flagshipMemoDocumentId}/export-docx`,
          ) && response.status() === 200,
      () =>
        packaged.page
          .getByRole("button", { name: /导出 DOCX|Export DOCX/ })
          .click(),
      /\.docx$/i,
      /wordprocessingml\.document/,
    );

    const customExtractionChatId = await startGeneralExtractionInUi(
      packaged.page,
      gate1MatterId,
      "custom",
    );
    const customReviewCard = packaged.page.locator(
      '[data-testid^="assistant-review-result-"]',
    );
    await customReviewCard.waitFor({
      state: "visible",
      timeout: POLL_TIMEOUT_MS,
    });
    customExtractionReviewId = (
      await customReviewCard.getAttribute("data-testid")
    )?.replace("assistant-review-result-", "");
    assert.match(customExtractionReviewId ?? "", /^[0-9a-f-]{36}$/i);
    const customExtractionReview = await waitForCompletedReview(
      token,
      customExtractionReviewId,
      "Custom extraction Review",
    );
    assert.deepEqual(
      customExtractionReview.review.document_ids.sort(),
      gate1MatterDocumentIds.slice(0, 2).sort(),
    );
    assert.equal(customExtractionReview.cells.length, 12);
    assert.ok(
      customExtractionReview.cells.every((cell) => cell.status === "done"),
    );
    assert.ok(
      customExtractionReview.cells.every((cell) => cell.sources.length >= 1),
    );
    customExtractionReviewBeforeRestart = customExtractionReview;
    await customReviewCard
      .getByRole("button", { name: /打开 Review|Open Review/ })
      .click();
    await packaged.page.waitForURL(
      (url) =>
        url.pathname ===
        `/matters/${gate1MatterId}/review/${customExtractionReviewId}`,
      { timeout: 90_000 },
    );
    await navigateAndAssertVisibleText(
      packaged.page,
      `/matters/${gate1MatterId}/assistant/chat/${customExtractionChatId}`,
      ["自定义信息提取已完成"],
    );
    await assertGeneralTaskPlan(packaged.page, false);
    const persistedCustomReviewCard = packaged.page.locator(
      `[data-testid="assistant-review-result-${customExtractionReviewId}"]`,
    );
    await assertUiDownload(
      packaged.page,
      (response) =>
        response
          .url()
          .includes(
            `/tabular-review/${customExtractionReviewId}/export.xlsx`,
          ) && response.status() === 200,
      () =>
        persistedCustomReviewCard
          .getByRole("button", { name: /导出 XLSX|Export XLSX/ })
          .click(),
      /\.xlsx$/i,
      /spreadsheetml\.sheet/,
    );

    const timelineChatId = await startGeneralExtractionInUi(
      packaged.page,
      gate1MatterId,
      "timeline",
    );
    const timelineReviewCard = packaged.page.locator(
      '[data-testid^="assistant-review-result-"]',
    );
    const timelineDraftCard = packaged.page.locator(
      '[data-testid^="assistant-draft-result-"]',
    );
    await timelineReviewCard.waitFor({
      state: "visible",
      timeout: POLL_TIMEOUT_MS,
    });
    await timelineDraftCard.waitFor({
      state: "visible",
      timeout: POLL_TIMEOUT_MS,
    });
    timelineReviewId = (
      await timelineReviewCard.getAttribute("data-testid")
    )?.replace("assistant-review-result-", "");
    timelineMemoDocumentId = (
      await timelineDraftCard.getAttribute("data-testid")
    )?.replace("assistant-draft-result-", "");
    assert.match(timelineReviewId ?? "", /^[0-9a-f-]{36}$/i);
    assert.match(timelineMemoDocumentId ?? "", /^[0-9a-f-]{36}$/i);
    const timelineReview = await waitForCompletedReview(
      token,
      timelineReviewId,
      "Timeline Review",
    );
    assert.equal(timelineReview.cells.length, 14);
    assert.ok(timelineReview.cells.every((cell) => cell.status === "done"));
    assert.ok(timelineReview.cells.every((cell) => cell.sources.length >= 1));
    timelineReviewBeforeRestart = timelineReview;
    timelineMemoBeforeRestart = await apiJson(
      token,
      `/projects/${gate1MatterId}/studio/documents/${timelineMemoDocumentId}`,
    );
    await timelineReviewCard
      .getByRole("button", { name: /打开 Review|Open Review/ })
      .click();
    await packaged.page.waitForURL(
      (url) =>
        url.pathname === `/matters/${gate1MatterId}/review/${timelineReviewId}`,
      { timeout: 90_000 },
    );
    await navigateAndAssertVisibleText(
      packaged.page,
      `/matters/${gate1MatterId}/assistant/chat/${timelineChatId}`,
      ["案件时间线和事实摘要已完成。"],
    );
    await assertGeneralTaskPlan(packaged.page, true);
    const persistedTimelineReviewCard = packaged.page.locator(
      `[data-testid="assistant-review-result-${timelineReviewId}"]`,
    );
    await assertUiDownload(
      packaged.page,
      (response) =>
        response
          .url()
          .includes(`/tabular-review/${timelineReviewId}/export.xlsx`) &&
        response.status() === 200,
      () =>
        persistedTimelineReviewCard
          .getByRole("button", { name: /导出 XLSX|Export XLSX/ })
          .click(),
      /\.xlsx$/i,
      /spreadsheetml\.sheet/,
    );
    const persistedTimelineDraftCard = packaged.page.locator(
      `[data-testid="assistant-draft-result-${timelineMemoDocumentId}"]`,
    );
    await persistedTimelineDraftCard
      .getByRole("button", { name: /打开文稿|Open Draft/ })
      .click();
    await packaged.page.waitForURL(
      (url) =>
        url.pathname.includes(`/documents/${timelineMemoDocumentId}/studio`),
      { timeout: 90_000 },
    );
    await navigateAndAssertVisibleText(
      packaged.page,
      `/matters/${gate1MatterId}/assistant/chat/${timelineChatId}`,
      ["案件时间线和事实摘要已完成。"],
    );
    await assertUiDownload(
      packaged.page,
      (response) =>
        response
          .url()
          .includes(
            `/projects/${gate1MatterId}/studio/documents/${timelineMemoDocumentId}/export-docx`,
          ) && response.status() === 200,
      () =>
        packaged.page
          .locator(
            `[data-testid="assistant-draft-result-${timelineMemoDocumentId}"]`,
          )
          .getByRole("button", { name: /导出 DOCX|Export DOCX/ })
          .click(),
      /\.docx$/i,
      /wordprocessingml\.document/,
    );

    const documentsBeforeCancelledReview = await apiJson(
      token,
      `/projects/${gate1MatterId}/documents?limit=100`,
    );
    assert.equal(documentsBeforeCancelledReview.length, 5);
    const documentIdsBeforeCancelledReview = documentsBeforeCancelledReview
      .map((document) => document.id)
      .sort();
    const reviewsBeforeCancelledReview = await apiJson(
      token,
      `/tabular-review?project_id=${gate1MatterId}`,
    );
    const reviewIdsBeforeCancelledReview = new Set(
      reviewsBeforeCancelledReview.map((review) => review.id),
    );
    mock.setHoldGeneralTabular(true);
    const cancelledChatId = await startGeneralExtractionInUi(
      packaged.page,
      gate1MatterId,
      "custom",
    );
    await pollUntil(
      "Cancelled custom extraction reaches an in-flight cell",
      () => (mock.calls.heldGeneralTabularTurns > 0 ? true : undefined),
    );
    await packaged.page
      .getByRole("button", { name: /停止生成|Stop generating/ })
      .click();
    const cancelledJob = await pollUntil(
      "Cancelled custom extraction job",
      async () => {
        const jobs = await apiJson(
          token,
          `/assistant/jobs?chat_id=${cancelledChatId}&limit=20`,
        );
        const job = jobs.items?.[0];
        if (!job?.terminal) return undefined;
        assert.equal(job.status, "cancelled");
        return job;
      },
    );
    assert.equal(cancelledJob.cancel_requested, true);
    mock.setHoldGeneralTabular(false);
    const cancelledReview = await pollUntil(
      "Cancelled custom extraction Review",
      async () => {
        const reviews = await apiJson(
          token,
          `/tabular-review?project_id=${gate1MatterId}`,
        );
        const review = reviews.find(
          (item) => !reviewIdsBeforeCancelledReview.has(item.id),
        );
        if (!review || review.status !== "cancelled") return undefined;
        return apiJson(token, `/tabular-review/${review.id}`);
      },
    );
    cancelledCustomExtractionReviewId = cancelledReview.review.id;
    assert.equal(cancelledReview.review.status, "cancelled");
    assert.equal(
      cancelledReview.cells.some((cell) => cell.status === "running"),
      false,
      "Cancelled custom extraction must not leave a Review cell running.",
    );
    const cancelledChatText = await packaged.page.locator("body").innerText();
    assert.equal(
      cancelledChatText.includes("自定义信息提取已完成"),
      false,
      "Cancelled custom extraction must not render a completed Assistant answer.",
    );
    assert.equal(
      await packaged.page
        .locator('[data-testid^="assistant-draft-result-"]')
        .count(),
      0,
      "Cancelled custom extraction must not render a Draft card.",
    );
    const documentsAfterCancelledReview = await apiJson(
      token,
      `/projects/${gate1MatterId}/documents?limit=100`,
    );
    assert.deepEqual(
      documentsAfterCancelledReview.map((document) => document.id).sort(),
      documentIdsBeforeCancelledReview,
      "Cancelled custom extraction must not create a Draft document.",
    );
    gate1MatterBeforeRestart = await apiJson(
      token,
      `/matters/${gate1MatterId}`,
    );
    assertGate1MatterProjection(gate1MatterBeforeRestart, gate1MatterId, {
      document_count: 5,
      chat_count: 5,
      tabular_review_count: 4,
      workflow_count: 0,
    });
    const flagshipMatterList = await apiJson(token, "/matters?limit=100");
    assert.deepEqual(
      assertMatterListPage(flagshipMatterList, project.id, gate1MatterId, {
        document_count: 5,
        chat_count: 5,
        tabular_review_count: 4,
        workflow_count: 0,
      }).matter,
      gate1MatterBeforeRestart,
    );

    assert.deepEqual(mock.failures, []);
    assert.equal(mock.calls.probes, 1);
    assert.equal(
      mock.calls.assistantTurns - mock.calls.contractAssistantTurns,
      13,
    );
    assert.equal(mock.calls.contractToolCalls, 2);
    assert.equal(mock.calls.contractAssistantTurns, 3);
    assert.equal(
      mock.calls.assistantToolCalls - mock.calls.contractToolCalls,
      9,
    );
    assert.equal(mock.calls.workflowTurns, 1);
    assert.equal(
      mock.calls.tabularTurns - mock.calls.flagshipTabularTurns,
      mock.calls.tabularCells.size + mock.calls.generalTabularTurns,
      "Only the baseline 2x2 review and general extraction Reviews may use non-flagship Tabular turns.",
    );
    assert.deepEqual([...mock.calls.tabularCells].sort(), [
      "alpha:clause",
      "alpha:party",
      "beta:clause",
      "beta:party",
    ]);
    assert.equal(mock.calls.flagshipTabularCells.size, 54);
    assert.ok(
      mock.calls.generalTabularTurns > mock.calls.generalTabularCells.size,
      "Stopping custom extraction must interrupt at least one in-flight Tabular cell.",
    );
    assert.equal(mock.calls.generalTabularCells.size, 26);
    assert.ok(mock.calls.heldGeneralTabularTurns > 0);
    mockSummary = mock.calls;
    await mock.close();
    mock = null;
    await assertMockUnavailable(providerPort);

    await closePackagedVera(packaged.app);
    packaged = null;
    await assertPortsFree();

    packaged = await launchPackagedVera(
      userDataDir,
      applicationMasterKey,
      databaseKey,
    );
    token = packaged.token;
    await assertGate1MatterHealth();
    await assertMockUnavailable(providerPort);

    const persistedModel = await apiJson(
      token,
      `/model-profiles/${modelProfileId}`,
    );
    assert.equal(persistedModel.enabled, true);
    assert.equal(persistedModel.is_default, true);
    assert.equal(persistedModel.credential.status, "configured");
    const persistedPrivacy = await apiJson(
      token,
      `/model-profiles/${modelProfileId}/privacy`,
    );
    assertModelPrivacy(persistedPrivacy, modelProfileId);
    assert.deepEqual(persistedPrivacy, modelPrivacyBeforeRestart);
    const persistedSettings = await apiJson(token, "/settings");
    assert.equal(persistedSettings.default_model_profile_id, modelProfileId);
    assert.equal(persistedSettings.default_project_id, gate1MatterId);
    const persistedProject = await apiJson(token, `/projects/${project.id}`);
    assert.equal(persistedProject.name, project.name);
    assert.deepEqual(
      persistedProject.documents.map((document) => document.id).sort(),
      [...documentIds].sort(),
    );
    assert.ok(
      persistedProject.documents.every(
        (document) => document.status === "ready",
      ),
    );
    const persistedChat = await apiJson(
      token,
      `/chat/${acceptedAssistant.chat_id}`,
    );
    const persistedAssistant = persistedChat.messages.find(
      (message) => message.role === "assistant",
    );
    assert.equal(
      assistantMessageText(persistedAssistant),
      ASSISTANT_VISIBLE_ANSWER,
    );
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
    const persistedTabular = await apiJson(
      token,
      `/tabular-review/${tabular.id}`,
    );
    assert.equal(persistedTabular.cells.length, 4);
    assert.ok(persistedTabular.cells.every((cell) => cell.status === "done"));
    assert.ok(persistedTabular.cells.every((cell) => cell.sources.length >= 1));
    const persistedGate1Matter = await apiJson(
      token,
      `/matters/${gate1MatterId}`,
    );
    assertGate1MatterProjection(persistedGate1Matter, gate1MatterId, {
      document_count: 5,
      chat_count: 5,
      tabular_review_count: 4,
      workflow_count: 0,
    });
    assert.deepEqual(
      persistedGate1Matter,
      gate1MatterBeforeRestart,
      "Matter Profile, metadata, counts, state and capabilities must persist exactly across restart.",
    );
    const persistedMatterList = await apiJson(token, "/matters?limit=100");
    const listedAfterRestart = assertMatterListPage(
      persistedMatterList,
      project.id,
      gate1MatterId,
      {
        document_count: 5,
        chat_count: 5,
        tabular_review_count: 4,
        workflow_count: 0,
      },
    );
    assert.deepEqual(listedAfterRestart.matter, gate1MatterBeforeRestart);
    const persistedMatterPolicy = await apiJson(
      token,
      `/matters/${gate1MatterId}/policy`,
    );
    assertMatterPolicy(persistedMatterPolicy, gate1MatterId);
    assert.deepEqual(persistedMatterPolicy, gate1MatterPolicyBeforeRestart);
    const persistedMatterProject = await apiJson(
      token,
      `/projects/${gate1MatterId}`,
    );
    assert.equal(persistedMatterProject.documents.length, 5);
    assert.ok(
      gate1MatterDocumentIds.every((documentId) =>
        persistedMatterProject.documents.some(
          (document) => document.id === documentId,
        ),
      ),
    );
    assert.ok(
      persistedMatterProject.documents.some(
        (document) => document.id === flagshipMemoDocumentId,
      ),
    );
    assert.ok(
      persistedMatterProject.documents.some(
        (document) => document.id === timelineMemoDocumentId,
      ),
    );
    assert.ok(
      persistedMatterProject.documents.every(
        (document) => document.status === "ready",
      ),
    );
    const persistedMatterChat = await apiJson(
      token,
      `/chat/${gate1MatterChatId}`,
    );
    assert.deepEqual(persistedMatterChat, gate1MatterChatBeforeRestart);
    const persistedMatterAssistant = persistedMatterChat.messages.find(
      (message) => message.role === "assistant",
    );
    assert.ok(persistedMatterAssistant);
    assert.equal(
      assistantMessageText(persistedMatterAssistant),
      ASSISTANT_VISIBLE_ANSWER,
    );
    assert.deepEqual(
      persistedMatterAssistant.citations
        .map((citation) => citation.document_id)
        .sort(),
      [...gate1MatterAssistantDocumentIds].sort(),
    );
    assert.deepEqual(
      persistedMatterAssistant.citations.map((citation) => citation.quote),
      [DOCUMENT_ONE_PAYMENT_QUOTE, DOCUMENT_TWO_TERMINATION_QUOTE],
    );
    const persistedMatterSources = await apiJson(
      token,
      `/projects/${gate1MatterId}/sources?limit=100`,
    );
    assert.deepEqual(persistedMatterSources, gate1MatterSourcesBeforeRestart);
    assert.deepEqual(
      persistedMatterSources.sources.map((source) => source.id).sort(),
      [...gate1MatterSourceIds].sort(),
    );
    for (const [index, snapshotId] of gate1MatterSourceIds.entries()) {
      const detail = await apiJson(
        token,
        `/projects/${gate1MatterId}/sources/${snapshotId}`,
      );
      assert.equal(detail.snapshot.project_id, gate1MatterId);
      assert.equal(
        detail.snapshot.source_record_id,
        gate1MatterDocumentIds[index],
      );
      const content = await apiJson(
        token,
        `/projects/${gate1MatterId}/sources/${snapshotId}/content?limit=20`,
      );
      assert.equal(content.snapshot_id, snapshotId);
      assert.equal(content.document.document_id, gate1MatterDocumentIds[index]);
      assert.ok(
        content.chunks.some((chunk) =>
          chunk.text.includes(
            index === 0
              ? "VERA-E2E-ALPHA"
              : index === 1
                ? "VERA-E2E-BETA"
                : "VERA-FLAGSHIP-GAMMA",
          ),
        ),
      );
    }

    const persistedFlagshipReview = await apiJson(
      token,
      `/tabular-review/${flagshipReviewId}`,
    );
    assert.deepEqual(persistedFlagshipReview, flagshipReviewBeforeRestart);
    const persistedFlagshipMemo = await apiJson(
      token,
      `/projects/${gate1MatterId}/studio/documents/${flagshipMemoDocumentId}`,
    );
    assert.deepEqual(persistedFlagshipMemo, flagshipMemoBeforeRestart);
    const persistedCustomExtractionReview = await apiJson(
      token,
      `/tabular-review/${customExtractionReviewId}`,
    );
    assert.deepEqual(
      persistedCustomExtractionReview,
      customExtractionReviewBeforeRestart,
    );
    const persistedTimelineReview = await apiJson(
      token,
      `/tabular-review/${timelineReviewId}`,
    );
    assert.deepEqual(persistedTimelineReview, timelineReviewBeforeRestart);
    const persistedTimelineMemo = await apiJson(
      token,
      `/projects/${gate1MatterId}/studio/documents/${timelineMemoDocumentId}`,
    );
    assert.deepEqual(persistedTimelineMemo, timelineMemoBeforeRestart);
    const persistedCancelledCustomExtractionReview = await apiJson(
      token,
      `/tabular-review/${cancelledCustomExtractionReviewId}`,
    );
    assert.equal(
      persistedCancelledCustomExtractionReview.review.status,
      "cancelled",
    );
    const persistedFlagshipXlsx = await apiBytes(
      token,
      `/tabular-review/${flagshipReviewId}/export.xlsx`,
    );
    assert.match(
      persistedFlagshipXlsx.response.headers.get("content-type") ?? "",
      /spreadsheetml\.sheet/,
    );
    assert.match(
      persistedFlagshipXlsx.response.headers.get("content-disposition") ?? "",
      /\.xlsx/i,
    );
    assert.equal(
      persistedFlagshipXlsx.bytes.subarray(0, 4).toString("hex"),
      "504b0304",
    );
    const persistedFlagshipDocx = await apiBytes(
      token,
      `/projects/${gate1MatterId}/studio/documents/${flagshipMemoDocumentId}/export-docx`,
    );
    assert.match(
      persistedFlagshipDocx.response.headers.get("content-type") ?? "",
      /wordprocessingml\.document/,
    );
    assert.match(
      persistedFlagshipDocx.response.headers.get("content-disposition") ?? "",
      /\.docx/i,
    );
    assert.equal(
      persistedFlagshipDocx.bytes.subarray(0, 4).toString("hex"),
      "504b0304",
    );
    const persistedCustomExtractionXlsx = await apiBytes(
      token,
      `/tabular-review/${customExtractionReviewId}/export.xlsx`,
    );
    assert.match(
      persistedCustomExtractionXlsx.response.headers.get("content-type") ?? "",
      /spreadsheetml\.sheet/,
    );
    assert.equal(
      persistedCustomExtractionXlsx.bytes.subarray(0, 4).toString("hex"),
      "504b0304",
    );
    const persistedTimelineXlsx = await apiBytes(
      token,
      `/tabular-review/${timelineReviewId}/export.xlsx`,
    );
    assert.match(
      persistedTimelineXlsx.response.headers.get("content-type") ?? "",
      /spreadsheetml\.sheet/,
    );
    assert.equal(
      persistedTimelineXlsx.bytes.subarray(0, 4).toString("hex"),
      "504b0304",
    );
    const persistedTimelineDocx = await apiBytes(
      token,
      `/projects/${gate1MatterId}/studio/documents/${timelineMemoDocumentId}/export-docx`,
    );
    assert.match(
      persistedTimelineDocx.response.headers.get("content-type") ?? "",
      /wordprocessingml\.document/,
    );
    assert.equal(
      persistedTimelineDocx.bytes.subarray(0, 4).toString("hex"),
      "504b0304",
    );

    await navigateAndAssertVisibleText(
      packaged.page,
      `/matters/${gate1MatterId}/assistant/chat/${customExtractionChatId}`,
      ["自定义信息提取已完成"],
    );
    await assertGeneralTaskPlan(packaged.page, false);
    const restartedCustomReviewCard = packaged.page.locator(
      `[data-testid="assistant-review-result-${customExtractionReviewId}"]`,
    );
    await assertUiDownload(
      packaged.page,
      (response) =>
        response
          .url()
          .includes(
            `/tabular-review/${customExtractionReviewId}/export.xlsx`,
          ) && response.status() === 200,
      () =>
        restartedCustomReviewCard
          .getByRole("button", { name: /导出 XLSX|Export XLSX/ })
          .click(),
      /\.xlsx$/i,
      /spreadsheetml\.sheet/,
    );

    await navigateAndAssertVisibleText(
      packaged.page,
      `/matters/${gate1MatterId}/assistant/chat/${timelineChatId}`,
      ["案件时间线和事实摘要已完成。"],
    );
    await assertGeneralTaskPlan(packaged.page, true);
    const restartedTimelineReviewCard = packaged.page.locator(
      `[data-testid="assistant-review-result-${timelineReviewId}"]`,
    );
    const restartedTimelineDraftCard = packaged.page.locator(
      `[data-testid="assistant-draft-result-${timelineMemoDocumentId}"]`,
    );
    await assertUiDownload(
      packaged.page,
      (response) =>
        response
          .url()
          .includes(`/tabular-review/${timelineReviewId}/export.xlsx`) &&
        response.status() === 200,
      () =>
        restartedTimelineReviewCard
          .getByRole("button", { name: /导出 XLSX|Export XLSX/ })
          .click(),
      /\.xlsx$/i,
      /spreadsheetml\.sheet/,
    );
    await assertUiDownload(
      packaged.page,
      (response) =>
        response
          .url()
          .includes(
            `/projects/${gate1MatterId}/studio/documents/${timelineMemoDocumentId}/export-docx`,
          ) && response.status() === 200,
      () =>
        restartedTimelineDraftCard
          .getByRole("button", { name: /导出 DOCX|Export DOCX/ })
          .click(),
      /\.docx$/i,
      /wordprocessingml\.document/,
    );

    await assertAssistantRenderer(
      packaged.page,
      project.id,
      acceptedAssistant.chat_id,
    );
    await assertWorkflowRenderer(packaged.page, workflow.id);
    await assertTabularRenderer(packaged.page, project.id, tabular.id);
    await navigateAndAssertVisibleText(packaged.page, "/assistant", []);
    await assertVeraUi(packaged.page);
    await assertMattersListRenderer(packaged.page);
    await assertMatterRenderer(packaged.page, gate1MatterId);
    await assertAssistantRenderer(
      packaged.page,
      gate1MatterId,
      gate1MatterChatId,
      "matter",
    );
    await assertMatterRenderer(packaged.page, gate1MatterId);
    const visibleText = await packaged.page.locator("body").innerText();
    assert.equal(visibleText.includes(providerSecret), false);
    assert.equal(visibleText.includes(DOCUMENT_ONE), false);
    assert.equal(visibleText.includes(DOCUMENT_TWO), false);
    assert.equal(visibleText.includes(DOCUMENT_THREE), false);
    await packaged.page.screenshot({ path: evidencePath, fullPage: false });
    assert.ok(fs.statSync(evidencePath).size > 10_000);

    const clearedModel = await apiJson(
      token,
      `/model-profiles/${modelProfileId}/credential`,
      { method: "DELETE" },
    );
    assert.equal(clearedModel.credential.status, "missing");
    assert.equal(clearedModel.enabled, false);
    assert.equal(clearedModel.is_default, false);
    credentialDeleted = true;

    completed = true;
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          suite: "vera-packaged-workspace-e2e-gate1-v4-contract-review",
          evidence: process.env.VERA_PACKAGED_E2E_EVIDENCE_PATH
            ? "explicitly-configured"
            : "temporary-validated-and-cleaned",
          isolated_workspace_database_bytes: packaged.workspaceDatabaseBytes,
          provider_calls: {
            connection_probes: mockSummary.probes,
            assistant_turns: mockSummary.assistantTurns,
            assistant_document_tool_calls: mockSummary.assistantToolCalls,
            workflow_turns: mockSummary.workflowTurns,
            tabular_turns: mockSummary.tabularTurns,
            flagship_tabular_cells: mockSummary.flagshipTabularCells.size,
            general_extraction_tabular_cells:
              mockSummary.generalTabularCells.size,
          },
          matter_health: GATE1_MATTER_HEALTH,
          matter: {
            project_id: persistedGate1Matter.project.id,
            project_default_model_profile_id:
              persistedGate1Matter.project.default_model_profile_id,
            effective_workspace_default_model_profile_id: modelProfileId,
            workspace_type: persistedGate1Matter.matter_profile.workspace_type,
            profile_state: persistedGate1Matter.profile_state,
            capabilities: persistedGate1Matter.capabilities,
            privacy: {
              declaration_basis: persistedPrivacy.declaration_basis,
              execution_location: persistedPrivacy.execution_location,
              retention: persistedPrivacy.retention,
              training_use: persistedPrivacy.training_use,
              sensitive_data_allowed: persistedPrivacy.sensitive_data_allowed,
            },
            policy: {
              external_egress_mode: persistedMatterPolicy.external_egress_mode,
              execution_locations: persistedMatterPolicy.execution_locations,
            },
            source_snapshot_ids: [...gate1MatterSourceIds],
            assistant_chat_id: gate1MatterChatId,
            flagship_contract_review: {
              review_id: flagshipReviewId,
              memo_document_id: flagshipMemoDocumentId,
              documents: 3,
              cells_complete: 54,
            },
            custom_extraction: {
              review_id: customExtractionReviewId,
              documents: 2,
              cells_complete: 12,
            },
            stopped_custom_extraction: {
              review_id: cancelledCustomExtractionReviewId,
              documents: 2,
              status: "cancelled",
            },
            timeline_extraction: {
              review_id: timelineReviewId,
              memo_document_id: timelineMemoDocumentId,
              documents: 2,
              cells_complete: 14,
            },
            counts: {
              documents: persistedGate1Matter.project.document_count,
              chats: persistedGate1Matter.project.chat_count,
              tabular_reviews:
                persistedGate1Matter.project.tabular_review_count,
              workflows: persistedGate1Matter.project.workflow_count,
            },
          },
          checks: [
            "exact production Matter health on both packaged launches",
            "exact packaged Assistant Matters Workflows Review Settings navigation with truthful Review disablement and no top-level Projects or Tabular",
            "generic OpenAI-compatible profile credential test enable Workspace default and explicit confidential-remote privacy declaration",
            "generic Project with two locally parsed TXT documents",
            "Assistant streaming fetch_documents and exact persisted citations",
            "prompt plus output Workflow definition with real durable execution I/O",
            "2x2 Tabular structured generation with exact sources and CSV/XLSX export",
            "atomic classified Matter creation with bounded Project and Profile metadata",
            "Matter list projection separates the generic Project absent state from the ready classified Matter",
            "Matter effective Workspace default through the existing Settings owner while the Project override remains truthfully null",
            "complete allowed-by-policy Matter Policy for the explicit confidential-remote execution declaration",
            "strict six-field Matter capabilities with Review Center unavailable and existing Tabular compatibility available",
            "Matter Overview and exact Documents Assistant Review Workflows Drafts Settings navigation under Matter routes",
            "Matter Assistant reaches the provider for tool and final turns and persists exact citations",
            "Matter Assistant starter selects exactly three ready documents in the packaged UI and calls fetch_documents followed by run_contract_review",
            "built-in Commercial Agreement Review completes all 54 cells and renders durable Review and Draft cards",
            "custom extraction Starter opens its field dialog, attaches two Matter documents, calls canonical mode=custom, and exports its durable XLSX Review",
            "timeline Starter attaches two Matter documents, calls canonical mode=timeline, creates its Memo from that exact Review, and exports XLSX/DOCX",
            "packaged UI captures and validates XLSX and DOCX downloads by filename MIME and ZIP signature",
            "second in-flight Assistant custom extraction is stopped from the packaged UI, leaving a cancelled Review with no running cells, completed answer, or Draft",
            "durable flagship Review and Studio memo persist unchanged across offline restart",
            "custom extraction Review plus timeline Review and Review-derived Studio memo persist unchanged and export again after offline restart",
            "Matter-owned document source snapshots retain exact local content across restart",
            "same SQLCipher data and blob keys across an offline second launch",
            "private non-plaintext SQLCipher database inside the isolated profile",
            "persisted project documents chat messages workflow run and Tabular results",
            "exact Matter Profile privacy policy default model chat citations sources counts state and capabilities after offline restart",
            "provider credential deletion disables and clears the default model after persistence assertions",
            "redacted second-launch Gate 1 Matter Overview screenshot evidence",
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
    if (evidencePath && !completed) fs.rmSync(evidencePath, { force: true });
  }
}

main().catch((error) => {
  const primary = bounded(error instanceof Error ? error.stack : error, 12_000);
  const logs = applicationLog
    ? `\nPackaged application log (redacted):\n${bounded(applicationLog, 8_000)}`
    : "";
  process.stderr.write(`${primary}${logs}\n`);
  process.exitCode = 1;
});
