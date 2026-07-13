import { Router } from "express";
import { localModelScheduler } from "../lib/aletheia/localModelRuntime";
import { LocalModelSchedulerError } from "../lib/aletheia/localModelScheduler";
import { requireAuth } from "../middleware/auth";
import { LocalControlRepository } from "../lib/aletheia/localControlRepository";
import {
  calibrateLocalModel,
  modelCalibrationAcceptance,
} from "../lib/aletheia/localModelCalibration";
import {
  benchmarkLocalModel,
  modelBenchmarkAcceptance,
} from "../lib/aletheia/localModelBenchmark";

export const localModelsRouter = Router();

function modelId(value: unknown) {
  return typeof value === "string" &&
    /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value)
    ? value
    : null;
}

function handleError(
  res: { status: (code: number) => { json: (body: unknown) => void } },
  error: unknown,
) {
  if (error instanceof LocalModelSchedulerError) {
    const status = error.code === "MODEL_NOT_FOUND" ? 404 : 409;
    return void res
      .status(status)
      .json({ code: error.code, detail: error.message });
  }
  const detail = error instanceof Error ? error.message : String(error);
  res.status(500).json({ detail });
}

let calibrationRepositorySingleton: LocalControlRepository | null = null;

function calibrationRepository() {
  calibrationRepositorySingleton ??= new LocalControlRepository();
  return calibrationRepositorySingleton;
}

localModelsRouter.get("/local-models", requireAuth, (_req, res) => {
  try {
    const userId = String(res.locals.userId);
    const repository = calibrationRepository();
    const settings = repository.getSettings(userId).settings;
    res.json({
      schemaVersion: "aletheia-local-model-runtime-v1",
      localOnly: true,
      benchmark: { diagnostic: true, productionExecutionGate: false },
      models: localModelScheduler()
        .snapshots()
        .map((model) => {
          const calibration = repository.latestModelCalibration(
            userId,
            model.id,
          );
          const benchmark = repository.latestModelBenchmark(userId, model.id);
          return {
            ...model,
            calibration,
            calibrationAcceptance: modelCalibrationAcceptance({
              model,
              calibration,
              reasoning: settings.reasoning,
              fastMode: settings.fastMode,
            }),
            benchmark,
            benchmarkAcceptance: modelBenchmarkAcceptance({
              model,
              benchmark,
              integrity: repository.verifyModelBenchmarkIntegrity(
                userId,
                model.id,
              ),
              reasoning: settings.reasoning,
              fastMode: settings.fastMode,
            }),
          };
        }),
    });
  } catch (error) {
    handleError(res, error);
  }
});

localModelsRouter.post(
  "/local-models/:modelId/calibrate",
  requireAuth,
  async (req, res) => {
    const id = modelId(req.params.modelId);
    if (!id) return void res.status(400).json({ detail: "modelId is invalid" });
    try {
      const scheduler = localModelScheduler();
      const repository = calibrationRepository();
      const settings = repository.getSettings(
        String(res.locals.userId),
      ).settings;
      await scheduler.healthCheck(id);
      const result = await calibrateLocalModel({
        scheduler,
        model: scheduler.snapshot(id),
        userId: String(res.locals.userId),
        repository,
        reasoning: settings.reasoning,
        fastMode: settings.fastMode,
      });
      res.status(result.status === "passed" ? 200 : 422).json(result);
    } catch (error) {
      handleError(res, error);
    }
  },
);

localModelsRouter.post(
  "/local-models/:modelId/benchmark",
  requireAuth,
  async (req, res) => {
    const id = modelId(req.params.modelId);
    if (!id) return void res.status(400).json({ detail: "modelId is invalid" });
    try {
      const scheduler = localModelScheduler();
      const model = scheduler.snapshot(id);
      if (model.state !== "ready" || !model.modelRevision) {
        return void res.status(409).json({
          code: "MODEL_NOT_READY_OR_IMMUTABLE",
          detail:
            "Benchmarking requires a ready model with an immutable revision.",
        });
      }
      const repository = calibrationRepository();
      const userId = String(res.locals.userId);
      const settings = repository.getSettings(userId).settings;
      const calibration = repository.latestModelCalibration(userId, id);
      const acceptedCalibration = modelCalibrationAcceptance({
        model,
        calibration,
        reasoning: settings.reasoning,
        fastMode: settings.fastMode,
      });
      if (!acceptedCalibration.accepted) {
        return void res.status(428).json({
          code: acceptedCalibration.code,
          detail:
            "Benchmarking requires a current passed calibration for this exact model and settings.",
        });
      }
      const result = await benchmarkLocalModel({
        scheduler,
        model,
        userId,
        repository,
        reasoning: settings.reasoning,
        fastMode: settings.fastMode,
      });
      res.status(result.status === "passed" ? 200 : 422).json({
        ...result,
        diagnostic: true,
        productionExecutionGate: false,
      });
    } catch (error) {
      handleError(res, error);
    }
  },
);

for (const action of ["start", "stop", "health"] as const) {
  localModelsRouter.post(
    `/local-models/:modelId/${action}`,
    requireAuth,
    async (req, res) => {
      const id = modelId(req.params.modelId);
      if (!id)
        return void res.status(400).json({ detail: "modelId is invalid" });
      try {
        const scheduler = localModelScheduler();
        const result =
          action === "start"
            ? await scheduler.startModel(id)
            : action === "stop"
              ? await scheduler.stopModel(id)
              : await scheduler.healthCheck(id);
        res.json(result);
      } catch (error) {
        handleError(res, error);
      }
    },
  );
}
