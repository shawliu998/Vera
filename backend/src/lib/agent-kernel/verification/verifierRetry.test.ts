import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentTaskVerifierRetryError,
  requireAgentTaskVerifierRetryStarted,
} from "./verifierRetry";

test("accepts a newly started or idempotently committed Verifier retry", () => {
  for (const outcome of ["started", "already_started"] as const) {
    const result = requireAgentTaskVerifierRetryStarted({
      outcome,
      taskStatus: "verifying",
      currentStep: "verifier-step",
    });
    assert.equal(result.outcome, outcome);
    assert.equal(result.currentStep, "verifier-step");
  }
});

test("preserves the structured reason when current verifier facts drift", () => {
  assert.throws(
    () =>
      requireAgentTaskVerifierRetryStarted({
        outcome: "verification_result_invalid",
        taskStatus: "completed",
        currentStep: null,
      }),
    (error: unknown) =>
      error instanceof AgentTaskVerifierRetryError &&
      error.outcome === "verification_result_invalid" &&
      /structured review gap/.test(error.message),
  );
});
