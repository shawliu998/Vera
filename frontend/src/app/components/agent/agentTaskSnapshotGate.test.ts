import assert from "node:assert/strict";
import test from "node:test";

import { createAgentTaskSnapshotGate } from "./agentTaskSnapshotGate";

test("rejects a poll response older than a committed task action", () => {
  const gate = createAgentTaskSnapshotGate("task-a");
  const poll = gate.issue();
  gate.commit();
  assert.equal(gate.accept(poll), false);
  assert.equal(gate.accept(gate.issue()), true);
});

test("rejects duplicate and out-of-order responses", () => {
  const gate = createAgentTaskSnapshotGate("task-a");
  const first = gate.issue();
  const second = gate.issue();
  assert.equal(gate.accept(second), true);
  assert.equal(gate.accept(first), false);
  assert.equal(gate.accept(second), false);
});

test("rejects every response from a previous task after navigation", () => {
  const gate = createAgentTaskSnapshotGate("task-a");
  const oldRequest = gate.issue();
  gate.reset("task-b");
  assert.equal(gate.isCurrent(oldRequest), false);
  assert.equal(gate.accept(oldRequest), false);
  const current = gate.issue();
  assert.deepEqual(current, { taskId: "task-b", sequence: 1 });
  assert.equal(gate.accept(current), true);
});
