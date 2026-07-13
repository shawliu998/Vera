import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalDatabase } from "../lib/aletheia/localDatabase";
import {
  closeLocalAletheiaRepositoryForAudit,
  LocalAletheiaRepository,
} from "../lib/aletheia/localRepository";

type Row = Record<string, any>;

function row(value: unknown) {
  assert(value && typeof value === "object");
  return value as Row;
}

async function main() {
  const root = mkdtempSync(path.join(os.tmpdir(), "vera-event-correction-"));
  process.env.ALETHEIA_DATA_DIR = root;
  process.env.ALETHEIA_STORAGE_DRIVER = "local";
  process.env.ALETHEIA_AUTH_MODE = "single_user";
  process.env.ALETHEIA_APPLICATION_ENCRYPTION = "disabled";
  process.env.ALETHEIA_DATABASE_ENCRYPTION = "metadata_plaintext";
  const repository = new LocalAletheiaRepository();
  const owner = { userId: "event-correction-owner" };
  const other = { userId: "event-correction-other" };
  try {
    const matter = row(
      await repository.createMatter(owner, {
        title: "Procedural event correction audit",
        objective: "Verify deadline invalidation after an event correction.",
        template: "civil_litigation",
        status: "in_progress",
        riskLevel: "high",
        clientOrProject: null,
        sourceProjectId: null,
        sharedWith: [],
        metadata: { audit: "event_correction" },
      }),
    );
    const evidence =
      "Original service record: service completed at 2026-06-26 10:00 CST. " +
      "Corrected court receipt: service completed at 2026-06-28 10:00 CST.";
    await repository.uploadMatterDocument(owner, matter.id, {
      filename: "service-record.txt",
      mimeType: "text/plain",
      sizeBytes: Buffer.byteLength(evidence),
      buffer: Buffer.from(evidence),
    });
    const index = row(
      await repository.listV1SourceIndex(owner, matter.id, {
        includeChunks: true,
        includeEvidenceLinks: true,
        chunkLimit: 20,
      }),
    );
    const chunk = row(index.chunks[0]);
    const originalQuote =
      "Original service record: service completed at 2026-06-26 10:00 CST.";
    const correctedQuote =
      "Corrected court receipt: service completed at 2026-06-28 10:00 CST.";
    const originalStart = String(chunk.text).indexOf(originalQuote);
    const correctedStart = String(chunk.text).indexOf(correctedQuote);
    assert(originalStart >= 0 && correctedStart >= 0);
    const original = row(
      await repository.createLitigationProceduralEvent(owner, matter.id, {
        eventType: "service_completed",
        title: "Service completed",
        occurredAt: "2026-06-26T02:00:00.000Z",
        source: {
          sourceChunkId: chunk.id,
          quoteStart: originalStart,
          quoteEnd: originalStart + originalQuote.length,
        },
        createdBy: "human",
        metadata: {},
      }),
    );
    await repository.decideLitigationProceduralEvent(
      owner,
      matter.id,
      original.id,
      {
        decision: "confirmed",
        comment: "Counsel confirmed the initial service record.",
      },
    );

    const ruleQuote =
      "A response must be filed within fifteen calendar days after service.";
    const authority = row(
      await repository.createLitigationLegalAuthorityVersion(owner, matter.id, {
        authorityType: "regulation",
        title: "Civil Procedure Filing Rule",
        issuer: "Verified rulemaking authority",
        officialIdentifier: "CORRECTION-CPFR-15",
        versionLabel: "2026 verified copy",
        sourceReference: "Named official publication copy",
        content: `${ruleQuote} Filing time is measured in Asia/Shanghai.`,
        effectiveFrom: "2026-01-01",
        effectiveTo: "2026-12-31",
      }),
    );
    await repository.verifyLitigationLegalAuthorityVersion(
      owner,
      matter.id,
      authority.id,
      {
        comment:
          "Counsel checked the source text and effective period against the named official copy.",
      },
    );
    const rule = row(
      await repository.createLitigationDeadlineRule(owner, matter.id, {
        name: "Correction audit response rule",
        triggerEventType: "service_completed",
        authorityVersionId: authority.id,
        provisionReference: "Response deadline",
        exactQuote: ruleQuote,
        offsetDays: 15,
        countingBasis: "calendar_days",
        startPolicy: "next_day",
      }),
    );
    await repository.verifyLitigationDeadlineRule(owner, matter.id, rule.id, {
      comment:
        "Counsel verified next-day calendar counting and the local day-end convention.",
    });
    const firstDeadline = row(
      await repository.calculateLitigationDeadlineFromRule(
        owner,
        matter.id,
        rule.id,
        { eventId: original.id, title: "Initial response deadline" },
      ),
    );
    assert.equal(firstDeadline.due_at, "2026-07-11T15:59:59.000Z");
    await repository.decideLitigationDeadline(
      owner,
      matter.id,
      firstDeadline.id,
      {
        decision: "confirmed",
        comment: "Counsel checked the initial calculation trace.",
      },
    );
    const firstTask = row(
      await repository.createTaskFromLitigationDeadline(
        owner,
        matter.id,
        firstDeadline.id,
        { priority: "high", note: "Initial event calculation." },
      ),
    ).task;
    await repository.claimTaskNotifications(owner);

    const correctionReason =
      "The court receipt shows service occurred two days later than the initial record.";
    const correction = row(
      await repository.correctLitigationProceduralEvent(
        owner,
        matter.id,
        original.id,
        {
          title: "Service completed (corrected court receipt)",
          occurredAt: "2026-06-28T02:00:00.000Z",
          reason: correctionReason,
          source: {
            sourceChunkId: chunk.id,
            quoteStart: correctedStart,
            quoteEnd: correctedStart + correctedQuote.length,
          },
        },
      ),
    );
    const replacement = row(correction.replacement);
    assert.equal(replacement.event_version, 2);
    assert.equal(replacement.supersedes_event_id, original.id);
    assert.match(replacement.event_lineage_hash, /^sha256:[a-f0-9]{64}$/);
    assert.match(correction.correctionHash, /^sha256:[a-f0-9]{64}$/);
    assert.equal(correction.invalidatedDeadlines, 1);
    assert.equal(correction.invalidatedTasks, 1);

    const workspace = row(
      await repository.getLitigationWorkspace(owner, matter.id),
    );
    const oldProjection = row(
      workspace.procedural_events.find((event: Row) => event.id === original.id),
    );
    assert.equal(oldProjection.superseded_by_event_id, replacement.id);
    assert.equal(oldProjection.correction_reason, correctionReason);
    assert.equal(workspace.procedural_event_corrections.length, 1);
    assert.match(
      workspace.deadlines.find((deadline: Row) => deadline.id === firstDeadline.id)
        .stale_reason,
      /Triggering event corrected/,
    );
    const invalidatedTask = (
      (await repository.listTasks(owner, "all")) as Row[]
    ).find((task) => task.id === firstTask.id);
    assert.match(invalidatedTask?.invalidated_reason, /Triggering event corrected/);
    assert.equal(
      (await repository.exportTaskCalendar(owner, "all")).some(
        (task) => task.id === firstTask.id,
      ),
      false,
    );
    const notifications = row(await repository.claimTaskNotifications(owner));
    assert.equal(
      notifications.withdrawals.some((item: Row) => item.taskId === firstTask.id),
      true,
    );
    await assert.rejects(
      () => repository.completeTask(owner, firstTask.id),
      /invalidated deadline task/i,
    );
    await assert.rejects(
      () =>
        repository.calculateLitigationDeadlineFromRule(
          owner,
          matter.id,
          rule.id,
          { eventId: original.id, title: "Old event must not calculate" },
        ),
      /confirmed triggering event/i,
    );
    const replacementDeadline = row(
      await repository.calculateLitigationDeadlineFromRule(
        owner,
        matter.id,
        rule.id,
        { eventId: replacement.id, title: "Corrected response deadline" },
      ),
    );
    assert.equal(replacementDeadline.due_at, "2026-07-13T15:59:59.000Z");
    assert.equal(replacementDeadline.stale_at, null);

    await assert.rejects(
      () =>
        repository.correctLitigationProceduralEvent(owner, matter.id, replacement.id, {
          title: replacement.title,
          occurredAt: replacement.occurred_at,
          reason: "A no-op correction must not create another event version.",
        }),
      /must change/i,
    );
    await assert.rejects(
      () =>
        repository.correctLitigationProceduralEvent(other, matter.id, replacement.id, {
          title: "Unauthorized correction",
          occurredAt: "2026-06-29T02:00:00.000Z",
          reason: "A different principal must not change this matter event.",
        }),
      /lacks matter\.write/i,
    );

    const db = new LocalDatabase(path.join(root, "aletheia.db"));
    assert.throws(() =>
      db
        .prepare(
          "update aletheia_litigation_procedural_event_corrections set reason = 'tampered' where id = ?",
        )
        .run(correction.correctionId),
    );
    db.exec(`create trigger force_event_correction_audit_failure
      before insert on aletheia_audit_events
      when new.action = 'litigation_procedural_event_corrected'
      begin select raise(abort, 'forced correction audit rollback'); end;`);
    db.close();
    await assert.rejects(
      () =>
        repository.correctLitigationProceduralEvent(owner, matter.id, replacement.id, {
          title: "Service completed (rollback probe)",
          occurredAt: "2026-06-29T02:00:00.000Z",
          reason:
            "This correction must roll back when its atomic audit event cannot be written.",
        }),
      /forced correction audit rollback/i,
    );
    const rollbackDb = new LocalDatabase(path.join(root, "aletheia.db"));
    rollbackDb.exec("drop trigger force_event_correction_audit_failure");
    assert.equal(
      rollbackDb
        .prepare(
          "select count(*) as n from aletheia_litigation_procedural_event_corrections",
        )
        .get().n,
      1,
    );
    assert.equal(
      rollbackDb
        .prepare(
          "select superseded_at from aletheia_litigation_procedural_events where id = ?",
        )
        .get(replacement.id).superseded_at,
      null,
    );
    assert.equal(
      rollbackDb
        .prepare(
          "select stale_at from aletheia_litigation_deadlines where id = ?",
        )
        .get(replacementDeadline.id).stale_at,
      null,
    );
    const auditCount = rollbackDb
      .prepare(
        "select count(*) as n from aletheia_audit_events where action = 'litigation_procedural_event_corrected'",
      )
      .get().n;
    assert.equal(auditCount, 1);
    rollbackDb.close();

    const detail = row(await repository.getMatterDetail(owner, matter.id));
    const audit = detail.auditEvents.find(
      (event: Row) => event.action === "litigation_procedural_event_corrected",
    );
    assert.equal(audit.details.originalEventId, original.id);
    assert.equal(audit.details.replacementEventId, replacement.id);
    assert.equal(audit.details.invalidatedDeadlines, 1);
    assert.equal(audit.details.invalidatedTasks, 1);

    const tamperDb = new LocalDatabase(path.join(root, "aletheia.db"));
    tamperDb
      .prepare(
        "update aletheia_source_spans set quote_sha256 = 'sha256:tampered' where id = ?",
      )
      .run(replacement.primary_source_span_id);
    tamperDb.close();
    await assert.rejects(
      () =>
        repository.correctLitigationProceduralEvent(owner, matter.id, replacement.id, {
          title: "Service completed (tampered source probe)",
          occurredAt: "2026-06-30T02:00:00.000Z",
          reason:
            "A correction must fail closed when its reused source span no longer verifies.",
        }),
      /source integrity verification failed/i,
    );
    const failClosedDb = new LocalDatabase(path.join(root, "aletheia.db"));
    assert.equal(
      failClosedDb
        .prepare(
          "select count(*) as n from aletheia_litigation_procedural_event_corrections",
        )
        .get().n,
      1,
    );
    assert.equal(
      failClosedDb
        .prepare(
          "select superseded_at from aletheia_litigation_procedural_events where id = ?",
        )
        .get(replacement.id).superseded_at,
      null,
    );
    failClosedDb.close();
    console.log(
      JSON.stringify(
        {
          ok: true,
          suite: "vera-procedural-event-correction-v1",
          checks: {
            immutableSupersession: true,
            sourceBoundCorrection: true,
            lineageAndCorrectionHashes: true,
            deadlineAndTaskInvalidation: true,
            notificationWithdrawal: true,
            calendarExclusion: true,
            oldEventCalculationBlocked: true,
            replacementRecalculation: true,
            noOpAndUserIsolation: true,
            immutableCorrectionRows: true,
            atomicAuditRollback: true,
            tamperedSourceFailsClosed: true,
          },
        },
        null,
        2,
      ),
    );
  } finally {
    closeLocalAletheiaRepositoryForAudit();
    rmSync(root, { recursive: true, force: true });
  }
}

void main();
