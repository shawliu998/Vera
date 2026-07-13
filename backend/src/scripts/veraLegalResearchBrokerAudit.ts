import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import type { LegalSourceAdapter } from "../lib/aletheia/legalSourceAdapter";

function hash(value: string) {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

async function request(
  baseUrl: string,
  pathname: string,
  options: { method?: string; body?: unknown } = {},
) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method ?? "GET",
    headers: options.body === undefined ? undefined : { "content-type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return {
    response,
    body: text ? (JSON.parse(text) as Record<string, any>) : {},
  };
}

async function main() {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "vera-legal-research-broker-"));
  process.env.ALETHEIA_AUTH_MODE = "single_user";
  process.env.ALETHEIA_DATA_DIR = dataDir;
  process.env.ALETHEIA_LOCAL_USER_ID = "research-auditor";
  process.env.ALETHEIA_LOCAL_USER_EMAIL = "research-auditor@vera.local";
  process.env.ALETHEIA_APPLICATION_ENCRYPTION = "disabled";
  process.env.ALETHEIA_DATABASE_ENCRYPTION = "metadata_plaintext";

  const outboundQueries: string[] = [];
  const fetchedDocumentIds: string[] = [];
  const sourceText = "民法典第五百六十三条：当事人一方迟延履行债务或者有其他违约行为致使不能实现合同目的的，当事人可以解除合同。";
  const adapter: LegalSourceAdapter = {
    provider: "pkulaw",
    async search({ query }) {
      outboundQueries.push(query);
      return [{
        documentId: "civil-code-563",
        title: "中华人民共和国民法典第五百六十三条",
        summary: "迟延履行致使不能实现合同目的时可以解除合同。",
        snapshot: {
          url: "https://api.pkulaw.example/law/civil-code-563",
          fetchedAt: "2026-07-12T12:00:00.000Z",
          contentHash: hash("candidate-civil-code-563"),
          sourceType: "pkulaw",
          version: "2021-01-01",
          effectiveDate: "2021-01-01",
        },
      }];
    },
    async fetch({ documentId }) {
      fetchedDocumentIds.push(documentId);
      assert.equal(documentId, "civil-code-563");
      return {
        documentId,
        title: "中华人民共和国民法典第五百六十三条",
        content: sourceText,
        snapshot: {
          url: "https://api.pkulaw.example/law/civil-code-563",
          fetchedAt: "2026-07-12T12:01:00.000Z",
          contentHash: hash(sourceText),
          sourceType: "pkulaw",
          version: "2021-01-01",
          effectiveDate: "2021-01-01",
        },
      };
    },
  };

  let server: http.Server | null = null;
  try {
    const [{ createAletheiaRepository }, { createLegalResearchRouter }, { createLegalResearchIssuesRouter }, { aletheiaRouter }] = await Promise.all([
      import("../lib/aletheia"),
      import("../routes/legalResearch"),
      import("../routes/legalResearchIssues"),
      import("../routes/aletheia"),
    ]);
    const repo = createAletheiaRepository();
    const ctx = { userId: "research-auditor", userEmail: "research-auditor@vera.local" };
    const matter = await repo.createMatter(ctx, {
      title: "受控联网法律研究审计",
      objective: "验证本地研究、外发审批和来源快照。",
      template: "civil_litigation",
      status: "in_progress",
      riskLevel: "high",
      clientOrProject: "本地审计",
      sourceProjectId: null,
      sharedWith: [],
      metadata: {},
    }) as Record<string, any>;
    assert.equal(
      await repo.getMatterDetail({ userId: "other-research-user" }, matter.id),
      null,
      "research records must remain matter-owner scoped",
    );
    await assert.rejects(
      () => repo.createWorkProduct(ctx, matter.id, {
        kind: "legal_qa_answer",
        title: "Direct accepted-answer bypass",
        status: "accepted",
        schemaVersion: "vera-legal-research-memo-v1",
        content: {},
        validationErrors: [],
        generatedBy: "human",
        model: null,
      }),
      /human-review approval workflow/,
    );

    const factSourceText =
      "The supplier did not deliver the equipment by the agreed deadline of 1 June 2026.";
    await repo.uploadMatterDocument(ctx, matter.id, {
      filename: "delivery-delay-record.txt",
      mimeType: "text/plain",
      sizeBytes: Buffer.byteLength(factSourceText, "utf8"),
      buffer: Buffer.from(factSourceText, "utf8"),
    });
    const sourceIndex = await repo.listV1SourceIndex(ctx, matter.id, {
      includeChunks: true,
      includeEvidenceLinks: false,
      chunkLimit: 10,
    }) as Record<string, any>;
    const factChunk = sourceIndex.chunks[0] as Record<string, any>;
    assert(factChunk?.id, "fixture upload must create a real local source chunk");
    const fact = await repo.createLitigationFact(ctx, matter.id, {
      statement: "The supplier did not deliver the equipment by 1 June 2026.",
      occurredAt: "2026-06-01T00:00:00.000Z",
      datePrecision: "day",
      sourceRelation: "supports",
      helpfulness: "helpful",
      confidence: "high",
      createdBy: "human",
      source: {
        sourceChunkId: factChunk.id,
        quoteStart: 0,
        quoteEnd: factSourceText.length,
      },
    }) as Record<string, any>;
    assert(fact?.id);
    await repo.decideLitigationFact(ctx, matter.id, fact.id, {
      decision: "confirmed",
      comment: "Counsel confirmed the local delivery-delay source.",
    });
    const unsupportedFact = await repo.createLitigationFact(ctx, matter.id, {
      statement: "This fact intentionally has no local source.",
      createdBy: "human",
    }) as Record<string, any>;
    await repo.decideLitigationFact(ctx, matter.id, unsupportedFact.id, {
      decision: "confirmed",
      comment: "Audit fixture confirmation.",
    });
    const rejectedFact = await repo.createLitigationFact(ctx, matter.id, {
      statement: "This fact is rejected and cannot enter research context.",
      createdBy: "human",
    }) as Record<string, any>;
    await repo.decideLitigationFact(ctx, matter.id, rejectedFact.id, {
      decision: "rejected",
      comment: "Audit fixture rejection.",
    });
    const proceduralEvent = await repo.createLitigationProceduralEvent(ctx, matter.id, {
      eventType: "demand_notice",
      title: "律师函送达并要求限期交货",
      occurredAt: "2026-06-15",
      createdBy: "human",
      source: {
        sourceChunkId: factChunk.id,
        quoteStart: 0,
        quoteEnd: factSourceText.length,
      },
    }) as Record<string, any>;
    await repo.decideLitigationProceduralEvent(ctx, matter.id, proceduralEvent.id, {
      decision: "confirmed",
      comment: "Counsel confirmed the local demand-notice source.",
    });
    const contextWorkspace = await repo.getLitigationWorkspace(ctx, matter.id) as Record<string, any>;
    const boundProceduralEvent = contextWorkspace.procedural_events.find(
      (event: Record<string, unknown>) => event.id === proceduralEvent.id,
    );
    assert(boundProceduralEvent, "confirmed procedural event must be visible in its local workspace");
    assert.equal(boundProceduralEvent.current_quote, factSourceText);
    assert.match(String(boundProceduralEvent.current_quote_sha256 ?? ""), /^[a-f0-9]{64}$/);
    for (const field of [
      "primary_source_span_id",
      "document_id",
      "document_name",
      "quote",
      "quote_sha256",
      "source_chunk_sha256",
      "current_quote",
      "current_quote_sha256",
      "current_source_chunk_sha256",
    ]) assert(boundProceduralEvent[field], `procedural event context field ${field} must be available`);
    assert.equal(boundProceduralEvent.quote, boundProceduralEvent.current_quote);
    assert.equal(boundProceduralEvent.quote_sha256, boundProceduralEvent.current_quote_sha256);
    assert.equal(
      boundProceduralEvent.source_chunk_sha256,
      boundProceduralEvent.current_source_chunk_sha256,
    );
    const freshRepositoryWorkspace = await createAletheiaRepository().getLitigationWorkspace(
      ctx,
      matter.id,
    ) as Record<string, any>;
    const freshRepositoryEvent = freshRepositoryWorkspace.procedural_events.find(
      (event: Record<string, unknown>) => event.id === proceduralEvent.id,
    );
    assert.equal(freshRepositoryEvent.current_quote, factSourceText);

    const app = express();
    app.use(express.json({ limit: "1mb" }));
    app.use("/aletheia", createLegalResearchRouter({
      createAdapter: (args) => {
        assert.equal(args.provider, "pkulaw");
        assert.equal(args.userId, ctx.userId);
        return adapter;
      },
    }));
    app.use("/aletheia", createLegalResearchIssuesRouter({ createRepository: () => repo }));
    app.use("/aletheia", aletheiaRouter);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server?.once("listening", resolve));
    const address = server.address();
    assert(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const root = `/aletheia/matters/${matter.id}/research`;

    const bypass = await request(baseUrl, `/aletheia/matters/${matter.id}/work-products`, {
      method: "POST",
      body: {
        kind: "legal_qa_answer",
        title: "Bypass attempt",
        status: "needs_review",
        schemaVersion: "vera-legal-research-memo-v1",
        generatedBy: "human",
        content: {},
      },
    });
    assert.equal(bypass.response.status, 403);
    assert.equal(bypass.body.code, "research_broker_required");

    const invalidNoSource = await request(baseUrl, `${root}/requests`, {
      method: "POST",
      body: {
        title: "Invalid no-source context",
        factIds: [unsupportedFact.id],
        jurisdiction: "中国大陆",
        asOfDate: "2026-07-12",
        question: "This must fail closed.",
      },
    });
    assert.equal(invalidNoSource.response.status, 409);
    assert.equal(invalidNoSource.body.code, "case_context_required");
    const invalidRejected = await request(baseUrl, `${root}/requests`, {
      method: "POST",
      body: {
        title: "Invalid rejected context",
        factIds: [rejectedFact.id],
        jurisdiction: "中国大陆",
        asOfDate: "2026-07-12",
        question: "This must fail closed.",
      },
    });
    assert.equal(invalidRejected.response.status, 409);
    assert.equal(invalidRejected.body.code, "case_context_required");

    const created = await request(baseUrl, `${root}/requests`, {
      method: "POST",
      body: {
        title: "迟延交货解除条件研究",
        factIds: [fact.id],
        proceduralEventIds: [proceduralEvent.id],
        facts: "UNTRUSTED CLIENT FACTS MUST NEVER BE PERSISTED",
        jurisdiction: "中国大陆",
        asOfDate: "2026-07-12",
        question: "长期迟延交货是否构成解除合同的条件？",
      },
    });
    assert.equal(created.response.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.schema_version, "vera-legal-research-request-v2");
    assert.equal(created.body.content.request.facts.includes("UNTRUSTED CLIENT FACTS"), false);
    assert.match(created.body.content.request.facts, /supplier did not deliver/i);
    assert.match(created.body.content.caseContextHash, /^sha256:[a-f0-9]{64}$/);
    assert.match(created.body.content.caseContextContentHash, /^sha256:[a-f0-9]{64}$/);
    const requestDetail = await repo.getMatterDetail(ctx, matter.id) as Record<string, any>;
    const caseContext = requestDetail.workProducts.find((product: Record<string, any>) =>
      product.id === created.body.content.caseContextId,
    );
    assert.equal(caseContext.kind, "legal_research_case_context");
    assert.equal(caseContext.status, "accepted");
    assert.equal(caseContext.content.contextHash, created.body.content.caseContextHash);
    assert.equal(caseContext.content.items.facts[0].id, fact.id);
    assert.equal(caseContext.content.items.facts[0].evidence.length, 1);
    assert.equal(caseContext.content.items.proceduralEvents[0].id, proceduralEvent.id);
    assert.equal(caseContext.content.items.proceduralEvents[0].source.quote, factSourceText);
    const caseContextAudit = requestDetail.auditEvents.find((event: Record<string, any>) =>
      event.action === "legal_research_case_context_bound",
    );
    assert(caseContextAudit, "v2 context binding requires a dedicated audit event");
    assert.deepEqual(Object.keys(caseContextAudit.details).sort(), [
      "caseContextContentHash",
      "caseContextHash",
      "caseContextId",
      "factCount",
      "factIds",
      "proceduralEventCount",
      "proceduralEventIds",
    ]);
    assert.equal(caseContextAudit.details.proceduralEventCount, 1);
    assert.equal(JSON.stringify(caseContextAudit.details).includes(fact.statement), false);
    assert.equal(JSON.stringify(caseContextAudit.details).includes(factSourceText), false);
    const requestId = created.body.id as string;

    const missingIssueTree = await request(baseUrl, `${root}/requests/${requestId}/query-preview`, {
      method: "POST",
      body: {
        provider: "pkulaw",
        query: "迟延交货 解除合同 条件",
      },
    });
    assert.equal(missingIssueTree.response.status, 409);
    assert.equal(missingIssueTree.body.code, "issue_tree_required");

    const issueTree = await request(baseUrl, `${root}/requests/${requestId}/issues`, {
      method: "POST",
      body: {
        nodes: [{
          id: "root",
          parentId: null,
          title: "迟延交货是否达到法定解除合同的条件",
          description: "需要研究合同目的、催告与替代履行。",
          status: "open",
          order: 0,
        }],
      },
    });
    assert.equal(issueTree.response.status, 201);
    const issueTreeId = issueTree.body.id as string;
    assert.match(issueTree.body.content.tree.treeHash, /^sha256:[a-f0-9]{64}$/);
    const loadedIssueTree = await request(baseUrl, `${root}/requests/${requestId}/issues`);
    assert.equal(loadedIssueTree.response.status, 200);
    assert.equal(loadedIssueTree.body.id, issueTreeId);

    const manualSource = {
      documentId: "manual-civil-code-563",
      title: "中华人民共和国民法典第五百六十三条（律师本地导入）",
      content: sourceText,
      documentKind: "statute",
      version: "2021-01-01",
      effectiveDate: "2021-01-01",
      publicationDate: "2020-05-28",
    };
    const manualSourcesPath = `${root}/requests/${requestId}/manual-sources`;
    const missingManualEffectiveDate = await request(baseUrl, manualSourcesPath, {
      method: "POST",
      body: { ...manualSource, effectiveDate: undefined },
    });
    assert.equal(missingManualEffectiveDate.response.status, 400);
    assert.equal(missingManualEffectiveDate.body.code, "invalid_input");
    const invalidManualDate = await request(baseUrl, manualSourcesPath, {
      method: "POST",
      body: { ...manualSource, effectiveDate: "2021-02-29" },
    });
    assert.equal(invalidManualDate.response.status, 400);
    assert.equal(invalidManualDate.body.code, "invalid_input");
    const invalidManualDateRange = await request(baseUrl, manualSourcesPath, {
      method: "POST",
      body: { ...manualSource, effectiveTo: "2020-12-31" },
    });
    assert.equal(invalidManualDateRange.response.status, 400);
    assert.equal(invalidManualDateRange.body.code, "invalid_input");
    const forgedManualBinding = await request(baseUrl, manualSourcesPath, {
      method: "POST",
      body: { ...manualSource, queryPlanId: "forged-query-plan" },
    });
    assert.equal(forgedManualBinding.response.status, 400);
    assert.equal(forgedManualBinding.body.code, "invalid_input");
    const rejectedManualCase = await request(baseUrl, manualSourcesPath, {
      method: "POST",
      body: { ...manualSource, documentKind: "case" },
    });
    assert.equal(rejectedManualCase.response.status, 400);
    assert.equal(rejectedManualCase.body.code, "invalid_input");

    const crossRequest = await request(baseUrl, `${root}/requests`, {
      method: "POST",
      body: {
        title: "交叉请求隔离审计",
        factIds: [fact.id],
        proceduralEventIds: [proceduralEvent.id],
        jurisdiction: "中国大陆",
        asOfDate: "2026-07-12",
        question: "同一案卷中的另一法律研究请求不得复用来源。",
      },
    });
    assert.equal(crossRequest.response.status, 201);
    const crossRequestId = crossRequest.body.id as string;
    const otherMatter = await repo.createMatter(ctx, {
      title: "手工导入跨 Matter 审计",
      objective: "验证手工法律资料不能跨 Matter 写入。",
      template: "civil_litigation",
      status: "in_progress",
      riskLevel: "high",
      clientOrProject: "本地审计",
      sourceProjectId: null,
      sharedWith: [],
      metadata: {},
    }) as Record<string, any>;
    const crossMatterManualSource = await request(
      baseUrl,
      `/aletheia/matters/${otherMatter.id}/research/requests/${requestId}/manual-sources`,
      { method: "POST", body: manualSource },
    );
    assert.equal(crossMatterManualSource.response.status, 404);
    assert.equal(crossMatterManualSource.body.code, "not_found");

    const manualSnapshot = await request(baseUrl, manualSourcesPath, {
      method: "POST",
      body: manualSource,
    });
    assert.equal(manualSnapshot.response.status, 201, JSON.stringify(manualSnapshot.body));
    assert.equal(outboundQueries.length, 0, "manual imports must not dispatch a search");
    assert.equal(fetchedDocumentIds.length, 0, "manual imports must not fetch an external source");
    const manualSnapshotId = manualSnapshot.body.id as string;
    assert.equal(manualSnapshot.body.content.sourceIdentity, "manual_import:manual-civil-code-563");
    assert.equal(manualSnapshot.body.content.documentId, manualSource.documentId);
    assert.equal(manualSnapshot.body.content.queryPlanId, undefined);
    assert.equal(manualSnapshot.body.content.searchResultId, undefined);
    assert.equal(manualSnapshot.body.content.issueTreeId, issueTreeId);
    assert.equal(manualSnapshot.body.content.issueTreeHash, issueTree.body.content.tree.treeHash);
    assert.equal(manualSnapshot.body.content.caseContextId, created.body.content.caseContextId);
    assert.equal(manualSnapshot.body.content.caseContextHash, created.body.content.caseContextHash);
    assert.equal(manualSnapshot.body.content.caseContextContentHash, created.body.content.caseContextContentHash);
    assert.equal(manualSnapshot.body.content.snapshot.url, "manual://local/manual-civil-code-563");
    assert.match(manualSnapshot.body.content.snapshot.fetchedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(manualSnapshot.body.content.snapshot.contentHash, hash(sourceText));
    assert.equal(manualSnapshot.body.content.snapshot.sourceType, "manual_import");
    assert.equal(manualSnapshot.body.content.snapshot.documentKind, "statute");
    assert.equal(manualSnapshot.body.content.snapshot.caseVerificationStatus, "unverified");
    assert.equal(manualSnapshot.body.content.verificationStatus, "captured_unverified");

    const hashMismatchSnapshot = await repo.createWorkProduct(ctx, matter.id, {
      kind: "external_source_workpaper",
      title: "仅用于哈希完整性审计的来源",
      status: "generated",
      schemaVersion: "vera-legal-source-snapshot-v1",
      content: {
        schemaVersion: "vera-legal-source-snapshot-v1",
        requestId,
        issueTreeId,
        issueTreeHash: issueTree.body.content.tree.treeHash,
        caseContextId: created.body.content.caseContextId,
        caseContextHash: created.body.content.caseContextHash,
        caseContextContentHash: created.body.content.caseContextContentHash,
        sourceIdentity: "manual_import:hash-mismatch-audit",
        snapshot: {
          url: "manual://local/hash-mismatch-audit",
          fetchedAt: "2026-07-12T12:00:00.000Z",
          contentHash: hash("different content"),
          sourceType: "manual_import",
          documentKind: "other",
          caseVerificationStatus: "unverified",
        },
        content: "stored content",
        verificationStatus: "captured_unverified",
      },
      validationErrors: [],
      generatedBy: "system",
      model: null,
    }) as Record<string, any>;
    const hashMismatchExcerpt = await request(baseUrl, `${root}/snapshots/${hashMismatchSnapshot.id}/excerpts`, {
      method: "POST",
      body: { quote: "stored content", comment: "哈希不一致的来源不能确认摘录。" },
    });
    assert.equal(hashMismatchExcerpt.response.status, 409);
    assert.equal(hashMismatchExcerpt.body.code, "invalid_state");

    const manualDetail = await repo.getMatterDetail(ctx, matter.id) as Record<string, any>;
    const manualAudit = manualDetail.auditEvents.find((event: Record<string, any>) =>
      event.action === "legal_research_manual_source_snapshot_saved",
    );
    assert(manualAudit, "manual imports require a safety-metadata audit event");
    assert.deepEqual(Object.keys(manualAudit.details).sort(), [
      "caseContextContentHash",
      "caseContextHash",
      "caseContextId",
      "contentHash",
      "documentIdHash",
      "documentKind",
      "effectiveDate",
      "effectiveTo",
      "issueTreeHash",
      "issueTreeId",
      "publicationDate",
      "requestId",
      "sourceSnapshotId",
      "verificationStatus",
    ]);
    const manualAuditJson = JSON.stringify(manualAudit.details);
    assert.equal(manualAuditJson.includes(manualSource.content), false);
    assert.equal(manualAuditJson.includes(manualSource.title), false);
    assert.equal(manualAuditJson.includes(manualSource.documentId), false);
    assert.equal(manualAuditJson.includes("manual://local/"), false);

    const snapshotBypassesExcerpt = await request(baseUrl, `${root}/requests/${requestId}/input-manifests`, {
      method: "POST",
      body: { excerptIds: [manualSnapshotId] },
    });
    assert.equal(snapshotBypassesExcerpt.response.status, 404);
    const nonExactManualExcerpt = await request(baseUrl, `${root}/snapshots/${manualSnapshotId}/excerpts`, {
      method: "POST",
      body: {
        quote: "不存在于手工导入内容中的摘录。",
        comment: "这必须被拒绝。",
      },
    });
    assert.equal(nonExactManualExcerpt.response.status, 409);
    assert.equal(nonExactManualExcerpt.body.code, "quote_mismatch");
    const manualExcerptQuote = "当事人一方迟延履行债务或者有其他违约行为致使不能实现合同目的的，当事人可以解除合同。";
    const manualExcerpt = await request(baseUrl, `${root}/snapshots/${manualSnapshotId}/excerpts`, {
      method: "POST",
      body: {
        quote: manualExcerptQuote,
        comment: "律师逐字确认本地导入的条文原文。",
      },
    });
    assert.equal(manualExcerpt.response.status, 201);
    const manualExcerptId = manualExcerpt.body.id as string;
    const crossRequestManifest = await request(
      baseUrl,
      `${root}/requests/${crossRequestId}/input-manifests`,
      { method: "POST", body: { excerptIds: [manualExcerptId] } },
    );
    assert.equal(crossRequestManifest.response.status, 409);
    assert.equal(crossRequestManifest.body.code, "invalid_binding");
    const manualManifest = await request(baseUrl, `${root}/requests/${requestId}/input-manifests`, {
      method: "POST",
      body: { excerptIds: [manualExcerptId] },
    });
    assert.equal(manualManifest.response.status, 201);
    const manualManifestId = manualManifest.body.id as string;
    const manualMemo = await request(baseUrl, `${root}/input-manifests/${manualManifestId}/memos`, {
      method: "POST",
      body: {
        findings: [{
          conclusion: "手工导入的法规摘录可用于待律师复核的法律研究结论。",
          confidence: "medium",
          uncertainty: "手工导入资料未经自动外部核验。",
          position: "neutral",
          citations: [{ excerptId: manualExcerptId, sourceType: "statute" }],
        }],
      },
    });
    assert.equal(manualMemo.response.status, 201);
    const manualMemoId = manualMemo.body.id as string;
    const manualMemoDetail = await repo.getMatterDetail(ctx, matter.id) as Record<string, any>;
    const manualMemoReview = manualMemoDetail.reviews.find((review: Record<string, unknown>) =>
      review.work_product_id === manualMemoId,
    );
    assert(manualMemoReview, "a manual-source memo must require human review");
    const manualExcerptAudit = manualMemoDetail.auditEvents.find((event: Record<string, any>) =>
      event.action === "legal_research_excerpt_confirmed" &&
      event.details?.snapshotId === manualSnapshotId,
    );
    const manualMemoAudit = manualMemoDetail.auditEvents.find((event: Record<string, any>) =>
      event.action === "human_note.legal_qa_answer_persisted" &&
      event.details?.workpaperId === manualMemoId,
    );
    assert(manualExcerptAudit && manualMemoAudit, "manual source chain requires audit records");
    for (const audit of [manualExcerptAudit, manualMemoAudit]) {
      const serialized = JSON.stringify(audit.details);
      assert.equal(serialized.includes(manualSource.content), false);
      assert.equal(serialized.includes(manualSource.title), false);
      assert.equal(serialized.includes(manualSource.documentId), false);
      assert.equal(serialized.includes("manual://local/"), false);
    }
    assert.match(manualExcerptAudit.details.sourceIdentityHash, /^sha256:[a-f0-9]{64}$/);
    assert.equal(manualExcerptAudit.details.sourceIdentity, undefined);
    assert.match(manualMemoAudit.details.sourceSnapshots[0].sourceIdentityHash, /^sha256:[a-f0-9]{64}$/);
    assert.equal(manualMemoAudit.details.sourceSnapshots[0].sourceIdentity, undefined);
    await repo.resolveReview(ctx, matter.id, manualMemoReview.id, {
      status: "accepted",
      comment: "律师确认手工导入来源的限定用途。",
      createEvalCase: false,
    });

    const updatedManualSnapshot = await request(baseUrl, manualSourcesPath, {
      method: "POST",
      body: { ...manualSource, content: `${sourceText}（律师本地更新版）` },
    });
    assert.equal(updatedManualSnapshot.response.status, 201);
    assert.equal(updatedManualSnapshot.body.content.sourceIdentity, manualSnapshot.body.content.sourceIdentity);
    assert.notEqual(
      updatedManualSnapshot.body.content.snapshot.contentHash,
      manualSnapshot.body.content.snapshot.contentHash,
    );
    const staleManualExcerpt = await request(baseUrl, `${root}/requests/${requestId}/input-manifests`, {
      method: "POST",
      body: { excerptIds: [manualExcerptId] },
    });
    assert.equal(staleManualExcerpt.response.status, 409);
    assert.equal(staleManualExcerpt.body.code, "source_changed");
    const staleManualManifest = await request(baseUrl, `${root}/input-manifests/${manualManifestId}/memos`, {
      method: "POST",
      body: {
        findings: [{
          conclusion: "旧输入清单不得在来源更新后继续生成备忘录。",
          confidence: "medium",
          uncertainty: null,
          position: "neutral",
          citations: [{ excerptId: manualExcerptId, sourceType: "statute" }],
        }],
      },
    });
    assert.equal(staleManualManifest.response.status, 409);
    assert.equal(staleManualManifest.body.code, "source_changed");
    await assert.rejects(
      () => repo.approveLegalQaAnswer(ctx, matter.id, manualMemoId),
      /reviewed input binding changed/,
    );
    const staleManualDetail = await repo.getMatterDetail(ctx, matter.id) as Record<string, any>;
    const staleManualMemo = staleManualDetail.workProducts.find((product: Record<string, unknown>) =>
      product.id === manualMemoId,
    );
    assert(staleManualMemo.stale_at, "manual source updates must mark the old memo stale");

    const preview = await request(baseUrl, `${root}/requests/${requestId}/query-preview`, {
      method: "POST",
      body: {
        provider: "pkulaw",
        issueTreeId,
        query: "杭州甲公司与乙公司于2026年7月12日签订设备采购合同，金额1000万元，乙方迟延交货六个月，解除合同条件",
        protectedTerms: ["杭州甲公司", "乙公司", "1000万元"],
      },
    });
    assert.equal(preview.response.status, 201);
    const queryPlanId = preview.body.id as string;
    const outboundPreview = preview.body.content.preview.query as string;
    assert.equal(outboundPreview.includes("杭州甲公司"), false);
    assert.equal(outboundPreview.includes("乙公司"), false);
    assert.equal(outboundPreview.includes("1000万元"), false);
    assert.equal(outboundPreview.includes("2026年7月12日"), false);
    assert.equal(preview.body.content.issueTreeId, issueTreeId);
    assert.equal(preview.body.content.issueTreeHash, issueTree.body.content.tree.treeHash);
    assert.equal(preview.body.content.caseContextId, created.body.content.caseContextId);
    assert.equal(preview.body.content.caseContextHash, created.body.content.caseContextHash);
    assert.equal(
      preview.body.content.caseContextContentHash,
      created.body.content.caseContextContentHash,
    );

    const queryApproval = await request(baseUrl, `${root}/query-plans/${queryPlanId}/approval`, { method: "POST" });
    assert.equal(queryApproval.response.status, 201);
    const queryCheckpointId = queryApproval.body.id as string;
    const unauthorizedSearch = await request(baseUrl, `${root}/query-plans/${queryPlanId}/search`, {
      method: "POST",
      body: { approvalCheckpointId: queryCheckpointId },
    });
    assert.equal(unauthorizedSearch.response.status, 409);
    assert.equal(outboundQueries.length, 0, "unapproved research must not reach an API");

    await repo.decideApproval(ctx, matter.id, queryCheckpointId, {
      decision: "approved",
      comment: "律师确认外发查询仅包含泛化法律问题。",
    });
    const searched = await request(baseUrl, `${root}/query-plans/${queryPlanId}/search`, {
      method: "POST",
      body: { approvalCheckpointId: queryCheckpointId },
    });
    assert.equal(searched.response.status, 201);
    assert.deepEqual(outboundQueries, [outboundPreview]);
    const searchResultId = searched.body.id as string;

    const sourceApproval = await request(baseUrl, `${root}/query-plans/${queryPlanId}/search-results/${searchResultId}/sources/civil-code-563/approval`, { method: "POST" });
    assert.equal(sourceApproval.response.status, 201);
    const sourceCheckpointId = sourceApproval.body.id as string;
    const unauthorizedFetch = await request(baseUrl, `${root}/query-plans/${queryPlanId}/search-results/${searchResultId}/sources/civil-code-563/fetch`, {
      method: "POST",
      body: { approvalCheckpointId: sourceCheckpointId },
    });
    assert.equal(unauthorizedFetch.response.status, 409);
    assert.equal(fetchedDocumentIds.length, 0, "unapproved source fetch must not reach an API");

    await repo.decideApproval(ctx, matter.id, sourceCheckpointId, {
      decision: "approved",
      comment: "律师确认下载该法规来源。",
    });
    const fetched = await request(baseUrl, `${root}/query-plans/${queryPlanId}/search-results/${searchResultId}/sources/civil-code-563/fetch`, {
      method: "POST",
      body: { approvalCheckpointId: sourceCheckpointId },
    });
    assert.equal(fetched.response.status, 201);
    assert.deepEqual(fetchedDocumentIds, ["civil-code-563"]);
    const snapshotId = fetched.body.id as string;
    assert.equal(fetched.body.content.snapshot.contentHash, hash(sourceText));
    assert.equal(fetched.body.content.content, sourceText);

    const excerptQuote = "当事人一方迟延履行债务或者有其他违约行为致使不能实现合同目的的，当事人可以解除合同。";
    const excerpt = await request(baseUrl, `${root}/snapshots/${snapshotId}/excerpts`, {
      method: "POST",
      body: {
        quote: excerptQuote,
        comment: "律师逐字确认该条文原文，并用于解除合同研究。",
      },
    });
    assert.equal(excerpt.response.status, 201);
    const excerptId = excerpt.body.id as string;
    assert.match(excerpt.body.content.quoteHash, /^sha256:[a-f0-9]{64}$/);

    const manifest = await request(baseUrl, `${root}/requests/${requestId}/input-manifests`, {
      method: "POST",
      body: { excerptIds: [excerptId] },
    });
    assert.equal(manifest.response.status, 201);
    const inputManifestId = manifest.body.id as string;
    assert.match(manifest.body.content.bindingHash, /^sha256:[a-f0-9]{64}$/);

    const insufficient = await request(baseUrl, `${root}/input-manifests/${inputManifestId}/memos`, {
      method: "POST",
      body: { findings: [] },
    });
    assert.equal(insufficient.response.status, 422);
    assert.equal(insufficient.body.code, "insufficient_basis");

    const memo = await request(baseUrl, `${root}/input-manifests/${inputManifestId}/memos`, {
      method: "POST",
      body: {
        findings: [{
          conclusion: "仅在迟延履行致使不能实现合同目的时，迟延交货才可能构成法定解除事由；仍需核对催告、合同目的与替代履行事实。",
          confidence: "medium",
          uncertainty: "现有来源只说明一般规则，尚需补充裁判观点和送达事实。",
          position: "neutral",
          citations: [{ excerptId, sourceType: "statute" }],
        }],
      },
    });
    assert.equal(memo.response.status, 201);
    const memoId = memo.body.id as string;
    assert.equal(memo.body.status, "needs_review");
    assert.equal(memo.body.content.gate.status, "ready_for_review");
    const detailBeforeStale = await repo.getMatterDetail(ctx, matter.id) as Record<string, any>;
    const memoReview = detailBeforeStale.reviews.find((review: Record<string, unknown>) => review.work_product_id === memoId);
    assert(memoReview, "a research memo must create a human review item");
    await repo.resolveReview(ctx, matter.id, memoReview.id, {
      status: "accepted",
      comment: "律师确认现阶段只能作为待补充的研究结论。",
      createEvalCase: false,
    });

    await repo.createWorkProduct(ctx, matter.id, {
      kind: "external_source_workpaper",
      title: "中华人民共和国民法典第五百六十三条（更新快照）",
      status: "generated",
      schemaVersion: "vera-legal-source-snapshot-v1",
      content: {
        schemaVersion: "vera-legal-source-snapshot-v1",
        sourceIdentity: "pkulaw:civil-code-563",
        snapshot: {
          contentHash: hash(`${sourceText}（更新）`),
          effectiveDate: "2021-01-01",
          fetchedAt: "2026-07-12T12:02:00.000Z",
          sourceType: "pkulaw",
          url: "https://api.pkulaw.example/law/civil-code-563",
          version: "2021-01-01",
        },
        content: `${sourceText}（更新）`,
      },
      validationErrors: [],
      generatedBy: "system",
      model: null,
    });
    await assert.rejects(
      () => repo.approveLegalQaAnswer(ctx, matter.id, memoId),
      /reviewed input binding changed/,
    );
    const staleDetail = await repo.getMatterDetail(ctx, matter.id) as Record<string, any>;
    const staleMemo = staleDetail.workProducts.find((product: Record<string, unknown>) => product.id === memoId);
    assert(staleMemo.stale_at, "source changes must mark a pending memo stale");
    assert.match(staleMemo.stale_reason, /changed/);

    const issueTreeStaleCandidate = await repo.createWorkProduct(ctx, matter.id, {
      kind: "legal_qa_answer",
      title: "法律研究备忘录：争点树变更审计",
      status: "needs_review",
      schemaVersion: "vera-legal-research-memo-v1",
      content: memo.body.content,
      validationErrors: [],
      generatedBy: "human",
      model: null,
    }) as Record<string, any>;
    const issueTreeStaleReview = await repo.addReview(ctx, matter.id, {
      targetType: "work_product",
      targetId: issueTreeStaleCandidate.id,
      workProductId: issueTreeStaleCandidate.id,
      evidenceItemId: null,
      reviewerName: null,
      tag: "needs_human_judgment",
      comment: "审计争点树变更后的最终审批阻断。",
    });
    await repo.resolveReview(ctx, matter.id, issueTreeStaleReview.id, {
      status: "accepted",
      comment: "律师已完成此审计复核。",
      createEvalCase: false,
    });
    await repo.appendAuditEvent(ctx, matter.id, {
      actor: "system",
      action: "human_note.legal_qa_answer_persisted",
      workflowVersion: "vera-legal-research-memo-v1",
      model: null,
      details: { workpaperId: issueTreeStaleCandidate.id },
    });

    const revisedIssueTree = await request(baseUrl, `${root}/requests/${requestId}/issues`, {
      method: "POST",
      body: {
        nodes: [{
          id: "root",
          parentId: null,
          title: "迟延交货是否达到法定解除合同的条件",
          description: "补充研究根本违约、催告与替代履行。",
          status: "open",
          order: 0,
        }],
      },
    });
    assert.equal(revisedIssueTree.response.status, 201);
    await assert.rejects(
      () => repo.approveLegalQaAnswer(ctx, matter.id, issueTreeStaleCandidate.id),
      /issue tree/,
    );
    const issueTreeStaleDetail = await repo.getMatterDetail(ctx, matter.id) as Record<string, any>;
    const issueTreeStaleMemo = issueTreeStaleDetail.workProducts.find((product: Record<string, unknown>) => product.id === issueTreeStaleCandidate.id);
    assert.match(issueTreeStaleMemo.stale_reason, /issue tree/i);
    const stalePlanApproval = await request(baseUrl, `${root}/query-plans/${queryPlanId}/approval`, {
      method: "POST",
    });
    assert.equal(stalePlanApproval.response.status, 409);
    assert.equal(stalePlanApproval.body.code, "issue_tree_changed");

    const contextStaleCandidate = await repo.createWorkProduct(ctx, matter.id, {
      kind: "legal_qa_answer",
      title: "法律研究备忘录：案情上下文变更审计",
      status: "needs_review",
      schemaVersion: "vera-legal-research-memo-v1",
      content: memo.body.content,
      validationErrors: [],
      generatedBy: "human",
      model: null,
    }) as Record<string, any>;
    const contextStaleReview = await repo.addReview(ctx, matter.id, {
      targetType: "work_product",
      targetId: contextStaleCandidate.id,
      workProductId: contextStaleCandidate.id,
      evidenceItemId: null,
      reviewerName: null,
      tag: "needs_human_judgment",
      comment: "Audit the final approval block when the bound case context changes.",
    });
    await repo.resolveReview(ctx, matter.id, contextStaleReview.id, {
      status: "accepted",
      comment: "Counsel completed the audit review.",
      createEvalCase: false,
    });
    await repo.appendAuditEvent(ctx, matter.id, {
      actor: "system",
      action: "human_note.legal_qa_answer_persisted",
      workflowVersion: "vera-legal-research-memo-v1",
      model: null,
      details: { workpaperId: contextStaleCandidate.id },
    });
    await repo.correctLitigationProceduralEvent(ctx, matter.id, proceduralEvent.id, {
      title: "律师函送达并要求限期交货（更正）",
      occurredAt: "2026-06-16",
      reason: "律师复核原件后更正送达日期。",
      source: {
        sourceChunkId: factChunk.id,
        quoteStart: 0,
        quoteEnd: factSourceText.length,
      },
    });
    await assert.rejects(
      () => repo.approveLegalQaAnswer(ctx, matter.id, contextStaleCandidate.id),
      /case context changed/i,
    );
    const contextStaleDetail = await repo.getMatterDetail(ctx, matter.id) as Record<string, any>;
    const contextStaleMemo = contextStaleDetail.workProducts.find((product: Record<string, unknown>) =>
      product.id === contextStaleCandidate.id,
    );
    assert.match(contextStaleMemo.stale_reason, /case context changed/i);

    const actions = new Set(contextStaleDetail.auditEvents.map((event: Record<string, unknown>) => event.action));
    for (const action of [
      "legal_research_request_created",
      "legal_research_case_context_bound",
      "legal_research_query_previewed",
      "legal_research_search_completed",
      "legal_research_source_snapshot_saved",
      "legal_research_excerpt_confirmed",
      "legal_research_agent_input_bound",
      "legal_research_insufficient_basis",
      "legal_research_memo_marked_stale",
    ]) assert(actions.has(action), `missing audit action ${action}`);

    process.stdout.write(`${JSON.stringify({
      ok: true,
      suite: "vera-legal-research-broker-audit-v3",
      checks: [
        "server-derived v2 matter case context",
        "case-context audit redaction and invalid-selection rejection",
        "generic work-product bypass rejected",
        "repository accepted-answer bypass rejected",
        "matter-owner isolation",
        "manual-source minimal contract and derived-field rejection",
        "manual-source statutory date validation and no-case policy",
        "manual-source matter/request isolation",
        "manual-source metadata-only audit trail",
        "manual-source exact-excerpt and manifest enforcement",
        "snapshot content-hash integrity enforcement",
        "manual-source update blocks old excerpt, manifest, and memo approval",
        "lawyer-visible query redaction",
        "issue-tree-bound query plan and stale-tree block",
        "approval-required API search",
        "approval-required API source fetch",
        "allowlisted-adapter-only source capture",
        "immutable local source snapshot and hash",
        "lawyer-confirmed exact excerpt",
        "immutable Agent input binding",
        "insufficient-basis outcome",
        "per-conclusion source citation",
        "mandatory human review",
        "source-change stale approval block",
        "issue-tree-change stale approval block",
        "case-context-change stale approval block",
        "matter-scoped audit trail",
      ],
    })}\n`);
  } finally {
    if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
    rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
