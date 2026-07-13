import { createHash } from "node:crypto";
import { Router } from "express";
import {
  DurableAgentQueue,
  type DurableStepDefinition,
} from "../lib/aletheia/durableAgentExecutor";
import { LOCAL_MODEL_GENERATE_HANDLER } from "../lib/aletheia/durableLocalModelStepExecutor";
import { LITIGATION_GROUNDED_HANDLER } from "../lib/aletheia/litigationGrounding";
import {
  LitigationAgentPartitionError,
  planLitigationAgentExecution,
} from "../lib/aletheia/litigationAgentPartition";
import { LitigationValidationError } from "../lib/aletheia/litigationStore";
import {
  configuredDurableAgentRuntime,
  durableAgentRuntimeAcceptingRuns,
  durableAgentRuntimeStatus,
} from "../lib/aletheia/durableAgentRuntime";
import { requireAuth } from "../middleware/auth";
import { createAletheiaRepository } from "../lib/aletheia";
import {
  getAuthoritativeModelCalibration,
  getAuthoritativeRuntimeSettings,
  resolveAuthoritativeModelRouting,
} from "../lib/aletheia/localControlRepository";
import { modelCalibrationAcceptance } from "../lib/aletheia/localModelCalibration";

export const durableAgentRunsRouter = Router();

let localQueue: DurableAgentQueue | null = null;
const GROUNDED_OUTPUT_PROTOCOL =
  'Return JSON only: {"summary":"...","summaryCitations":[{"sourceId":"source-span-id","quote":"exact source quote"}],"findings":[{"statement":"...","citations":[{"sourceId":"source-span-id","quote":"exact source quote"}],"confidence":"high|medium|low","uncertainty":"... or null"}],"questionsForCounsel":["..."]}. Summary and every finding require one or more citations copied exactly from the supplied sources, including the complete exact quote. Do not cite document IDs, fact IDs, claim IDs, modified quotes, or sources outside the supplied input.';

function queue() {
  const configured = configuredDurableAgentRuntime();
  if (configured) return configured.queue;
  const driver =
    process.env.ALETHEIA_STORAGE_DRIVER ??
    process.env.ALET_HEIA_STORAGE_MODE ??
    "local";
  if (driver !== "local") {
    throw new Error(
      "Durable agent execution is available only in local storage mode",
    );
  }
  if (!localQueue) localQueue = new DurableAgentQueue();
  return localQueue;
}

