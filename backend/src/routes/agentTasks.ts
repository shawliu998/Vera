import { Router } from "express";
import { checkProjectAccess } from "../lib/access";
import {
  advanceAgentTask,
  attachAgentTaskDocuments,
  createAgentTask,
  deferAgentTaskForProvider,
  getAgentTaskSnapshot,
  linkAgentTaskArtifacts,
  listAgentTasks,
  pauseAgentTask,
  recordAgentTaskCheckpoint,
  resumeAgentTask,
  retryAgentTask,
  stopAgentTask,
  updateAgentTaskExecutionModel,
} from "../lib/agentTasks";
import {
  executeAgentStep,
  isTransientModelError,
  verifyTaskCitationLinks,
} from "../lib/agentStepExecutor";
import { createServerSupabase } from "../lib/supabase";
import { requireAuth } from "../middleware/auth";
import { DEFAULT_MAIN_MODEL, isSupportedModel } from "../lib/llm";

export const agentTasksRouter = Router();

function routeError(
  res: Parameters<Parameters<typeof agentTasksRouter.get>[1]>[1],
  error: unknown,
) {
  const detail =
    error instanceof Error ? error.message : "Agent task request failed";
  const status = detail.startsWith("Only a") ? 409 : 500;
  res.status(status).json({ detail });
}

function executionErrorMessage(error: unknown) {
  const message =
    error instanceof Error ? error.message : "Model or tool execution failed";
  if (/deepseek api key/i.test(message)) {
    return "DeepSeek is unavailable. Configure a DeepSeek API key in Settings before running this task.";
  }
  if (/gemini api key/i.test(message)) {
    return "Gemini is unavailable. Configure a Gemini API key in Settings before running this task.";
  }
  if (/api key is not configured/i.test(message)) {
    return "The selected model is unavailable. Configure its API key in Settings before running this task.";
  }
  if (/503|overloaded|queue|temporarily unavailable/i.test(message)) {
    return "The selected model is temporarily unavailable. Wait a moment and try again.";
  }
  return message;
}

function verifierRepairAlreadyAttempted(task: {
  latest_checkpoint?: unknown;
}) {
  const checkpoint = task.latest_checkpoint;
  if (!checkpoint || typeof checkpoint !== "object") return false;
  const summary = (checkpoint as { summary?: unknown }).summary;
  return (
    typeof summary === "string" &&
    /^(?:Verifier repair 1\/1 started:|Provider queue during verifier repair 1\/1:)/.test(
      summary,
    )
  );
}

agentTasksRouter.get("/", requireAuth, async (req, res) => {
  try {
    const matterId =
      typeof req.query.matter_id === "string" ? req.query.matter_id : undefined;
    const data = await listAgentTasks(
      createServerSupabase(),
      res.locals.userId as string,
      matterId,
    );
    res.json(data);
  } catch (error) {
    routeError(res, error);
  }
});

agentTasksRouter.post("/", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const goal = typeof req.body?.goal === "string" ? req.body.goal.trim() : "";
  const matterId =
    typeof req.body?.matter_id === "string" ? req.body.matter_id.trim() : "";
  const model =
    typeof req.body?.model === "string"
      ? req.body.model.trim()
      : DEFAULT_MAIN_MODEL;
  const rawDocumentIds: unknown[] = Array.isArray(req.body?.document_ids)
    ? (req.body.document_ids as unknown[])
    : [];
  const documentIds = rawDocumentIds.length
    ? Array.from(
        new Set(
          rawDocumentIds.filter(
            (value: unknown): value is string =>
              typeof value === "string" && value.trim().length > 0,
          ),
        ),
      ).slice(0, 100)
    : [];
  if (!goal) return void res.status(400).json({ detail: "goal is required" });
  if (goal.length > 4000)
    return void res.status(400).json({ detail: "goal is too long" });
  if (!matterId)
    return void res.status(400).json({ detail: "matter_id is required" });
  if (!isSupportedModel(model))
    return void res.status(400).json({ detail: "Unsupported model" });

  try {
    const db = createServerSupabase();
    const access = await checkProjectAccess(matterId, userId, userEmail, db);
    if (!access.ok)
      return void res.status(404).json({ detail: "Matter not found" });
    if (documentIds.length) {
      const { data: documents, error: documentsError } = await db
        .from("documents")
        .select("id")
        .eq("project_id", matterId)
        .in("id", documentIds);
      if (documentsError) throw documentsError;
      if ((documents ?? []).length !== documentIds.length) {
        return void res
          .status(400)
          .json({ detail: "One or more documents are not in this Matter" });
      }
    }
    const snapshot = await createAgentTask(db, {
      userId,
      matterId,
      goal,
      executionModel: model,
      initialArtifacts: documentIds.map((documentId) => ({
        artifact_type: "document" as const,
        artifact_id: documentId,
        purpose: "Source document",
      })),
    });
    res.status(201).json(snapshot);
  } catch (error) {
    routeError(res, error);
  }
});

