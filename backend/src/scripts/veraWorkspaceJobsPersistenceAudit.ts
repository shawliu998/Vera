import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { WorkspaceDatabase } from "../lib/workspace/database";
import {
  createWorkspaceJob,
  projectWorkspaceJobForLogs,
  transitionWorkspaceJob,
} from "../lib/workspace/jobs/stateMachine";
import {
  WorkspaceJobPersistenceError,
  parseWorkspaceJobRowV7,
  type WorkspaceJobRow,
} from "../lib/workspace/jobPersistenceV7";
import {
  DuplicateWorkspaceJobError,
  WorkspaceJobConflictError,
  WorkspaceJobLeaseLostError,
  WorkspaceJobsRepository,
  type WorkspaceJobStoredRecord,
} from "../lib/workspace/repositories/jobs";
import {
  WorkspaceJobAbortRegistry,
  WorkspaceJobRuntime,
  WorkspaceJobsService,
} from "../lib/workspace/services/jobs";
import { createWorkspaceJobEnqueuer } from "../lib/workspace/services/jobEnqueuer";

const root = mkdtempSync(
  path.join(os.tmpdir(), "vera-workspace-jobs-persistence-"),
);
const persistenceDbPath = path.join(root, "workspace-persistence.db");
const claimFenceDbPath = path.join(root, "workspace-claim-fence.db");
const runtimeDbPath = path.join(root, "workspace-runtime.db");
const BASE_TIME = new Date("2026-07-14T12:00:00.000Z").getTime();
let tick = 0;

const IDS = {
  persistenceJob: "11111111-1111-4111-8111-111111111111",
  persistenceResource: "21111111-1111-4111-8111-111111111111",
  competitionJob: "31111111-1111-4111-8111-111111111111",
  competitionResource: "41111111-1111-4111-8111-111111111111",
  successJob: "51111111-1111-4111-8111-111111111111",
  successResource: "61111111-1111-4111-8111-111111111111",
  failureJob: "71111111-1111-4111-8111-111111111111",
  failureResource: "81111111-1111-4111-8111-111111111111",
  retryJob: "91111111-1111-4111-8111-111111111111",
  retryResource: "a1111111-1111-4111-8111-111111111111",
  tabularJob: "b1111111-1111-4111-8111-111111111111",
  tabularResource: "c1111111-1111-4111-8111-111111111111",
  cancelJob: "d1111111-1111-4111-8111-111111111111",
  cancelResource: "e1111111-1111-4111-8111-111111111111",
  queuedCancelJob: "f1111111-1111-4111-8111-111111111111",
  queuedCancelResource: "12111111-1111-4111-8111-111111111111",
  missingHandlerJob: "13111111-1111-4111-8111-111111111111",
  missingHandlerResource: "14111111-1111-4111-8111-111111111111",
  recoveryJob: "15111111-1111-4111-8111-111111111111",
  recoveryResource: "16111111-1111-4111-8111-111111111111",
  rollbackJob: "17111111-1111-4111-8111-111111111111",
  rollbackResource: "18111111-1111-4111-8111-111111111111",
  workflowJobOne: "19111111-1111-4111-8111-111111111111",
  workflowRunOne: "1a111111-1111-4111-8111-111111111111",
  workflowJobTwo: "1b111111-1111-4111-8111-111111111111",
  workflowRunTwo: "1c111111-1111-4111-8111-111111111111",
  leasedJob: "1d111111-1111-4111-8111-111111111111",
  leasedResource: "1e111111-1111-4111-8111-111111111111",
  adapterCellJob: "1f111111-1111-4111-8111-111111111111",
  adapterCellResource: "22111111-1111-4111-8111-111111111111",
  raceCellJob: "23111111-1111-4111-8111-111111111111",
  raceCellResource: "24111111-1111-4111-8111-111111111111",
  claimFenceAtomicJob: "27111111-1111-4111-8111-111111111111",
  claimFenceAtomicResource: "28111111-1111-4111-8111-111111111111",
  claimFenceRetryJob: "29111111-1111-4111-8111-111111111111",
  claimFenceRetryResource: "2a111111-1111-4111-8111-111111111111",
  claimFenceCancelJob: "2b111111-1111-4111-8111-111111111111",
  claimFenceCancelResource: "2c111111-1111-4111-8111-111111111111",
} as const;

const CLAIM_FENCE_SECRET = "claim-fence-secret-must-never-leak";

function nextDate() {
  const date = new Date(BASE_TIME + tick * 1000);
  tick += 1;
  return date;
}

function createDatabase(databasePath: string) {
  return new WorkspaceDatabase(databasePath);
}

function createRepository(database: WorkspaceDatabase) {
  return new WorkspaceJobsRepository(database);
}

function createService(
  repository: WorkspaceJobsRepository,
  abortRegistry?: WorkspaceJobAbortRegistry,
  ids: readonly string[] = [],
) {
  let index = 0;
  return new WorkspaceJobsService(repository, {
    now: nextDate,
    createId: () => ids[index++] ?? randomUUID(),
    abortRegistry,
  });
}

function rowFor(database: WorkspaceDatabase, id: string) {
  return database
    .prepare(
      `SELECT
         id,
         queued_at,
         cancellation_reason,
         lease_owner,
         lease_expires_at,
         idempotency_key,
         result_json
       FROM jobs
      WHERE id = ?`,
    )
    .get(id);
}

function assertSnapshot(
  value: {
    id: string;
    attempt: number;
    maxAttempts: number;
    status: string;
  } | null,
  expected: Partial<{
    id: string;
    attempt: number;
    maxAttempts: number;
    status: string;
  }>,
) {
  assert.ok(value);
  for (const [key, item] of Object.entries(expected)) {
    assert.equal((value as Record<string, unknown>)[key], item);
  }
}

function assertStableLeaseLost(action: () => unknown) {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof WorkspaceJobLeaseLostError);
  assert.equal(thrown.message, "Workspace job claim lease was lost.");
  assert.equal(thrown.message.includes(CLAIM_FENCE_SECRET), false);
}

