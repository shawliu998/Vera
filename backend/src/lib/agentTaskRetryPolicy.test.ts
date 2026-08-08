import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_AGENT_TASK_TRANSIENT_WAIT_MS,
  buildAgentTaskProviderDiagnosticV1,
  calculateAgentTaskBackoffMs,
  classifyAgentTaskError,
  classifyAgentTaskProviderProtocolError,
  parseRetryAfterMs,
} from "./agentTaskRetryPolicy";
import { RequiredToolProtocolError } from "./llm/requiredToolContract";

const now = Date.parse("2026-08-07T00:00:00.000Z");

test("classifies explicit HTTP 200 SSE provider capacity errors", () => {
  assert.deepEqual(
    classifyAgentTaskError(
      Object.assign(new Error("SSE data.error code 1302"), { status: "200" }),
      now,
    ),
    { classification: "rate_limit", retryAfterMs: null },
  );
  assert.deepEqual(
    classifyAgentTaskError(
      Object.assign(new Error("该模型当前访问量过大，请您稍后再试 (1305)"), {
        status: 200,
      }),
      now,
    ),
    { classification: "provider_unavailable", retryAfterMs: null },
  );
});

test("fails closed for unknown HTTP 200 SSE errors", () => {
  assert.equal(
    classifyAgentTaskError(
      Object.assign(new Error("SSE data.error unknown provider condition"), {
        status: "200",
      }),
      now,
    ),
    null,
  );
  assert.equal(
    classifyAgentTaskError(
      Object.assign(new Error("fetch failed"), { status: 200 }),
      now,
    ),
    null,
    "HTTP 200 only authorizes explicit SSE capacity or rate-limit signals",
  );
});

test("retains the prior message-only transient classifications", () => {
  const cases: Array<
    [string, "rate_limit" | "provider_unavailable" | "timeout" | "network"]
  > = [
    ["resource exhausted", "rate_limit"],
    ["resource_exhausted", "rate_limit"],
    ["provider overloaded", "provider_unavailable"],
    ["provider queue", "provider_unavailable"],
    ["service unavailable", "provider_unavailable"],
    ["Service is too busy", "provider_unavailable"],
    ["temporarily unavailable", "provider_unavailable"],
    ["deadline_exceeded", "timeout"],
    ["timed out", "timeout"],
    ["timeout", "timeout"],
    ["fetch failed", "network"],
    ["ECONNRESET", "network"],
    ["ETIMEDOUT", "timeout"],
    ["ENETUNREACH", "network"],
    ["EAI_AGAIN", "network"],
    ["socket hang up", "network"],
  ];
  for (const [message, classification] of cases) {
    assert.deepEqual(classifyAgentTaskError(new Error(message), now), {
      classification,
      retryAfterMs: null,
    });
  }
  const aborted = new Error("provider request aborted");
  aborted.name = "AbortError";
  assert.deepEqual(classifyAgentTaskError(aborted, now), {
    classification: "timeout",
    retryAfterMs: null,
  });
});

test("normalizes numeric-string HTTP statuses", () => {
  assert.deepEqual(
    classifyAgentTaskError(
      Object.assign(new Error("limited"), {
        statusCode: "429",
        headers: { "Retry-After": "7" },
      }),
      now,
    ),
    { classification: "rate_limit", retryAfterMs: 7_000 },
  );
  assert.deepEqual(
    classifyAgentTaskError(
      Object.assign(new Error("provider failure"), { status: "503" }),
      now,
    ),
    { classification: "provider_unavailable", retryAfterMs: null },
  );
});

test("bounds Retry-After and exponential backoff", () => {
  assert.equal(parseRetryAfterMs("2.5", now), 2_500);
  assert.equal(
    calculateAgentTaskBackoffMs(1, {
      baseMs: 10_000,
      jitterRatio: 0,
      random: () => 0.5,
    }),
    10_000,
  );
  assert.equal(
    calculateAgentTaskBackoffMs(9, { retryAfterMs: 90_000 }),
    MAX_AGENT_TASK_TRANSIENT_WAIT_MS,
  );
  assert.equal(calculateAgentTaskBackoffMs(1, { retryAfterMs: -1 }), 0);
});

