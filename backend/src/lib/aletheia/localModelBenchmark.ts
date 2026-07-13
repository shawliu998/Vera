import { createHash, randomUUID } from "node:crypto";
import type {
  LocalModelScheduler,
  LocalModelStatusSnapshot,
} from "./localModelScheduler";
import { parseGroundedLitigationOutput } from "./litigationGrounding";

export const LOCAL_MODEL_BENCHMARK_PROTOCOL =
  "aletheia-local-litigation-model-benchmark-v1";
export const LOCAL_MODEL_BENCHMARK_GRADER_VERSION =
  "aletheia-local-litigation-semantic-grader-v1";
export const LOCAL_MODEL_BENCHMARK_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;

type BenchmarkSource = { id: string; quote: string };
type BenchmarkCase = {
  id: string;
  prompt: string;
  sources: readonly BenchmarkSource[];
  requiredSourceIds: readonly string[];
  forbiddenSourceIds: readonly string[];
  requiredMarkers: readonly string[];
  forbiddenMarkers: readonly string[];
  confidence: "high" | "medium" | "low" | null;
  uncertainty: { required: boolean; markers: readonly string[] };
  question: { required: boolean; markers: readonly string[] };
};

// Fixed synthetic records only. This suite must never incorporate matter content.
const BENCHMARK_CASES: readonly BenchmarkCase[] = Object.freeze([
  {
    id: "single_exact_quote",
    prompt: "请判断收据能够证明的事实。",
    sources: [
      {
        id: "receipt-v1",
        quote: "2026年3月2日，甲方向乙方支付货款人民币5000元，乙方出具收据。",
      },
    ],
    requiredSourceIds: ["receipt-v1"],
    forbiddenSourceIds: [],
    requiredMarkers: ["5000元", "收据"],
    forbiddenMarkers: ["未支付"],
    confidence: "high",
    uncertainty: { required: false, markers: [] },
    question: { required: false, markers: [] },
  },
  {
    id: "conflicting_sources",
    prompt: "请判断尾款是否已经支付，并处理证据冲突。",
    sources: [
      {
        id: "ledger-v1",
        quote: "乙方台账记载：2026年4月8日收到甲方尾款人民币20000元。",
      },
      {
        id: "bank-v1",
        quote:
          "银行流水显示：2026年4月8日甲方账户未向乙方账户发生人民币20000元转账。",
      },
    ],
    requiredSourceIds: ["ledger-v1", "bank-v1"],
    forbiddenSourceIds: [],
    requiredMarkers: ["存在矛盾", "无法确定"],
    forbiddenMarkers: ["已经确定支付"],
    confidence: "low",
    uncertainty: { required: true, markers: ["矛盾", "核实"] },
    question: { required: true, markers: ["银行", "付款"] },
  },
  {
    id: "insufficient_evidence_abstention",
    prompt: "请判断设备是否完成交付；证据不足时必须明确保留并提出问题。",
    sources: [
      {
        id: "contract-v1",
        quote:
          "《设备采购合同》第五条仅约定乙方应交付设备，未载明实际交付日期或验收记录。",
      },
    ],
    requiredSourceIds: ["contract-v1"],
    forbiddenSourceIds: [],
    requiredMarkers: ["无法确定", "未载明"],
    forbiddenMarkers: ["已经交付", "完成验收"],
    confidence: "low",
    uncertainty: { required: true, markers: ["证据不足", "无法确定"] },
    question: { required: true, markers: ["验收", "交付"] },
  },
  {
    id: "relevant_source_selection",
    prompt: "请判断乙方是否同意将付款期限延长至6月30日，并只使用相关来源。",
    sources: [
      {
        id: "wechat-v1",
        quote:
          "2026年5月28日乙方微信回复：同意将本案付款期限延长至2026年6月30日。",
      },
      {
        id: "distractor-v1",
        quote: "丙公司2025年度借款纠纷与本案付款期限无关。",
      },
    ],
    requiredSourceIds: ["wechat-v1"],
    forbiddenSourceIds: ["distractor-v1"],
    requiredMarkers: ["同意", "6月30日"],
    forbiddenMarkers: ["丙公司"],
    confidence: "high",
    uncertainty: { required: false, markers: [] },
    question: { required: false, markers: [] },
  },
]);

export type LocalModelBenchmarkCaseResult = {
  caseId: string;
  status: "passed" | "failed";
  score: number;
  durationMs: number;
  responseSha256: string | null;
  responseText: string | null;
  failureCode: string | null;
  failureDetail: string | null;
  resultHash: string;
};

