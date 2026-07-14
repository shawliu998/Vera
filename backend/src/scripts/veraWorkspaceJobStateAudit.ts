import { strict as assert } from "node:assert";

import {
  WORKSPACE_JOB_ALLOWED_TRANSITIONS,
  canCancelWorkspaceJob,
  canReuseCompletedJob,
  canRetryWorkspaceJob,
  createWorkspaceJob,
  projectWorkspaceJobForLogs,
  projectWorkspaceJobValueForLogs,
  recoverRunningWorkspaceJobs,
  transitionWorkspaceJob,
} from "../lib/workspace/jobs/stateMachine";
import type {
  WorkspaceJobEvent,
  WorkspaceJobRecord,
  WorkspaceJobStatus,
} from "../lib/workspace/jobs/types";

const TIMES = {
  created: "2026-07-14T09:00:00.000Z",
  started: "2026-07-14T09:00:05.000Z",
  completed: "2026-07-14T09:00:10.000Z",
  retried: "2026-07-14T09:00:15.000Z",
  restarted: "2026-07-14T09:00:20.000Z",
} as const;

function baseJob(
  overrides: Partial<Parameters<typeof createWorkspaceJob>[0]> = {},
): WorkspaceJobRecord {
  return createWorkspaceJob({
    id: overrides.id ?? "job-1",
    type: overrides.type ?? "document_parse",
    payload:
      overrides.payload ??
      {
        documentId: "doc-1",
        prompt: "Never print this prompt",
        apiKey: "sk-test-secret-value-1234567890",
      },
    maxAttempts: overrides.maxAttempts ?? 2,
    createdAt: overrides.createdAt ?? TIMES.created,
    idempotencyKey: overrides.idempotencyKey,
  });
}

function expectTransitionError(
  job: WorkspaceJobRecord,
  event: WorkspaceJobEvent,
  pattern: RegExp,
) {
  assert.throws(() => transitionWorkspaceJob(job, event), pattern);
}

function runningJob(): WorkspaceJobRecord {
  return transitionWorkspaceJob(baseJob(), {
    type: "start",
    at: TIMES.started,
  });
}

function failedJob(retryable = true, attempt = 1): WorkspaceJobRecord {
  let job = runningJob();
  job = transitionWorkspaceJob(job, {
    type: "fail",
    at: TIMES.completed,
    error: {
      code: "provider_failure",
      message: "Provider rejected apiKey=sk-test-secret-value-1234567890",
      retryable,
      details: {
        prompt: "Classify this document verbatim",
        authorization: "Bearer super-secret-token",
      },
    },
  });
  if (attempt > 1) {
    for (let current = 1; current < attempt; current += 1) {
      job = transitionWorkspaceJob(job, { type: "retry", at: TIMES.retried });
      job = transitionWorkspaceJob(job, { type: "start", at: TIMES.started });
      job = transitionWorkspaceJob(job, {
        type: "fail",
        at: TIMES.completed,
        error: {
          code: "provider_failure",
          message: "retry failure",
          retryable,
        },
      });
    }
  }
  return job;
}

function interruptedJob(retryable = true): WorkspaceJobRecord {
  return transitionWorkspaceJob(runningJob(), {
    type: "interrupt",
    at: TIMES.completed,
    error: {
      code: "worker_restart",
      message: "Worker restart interrupted prompt processing",
      retryable,
      details: { prompt: "Sensitive prompt" },
    },
  });
}

function completedJob(): WorkspaceJobRecord {
  return transitionWorkspaceJob(runningJob(), {
    type: "complete",
    at: TIMES.completed,
    result: {
      output: "Confidential generated content",
      document: "Do not log this",
    },
  });
}

function cancelledJob(): WorkspaceJobRecord {
  return transitionWorkspaceJob(baseJob(), {
    type: "cancel",
    at: TIMES.completed,
    reason: "User cancelled prompt with apiKey sk-test-secret-value-1234567890",
  });
}

