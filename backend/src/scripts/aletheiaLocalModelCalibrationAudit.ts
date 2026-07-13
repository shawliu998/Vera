import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalControlRepository } from "../lib/aletheia/localControlRepository";
import {
  calibrateLocalModel,
  modelCalibrationAcceptance,
} from "../lib/aletheia/localModelCalibration";
import type { LocalModelStatusSnapshot } from "../lib/aletheia/localModelScheduler";

const quote = "2026年7月10日，甲方向乙方交付了编号为A-17的收据。";
const model: LocalModelStatusSnapshot = {
  id: "audit-model",
  adapter: "ollama",
  endpoint: "http://127.0.0.1:11434/",
  model: "audit-model:fixed",
  modelRevision: `sha256:${"b".repeat(64)}`,
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

function response(exactQuote = quote) {
  return JSON.stringify({
    summary: "收到一份收据。",
    summaryCitations: [
      { sourceId: "calibration-source-v1", quote: exactQuote },
    ],
    findings: [
      {
        statement: "记录载有一次交付。",
        citations: [{ sourceId: "calibration-source-v1", quote: exactQuote }],
        confidence: "high",
        uncertainty: null,
      },
    ],
    questionsForCounsel: [],
  });
}

async function main() {
  const directory = mkdtempSync(
    path.join(os.tmpdir(), "aletheia-model-calibration-"),
  );
  process.env.ALETHEIA_DATA_DIR = directory;
  process.env.ALETHEIA_APPLICATION_ENCRYPTION = "required";
  process.env.ALETHEIA_MASTER_KEY_SOURCE = "env";
  process.env.ALETHEIA_MASTER_KEY_BASE64 = Buffer.alloc(32, 53).toString(
    "base64",
  );
  const repository = new LocalControlRepository({
    databasePath: path.join(directory, "aletheia.db"),
  });
  try {
    const scheduler = {
      healthCheck: async () => model,
      generate: async () => ({
        text: response(),
        modelId: model.id,
        providerModel: model.model,
        estimatedInputTokens: 100,
        outputTokens: 80,
        totalTokens: 180,
        durationMs: 10,
      }),
    };
    assert.equal(
      modelCalibrationAcceptance({ model, calibration: null }).code,
      "calibration_required",
    );
    assert.equal(
      modelCalibrationAcceptance({
        model: { ...model, modelRevision: undefined },
        calibration: null,
      }).code,
      "model_revision_unavailable",
    );
    const passed = await calibrateLocalModel({
      scheduler,
      model,
      userId: "user-a",
      repository,
      now: new Date("2026-07-10T00:00:00.000Z"),
      reasoning: "Medium",
      fastMode: false,
    });
    assert.equal(passed.status, "passed");
    assert.equal(
      repository.latestModelCalibration("user-a", model.id)?.id,
      passed.id,
    );
    assert.equal(repository.latestModelCalibration("user-b", model.id), null);
    assert.equal(
      modelCalibrationAcceptance({
        model,
        calibration: passed,
        now: new Date("2026-07-11T00:00:00.000Z"),
        reasoning: "Medium",
        fastMode: false,
      }).accepted,
      true,
    );
    assert.equal(
      modelCalibrationAcceptance({
        model,
        calibration: passed,
        now: new Date("2026-07-11T00:00:00.000Z"),
        reasoning: "High",
        fastMode: false,
      }).code,
      "calibration_stale",
    );
    assert.equal(
      modelCalibrationAcceptance({
        model: { ...model, model: "audit-model:replaced" },
        calibration: passed,
        now: new Date("2026-07-11T00:00:00.000Z"),
        reasoning: "Medium",
        fastMode: false,
      }).code,
      "calibration_stale",
    );

    const failed = await calibrateLocalModel({
      scheduler: {
        healthCheck: async () => model,
        generate: async () => ({
          ...(await scheduler.generate()),
          text: response(`${quote}（已修改）`),
        }),
      },
      model,
      userId: "user-a",
      repository,
      now: new Date("2026-07-12T00:00:00.000Z"),
      reasoning: "Medium",
      fastMode: false,
    });
    assert.equal(failed.status, "failed");
    assert.equal(
      repository.latestModelCalibration("user-a", model.id)?.id,
      failed.id,
    );
    assert.equal(
      modelCalibrationAcceptance({
        model,
        calibration: repository.latestModelCalibration("user-a", model.id),
        now: new Date("2026-07-12T01:00:00.000Z"),
        reasoning: "Medium",
        fastMode: false,
      }).code,
      "calibration_failed",
    );
    assert.equal(failed.failureCode, "GROUNDING_QUOTE_MISMATCH");
    assert.equal(failed.outputSha256?.startsWith("sha256:"), true);
    console.log(
      JSON.stringify(
        {
          ok: true,
          suite: "aletheia-local-model-calibration-v1",
          checks: {
            realGenerationProbePath: true,
            exactQuoteFailurePersisted: true,
            latestFailureOverridesPriorPass: true,
            userIsolation: true,
            settingsAndModelChangesInvalidate: true,
            immutableRevisionRequired: true,
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