test("classifies only an exact required-tool provider protocol diagnostic", () => {
  for (const provider of [
    "DeepSeek",
    "Kimi",
    "Gemini",
    "Zhipu",
    "Claude",
    "OpenAI",
  ]) {
    assert.deepEqual(
      classifyAgentTaskProviderProtocolError(
        new Error(
          `${provider} did not return the required read_document tool call for this iteration.`,
        ),
      ),
      { classification: "provider_protocol" },
    );
  }
  for (const toolName of ["edit_document", "source-verify"]) {
    assert.deepEqual(
      classifyAgentTaskProviderProtocolError(
        new Error(
          `OpenAI did not return the required ${toolName} tool call for this iteration.`,
        ),
      ),
      { classification: "provider_protocol" },
    );
  }
});

test("classifies structured required-tool contract failures without parsing display text", () => {
  assert.deepEqual(
    classifyAgentTaskProviderProtocolError(
      new RequiredToolProtocolError(
        "provider_forced_tool_unsupported",
        "zhipu",
        "generate_docx",
      ),
    ),
    { classification: "provider_protocol" },
  );
});

test("classifies verifier structured-output drift separately", () => {
  const error = new Error("Verifier returned an invalid structured result");
  error.name = "AgentVerifierStructuredOutputError";
  assert.deepEqual(classifyAgentTaskProviderProtocolError(error), {
    classification: "provider_structured_output",
  });
});

test("classifies provider key, balance, and entitlement errors as resumable configuration pauses", () => {
  for (const message of [
    "DeepSeek error (invalid_request_error): Insufficient Balance",
    "OpenAI error: Incorrect API key provided",
    "Claude authentication failed: expired API key",
    "Gemini: account does not have access to model",
    "智谱模型无权限",
  ]) {
    assert.deepEqual(
      classifyAgentTaskProviderProtocolError(new Error(message)),
      { classification: "provider_configuration" },
    );
  }
});

test("classifies quota-exceeded 429 billing prose as capacity before configuration", () => {
  const error = new Error(
    "Gemini error (429): You exceeded your current quota. Check your plan and billing details.",
  );
  assert.deepEqual(classifyAgentTaskError(error, now), {
    classification: "rate_limit",
    retryAfterMs: null,
  });
  assert.equal(
    classifyAgentTaskProviderProtocolError(error),
    null,
    "billing prose must not override explicit 429/quota capacity evidence",
  );
  assert.deepEqual(
    classifyAgentTaskProviderProtocolError(
      Object.assign(
        new Error("OpenAI error: insufficient_quota; payment required"),
        { status: 429 },
      ),
    ),
    { classification: "provider_configuration" },
    "a hard billing quota without transient evidence remains configuration",
  );
});

test("extracts a bounded provider diagnostic without retaining response prose", () => {
  const error = Object.assign(
    new Error(
      "Gemini error (RESOURCE_EXHAUSTED): quota hit; secret-source-text",
    ),
    {
      status: 429,
      code: "RESOURCE_EXHAUSTED",
      headers: {
        "Retry-After": "7",
        "x-request-id": "request-123",
        authorization: "Bearer must-not-be-retained",
      },
    },
  );
  const diagnostic = buildAgentTaskProviderDiagnosticV1(error, {
    provider: "gemini",
    model: "gemini-3-flash-preview",
    nowMs: now,
  });
  assert.deepEqual(diagnostic, {
    kind: "agent_provider_diagnostic_v1",
    provider: "gemini",
    model: "gemini-3-flash-preview",
    http_status: 429,
    provider_code: "RESOURCE_EXHAUSTED",
    request_id: "request-123",
    retry_after_ms: 7_000,
  });
  const serialized = JSON.stringify(diagnostic);
  assert.doesNotMatch(serialized, /secret-source-text|authorization|Bearer/);

  assert.equal(
    buildAgentTaskProviderDiagnosticV1(
      Object.assign(new Error("provider error"), {
        requestId: "../../unsafe request id",
      }),
    ).request_id,
    null,
  );
});

test("fails closed for non-exact provider protocol and policy diagnostics", () => {
  for (const message of [
    "UnknownAI did not return the required read_document tool call for this iteration.",
    "OpenAI did not return the required read_document tool call for this iteration. Retry now.",
    "OpenAI provider policy rejected an unregistered tool.",
    "OpenAI rejected an unauthorized tool invocation.",
    "OpenAI rejected a mutation target outside the fixed document version.",
    "OpenAI did not return required tool call for this iteration.",
  ]) {
    assert.equal(
      classifyAgentTaskProviderProtocolError(new Error(message)),
      null,
    );
  }
});
