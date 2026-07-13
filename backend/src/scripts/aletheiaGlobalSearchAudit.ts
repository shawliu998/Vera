import assert from "node:assert/strict";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

type RecordValue = Record<string, any>;

const HOST = "127.0.0.1";
const AUTH_TOKEN = "global-search-audit-private-token-000000000001";

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
  authenticated = true,
) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    headers: authenticated
      ? { authorization: `Bearer ${AUTH_TOKEN}` }
      : undefined,
  });
  return { response, body: await response.json() };
}

async function main() {
  const dataDir = mkdtempSync(
    path.join(os.tmpdir(), "aletheia-global-search-audit-"),
  );
  process.env.ALETHEIA_AUTH_MODE = "private_token";
  process.env.ALETHEIA_PRIVATE_AUTH_TOKEN = AUTH_TOKEN;
  process.env.ALETHEIA_LOCAL_USER_ID = "global-search-user";
  process.env.ALETHEIA_LOCAL_USER_EMAIL = "search@example.test";
  process.env.ALETHEIA_DATA_DIR = dataDir;
  process.env.ALETHEIA_APPLICATION_ENCRYPTION = "disabled";
  process.env.ALETHEIA_DATABASE_ENCRYPTION = "metadata_plaintext";

  let server: http.Server | null = null;
  try {
    const [{ createAletheiaRepository }, { aletheiaRouter }] =
      await Promise.all([
        import("../lib/aletheia"),
        import("../routes/aletheia"),
      ]);
    const repo = createAletheiaRepository();
    const ctx = {
      userId: "global-search-user",
      userEmail: "search@example.test",
    };
    const foreignCtx = {
      userId: "foreign-search-user",
      userEmail: "foreign-search@example.test",
    };
    const createMatter = async (
      owner: typeof ctx,
      title: string,
      objective: string,
    ) =>
      asRecord(
        await repo.createMatter(owner, {
          title,
          objective,
          template: "civil_litigation",
          status: "in_progress",
          riskLevel: "high",
          clientOrProject: "Orion Client",
          sourceProjectId: null,
          sharedWith: [],
          metadata: { audit: "global_search" },
        }),
      );

    const matter = await createMatter(
      ctx,
      "Orion contract dispute",
      "Assess liability and preserve evidence.",
    );
    const document = asRecord(
      await repo.uploadMatterDocument(ctx, matter.id, {
        filename: "Orion Evidence.txt",
        mimeType: "text/plain",
        sizeBytes: 560,
        buffer: Buffer.from(
          `The meridian clause controls notice. ${"Supporting chronology and correspondence. ".repeat(14)}`,
          "utf8",
        ),
      }),
    );
    const workProduct = asRecord(
      await repo.createWorkProduct(ctx, matter.id, {
        kind: "litigation_brief",
        title: "Orion liability analysis",
        status: "generated",
        schemaVersion: "global-search-audit-v1",
        content: { finding: "Test work product" },
        validationErrors: [],
        generatedBy: "human",
        model: null,
      }),
    );
    const fact = asRecord(
      await repo.createLitigationFact(ctx, matter.id, {
        statement: "Orion delivery occurred after the agreed milestone.",
        occurredAt: "2026-06-12T09:00:00+08:00",
        datePrecision: "day",
        helpfulness: "supports",
        confidence: "high",
        createdBy: "human",
      }),
    );
    const position = asRecord(
      await repo.createLitigationClaim(ctx, matter.id, {
        kind: "claim",
        title: "Orion delayed-delivery liability",
        legalBasis: "Contractual delivery obligation",
        confidence: "medium",
        uncertainty: "Damages remain to be proved.",
        createdBy: "human",
      }),
    );
    const deadline = asRecord(
      await repo.createLitigationDeadline(ctx, matter.id, {
        title: "Orion filing deadline",
        dueAt: "2026-08-03T18:00:00+08:00",
        ruleLabel: "Court order",
        ruleVersion: "court-order-v1",
        calculation: "Date stated in the court order.",
        createdBy: "human",
      }),
    );
    await repo.decideLitigationDeadline(ctx, matter.id, deadline.id, {
      decision: "confirmed",
    });
    const taskResult = asRecord(
      await repo.createTaskFromLitigationDeadline(ctx, matter.id, deadline.id, {
        title: "Orion filing task",
        priority: "high",
      }),
    );
    const task = asRecord(taskResult.task);

    const chineseMatter = await createMatter(
      ctx,
      "星河证据保全案件",
      "验证中文案件标题检索。",
    );
    const chineseDocument = asRecord(
      await repo.uploadMatterDocument(ctx, chineseMatter.id, {
        filename: "星河证据目录.txt",
        mimeType: "text/plain",
        sizeBytes: 30,
        buffer: Buffer.from("中文文档内容用于本地检索。", "utf8"),
      }),
    );
    const chineseFact = asRecord(
      await repo.createLitigationFact(ctx, chineseMatter.id, {
        statement: "被告于二〇二六年六月十二日签收保全裁定。",
        occurredAt: "2026-06-12T10:00:00+08:00",
        datePrecision: "day",
        createdBy: "human",
      }),
    );
    const chinesePosition = asRecord(
      await repo.createLitigationClaim(ctx, chineseMatter.id, {
        kind: "claim",
        title: "请求被告支付逾期违约金",
        legalBasis: "合同约定的逾期付款责任",
        createdBy: "human",
      }),
    );
    const chineseDeadline = asRecord(
      await repo.createLitigationDeadline(ctx, chineseMatter.id, {
        title: "举证期限届满",
        dueAt: "2026-08-18T18:00:00+08:00",
        ruleLabel: "法院举证通知书",
        ruleVersion: "court-notice-v1",
        calculation: "按法院通知书载明日期记录。",
        createdBy: "human",
      }),
    );

    const foreignMatter = await createMatter(
      foreignCtx,
      "Orion foreign confidential matter",
      "Must never cross the user boundary.",
    );
    const foreignDocument = asRecord(
      await repo.uploadMatterDocument(foreignCtx, foreignMatter.id, {
        filename: "Orion Foreign Secret.txt",
        mimeType: "text/plain",
        sizeBytes: 48,
        buffer: Buffer.from(
          "The meridian foreign secret must remain isolated.",
        ),
      }),
    );
    const foreignWorkProduct = asRecord(
      await repo.createWorkProduct(foreignCtx, foreignMatter.id, {
        kind: "issue_map",
        title: "Orion foreign work product",
        status: "generated",
        schemaVersion: "global-search-audit-v1",
        content: {},
        validationErrors: [],
        generatedBy: "human",
        model: null,
      }),
    );
    const foreignFact = asRecord(
      await repo.createLitigationFact(foreignCtx, foreignMatter.id, {
        statement: "Orion foreign fact must remain isolated.",
        createdBy: "human",
      }),
    );
    const foreignPosition = asRecord(
      await repo.createLitigationClaim(foreignCtx, foreignMatter.id, {
        kind: "defense",
        title: "Orion foreign defense must remain isolated",
        createdBy: "human",
      }),
    );
    const foreignDeadline = asRecord(
      await repo.createLitigationDeadline(foreignCtx, foreignMatter.id, {
        title: "Orion foreign deadline must remain isolated",
        dueAt: "2026-09-01T18:00:00+08:00",
        ruleLabel: "Foreign confidential order",
        ruleVersion: "foreign-v1",
        calculation: "Confidential.",
        createdBy: "human",
      }),
    );

    const app = express();
    app.use(express.json({ limit: "1mb" }));
    app.use("/aletheia", aletheiaRouter);
    server = app.listen(0, HOST);
    await new Promise<void>((resolve) => server?.once("listening", resolve));
    const address = server.address();
    assert(address && typeof address === "object");
    const baseUrl = `http://${HOST}:${address.port}`;

    const unauthenticated = await jsonRequest(
      baseUrl,
      "/aletheia/search?q=Orion",
      false,
    );
    assert.equal(unauthenticated.response.status, 401);

    const search = await jsonRequest(
      baseUrl,
      "/aletheia/search?q=%20Orion%20&limit=20",
    );
    assert.equal(search.response.status, 200);
    const payload = asRecord(search.body);
    assert.equal(payload.query, "Orion");
    assert.ok(payload.total >= 7);
    assert.deepEqual(
      new Set(payload.results.map((result: RecordValue) => result.kind)),
      new Set([
        "matter",
        "document",
        "fact",
        "position",
        "deadline",
        "task",
        "work_product",
      ]),
    );
    assert.ok(
      payload.results.some(
        (result: RecordValue) =>
          result.kind === "fact" && result.id === fact.id,
      ),
    );
    assert.ok(
      payload.results.some(
        (result: RecordValue) =>
          result.kind === "position" && result.id === position.id,
      ),
    );
    assert.ok(
      payload.results.some(
        (result: RecordValue) =>
          result.kind === "deadline" && result.id === deadline.id,
      ),
    );
    assert.ok(
      payload.results.some(
        (result: RecordValue) =>
          result.kind === "matter" && result.id === matter.id,
      ),
    );
    assert.ok(
      payload.results.some(
        (result: RecordValue) =>
          result.kind === "document" && result.id === document.id,
      ),
    );
    assert.ok(
      payload.results.some(
        (result: RecordValue) =>
          result.kind === "task" && result.id === task.id,
      ),
    );
    assert.ok(
      payload.results.some(
        (result: RecordValue) =>
          result.kind === "work_product" && result.id === workProduct.id,
      ),
    );
    const expectedHrefs = new Map([
      [
        matter.id,
        `/aletheia/matters/${matter.id}/litigation?view=overview`,
      ],
      [
        document.id,
        `/aletheia/matters/${matter.id}/litigation?view=facts&focus=document%3A${document.id}`,
      ],
      [
        fact.id,
        `/aletheia/matters/${matter.id}/litigation?view=facts&focus=fact%3A${fact.id}`,
      ],
      [
        position.id,
        `/aletheia/matters/${matter.id}/litigation?view=positions&focus=position%3A${position.id}`,
      ],
      [
        deadline.id,
        `/aletheia/matters/${matter.id}/litigation?view=procedure&focus=deadline%3A${deadline.id}`,
      ],
      [
        task.id,
        `/aletheia/matters/${matter.id}/litigation?view=procedure&focus=task%3A${task.id}`,
      ],
      [
        workProduct.id,
        `/aletheia/matters/${matter.id}/litigation?view=artifacts&focus=artifact%3A${workProduct.id}`,
      ],
    ]);
    for (const result of payload.results as RecordValue[]) {
      const expectedHref = expectedHrefs.get(result.id);
      if (expectedHref) assert.equal(result.href, expectedHref);
    }
    const ids = new Set(
      payload.results.map((result: RecordValue) => result.id),
    );
    assert.equal(
      ids.size,
      payload.results.length,
      "results must be deduplicated",
    );
    assert.ok(!ids.has(foreignMatter.id));
    assert.ok(!ids.has(foreignDocument.id));
    assert.ok(!ids.has(foreignWorkProduct.id));
    assert.ok(!ids.has(foreignFact.id));
    assert.ok(!ids.has(foreignPosition.id));
    assert.ok(!ids.has(foreignDeadline.id));

    const expectedResultKeys = [
      "href",
      "id",
      "kind",
      "matterId",
      "matterTitle",
      "snippet",
      "status",
      "title",
      "updatedAt",
    ];
    for (const result of payload.results as RecordValue[]) {
      assert.deepEqual(Object.keys(result).sort(), expectedResultKeys);
      assert.ok(result.snippet.length <= 240);
      assert.match(result.href, /^\/aletheia\/matters\//);
    }
    const serialized = JSON.stringify(payload);
    assert.ok(!serialized.includes(dataDir));
    assert.ok(!serialized.includes(`${path.sep}documents${path.sep}`));
    assert.ok(!serialized.includes(`${path.sep}exports${path.sep}`));

    const fts = await jsonRequest(
      baseUrl,
      "/aletheia/search?q=meridian&limit=20",
    );
    assert.equal(fts.response.status, 200);
    const ftsPayload = asRecord(fts.body);
    assert.ok(
      ftsPayload.results.some(
        (result: RecordValue) =>
          result.kind === "document" && result.id === document.id,
      ),
    );
    assert.ok(
      !ftsPayload.results.some(
        (result: RecordValue) => result.id === foreignDocument.id,
      ),
    );

    const legalBasisSearch = await jsonRequest(
      baseUrl,
      `/aletheia/search?q=${encodeURIComponent("Contractual delivery")}`,
    );
    assert.equal(legalBasisSearch.response.status, 200);
    assert.ok(
      asRecord(legalBasisSearch.body).results.some(
        (result: RecordValue) =>
          result.kind === "position" && result.id === position.id,
      ),
    );
    const deadlineRuleSearch = await jsonRequest(
      baseUrl,
      `/aletheia/search?q=${encodeURIComponent("Court order")}`,
    );
    assert.equal(deadlineRuleSearch.response.status, 200);
    assert.ok(
      asRecord(deadlineRuleSearch.body).results.some(
        (result: RecordValue) =>
          result.kind === "deadline" && result.id === deadline.id,
      ),
    );

    const safeSyntax = await jsonRequest(
      baseUrl,
      `/aletheia/search?q=${encodeURIComponent('OR ("')}`,
    );
    assert.equal(safeSyntax.response.status, 200);
    const escapedLike = await jsonRequest(
      baseUrl,
      `/aletheia/search?q=${encodeURIComponent("%_")}`,
    );
    assert.equal(escapedLike.response.status, 200);
    assert.equal(asRecord(escapedLike.body).total, 0);

    const chinese = await jsonRequest(
      baseUrl,
      `/aletheia/search?q=${encodeURIComponent("星河")}`,
    );
    assert.equal(chinese.response.status, 200);
    const chineseIds = new Set(
      asRecord(chinese.body).results.map((result: RecordValue) => result.id),
    );
    assert.ok(chineseIds.has(chineseMatter.id));
    assert.ok(chineseIds.has(chineseDocument.id));

    for (const [query, kind, id] of [
      ["签收保全裁定", "fact", chineseFact.id],
      ["逾期违约金", "position", chinesePosition.id],
      ["举证期限", "deadline", chineseDeadline.id],
    ] as const) {
      const result = await jsonRequest(
        baseUrl,
        `/aletheia/search?q=${encodeURIComponent(query)}`,
      );
      assert.equal(result.response.status, 200);
      assert.ok(
        asRecord(result.body).results.some(
          (item: RecordValue) => item.kind === kind && item.id === id,
        ),
      );
    }

    for (const query of ["q=a", "q=%20a%20", "q="]) {
      const short = await jsonRequest(baseUrl, `/aletheia/search?${query}`);
      assert.equal(short.response.status, 400);
    }
    const limited = await jsonRequest(
      baseUrl,
      "/aletheia/search?q=Orion&limit=2",
    );
    assert.equal(limited.response.status, 200);
    assert.equal(asRecord(limited.body).results.length, 2);
    assert.equal(asRecord(limited.body).total, payload.total);
    for (const invalidLimit of ["0", "51", "1.5", "abc"]) {
      const invalid = await jsonRequest(
        baseUrl,
        `/aletheia/search?q=Orion&limit=${invalidLimit}`,
      );
      assert.equal(invalid.response.status, 400);
    }

    console.log(
      "Aletheia global search audit passed: authenticated cross-matter search covers all entity kinds, Chinese names, safe FTS, user isolation, limits, deduplication, snippets, and path hygiene.",
    );
  } finally {
    if (server) await closeServer(server);
    rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("[aletheia-global-search-audit] failed", error);
  process.exitCode = 1;
});
