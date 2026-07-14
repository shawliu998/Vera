import assert from "node:assert/strict";
import { test } from "@playwright/test";

import {
  createDocumentStatusPollCoordinator,
  DOCUMENT_STATUS_POLL_DELAY_MS,
  DOCUMENT_STATUS_POLL_MAX_CONSECUTIVE_FAILURES,
} from "../src/app/components/projects/ProjectWorkspace.tsx";
import { VeraApiError } from "../src/app/lib/veraApi.ts";
import type { VeraDocumentWire } from "../src/app/lib/veraWireTypes.ts";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

class ManualScheduler {
  private nextId = 1;
  private readonly tasks = new Map<
    number,
    { callback: () => void; delayMs: number }
  >();
  readonly executedDelays: number[] = [];

  schedule = (callback: () => void, delayMs: number): number => {
    const id = this.nextId++;
    this.tasks.set(id, { callback, delayMs });
    return id;
  };

  cancel = (id: number): void => {
    this.tasks.delete(id);
  };

  runNext(): void {
    const entry = this.tasks.entries().next().value as
      [number, { callback: () => void; delayMs: number }] | undefined;
    assert.ok(entry, "expected a scheduled poll");
    const [id, task] = entry;
    this.tasks.delete(id);
    this.executedDelays.push(task.delayMs);
    task.callback();
  }

  get pendingCount(): number {
    return this.tasks.size;
  }
}

function document(
  id: string,
  status: VeraDocumentWire["status"],
  filename = `${id}.pdf`,
): VeraDocumentWire {
  return {
    id,
    user_id: "00000000-0000-4000-8000-000000000001",
    project_id: "11111111-1111-4111-8111-111111111111",
    folder_id: null,
    filename,
    owner_email: null,
    owner_display_name: null,
    file_type: "pdf",
    storage_path: null,
    pdf_storage_path: null,
    size_bytes: 10,
    page_count: null,
    structure_tree: null,
    status,
    created_at: "2026-07-15T00:00:00.000Z",
    updated_at: "2026-07-15T00:00:00.000Z",
    active_version_number: 1,
    latest_version_number: 1,
  };
}

