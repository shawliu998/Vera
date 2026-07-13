import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalControlRepository } from "../lib/aletheia/localControlRepository";
import {
  benchmarkLocalModel,
  localModelBenchmarkCasesForAudit,
  modelBenchmarkAcceptance,
} from "../lib/aletheia/localModelBenchmark";
import { LocalDatabase } from "../lib/aletheia/localDatabase";
import type { LocalModelStatusSnapshot } from "../lib/aletheia/localModelScheduler";

const model: LocalModelStatusSnapshot = {
  id: "benchmark-audit-model",
  adapter: "ollama",
  endpoint: "http://127.0.0.1:11434/",
  model: "benchmark-audit-model:fixed",
  modelRevision: `sha256:${"d".repeat(64)}`,
  managed: false,
  state: "ready",
  activeRequests: 0,
  queuedRequests: 0,
  concurrency: 1,
  queueLimit: 4,
  contextWindowTokens: 8192,
  maxOutputTokens: 2048,
  restartAttempts: 0,
  logTail: "",
};

function json(value: unknown) {
  return JSON.stringify(value);
}

function responseFor(prompt: string) {
  if (prompt.includes("receipt-v1")) {
    const quote =
      "2026年3月2日，甲方向乙方支付货款人民币5000元，乙方出具收据。";
    return json({
      summary: "收据显示甲方支付5000元。",
      summaryCitations: [{ sourceId: "receipt-v1", quote }],
      findings: [
        {
          statement: "收据证明支付5000元。",
          citations: [{ sourceId: "receipt-v1", quote }],
          confidence: "high",
          uncertainty: null,
        },
      ],
      questionsForCounsel: [],
    });
  }
  if (prompt.includes("ledger-v1")) {
    const ledger = "乙方台账记载：2026年4月8日收到甲方尾款人民币20000元。";
    const bank =
      "银行流水显示：2026年4月8日甲方账户未向乙方账户发生人民币20000元转账。";
    return json({
      summary: "两份记录存在矛盾，无法确定尾款是否支付。",
      summaryCitations: [
        { sourceId: "ledger-v1", quote: ledger },
        { sourceId: "bank-v1", quote: bank },
      ],
      findings: [
        {
          statement: "台账与银行流水存在矛盾，需核实付款。",
          citations: [
            { sourceId: "ledger-v1", quote: ledger },
            { sourceId: "bank-v1", quote: bank },
          ],
          confidence: "low",
          uncertainty: "两份来源矛盾，尚需核实。",
        },
      ],
      questionsForCounsel: ["请提供银行付款凭证以核实付款。"],
    });
  }
  if (prompt.includes("contract-v1")) {
    const quote =
      "《设备采购合同》第五条仅约定乙方应交付设备，未载明实际交付日期或验收记录。";
    return json({
      summary: "合同未载明实际交付日期，证据不足，无法确定设备是否交付。",
      summaryCitations: [{ sourceId: "contract-v1", quote }],
      findings: [
        {
          statement: "现有材料未载明交付或验收，无法确定。",
          citations: [{ sourceId: "contract-v1", quote }],
          confidence: "low",
          uncertainty: "证据不足，无法确定实际交付。",
        },
      ],
      questionsForCounsel: ["请提供交付单和验收记录。"],
    });
  }
  const quote =
    "2026年5月28日乙方微信回复：同意将本案付款期限延长至2026年6月30日。";
  return json({
    summary: "乙方同意将付款期限延长至6月30日。",
    summaryCitations: [{ sourceId: "wechat-v1", quote }],
    findings: [
      {
        statement: "微信回复显示乙方同意延长至6月30日。",
        citations: [{ sourceId: "wechat-v1", quote }],
        confidence: "high",
        uncertainty: null,
      },
    ],
    questionsForCounsel: [],
  });
}

type SchedulerMode =
  | "pass"
  | "quote-altered"
  | "error"
  | "extra-finding"
  | "conflict-missing-source"
  | "unexpected-uncertainty"
  | "unexpected-question"
  | "provider-mismatch";