function rawFailedJobRow(errorJson: string): WorkspaceJobRow {
  const at = "2026-07-14T12:00:00.000Z";
  return {
    id: randomUUID(),
    type: "document_parse",
    status: "failed",
    resource_type: "document",
    resource_id: randomUUID(),
    idempotency_key: null,
    priority: 0,
    attempt: 1,
    max_attempts: 2,
    retryable: 0,
    payload_json: "{}",
    result_json: null,
    error_json: errorJson,
    error_code: "workspace_job_failed",
    scheduled_at: at,
    queued_at: at,
    locked_at: null,
    lease_owner: null,
    lease_expires_at: null,
    started_at: at,
    completed_at: at,
    cancel_requested_at: null,
    cancellation_reason: null,
    created_at: at,
    updated_at: at,
  };
}

function rawCancelledJobRow(
  reason: unknown,
  input: { resultJson?: string | null } = {},
): WorkspaceJobRow {
  const at = "2026-07-14T12:00:00.000Z";
  return {
    id: randomUUID(),
    type: "document_parse",
    status: "cancelled",
    resource_type: "document",
    resource_id: randomUUID(),
    idempotency_key: null,
    priority: 0,
    attempt: 0,
    max_attempts: 2,
    retryable: 0,
    payload_json: "{}",
    result_json: input.resultJson ?? null,
    error_json: null,
    error_code: null,
    scheduled_at: at,
    queued_at: at,
    locked_at: null,
    lease_owner: null,
    lease_expires_at: null,
    started_at: null,
    completed_at: at,
    cancel_requested_at: at,
    cancellation_reason: reason,
    created_at: at,
    updated_at: at,
  };
}

function legacyCancellationResultEnvelope(reason: unknown): string {
  return JSON.stringify({
    schema: "vera-workspace-job-cancellation-v1",
    cancellation: {
      requestedAt: "2026-07-14T12:00:00.000Z",
      reason,
    },
  });
}

async function auditFrozenJobErrorParser() {
  for (const errorJson of ["false", "0", '""']) {
    assert.throws(
      () => parseWorkspaceJobRowV7(rawFailedJobRow(errorJson)),
      WorkspaceJobPersistenceError,
    );
  }
  for (const reason of [false, 0, {}, ["x"], ""]) {
    assert.throws(
      () => parseWorkspaceJobRowV7(rawCancelledJobRow(reason)),
      WorkspaceJobPersistenceError,
    );
    assert.throws(
      () =>
        parseWorkspaceJobRowV7(
          rawCancelledJobRow(null, {
            resultJson: legacyCancellationResultEnvelope(reason),
          }),
        ),
      WorkspaceJobPersistenceError,
    );
  }
  for (const reason of ["safe reason", null]) {
    assert.equal(
      parseWorkspaceJobRowV7(
        rawCancelledJobRow(null, {
          resultJson: legacyCancellationResultEnvelope(reason),
        }),
      ).cancellation?.reason,
      reason,
    );
  }
  for (const reason of [`A\0secret`, "\ud800"]) {
    assert.throws(
      () =>
        parseWorkspaceJobRowV7(
          rawCancelledJobRow(null, {
            resultJson: legacyCancellationResultEnvelope(reason),
          }),
        ),
      WorkspaceJobPersistenceError,
    );
  }
  assert.throws(
    () =>
      parseWorkspaceJobRowV7(
        rawFailedJobRow(
          JSON.stringify({
            code: "workspace_job_failed",
            message: "Legacy failure",
            retryable: false,
            details: { api_key: "plaintext-secret" },
          }),
        ),
      ),
    WorkspaceJobPersistenceError,
  );
  const persistedSecretError = parseWorkspaceJobRowV7(
    rawFailedJobRow(
      JSON.stringify({
        code: "workspace_job_failed",
        message:
          "provider failed with api_key=plaintextsecret and sk-test-secret-123456",
        retryable: false,
        details: null,
      }),
    ),
  );
  const projectedPersistedError = JSON.stringify(
    projectWorkspaceJobForLogs(persistedSecretError),
  );
  assert.equal(projectedPersistedError.includes("plaintextsecret"), false);
  assert.equal(
    projectedPersistedError.includes("sk-test-secret-123456"),
    false,
  );

  const persistedSecretCancellation = parseWorkspaceJobRowV7(
    rawCancelledJobRow("user cancelled api_key=plaintextsecret"),
  );
  const projectedCancellation = JSON.stringify(
    projectWorkspaceJobForLogs(persistedSecretCancellation),
  );
  assert.equal(projectedCancellation.includes("plaintextsecret"), false);
  assert.throws(
    () =>
      parseWorkspaceJobRowV7(
        rawFailedJobRow(
          JSON.stringify({
            code: "workspace_job_failed",
            message: "Legacy failure",
            retryable: false,
            details: {
              kind: "object",
              totalKeys: 1,
              keys: ["api_key"],
              sensitiveKeyCount: 0,
            },
          }),
        ),
      ),
    WorkspaceJobPersistenceError,
  );

  const queued = createWorkspaceJob({
    id: randomUUID(),
    type: "document_parse",
    payload: { documentId: randomUUID() },
    maxAttempts: 1,
    createdAt: "2026-07-14T12:00:00.000Z",
  });
  const running = transitionWorkspaceJob(queued, {
    type: "start",
    at: "2026-07-14T12:00:01.000Z",
  });
  const failed = transitionWorkspaceJob(running, {
    type: "fail",
    at: "2026-07-14T12:00:02.000Z",
    error: {
      code: "workspace_job_failed",
      message: "provider failed",
      retryable: false,
      details: { api_key: "plaintext-secret", visible: "safe" },
    },
  });
  assert.equal(failed.error?.details?.kind, "object");
  assert.deepEqual(
    failed.error?.details?.kind === "object" ? failed.error.details.keys : [],
    ["visible"],
  );
  assert.equal(
    JSON.stringify(projectWorkspaceJobForLogs(failed)).includes(
      "plaintext-secret",
    ),
    false,
  );
}

function sentinelValue(database: WorkspaceDatabase, jobId: string) {
  const row = database
    .prepare("SELECT value FROM claim_fence_sentinel WHERE job_id = ?")
    .get(jobId) as { value?: unknown } | undefined;
  assert.equal(typeof row?.value, "string");
  return row?.value as string;
}

