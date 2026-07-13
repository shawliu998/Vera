import assert from "node:assert/strict";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { LocalDatabase } from "../lib/aletheia/localDatabase";

async function request(
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
  return { response, body: (await response.json()) as Record<string, any> };
}

async function main() {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "vera-deadline-rule-"));
  process.env.ALETHEIA_AUTH_MODE = "single_user";
  process.env.ALETHEIA_DATA_DIR = dataDir;
  process.env.ALETHEIA_LOCAL_USER_ID = "deadline-rule-auditor";
  process.env.ALETHEIA_LOCAL_USER_EMAIL = "deadline@vera.local";
  process.env.ALETHEIA_APPLICATION_ENCRYPTION = "disabled";
  process.env.ALETHEIA_DATABASE_ENCRYPTION = "metadata_plaintext";

  let server: http.Server | null = null;
  try {
    const [{ createAletheiaRepository }, { litigationRouter }] =
      await Promise.all([
        import("../lib/aletheia"),
        import("../routes/litigation"),
      ]);
    const repository = createAletheiaRepository();
    const ctx = { userId: "deadline-rule-auditor" };
    const matter = (await repository.createMatter(ctx, {
      title: "Deadline rule audit",
      objective: "Verify reproducible local procedural deadline calculation.",
      template: "civil_litigation",
      status: "in_progress",
      riskLevel: "high",
      clientOrProject: "Deadline audit",
      sourceProjectId: null,
      sharedWith: [],
      metadata: {},
    })) as Record<string, any>;
    const event = (await repository.createLitigationProceduralEvent(
      ctx,
      matter.id,
      {
        eventType: "service_completed",
        title: "Service completed",
        occurredAt: "2026-06-26T02:00:00.000Z",
        createdBy: "human",
      },
    )) as Record<string, any>;
    await repository.decideLitigationProceduralEvent(ctx, matter.id, event.id, {
      decision: "confirmed",
      comment: "Counsel confirmed the service timestamp from the case record.",
    });

    const app = express();
    app.use(express.json({ limit: "2mb" }));
    app.use("/aletheia", litigationRouter);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server?.once("listening", resolve));
    const address = server.address();
    assert(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const authorityPath = `/aletheia/matters/${matter.id}/litigation/legal-authorities`;
    const ruleQuote =
      "A response must be filed within fifteen calendar days after service.";
    const businessRuleQuote =
      "A supplemental response must be filed within three court business days after service.";
    const authority = await request(baseUrl, authorityPath, {
      method: "POST",
      body: {
        authorityType: "regulation",
        title: "Civil Procedure Filing Rule",
        issuer: "Verified rulemaking authority",
        officialIdentifier: "CPFR-15",
        versionLabel: "2026 verified copy",
        sourceReference: "Named official publication copy",
        content: `${ruleQuote} ${businessRuleQuote} The verified 2026 court calendar closes 1 July and treats 4 July as an open make-up day. Filing time is measured in Asia/Shanghai.`,
        effectiveFrom: "2026-01-01",
        effectiveTo: "2026-12-31",
      },
    });
    assert.equal(authority.response.status, 201);
    assert.equal(
      (
        await request(baseUrl, `${authorityPath}/${authority.body.id}/verify`, {
          method: "POST",
          body: {
            comment:
              "Counsel checked the full rule text and effective interval against the named official copy.",
          },
        })
      ).response.status,
      200,
    );

    const rulesPath = `/aletheia/matters/${matter.id}/litigation/deadline-rules`;
    const commonRule = {
      triggerEventType: "service_completed",
      authorityVersionId: authority.body.id,
      provisionReference: "Response deadline",
      exactQuote: ruleQuote,
      offsetDays: 15,
      startPolicy: "next_day",
    };
    const missingCalendarRule = await request(baseUrl, rulesPath, {
      method: "POST",
      body: {
        ...commonRule,
        name: "Unconfigured business-day response rule",
        countingBasis: "business_days",
      },
    });
    assert.equal(missingCalendarRule.response.status, 400);
    assert.match(missingCalendarRule.body.detail, /verified court calendar/i);

    const calendarsPath = `/aletheia/matters/${matter.id}/litigation/court-calendars`;
    const calendarVersion = await request(baseUrl, calendarsPath, {
      method: "POST",
      body: {
        courtIdentifier: "SH-COMMERCIAL-COURT",
        name: "Shanghai Commercial Court working calendar",
        versionLabel: "2026 official schedule",
        sourceAuthorityVersionId: authority.body.id,
        effectiveFrom: "2026-01-01",
        effectiveTo: "2026-12-31",
        weeklyNonWorkingDays: [0, 6],
        overrides: [
          {
            localDate: "2026-07-01",
            disposition: "closed",
            sourceReference: "Official 2026 court closure schedule, item 7",
          },
          {
            localDate: "2026-07-04",
            disposition: "open",
            sourceReference: "Official 2026 make-up working schedule, item 8",
          },
        ],
      },
    });
    assert.equal(calendarVersion.response.status, 201);
    assert.match(calendarVersion.body.calendar_hash, /^sha256:[a-f0-9]{64}$/);
    const draftCalendarRule = await request(baseUrl, rulesPath, {
      method: "POST",
      body: {
        ...commonRule,
        name: "Draft-calendar rule must fail",
        exactQuote: businessRuleQuote,
        offsetDays: 3,
        countingBasis: "business_days",
        courtCalendarVersionId: calendarVersion.body.id,
      },
    });
    assert.equal(draftCalendarRule.response.status, 400);
    const calendarVerify = await request(
      baseUrl,
      `${calendarsPath}/${calendarVersion.body.id}/verify`,
      {
        method: "POST",
        body: {
          comment:
            "Counsel checked the full yearly schedule and each exception against the named official publication.",
        },
      },
    );
    assert.equal(calendarVerify.response.status, 200);
    assert.equal(calendarVerify.body.status, "verified");

    const businessRule = await request(baseUrl, rulesPath, {
      method: "POST",
      body: {
        ...commonRule,
        name: "Three court-business-day response rule",
        exactQuote: businessRuleQuote,
        offsetDays: 3,
        countingBasis: "business_days",
        courtCalendarVersionId: calendarVersion.body.id,
      },
    });
    assert.equal(businessRule.response.status, 201);
    assert.equal(businessRule.body.court_calendar_hash, calendarVersion.body.calendar_hash);
    const businessVerify = await request(
      baseUrl,
      `${rulesPath}/${businessRule.body.id}/verify`,
      {
        method: "POST",
        body: {
          comment:
            "Counsel verified business-day counting against the exact court calendar version.",
        },
      },
    );
    assert.equal(businessVerify.response.status, 200);
    const businessDeadline = await request(
      baseUrl,
      `${rulesPath}/${businessRule.body.id}/calculate`,
      {
        method: "POST",
        body: { eventId: event.id, title: "Supplemental response deadline" },
      },
    );
    assert.equal(businessDeadline.response.status, 201);
    assert.equal(businessDeadline.body.due_at, "2026-07-02T15:59:59.000Z");
    assert.equal(
      businessDeadline.body.court_calendar_version_id,
      calendarVersion.body.id,
    );
    const businessMetadata =
      typeof businessDeadline.body.metadata === "string"
        ? JSON.parse(businessDeadline.body.metadata)
        : businessDeadline.body.metadata;
    assert.equal(businessMetadata.businessDayTrace[2].reason, "regular_working_day");
    assert.equal(businessMetadata.businessDayTrace[4].reason, "override_closed");
    assert.equal(businessMetadata.businessDayTrace.at(-1).date, "2026-07-02");
    await repository.decideLitigationDeadline(ctx, matter.id, businessDeadline.body.id, {
      decision: "confirmed",
      comment: "Counsel checked every counted and skipped local date in the trace.",
    });
    const businessTask = (await repository.createTaskFromLitigationDeadline(
      ctx,
      matter.id,
      businessDeadline.body.id,
      { priority: "high", note: "Bound to the verified court calendar version." },
    )) as Record<string, any>;
    await repository.claimTaskNotifications(ctx);

    const tamperDb = new LocalDatabase(path.join(dataDir, "aletheia.db"));
    assert.throws(() =>
      tamperDb
        .prepare(
          "update aletheia_litigation_court_calendar_day_overrides set disposition = 'open' where calendar_version_id = ? and local_date = '2026-07-01'",
        )
        .run(calendarVersion.body.id),
    );
    assert.throws(() =>
      tamperDb
        .prepare(
          "update aletheia_litigation_court_calendar_versions set calendar_hash = 'sha256:tampered' where id = ?",
        )
        .run(calendarVersion.body.id),
    );
    tamperDb.close();

    const calendarRetirement = await request(
      baseUrl,
      `${calendarsPath}/${calendarVersion.body.id}/retire`,
      {
        method: "POST",
        body: {
          comment:
            "Counsel retired this schedule after publication of a replacement calendar version.",
        },
      },
    );
    assert.equal(calendarRetirement.response.status, 200);
    assert.equal(calendarRetirement.body.retiredRules, 1);
    assert.equal(calendarRetirement.body.invalidatedDeadlines, 1);
    assert.equal(calendarRetirement.body.invalidatedTasks, 1);
    const retiredBusinessTask = (
      (await repository.listTasks(ctx, "all")) as Array<Record<string, any>>
    ).find((item) => item.id === businessTask.task.id);
    assert.match(retiredBusinessTask?.invalidated_reason, /Court calendar version retired/);
    assert.equal(
      (await repository.exportTaskCalendar(ctx, "all")).some(
        (item) => item.id === businessTask.task.id,
      ),
      false,
    );
    const calendarNotificationSweep = (await repository.claimTaskNotifications(
      ctx,
    )) as Record<string, any>;
    assert.equal(
      calendarNotificationSweep.withdrawals.some(
        (item: Record<string, unknown>) => item.taskId === businessTask.task.id,
      ),
      true,
      "calendar retirement must withdraw the invalidated task notification",
    );

    const rollbackDb = new LocalDatabase(path.join(dataDir, "aletheia.db"));
    rollbackDb.exec(`create trigger force_calendar_audit_failure
      before insert on aletheia_audit_events
      when new.action = 'litigation_court_calendar_version_created'
      begin select raise(abort, 'forced court calendar audit rollback'); end;`);
    rollbackDb.close();
    await assert.rejects(
      () =>
        repository.createLitigationCourtCalendarVersion(ctx, matter.id, {
          courtIdentifier: "SH-COMMERCIAL-COURT",
          name: "Shanghai Commercial Court working calendar",
          versionLabel: "Rollback probe",
          sourceAuthorityVersionId: authority.body.id,
          effectiveFrom: "2027-01-01",
          effectiveTo: "2027-12-31",
          weeklyNonWorkingDays: [0, 6],
          overrides: [],
        }),
      /forced court calendar audit rollback/,
    );
    const rollbackCheckDb = new LocalDatabase(path.join(dataDir, "aletheia.db"));
    rollbackCheckDb.exec("drop trigger force_calendar_audit_failure");
    assert.equal(
      rollbackCheckDb
        .prepare(
          "select count(*) as n from aletheia_litigation_court_calendar_versions where calendar_id = ?",
        )
        .get(calendarVersion.body.calendar_id).n,
      1,
    );
    rollbackCheckDb.close();

    const calendarRule = await request(baseUrl, rulesPath, {
      method: "POST",
      body: {
        ...commonRule,
        name: "Fifteen calendar-day response rule",
        countingBasis: "calendar_days",
      },
    });
    assert.equal(calendarRule.response.status, 201);
    assert.match(calendarRule.body.rule_hash, /^sha256:[a-f0-9]{64}$/);
    const calculatePath = `${rulesPath}/${calendarRule.body.id}/calculate`;
    assert.equal(
      (
        await request(baseUrl, calculatePath, {
          method: "POST",
          body: { eventId: event.id, title: "Response filing deadline" },
        })
      ).response.status,
      404,
      "draft rules must not calculate deadlines",
    );
    const verifyPath = `${rulesPath}/${calendarRule.body.id}/verify`;
    assert.equal(
      (
        await request(baseUrl, verifyPath, {
          method: "POST",
          body: { comment: "short" },
        })
      ).response.status,
      400,
    );
    const verified = await request(baseUrl, verifyPath, {
      method: "POST",
      body: {
        comment:
          "Counsel verified next-day calendar counting and the local day-end convention.",
      },
    });
    assert.equal(verified.response.status, 200);
    assert.equal(verified.body.status, "verified");

    const deadline = await request(baseUrl, calculatePath, {
      method: "POST",
      body: { eventId: event.id, title: "Response filing deadline" },
    });
    assert.equal(deadline.response.status, 201);
    assert.equal(deadline.body.status, "proposed");
    assert.equal(deadline.body.due_at, "2026-07-11T15:59:59.000Z");
    const deadlineMetadata =
      typeof deadline.body.metadata === "string"
        ? JSON.parse(deadline.body.metadata)
        : deadline.body.metadata;
    assert.equal(deadlineMetadata.deadlineRuleId, calendarRule.body.id);
    assert.equal(deadlineMetadata.ruleHash, calendarRule.body.rule_hash);
    assert.equal(deadlineMetadata.triggerDate, "2026-06-26");
    await repository.decideLitigationDeadline(
      ctx,
      matter.id,
      deadline.body.id,
      {
        decision: "confirmed",
        comment:
          "Counsel independently checked the calculation trace and due date.",
      },
    );
    const taskResult = (await repository.createTaskFromLitigationDeadline(
      ctx,
      matter.id,
      deadline.body.id,
      { priority: "high", note: "Derived from the verified local rule." },
    )) as Record<string, any>;
    assert.equal(taskResult.created, true);
    const initialNotifications = (await repository.claimTaskNotifications(
      ctx,
    )) as Record<string, any>;
    assert.equal(
      initialNotifications.claims.some(
        (item: Record<string, unknown>) => item.taskId === taskResult.task.id,
      ),
      true,
      "a valid due-soon task should enter the notification lease",
    );

    const ruleTamperDb = new LocalDatabase(path.join(dataDir, "aletheia.db"));
    ruleTamperDb
      .prepare(
        "update aletheia_litigation_deadline_rules set offset_days = 16 where id = ?",
      )
      .run(calendarRule.body.id);
    ruleTamperDb.close();
    const tamperedRuleCalculation = await request(baseUrl, calculatePath, {
      method: "POST",
      body: { eventId: event.id, title: "Tampered rule must not calculate" },
    });
    assert.equal(tamperedRuleCalculation.response.status, 409);
    assert.match(tamperedRuleCalculation.body.detail, /immutable rule hash/i);

    const retirePath = `${rulesPath}/${calendarRule.body.id}/retire`;
    assert.equal(
      (
        await request(baseUrl, retirePath, {
          method: "POST",
          body: { comment: "short" },
        })
      ).response.status,
      400,
    );
    const retired = await request(baseUrl, retirePath, {
      method: "POST",
      body: {
        comment:
          "Counsel retired the rule after determining that it requires replacement.",
      },
    });
    assert.equal(retired.response.status, 200);
    assert.equal(retired.body.status, "retired");
    assert.equal(
      (
        await request(baseUrl, calculatePath, {
          method: "POST",
          body: { eventId: event.id, title: "Must not recalculate" },
        })
      ).response.status,
      404,
    );
    const workspace = (await repository.getLitigationWorkspace(
      ctx,
      matter.id,
    )) as Record<string, any>;
    const staleDeadline = workspace.deadlines.find(
      (item: Record<string, unknown>) => item.id === deadline.body.id,
    );
    assert.match(staleDeadline.stale_reason, /Deadline rule retired/);
    const invalidatedTask = (
      (await repository.listTasks(ctx, "all")) as Array<Record<string, any>>
    ).find((item) => item.id === taskResult.task.id);
    assert.match(invalidatedTask?.invalidated_reason, /rule retired/);
    const notificationSweep = (await repository.claimTaskNotifications(
      ctx,
    )) as Record<string, any>;
    assert.equal(
      notificationSweep.withdrawals.some(
        (item: Record<string, unknown>) => item.taskId === taskResult.task.id,
      ),
      true,
      "rule retirement must withdraw an existing notification lease",
    );
    await assert.rejects(
      () => repository.completeTask(ctx, taskResult.task.id),
      /invalidated deadline task/,
    );
    assert.equal(
      (await repository.exportTaskCalendar(ctx, "all")).some(
        (item) => item.id === taskResult.task.id,
      ),
      false,
      "invalidated deadline tasks must not enter calendar exports",
    );

    const sourceCalendarQuote =
      "A source-calendar response is due within one court business day after service.";
    const sourceCalendarAuthority = (await repository.createLitigationLegalAuthorityVersion(
      ctx,
      matter.id,
      {
        authorityType: "regulation",
        title: "Source calendar retirement rule",
        issuer: "Verified court administration",
        officialIdentifier: "SOURCE-CALENDAR-2026",
        versionLabel: "2026 official copy",
        sourceReference: "Named official court administration publication",
        content: `${sourceCalendarQuote} The court is closed on weekends.`,
        effectiveFrom: "2026-01-01",
        effectiveTo: "2026-12-31",
      },
    )) as Record<string, any>;
    await repository.verifyLitigationLegalAuthorityVersion(
      ctx,
      matter.id,
      sourceCalendarAuthority.id,
      { comment: "Counsel checked the named source and effective interval." },
    );
    const sourceBoundCalendar = (await repository.createLitigationCourtCalendarVersion(
      ctx,
      matter.id,
      {
        courtIdentifier: "SOURCE-RETIREMENT-COURT",
        name: "Source retirement court calendar",
        versionLabel: "2026 official schedule",
        sourceAuthorityVersionId: sourceCalendarAuthority.id,
        effectiveFrom: "2026-01-01",
        effectiveTo: "2026-12-31",
        weeklyNonWorkingDays: [0, 6],
        overrides: [],
      },
    )) as Record<string, any>;
    await repository.verifyLitigationCourtCalendarVersion(
      ctx,
      matter.id,
      sourceBoundCalendar.id,
      { comment: "Counsel compared the complete schedule with its named source." },
    );
    const sourceBoundRule = (await repository.createLitigationDeadlineRule(
      ctx,
      matter.id,
      {
        name: "Source-bound one business day rule",
        triggerEventType: "service_completed",
        authorityVersionId: sourceCalendarAuthority.id,
        provisionReference: "Source-calendar deadline",
        exactQuote: sourceCalendarQuote,
        offsetDays: 1,
        countingBasis: "business_days",
        courtCalendarVersionId: sourceBoundCalendar.id,
        startPolicy: "next_day",
      },
    )) as Record<string, any>;
    await repository.verifyLitigationDeadlineRule(ctx, matter.id, sourceBoundRule.id, {
      comment: "Counsel verified the rule and exact calendar source binding.",
    });
    const sourceBoundDeadline = (await repository.calculateLitigationDeadlineFromRule(
      ctx,
      matter.id,
      sourceBoundRule.id,
      { eventId: event.id, title: "Source-bound business deadline" },
    )) as Record<string, any>;
    await repository.decideLitigationDeadline(ctx, matter.id, sourceBoundDeadline.id, {
      decision: "confirmed",
      comment: "Counsel checked the one-day business calculation trace.",
    });
    const sourceBoundTask = (await repository.createTaskFromLitigationDeadline(
      ctx,
      matter.id,
      sourceBoundDeadline.id,
      { priority: "normal" },
    )) as Record<string, any>;
    const sourceRetirement = (await repository.retireLitigationLegalAuthorityVersion(
      ctx,
      matter.id,
      sourceCalendarAuthority.id,
      { comment: "The publishing authority withdrew this calendar source version." },
    )) as Record<string, any>;
    assert.equal(sourceRetirement.status, "retired");
    const sourceCalendarProjection = (
      (await repository.listLitigationCourtCalendarVersions(
        ctx,
        matter.id,
      )) as Array<Record<string, any>>
    ).find((item) => item.id === sourceBoundCalendar.id);
    assert.equal(sourceCalendarProjection?.status, "retired");
    const sourceDeadlineProjection = (
      (await repository.getLitigationWorkspace(ctx, matter.id)) as Record<string, any>
    ).deadlines.find((item: Record<string, unknown>) => item.id === sourceBoundDeadline.id);
    assert.match(sourceDeadlineProjection.stale_reason, /Legal authority version retired/);
    const sourceTaskProjection = (
      (await repository.listTasks(ctx, "all")) as Array<Record<string, any>>
    ).find((item) => item.id === sourceBoundTask.task.id);
    assert.match(sourceTaskProjection?.invalidated_reason, /Source deadline authority retired/);

    const listed = await request(baseUrl, rulesPath);
    assert.equal(listed.response.status, 200);
    assert.equal(listed.body.length, 3);
    assert.equal(
      await repository.listLitigationDeadlineRules(
        { userId: "different-user" },
        matter.id,
      ),
      null,
    );
    assert.equal(
      await repository.listLitigationCourtCalendarVersions(
        { userId: "different-user" },
        matter.id,
      ),
      null,
    );
    const detail = (await repository.getMatterDetail(ctx, matter.id)) as Record<
      string,
      any
    >;
    const actions = new Set(
      detail.auditEvents.map((item: Record<string, unknown>) => item.action),
    );
    assert(actions.has("litigation_deadline_rule_created"));
    assert(actions.has("litigation_deadline_rule_verified"));
    assert(actions.has("litigation_deadline_calculated_from_verified_rule"));
    assert(actions.has("litigation_deadline_rule_retired"));
    assert(actions.has("litigation_court_calendar_version_created"));
    assert(actions.has("litigation_court_calendar_version_verified"));
    assert(actions.has("litigation_court_calendar_version_retired"));

    console.log(
      JSON.stringify(
        {
          ok: true,
          suite: "vera-deadline-rule-v1",
          checks: [
            "verified authority dependency",
            "immutable rule hash",
            "draft rule calculation rejection",
            "mandatory counsel verification",
            "missing and draft business-day calendar fail closed",
            "verified immutable court calendar version",
            "weekend/closure business-day calculation trace",
            "calendar retirement invalidates rule deadline task and calendar export",
            "calendar retirement withdraws notification",
            "calendar create and audit commit atomically",
            "calendar source retirement cascades to rule deadline and task",
            "confirmed matching event requirement",
            "Asia/Shanghai calendar-day trace",
            "proposed deadline with rule provenance",
            "post-verification rule tamper fails closed at calculation",
            "rule retirement invalidates deadline and task",
            "invalidated task calendar exclusion",
            "invalidated notification withdrawal",
            "matter/user isolation",
            "matter audit events",
          ],
        },
        null,
        2,
      ),
    );
  } finally {
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    }
    rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
