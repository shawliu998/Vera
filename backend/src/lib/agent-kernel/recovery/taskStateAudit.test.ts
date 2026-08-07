import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { auditAgentTaskState } from "./taskStateAudit";

test("accepts coherent queued, active, paused and terminal Task shapes", () => {
  const tasks = [
    { id: "queued", status: "queued", current_step: null },
    { id: "running", status: "running", current_step: "r1" },
    { id: "verifying", status: "verifying", current_step: "v1" },
    { id: "paused", status: "paused", current_step: "p1" },
    { id: "waiting", status: "waiting_input", current_step: "w1" },
    { id: "failed", status: "failed", current_step: "f1" },
    { id: "completed", status: "completed", current_step: null },
  ];
  const steps = [
    { id: "q1", task_id: "queued", position: 0, status: "pending", attempt: 0 },
    {
      id: "r1",
      task_id: "running",
      position: 0,
      status: "running",
      attempt: 1,
    },
    {
      id: "r2",
      task_id: "running",
      position: 1,
      status: "pending",
      attempt: 0,
    },
    {
      id: "v0",
      task_id: "verifying",
      position: 0,
      status: "completed",
      attempt: 1,
    },
    {
      id: "v1",
      task_id: "verifying",
      position: 1,
      status: "running",
      attempt: 1,
    },
    { id: "p1", task_id: "paused", position: 0, status: "running", attempt: 2 },
    { id: "p2", task_id: "paused", position: 1, status: "pending", attempt: 0 },
    {
      id: "w1",
      task_id: "waiting",
      position: 0,
      status: "blocked",
      attempt: 1,
    },
    { id: "f1", task_id: "failed", position: 0, status: "blocked", attempt: 1 },
    {
      id: "c1",
      task_id: "completed",
      position: 0,
      status: "completed",
      attempt: 1,
    },
  ];
  assert.deepEqual(auditAgentTaskState(tasks, steps, 0).issues, []);
});

test("reports torn Task/Step shapes without proposing an automatic legal repair", () => {
  const report = auditAgentTaskState(
    [
      {
        id: "torn",
        status: "paused",
        current_step: "s1",
        execution_lease_owner: "owner",
        execution_lease_expires_at: "2026-08-07T00:00:00.000Z",
      },
    ],
    [
      { id: "s1", task_id: "torn", position: 0, status: "running", attempt: 1 },
      { id: "s2", task_id: "torn", position: 1, status: "running", attempt: 1 },
    ],
    Date.parse("2026-08-08T00:00:00.000Z"),
  );
  assert.equal(report.issue_counts.inactive_task_expired_lease, 1);
  assert.equal(report.issue_counts.multiple_running_steps, 1);
  assert.equal(report.issue_counts.paused_shape_invalid, 1);
  assert.equal(report.disposition_counts.mechanically_repairable, 1);
  assert.equal(report.disposition_counts.review_required, 2);
});

test("fails closed for malformed effect receipts", () => {
  const malformed = auditAgentTaskState(
    [{ id: "effect", status: "verifying", current_step: "s1" }],
    [
      {
        id: "s1",
        task_id: "effect",
        position: 0,
        status: "running",
        attempt: 1,
        result_data: { effect_receipts: [] },
      },
    ],
  );
  assert.equal(malformed.issue_counts.effect_receipt_malformed, 1);
});

test("the inventory command exposes no database mutation or RPC path", async () => {
  const script = await readFile(
    new URL("../../../../scripts/auditAgentTaskState.ts", import.meta.url),
    "utf8",
  );
  assert.match(script, /\.select\(/);
  assert.doesNotMatch(script, /\.(insert|update|upsert|delete|rpc)\(/);
});
