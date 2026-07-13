import { DurableAgentQueue, DurableAgentWorker } from "./durableAgentExecutor";
import { DurableLocalModelStepExecutor } from "./durableLocalModelStepExecutor";
import { LITIGATION_GROUNDED_HANDLER } from "./litigationGrounding";
import type { LocalModelScheduler } from "./localModelScheduler";
import { localModelScheduler } from "./localModelRuntime";
import { LocalAletheiaRepository } from "./localRepository";
import {
  getAuthoritativeRuntimeSettings,
  resolveAuthoritativeModelRouting,
} from "./localControlRepository";
import { shouldFailClosedForAuditAnchor } from "./auditAnchorJournal";
import type { ContextDigest } from "./contextCompression";
import { getAuthoritativeModelCalibration } from "./localControlRepository";
import { modelCalibrationAcceptance } from "./localModelCalibration";

type MatterMemoryItem = {
  category?: string;
  title?: string;
  body?: string;
};

type ConfiguredDurableRuntime = {
  queue: DurableAgentQueue;
  worker: DurableAgentWorker;
  scheduler: LocalModelScheduler;
  modelId: string;
  ready: boolean;
  startupError: string | null;
  close: () => Promise<void>;
};

let runtime: ConfiguredDurableRuntime | null = null;
let disabledReason = "local model is not configured";

export function buildMatterMemorySystemContext(items: MatterMemoryItem[]) {
  const entries = items
    .slice(0, 20)
    .map((item) => {
      const title = String(item.title ?? "")
        .trim()
        .slice(0, 240);
      const body = String(item.body ?? "")
        .trim()
        .slice(0, 2_000);
      if (!title && !body) return "";
      return `- [${String(item.category ?? "memory").slice(0, 80)}] ${title}: ${body}`;
    })
    .filter(Boolean);
  return entries.length
    ? `Matter-scoped memory. Treat these as context, not independently verified facts:\n${entries.join("\n")}`
    : "";
}