function createClaimFenceJob(
  repository: WorkspaceJobsRepository,
  input: {
    id: string;
    resourceId: string;
    createdAt: string;
    maxAttempts: number;
    payload: unknown;
  },
) {
  return repository.createJob({
    job: repository.toRecord({
      id: input.id,
      type: "document_parse",
      payload: input.payload,
      maxAttempts: input.maxAttempts,
      createdAt: input.createdAt,
    }),
    resourceType: "document",
    resourceId: input.resourceId,
  });
}

async function auditPersistenceAcrossReopen() {
  const database = createDatabase(persistenceDbPath);
  try {
    const repository = createRepository(database);
    const service = createService(repository, undefined, [IDS.persistenceJob]);
    const created = service.createJob({
      type: "document_parse",
      payload: {
        documentId: IDS.persistenceResource,
        prompt: "top secret prompt",
      },
      resourceType: "document",
      resourceId: IDS.persistenceResource,
      maxAttempts: 2,
      scheduledAt: "2026-07-14T12:00:00.000Z",
    });
    assert.equal(created.created, true);
    assert.equal(created.job.id, IDS.persistenceJob);
    assert.equal(created.job.queuedAt, "2026-07-14T12:00:00.000Z");
    const raw = rowFor(database, IDS.persistenceJob);
    assert.equal(raw?.queued_at, "2026-07-14T12:00:00.000Z");
  } finally {
    database.close();
  }

  const reopened = createDatabase(persistenceDbPath);
  try {
    const repository = createRepository(reopened);
    const persisted = repository.getJob(IDS.persistenceJob);
    assert.ok(persisted);
    assert.equal(persisted?.status, "queued");
    assert.equal(persisted?.queuedAt, "2026-07-14T12:00:00.000Z");
    assert.equal(repository.listJobs().length, 1);
  } finally {
    reopened.close();
  }
}