function text(value: unknown, maximum: number) {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function positiveInteger(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function litigationCalibration(userId: string) {
  const runtime = configuredDurableAgentRuntime();
  if (!runtime) {
    return { accepted: false as const, code: "calibration_required" };
  }
  const settings = getAuthoritativeRuntimeSettings(userId);
  const modelId = resolveAuthoritativeModelRouting(
    settings,
    runtime.modelId,
  ).litigationModelId;
  const model = runtime.scheduler.snapshot(modelId);
  const calibration = getAuthoritativeModelCalibration(userId, modelId);
  return {
    ...modelCalibrationAcceptance({
      model,
      calibration,
      reasoning: settings.reasoning,
      fastMode: settings.fastMode,
    }),
    modelId,
    calibration,
  };
}

function acceptedLitigationCalibration(
  userId: string,
  res: Parameters<Parameters<typeof durableAgentRunsRouter.post>[1]>[1],
) {
  const acceptance = litigationCalibration(userId);
  if (
    acceptance.accepted &&
    "modelId" in acceptance &&
    acceptance.calibration
  ) {
    return {
      modelId: acceptance.modelId,
      calibration: acceptance.calibration,
    };
  }
  res.status(412).json({
    code: acceptance.code,
    detail:
      "The selected local model must pass the current exact-quote litigation calibration before this run can start.",
  });
  return null;
}

function steps(value: unknown): DurableStepDefinition[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 200)
    return null;
  const parsed = value.map((item) => {
    const record = object(item);
    return {
      key: text(record.key, 120),
      title: text(record.title, 240),
      handler: text(record.handler, 160),
      input: object(record.input),
      maxAttempts: positiveInteger(record.maxAttempts),
      timeoutMs: positiveInteger(record.timeoutMs),
    };
  });
  if (
    parsed.some(
      (step) =>
        !step.key ||
        !step.title ||
        !/^[a-zA-Z0-9_.:-]+$/.test(step.key) ||
        !/^[a-zA-Z0-9_.:-]+$/.test(step.handler) ||
        step.handler !== LOCAL_MODEL_GENERATE_HANDLER,
    )
  ) {
    return null;
  }
  return parsed;
}

durableAgentRunsRouter.get(
  "/durable-executor/status",
  requireAuth,
  (_req, res) => res.json(durableAgentRuntimeStatus()),
);

function handleError(
  res: Parameters<Parameters<typeof durableAgentRunsRouter.post>[1]>[1],
  error: unknown,
) {
  const message = error instanceof Error ? error.message : String(error);
  res
    .status(error instanceof LitigationValidationError ? 400 : 500)
    .json({ detail: message });
}

durableAgentRunsRouter.post(
  "/matters/:matterId/durable-runs",
  requireAuth,
  (req, res) => {
    const workflow = text(req.body?.workflow, 120);
    const goal = text(req.body?.goal, 4_000);
    const parsedSteps = steps(req.body?.steps);
    if (!workflow || !goal || !parsedSteps) {
      return void res.status(400).json({
        detail:
          "workflow, goal, and 1-200 valid steps with key/title/handler are required",
      });
    }
    if (!durableAgentRuntimeAcceptingRuns()) {
      return void res.status(503).json({
        code: "durable_worker_not_configured",
        detail:
          "A configured local model must pass its health check before durable runs are accepted.",
      });
    }
    try {
      const result = queue().enqueue({
        matterId: req.params.matterId,
        userId: String(res.locals.userId),
        workflow,
        goal,
        modelProfile: text(req.body?.modelProfile, 160) || null,
        metadata: object(req.body?.metadata),
        steps: parsedSteps,
        runTimeoutMs: positiveInteger(req.body?.runTimeoutMs),
        maxRunAttempts: positiveInteger(req.body?.maxRunAttempts),
      });
      if (!result)
        return void res.status(404).json({ detail: "Matter not found" });
      res.status(202).json(result);
    } catch (error) {
      handleError(res, error);
    }
  },
);

durableAgentRunsRouter.post(
  "/matters/:matterId/litigation-durable-runs",
  requireAuth,
  async (req, res) => {
    if (!durableAgentRuntimeAcceptingRuns()) {
      return void res.status(503).json({
        code: "durable_worker_not_configured",
        detail:
          "Configure and health-check a local model before starting litigation analysis.",
      });
    }
    try {
      const userId = String(res.locals.userId);
      const calibrationBinding = acceptedLitigationCalibration(userId, res);
      if (!calibrationBinding) return;
      const routing = resolveAuthoritativeModelRouting(
        getAuthoritativeRuntimeSettings(userId),
        configuredDurableAgentRuntime()!.modelId,
      );
      const focus = text(req.body?.focus, 500);
      const retrievalManifestId = text(req.body?.retrievalManifestId, 128);
      const repository = createAletheiaRepository();
      const baseCompiled = (await repository.prepareLitigationAgentSnapshot(
        { userId },
        req.params.matterId,
      )) as Record<string, unknown> | null;
      if (!baseCompiled)
        return void res.status(404).json({ detail: "Matter not found" });
      const retrievalInputBinding = retrievalManifestId
        ? ((await repository.prepareLitigationReviewedExcerptInput(
            { userId },
            req.params.matterId,
            retrievalManifestId,
          )) as Record<string, any> | null)
        : null;
      if (retrievalManifestId && !retrievalInputBinding) {
        return void res.status(404).json({
          detail: "Reviewed retrieval manifest not found",
        });
      }
      if (
        retrievalInputBinding &&
        focus &&
        focus !== String(retrievalInputBinding.focus)
      ) {
        return void res.status(400).json({
          detail:
            "focus must match the reviewed retrieval manifest when retrievalManifestId is supplied",
        });
      }
      const retrievalManifest =
        !retrievalInputBinding && focus
          ? ((await repository.createLitigationRetrievalManifest(
              { userId },
              req.params.matterId,
              { focus },
            )) as Record<string, unknown> | null)
          : null;
      const reviewedExcerpts = Array.isArray(retrievalInputBinding?.excerpts)
        ? retrievalInputBinding.excerpts
        : [];
      const reviewedSources = reviewedExcerpts.map(
        (excerpt: Record<string, any>) => ({
          id: String(excerpt.sourceId),
          kind: "counsel_confirmed_retrieval_excerpt",
          documentId: String(excerpt.documentId),
          documentName: String(excerpt.documentName),
          chunkId: String(excerpt.chunkId),
          quote: String(excerpt.quote),
          quoteSha256: String(excerpt.quoteSha256),
          review: {
            excerptId: String(excerpt.id),
            manifestId: String(excerpt.manifestId),
            confirmedBy: String(excerpt.confirmedBy),
            confirmedAt: String(excerpt.confirmedAt),
            decisionComment: String(excerpt.decisionComment),
          },
        }),
      );
      const { snapshotHash: _baseSnapshotHash, ...baseSnapshot } = baseCompiled;
      const compiledContent: Record<string, any> = retrievalInputBinding
        ? {
            ...baseSnapshot,
            retrievalInputBinding: {
              schemaVersion: retrievalInputBinding.schemaVersion,
              manifestId: retrievalInputBinding.manifestId,
              manifestHash: retrievalInputBinding.manifestHash,
              bindingHash: retrievalInputBinding.bindingHash,
              indexFingerprint: retrievalInputBinding.indexFingerprint,
              focus: retrievalInputBinding.focus,
              candidateCount: retrievalInputBinding.candidateCount,
              candidateSetComplete: true,
              omissionPolicy: "none",
              inputBinding: true,
            },
            reviewedRetrievalExcerpts: reviewedExcerpts,
            sources: [
              ...(Array.isArray(baseCompiled.sources)
                ? baseCompiled.sources
                : []),
              ...reviewedSources,
            ],
          }
        : baseSnapshot;
      const compiled: Record<string, any> = {
        ...compiledContent,
        snapshotHash: `sha256:${createHash("sha256")
          .update(JSON.stringify(compiledContent))
          .digest("hex")}`,
      };
      const allowedSources = Array.isArray(compiled.sources)
        ? compiled.sources
            .map((item) => {
              const source =
                item && typeof item === "object" && !Array.isArray(item)
                  ? (item as Record<string, unknown>)
                  : {};
              return {
                id: typeof source.id === "string" ? source.id : "",
                quoteSha256:
                  typeof source.quoteSha256 === "string"
                    ? source.quoteSha256
                    : "",
              };
            })
            .filter(
              (source) =>
                source.id.length > 0 &&
                /^[a-f0-9]{64}$/.test(source.quoteSha256),
            )
        : [];
      if (allowedSources.length === 0) {
        return void res.status(422).json({
          code: "litigation_snapshot_has_no_cited_sources",
          detail:
            "No verified source span is available for a grounded litigation run. No run was created.",
        });
      }
      const outputProtocol = GROUNDED_OUTPUT_PROTOCOL;
      const effectiveFocus = String(retrievalInputBinding?.focus ?? focus);
      const executionRetrievalBinding = retrievalInputBinding
        ? {
            manifestId: String(retrievalInputBinding.manifestId),
            bindingHash: String(retrievalInputBinding.bindingHash),
          }
        : null;
      const runtimeStatus = durableAgentRuntimeStatus() as Record<string, any>;
      const contextWindowTokens = Number(
        runtimeStatus.scheduler?.contextWindowTokens ?? 32_768,
      );
      const {
        serializedSnapshot: snapshot,
        snapshotBytes,
        partitioned,
        executionMode,
      } = planLitigationAgentExecution(
        compiled as Record<string, any>,
        contextWindowTokens,
        { focus: effectiveFocus },
      );
      const partitions = partitioned?.partitions ?? [];
      const steps = partitioned
        ? partitions.map((partition, index) => {
            const partitionSources = Array.isArray(partition.content.sources)
              ? partition.content.sources.map(
                  (source: Record<string, any>) => ({
                    id: String(source.id),
                    quoteSha256: String(source.quoteSha256),
                  }),
                )
              : [];
            return {
              key: `analyze_source_partition_${index + 1}`,
              title: `Analyze source partition ${index + 1} of ${partitions.length}`,
              handler: LITIGATION_GROUNDED_HANDLER,
              maxAttempts: 2,
              timeoutMs: 3 * 60_000,
              input: {
                systemPrompt: `You are a Chinese civil litigation analysis assistant. Analyze only this bounded source partition. Do not claim to synthesize the entire matter. ${outputProtocol}`,
                prompt: `Analyze partition ${index + 1} of ${partitions.length}. Identify supported findings, uncertainty, and questions for counsel.\n${JSON.stringify(partition.content)}`,
                temperature: 0,
                snapshotHash: partition.hash,
                allowedSources: partitionSources,
                retrievalInputBinding: executionRetrievalBinding,
              },
            };
          })
        : [
            {
              key: "analyze_confirmed_case_state",
              title: "Analyze confirmed case state",
              handler: LITIGATION_GROUNDED_HANDLER,
              maxAttempts: 2,
              timeoutMs: 3 * 60_000,
              input: {
                systemPrompt: `You are a Chinese civil litigation analysis assistant. Use only the cited records in the server-owned snapshot. Distinguish confirmed facts from gaps, cite record identifiers, disclose exclusions, and never invent law or evidence. ${outputProtocol}`,
                prompt: `Analyze this hash-bound litigation snapshot. Identify claim/defense strengths, missing elements, adverse facts, exclusions, and questions for counsel.\n${snapshot}`,
                temperature: 0,
                snapshotHash: compiled.snapshotHash,
                allowedSources,
                retrievalInputBinding: executionRetrievalBinding,
              },
            },
            {
              key: "prepare_hearing_checklist",
              title: "Prepare hearing checklist",
              handler: LITIGATION_GROUNDED_HANDLER,
              maxAttempts: 2,
              timeoutMs: 3 * 60_000,
              input: {
                systemPrompt: `You prepare conservative Chinese civil hearing checklists from cited, confirmed local matter state only. Mark every unresolved or excluded issue explicitly. ${outputProtocol}`,
                prompt: `Create a hearing checklist with issues, proof goals, contradiction checks, deadlines, exclusions, and required human decisions from this hash-bound snapshot.\n${snapshot}`,
                temperature: 0,
                snapshotHash: compiled.snapshotHash,
                allowedSources,
                retrievalInputBinding: executionRetrievalBinding,
              },
            },
          ];
      const result = queue().enqueue({
        matterId: req.params.matterId,
        userId,
        workflow: "aletheia-civil-litigation-harness-v1",
        goal: "Prepare a source-grounded litigation analysis and hearing checklist.",
        modelProfile: calibrationBinding.modelId,
        metadata: {
          source: "server_owned_litigation_workflow",
          statePolicy: compiled.statePolicy,
          snapshotSchemaVersion: compiled.schemaVersion,
          snapshotHash: compiled.snapshotHash,
          stateHash: compiled.stateHash,
          snapshotBytes,
          artifactDependencyHashes: compiled.artifactDependencyHashes,
          exclusions: compiled.exclusions,
          executionMode,
          partitionCount: partitioned?.partitions.length ?? 1,
          partitionHashes: partitions.map((partition) => partition.hash),
          excludedUnboundPartitionUnits: partitioned?.excludedUnboundUnits ?? 0,
          retrievalFocus: String(retrievalInputBinding?.focus ?? focus) || null,
          retrievalManifest,
          retrievalManifestHash: retrievalManifest?.manifestHash ?? null,
          retrievalInputBinding: retrievalInputBinding
            ? {
                manifestId: retrievalInputBinding.manifestId,
                manifestHash: retrievalInputBinding.manifestHash,
                bindingHash: retrievalInputBinding.bindingHash,
                indexFingerprint: retrievalInputBinding.indexFingerprint,
                confirmedExcerptIds: reviewedExcerpts.map(
                  (excerpt: Record<string, any>) => String(excerpt.id),
                ),
              }
            : null,
          partitionOrdering:
            partitioned?.ordering.strategy ?? "single_snapshot",
          partitionOmissionPolicy:
            partitioned?.ordering.omissionPolicy ?? "none",
          allowedHandlers: [LITIGATION_GROUNDED_HANDLER],
          modelCalibrationId: calibrationBinding.calibration?.id,
          modelCalibrationFingerprint:
            calibrationBinding.calibration?.modelFingerprint,
          modelCalibrationProtocol:
            calibrationBinding.calibration?.protocolVersion,
          modelRouting: {
            role: "litigation_analysis",
            modelId: calibrationBinding.modelId,
            routineModelId: routing.routineModelId,
          },
        },
        maxRunAttempts: 2,
        runTimeoutMs: Math.min(
          30 * 60_000,
          steps.length * 3 * 60_000 + 120_000,
        ),
        steps,
      });
      res.status(202).json(result);
    } catch (error) {
      if (error instanceof LitigationAgentPartitionError) {
        return void res.status(422).json({
          code: error.code.toLowerCase(),
          detail: error.message,
        });
      }
      handleError(res, error);
    }
  },
);

durableAgentRunsRouter.post(
  "/matters/:matterId/litigation-durable-runs/:runId/synthesis",
  requireAuth,
  async (req, res) => {
    if (!durableAgentRuntimeAcceptingRuns()) {
      return void res.status(503).json({
        code: "durable_worker_not_configured",
        detail:
          "Configure and health-check a local model before starting reviewed synthesis.",
      });
    }
    try {
      const userId = String(res.locals.userId);
      const calibrationBinding = acceptedLitigationCalibration(userId, res);
      if (!calibrationBinding) return;
      const routing = resolveAuthoritativeModelRouting(
        getAuthoritativeRuntimeSettings(userId),
        configuredDurableAgentRuntime()!.modelId,
      );
      const prepared =
        (await createAletheiaRepository().prepareLitigationAgentSynthesis(
          { userId },
          req.params.matterId,
          req.params.runId,
        )) as Record<string, any> | null;
      if (!prepared)
        return void res.status(404).json({ detail: "Matter not found" });
      const input = JSON.stringify(prepared.content);
      const inputBytes = Buffer.byteLength(input, "utf8");
      const runtimeStatus = durableAgentRuntimeStatus() as Record<string, any>;
      const contextWindowTokens = Number(
        runtimeStatus.scheduler?.contextWindowTokens ?? 32_768,
      );
      const maximumBytes = Math.min(
        750_000,
        Math.max(16_000, (contextWindowTokens - 4_096) * 2),
      );
      if (inputBytes > maximumBytes) {
        return void res.status(422).json({
          code: "reviewed_synthesis_input_too_large",
          detail:
            "Adopted partition outputs do not fit one reviewed synthesis run. No input was truncated and no run was created.",
          inputBytes,
          maximumBytes,
        });
      }
      const result = queue().enqueue({
        matterId: req.params.matterId,
        userId,
        workflow: "aletheia-civil-litigation-harness-v1",
        modelProfile: calibrationBinding.modelId,
        goal: "Prepare a reviewed cross-partition litigation synthesis.",
        metadata: {
          source: "reviewed_partition_synthesis",
          statePolicy: "human_adopted_partition_outputs_only",
          executionMode: "reviewed_synthesis",
          snapshotSchemaVersion: prepared.content.schemaVersion,
          snapshotHash: prepared.synthesisHash,
          snapshotBytes: inputBytes,
          synthesisOfRunId: req.params.runId,
          parentOutputReviewId: prepared.parentReviewId,
          parentOutputHash: prepared.parentOutputHash,
          allowedHandlers: [LITIGATION_GROUNDED_HANDLER],
          modelCalibrationId: calibrationBinding.calibration?.id,
          modelCalibrationFingerprint:
            calibrationBinding.calibration?.modelFingerprint,
          modelCalibrationProtocol:
            calibrationBinding.calibration?.protocolVersion,
          modelRouting: {
            role: "litigation_analysis",
            modelId: calibrationBinding.modelId,
            routineModelId: routing.routineModelId,
          },
        },
        maxRunAttempts: 2,
        runTimeoutMs: 8 * 60_000,
        steps: [
          {
            key: "synthesize_adopted_partitions",
            title: "Synthesize adopted partitions",
            handler: LITIGATION_GROUNDED_HANDLER,
            maxAttempts: 2,
            timeoutMs: 5 * 60_000,
            input: {
              systemPrompt: `Synthesize only the human-adopted partition outputs supplied by the server. Preserve conflicts and uncertainty; do not introduce new law or evidence. The result remains an unreviewed draft. ${GROUNDED_OUTPUT_PROTOCOL}`,
              prompt: `Prepare a cross-partition synthesis from this adopted, hash-bound input.\n${input}`,
              temperature: 0,
              snapshotHash: prepared.synthesisHash,
              allowedSources: prepared.allowedSources,
            },
          },
        ],
      });
      if (!result)
        return void res.status(404).json({ detail: "Matter not found" });
      res.status(202).json(result);
    } catch (error) {
      handleError(res, error);
    }
  },
);

durableAgentRunsRouter.get(
  "/matters/:matterId/litigation-durable-runs/latest",
  requireAuth,
  (req, res) => {
    try {
      res.json(
        queue().latestRun(
          String(res.locals.userId),
          req.params.matterId,
          "aletheia-civil-litigation-harness-v1",
        ),
      );
    } catch (error) {
      handleError(res, error);
    }
  },
);

durableAgentRunsRouter.get("/durable-runs/:runId", requireAuth, (req, res) => {
  try {
    const result = queue().getRun(String(res.locals.userId), req.params.runId);
    if (!result)
      return void res.status(404).json({ detail: "Durable run not found" });
    res.json(result);
  } catch (error) {
    handleError(res, error);
  }
});

durableAgentRunsRouter.get(
  "/durable-runs/:runId/integrity",
  requireAuth,
  (req, res) => {
    try {
      const owned = queue().getRun(String(res.locals.userId), req.params.runId);
      if (!owned)
        return void res.status(404).json({ detail: "Durable run not found" });
      res.json(queue().verifyEventChain(req.params.runId));
    } catch (error) {
      handleError(res, error);
    }
  },
);

durableAgentRunsRouter.post(
  "/durable-runs/:runId/cancel",
  requireAuth,
  (req, res) => {
    try {
      const result = queue().cancel(
        String(res.locals.userId),
        req.params.runId,
      );
      if (!result)
        return void res.status(404).json({ detail: "Durable run not found" });
      res.status(202).json(result);
    } catch (error) {
      handleError(res, error);
    }
  },
);
