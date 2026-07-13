import assert from "node:assert/strict";
import test from "node:test";
import {
  deadlineNotificationCandidate,
  deadlineNotificationCandidates,
} from "../src/aletheia/deadlineNotifications.ts";
import type { AletheiaMatterTaskRecord } from "../src/app/lib/aletheiaApi.ts";

function task(overrides: Partial<AletheiaMatterTaskRecord> = {}) {
  return {
    id: "task-1",
    matter_id: "matter-1",
    user_id: "local-user",
    source_deadline_id: "deadline-1",
    title: "File statement of defence",
    due_at: "2026-07-12T08:00:00.000Z",
    status: "open",
    priority: "high",
    note: null,
    completed_at: null,
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
    ...overrides,
  } satisfies AletheiaMatterTaskRecord;
}

test("deadline reminders include due-soon and overdue work once per local day", () => {
  const now = new Date("2026-07-11T09:00:00.000Z");
  const dueSoon = deadlineNotificationCandidate(task(), now, "Orion dispute");
  assert(dueSoon);
  assert.match(dueSoon.title, /^Due soon:/);
  assert.match(dueSoon.body, /Orion dispute/);
  assert.equal(dueSoon.href, "/aletheia/tasks");

  const overdue = deadlineNotificationCandidate(
    task({ due_at: "2026-07-10T08:00:00.000Z" }),
    now,
  );
  assert(overdue);
  assert.match(overdue.title, /^Overdue:/);
  assert.notEqual(overdue.key, dueSoon.key);
});

test("deadline reminders ignore completed, invalid, and distant tasks", () => {
  const now = new Date("2026-07-11T09:00:00.000Z");
  assert.equal(
    deadlineNotificationCandidate(task({ status: "completed" }), now),
    null,
  );
  assert.equal(
    deadlineNotificationCandidate(task({ due_at: "invalid" }), now),
    null,
  );
  assert.equal(
    deadlineNotificationCandidate(
      task({ due_at: "2026-07-20T08:00:00.000Z" }),
      now,
    ),
    null,
  );
});

test("deadline reminder candidates are sorted by due time", () => {
  const now = new Date("2026-07-11T09:00:00.000Z");
  const candidates = deadlineNotificationCandidates(
    [
      task({ id: "later", due_at: "2026-07-12T08:00:00.000Z" }),
      task({ id: "earlier", due_at: "2026-07-11T10:00:00.000Z" }),
    ],
    now,
  );
  assert.deepEqual(
    candidates.map((candidate) => candidate.taskId),
    ["earlier", "later"],
  );
});
