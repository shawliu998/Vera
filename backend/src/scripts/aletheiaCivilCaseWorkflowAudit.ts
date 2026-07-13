import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";
import ExcelJS from "exceljs";

type Row = Record<string, any>;

function row(value: unknown) {
  assert(value && typeof value === "object");
  return value as Row;
}

function elapsed(startedAt: number) {
  return Date.now() - startedAt;
}

async function closeServer(server: http.Server) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function xlsxFixture() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("付款明细");
  sheet.addRow(["日期", "项目", "金额", "凭证号"]);
  sheet.addRow(["2026-06-03", "首期货款", 480000, "PAY-001"]);
  sheet.addRow(["2026-07-01", "争议尾款", 320000, "PAY-002"]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function main() {
  assert.equal(process.platform, "darwin", "P4 workflow audit requires macOS OCR");
  const root = mkdtempSync(path.join(os.tmpdir(), "vera-civil-case-p4-"));
  const scannedPdf = path.join(root, "扫描付款记录.pdf");
  const brokenOcr = path.join(root, "broken-ocr");
  const realOcr = path.resolve(
    process.cwd(),
    "../desktop/.runtime/native/aletheia-ocr",
  );
  const fixtureScript = path.resolve(
    process.cwd(),
    "../desktop/native/civil-case-ocr-fixture.swift",
  );
  assert(existsSync(realOcr), "Build the desktop native OCR helper first");
  execFileSync("/usr/bin/xcrun", ["swift", fixtureScript, scannedPdf]);
  writeFileSync(
    brokenOcr,
    "#!/bin/sh\nprintf '{\"schemaVersion\":\"wrong\",\"pages\":[]}'\n",
  );
  chmodSync(brokenOcr, 0o700);

  process.env.ALETHEIA_AUTH_MODE = "single_user";
  process.env.ALETHEIA_LOCAL_USER_ID = "p4-counsel";
  process.env.ALETHEIA_LOCAL_USER_EMAIL = "p4-counsel@vera.invalid";
  process.env.ALETHEIA_DATA_DIR = root;
  process.env.ALETHEIA_STORAGE_DRIVER = "local";
  process.env.ALETHEIA_APPLICATION_ENCRYPTION = "required";
  process.env.ALETHEIA_MASTER_KEY_SOURCE = "env";
  process.env.ALETHEIA_MASTER_KEY_BASE64 = Buffer.alloc(32, 94).toString("base64");
  process.env.ALETHEIA_DATABASE_ENCRYPTION = "metadata_plaintext";
  process.env.ALETHEIA_OCR_ENABLED = "true";
  process.env.ALETHEIA_OCR_BINARY = brokenOcr;

  const phases: Array<{ phase: string; durationMs: number; outcome: string }> = [];
  const handoffs: string[] = [];
  let server: http.Server | null = null;
  try {
    const [{ createAletheiaRepository }, { aletheiaRouter }, { closeLocalAletheiaRepositoryForAudit }] =
      await Promise.all([
        import("../lib/aletheia"),
        import("../routes/aletheia"),
        import("../lib/aletheia/localRepository"),
      ]);
    const ctx = {
      userId: "p4-counsel",
      userEmail: "p4-counsel@vera.invalid",
    };
    let repository = createAletheiaRepository();

    let started = Date.now();
    const matter = row(
      await repository.createMatter(ctx, {
        title: "华辰公司诉明远公司买卖合同纠纷（脱敏结构化夹具）",
        objective: "核对交付、付款与程序期限，形成可复核的庭前工作底稿。",
        template: "civil_litigation",
        status: "in_progress",
        riskLevel: "high",
        clientOrProject: "明远公司",
        sourceProjectId: null,
        sharedWith: [],
        metadata: {
          fixtureClassification: "synthetic_anonymized_structure",
          representedSide: "defendant",
          opposingParty: "华辰公司",
          court: "某市中级人民法院",
          caseNumber: "（2026）某01民初100号",
          procedureStage: "first_instance",
        },
      }),
    );
    phases.push({ phase: "案件接收", durationMs: elapsed(started), outcome: "persisted" });

    started = Date.now();
    const notice = Buffer.from(
      [
        "某市中级人民法院送达记录（脱敏夹具）",
        "首次记录：应诉材料于2026年6月26日送达。",
        "更正记录：法院回证确认应诉材料于2026年6月28日送达。",
        "举证期限依经律师核验的规则另行计算。",
      ].join("\n"),
      "utf8",
    );
    const xlsx = await xlsxFixture();
    const pdf = await import("node:fs").then(({ readFileSync }) =>
      readFileSync(scannedPdf),
    );
    const app = express();
    app.use("/aletheia", aletheiaRouter);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server?.once("listening", resolve));
    const address = server.address();
    assert(address && typeof address === "object");
    const form = new FormData();
    form.append("files", new Blob([new Uint8Array(notice)], { type: "text/plain" }), "service-record.txt");
    form.append(
      "files",
      new Blob([new Uint8Array(xlsx)], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
      "payment-ledger.xlsx",
    );
    form.append("files", new Blob([new Uint8Array(pdf)], { type: "application/pdf" }), "scanned-payment-record.pdf");
    const batchResponse = await fetch(
      `http://127.0.0.1:${address.port}/aletheia/matters/${matter.id}/documents/batch`,
      { method: "POST", body: form },
    );
    assert.equal(batchResponse.status, 201);
    const batch = row(await batchResponse.json());
    assert.equal(batch.total, 3);
    const failedScan = row(
      batch.documents.find((item: Row) => item.name === "scanned-payment-record.pdf"),
    );
    assert.equal(failedScan.parsed_status, "failed");
    assert.equal(failedScan.metadata.extractionFailureCode, "ocr_runtime_failed");
    phases.push({
      phase: "批量导入",
      durationMs: elapsed(started),
      outcome: "2 parsed, scanned PDF failed closed",
    });
    handoffs.push("扫描 PDF 的 OCR helper 返回无效 schema，需人工修复 runtime 后重试。");

    started = Date.now();
    process.env.ALETHEIA_OCR_BINARY = realOcr;
    const retried = row(
      await repository.retryMatterDocumentParse(ctx, matter.id, failedScan.id),
    );
    assert.equal(retried.parsed_status, "parsed");
    assert.equal(retried.metadata.parserMetadata.parser, "pdf+apple-vision");
    assert.equal(retried.metadata.parseAttemptCount, 1);
    phases.push({ phase: "OCR 恢复", durationMs: elapsed(started), outcome: "real Apple Vision retry persisted" });

    started = Date.now();
    const sourceIndex = row(
      await repository.listV1SourceIndex(ctx, matter.id, {
        includeChunks: true,
        includeEvidenceLinks: true,
        chunkLimit: 100,
      }),
    );
    const chunks = sourceIndex.chunks as Row[];
    const scanChunk = row(chunks.find((item) => String(item.text).includes("2026-09-01")));
    const pdfTableChunk = row(
      chunks.find(
        (item) =>
          item.document_id === failedScan.id &&
          String(item.text).includes("PAYTWO"),
      ),
    );
    const noticeChunk = row(chunks.find((item) => String(item.text).includes("2026年6月28日")));
    const sheetChunk = row(chunks.find((item) => String(item.text).includes("PAY-002")));
    assert.equal(scanChunk.metadata.ocrProvenance.engine, "apple-vision");
    assert.equal(pdfTableChunk.metadata.ocrProvenance.engine, "apple-vision");
    const scannedPages = chunks
      .filter((item) => item.document_id === failedScan.id)
      .map((item) => Number(item.page))
      .sort();
    assert.deepEqual(scannedPages, [1, 2, 3]);
    assert.equal(sourceIndex.documents.length, 3);

    const manifest = row(
      await repository.createLitigationRetrievalManifest(ctx, matter.id, {
        focus: "PAYMENT",
      }),
    );
    const dueCandidate = row(
      manifest.candidates.find((item: Row) => item.chunkId === scanChunk.id),
    );
    const tableCandidate = row(
      manifest.candidates.find((item: Row) => item.chunkId === pdfTableChunk.id),
    );
    const dueExcerpt = row(
      await repository.confirmLitigationRetrievalExcerpt(
        ctx,
        matter.id,
        manifest.id,
        {
          chunkId: dueCandidate.chunkId,
          comment: "律师核对多页扫描件，并确认第一页付款到期日摘录。",
        },
      ),
    );
    const tableExcerpt = row(
      await repository.confirmLitigationRetrievalExcerpt(
        ctx,
        matter.id,
        manifest.id,
        {
          chunkId: tableCandidate.chunkId,
          comment: "律师核对多页扫描件，并确认第二页表格中的争议尾款记录。",
        },
      ),
    );
    const boundInput = row(
      await repository.prepareLitigationReviewedExcerptInput(
        ctx,
        matter.id,
        manifest.id,
      ),
    );
    assert.equal(boundInput.excerpts.length, 2);
    assert.deepEqual(
      boundInput.excerpts.map((item: Row) => item.page).sort(),
      [1, 2],
    );
    assert.match(boundInput.bindingHash, /^sha256:[a-f0-9]{64}$/);
    await repository.withdrawLitigationRetrievalExcerpt(
      ctx,
      matter.id,
      dueExcerpt.id,
      { comment: "律师撤回该摘录，以验证撤回后不得继续绑定 Agent 输入。" },
    );
    await repository.withdrawLitigationRetrievalExcerpt(
      ctx,
      matter.id,
      tableExcerpt.id,
      { comment: "律师撤回第二页表格摘录，以验证全部撤回后的失败关闭。" },
    );
    await assert.rejects(
      () =>
        repository.prepareLitigationReviewedExcerptInput(
          ctx,
          matter.id,
          manifest.id,
        ),
      /confirmed retrieval excerpt/i,
    );
    const replacementManifest = row(
      await repository.createLitigationRetrievalManifest(ctx, matter.id, {
        focus: "PAYMENT",
      }),
    );
    for (const [chunkId, comment] of [
      [scanChunk.id, "律师重新确认第一页付款到期日摘录。"],
      [pdfTableChunk.id, "律师重新确认第二页争议尾款表格摘录。"],
    ] as const) {
      assert(
        replacementManifest.candidates.some(
          (item: Row) => item.chunkId === chunkId,
        ),
      );
      await repository.confirmLitigationRetrievalExcerpt(
        ctx,
        matter.id,
        replacementManifest.id,
        { chunkId, comment },
      );
    }
    const reboundInput = row(
      await repository.prepareLitigationReviewedExcerptInput(
        ctx,
        matter.id,
        replacementManifest.id,
      ),
    );
    assert.equal(reboundInput.excerpts.length, 2);
    phases.push({
      phase: "律师确认摘录",
      durationMs: elapsed(started),
      outcome: "two-page binding, full withdrawal fail-closed, then re-confirmed",
    });
    started = Date.now();
    const scanQuote = "2026-09-01";
    const scanStart = String(scanChunk.text).indexOf(scanQuote);
    const fact = row(
      await repository.createLitigationFact(ctx, matter.id, {
        statement: "扫描付款记录载明付款到期日为2026年9月1日。",
        occurredAt: "2026-09-01T00:00:00+08:00",
        datePrecision: "day",
        sourceRelation: "supports",
        helpfulness: "helpful",
        confidence: "medium",
        createdBy: "human",
        source: {
          sourceChunkId: scanChunk.id,
          quoteStart: scanStart,
          quoteEnd: scanStart + scanQuote.length,
        },
      }),
    );
    try {
      await repository.decideLitigationFact(ctx, matter.id, fact.id, {
        decision: "confirmed",
        comment: "律师已核对扫描件中的日期字段。",
      });
    } catch (error) {
      assert.match(String(error), /original scan/i);
      const workspace = row(await repository.getLitigationWorkspace(ctx, matter.id));
      const source = row(workspace.fact_sources.find((item: Row) => item.fact_id === fact.id));
      await repository.verifyLitigationSourceSpanOriginal(
        ctx,
        matter.id,
        source.source_span_id,
        "律师逐字核对扫描件中的付款到期日和对应字段。",
      );
      await repository.decideLitigationFact(ctx, matter.id, fact.id, {
        decision: "confirmed",
        comment: "完成原始扫描件比对后确认。",
      });
      handoffs.push("低置信度 OCR 摘录需律师逐字比对原始扫描件后确认。");
    }
    const paymentQuote = "PAY-002";
    const paymentStart = String(sheetChunk.text).indexOf(paymentQuote);
    const position = row(
      await repository.createLitigationClaim(ctx, matter.id, {
        kind: "defense",
        title: "争议尾款的到期与履行情况需要结合付款凭证审查",
        legalBasis: "《中华人民共和国民法典》第五百零九条",
        confidence: "medium",
        uncertainty: "尚需核对原合同加速到期条款。",
        sourceRelation: "supports",
        createdBy: "human",
        source: {
          sourceChunkId: sheetChunk.id,
          quoteStart: paymentStart,
          quoteEnd: paymentStart + paymentQuote.length,
        },
      }),
    );
    const authorityQuote = "当事人应当按照约定全面履行自己的义务。";
    const authority = row(
      await repository.createLitigationLegalAuthorityVersion(ctx, matter.id, {
        authorityType: "statute",
        title: "中华人民共和国民法典",
        issuer: "全国人民代表大会",
        officialIdentifier: "PRC-CIVIL-CODE-509",
        versionLabel: "现行核验副本",
        sourceReference: "律师核验的官方公布文本",
        content: `第五百零九条 ${authorityQuote}当事人应当遵循诚信原则，根据合同的性质、目的和交易习惯履行通知、协助、保密等义务。`,
        effectiveFrom: "2021-01-01",
        effectiveTo: null,
      }),
    );
    await repository.verifyLitigationLegalAuthorityVersion(ctx, matter.id, authority.id, {
      comment: "律师已核对条文、施行日期与官方公布文本。",
    });
    await repository.linkLitigationPositionAuthority(ctx, matter.id, {
      claimId: position.id,
      authorityVersionId: authority.id,
      applicabilityDate: "2026-06-28",
      provisionReference: "第五百零九条",
      exactQuote: authorityQuote,
      rationale: "用于审查合同约定履行期限及尾款履行抗辩。",
    });
    await repository.decideLitigationClaim(ctx, matter.id, position.id, {
      decision: "confirmed",
      comment: "律师确认该抗辩进入庭前分析，保留加速到期不确定性。",
    });
    phases.push({ phase: "事实与请求权抗辩", durationMs: elapsed(started), outcome: "source-bound and counsel-confirmed" });

    started = Date.now();
    const firstQuote = "2026年6月26日";
    const correctedQuote = "2026年6月28日";
    const firstStart = String(noticeChunk.text).indexOf(firstQuote);
    const correctedStart = String(noticeChunk.text).indexOf(correctedQuote);
    const event = row(
      await repository.createLitigationProceduralEvent(ctx, matter.id, {
        eventType: "service_completed",
        title: "应诉材料送达",
        occurredAt: "2026-06-26T10:00:00+08:00",
        createdBy: "human",
        source: {
          sourceChunkId: noticeChunk.id,
          quoteStart: firstStart,
          quoteEnd: firstStart + firstQuote.length,
        },
      }),
    );
    await repository.decideLitigationProceduralEvent(ctx, matter.id, event.id, {
      decision: "confirmed",
      comment: "律师按首次送达记录确认。",
    });
    const deadline = row(
      await repository.createLitigationDeadline(ctx, matter.id, {
        title: "提交答辩及证据材料",
        dueAt: "2026-07-11T18:00:00+08:00",
        triggeringEventId: event.id,
        ruleLabel: "经律师核验的十五日期限规则",
        ruleVersion: "p4-fixture-v1",
        calculation: "从首次记录次日起计算十五个自然日。",
        createdBy: "human",
      }),
    );
    await repository.decideLitigationDeadline(ctx, matter.id, deadline.id, {
      decision: "confirmed",
      comment: "律师核对起算点和计算结果。",
    });
    const task = row(
      await repository.createTaskFromLitigationDeadline(ctx, matter.id, deadline.id, {
        priority: "high",
        note: "准备答辩和证据目录。",
      }),
    ).task;
    const correction = row(
      await repository.correctLitigationProceduralEvent(ctx, matter.id, event.id, {
        title: "应诉材料送达（按法院回证更正）",
        occurredAt: "2026-06-28T10:00:00+08:00",
        reason: "法院回证显示实际送达日晚于首次录入日期。",
        source: {
          sourceChunkId: noticeChunk.id,
          quoteStart: correctedStart,
          quoteEnd: correctedStart + correctedQuote.length,
        },
      }),
    );
    assert.equal(correction.invalidatedDeadlines, 1);
    assert.equal(correction.invalidatedTasks, 1);
    const invalidatedTask = row(
      (await repository.listTasks(ctx, "all")).find((item: Row) => item.id === task.id),
    );
    assert(invalidatedTask.invalidated_at);
    phases.push({ phase: "程序期限更正", durationMs: elapsed(started), outcome: "old deadline and task invalidated" });
    handoffs.push("送达日期发生更正后，旧期限和任务自动失效，需律师重新计算并确认。");

    started = Date.now();
    const brief = row(
      await repository.generateLitigationArtifact(ctx, matter.id, "litigation_brief"),
    );
    assert.deepEqual(brief.validation_errors, []);
    const draft = row(
      await repository.createLitigationDocumentDraft(ctx, matter.id, {
        artifactId: brief.id,
      }),
    );
    const v1 = row(draft.versions[0]);
    const sections = (v1.sections as Row[]).map((section) =>
      section.id === "issues"
        ? { ...section, body: `${section.body}\n律师补充：继续核对加速到期条款。` }
        : section,
    );
    const revised = row(
      await repository.appendLitigationDocumentDraftVersion(ctx, matter.id, draft.id, {
        baseVersion: 1,
        changeSummary: "律师补充争议焦点和待核事项。",
        sections,
      }),
    );
    const v2 = row(revised.versions.at(-1));
    const diff = row(
      await repository.diffLitigationDocumentDraftVersions(ctx, matter.id, draft.id, 1, 2),
    );
    assert(diff.changes.some((item: Row) => item.status === "modified"));
    await repository.reviewLitigationDocumentDraftVersion(
      ctx,
      matter.id,
      draft.id,
      v2.id,
      { decision: "approved", reason: "律师已完成当前版本的事实、争点和来源复核。" },
    );
    await repository.generateLitigationArtifact(ctx, matter.id, "hearing_bundle_index");
    phases.push({ phase: "文书与庭审准备", durationMs: elapsed(started), outcome: "draft v2 diffed and approved; bundle index persisted" });

    started = Date.now();
    const artifactBinding = {
      workProductId: String(brief.id),
      version: Number(brief.version),
      contentHash: String(brief.content_hash),
    };
    const checkpoint = row(
      await repository.requestApproval(ctx, matter.id, {
        action: "litigation_artifact_export",
        requestedPayload: artifactBinding,
      }),
    );
    await assert.rejects(
      () =>
        repository.exportLitigationArtifact(
          ctx,
          matter.id,
          brief.id,
          checkpoint.id,
          "docx",
        ),
      /approval/i,
    );
    await repository.decideApproval(ctx, matter.id, checkpoint.id, {
      decision: "approved",
      comment: "律师确认当前诉讼文书版本和来源可用于本地导出。",
    });
    const exported = row(
      await repository.exportLitigationArtifact(
        ctx,
        matter.id,
        brief.id,
        checkpoint.id,
        "docx",
      ),
    );
    const downloaded = await repository.downloadLitigationArtifact(
      ctx,
      matter.id,
      exported.exportId,
    );
    assert(downloaded);
    assert.equal(downloaded.bytes.subarray(0, 2).toString("ascii"), "PK");

    const changedQuote = "2026年6月28日";
    const changedStart = String(noticeChunk.text).indexOf(changedQuote);
    const laterFact = row(
      await repository.createLitigationFact(ctx, matter.id, {
        statement: "法院回证确认应诉材料于2026年6月28日送达。",
        occurredAt: "2026-06-28T10:00:00+08:00",
        datePrecision: "day",
        sourceRelation: "supports",
        helpfulness: "neutral",
        confidence: "high",
        createdBy: "human",
        source: {
          sourceChunkId: noticeChunk.id,
          quoteStart: changedStart,
          quoteEnd: changedStart + changedQuote.length,
        },
      }),
    );
    await repository.decideLitigationFact(ctx, matter.id, laterFact.id, {
      decision: "confirmed",
      comment: "律师确认法院回证中的实际送达日期。",
    });
    await assert.rejects(
      () =>
        repository.exportLitigationArtifact(
          ctx,
          matter.id,
          brief.id,
          checkpoint.id,
          "docx",
        ),
      /stale|current|approval/i,
    );
    const replacementBrief = row(
      await repository.generateLitigationArtifact(
        ctx,
        matter.id,
        "litigation_brief",
      ),
    );
    const replacementCheckpoint = row(
      await repository.requestApproval(ctx, matter.id, {
        action: "litigation_artifact_export",
        requestedPayload: {
          workProductId: String(replacementBrief.id),
          version: Number(replacementBrief.version),
          contentHash: String(replacementBrief.content_hash),
        },
      }),
    );
    await repository.decideApproval(
      ctx,
      matter.id,
      replacementCheckpoint.id,
      {
        decision: "approved",
        comment: "律师复核案件状态变化后的新版本并批准本地导出。",
      },
    );
    const replacementExport = row(
      await repository.exportLitigationArtifact(
        ctx,
        matter.id,
        replacementBrief.id,
        replacementCheckpoint.id,
        "docx",
      ),
    );
    const replacementDownload = await repository.downloadLitigationArtifact(
      ctx,
      matter.id,
      replacementExport.exportId,
    );
    assert(replacementDownload);
    assert.equal(
      replacementDownload.bytes.subarray(0, 2).toString("ascii"),
      "PK",
    );
    phases.push({
      phase: "批准导出与恢复",
      durationMs: elapsed(started),
      outcome: "unapproved blocked; stale approval blocked; new approved DOCX downloaded",
    });

    started = Date.now();
    await closeServer(server);
    server = null;
    closeLocalAletheiaRepositoryForAudit();
    repository = createAletheiaRepository();
    const restored = row(await repository.getLitigationWorkspace(ctx, matter.id));
    const restoredDraft = row(
      await repository.getLitigationDocumentDraft(ctx, matter.id, draft.id),
    );
    assert(restored.facts.some((item: Row) => item.id === fact.id && item.status === "confirmed"));
    assert(restored.claims.some((item: Row) => item.id === position.id && item.status === "confirmed"));
    assert.equal(restoredDraft.versions.at(-1).review_status, "approved");
    phases.push({ phase: "重启恢复", durationMs: elapsed(started), outcome: "matter state and approved draft reloaded" });

    const totalDurationMs = phases.reduce((sum, item) => sum + item.durationMs, 0);
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          suite: "vera-civil-case-workflow-p4-baseline-v1",
          fixture: {
            classification: "synthetic_anonymized_structure",
            realClientMaterial: false,
            matterId: matter.id,
          },
          phases,
          completion: { completed: 9, planned: 9, percent: 100 },
          totalDurationMs,
          manualHandoffs: handoffs,
          notCovered: [
            "real anonymized client PDFs",
            "trusted local model evaluation",
            "SQLCipher restart in the backend Node runtime",
          ],
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    if (server) await closeServer(server);
    try {
      const { closeLocalAletheiaRepositoryForAudit } = await import(
        "../lib/aletheia/localRepository"
      );
      closeLocalAletheiaRepositoryForAudit();
    } catch {}
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("[vera-civil-case-workflow] failed", error);
  process.exitCode = 1;
});
