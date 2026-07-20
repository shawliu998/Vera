import { Router } from "express";
import { checkProjectAccess } from "../lib/access";
import {
  advanceAgentTask,
  createAgentTask,
  getAgentTaskSnapshot,
  listAgentTasks,
  pauseAgentTask,
  resumeAgentTask,
  stopAgentTask,
} from "../lib/agentTasks";
import { executeAgentStep } from "../lib/agentStepExecutor";
import { createServerSupabase } from "../lib/supabase";
import { requireAuth } from "../middleware/auth";

export const agentTasksRouter = Router();

function routeError(res: Parameters<Parameters<typeof agentTasksRouter.get>[1]>[1], error: unknown) {
  const detail = error instanceof Error ? error.message : "Agent task request failed";
  const status = detail.startsWith("Only a") ? 409 : 500;
  res.status(status).json({ detail });
}

function executionErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "Model or tool execution failed";
  if (/gemini api key|api key is not configured/i.test(message)) {
    return "Gemini is unavailable. Configure a Gemini API key in Settings before running this task.";
  }
  if (/503|overloaded|queue|temporarily unavailable/i.test(message)) {
    return "The selected model is temporarily unavailable. Wait a moment and try again.";
  }
  return message;
}

agentTasksRouter.get("/", requireAuth, async (req, res) => {
  try {
    const matterId = typeof req.query.matter_id === "string" ? req.query.matter_id : undefined;
    const data = await listAgentTasks(createServerSupabase(), res.locals.userId as string, matterId);
    res.json(data);
  } catch (error) {
    routeError(res, error);
  }
});

agentTasksRouter.post("/", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const goal = typeof req.body?.goal === "string" ? req.body.goal.trim() : "";
  const matterId = typeof req.body?.matter_id === "string" ? req.body.matter_id.trim() : "";
  const rawDocumentIds: unknown[] = Array.isArray(req.body?.document_ids)
    ? (req.body.document_ids as unknown[])
    : [];
  const documentIds = rawDocumentIds.length
    ? Array.from(
        new Set(
          rawDocumentIds.filter(
            (value: unknown): value is string => typeof value === "string" && value.trim().length > 0,
          ),
        ),
      ).slice(0, 100)
    : [];
  if (!goal) return void res.status(400).json({ detail: "goal is required" });
  if (goal.length > 4000) return void res.status(400).json({ detail: "goal is too long" });
  if (!matterId) return void res.status(400).json({ detail: "matter_id is required" });

  try {
    const db = createServerSupabase();
    const access = await checkProjectAccess(matterId, userId, userEmail, db);
    if (!access.ok) return void res.status(404).json({ detail: "Matter not found" });
    if (documentIds.length) {
      const { data: documents, error: documentsError } = await db
        .from("documents")
        .select("id")
        .eq("project_id", matterId)
        .in("id", documentIds);
      if (documentsError) throw documentsError;
      if ((documents ?? []).length !== documentIds.length) {
        return void res.status(400).json({ detail: "One or more documents are not in this Matter" });
      }
    }
    const snapshot = await createAgentTask(db, {
      userId,
      matterId,
      goal,
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
    if (!snapshot) return void res.status(404).json({ detail: "Agent task not found" });
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
    if (!current) return void res.status(404).json({ detail: "Agent task not found" });
    if (current.task.status === "queued") {
      const started = await advanceAgentTask(db, req.params.taskId, userId);
      return void res.json(started);
    }
    if (current.task.status !== "running" && current.task.status !== "verifying") {
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
      const allArtifacts = [...current.artifacts, ...execution.artifacts];
      const hasRiskMatrix = allArtifacts.some((artifact) => artifact.purpose === "Risk matrix");
      const hasReviewMemo = allArtifacts.some((artifact) => artifact.purpose === "Review memo draft");
      if (!hasRiskMatrix || !hasReviewMemo) {
        const missing = [
          !hasRiskMatrix ? "risk matrix" : null,
          !hasReviewMemo ? "review memo draft" : null,
        ].filter(Boolean).join(" and ");
        const failed = await stopAgentTask(db, req.params.taskId, userId, {
          status: "failed",
          summary: `Verification blocked: missing ${missing}.`,
        });
        return void res.status(409).json({
          detail: `Verification blocked: missing ${missing}.`,
          task: failed,
        });
      }
    }
    const snapshot = await advanceAgentTask(db, req.params.taskId, userId, execution);
    if (!snapshot) return void res.status(404).json({ detail: "Agent task not found" });
    res.json(snapshot);
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
    if (!snapshot) return void res.status(404).json({ detail: "Agent task not found" });
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
    if (!snapshot) return void res.status(404).json({ detail: "Agent task not found" });
    res.json(snapshot);
  } catch (error) {
    routeError(res, error);
  }
});
