import assert from "node:assert/strict";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { LocalDatabase } from "../lib/aletheia/localDatabase";

type RecordValue = Record<string, any>;

async function closeServer(server: http.Server) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function unfold(content: string) {
  return content.replace(/\r\n[ \t]/g, "");
}

function occurrences(content: string, value: string) {
  return content.split(value).length - 1;
}

async function main() {
  const dataDir = mkdtempSync(
    path.join(os.tmpdir(), "aletheia-task-calendar-audit-"),
  );
  const userId = "calendar-route-user";
  const foreignUserId = "foreign-calendar-user";
  process.env.ALETHEIA_AUTH_MODE = "single_user";
  process.env.ALETHEIA_DATA_DIR = dataDir;
  process.env.ALETHEIA_LOCAL_USER_ID = userId;
  process.env.ALETHEIA_LOCAL_USER_EMAIL = "calendar@aletheia.internal";
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
    const ctx = { userId, userEmail: "calendar@aletheia.internal" };
    const foreignCtx = {
      userId: foreignUserId,
      userEmail: "foreign-calendar@aletheia.internal",
    };

    const createTask = async (input: {
      owner: typeof ctx;
      matterTitle: string;
      taskTitle: string;
      dueAt: string;
      note: string;
    }) => {
      const matter = (await repo.createMatter(input.owner, {
        title: input.matterTitle,
        objective: "Task calendar audit",
        template: "civil_litigation",
        status: "in_progress",
        riskLevel: "high",
        clientOrProject: "Calendar audit",
        sourceProjectId: null,
        sharedWith: [],
        metadata: { audit: "task_calendar" },
      })) as RecordValue;
      const deadline = (await repo.createLitigationDeadline(
        input.owner,
        matter.id,
        {
          title: input.taskTitle,
          dueAt: input.dueAt,
          ruleLabel: "Court order",
          ruleVersion: "court-order-v1",
          calculation: "Date stated by court order.",
          createdBy: "human",
          metadata: {},
        },
      )) as RecordValue;
      await repo.decideLitigationDeadline(input.owner, matter.id, deadline.id, {
        decision: "confirmed",
        comment: "Calendar audit confirmation.",
      });
      const result = (await repo.createTaskFromLitigationDeadline(
        input.owner,
        matter.id,
        deadline.id,
        { title: input.taskTitle, priority: "high", note: input.note },
      )) as { task: RecordValue };
      return { matter, task: result.task };
    };

    const open = await createTask({
      owner: ctx,
      matterTitle: "王氏诉讼, 特殊;事项\\一",
      taskTitle:
        "提交,答辩; \\旁注\n第二行与足够长的中文内容用于验证多字节 UTF-8 日历折行不会截断字符",
      dueAt: "2026-08-03T18:00:00+08:00",
      note: "核对附件,签名;并记录\\结果\n不得泄露路径",
    });
    const completed = await createTask({
      owner: ctx,
      matterTitle: "Completed matter",
      taskTitle: "Completed filing",
      dueAt: "2026-08-04T01:30:00-04:00",
      note: "Already filed.",
    });
    await repo.completeTask(ctx, completed.task.id);
    const foreign = await createTask({
      owner: foreignCtx,
      matterTitle: "FOREIGN SECRET MATTER",
      taskTitle: "FOREIGN SECRET TASK",
      dueAt: "2026-08-05T12:00:00Z",
      note: "FOREIGN SECRET NOTE",
    });

    const app = express();
    app.use("/aletheia", litigationRouter);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server?.once("listening", resolve));
    const address = server.address();
    assert(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    process.env.ALETHEIA_AUTH_MODE = "private_token";
    process.env.ALETHEIA_PRIVATE_AUTH_TOKEN =
      "calendar-audit-token-at-least-32-characters";
    const unauthenticated = await fetch(
      `${baseUrl}/aletheia/tasks/calendar.ics`,
    );
    assert.equal(unauthenticated.status, 401);
    process.env.ALETHEIA_AUTH_MODE = "single_user";

    const invalid = await fetch(
      `${baseUrl}/aletheia/tasks/calendar.ics?status=pending`,
    );
    assert.equal(invalid.status, 400);

    const defaultResponse = await fetch(
      `${baseUrl}/aletheia/tasks/calendar.ics`,
    );
    assert.equal(defaultResponse.status, 200);
    assert.equal(
      defaultResponse.headers.get("content-type"),
      "text/calendar; charset=utf-8",
    );
    assert.equal(
      defaultResponse.headers.get("content-disposition"),
      `attachment; filename="aletheia-tasks.ics"; filename*=UTF-8''aletheia-tasks.ics`,
    );
    assert.equal(
      defaultResponse.headers.get("cache-control"),
      "private, no-store",
    );
    assert.equal(defaultResponse.headers.get("pragma"), "no-cache");
    const defaultCalendar = await defaultResponse.text();
    const unfoldedOpen = unfold(defaultCalendar);
    assert(defaultCalendar.endsWith("\r\n"));
    assert(!defaultCalendar.replace(/\r\n/g, "").includes("\n"));
    for (const line of defaultCalendar.split("\r\n").slice(0, -1)) {
      assert(
        Buffer.byteLength(line, "utf8") <= 75,
        `Calendar line exceeds 75 octets: ${line}`,
      );
    }
    assert.equal(occurrences(defaultCalendar, "BEGIN:VEVENT"), 1);
    assert.equal(occurrences(defaultCalendar, "BEGIN:VALARM"), 3);
    assert(
      unfoldedOpen.includes(`UID:aletheia-task-${open.task.id}@aletheia.local`),
    );
    assert(unfoldedOpen.includes("DTSTART:20260803T100000Z"));
    assert(unfoldedOpen.includes("DTEND:20260803T110000Z"));
    assert(
      unfoldedOpen.includes(
        "SUMMARY:提交\\,答辩\\; \\\\旁注\\n第二行与足够长的中文内容用于验证多字节 UTF-8 日历折行不会截断字符",
      ),
    );
    assert(unfoldedOpen.includes("Matter: 王氏诉讼\\, 特殊\\;事项\\\\一"));
    assert(unfoldedOpen.includes("TRIGGER:-P7D"));
    assert(unfoldedOpen.includes("TRIGGER:-P1D"));
    assert(unfoldedOpen.includes("TRIGGER:-PT2H"));
    assert(unfoldedOpen.includes("STATUS:CONFIRMED"));
    assert(unfoldedOpen.includes("CATEGORIES:ALETHEIA,TASK,OPEN,HIGH"));
    assert(
      unfoldedOpen.includes(
        `URL:/aletheia/tasks?matterId=${open.matter.id}&taskId=${open.task.id}`,
      ),
    );

    const completedResponse = await fetch(
      `${baseUrl}/aletheia/tasks/calendar.ics?status=completed`,
    );
    assert.equal(completedResponse.status, 200);
    const completedCalendar = unfold(await completedResponse.text());
    assert.equal(occurrences(completedCalendar, "BEGIN:VEVENT"), 1);
    assert.equal(occurrences(completedCalendar, "BEGIN:VALARM"), 0);
    assert(completedCalendar.includes("DTSTART:20260804T053000Z"));
    assert(completedCalendar.includes("DTEND:20260804T063000Z"));
    assert(completedCalendar.includes("STATUS:CANCELLED"));
    assert(
      completedCalendar.includes("CATEGORIES:ALETHEIA,TASK,COMPLETED,HIGH"),
    );

    const allResponse = await fetch(
      `${baseUrl}/aletheia/tasks/calendar.ics?status=all`,
    );
    assert.equal(allResponse.status, 200);
    const allCalendar = unfold(await allResponse.text());
    assert.equal(occurrences(allCalendar, "BEGIN:VEVENT"), 2);
    assert(
      allCalendar.includes(`UID:aletheia-task-${open.task.id}@aletheia.local`),
    );
    assert(
      allCalendar.includes(
        `UID:aletheia-task-${completed.task.id}@aletheia.local`,
      ),
    );
    assert(!allCalendar.includes(foreign.matter.title));
    assert(!allCalendar.includes(foreign.task.title));
    assert(!allCalendar.includes("localhost"));
    assert(!allCalendar.includes("127.0.0.1"));
    assert(!allCalendar.includes("token"));
    assert(!allCalendar.includes(dataDir));

    const db = new LocalDatabase(path.join(dataDir, "aletheia.db"));
    try {
      const events = db
        .prepare(
          `select matter_id, user_id, details
             from aletheia_audit_events
            where action = 'task_calendar_exported'
            order by created_at asc, id asc`,
        )
        .all() as Array<{
        matter_id: string;
        user_id: string;
        details: string;
      }>;
      assert.equal(events.length, 4);
      assert.deepEqual(
        events.map((event) => event.user_id),
        [userId, userId, userId, userId],
      );
      assert.equal(
        events.filter((event) => event.matter_id === open.matter.id).length,
        2,
      );
      assert.equal(
        events.filter((event) => event.matter_id === completed.matter.id)
          .length,
        2,
      );
      assert.equal(
        events.filter((event) => event.matter_id === foreign.matter.id).length,
        0,
      );
      const details = events.map((event) => JSON.parse(event.details));
      assert.deepEqual(details.map((detail) => detail.status).sort(), [
        "all",
        "all",
        "completed",
        "open",
      ]);
      for (const detail of details) {
        const serialized = JSON.stringify(detail);
        assert(!serialized.includes("path"));
        assert(!serialized.includes("url"));
        assert(!serialized.includes("token"));
        assert(!serialized.includes(dataDir));
      }
    } finally {
      db.close();
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          suite: "aletheia-task-calendar-v1",
          checks: [
            "requireAuth and status validation",
            "RFC 5545 CRLF and 75-octet UTF-8 folding",
            "text escaping and UTC DTSTART/DTEND",
            "open reminders and completed suppression",
            "stable UID and relative token-free URL",
            "open completed and all filtering",
            "cross-user calendar and audit isolation",
            "safe response headers and path-free audit details",
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

main().catch((error) => {
  console.error("[aletheia-task-calendar-audit] failed", error);
  process.exitCode = 1;
});