function scheduler(mode: SchedulerMode, calls: Array<Record<string, unknown>>) {
  return {
    generate: async (request: Record<string, unknown>) => {
      calls.push(request);
      if (mode === "error") {
        const error = new Error("synthetic local model outage") as Error & {
          code: string;
        };
        error.code = "LOCAL_MODEL_ERROR";
        throw error;
      }
      let text = responseFor(String(request.prompt));
      if (
        mode === "quote-altered" &&
        String(request.prompt).includes("receipt-v1")
      ) {
        text = text.replace("乙方出具收据。", "乙方出具收据（改写）。");
      }
      if (
        mode === "extra-finding" ||
        mode === "conflict-missing-source" ||
        mode === "unexpected-uncertainty" ||
        mode === "unexpected-question"
      ) {
        const output = JSON.parse(text) as {
          findings: Array<{
            statement: string;
            citations: Array<{ sourceId: string; quote: string }>;
            confidence: string;
            uncertainty: string | null;
          }>;
          questionsForCounsel: string[];
        };
        const finding = output.findings[0];
        if (!finding)
          throw new Error("Synthetic audit response omitted finding.");
        if (
          mode === "extra-finding" &&
          String(request.prompt).includes("receipt-v1")
        ) {
          output.findings.push({
            ...finding,
            citations: [...finding.citations],
          });
        }
        if (
          mode === "conflict-missing-source" &&
          String(request.prompt).includes("ledger-v1")
        ) {
          finding.citations = finding.citations.filter(
            (citation) => citation.sourceId !== "bank-v1",
          );
        }
        if (
          mode === "unexpected-uncertainty" &&
          String(request.prompt).includes("receipt-v1")
        ) {
          finding.uncertainty = "不应出现的不确定性";
        }
        if (
          mode === "unexpected-question" &&
          String(request.prompt).includes("receipt-v1")
        ) {
          output.questionsForCounsel = ["不应提出的问题"];
        }
        text = JSON.stringify(output);
      }
      return {
        text,
        modelId: model.id,
        providerModel:
          mode === "provider-mismatch"
            ? `${model.model}:unexpected`
            : model.model,
        estimatedInputTokens: 120,
        outputTokens: 120,
        totalTokens: 240,
        durationMs: 5,
      };
    },
  };
}