export type LocalModelBenchmarkAttempt = {
  id: string;
  userId: string;
  modelId: string;
  modelFingerprint: string;
  modelRevision: string;
  adapter: string;
  providerModel: string;
  reasoning: "Off" | "Low" | "Medium" | "High";
  fastMode: boolean;
  protocolVersion: string;
  caseSetHash: string;
  graderVersion: string;
  status: "passed" | "failed";
  score: number;
  testedAt: string;
  expiresAt: string;
  durationMs: number;
  responseHashesSha256: string;
  failureCode: string | null;
  failureDetail: string | null;
  resultHash: string;
  cases: LocalModelBenchmarkCaseResult[];
};

export type BenchmarkAttemptWriter = {
  recordModelBenchmark(input: LocalModelBenchmarkAttempt): unknown;
};

function sha256(value: string) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

export function localModelBenchmarkCaseSetHash() {
  return sha256(
    stableJson(
      BENCHMARK_CASES.map((item) => ({
        ...item,
        sources: item.sources.map((source) => ({
          id: source.id,
          quoteSha256: sha256(source.quote),
        })),
      })),
    ),
  );
}

export function localModelBenchmarkFingerprint(
  model: Pick<
    LocalModelStatusSnapshot,
    | "id"
    | "adapter"
    | "endpoint"
    | "model"
    | "modelRevision"
    | "contextWindowTokens"
    | "maxOutputTokens"
  >,
  execution: { reasoning: string; fastMode: boolean },
) {
  return sha256(
    stableJson({
      protocol: LOCAL_MODEL_BENCHMARK_PROTOCOL,
      caseSetHash: localModelBenchmarkCaseSetHash(),
      id: model.id,
      adapter: model.adapter,
      endpoint: model.endpoint,
      model: model.model,
      modelRevision: model.modelRevision ?? null,
      contextWindowTokens: model.contextWindowTokens,
      maxOutputTokens: model.maxOutputTokens,
      reasoning: execution.reasoning,
      fastMode: execution.fastMode,
    }),
  );
}

export function modelBenchmarkCaseResultHash(
  item: Omit<LocalModelBenchmarkCaseResult, "resultHash">,
) {
  return sha256(stableJson(item));
}

export function modelBenchmarkResultHash(
  input: Omit<LocalModelBenchmarkAttempt, "resultHash" | "cases"> & {
    cases: Array<Pick<LocalModelBenchmarkCaseResult, "caseId" | "resultHash">>;
  },
) {
  return sha256(stableJson(input));
}

export function modelBenchmarkEventHash(input: {
  userId: string;
  runId: string;
  eventType: string;
  occurredAt: string;
  priorHash: string | null;
  payloadSha256: string;
}) {
  return sha256(stableJson(input));
}

function outputText(output: {
  summary: string;
  findings: Array<{
    statement: string;
    confidence: string;
    uncertainty: string | null;
  }>;
  questionsForCounsel: string[];
}) {
  return [
    output.summary,
    ...output.findings.flatMap((finding) => [
      finding.statement,
      finding.confidence,
      finding.uncertainty ?? "",
    ]),
    ...output.questionsForCounsel,
  ].join("\n");
}

function grade(caseDefinition: BenchmarkCase, response: string) {
  const parsed = parseGroundedLitigationOutput({
    response,
    allowedSources: caseDefinition.sources.map((source) => ({
      id: source.id,
      quoteSha256: sha256(source.quote).slice("sha256:".length),
    })),
  });
  const finding = parsed.findings[0];
  const text = outputText(parsed);
  const uncertainty = finding?.uncertainty ?? null;
  const questions = parsed.questionsForCounsel.join("\n");
  const failures: string[] = [];
  if (parsed.findings.length !== 1 || !finding) {
    failures.push(`finding_count:${parsed.findings.length}`);
    return { passed: false, detail: failures.join(", ") };
  }
  const cited = new Set(finding.citations.map((citation) => citation.sourceId));
  for (const sourceId of caseDefinition.requiredSourceIds) {
    if (!cited.has(sourceId)) failures.push(`required_source:${sourceId}`);
  }
  for (const sourceId of caseDefinition.forbiddenSourceIds) {
    if (cited.has(sourceId)) failures.push(`forbidden_source:${sourceId}`);
  }
  for (const marker of caseDefinition.requiredMarkers) {
    if (!text.includes(marker)) failures.push(`required_marker:${marker}`);
  }
  for (const marker of caseDefinition.forbiddenMarkers) {
    if (text.includes(marker)) failures.push(`forbidden_marker:${marker}`);
  }
  if (
    caseDefinition.confidence &&
    finding.confidence !== caseDefinition.confidence
  ) {
    failures.push(`confidence:${caseDefinition.confidence}`);
  }
  if (caseDefinition.uncertainty.required) {
    if (!uncertainty?.trim()) failures.push("uncertainty:required");
    for (const marker of caseDefinition.uncertainty.markers) {
      if (!uncertainty?.includes(marker)) {
        failures.push(`uncertainty_marker:${marker}`);
      }
    }
  } else if (uncertainty !== null) {
    failures.push("uncertainty:unexpected");
  }
  if (caseDefinition.question.required) {
    if (!questions.trim()) failures.push("question:required");
    for (const marker of caseDefinition.question.markers) {
      if (!questions.includes(marker)) {
        failures.push(`question_marker:${marker}`);
      }
    }
  } else if (parsed.questionsForCounsel.length !== 0) {
    failures.push("question:unexpected");
  }
  return { passed: failures.length === 0, detail: failures.join(", ") };
}

