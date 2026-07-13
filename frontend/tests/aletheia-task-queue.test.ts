import assert from "node:assert/strict";
import test from "node:test";
import {
  formatTaskDueDate,
  taskDueGroup,
} from "../src/aletheia/AletheiaTaskQueue.tsx";
import type { AletheiaMatterTaskRecord } from "../src/app/lib/aletheiaApi.ts";

function task(
  dueAt: Date,
  status: AletheiaMatterTaskRecord["status"] = "open",
): AletheiaMatterTaskRecord {
  return {
    id: "task-1",
    matter_id: "matter-1",
    user_id: "user-1",
    source_deadline_id: "deadline-1",
    title: "File response",
    due_at: dueAt.toISOString(),
    status,
    priority: "normal",
    note: null,
    completed_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

test("task due groups use the local calendar day", () => {
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  assert.equal(taskDueGroup(task(yesterday)), "overdue");
  assert.equal(taskDueGroup(task(today)), "today");
  assert.equal(taskDueGroup(task(tomorrow)), "upcoming");
  assert.equal(taskDueGroup(task(yesterday, "completed")), "completed");
});

test("task due date renders a readable value", () => {
  assert.match(formatTaskDueDate("2026-07-10T08:00:00.000Z"), /2026/);
});
