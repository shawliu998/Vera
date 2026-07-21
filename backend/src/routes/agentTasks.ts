import { Router } from "express";
import { checkProjectAccess } from "../lib/access";
import {
  attachAgentTaskDocuments,
  createAgentTask,
  getAgentTaskSnapshot,
  listAgentTasks,
  pauseAgentTask,
  reviseAgentTask,
  resumeAgentTask,
  retryAgentTask,
  updateAgentTaskExecutionModel,
} from "../lib/agentTasks";
import {
  cancelAgentTaskRunner,
  wakeAgentTaskRunner,
} from "../lib/agentTaskRunner";
import { createServerSupabase } from "../lib/supabase";
import { requireAuth } from "../middleware/auth";
import { DEFAULT_MAIN_MODEL, isSupportedModel } from "../lib/llm";
import {
  buildGoalAwareFallbackPlan,
  resolveAgentWorkflowConstraint,
} from "../lib/agentTaskPlanner";
import {
  captureApprovedArtifacts,
  getReviewBlockers,
  loadApprovedExport,
} from "../lib/agentTaskReviews";
import { buildContentDisposition } from "../lib/storage";
import { contentTypeForDocumentType } from "../lib/documentTypes";
import { getAgentTaskEvidence } from "../lib/agentTaskEvidence";

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
  const workflowId =
    typeof req.body?.workflow_id === "string"
      ? req.body.workflow_id.trim().slice(0, 200)
      : "";
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
    const workflow = workflowId
      ? await resolveAgentWorkflowConstraint({
          db,
          workflowId,
          userId,
          userEmail,
        })
      : null;
    if (workflowId && !workflow) {
      return void res.status(404).json({ detail: "Workflow not found" });
    }
    const provisionalPlan = buildGoalAwareFallbackPlan({
      goal,
      hasSources: documentIds.length > 0,
      workflowId: workflowId || undefined,
      workflowType: workflow?.type,
    });
    const snapshot = await createAgentTask(db, {
      userId,
      matterId,
      goal,
      executionModel: model,
      plan: provisionalPlan.steps,
      deliverables: provisionalPlan.deliverables,
      planningRequest: {
        document_ids: documentIds,
        ...(workflowId ? { workflow_id: workflowId } : {}),
      },
      initialArtifacts: [
        ...documentIds.map((documentId) => ({
          artifact_type: "document" as const,
          artifact_id: documentId,
          purpose: "Source document",
        })),
        ...(workflow
          ? [
              {
                artifact_type: "workflow_run" as const,
                artifact_id: workflow.id,
                purpose: `Selected workflow: ${workflow.title}`,
              },
            ]
          : []),
      ],
    });
    if (!snapshot) throw new Error("Created task could not be reloaded");
    wakeAgentTaskRunner({ taskId: snapshot.task.id, userId, userEmail });
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

agentTasksRouter.get(
  "/:taskId/evidence/:artifactId",
  requireAuth,
  async (req, res) => {
    try {
      const evidence = await getAgentTaskEvidence(createServerSupabase(), {
        taskId: req.params.taskId,
        userId: res.locals.userId as string,
        artifactId: req.params.artifactId,
      });
      if (!evidence) {
        return void res.status(404).json({ detail: "Evidence not found" });
      }
      res.json(evidence);
    } catch (error) {
      routeError(res, error);
    }
  },
);

agentTasksRouter.post(
  "/:taskId/review-decisions",
  requireAuth,
  async (req, res) => {
    const status =
      req.body?.status === "approved" ||
      req.body?.status === "changes_requested"
        ? req.body.status
        : null;
    const note = typeof req.body?.note === "string" ? req.body.note.trim() : "";
    if (!status) {
      return void res.status(400).json({
        detail: "status must be approved or changes_requested",
      });
    }
    if (note.length > 4000) {
      return void res.status(400).json({ detail: "note is too long" });
    }
    if (status === "changes_requested" && !note) {
      return void res
        .status(400)
        .json({ detail: "A note is required when requesting changes" });
    }

    try {
      const db = createServerSupabase();
      const userId = res.locals.userId as string;
      const snapshot = await getAgentTaskSnapshot(
        db,
        req.params.taskId,
        userId,
      );
      if (!snapshot) {
        return void res.status(404).json({ detail: "Agent task not found" });
      }
      if (snapshot.task.status !== "completed") {
        return void res.status(409).json({
          detail: "Lawyer review is available only after task completion",
        });
      }

      let artifactSnapshot: unknown[] = [];
      if (status === "approved") {
        const { blockers } = await getReviewBlockers(db, snapshot);
        if (blockers.length) {
          return void res.status(409).json({
            detail: `Approval is blocked: ${blockers.join(" ")}`,
            blockers,
          });
        }
        artifactSnapshot = await captureApprovedArtifacts(db, snapshot);
      }

      const { data: profile } = await db
        .from("user_profiles")
        .select("display_name")
        .eq("user_id", userId)
        .maybeSingle();
      const { error } = await db.from("agent_task_review_decisions").insert({
        task_id: req.params.taskId,
        status,
        reviewer_id: userId,
        reviewer_email:
          (res.locals.userEmail as string | undefined)?.toLowerCase() || null,
        reviewer_name:
          typeof profile?.display_name === "string" &&
          profile.display_name.trim()
            ? profile.display_name.trim()
            : null,
        note,
        artifact_snapshot: artifactSnapshot,
      });
      if (error) throw error;

      res.json(await getAgentTaskSnapshot(db, req.params.taskId, userId));
    } catch (error) {
      routeError(res, error);
    }
  },
);