function assertAllowedTransitions() {
  const statusJobs: Record<WorkspaceJobStatus, WorkspaceJobRecord> = {
    queued: baseJob(),
    running: runningJob(),
    complete: completedJob(),
    failed: failedJob(true),
    cancelled: cancelledJob(),
    interrupted: interruptedJob(true),
  };
  const events: Array<{
    name: WorkspaceJobEvent["type"];
    nextStatus: WorkspaceJobStatus;
    allowedFrom: WorkspaceJobStatus[];
    build: () => WorkspaceJobEvent;
  }> = [
    {
      name: "start",
      nextStatus: "running",
      allowedFrom: ["queued"],
      build: () => ({ type: "start", at: TIMES.started }),
    },
    {
      name: "complete",
      nextStatus: "complete",
      allowedFrom: ["running"],
      build: () => ({
        type: "complete",
        at: TIMES.completed,
        result: { content: "Sensitive completion" },
      }),
    },
    {
      name: "fail",
      nextStatus: "failed",
      allowedFrom: ["running"],
      build: () => ({
        type: "fail",
        at: TIMES.completed,
        error: {
          code: "provider_failure",
          message: "Provider failed",
          retryable: true,
        },
      }),
    },
    {
      name: "cancel",
      nextStatus: "cancelled",
      allowedFrom: ["queued", "running", "failed", "interrupted"],
      build: () => ({ type: "cancel", at: TIMES.completed, reason: "cancel" }),
    },
    {
      name: "interrupt",
      nextStatus: "interrupted",
      allowedFrom: ["running"],
      build: () => ({ type: "interrupt", at: TIMES.completed }),
    },
    {
      name: "retry",
      nextStatus: "queued",
      allowedFrom: ["failed", "interrupted"],
      build: () => ({ type: "retry", at: TIMES.retried }),
    },
  ];

  for (const [status, job] of Object.entries(statusJobs) as Array<
    [WorkspaceJobStatus, WorkspaceJobRecord]
  >) {
    for (const event of events) {
      const allowed = event.allowedFrom.includes(status);
      if (allowed) {
        const transitioned = transitionWorkspaceJob(job, event.build());
        assert.equal(
          transitioned.status,
          event.nextStatus,
          `${status} + ${event.name} should reach ${event.nextStatus}`,
        );
      } else {
        expectTransitionError(
          job,
          event.build(),
          /is not allowed|cannot be retried/,
        );
      }
    }
    assert.deepEqual(
      [...WORKSPACE_JOB_ALLOWED_TRANSITIONS[status]].sort(),
      Array.from(
        new Set(
          events
            .filter((event) => event.allowedFrom.includes(status))
            .map((event) => event.nextStatus),
        ),
      ).sort(),
    );
  }
}

function assertDuplicateCompletionBlocked() {
  const job = completedJob();
  expectTransitionError(
    job,
    { type: "complete", at: TIMES.retried, result: { output: "again" } },
    /is not allowed/,
  );
  expectTransitionError(
    job,
    { type: "start", at: TIMES.retried },
    /is not allowed/,
  );
}

function assertCancellationTerminal() {
  const queuedCancelled = transitionWorkspaceJob(baseJob(), {
    type: "cancel",
    at: TIMES.completed,
    reason: "Prompt cancelled with sk-test-secret-value-1234567890",
  });
  assert.equal(queuedCancelled.status, "cancelled");
  assert.equal(canCancelWorkspaceJob(queuedCancelled), false);
  assert.equal(
    queuedCancelled.cancellation?.reason?.includes("sk-test-secret-value-1234567890"),
    false,
  );
  expectTransitionError(
    queuedCancelled,
    { type: "retry", at: TIMES.retried },
    /is not allowed/,
  );
}

function assertRecoverySemantics() {
  const jobs = [
    runningJob(),
    baseJob({ id: "job-queued" }),
    failedJob(true),
  ];
  const recovered = recoverRunningWorkspaceJobs(jobs, TIMES.restarted);
  assert.equal(recovered[0].status, "interrupted");
  assert.equal(recovered[0].error?.retryable, true);
  assert.equal(recovered[0].completedAt, TIMES.restarted);
  assert.equal(recovered[1].status, "queued");
  assert.equal(recovered[2].status, "failed");
}

function assertRetrySemantics() {
  const retryable = failedJob(true);
  assert.equal(canRetryWorkspaceJob(retryable), true);
  const queued = transitionWorkspaceJob(retryable, {
    type: "retry",
    at: TIMES.retried,
  });
  assert.equal(queued.status, "queued");
  assert.equal(queued.attempt, 1);
  assert.equal(queued.error, null);

  const nonRetryable = failedJob(false);
  assert.equal(canRetryWorkspaceJob(nonRetryable), false);
  expectTransitionError(
    nonRetryable,
    { type: "retry", at: TIMES.retried },
    /cannot be retried/,
  );

  const maxed = failedJob(true, 2);
  assert.equal(maxed.attempt, 2);
  assert.equal(canRetryWorkspaceJob(maxed), false);
  expectTransitionError(
    maxed,
    { type: "retry", at: TIMES.retried },
    /cannot be retried/,
  );
}