async function auditTransactionlessClaimFence() {
  const database = createDatabase(claimFenceDbPath);
  const repository = createRepository(database);
  const atomicPayload = {
    documentId: IDS.claimFenceAtomicResource,
    instruction: CLAIM_FENCE_SECRET,
    options: { language: "zh-CN", mode: "exact" },
  };

  try {
    database.exec(`CREATE TABLE claim_fence_sentinel (
      job_id TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT`);

    createClaimFenceJob(repository, {
      id: IDS.claimFenceAtomicJob,
      resourceId: IDS.claimFenceAtomicResource,
      createdAt: "2026-07-15T00:00:00.000Z",
      maxAttempts: 1,
      payload: atomicPayload,
    });
    database
      .prepare("INSERT INTO claim_fence_sentinel (job_id, value) VALUES (?, ?)")
      .run(IDS.claimFenceAtomicJob, "initial");

    const atomicClaim = repository.claimNextQueued(
      "2026-07-15T00:00:01.000Z",
      "claim-fence-worker-a",
      "2026-07-15T00:10:00.000Z",
    );
    assert.equal(atomicClaim?.id, IDS.claimFenceAtomicJob);
    assert.equal(atomicClaim?.attempt, 1);

    database.exec("BEGIN IMMEDIATE");
    try {
      const asserted = repository.assertClaimInCurrentTransaction({
        id: IDS.claimFenceAtomicJob,
        type: "document_parse",
        resourceType: "document",
        resourceId: IDS.claimFenceAtomicResource,
        payload: atomicPayload,
        leaseOwner: "claim-fence-worker-a",
        attempt: 1,
        at: "2026-07-15T00:00:02.000Z",
      });
      assert.equal(asserted.id, IDS.claimFenceAtomicJob);
      assert.deepEqual(asserted.payload, atomicPayload);

      assertStableLeaseLost(() =>
        repository.assertClaimInCurrentTransaction({
          id: "deadbeef-1111-4111-8111-111111111111",
          type: "document_parse",
          resourceType: "document",
          resourceId: IDS.claimFenceAtomicResource,
          payload: atomicPayload,
          leaseOwner: "claim-fence-worker-a",
          attempt: 1,
          at: "2026-07-15T00:00:02.000Z",
        }),
      );
      assertStableLeaseLost(() =>
        repository.assertClaimInCurrentTransaction({
          id: IDS.claimFenceAtomicJob,
          type: "assistant_generate",
          resourceType: "document",
          resourceId: IDS.claimFenceAtomicResource,
          payload: atomicPayload,
          leaseOwner: "claim-fence-worker-a",
          attempt: 1,
          at: "2026-07-15T00:00:02.000Z",
        }),
      );
      assertStableLeaseLost(() =>
        repository.assertClaimInCurrentTransaction({
          id: IDS.claimFenceAtomicJob,
          type: "document_parse",
          resourceType: "chat",
          resourceId: IDS.claimFenceAtomicResource,
          payload: atomicPayload,
          leaseOwner: "claim-fence-worker-a",
          attempt: 1,
          at: "2026-07-15T00:00:02.000Z",
        }),
      );
      assertStableLeaseLost(() =>
        repository.assertClaimInCurrentTransaction({
          id: IDS.claimFenceAtomicJob,
          type: "document_parse",
          resourceType: "document",
          resourceId: IDS.claimFenceRetryResource,
          payload: atomicPayload,
          leaseOwner: "claim-fence-worker-a",
          attempt: 1,
          at: "2026-07-15T00:00:02.000Z",
        }),
      );
      assertStableLeaseLost(() =>
        repository.assertClaimInCurrentTransaction({
          id: IDS.claimFenceAtomicJob,
          type: "document_parse",
          resourceType: "document",
          resourceId: IDS.claimFenceAtomicResource,
          payload: {
            ...atomicPayload,
            instruction: `${CLAIM_FENCE_SECRET}-mismatch`,
          },
          leaseOwner: "claim-fence-worker-a",
          attempt: 1,
          at: "2026-07-15T00:00:02.000Z",
        }),
      );
      assertStableLeaseLost(() =>
        repository.assertClaimInCurrentTransaction({
          id: IDS.claimFenceAtomicJob,
          type: "document_parse",
          resourceType: "document",
          resourceId: IDS.claimFenceAtomicResource,
          payload: atomicPayload,
          leaseOwner: "claim-fence-worker-b",
          attempt: 1,
          at: "2026-07-15T00:00:02.000Z",
        }),
      );
      assertStableLeaseLost(() =>
        repository.assertClaimInCurrentTransaction({
          id: IDS.claimFenceAtomicJob,
          type: "document_parse",
          resourceType: "document",
          resourceId: IDS.claimFenceAtomicResource,
          payload: atomicPayload,
          leaseOwner: "claim-fence-worker-a",
          attempt: 2,
          at: "2026-07-15T00:00:02.000Z",
        }),
      );
      assertStableLeaseLost(() =>
        repository.assertClaimInCurrentTransaction({
          id: IDS.claimFenceAtomicJob,
          type: "document_parse",
          resourceType: "document",
          resourceId: IDS.claimFenceAtomicResource,
          payload: atomicPayload,
          leaseOwner: "claim-fence-worker-a",
          attempt: 1,
          at: "2026-07-15T00:10:00.000Z",
        }),
      );
      database.exec("ROLLBACK");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }

    database.exec("BEGIN IMMEDIATE");
    try {
      database
        .prepare("UPDATE claim_fence_sentinel SET value = ? WHERE job_id = ?")
        .run("rolled-back-domain-write", IDS.claimFenceAtomicJob);
      const completedInsideRolledBackTransaction =
        repository.finishClaimInCurrentTransaction({
          id: IDS.claimFenceAtomicJob,
          type: "document_parse",
          resourceType: "document",
          resourceId: IDS.claimFenceAtomicResource,
          payload: atomicPayload,
          leaseOwner: "claim-fence-worker-a",
          attempt: 1,
          event: {
            type: "complete",
            at: "2026-07-15T00:00:03.000Z",
            result: { parsed: true },
          },
        });
      assert.equal(completedInsideRolledBackTransaction.status, "complete");
      assert.equal(
        repository.getJob(IDS.claimFenceAtomicJob)?.status,
        "complete",
      );
      assert.equal(
        sentinelValue(database, IDS.claimFenceAtomicJob),
        "rolled-back-domain-write",
      );
      database.exec("ROLLBACK");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    assert.equal(sentinelValue(database, IDS.claimFenceAtomicJob), "initial");
    assert.equal(repository.getJob(IDS.claimFenceAtomicJob)?.status, "running");

    database.exec("BEGIN IMMEDIATE");
    try {
      database
        .prepare("UPDATE claim_fence_sentinel SET value = ? WHERE job_id = ?")
        .run("committed-domain-write", IDS.claimFenceAtomicJob);
      const completed = repository.finishClaimInCurrentTransaction({
        id: IDS.claimFenceAtomicJob,
        type: "document_parse",
        resourceType: "document",
        resourceId: IDS.claimFenceAtomicResource,
        payload: atomicPayload,
        leaseOwner: "claim-fence-worker-a",
        attempt: 1,
        event: {
          type: "complete",
          at: "2026-07-15T00:00:04.000Z",
          result: { parsed: true, committed: true },
        },
      });
      assert.equal(completed.status, "complete");
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    assert.equal(
      sentinelValue(database, IDS.claimFenceAtomicJob),
      "committed-domain-write",
    );
    assert.equal(
      repository.getJob(IDS.claimFenceAtomicJob)?.status,
      "complete",
    );

    database.exec("BEGIN IMMEDIATE");
    try {
      assertStableLeaseLost(() =>
        repository.assertClaimInCurrentTransaction({
          id: IDS.claimFenceAtomicJob,
          type: "document_parse",
          resourceType: "document",
          resourceId: IDS.claimFenceAtomicResource,
          payload: atomicPayload,
          leaseOwner: "claim-fence-worker-a",
          attempt: 1,
          at: "2026-07-15T00:00:05.000Z",
        }),
      );
      database.exec("ROLLBACK");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }

    const retryPayload = {
      documentId: IDS.claimFenceRetryResource,
      instruction: CLAIM_FENCE_SECRET,
    };
    createClaimFenceJob(repository, {
      id: IDS.claimFenceRetryJob,
      resourceId: IDS.claimFenceRetryResource,
      createdAt: "2026-07-15T01:00:00.000Z",
      maxAttempts: 2,
      payload: retryPayload,
    });
    database
      .prepare("INSERT INTO claim_fence_sentinel (job_id, value) VALUES (?, ?)")
      .run(IDS.claimFenceRetryJob, "initial");
    const firstAttempt = repository.claimNextQueued(
      "2026-07-15T01:00:01.000Z",
      "claim-fence-old-worker",
      "2026-07-15T01:00:05.000Z",
    );
    assert.equal(firstAttempt?.id, IDS.claimFenceRetryJob);
    assert.equal(firstAttempt?.attempt, 1);
    const recovered = repository.recoverStaleRunningJobs(
      "2026-07-15T01:00:05.000Z",
    );
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].status, "queued");
    assert.equal(recovered[0].attempt, 1);
    const secondAttempt = repository.claimNextQueued(
      "2026-07-15T01:00:06.000Z",
      "claim-fence-current-worker",
      "2026-07-15T01:10:00.000Z",
    );
    assert.equal(secondAttempt?.id, IDS.claimFenceRetryJob);
    assert.equal(secondAttempt?.attempt, 2);

    database.exec("BEGIN IMMEDIATE");
    try {
      database
        .prepare("UPDATE claim_fence_sentinel SET value = ? WHERE job_id = ?")
        .run("stale-claim-domain-write", IDS.claimFenceRetryJob);
      assertStableLeaseLost(() =>
        repository.finishClaimInCurrentTransaction({
          id: IDS.claimFenceRetryJob,
          type: "document_parse",
          resourceType: "document",
          resourceId: IDS.claimFenceRetryResource,
          payload: retryPayload,
          leaseOwner: "claim-fence-old-worker",
          attempt: 1,
          event: {
            type: "complete",
            at: "2026-07-15T01:00:07.000Z",
            result: { stale: true, secret: CLAIM_FENCE_SECRET },
          },
        }),
      );
      assert.equal(
        repository.getJob(IDS.claimFenceRetryJob)?.status,
        "running",
      );
      assert.equal(repository.getJob(IDS.claimFenceRetryJob)?.attempt, 2);
      database.exec("ROLLBACK");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    assert.equal(sentinelValue(database, IDS.claimFenceRetryJob), "initial");
    assert.equal(repository.getJob(IDS.claimFenceRetryJob)?.status, "running");
    assert.equal(repository.getJob(IDS.claimFenceRetryJob)?.attempt, 2);

    database.exec("BEGIN IMMEDIATE");
    try {
      database
        .prepare("UPDATE claim_fence_sentinel SET value = ? WHERE job_id = ?")
        .run("current-claim-domain-write", IDS.claimFenceRetryJob);
      const completed = repository.finishClaimInCurrentTransaction({
        id: IDS.claimFenceRetryJob,
        type: "document_parse",
        resourceType: "document",
        resourceId: IDS.claimFenceRetryResource,
        payload: retryPayload,
        leaseOwner: "claim-fence-current-worker",
        attempt: 2,
        event: {
          type: "complete",
          at: "2026-07-15T01:00:08.000Z",
          result: { current: true },
        },
      });
      assert.equal(completed.status, "complete");
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    assert.equal(
      sentinelValue(database, IDS.claimFenceRetryJob),
      "current-claim-domain-write",
    );

    const cancellationPayload = {
      documentId: IDS.claimFenceCancelResource,
      instruction: CLAIM_FENCE_SECRET,
    };
    createClaimFenceJob(repository, {
      id: IDS.claimFenceCancelJob,
      resourceId: IDS.claimFenceCancelResource,
      createdAt: "2026-07-15T02:00:00.000Z",
      maxAttempts: 1,
      payload: cancellationPayload,
    });
    const cancellationClaim = repository.claimNextQueued(
      "2026-07-15T02:00:01.000Z",
      "claim-fence-cancel-worker",
      "2026-07-15T02:10:00.000Z",
    );
    assert.equal(cancellationClaim?.id, IDS.claimFenceCancelJob);
    const cancellationRequested = repository.requestCancellation(
      IDS.claimFenceCancelJob,
      "2026-07-15T02:00:02.000Z",
      "claim fence cancellation fixture",
    );
    assert.ok(cancellationRequested.cancelRequestedAt);

    database.exec("BEGIN IMMEDIATE");
    try {
      assertStableLeaseLost(() =>
        repository.assertClaimInCurrentTransaction({
          id: IDS.claimFenceCancelJob,
          type: "document_parse",
          resourceType: "document",
          resourceId: IDS.claimFenceCancelResource,
          payload: cancellationPayload,
          leaseOwner: "claim-fence-cancel-worker",
          attempt: 1,
          at: "2026-07-15T02:00:03.000Z",
        }),
      );
      assertStableLeaseLost(() =>
        repository.finishClaimInCurrentTransaction({
          id: IDS.claimFenceCancelJob,
          type: "document_parse",
          resourceType: "document",
          resourceId: IDS.claimFenceCancelResource,
          payload: cancellationPayload,
          leaseOwner: "claim-fence-cancel-worker",
          attempt: 1,
          event: {
            type: "complete",
            at: "2026-07-15T02:00:03.000Z",
            result: { mustNotPersist: true },
          },
        }),
      );
      database.exec("ROLLBACK");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    const cancelled = repository.finishClaim({
      id: IDS.claimFenceCancelJob,
      leaseOwner: "claim-fence-cancel-worker",
      attempt: 1,
      event: {
        type: "cancel",
        at: "2026-07-15T02:00:04.000Z",
        reason: "claim fence cancellation fixture",
      },
    });
    assert.equal(cancelled.status, "cancelled");
  } finally {
    database.close();
  }
}

async function auditRuntimeRepositoryAndAdapter() {
  const database = createDatabase(runtimeDbPath);
  const abortRegistry = new WorkspaceJobAbortRegistry();
  const repository = createRepository(database);
  const service = createService(repository, abortRegistry, [
    IDS.competitionJob,
    IDS.leasedJob,
    IDS.successJob,
    IDS.failureJob,
    IDS.retryJob,
    IDS.tabularJob,
    IDS.cancelJob,
    IDS.queuedCancelJob,
    IDS.missingHandlerJob,
  ]);
  const adapter = createWorkspaceJobEnqueuer(database, { now: nextDate });

  try {
    const runtime = new WorkspaceJobRuntime(
      repository,
      {
        document_parse: ({ signal, job }) => {
          if (job.id === IDS.successJob) {
            return { parsed: true, summary: "done" };
          }
          if (job.id === IDS.failureJob) {
            throw new Error(
              "provider returned apiKey=sk-test-super-secret-1234567890",
            );
          }
          if (job.id === IDS.retryJob) {
            throw {
              code: "temporary_provider_outage",
              message: "temporary provider outage",
              retryable: true,
            };
          }
          if (job.id === IDS.cancelJob) {
            return new Promise((resolve, reject) => {
              signal.addEventListener(
                "abort",
                () => {
                  const error = new Error("aborted");
                  error.name = "AbortError";
                  reject(error);
                },
                { once: true },
              );
              setImmediate(() => {
                resolve({ late: "completion" });
              });
            });
          }
          return { noop: true };
        },
        assistant_generate: ({ job }) => ({ chat: job.resourceId }),
        tabular_cell: ({ job }) => ({ cell: job.resourceId }),
      },
      {
        now: nextDate,
        abortRegistry,
        leaseOwner: "runtime-worker-1",
        leaseDurationMs: 120_000,
      },
    );

    const preRunning = repository.createJob({
      job: repository.toRecord({
        id: IDS.recoveryJob,
        type: "assistant_generate",
        payload: { chatId: IDS.recoveryResource },
        maxAttempts: 2,
        createdAt: nextDate().toISOString(),
      }),
      resourceType: "chat",
      resourceId: IDS.recoveryResource,
    });
    const claimedRecovery = repository.claimNextQueued(
      nextDate().toISOString(),
      "bootstrap-worker",
      nextDate().toISOString(),
    );
    assert.equal(claimedRecovery?.id, preRunning.id);
    assert.equal(claimedRecovery?.leaseOwner, "bootstrap-worker");
    assert.ok(claimedRecovery?.leaseExpiresAt);

    const recoveredOnStart = await runtime.start();
    assert.equal(recoveredOnStart.length, 1);
    assert.equal(recoveredOnStart[0].id, IDS.recoveryJob);
    assert.equal(recoveredOnStart[0].status, "interrupted");
    assert.equal(recoveredOnStart[0].error?.retryable, true);
    assert.equal(recoveredOnStart[0].leaseOwner, null);
    assert.equal(recoveredOnStart[0].leaseExpiresAt, null);

    const competition = service.createJob({
      type: "document_parse",
      payload: { documentId: IDS.competitionResource },
      resourceType: "document",
      resourceId: IDS.competitionResource,
      maxAttempts: 1,
      priority: 10,
    }).job;
    const secondConnection = createDatabase(runtimeDbPath);
    try {
      const secondRepository = createRepository(secondConnection);
      const claimTimeOne = nextDate();
      const claimedFirst = repository.claimNextQueued(
        claimTimeOne.toISOString(),
        "claim-worker-1",
        new Date(claimTimeOne.getTime() + 60_000).toISOString(),
      );
      assert.equal(claimedFirst?.id, competition.id);
      assert.equal(claimedFirst?.leaseOwner, "claim-worker-1");
      const claimedSecond = secondRepository.claimNextQueued(
        nextDate().toISOString(),
        "claim-worker-2",
        nextDate().toISOString(),
      );
      assert.notEqual(claimedSecond?.id, competition.id);
      repository.persistTransition(claimedFirst!.id, {
        type: "interrupt",
        at: nextDate().toISOString(),
        error: {
          code: "competition_release",
          message: "release claimed fixture",
          retryable: true,
        },
      });
      if (claimedSecond) {
        secondRepository.persistTransition(claimedSecond.id, {
          type: "interrupt",
          at: nextDate().toISOString(),
          error: {
            code: "competition_release_second",
            message: "release secondary claimed fixture",
            retryable: true,
          },
        });
      }
    } finally {
      secondConnection.close();
    }

    const leasedJob = service.createJob({
      type: "assistant_generate",
      payload: { chatId: IDS.leasedResource },
      resourceType: "chat",
      resourceId: IDS.leasedResource,
      maxAttempts: 2,
    }).job;
    const leaseClaimTime = nextDate();
    const leaseExpiresAt = new Date(
      leaseClaimTime.getTime() + 30_000,
    ).toISOString();
    const leased = repository.claimNextQueued(
      leaseClaimTime.toISOString(),
      "lease-worker",
      leaseExpiresAt,
    );
    assert.equal(leased?.id, leasedJob.id);
    assert.equal(leased?.leaseOwner, "lease-worker");
    assert.equal(leased?.leaseExpiresAt, leaseExpiresAt);
    const renewed = repository.renewLease(
      leasedJob.id,
      "lease-worker",
      "2026-07-14T12:03:00.000Z",
      "2026-07-14T12:02:30.000Z",
    );
    assert.equal(renewed.leaseExpiresAt, "2026-07-14T12:03:00.000Z");
    const released = repository.releaseLease(
      leasedJob.id,
      "lease-worker",
      "2026-07-14T12:02:40.000Z",
    );
    assert.equal(released.leaseOwner, null);
    assert.equal(released.leaseExpiresAt, null);
    repository.persistTransition(leasedJob.id, {
      type: "interrupt",
      at: nextDate().toISOString(),
      error: {
        code: "leased_release",
        message: "release leased fixture",
        retryable: true,
      },
    });

    database.exec("BEGIN IMMEDIATE");
    try {
      const workflowOne = adapter.enqueueInCurrentTransaction({
        id: IDS.workflowJobOne,
        type: "workflow_run",
        resourceType: "workflow_run",
        resourceId: IDS.workflowRunOne,
        idempotencyKey: "workflow_run:v1:shared",
        payload: { workflowRunId: IDS.workflowRunOne },
        maxAttempts: 1,
        now: nextDate().toISOString(),
      });
      const workflowTwo = adapter.enqueueInCurrentTransaction({
        id: IDS.workflowJobTwo,
        type: "workflow_run",
        resourceType: "workflow_run",
        resourceId: IDS.workflowRunTwo,
        idempotencyKey: "workflow_run:v1:shared",
        payload: { workflowRunId: IDS.workflowRunTwo },
        maxAttempts: 1,
        now: nextDate().toISOString(),
      });
      assertSnapshot(workflowOne, { id: IDS.workflowJobOne, status: "queued" });
      assertSnapshot(workflowTwo, { id: IDS.workflowJobTwo, status: "queued" });
      adapter.transitionInCurrentTransaction(IDS.workflowJobOne, {
        type: "start",
        at: nextDate().toISOString(),
      });
      adapter.transitionInCurrentTransaction(IDS.workflowJobOne, {
        type: "cancel",
        at: nextDate().toISOString(),
        reason: "workflow adapter fixture complete",
      });
      adapter.transitionInCurrentTransaction(IDS.workflowJobTwo, {
        type: "start",
        at: nextDate().toISOString(),
      });
      adapter.transitionInCurrentTransaction(IDS.workflowJobTwo, {
        type: "cancel",
        at: nextDate().toISOString(),
        reason: "workflow adapter fixture complete",
      });
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    assert.equal(repository.getJob(IDS.workflowJobOne)?.idempotencyKey, null);
    assert.equal(repository.getJob(IDS.workflowJobTwo)?.idempotencyKey, null);

    database.exec("BEGIN IMMEDIATE");
    try {
      const queued = adapter.enqueueInCurrentTransaction({
        id: IDS.adapterCellJob,
        type: "tabular_cell",
        resourceType: "tabular_cell",
        resourceId: IDS.adapterCellResource,
        idempotencyKey: "tabular_cell:v1:adapter-cell",
        payload: { documentId: IDS.adapterCellResource, columnId: "col-1" },
        maxAttempts: 1,
        now: nextDate().toISOString(),
      });
      assertSnapshot(queued, { id: IDS.adapterCellJob, status: "queued" });
      const started = adapter.transitionInCurrentTransaction(
        IDS.adapterCellJob,
        {
          type: "start",
          at: nextDate().toISOString(),
        },
      );
      assertSnapshot(started, { id: IDS.adapterCellJob, status: "running" });
      const cancelled = adapter.transitionInCurrentTransaction(
        IDS.adapterCellJob,
        {
          type: "cancel",
          at: nextDate().toISOString(),
          reason: "adapter cancelled",
        },
      );
      assertSnapshot(cancelled, {
        id: IDS.adapterCellJob,
        status: "cancelled",
      });
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    assert.equal(
      repository.getJob(IDS.adapterCellJob)?.cancellation?.reason,
      "adapter cancelled",
    );

    const raceRepository = createRepository(database);
    const raceService = new WorkspaceJobsService(raceRepository, {
      now: nextDate,
    });
    database.exec("BEGIN IMMEDIATE");
    try {
      adapter.enqueueInCurrentTransaction({
        id: IDS.raceCellJob,
        type: "tabular_cell",
        resourceType: "tabular_cell",
        resourceId: IDS.raceCellResource,
        idempotencyKey: "tabular_cell:v1:race",
        payload: { documentId: IDS.raceCellResource, columnId: "col-2" },
        maxAttempts: 1,
        now: nextDate().toISOString(),
      });
      adapter.transitionInCurrentTransaction(IDS.raceCellJob, {
        type: "start",
        at: nextDate().toISOString(),
      });
      adapter.transitionInCurrentTransaction(IDS.raceCellJob, {
        type: "cancel",
        at: nextDate().toISOString(),
        reason: "race fixture complete",
      });
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    const originalLookup =
      raceRepository.getJobByIdempotencyKey.bind(raceRepository);
    let hideFirstLookup = true;
    raceRepository.getJobByIdempotencyKey = (idempotencyKey: string) => {
      if (hideFirstLookup) {
        hideFirstLookup = false;
        return null;
      }
      return originalLookup(idempotencyKey);
    };
    assert.throws(
      () =>
        raceService.enqueueJobInCurrentTransaction({
          id: randomUUID(),
          type: "tabular_cell",
          resourceType: "tabular_cell",
          resourceId: IDS.raceCellResource,
          idempotencyKey: "tabular_cell:v1:race",
          payload: { documentId: IDS.raceCellResource, columnId: "col-2" },
          maxAttempts: 2,
          now: nextDate().toISOString(),
        }),
      WorkspaceJobConflictError,
    );

    const successCreated = service.createJob({
      type: "document_parse",
      payload: { documentId: IDS.successResource, prompt: "safe" },
      resourceType: "document",
      resourceId: IDS.successResource,
      maxAttempts: 2,
    }).job;
    const successFinal = await runtime.claimAndRun();
    assert.equal(successFinal?.id, successCreated.id);
    assert.equal(successFinal?.status, "complete");
    assert.deepEqual(successFinal?.result, { parsed: true, summary: "done" });
    assert.equal(successFinal?.leaseOwner, null);

    const failureCreated = service.createJob({
      type: "document_parse",
      payload: { documentId: IDS.failureResource, prompt: "secret prompt 2" },
      resourceType: "document",
      resourceId: IDS.failureResource,
      maxAttempts: 2,
    }).job;
    const failureFinal = await runtime.claimAndRun();
    assert.equal(failureFinal?.id, failureCreated.id);
    assert.equal(failureFinal?.status, "failed");
    assert.match(failureFinal?.error?.message ?? "", /\[redacted\]/);
    assert.equal(
      JSON.stringify(projectWorkspaceJobForLogs(failureFinal!)).includes(
        "sk-test-super-secret-1234567890",
      ),
      false,
    );

    const retryCreated = service.createJob({
      type: "document_parse",
      payload: { documentId: IDS.retryResource },
      resourceType: "document",
      resourceId: IDS.retryResource,
      maxAttempts: 2,
    }).job;
    const retryFailed = await runtime.claimAndRun();
    assert.equal(retryFailed?.id, retryCreated.id);
    assert.equal(retryFailed?.status, "failed");
    assert.equal(retryFailed?.queuedAt, retryCreated.queuedAt);
    const retried = service.retryJob(retryCreated.id);
    assert.equal(retried.status, "queued");
    assert.notEqual(retried.queuedAt, retryCreated.queuedAt);
    const retryFailedAgain = await runtime.claimAndRun();
    assert.equal(retryFailedAgain?.status, "failed");
    assert.throws(
      () => service.retryJob(retryCreated.id),
      /not eligible for retry/i,
    );

    const tabularFirst = service.createJob({
      type: "tabular_cell",
      payload: { rowId: IDS.tabularResource, columnId: IDS.tabularResource },
      resourceType: "tabular_cell",
      resourceId: IDS.tabularResource,
      idempotencyKey: "table:row-1:col-1:v1",
      maxAttempts: 2,
    });
    const tabularQueuedAgain = service.createJob({
      type: "tabular_cell",
      payload: { rowId: IDS.tabularResource, columnId: IDS.tabularResource },
      resourceType: "tabular_cell",
      resourceId: IDS.tabularResource,
      idempotencyKey: "table:row-1:col-1:v1",
      maxAttempts: 2,
    });
    assert.equal(tabularQueuedAgain.created, false);
    assert.equal(tabularQueuedAgain.job.id, tabularFirst.job.id);
    assert.throws(
      () =>
        service.createJob({
          type: "tabular_cell",
          payload: {
            rowId: IDS.tabularResource,
            columnId: IDS.tabularResource,
          },
          resourceType: "tabular_cell",
          resourceId: IDS.tabularResource,
          idempotencyKey: "table:row-1:col-1:v1",
          maxAttempts: 3,
        }),
      WorkspaceJobConflictError,
    );
    const tabularComplete = await runtime.claimAndRun();
    assert.equal(tabularComplete?.status, "complete");
    const tabularReused = service.createJob({
      type: "tabular_cell",
      payload: { rowId: IDS.tabularResource, columnId: IDS.tabularResource },
      resourceType: "tabular_cell",
      resourceId: IDS.tabularResource,
      idempotencyKey: "table:row-1:col-1:v1",
      maxAttempts: 2,
    });
    assert.equal(tabularReused.created, false);
    assert.equal(tabularReused.job.status, "complete");

    const cancelCreated = service.createJob({
      type: "document_parse",
      payload: { documentId: IDS.cancelResource },
      resourceType: "document",
      resourceId: IDS.cancelResource,
      maxAttempts: 2,
    }).job;
    const cancelPromise = runtime.claimAndRun();
    await Promise.resolve();
    const requestedCancel = service.requestCancellation(
      cancelCreated.id,
      "User requested cancellation",
    );
    assert.equal(requestedCancel.status, "running");
    assert.ok(requestedCancel.cancelRequestedAt);
    assert.equal(requestedCancel.cancellation, null);
    assert.equal(
      requestedCancel.cancellationReason,
      "User requested cancellation",
    );
    const cancelRaw = rowFor(database, cancelCreated.id);
    assert.equal(cancelRaw?.cancellation_reason, "User requested cancellation");
    const cancelled = await cancelPromise;
    assert.equal(cancelled?.status, "cancelled");
    assert.equal(
      cancelled?.cancellation?.reason,
      "User requested cancellation",
    );
    assert.equal(rowFor(database, cancelCreated.id)?.result_json, null);
    assert.throws(
      () => service.requestCancellation(cancelCreated.id, "again"),
      /cannot be cancelled again/i,
    );

    const queuedCancelCreated = service.createJob({
      type: "assistant_generate",
      payload: { chatId: IDS.queuedCancelResource },
      resourceType: "chat",
      resourceId: IDS.queuedCancelResource,
      maxAttempts: 1,
    }).job;
    const queuedCancelled = service.requestCancellation(
      queuedCancelCreated.id,
      "queued cancel",
    );
    assert.equal(queuedCancelled.status, "cancelled");
    assert.equal(queuedCancelled.cancellation?.reason, "queued cancel");

    const missingHandlerCreated = service.createJob({
      type: "workflow_run",
      payload: { workflowRunId: IDS.missingHandlerResource },
      resourceType: "workflow_run",
      resourceId: IDS.missingHandlerResource,
      maxAttempts: 1,
    }).job;
    const missingHandlerFinal = await runtime.claimAndRun();
    assert.equal(missingHandlerFinal?.id, missingHandlerCreated.id);
    assert.equal(missingHandlerFinal?.status, "failed");
    assert.equal(missingHandlerFinal?.error?.retryable, false);

    const recoveredRequeued = service.retryJob(IDS.recoveryJob);
    assert.equal(recoveredRequeued.status, "queued");

    const prepared = service.prepareCreateJob({
      type: "assistant_generate",
      payload: { chatId: "25111111-1111-4111-8111-111111111111" },
      resourceType: "chat",
      resourceId: "26111111-1111-4111-8111-111111111111",
      maxAttempts: 1,
    });
    database.exec("BEGIN IMMEDIATE");
    try {
      repository.insertPreparedJob(prepared);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }

    const adapterForRollback = {
      exec: database.exec.bind(database),
      prepare(sql: string) {
        const statement = database.prepare(sql);
        if (/UPDATE jobs\s+SET status = \?/i.test(sql)) {
          return {
            ...statement,
            get: statement.get.bind(statement),
            all: statement.all.bind(statement),
            run(..._parameters: unknown[]) {
              throw new Error("simulated update failure");
            },
          };
        }
        return statement;
      },
    };
    const rollbackRepository = new WorkspaceJobsRepository(adapterForRollback);
    const rollbackService = createService(rollbackRepository, undefined, [
      IDS.rollbackJob,
    ]);
    const rollbackJob = rollbackService.createJob({
      type: "document_parse",
      payload: { documentId: IDS.rollbackResource },
      resourceType: "document",
      resourceId: IDS.rollbackResource,
      maxAttempts: 1,
    }).job;
    assert.throws(
      () =>
        rollbackRepository.claimNextQueued(
          nextDate().toISOString(),
          "rollback-worker",
          nextDate().toISOString(),
        ),
      /simulated update failure/,
    );
    const rollbackPersisted = repository.getJob(rollbackJob.id);
    assert.equal(rollbackPersisted?.status, "queued");
    assert.equal(rollbackPersisted?.attempt, 0);

    assert.throws(
      () =>
        repository.insertPreparedJob({
          job: repository.toRecord({
            id: IDS.workflowJobOne,
            type: "workflow_run",
            payload: { workflowRunId: IDS.workflowRunOne },
            maxAttempts: 1,
            createdAt: nextDate().toISOString(),
          }),
          resourceType: "workflow_run",
          resourceId: IDS.workflowRunOne,
        }),
      DuplicateWorkspaceJobError,
    );

    await runtime.stop();
  } finally {
    database.close();
  }
}

async function main() {
  process.env.ALETHEIA_DATABASE_ENCRYPTION = "metadata_plaintext";
  await auditFrozenJobErrorParser();
  await auditPersistenceAcrossReopen();
  await auditTransactionlessClaimFence();
  await auditRuntimeRepositoryAndAdapter();
  console.log(
    JSON.stringify(
      {
        ok: true,
        suite: "vera-workspace-jobs-persistence-v2",
        checks: [
          "frozen job row parser rejects scalar error_json and unsafe error details while log projection redacts secrets",
          "job rows persist queued_at and reload across database reopen",
          "claim is atomic across competing repositories and acquires a lease",
          "lease renew and release persist lease_owner and lease_expires_at",
          "runtime start recovers running jobs as interrupted and clears leases",
          "tabular-cell idempotency reuses only exact matching jobs including maxAttempts",
          "duplicate idempotency races re-check compatibility and conflict on mismatches",
          "workflow_run adapter ignores workflow idempotency keys instead of pretending workflow jobs are idempotent",
          "transactionless adapter supports enqueue and transition inside caller-owned transactions",
          "transactionless claim fence validates identity payload lease attempt expiry and cancellation without leaking payloads",
          "domain sentinel writes and claim terminal state roll back or commit atomically in one caller-owned transaction",
          "expired and superseded claims cannot write while the current attempt can commit",
          "runtime persists success failure cancellation and missing-handler outcomes without leaking secrets",
          "transaction failures roll back partial claim updates",
        ],
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.stack : String(error)}\n`,
    );
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(root, { recursive: true, force: true });
  });