function promptFor(caseDefinition: BenchmarkCase) {
  const sourceText = caseDefinition.sources
    .map((source) => `来源 ${source.id}: ${source.quote}`)
    .join("\n");
  return [
    sourceText,
    caseDefinition.prompt,
    "仅依据上述固定合成来源作答。引用必须逐字复制来源全文，不能改写、截断或规范化。",
    "返回严格 JSON，且不得输出 JSON 之外的文本。",
    'Schema: {"summary":"...","summaryCitations":[{"sourceId":"...","quote":"完整逐字来源"}],"findings":[{"statement":"...","citations":[{"sourceId":"...","quote":"完整逐字来源"}],"confidence":"high|medium|low","uncertainty":"...或null"}],"questionsForCounsel":["..."]}',
  ].join("\n\n");
}

export async function benchmarkLocalModel(args: {
  scheduler: Pick<LocalModelScheduler, "generate">;
  model: LocalModelStatusSnapshot;
  userId: string;
  repository: BenchmarkAttemptWriter;
  now?: Date;
  reasoning?: "Off" | "Low" | "Medium" | "High";
  fastMode?: boolean;
}) {
  const testedAt = args.now ?? new Date();
  const startedAt = Date.now();
  const reasoning = args.reasoning ?? "Off";
  const fastMode = args.fastMode ?? false;
  const immutableRevision = args.model.modelRevision;
  const base = {
    id: randomUUID(),
    userId: args.userId,
    modelId: args.model.id,
    modelFingerprint: localModelBenchmarkFingerprint(args.model, {
      reasoning,
      fastMode,
    }),
    modelRevision: immutableRevision ?? "",
    adapter: args.model.adapter,
    providerModel: "unavailable",
    reasoning,
    fastMode,
    protocolVersion: LOCAL_MODEL_BENCHMARK_PROTOCOL,
    caseSetHash: localModelBenchmarkCaseSetHash(),
    graderVersion: LOCAL_MODEL_BENCHMARK_GRADER_VERSION,
    testedAt: testedAt.toISOString(),
    expiresAt: new Date(
      testedAt.getTime() + LOCAL_MODEL_BENCHMARK_MAX_AGE_MS,
    ).toISOString(),
  };
  const cases: LocalModelBenchmarkCaseResult[] = [];
  let providerModel = "unavailable";
  for (const caseDefinition of BENCHMARK_CASES) {
    const caseStartedAt = Date.now();
    let responseText: string | null = null;
    try {
      if (!immutableRevision) {
        const error = new Error(
          "The local model runtime did not expose an immutable model revision.",
        ) as Error & { code: string };
        error.code = "MODEL_REVISION_UNAVAILABLE";
        throw error;
      }
      const response = await args.scheduler.generate({
        modelId: args.model.id,
        temperature: 0,
        maxOutputTokens: Math.min(args.model.maxOutputTokens, 1_024),
        timeoutMs: 60_000,
        reasoningEffort: reasoning.toLowerCase() as
          | "off"
          | "low"
          | "medium"
          | "high",
        fastMode,
        systemPrompt:
          "You are being evaluated for a fail-closed Chinese civil-litigation evidence protocol.",
        prompt: promptFor(caseDefinition),
      });
      responseText = response.text;
      if (providerModel === "unavailable")
        providerModel = response.providerModel;
      const semantic = grade(caseDefinition, responseText);
      const providerMatches = response.providerModel === args.model.model;
      const data = {
        caseId: caseDefinition.id,
        status:
          semantic.passed && providerMatches
            ? ("passed" as const)
            : ("failed" as const),
        score: semantic.passed && providerMatches ? 1 : 0,
        durationMs: Math.max(0, Date.now() - caseStartedAt),
        responseSha256: sha256(responseText),
        responseText,
        failureCode: providerMatches
          ? semantic.passed
            ? null
            : "SEMANTIC_GRADE_FAILED"
          : "PROVIDER_MODEL_MISMATCH",
        failureDetail: providerMatches
          ? semantic.passed
            ? null
            : semantic.detail.slice(0, 1_000)
          : `Expected provider model '${args.model.model}', received '${response.providerModel}'.`.slice(
              0,
              1_000,
            ),
      };
      cases.push({ ...data, resultHash: modelBenchmarkCaseResultHash(data) });
    } catch (error) {
      const data = {
        caseId: caseDefinition.id,
        status: "failed" as const,
        score: 0,
        durationMs: Math.max(0, Date.now() - caseStartedAt),
        responseSha256: responseText ? sha256(responseText) : null,
        responseText,
        failureCode: (error && typeof error === "object" && "code" in error
          ? String(
              (error as { code?: unknown }).code ?? "BENCHMARK_CASE_FAILED",
            )
          : "BENCHMARK_CASE_FAILED"
        ).slice(0, 120),
        failureDetail: (error instanceof Error
          ? error.message
          : String(error)
        ).slice(0, 1_000),
      };
      cases.push({ ...data, resultHash: modelBenchmarkCaseResultHash(data) });
    }
  }
  const status: LocalModelBenchmarkAttempt["status"] = cases.every(
    (item) => item.status === "passed",
  )
    ? "passed"
    : "failed";
  const failure = cases.find((item) => item.status === "failed") ?? null;
  const orderedCases = [...cases].sort((left, right) =>
    left.caseId.localeCompare(right.caseId),
  );
  const attemptWithoutHash = {
    ...base,
    providerModel,
    status,
    score:
      cases.reduce((total, item) => total + item.score, 0) /
      BENCHMARK_CASES.length,
    durationMs: Math.max(0, Date.now() - startedAt),
    responseHashesSha256: sha256(
      stableJson(
        orderedCases.map((item) => [item.caseId, item.responseSha256]),
      ),
    ),
    failureCode: failure?.failureCode ?? null,
    failureDetail: failure?.failureDetail ?? null,
  };
  const resultHash = modelBenchmarkResultHash({
    ...attemptWithoutHash,
    cases: orderedCases.map((item) => ({
      caseId: item.caseId,
      resultHash: item.resultHash,
    })),
  });
  const attempt: LocalModelBenchmarkAttempt = {
    ...attemptWithoutHash,
    resultHash,
    cases,
  };
  args.repository.recordModelBenchmark(attempt);
  return attempt;
}

