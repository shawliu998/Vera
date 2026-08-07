import assert from "node:assert/strict";
import test from "node:test";

import { agentTaskStatusAllowsExecution } from "../../agentTaskExecution";

test("a leased queued Task may cross the start boundary exactly once", () => {
  assert.equal(agentTaskStatusAllowsExecution("queued", "start"), true);
  assert.equal(agentTaskStatusAllowsExecution("queued", "continue"), false);
  assert.equal(agentTaskStatusAllowsExecution("running", "start"), false);
  assert.equal(agentTaskStatusAllowsExecution("running", "continue"), true);
  assert.equal(agentTaskStatusAllowsExecution("verifying", "continue"), true);
});

test("paused, failed, waiting and completed Tasks cannot cross either boundary", () => {
  for (const status of ["paused", "failed", "waiting_input", "completed"]) {
    assert.equal(agentTaskStatusAllowsExecution(status, "start"), false);
    assert.equal(agentTaskStatusAllowsExecution(status, "continue"), false);
  }
});