agentTasksRouter.post("/:taskId/revise", requireAuth, async (req, res) => {
  try {
    const snapshot = await reviseAgentTask(
      createServerSupabase(),
      req.params.taskId,
      res.locals.userId as string,
    );
    if (!snapshot) {
      return void res.status(404).json({ detail: "Agent task not found" });
    }
    wakeAgentTaskRunner({
      taskId: req.params.taskId,
      userId: res.locals.userId as string,
      userEmail: res.locals.userEmail as string | undefined,
    });
    res.json(snapshot);
  } catch (error) {
    routeError(res, error);
  }
});

agentTasksRouter.get(
  "/:taskId/final-export/:artifactId",
  requireAuth,
  async (req, res) => {
    try {
      const db = createServerSupabase();
      const userId = res.locals.userId as string;
      const snapshot = await getAgentTaskSnapshot(
        db,
        req.params.taskId,
        userId,
      );
      if (!snapshot) {
        return void res.status(404).json({ detail: "Agent task not found" });
      }
      const { blockers } = await getReviewBlockers(db, snapshot);
      if (blockers.length) {
        return void res.status(409).json({
          detail: `Final export is blocked: ${blockers.join(" ")}`,
          blockers,
        });
      }
      const exported = await loadApprovedExport(
        db,
        req.params.taskId,
        userId,
        req.params.artifactId,
      );
      if (!exported) {
        return void res.status(404).json({ detail: "Agent task not found" });
      }
      const extension = exported.artifact.filename.includes(".")
        ? (exported.artifact.filename.split(".").pop() ?? "")
        : (exported.artifact.file_type ?? "");
      res.setHeader("Content-Type", contentTypeForDocumentType(extension));
      res.setHeader(
        "Content-Disposition",
        buildContentDisposition("attachment", exported.artifact.filename),
      );
      res.setHeader("X-Vera-Approved-Version", exported.artifact.version_id);
      res.setHeader("X-Vera-Approved-SHA256", exported.artifact.sha256);
      res.send(exported.bytes);
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : "Final export failed";
      if (/blocked|not part|no longer|unavailable|integrity/i.test(detail)) {
        return void res.status(409).json({ detail });
      }
      routeError(res, error);
    }
  },
);

agentTasksRouter.post("/:taskId/advance", requireAuth, async (req, res) => {
  try {
    const db = createServerSupabase();
    const userId = res.locals.userId as string;
    const current = await getAgentTaskSnapshot(db, req.params.taskId, userId);
    if (!current)
      return void res.status(404).json({ detail: "Agent task not found" });
    wakeAgentTaskRunner({
      taskId: req.params.taskId,
      userId,
      userEmail: res.locals.userEmail as string | undefined,
    });
    res.status(202).json(current);
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
    wakeAgentTaskRunner({
      taskId: req.params.taskId,
      userId: res.locals.userId as string,
      userEmail: res.locals.userEmail as string | undefined,
    });
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
    if (updated && ["running", "verifying"].includes(updated.task.status)) {
      wakeAgentTaskRunner({
        taskId: req.params.taskId,
        userId,
        userEmail: res.locals.userEmail as string | undefined,
      });
    }
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
    cancelAgentTaskRunner(req.params.taskId);
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
    wakeAgentTaskRunner({
      taskId: req.params.taskId,
      userId: res.locals.userId as string,
      userEmail: res.locals.userEmail as string | undefined,
    });
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
