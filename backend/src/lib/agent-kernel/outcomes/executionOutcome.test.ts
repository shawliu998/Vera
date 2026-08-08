import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAgentTaskExecutionPauseCheckpoint,
  mergeAgentTaskProviderPauseCheckpoint,
  providerPauseClassificationForRetry,
  providerPauseSummary,
  readAgentTaskExecutionPauseCheckpoint,
} from "./executionOutcome";

const createdAt = "2026-08-07T00:00:00.000Z";

test("builds server-owned structured provider pause issues", () => {
  const cases = [
    ["provider_capacity", "provider_capacity_exhausted", true],
    ["provider_timeout", "provider_timeout_exhausted", true],
    ["provider_network", "provider_network_exhausted", true],
    ["provider_protocol", "provider_protocol_incompatible", false],
    ["provider_structured_output", "provider_structured_output_invalid", false],
    ["provider_configuration", "provider_configuration_required", false],
  ] as const;
  for (const [classification, code, exhausted] of cases) {
    const checkpoint = buildAgentTaskExecutionPauseCheckpoint({
      classification,
      stepId: "step-fixed",
      attempt: 2,
      createdAt,
    });
    assert.equal(checkpoint.issue.code, code);
    assert.equal(checkpoint.issue.recoverable, true);
    assert.equal(checkpoint.issue.facts.automatic_retries_exhausted, exhausted);
    assert.deepEqual(checkpoint.issue.facts, {
      step_id: "step-fixed",
      attempt: 2,
      automatic_retries_exhausted: exhausted,
    });
  }
});

test("separates timeout, network and capacity retry outcomes", () => {
  assert.equal(
    providerPauseClassificationForRetry("timeout"),
    "provider_timeout",
  );
  assert.equal(
    providerPauseClassificationForRetry("network"),
    "provider_network",
  );
  assert.equal(
    providerPauseClassificationForRetry("rate_limit"),
    "provider_capacity",
  );
  assert.equal(
    providerPauseClassificationForRetry("provider_unavailable"),
    "provider_capacity",
  );
  assert.match(providerPauseSummary("provider_timeout", 3), /timed out/i);
  assert.match(providerPauseSummary("provider_network", 3), /connection/i);
  assert.match(providerPauseSummary("provider_capacity", 3), /unavailable/i);
  assert.match(providerPauseSummary("provider_protocol", 0), /tool protocol/i);
  assert.match(
    providerPauseSummary("provider_structured_output", 0),
    /structured verifier result/i,
  );
  assert.match(
    providerPauseSummary("provider_configuration", 0),
    /API key, balance, or model access/i,
  );
});

test("normalizes legacy pauses but never repairs a malformed present issue", () => {
  const legacy = readAgentTaskExecutionPauseCheckpoint({
    kind: "agent_task_execution_pause_v1",
    classification: "provider_network",
    step_id: "step-legacy",
    attempt: 1,
    created_at: createdAt,
  });
  assert.equal(legacy?.issue.code, "provider_network_exhausted");

  assert.equal(
    readAgentTaskExecutionPauseCheckpoint({
      kind: "agent_task_execution_pause_v1",
      classification: "provider_network",
      step_id: "step-malformed",
      attempt: 1,
      created_at: createdAt,
      issue: {},
    }),
    null,
    "a present malformed structured issue must not authorize recovery",
  );
});

test("records a structured planner pause while preserving recovery input", () => {
  const checkpoint = mergeAgentTaskProviderPauseCheckpoint({
    previous: {
      step_id: "planner",
      iteration: 0,
      planner_request: { document_ids: ["document-fixed"] },
      user_input: { message: "保留此输入" },
    },
    classification: "provider_timeout",
    summary: "Provider timeout.",
    createdAt,
  });
  assert.deepEqual(checkpoint.planner_request, {
    document_ids: ["document-fixed"],
  });
  assert.deepEqual(checkpoint.user_input, { message: "保留此输入" });
  assert.equal(checkpoint.step_id, "planner");
  assert.equal(checkpoint.iteration, 0);
  assert.equal(
    checkpoint.execution_pause.issue.code,
    "provider_timeout_exhausted",
  );
});

test("binds a running Step over stale checkpoint position without replacing other receipts", () => {
  const checkpoint = mergeAgentTaskProviderPauseCheckpoint({
    previous: {
      step_id: "old-step",
      iteration: 9,
      existing_receipt: "retain-me",
    },
    currentStep: { id: "current-step", attempt: 2 },
    classification: "provider_protocol",
    summary: "Provider protocol pause.",
    createdAt,
  });
  assert.equal(checkpoint.existing_receipt, "retain-me");
  assert.equal(checkpoint.step_id, "current-step");
  assert.equal(checkpoint.iteration, 2);
  assert.equal(
    checkpoint.execution_pause.issue.facts.automatic_retries_exhausted,
    false,
  );
});

test("persists only a strict bounded provider diagnostic inside the pause issue", () => {
  const checkpoint = buildAgentTaskExecutionPauseCheckpoint({
    classification: "provider_capacity",
    stepId: "step-diagnostic",
    attempt: 3,
    createdAt,
    diagnostic: {
      kind: "agent_provider_diagnostic_v1",
      provider: "gemini",
      model: "gemini-3-flash-preview",
      http_status: 429,
      provider_code: "RESOURCE_EXHAUSTED",
      request_id: "request-123",
      retry_after_ms: 7_000,
    },
  });
  assert.deepEqual(
    checkpoint.issue.facts.provider_diagnostic,
    {
      kind: "agent_provider_diagnostic_v1",
      provider: "gemini",
      model: "gemini-3-flash-preview",
      http_status: 429,
      provider_code: "RESOURCE_EXHAUSTED",
      request_id: "request-123",
      retry_after_ms: 7_000,
    },
  );
  assert.equal(
    readAgentTaskExecutionPauseCheckpoint({
      ...checkpoint,
      issue: {
        ...checkpoint.issue,
        facts: {
          ...checkpoint.issue.facts,
          provider_diagnostic: {
            ...checkpoint.issue.facts.provider_diagnostic,
            response_text: "must never be persisted",
          },
        },
      },
    }),
    null,
    "an expanded or malformed diagnostic must fail closed",
  );
});