export function modelBenchmarkAcceptance(args: {
  model: LocalModelStatusSnapshot;
  benchmark: LocalModelBenchmarkAttempt | null;
  integrity?: boolean;
  now?: Date;
  reasoning?: "Off" | "Low" | "Medium" | "High";
  fastMode?: boolean;
}) {
  if (!args.model.modelRevision)
    return { accepted: false as const, code: "model_revision_unavailable" };
  if (!args.benchmark)
    return { accepted: false as const, code: "benchmark_required" };
  if (args.integrity === false)
    return { accepted: false as const, code: "benchmark_integrity_failed" };
  if (args.benchmark.status !== "passed")
    return { accepted: false as const, code: "benchmark_failed" };
  if (
    args.benchmark.protocolVersion !== LOCAL_MODEL_BENCHMARK_PROTOCOL ||
    args.benchmark.caseSetHash !== localModelBenchmarkCaseSetHash() ||
    args.benchmark.modelFingerprint !==
      localModelBenchmarkFingerprint(args.model, {
        reasoning: args.reasoning ?? "Off",
        fastMode: args.fastMode ?? false,
      })
  )
    return { accepted: false as const, code: "benchmark_stale" };
  const expiresAt = Date.parse(args.benchmark.expiresAt);
  if (
    !Number.isFinite(expiresAt) ||
    expiresAt <= (args.now ?? new Date()).getTime()
  ) {
    return { accepted: false as const, code: "benchmark_expired" };
  }
  return { accepted: true as const, code: "benchmarked_diagnostic" };
}

export function localModelBenchmarkCasesForAudit() {
  return BENCHMARK_CASES;
}