async function main() {
  const directory = mkdtempSync(
    path.join(os.tmpdir(), "aletheia-model-benchmark-"),
  );
  process.env.ALETHEIA_DATA_DIR = directory;
  process.env.ALETHEIA_APPLICATION_ENCRYPTION = "required";
  process.env.ALETHEIA_MASTER_KEY_SOURCE = "env";
  process.env.ALETHEIA_MASTER_KEY_BASE64 = Buffer.alloc(32, 67).toString(
    "base64",
  );
  const databasePath = path.join(directory, "aletheia.db");
  const sourceQuotes = localModelBenchmarkCasesForAudit().flatMap((item) =>
    item.sources.map((source) => source.quote),
  );
  let repository = new LocalControlRepository({ databasePath });
  try {
    const passCalls: Array<Record<string, unknown>> = [];
    const passed = await benchmarkLocalModel({
      scheduler: scheduler("pass", passCalls),
      model,
      userId: "user-a",
      repository,
      now: new Date("2026-07-10T00:00:00.000Z"),
      reasoning: "Medium",
      fastMode: false,
    });
    assert.equal(passed.status, "passed");
    assert.equal(passed.cases.length, 4);
    assert.equal(passCalls.length, 4);
    assert.equal(
      passCalls.every((item) => item.temperature === 0),
      true,
    );
    assert.equal(
      passCalls.every((item) => item.modelId === model.id),
      true,
    );
    assert.equal(
      passed.cases.every((item) => item.status === "passed"),
      true,
    );
    assert.equal(passed.providerModel, model.model);
    assert.equal(
      repository.verifyModelBenchmarkIntegrity("user-a", model.id),
      true,
    );
    assert.equal(
      modelBenchmarkAcceptance({
        model,
        benchmark: passed,
        integrity: true,
        now: new Date("2026-07-11T00:00:00.000Z"),
        reasoning: "Medium",
        fastMode: false,
      }).accepted,
      true,
    );
    assert.equal(
      modelBenchmarkAcceptance({
        model: { ...model, modelRevision: `sha256:${"e".repeat(64)}` },
        benchmark: passed,
        integrity: true,
        reasoning: "Medium",
        fastMode: false,
      }).code,
      "benchmark_stale",
    );
    assert.equal(
      modelBenchmarkAcceptance({
        model,
        benchmark: { ...passed, caseSetHash: "sha256:changed" },
        integrity: true,
        reasoning: "Medium",
        fastMode: false,
      }).code,
      "benchmark_stale",
    );
    assert.equal(
      modelBenchmarkAcceptance({
        model,
        benchmark: { ...passed, protocolVersion: "obsolete" },
        integrity: true,
        reasoning: "Medium",
        fastMode: false,
      }).code,
      "benchmark_stale",
    );
    assert.equal(
      modelBenchmarkAcceptance({
        model,
        benchmark: passed,
        integrity: true,
        now: new Date("2026-08-10T00:00:00.000Z"),
        reasoning: "Medium",
        fastMode: false,
      }).code,
      "benchmark_expired",
    );

    for (const [mode, caseId, failureCode, failureMarker] of [
      [
        "extra-finding",
        "single_exact_quote",
        "SEMANTIC_GRADE_FAILED",
        "finding_count:2",
      ],
      [
        "conflict-missing-source",
        "conflicting_sources",
        "SEMANTIC_GRADE_FAILED",
        "required_source:bank-v1",
      ],
      [
        "unexpected-uncertainty",
        "single_exact_quote",
        "SEMANTIC_GRADE_FAILED",
        "uncertainty:unexpected",
      ],
      [
        "unexpected-question",
        "single_exact_quote",
        "SEMANTIC_GRADE_FAILED",
        "question:unexpected",
      ],
      [
        "provider-mismatch",
        "single_exact_quote",
        "PROVIDER_MODEL_MISMATCH",
        null,
      ],
    ] as const) {
      const rejected = await benchmarkLocalModel({
        scheduler: scheduler(mode, []),
        model,
        userId: `negative-${mode}`,
        repository,
        now: new Date("2026-07-10T00:00:00.000Z"),
        reasoning: "Medium",
        fastMode: false,
      });
      const failedCase = rejected.cases.find((item) => item.caseId === caseId);
      assert.equal(rejected.status, "failed");
      assert.equal(failedCase?.failureCode, failureCode);
      if (failureMarker)
        assert.match(
          failedCase?.failureDetail ?? "",
          new RegExp(failureMarker),
        );
      if (mode === "provider-mismatch") {
        assert.equal(rejected.providerModel, `${model.model}:unexpected`);
      }
    }

    repository.close();
    repository = new LocalControlRepository({ databasePath });
    assert.equal(
      repository.latestModelBenchmark("user-a", model.id)?.id,
      passed.id,
    );
    assert.equal(
      repository.latestModelBenchmark("user-a", model.id)?.cases.length,
      4,
    );
    assert.equal(repository.latestModelBenchmark("user-b", model.id), null);

    const userBCalls: Array<Record<string, unknown>> = [];
    const userB = await benchmarkLocalModel({
      scheduler: scheduler("pass", userBCalls),
      model,
      userId: "user-b",
      repository,
      now: new Date("2026-07-10T00:00:00.000Z"),
      reasoning: "Medium",
      fastMode: false,
    });
    assert.equal(userB.status, "passed");
    assert.notEqual(
      repository.latestModelBenchmark("user-b", model.id)?.id,
      passed.id,
    );
    assert.equal(
      repository.verifyModelBenchmarkIntegrity("user-b", model.id),
      true,
    );

    const alteredCalls: Array<Record<string, unknown>> = [];
    const quoteAltered = await benchmarkLocalModel({
      scheduler: scheduler("quote-altered", alteredCalls),
      model,
      userId: "user-a",
      repository,
      now: new Date("2026-07-11T00:00:00.000Z"),
      reasoning: "Medium",
      fastMode: false,
    });
    assert.equal(quoteAltered.status, "failed");
    assert.equal(
      quoteAltered.cases[0]?.failureCode,
      "GROUNDING_QUOTE_MISMATCH",
    );
    assert.equal(alteredCalls.length, 4);
    assert.deepEqual(
      localModelBenchmarkCasesForAudit().flatMap((item) =>
        item.sources.map((source) => source.quote),
      ),
      sourceQuotes,
    );

    const errorCalls: Array<Record<string, unknown>> = [];
    const schedulerFailure = await benchmarkLocalModel({
      scheduler: scheduler("error", errorCalls),
      model,
      userId: "user-a",
      repository,
      now: new Date("2026-07-12T00:00:00.000Z"),
      reasoning: "Medium",
      fastMode: false,
    });
    assert.equal(schedulerFailure.status, "failed");
    assert.equal(errorCalls.length, 4);
    assert.equal(
      schedulerFailure.cases.every(
        (item) => item.failureCode === "LOCAL_MODEL_ERROR",
      ),
      true,
    );
    assert.equal(
      repository.latestModelBenchmark("user-a", model.id)?.id,
      schedulerFailure.id,
    );
    assert.equal(
      modelBenchmarkAcceptance({
        model,
        benchmark: repository.latestModelBenchmark("user-a", model.id),
        integrity: true,
        reasoning: "Medium",
        fastMode: false,
      }).code,
      "benchmark_failed",
    );

    repository.close();
    const tamper = new LocalDatabase(databasePath);
    try {
      assert.throws(() =>
        tamper
          .prepare(
            "update aletheia_local_model_benchmark_cases set response_text = 'tampered' where run_id = ? and case_id = ?",
          )
          .run(userB.id, "single_exact_quote"),
      );
      tamper.exec(
        "drop trigger aletheia_local_model_benchmark_cases_immutable_update;",
      );
      tamper
        .prepare(
          "update aletheia_local_model_benchmark_cases set response_text = 'tampered' where run_id = ? and case_id = ?",
        )
        .run(userB.id, "single_exact_quote");
      tamper
        .prepare(
          "update aletheia_local_model_benchmark_cases set response_sha256 = 'sha256:tampered' where run_id = ? and case_id = ?",
        )
        .run(userB.id, "single_exact_quote");
    } finally {
      tamper.close();
    }
    repository = new LocalControlRepository({ databasePath });
    assert.equal(
      repository.verifyModelBenchmarkIntegrity("user-b", model.id),
      false,
    );
    assert.equal(
      modelBenchmarkAcceptance({
        model,
        benchmark: repository.latestModelBenchmark("user-b", model.id),
        integrity: false,
        reasoning: "Medium",
        fastMode: false,
      }).code,
      "benchmark_integrity_failed",
    );
    console.log(
      JSON.stringify(
        {
          ok: true,
          suite: "aletheia-local-litigation-model-benchmark-v1",
          checks: {
            realGenerateCalls: true,
            allFourSemanticGraders: true,
            persistenceReopen: true,
            latestFailureAuthority: true,
            fingerprintCaseSetProtocolAndExpiry: true,
            userIsolation: true,
            immutableEventChain: true,
            responseAndHashTamperDetection: true,
            sourceQuotePreservation: true,
            singleFindingAndFindingScopedCitations: true,
            unexpectedUncertaintyAndQuestionsRejected: true,
            providerModelBindingRejectedOnMismatch: true,
          },
        },
        null,
        2,
      ),
    );
  } finally {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

void main();