function envInteger(name: string, fallback: number) {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function selectDurableTaskModel(
  settings: Parameters<typeof resolveAuthoritativeModelRouting>[0],
  fallbackModelId: string,
  context: { workflow: string; handler: string },
) {
  const routing = resolveAuthoritativeModelRouting(settings, fallbackModelId);
  const litigationWork =
    context.handler === LITIGATION_GROUNDED_HANDLER ||
    context.workflow.includes("litigation");
  return litigationWork
    ? {
        role: "litigation_analysis" as const,
        modelId: routing.litigationModelId,
      }
    : { role: "routine_analysis" as const, modelId: routing.routineModelId };
}

/**
 * Starts the single-process durable worker only when the operator explicitly
 * names a local model. No cloud endpoint or client-provided process definition
 * is accepted by this bootstrap path.
 */
export function configureDurableAgentRuntimeFromEnvironment() {
  if (runtime) return runtime;
  const scheduler = localModelScheduler();
  const snapshots = scheduler.snapshots();
  if (snapshots.length === 0) {
    disabledReason = "No local model is configured";
    return null;
  }
  const modelId =
    process.env.ALETHEIA_LOCAL_MODEL_ID?.trim() || snapshots[0].id;
  if (!snapshots.some((item) => item.id === modelId)) {
    throw new Error(`Configured durable model '${modelId}' is not registered`);
  }
  // Initialize/migrate the shared local schema before the queue adds its
  // executor-specific columns. The repository keeps the process-local handle.
  const repository = new LocalAletheiaRepository();
  const queue = new DurableAgentQueue();
  const executor = new DurableLocalModelStepExecutor(
    scheduler,
    async (context) => {
      const settings = getAuthoritativeRuntimeSettings(context.userId);
      const taskModel = selectDurableTaskModel(settings, modelId, context);
      const authoritativeModel = taskModel.modelId;
      if (!snapshots.some((item) => item.id === authoritativeModel)) {
        throw new Error(
          `Authoritative local model '${authoritativeModel}' is not registered`,
        );
      }
      if (context.modelProfile && context.modelProfile !== authoritativeModel) {
        throw new Error(
          `Durable run requested an unapproved model profile: ${context.modelProfile}`,
        );
      }
      await scheduler.startModel(authoritativeModel);
      const selected = scheduler.snapshot(authoritativeModel);
      if (selected.state !== "ready") {
        throw new Error(
          `Routed local model '${authoritativeModel}' is not ready`,
        );
      }
      if (context.workflow === "aletheia-civil-litigation-harness-v1") {
        const calibration = modelCalibrationAcceptance({
          model: selected,
          calibration: getAuthoritativeModelCalibration(
            context.userId,
            authoritativeModel,
          ),
          reasoning: settings.reasoning,
          fastMode: settings.fastMode,
        });
        if (!calibration.accepted) {
          throw new Error(
            `Litigation model calibration is no longer valid: ${calibration.code}`,
          );
        }
        if (
          context.input.retrievalInputBinding !== null &&
          context.input.retrievalInputBinding !== undefined
        ) {
          const binding =
            context.input.retrievalInputBinding &&
            typeof context.input.retrievalInputBinding === "object" &&
            !Array.isArray(context.input.retrievalInputBinding)
              ? (context.input.retrievalInputBinding as Record<string, unknown>)
              : {};
          const manifestId = String(binding.manifestId ?? "");
          const bindingHash = String(binding.bindingHash ?? "");
          if (!manifestId || !/^sha256:[a-f0-9]{64}$/.test(bindingHash)) {
            throw new Error(
              "Litigation retrieval input binding is malformed; execution stopped.",
            );
          }
          const currentBinding =
            (await repository.prepareLitigationReviewedExcerptInput(
              { userId: context.userId },
              context.matterId,
              manifestId,
            )) as Record<string, unknown> | null;
          if (!currentBinding || currentBinding.bindingHash !== bindingHash) {
            throw new Error(
              "Counsel-reviewed retrieval input changed after enqueue; execution stopped.",
            );
          }
        }
      }
      const detail = await repository.getMatterDetail(
        { userId: context.userId },
        context.matterId,
      );
      if (!detail) {
        throw new Error("Durable run matter is unavailable to this local user");
      }
      const compressionModelId =
        settings.compressionModelId ?? authoritativeModel;
      const compressionModel = scheduler.snapshot(compressionModelId);
      const contextBudgetTokens = Math.min(
        settings.contextBudgetTokens ?? selected.contextWindowTokens,
        selected.contextWindowTokens,
      );
      const compressionPolicy =
        settings.contextCompression === "Off"
          ? { mode: "Off" as const }
          : settings.contextCompression === "Manual"
            ? { mode: "Manual" as const }
            : (() => {
                if (
                  compressionModel.state !== "ready" ||
                  compressionModel.contextWindowTokens <
                    selected.contextWindowTokens
                ) {
                  throw new Error(
                    "Automatic context compression requires a healthy local model with a context window at least as large as the main model.",
                  );
                }
                return {
                  mode: "Auto" as const,
                  modelId: compressionModel.id,
                  modelVersion: compressionModel.model,
                  modelContextWindowTokens:
                    compressionModel.contextWindowTokens,
                  persistDigest: async (digest: ContextDigest) => {
                    const workProduct = await repository.createWorkProduct(
                      { userId: context.userId },
                      context.matterId,
                      {
                        kind: "context_digest",
                        title: `ContextDigest ${digest.digestId}`,
                        status: "active",
                        schemaVersion: digest.schemaVersion,
                        content: digest,
                        validationErrors: [],
                        generatedBy: "agent",
                        model: digest.model.id,
                      },
                    );
                    if (!workProduct)
                      throw new Error(
                        "Matter is unavailable for ContextDigest persistence.",
                      );
                    await repository.appendAuditEvent(
                      { userId: context.userId },
                      context.matterId,
                      {
                        actor: "agent",
                        action: "context_digest_created",
                        workflowVersion: digest.schemaVersion,
                        model: digest.model.id,
                        details: {
                          workProductId: workProduct.id,
                          digestId: digest.digestId,
                          originRun: digest.originRun,
                          priorDigestLink: digest.priorDigestLink,
                          sourceHashes: digest.sources.map(
                            (source) => source.sourceHash,
                          ),
                          evidenceIds: digest.sources.flatMap(
                            (source) => source.evidenceIds,
                          ),
                        },
                      },
                    );
                    return { id: workProduct.id };
                  },
                };
              })();
      return {
        modelId: authoritativeModel,
        contextBudgetTokens,
        maxOutputTokens: selected.maxOutputTokens,
        reasoning: settings.reasoning,
        fastMode: settings.fastMode,
        matterMemoryContext: buildMatterMemorySystemContext(
          detail.matterMemory ?? [],
        ),
        contextCompression: compressionPolicy,
      };
    },
  );
  const worker = new DurableAgentWorker(queue, executor, {
    workerId: `local-model-${modelId}`,
    pollIntervalMs: envInteger("ALETHEIA_DURABLE_WORKER_POLL_MS", 500),
    heartbeatIntervalMs: envInteger(
      "ALETHEIA_DURABLE_WORKER_HEARTBEAT_MS",
      1_000,
    ),
    canProcess: () => !shouldFailClosedForAuditAnchor(),
  });
  runtime = {
    queue,
    worker,
    scheduler,
    modelId,
    ready: false,
    startupError: null,
    async close() {
      worker.stop();
      await worker.waitForIdle();
      queue.close();
      runtime = null;
    },
  };
  void scheduler
    .startModel(modelId)
    .then(() => {
      if (!runtime) return;
      runtime.ready = true;
      runtime.startupError = null;
      disabledReason = "";
      worker.start();
    })
    .catch((error) => {
      if (!runtime) return;
      runtime.ready = false;
      runtime.startupError =
        error instanceof Error ? error.message : String(error);
      disabledReason = `Local model startup failed: ${runtime.startupError}`;
    });
  disabledReason = "";
  return runtime;
}

export function durableAgentRuntimeStatus() {
  return runtime
    ? {
        enabled: runtime.ready,
        starting: !runtime.ready && !runtime.startupError,
        error: runtime.startupError,
        modelId: runtime.modelId,
        scheduler: runtime.scheduler.snapshot(runtime.modelId),
      }
    : { enabled: false, reason: disabledReason };
}

export function configuredDurableAgentRuntime() {
  return runtime;
}

export function durableAgentRuntimeAcceptingRuns() {
  return runtime?.ready === true;
}