agentTasksRouter.get("/:taskId", requireAuth, async (req, res) => {
  try {
    const snapshot = await getAgentTaskSnapshot(
      createServerSupabase(),
      req.params.taskId,
      res.locals.userId as string,
    );
    if (!snapshot)
      return void res.status(404).json({ detail: "Agent task not found" });
    res.json(snapshot);
  } catch (error) {
    routeError(res, error);
  }
});

agentTasksRouter.post("/:taskId/advance", requireAuth, async (req, res) => {
  try {
    const db = createServerSupabase();
    const userId = res.locals.userId as string;
    const current = await getAgentTaskSnapshot(db, req.params.taskId, userId);
    if (!current)
      return void res.status(404).json({ detail: "Agent task not found" });
    if (current.task.status === "queued") {
      const started = await advanceAgentTask(db, req.params.taskId, userId);
      return void res.json(started);
    }
    if (
      current.task.status !== "running" &&
      current.task.status !== "verifying"
    ) {
      return void res.json(current);
    }
    let execution;
    try {
      execution = await executeAgentStep({
        db,
        snapshot: current,
        userId,
        userEmail: res.locals.userEmail as string | undefined,
      });
    } catch (error) {
      const summary = executionErrorMessage(error);
      if (isTransientModelError(error)) {
        const deferred = await deferAgentTaskForProvider(
          db,
          req.params.taskId,
          userId,
          `Provider queue: ${summary} Resume retries this step without losing completed work.`,
        );
        return void res.status(202).json(deferred);
      }
      const failed = await stopAgentTask(db, req.params.taskId, userId, {
        status: "failed",
        summary,
      });
      return void res.status(503).json({
        detail: summary,
        task: failed,
      });
    }
    if (execution.waitingForInput) {
      const waiting = await stopAgentTask(db, req.params.taskId, userId, {
        status: "waiting_input",
        summary: execution.summary,
      });
      return void res.json(waiting);
    }
    if (current.task.status === "verifying") {
      execution.citationCheck = await verifyTaskCitationLinks(db, current);
      const allArtifacts = [...current.artifacts, ...execution.artifacts];
      const missingDeliverables = () =>
        [
          !allArtifacts.some((artifact) => artifact.purpose === "Risk matrix")
            ? "risk matrix"
            : null,
          !allArtifacts.some(
            (artifact) => artifact.purpose === "Review memo draft",
          )
            ? "review memo draft"
            : null,
        ].filter((value): value is string => Boolean(value));
      const summaryHasGap = /\bGAP\b/i.test(execution.summary);
      const citationGap =
        execution.citationCheck.total > 0 &&
        execution.citationCheck.missing > 0;
      const initialGaps = missingDeliverables();
      if (initialGaps.length || summaryHasGap || citationGap) {
        const reasons = [
          initialGaps.length ? `missing ${initialGaps.join(" and ")}` : null,
          summaryHasGap
            ? "the verifier reported one or more GAP findings"
            : null,
          citationGap
            ? `${execution.citationCheck.missing} citation(s) could not be relocated`
            : null,
        ]
          .filter(Boolean)
          .join("; ");
        if (verifierRepairAlreadyAttempted(current.task)) {
          const detail = `Verification blocked after one repair pass: ${reasons}.`;
          const failed = await stopAgentTask(
            db,
            req.params.taskId,
            userId,
            { status: "failed", summary: detail },
          );
          return void res.status(409).json({ detail, task: failed });
        }
        await recordAgentTaskCheckpoint(
          db,
          req.params.taskId,
          userId,
          `Verifier repair 1/1 started: ${reasons}.`,
        );
        let repair;
        let recheck;
        try {
          repair = await executeAgentStep({
            db,
            snapshot: current,
            userId,
            userEmail: res.locals.userEmail as string | undefined,
            instructionOverride: `This is the single permitted repair pass. Repair: ${reasons}. Re-read the sources, update or recreate only the affected deliverables, and preserve lawyer-review status.`,
          });
          await linkAgentTaskArtifacts(
            db,
            req.params.taskId,
            userId,
            repair.artifacts,
          );
          const repairedSnapshot = {
            ...current,
            artifacts: [
              ...current.artifacts,
              ...repair.artifacts.map((artifact) => ({
                task_id: req.params.taskId,
                ...artifact,
              })),
            ],
          };
          recheck = await executeAgentStep({
            db,
            snapshot: repairedSnapshot,
            userId,
            userEmail: res.locals.userEmail as string | undefined,
            instructionOverride:
              "Re-run the four verifier checks after the one permitted repair. Do not repair again. Return PASS or GAP for every check.",
          });
          recheck.citationCheck = await verifyTaskCitationLinks(db, {
            ...repairedSnapshot,
            artifacts: [
              ...repairedSnapshot.artifacts,
              ...recheck.artifacts.map((artifact) => ({
                task_id: req.params.taskId,
                ...artifact,
              })),
            ],
          });
        } catch (error) {
          if (isTransientModelError(error)) {
            const deferred = await deferAgentTaskForProvider(
              db,
              req.params.taskId,
              userId,
              `Provider queue during verifier repair 1/1: ${executionErrorMessage(error)} Resume retries verification without losing completed work.`,
            );
            return void res.status(202).json(deferred);
          }
          throw error;
        }
        allArtifacts.push(...repair.artifacts);
        const remaining = missingDeliverables();
        if (
          remaining.length ||
          /\bGAP\b/i.test(recheck.summary) ||
          recheck.citationCheck.missing > 0
        ) {
          const missing = remaining.length
            ? remaining.join(" and ")
            : "one or more verifier checks";
          const failed = await stopAgentTask(db, req.params.taskId, userId, {
            status: "failed",
            summary: `Verification blocked after one repair pass: ${missing}.`,
          });
          return void res.status(409).json({
            detail: `Verification blocked after one repair pass: ${missing}.`,
            task: failed,
          });
        }
        execution = {
          ...recheck,
          summary: `Verifier repair 1/1 completed.\n${recheck.summary}`,
          artifacts: [
            ...execution.artifacts,
            ...repair.artifacts,
            ...recheck.artifacts,
          ],
        };
      } else if (execution.citationCheck.total === 0) {
        const failed = await stopAgentTask(db, req.params.taskId, userId, {
          status: "failed",
          summary:
            "Verification blocked: no source citations were available for deterministic relocation checks.",
        });
        return void res.status(409).json({
          detail:
            "Verification blocked: no source citations were available for deterministic relocation checks.",
          task: failed,
        });
      }
    }
    const snapshot = await advanceAgentTask(
      db,
      req.params.taskId,
      userId,
      execution,
    );
    if (!snapshot)
      return void res.status(404).json({ detail: "Agent task not found" });
    res.json(snapshot);
  } catch (error) {
    routeError(res, error);
  }
});