function assertIdempotencySemantics() {
  const tabular = createWorkspaceJob({
    id: "tabular-1",
    type: "tabular_cell",
    payload: { rowId: "row-1", columnId: "col-1", prompt: "Sensitive prompt" },
    maxAttempts: 3,
    createdAt: TIMES.created,
    idempotencyKey: "tabular:row-1:col-1:v1",
  });
  const completed = transitionWorkspaceJob(
    transitionWorkspaceJob(tabular, { type: "start", at: TIMES.started }),
    { type: "complete", at: TIMES.completed, result: { value: 42 } },
  );
  assert.equal(
    canReuseCompletedJob(
      completed,
      "tabular_cell",
      "tabular:row-1:col-1:v1",
    ),
    true,
  );
  assert.equal(
    canReuseCompletedJob(completed, "tabular_cell", "tabular:row-1:col-2:v1"),
    false,
  );
  expectTransitionError(
    completed,
    { type: "start", at: TIMES.retried },
    /is not allowed/,
  );
  assert.throws(
    () =>
      createWorkspaceJob({
        id: "bad-idempotency",
        type: "document_parse",
        payload: { documentId: "doc-2" },
        maxAttempts: 1,
        createdAt: TIMES.created,
        idempotencyKey: "not-allowed",
      }),
    /Only tabular_cell jobs may declare an idempotency key/,
  );
}

function assertErrorAndProjectionSanitization() {
  const failed = failedJob(true);
  assert.match(failed.error?.message ?? "", /\[redacted\]/);
  assert.equal(
    JSON.stringify(failed.error).includes("sk-test-secret-value-1234567890"),
    false,
  );
  const projection = projectWorkspaceJobForLogs(failed);
  const serialized = JSON.stringify(projection);
  assert.equal(serialized.includes("Never print this prompt"), false);
  assert.equal(serialized.includes("Classify this document verbatim"), false);
  assert.equal(serialized.includes("sk-test-secret-value-1234567890"), false);
  assert.equal(serialized.includes("Bearer super-secret-token"), false);
  assert.equal(serialized.includes("\"prompt\""), false);
  assert.equal(serialized.includes("\"document\""), false);
  assert.equal(serialized.includes("\"apiKey\""), false);
  const valueProjection = projectWorkspaceJobValueForLogs({
    prompt: "Top secret",
    document: "Classified",
    apiKey: "sk-top-secret",
    ok: true,
  });
  assert.deepEqual(valueProjection, {
    kind: "object",
    totalKeys: 4,
    keys: ["ok"],
    sensitiveKeyCount: 3,
  });
}

function assertBoundaryValidation() {
  assert.throws(
    () =>
      createWorkspaceJob({
        id: "bad-payload",
        type: "workflow_run",
        payload: { fn() {} },
        maxAttempts: 1,
        createdAt: TIMES.created,
      }),
    /must be JSON-like data/,
  );
  assert.throws(
    () =>
      transitionWorkspaceJob(runningJob(), {
        type: "complete",
        at: TIMES.completed,
        result: { invalid: Number.NaN },
      }),
    /must not contain NaN or Infinity/,
  );
}

assertAllowedTransitions();
assertDuplicateCompletionBlocked();
assertCancellationTerminal();
assertRecoverySemantics();
assertRetrySemantics();
assertIdempotencySemantics();
assertErrorAndProjectionSanitization();
assertBoundaryValidation();

console.log(
  JSON.stringify(
    {
      ok: true,
      suite: "vera-workspace-job-state-v1",
      checks: [
        "legal and illegal job status transitions",
        "duplicate completion and terminal cancellation blocking",
        "restart recovery converts running jobs to interrupted",
        "retry eligibility and max-attempt enforcement",
        "tabular-cell idempotency reuse and non-idempotent rerun blocking",
        "payload result and error sanitization for safe logging",
      ],
    },
    null,
    2,
  ),
);
