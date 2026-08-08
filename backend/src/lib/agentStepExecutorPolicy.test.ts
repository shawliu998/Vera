import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentModelRequestTimeoutError,
  agentStepThinkingEnabled,
  shouldRetryAgentStepModelError,
} from "./agentStepExecutor";

test("a server deadline pauses instead of replaying the same model payload", () => {
  assert.equal(
    shouldRetryAgentStepModelError(
      new AgentModelRequestTimeoutError("glm-5.2"),
    ),
    false,
  );
  assert.equal(
    shouldRetryAgentStepModelError(
      Object.assign(new Error("provider overloaded"), { status: 503 }),
    ),
    true,
  );
  assert.equal(
    shouldRetryAgentStepModelError(new Error("invalid legal finding")),
    false,
  );
});

test("bounded Contract extraction disables provider thinking only for that step", () => {
  assert.equal(agentStepThinkingEnabled(true), false);
  assert.equal(agentStepThinkingEnabled(false), true);
});
