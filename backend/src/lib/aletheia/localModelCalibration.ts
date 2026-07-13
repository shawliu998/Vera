import { createHash, randomUUID } from "node:crypto";
import type {
  LocalModelScheduler,
  LocalModelStatusSnapshot,
} from "./localModelScheduler";
import { parseGroundedLitigationOutput } from "./litigationGrounding";

export const LOCAL_MODEL_CALIBRATION_PROTOCOL =
  "aletheia-litigation-model-calibration-v1";
export const LOCAL_MODEL_CALIBRATION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;

const SOURCE_ID = "calibration-source-v1";
const EXACT_QUOTE = "2026年7月10日，甲方向乙方交付了编号为A-17的收据。";

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function localModelCalibrationFingerprint(
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
  execution: { reasoning: string; fastMode: boolean } = {
    reasoning: "Off",
    fastMode: false,
  },
) {
  return `sha256:${sha256(
    JSON.stringify({
      protocol: LOCAL_MODEL_CALIBRATION_PROTOCOL,
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
  )}`;
}

export type LocalModelCalibrationAttempt = {
  id: string;
  userId: string;
  modelId: string;
  modelFingerprint: string;
  adapter: string;
  providerModel: string;
  status: "passed" | "failed";
  protocolVersion: string;
  testedAt: string;
  expiresAt: string;
  durationMs: number;
  outputSha256: string | null;
  failureCode: string | null;
  failureDetail: string | null;
};

export type CalibrationAttemptWriter = {
  recordModelCalibration(input: LocalModelCalibrationAttempt): unknown;
};

export async function calibrateLocalModel(args: {
  scheduler: Pick<LocalModelScheduler, "generate" | "healthCheck">;
  model: LocalModelStatusSnapshot;
  userId: string;
  repository: CalibrationAttemptWriter;
  now?: Date;
  reasoning?: "Off" | "Low" | "Medium" | "High";
  fastMode?: boolean;
}) {
  const testedAt = args.now ?? new Date();
  const startedAt = Date.now();
  const base = {
    id: randomUUID(),
    userId: args.userId,
    modelId: args.model.id,
    modelFingerprint: localModelCalibrationFingerprint(args.model, {
      reasoning: args.reasoning ?? "Off",
      fastMode: args.fastMode ?? false,
    }),
    adapter: args.model.adapter,
    protocolVersion: LOCAL_MODEL_CALIBRATION_PROTOCOL,
    testedAt: testedAt.toISOString(),
    expiresAt: new Date(
      testedAt.getTime() + LOCAL_MODEL_CALIBRATION_MAX_AGE_MS,
    ).toISOString(),
  };
  let providerModel = args.model.model;
  let outputSha256: string | null = null;
  try {
    await args.scheduler.healthCheck(args.model.id);
    if (!args.model.modelRevision) {
      const error = new Error(
        "The local model runtime did not expose an immutable model revision.",
      ) as Error & { code: string };
      error.code = "MODEL_REVISION_UNAVAILABLE";
      throw error;
    }
    const result = await args.scheduler.generate({
      modelId: args.model.id,
      temperature: 0,
      maxOutputTokens: Math.min(args.model.maxOutputTokens, 768),
      timeoutMs: 60_000,
      reasoningEffort: (args.reasoning ?? "Off").toLowerCase() as
        | "off"
        | "low"
        | "medium"
        | "high",
      fastMode: args.fastMode ?? false,
      systemPrompt:
        "You are being tested for a fail-closed legal evidence protocol. Return JSON only and follow the requested schema exactly.",
      prompt: [
        `Source ${SOURCE_ID}: ${EXACT_QUOTE}`,
        "Return exactly one evidence-bound summary and one finding.",
        'Schema: {"summary":"...","summaryCitations":[{"sourceId":"calibration-source-v1","quote":"complete exact source quote"}],"findings":[{"statement":"...","citations":[{"sourceId":"calibration-source-v1","quote":"complete exact source quote"}],"confidence":"high|medium|low","uncertainty":null}],"questionsForCounsel":[]}',
        "Do not alter, shorten, translate, or normalize the quoted source text.",
      ].join("\n"),
    });
    providerModel = result.providerModel;
    outputSha256 = `sha256:${sha256(result.text)}`;
    parseGroundedLitigationOutput({
      response: result.text,
      allowedSources: [{ id: SOURCE_ID, quoteSha256: sha256(EXACT_QUOTE) }],
    });
    const attempt: LocalModelCalibrationAttempt = {
      ...base,
      providerModel,
      status: "passed",
      durationMs: Math.max(0, Date.now() - startedAt),
      outputSha256,
      failureCode: null,
      failureDetail: null,
    };
    args.repository.recordModelCalibration(attempt);
    return attempt;
  } catch (error) {
    const failureCode =
      error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code ?? "CALIBRATION_FAILED")
        : "CALIBRATION_FAILED";
    const attempt: LocalModelCalibrationAttempt = {
      ...base,
      providerModel,
      status: "failed",
      durationMs: Math.max(0, Date.now() - startedAt),
      outputSha256,
      failureCode: failureCode.slice(0, 120),
      failureDetail: (error instanceof Error
        ? error.message
        : String(error)
      ).slice(0, 1_000),
    };
    args.repository.recordModelCalibration(attempt);
    return attempt;
  }
}

export function modelCalibrationAcceptance(args: {
  model: LocalModelStatusSnapshot;
  calibration: LocalModelCalibrationAttempt | null;
  now?: Date;
  reasoning?: "Off" | "Low" | "Medium" | "High";
  fastMode?: boolean;
}) {
  const calibration = args.calibration;
  if (!args.model.modelRevision) {
    return {
      accepted: false as const,
      code: "model_revision_unavailable",
    };
  }
  if (!calibration) {
    return { accepted: false as const, code: "calibration_required" };
  }
  if (calibration.status !== "passed") {
    return { accepted: false as const, code: "calibration_failed" };
  }
  if (
    calibration.modelFingerprint !==
    localModelCalibrationFingerprint(args.model, {
      reasoning: args.reasoning ?? "Off",
      fastMode: args.fastMode ?? false,
    })
  ) {
    return { accepted: false as const, code: "calibration_stale" };
  }
  const expiresAt = Date.parse(calibration.expiresAt);
  if (
    !Number.isFinite(expiresAt) ||
    expiresAt <= (args.now ?? new Date()).getTime()
  ) {
    return { accepted: false as const, code: "calibration_expired" };
  }
  return { accepted: true as const, code: "calibrated" };
}