agentTasksRouter.post("/:taskId/retry", requireAuth, async (req, res) => {
  try {
    const snapshot = await retryAgentTask(
      createServerSupabase(),
      req.params.taskId,
      res.locals.userId as string,
    );
    if (!snapshot)
      return void res.status(404).json({ detail: "Agent task not found" });
    res.json(snapshot);
  } catch (error) {
    routeError(res, error);
  }
});

agentTasksRouter.post("/:taskId/documents", requireAuth, async (req, res) => {
  const rawDocumentIds: unknown[] = Array.isArray(req.body?.document_ids)
    ? (req.body.document_ids as unknown[])
    : [];
  const documentIds: string[] = Array.from(
    new Set(
      rawDocumentIds.filter(
        (value: unknown): value is string =>
          typeof value === "string" && value.trim().length > 0,
      ),
    ),
  ).slice(0, 100);
  if (!documentIds.length)
    return void res.status(400).json({ detail: "document_ids is required" });
  try {
    const db = createServerSupabase();
    const userId = res.locals.userId as string;
    const snapshot = await getAgentTaskSnapshot(db, req.params.taskId, userId);
    if (!snapshot)
      return void res.status(404).json({ detail: "Agent task not found" });
    const { data: documents, error } = await db
      .from("documents")
      .select("id")
      .eq("project_id", snapshot.task.matter_id)
      .in("id", documentIds);
    if (error) throw error;
    if ((documents ?? []).length !== documentIds.length) {
      return void res
        .status(400)
        .json({ detail: "One or more documents are not in this Matter" });
    }
    const updated = await attachAgentTaskDocuments(
      db,
      req.params.taskId,
      userId,
      documentIds,
    );
    res.json(updated);
  } catch (error) {
    routeError(res, error);
  }
});

agentTasksRouter.post("/:taskId/pause", requireAuth, async (req, res) => {
  try {
    const snapshot = await pauseAgentTask(
      createServerSupabase(),
      req.params.taskId,
      res.locals.userId as string,
    );
    if (!snapshot)
      return void res.status(404).json({ detail: "Agent task not found" });
    res.json(snapshot);
  } catch (error) {
    routeError(res, error);
  }
});

agentTasksRouter.post("/:taskId/resume", requireAuth, async (req, res) => {
  try {
    const snapshot = await resumeAgentTask(
      createServerSupabase(),
      req.params.taskId,
      res.locals.userId as string,
    );
    if (!snapshot)
      return void res.status(404).json({ detail: "Agent task not found" });
    res.json(snapshot);
  } catch (error) {
    routeError(res, error);
  }
});

agentTasksRouter.patch("/:taskId/model", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const model =
    typeof req.body?.model === "string" ? req.body.model.trim() : "";
  if (!model) return void res.status(400).json({ detail: "model is required" });
  if (!isSupportedModel(model))
    return void res.status(400).json({ detail: "Unsupported model" });
  try {
    const snapshot = await updateAgentTaskExecutionModel(
      createServerSupabase(),
      req.params.taskId,
      userId,
      model,
    );
    if (!snapshot)
      return void res.status(404).json({ detail: "Agent task not found" });
    res.json(snapshot);
  } catch (error) {
    routeError(res, error);
  }
});