async function settlePoll(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

test("an in-flight stale snapshot cannot overwrite a local mutation, then a fresh snapshot reconciles additions and deletions", async () => {
  const scheduler = new ManualScheduler();
  const requests: Array<Deferred<VeraDocumentWire[]>> = [];
  let generation = 0;
  let visible = [
    document("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "processing"),
    document("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "ready"),
  ];
  const applied: VeraDocumentWire[][] = [];

  const coordinator = createDocumentStatusPollCoordinator({
    load: () => {
      const request = deferred<VeraDocumentWire[]>();
      requests.push(request);
      return request.promise;
    },
    mutationGeneration: () => generation,
    applySnapshot: (snapshot) => {
      visible = snapshot;
      applied.push(snapshot);
    },
    reportError: () => assert.fail("unexpected polling error"),
    clearError: () => undefined,
    schedule: scheduler.schedule,
    cancelSchedule: scheduler.cancel,
  });

  coordinator.start();
  scheduler.runNext();
  assert.equal(requests.length, 1);

  generation += 1;
  visible = [
    document(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "processing",
      "renamed.pdf",
    ),
    visible[1],
  ];
  requests[0].resolve([
    document("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "processing"),
    document("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "ready"),
  ]);
  await settlePoll();

  assert.equal(applied.length, 0, "the stale whole-list response is rejected");
  assert.equal(visible[0].filename, "renamed.pdf");
  assert.equal(scheduler.pendingCount, 1, "a fresh reconciliation is queued");

  scheduler.runNext();
  const authoritative = [
    document("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "ready", "renamed.pdf"),
    document("cccccccc-cccc-4ccc-8ccc-cccccccccccc", "ready"),
  ];
  requests[1].resolve(authoritative);
  await settlePoll();

  assert.deepEqual(visible, authoritative);
  assert.equal(
    visible.some((item) => item.id === "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
    false,
    "a server deletion is preserved",
  );
  assert.equal(applied.length, 1);
  assert.equal(scheduler.pendingCount, 0, "terminal documents stop polling");
});

test("retryable failures use capped finite exponential backoff and become visible when exhausted", async () => {
  const scheduler = new ManualScheduler();
  const reported: unknown[] = [];
  const failure = new VeraApiError({
    status: 503,
    code: "TEMPORARY_UNAVAILABLE",
    message: "temporarily unavailable",
  });
  const coordinator = createDocumentStatusPollCoordinator({
    load: async () => {
      throw failure;
    },
    mutationGeneration: () => 0,
    applySnapshot: () => assert.fail("unexpected snapshot"),
    reportError: (error) => reported.push(error),
    clearError: assert.fail,
    schedule: scheduler.schedule,
    cancelSchedule: scheduler.cancel,
  });

  coordinator.start();
  for (
    let attempt = 0;
    attempt < DOCUMENT_STATUS_POLL_MAX_CONSECUTIVE_FAILURES;
    attempt += 1
  ) {
    scheduler.runNext();
    await settlePoll();
    if (attempt < DOCUMENT_STATUS_POLL_MAX_CONSECUTIVE_FAILURES - 1) {
      assert.equal(
        reported.length,
        0,
        "a recoverable retry must not replace the document table",
      );
    }
  }

  assert.deepEqual(scheduler.executedDelays, [
    DOCUMENT_STATUS_POLL_DELAY_MS,
    3_000,
    6_000,
    12_000,
    12_000,
  ]);
  assert.deepEqual(reported, [failure]);
  assert.equal(scheduler.pendingCount, 0, "the retry budget is finite");
});

for (const error of [
  new VeraApiError({ status: 401, message: "signed out" }),
  new VeraApiError({ status: 403, message: "forbidden", retryable: true }),
  new VeraApiError({ status: 404, message: "project missing" }),
  new VeraApiError({
    status: 200,
    code: "INVALID_RESPONSE",
    message: "invalid response",
    retryable: true,
  }),
]) {
  test(`non-retryable poll failure ${error.status}/${error.code ?? "HTTP"} is reported once`, async () => {
    const scheduler = new ManualScheduler();
    const reported: unknown[] = [];
    const coordinator = createDocumentStatusPollCoordinator({
      load: async () => {
        throw error;
      },
      mutationGeneration: () => 0,
      applySnapshot: () => assert.fail("unexpected snapshot"),
      reportError: (reason) => reported.push(reason),
      clearError: assert.fail,
      schedule: scheduler.schedule,
      cancelSchedule: scheduler.cancel,
    });

    coordinator.start();
    scheduler.runNext();
    await settlePoll();

    assert.deepEqual(reported, [error]);
    assert.equal(scheduler.pendingCount, 0);
  });
}

test("stop cancels a timeout and aborts an in-flight request without applying it", async () => {
  const scheduled = new ManualScheduler();
  let calls = 0;
  const beforeRequest = createDocumentStatusPollCoordinator({
    load: async () => {
      calls += 1;
      return [];
    },
    mutationGeneration: () => 0,
    applySnapshot: () => assert.fail("unexpected snapshot"),
    reportError: () => assert.fail("unexpected polling error"),
    clearError: assert.fail,
    schedule: scheduled.schedule,
    cancelSchedule: scheduled.cancel,
  });
  beforeRequest.start();
  beforeRequest.stop();
  assert.equal(scheduled.pendingCount, 0);
  assert.equal(calls, 0);

  const inFlight = new ManualScheduler();
  const request = deferred<VeraDocumentWire[]>();
  const signals: AbortSignal[] = [];
  let applied = false;
  const duringRequest = createDocumentStatusPollCoordinator({
    load: (nextSignal) => {
      signals.push(nextSignal);
      return request.promise;
    },
    mutationGeneration: () => 0,
    applySnapshot: () => {
      applied = true;
    },
    reportError: () => assert.fail("unexpected polling error"),
    clearError: assert.fail,
    schedule: inFlight.schedule,
    cancelSchedule: inFlight.cancel,
  });
  duringRequest.start();
  inFlight.runNext();
  duringRequest.stop();
  assert.equal(signals[0]?.aborted, true);
  request.resolve([document("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "ready")]);
  await settlePoll();
  assert.equal(applied, false);
  assert.equal(inFlight.pendingCount, 0);
});
