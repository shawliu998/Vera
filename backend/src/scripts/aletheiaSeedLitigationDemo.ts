import { createAletheiaRepository } from "../lib/aletheia";
import path from "node:path";
import { LocalDatabase } from "../lib/aletheia/localDatabase";

const ctx = { userId: "local-user", userEmail: "local@aletheia.invalid" };
const seedSuffix = process.env.ALETHEIA_DEMO_SEED_ID?.trim();
const title = seedSuffix
  ? `Aletheia Litigation Demo ${seedSuffix}`
  : "Aletheia Litigation Demo";

function asRecord(value: unknown) {
  return value as Record<string, any>;
}

async function main() {
  const repository = createAletheiaRepository();
  const existing = (await repository.listMatters(ctx)) as Array<
    Record<string, any>
  >;
  let matter = existing.find(
    (item) => item.title === title && item.template === "civil_litigation",
  );
  if (!matter) {
    matter = asRecord(
      await repository.createMatter(ctx, {
        title,
        objective:
          "Assess the payment dispute, verify the hearing notice, map the defense to confirmed facts, and prepare an evidence-grounded response.",
        template: "civil_litigation",
        status: "in_progress",
        riskLevel: "high",
        clientOrProject: "Huaxin Manufacturing v. Lanting Trading",
        sourceProjectId: null,
        sharedWith: [],
        metadata: {
          demo: true,
          court: "Hangzhou Intermediate People's Court",
          representedSide: "defendant",
        },
      }),
    );
  }
  const matterId = String(matter.id);
  const detail = asRecord(await repository.getMatterDetail(ctx, matterId));
  if (!detail.documents?.length) {
    const lowOcrFixture = process.env.ALETHEIA_DEMO_LOW_OCR === "true";
    const documents = lowOcrFixture
      ? [
          {
            filename: "hearing-notice.txt",
            lines: [
              "杭州市中级人民法院开庭通知",
              "本院定于2026年8月10日上午9时就华信制造有限公司与兰亭贸易有限公司买卖合同纠纷一案开庭审理。",
              "被告应于2026年8月3日前完成证据材料内部复核，并按法院要求提交证据目录。",
            ],
          },
          {
            filename: "scanned-payment-record.txt",
            lines: [
              "付款记录显示，争议款项约定付款日为2026年9月1日。",
              "原告主张被告已经逾期付款；被告主张付款期限尚未届满。",
            ],
          },
        ]
      : [
          {
            filename: "hearing-notice-and-payment-record.txt",
            lines: [
              "杭州市中级人民法院开庭通知",
              "本院定于2026年8月10日上午9时就华信制造有限公司与兰亭贸易有限公司买卖合同纠纷一案开庭审理。",
              "被告应于2026年8月3日前完成证据材料内部复核，并按法院要求提交证据目录。",
              "付款记录显示，争议款项约定付款日为2026年9月1日。",
              "原告主张被告已经逾期付款；被告主张付款期限尚未届满。",
            ],
          },
        ];
    for (const document of documents) {
      const bytes = Buffer.from(document.lines.join("\n"), "utf8");
      await repository.uploadMatterDocument(ctx, matterId, {
        filename: document.filename,
        mimeType: "text/plain",
        sizeBytes: bytes.length,
        buffer: bytes,
      });
    }
  }

  const workspace = asRecord(
    await repository.getLitigationWorkspace(ctx, matterId),
  );
  if (!workspace.facts?.length) {
    const sourceIndex = asRecord(
      await repository.listV1SourceIndex(ctx, matterId, {
        includeChunks: true,
        includeEvidenceLinks: true,
        chunkLimit: 100,
      }),
    );
    const sourceChunks = (sourceIndex.chunks ?? []) as Array<
      Record<string, any>
    >;
    const hearingChunk = sourceChunks.find((item) =>
      String(item.text).includes("2026年8月10日上午9时"),
    );
    const paymentChunk = sourceChunks.find((item) =>
      String(item.text).includes("争议款项约定付款日为2026年9月1日"),
    );
    if (!hearingChunk || !paymentChunk) {
      throw new Error(
        "Demo document did not produce searchable source chunks.",
      );
    }
    const hearingQuote = "2026年8月10日上午9时";
    const paymentQuote = "争议款项约定付款日为2026年9月1日";
    const hearingStart = String(hearingChunk.text).indexOf(hearingQuote);
    const paymentStart = String(paymentChunk.text).indexOf(paymentQuote);
    if (hearingStart < 0 || paymentStart < 0) {
      throw new Error("Demo source quotes were not retained by the parser.");
    }
    if (process.env.ALETHEIA_DEMO_LOW_OCR === "true") {
      const dataDir = process.env.ALETHEIA_DATA_DIR;
      if (!dataDir)
        throw new Error("ALETHEIA_DATA_DIR is required for OCR UI seed.");
      const db = new LocalDatabase(path.join(dataDir, "aletheia.db"));
      try {
        // Playwright starts the local backend before global setup. Give its
        // WAL writer a bounded window to finish instead of making this direct
        // fixture update fail immediately with SQLITE_BUSY.
        db.exec("pragma busy_timeout = 5000");
        db.prepare(
          "update aletheia_document_chunks set metadata = ? where id = ? and matter_id = ? and user_id = ?",
        ).run(
          JSON.stringify({
            ...(paymentChunk.metadata ?? {}),
            ocrProvenance: {
              engine: "apple-vision",
              page: Number(paymentChunk.page ?? 1),
              confidence: 0.55,
            },
          }),
          paymentChunk.id,
          matterId,
          ctx.userId,
        );
      } finally {
        db.close();
      }
    }

    const hearingFact = asRecord(
      await repository.createLitigationFact(ctx, matterId, {
        statement:
          "The court scheduled the hearing for 10 August 2026 at 09:00.",
        occurredAt: "2026-08-10T09:00:00+08:00",
        datePrecision: "day",
        sourceRelation: "supports",
        helpfulness: "neutral",
        confidence: "high",
        createdBy: "agent",
        source: {
          sourceChunkId: String(hearingChunk.id),
          quoteStart: hearingStart,
          quoteEnd: hearingStart + hearingQuote.length,
        },
      }),
    );
    await repository.decideLitigationFact(
      ctx,
      matterId,
      String(hearingFact.id),
      { decision: "confirmed", comment: "Verified against the court notice." },
    );
    const paymentFact = asRecord(
      await repository.createLitigationFact(ctx, matterId, {
        statement:
          "The disputed payment was contractually due on 1 September 2026.",
        occurredAt: "2026-09-01T00:00:00+08:00",
        datePrecision: "day",
        sourceRelation: "supports",
        helpfulness: "helpful",
        confidence: "medium",
        createdBy: "agent",
        source: {
          sourceChunkId: String(paymentChunk.id),
          quoteStart: paymentStart,
          quoteEnd: paymentStart + paymentQuote.length,
        },
      }),
    );
    const defense = asRecord(
      await repository.createLitigationClaim(ctx, matterId, {
        kind: "defense",
        title: "The payment obligation was not due when the action was filed.",
        legalBasis: "Contract performance period and defense of non-maturity.",
        confidence: "medium",
        uncertainty:
          "The filing date and any acceleration clause still require review.",
        sourceRelation: "supports",
        source: {
          sourceChunkId: String(paymentChunk.id),
          quoteStart: paymentStart,
          quoteEnd: paymentStart + paymentQuote.length,
        },
        createdBy: "agent",
      }),
    );
    const element = asRecord(
      await repository.createLitigationElement(
        ctx,
        matterId,
        String(defense.id),
        {
          title: "Agreed payment due date",
          sequence: 1,
          description: "The contract fixes a payment date after filing.",
          createdBy: "agent",
        },
      ),
    );
    await repository.linkLitigationElementFact(
      ctx,
      matterId,
      String(element.id),
      { factId: String(paymentFact.id), relation: "supports" },
    );
    const event = asRecord(
      await repository.createLitigationProceduralEvent(ctx, matterId, {
        eventType: "hearing_notice",
        title: "Court hearing notice received",
        occurredAt: "2026-07-10T10:00:00+08:00",
        createdBy: "agent",
        source: {
          sourceChunkId: String(hearingChunk.id),
          quoteStart: hearingStart,
          quoteEnd: hearingStart + hearingQuote.length,
        },
      }),
    );
    await repository.createLitigationDeadline(ctx, matterId, {
      title: "Complete internal evidence review",
      dueAt: "2026-08-03T18:00:00+08:00",
      triggeringEventId: String(event.id),
      ruleLabel: "Court notice and internal review policy",
      ruleVersion: "demo-2026-01",
      calculation: "Complete internal review seven days before the hearing.",
      createdBy: "agent",
      source: {
        sourceChunkId: String(hearingChunk.id),
        quoteStart: hearingStart,
        quoteEnd: hearingStart + hearingQuote.length,
      },
    });
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        matterId,
        path: `/aletheia/matters/${matterId}/litigation`,
        matterUrl: `/aletheia/matters/${matterId}/litigation`,
        matterTitle: title,
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
