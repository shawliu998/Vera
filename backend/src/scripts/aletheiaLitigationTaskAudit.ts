import assert from "node:assert/strict";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { LocalDatabase } from "../lib/aletheia/localDatabase";

type RecordValue = Record<string, any>;

function asRecord(value: unknown) {
  return value as RecordValue;
}

async function closeServer(server: http.Server) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function jsonRequest(
  baseUrl: string,
  pathname: string,
  options: { method?: string; body?: unknown } = {},
) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method ?? "GET",
    headers:
      options.body === undefined
        ? undefined
        : { "content-type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { response, body: await response.json() };
}

async function main() {
  const dataDir = mkdtempSync(
    path.join(os.tmpdir(), "aletheia-litigation-task-audit-"),
  );
  process.env.ALETHEIA_AUTH_MODE = "single_user";
  process.env.ALETHEIA_DATA_DIR = dataDir;
  process.env.ALETHEIA_LOCAL_USER_ID = "task-route-user";
  process.env.ALETHEIA_LOCAL_USER_EMAIL = "task-route@aletheia.internal";
  process.env.ALETHEIA_APPLICATION_ENCRYPTION = "disabled";
  process.env.ALETHEIA_DATABASE_ENCRYPTION = "metadata_plaintext";

  let server: http.Server | null = null;
  try {
    const [{ createAletheiaRepository }, { litigationRouter }] =
      await Promise.all([
        import("../lib/aletheia"),
        import("../routes/litigation"),
      ]);
    const repo = createAletheiaRepository();
    const ctx = {
      userId: "task-route-user",
      userEmail: "task-route@aletheia.internal",
    };
    const foreignCtx = {
      userId: "foreign-task-user",
      userEmail: "foreign-task@aletheia.internal",
    };

    const createMatter = async (owner: typeof ctx, title: string) =>
      asRecord(
        await repo.createMatter(owner, {
          title,
          objective: "Verify confirmed deadline task persistence.",
          template: "civil_litigation",
          status: "in_progress",
          riskLevel: "high",
          clientOrProject: "Task audit",
          sourceProjectId: null,
          sharedWith: [],
          metadata: { audit: "litigation_task" },
        }),
      );
    const matter = await createMatter(ctx, "Task route matter");
    const otherMatter = await createMatter(ctx, "Other task route matter");
    const foreignMatter = await createMatter(foreignCtx, "Foreign task matter");

    const createDeadline = async (
      owner: typeof ctx,
      matterId: string,
      title: string,
      dueAt: string,
    ) =>
      asRecord(
        await repo.createLitigationDeadline(owner, matterId, {
          title,
          dueAt,
          ruleLabel: "Court order",
          ruleVersion: "court-order-v1",
          calculation: "Date stated in confirmed court order.",
          createdBy: "human",
          metadata: { audit: true },
        }),
      );
    const confirmDeadline = async (
      owner: typeof ctx,
      matterId: string,
      deadlineId: string,
    ) =>
      repo.decideLitigationDeadline(owner, matterId, deadlineId, {
        decision: "confirmed",
        comment: "Confirmed for task creation audit.",
      });

    const proposed = await createDeadline(
      ctx,
      matter.id,
      "Proposed deadline cannot create a task",
      "2026-08-01T09:00:00+08:00",
    );
    const confirmed = await createDeadline(
      ctx,
      matter.id,
      "File evidence package",
      "2026-08-03T18:00:00+08:00",
    );
    await confirmDeadline(ctx, matter.id, confirmed.id);
    const otherMatterDeadline = await createDeadline(
      ctx,
      otherMatter.id,
      "Other matter deadline",
      "2026-08-04T18:00:00+08:00",
    );
    await confirmDeadline(ctx, otherMatter.id, otherMatterDeadline.id);
    const rejected = await createDeadline(
      ctx,
      matter.id,
      "Rejected deadline cannot create a task",
      "2026-08-05T18:00:00+08:00",
    );
    await repo.decideLitigationDeadline(ctx, matter.id, rejected.id, {
      decision: "rejected",
      comment: "Rejected for negative task audit.",
    });

    const app = express();
    app.use(express.json({ limit: "1mb" }));
    app.use("/aletheia", litigationRouter);
    server = app.listen(0, HOST);
    await new Promise<void>((resolve) => server?.once("listening", resolve));
    const address = server.address();
    assert(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    for (const [deadlineId, routeMatterId] of [
      [proposed.id, matter.id],
      [rejected.id, matter.id],
      [otherMatterDeadline.id, matter.id],
    ]) {
      const denied = await jsonRequest(
        baseUrl,
        `/aletheia/matters/${routeMatterId}/litigation/deadlines/${deadlineId}/task`,
        { method: "POST", body: {} },
      );
      assert.equal(denied.response.status, 404);
    }
    const invalidPriority = await jsonRequest(
      baseUrl,
      `/aletheia/matters/${matter.id}/litigation/deadlines/${confirmed.id}/task`,
      { method: "POST", body: { priority: "urgent" } },
    );
    assert.equal(invalidPriority.response.status, 400);

    const created = await jsonRequest(
      baseUrl,
      `/aletheia/matters/${matter.id}/litigation/deadlines/${confirmed.id}/task`,
      {
        method: "POST",
        body: {
          title: "Prepare and file evidence package",
          priority: "high",
          note: "Confirm service immediately after filing.",
        },
      },
    );
    assert.equal(created.response.status, 201);
    const task = asRecord(created.body);
    assert.deepEqual(Object.keys(task).sort(), [
      "completed_at",
      "created_at",
      "due_at",
      "id",
      "invalidated_at",
      "invalidated_reason",
      "matter_id",
      "note",
      "priority",
      "source_deadline_id",
      "status",
      "title",
      "updated_at",
      "user_id",
    ]);
    assert.equal(task.matter_id, matter.id);
    assert.equal(task.user_id, ctx.userId);
    assert.equal(task.source_deadline_id, confirmed.id);
    assert.equal(task.due_at, confirmed.due_at);
    assert.equal(task.status, "open");
    assert.equal(task.priority, "high");
    assert.equal(task.completed_at, null);
    assert.equal(task.invalidated_at, null);
    assert.equal(task.invalidated_reason, null);

    const duplicate = await jsonRequest(
      baseUrl,
      `/aletheia/matters/${matter.id}/litigation/deadlines/${confirmed.id}/task`,
      {
        method: "POST",
        body: { title: "Must not replace existing task", priority: "low" },
      },
    );
    assert.equal(duplicate.response.status, 200);
    assert.equal(asRecord(duplicate.body).id, task.id);
    assert.equal(asRecord(duplicate.body).title, task.title);
    assert.equal(asRecord(duplicate.body).priority, "high");

    const open = await jsonRequest(baseUrl, "/aletheia/tasks?status=open");
    assert.equal(open.response.status, 200);
    assert.deepEqual(
      (open.body as RecordValue[]).map((item) => item.id),
      [task.id],
    );
    const defaultOpen = await jsonRequest(baseUrl, "/aletheia/tasks");
    assert.equal(defaultOpen.response.status, 200);
    assert.equal((defaultOpen.body as RecordValue[]).length, 1);
    const invalidStatus = await jsonRequest(
      baseUrl,
      "/aletheia/tasks?status=pending",
    );
    assert.equal(invalidStatus.response.status, 400);

    const completed = await jsonRequest(
      baseUrl,
      `/aletheia/tasks/${task.id}/complete`,
      { method: "POST" },
    );
    assert.equal(completed.response.status, 200);
    assert.equal(asRecord(completed.body).status, "completed");
    assert.equal(typeof asRecord(completed.body).completed_at, "string");
    const completedAt = asRecord(completed.body).completed_at;
    const completedAgain = await jsonRequest(
      baseUrl,
      `/aletheia/tasks/${task.id}/complete`,
      { method: "POST" },
    );
    assert.equal(completedAgain.response.status, 200);
    assert.equal(asRecord(completedAgain.body).completed_at, completedAt);
    const completedList = await jsonRequest(
      baseUrl,
      "/aletheia/tasks?status=completed",
    );
    assert.deepEqual(
      (completedList.body as RecordValue[]).map((item) => item.id),
      [task.id],
    );

    const reopened = await jsonRequest(
      baseUrl,
      `/aletheia/tasks/${task.id}/reopen`,
      { method: "POST" },
    );
    assert.equal(reopened.response.status, 200);
    assert.equal(asRecord(reopened.body).status, "open");
    assert.equal(asRecord(reopened.body).completed_at, null);
    const reopenedAgain = await jsonRequest(
      baseUrl,
      `/aletheia/tasks/${task.id}/reopen`,
      { method: "POST" },
    );
    assert.equal(reopenedAgain.response.status, 200);

    const completedDeadline = await createDeadline(
      ctx,
      matter.id,
      "Completed deadline remains task eligible",
      "2026-08-06T18:00:00+08:00",
    );
    await confirmDeadline(ctx, matter.id, completedDeadline.id);
    const auditDb = new LocalDatabase(path.join(dataDir, "aletheia.db"));
    try {
      auditDb
        .prepare(
          "update aletheia_litigation_deadlines set status = 'completed' where id = ?",
        )
        .run(completedDeadline.id);
    } finally {
      auditDb.close();
    }
    const fromCompletedDeadline = await jsonRequest(
      baseUrl,
      `/aletheia/matters/${matter.id}/litigation/deadlines/${completedDeadline.id}/task`,
      { method: "POST", body: {} },
    );
    assert.equal(fromCompletedDeadline.response.status, 201);
    assert.equal(
      asRecord(fromCompletedDeadline.body).title,
      completedDeadline.title,
    );
    assert.equal(asRecord(fromCompletedDeadline.body).priority, "normal");

    const foreignDeadline = await createDeadline(
      foreignCtx,
      foreignMatter.id,
      "Foreign user's deadline",
      "2026-08-07T18:00:00+08:00",
    );
    await confirmDeadline(foreignCtx, foreignMatter.id, foreignDeadline.id);
    const foreignResult = asRecord(
      await repo.createTaskFromLitigationDeadline(
        foreignCtx,
        foreignMatter.id,
        foreignDeadline.id,
        {},
      ),
    );
    assert.equal(foreignResult.created, true);
    assert.equal((await repo.listTasks(foreignCtx, "all")).length, 1);
    assert.equal(await repo.completeTask(foreignCtx, task.id), null);
    assert.equal(
      await repo.createTaskFromLitigationDeadline(
        foreignCtx,
        matter.id,
        confirmed.id,
        {},
      ),
      null,
    );

    const all = await jsonRequest(baseUrl, "/aletheia/tasks?status=all");
    assert.equal(all.response.status, 200);
    assert.deepEqual(
      (all.body as RecordValue[]).map((item) => item.user_id),
      [ctx.userId, ctx.userId],
    );
    const foreignComplete = await jsonRequest(
      baseUrl,
      `/aletheia/tasks/${foreignResult.task.id}/complete`,
      { method: "POST" },
    );
    assert.equal(foreignComplete.response.status, 404);

    const notificationDb = new LocalDatabase(path.join(dataDir, "aletheia.db"));
    try {
      notificationDb
        .prepare("update aletheia_tasks set due_at = ? where id = ?")
        .run(new Date(Date.now() + 60 * 60 * 1000).toISOString(), task.id);
    } finally {
      notificationDb.close();
    }
    const firstClaim = await jsonRequest(
      baseUrl,
      "/aletheia/task-notifications/claim",
      { method: "POST" },
    );
    assert.equal(firstClaim.response.status, 200);
    assert.equal(firstClaim.body.claims.length, 1);
    assert.equal(firstClaim.body.claims[0].taskId, task.id);
    assert.equal(firstClaim.body.claims[0].category, "due_soon");
    const delivery = asRecord(firstClaim.body.claims[0]);
    const duplicateClaim = await jsonRequest(
      baseUrl,
      "/aletheia/task-notifications/claim",
      { method: "POST" },
    );
    assert.equal(duplicateClaim.body.claims.length, 0);
    const staleAck = await jsonRequest(
      baseUrl,
      `/aletheia/task-notifications/${delivery.deliveryId}/ack`,
      {
        method: "POST",
        body: {
          leaseToken: "wrong-lease-token",
          outcome: "delivered",
        },
      },
    );
    assert.equal(staleAck.response.status, 409);
    const failedAck = await jsonRequest(
      baseUrl,
      `/aletheia/task-notifications/${delivery.deliveryId}/ack`,
      {
        method: "POST",
        body: {
          leaseToken: delivery.leaseToken,
          outcome: "failed",
          failureCode: "native_error",
        },
      },
    );
    assert.equal(failedAck.response.status, 200);
    const retryClaim = await jsonRequest(
      baseUrl,
      "/aletheia/task-notifications/claim",
      { method: "POST" },
    );
    assert.equal(retryClaim.body.claims.length, 1);
    assert.equal(retryClaim.body.claims[0].attemptCount, 2);
    const retryDelivery = asRecord(retryClaim.body.claims[0]);
    const deliveredAck = await jsonRequest(
      baseUrl,
      `/aletheia/task-notifications/${retryDelivery.deliveryId}/ack`,
      {
        method: "POST",
        body: {
          leaseToken: retryDelivery.leaseToken,
          outcome: "delivered",
        },
      },
    );
    assert.equal(deliveredAck.response.status, 200);
    const deliveredDuplicate = await jsonRequest(
      baseUrl,
      "/aletheia/task-notifications/claim",
      { method: "POST" },
    );
    assert.equal(deliveredDuplicate.body.claims.length, 0);
    assert.equal(
      await repo.acknowledgeTaskNotification(
        foreignCtx,
        retryDelivery.deliveryId,
        {
          leaseToken: retryDelivery.leaseToken,
          outcome: "delivered",
        },
      ),
      null,
    );
    await repo.completeTask(ctx, task.id);
    const withdrawn = await jsonRequest(
      baseUrl,
      "/aletheia/task-notifications/claim",
      { method: "POST" },
    );
    assert.equal(withdrawn.body.withdrawals.length, 1);
    assert.equal(withdrawn.body.withdrawals[0].tag, retryDelivery.tag);

    const detail = asRecord(await repo.getMatterDetail(ctx, matter.id));
    const actions = detail.auditEvents.map(
      (event: RecordValue) => event.action,
    );
    assert.equal(
      actions.filter(
        (action: string) => action === "litigation_deadline_task_created",
      ).length,
      2,
    );
    assert.ok(actions.includes("task_notification_failed"));
    assert.ok(actions.includes("task_notification_delivered"));
    assert.ok(actions.includes("task_notification_withdrawn"));
    assert.equal(
      actions.filter((action: string) => action === "litigation_task_completed")
        .length,
      2,
    );
    assert.equal(
      actions.filter((action: string) => action === "litigation_task_reopened")
        .length,
      1,
    );

    const persistenceDb = new LocalDatabase(path.join(dataDir, "aletheia.db"));
    try {
      const persisted = persistenceDb
        .prepare(
          "select * from aletheia_tasks where user_id = ? order by due_at asc",
        )
        .all(ctx.userId) as RecordValue[];
      assert.equal(persisted.length, 2);
      assert.equal(
        persistenceDb
          .prepare(
            "select count(*) as count from aletheia_tasks where user_id = ? and source_deadline_id = ?",
          )
          .get(ctx.userId, confirmed.id)?.count,
        1,
      );
      const delivery = persistenceDb
        .prepare(
          "select * from aletheia_task_notification_deliveries where task_id = ?",
        )
        .get(task.id) as RecordValue;
      assert.equal(delivery.status, "withdrawn");
      assert.equal(delivery.attempt_count, 2);
      assert.equal(delivery.lease_token, null);
    } finally {
      persistenceDb.close();
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          suite: "aletheia-litigation-deadline-task-v1",
          matterId: matter.id,
          taskIds: (all.body as RecordValue[]).map((item) => item.id),
          checks: [
            "confirmed and completed deadline eligibility",
            "proposed rejected and cross-matter denial",
            "idempotent deadline task creation",
            "open completed and all filters",
            "idempotent complete and reopen transitions",
            "cross-user task isolation",
            "leased notification claim and stale-lease rejection",
            "failed display retry and delivered acknowledgement",
            "task-completion notification withdrawal",
            "matter audit events",
            "SQLite task persistence and unique source deadline",
          ],
        },
        null,
        2,
      ),
    );
  } finally {
    if (server) await closeServer(server);
    rmSync(dataDir, { recursive: true, force: true });
  }
}

const HOST = "127.0.0.1";

main().catch((error) => {
  console.error("[aletheia-litigation-task-audit] failed", error);
  process.exitCode = 1;
});
