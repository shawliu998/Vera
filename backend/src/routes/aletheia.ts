import { Router } from "express";
import { createAletheiaRepository } from "../lib/aletheia";
import {
  ACTORS,
  GENERATED_BY,
  MATTER_STATUSES,
  REVIEW_TAGS,
  REVIEW_TARGET_TYPES,
  RISK_LEVELS,
  TEMPLATES,
  WORK_PRODUCT_KINDS,
  WORK_PRODUCT_STATUSES,
  arrayPayload,
  cleanSharedEmails,
  nullableText,
  objectPayload,
  text,
} from "../lib/aletheia/domain";
import { LocalAdapterNotReadyError } from "../lib/aletheia/repository";
import { requireAuth } from "../middleware/auth";

export const aletheiaRouter = Router();

function userContext(res: { locals: Record<string, unknown> }) {
  return {
    userId: res.locals.userId as string,
    userEmail: res.locals.userEmail as string | undefined,
  };
}

function handleRouteError(res: { status: (code: number) => { json: (body: unknown) => void } }, error: unknown) {
  if (error instanceof LocalAdapterNotReadyError) {
    return void res.status(501).json({
      detail:
        "Local Aletheia storage is scaffolded but not enabled for API traffic yet.",
    });
  }
  const message = error instanceof Error ? error.message : "Unexpected error";
  res.status(500).json({ detail: message });
}

// GET /aletheia/matters
aletheiaRouter.get("/matters", requireAuth, async (_req, res) => {
  try {
    const data = await createAletheiaRepository().listMatters(userContext(res));
    res.json(data);
  } catch (error) {
    handleRouteError(res, error);
  }
});

// POST /aletheia/matters
aletheiaRouter.post("/matters", requireAuth, async (req, res) => {
  const ctx = userContext(res);
  const title = text(req.body?.title, 240);
  const objective = text(req.body?.objective, 2000);
  const template = text(req.body?.template, 80);
  const status = text(req.body?.status, 40) || "draft";
  const riskLevel = nullableText(req.body?.riskLevel, 40);

  if (!title) return void res.status(400).json({ detail: "title is required" });
  if (!objective) {
    return void res.status(400).json({ detail: "objective is required" });
  }
  if (!TEMPLATES.has(template)) {
    return void res.status(400).json({ detail: "template is invalid" });
  }
  if (!MATTER_STATUSES.has(status)) {
    return void res.status(400).json({ detail: "status is invalid" });
  }
  if (riskLevel && !RISK_LEVELS.has(riskLevel)) {
    return void res.status(400).json({ detail: "riskLevel is invalid" });
  }

  try {
    const data = await createAletheiaRepository().createMatter(ctx, {
      title,
      objective,
      template,
      status,
      riskLevel,
      clientOrProject: nullableText(req.body?.clientOrProject, 240),
      sourceProjectId: nullableText(req.body?.sourceProjectId, 80),
      sharedWith: cleanSharedEmails(req.body?.sharedWith, ctx.userEmail),
      metadata: objectPayload(req.body?.metadata),
    });
    res.status(201).json(data);
  } catch (error) {
    handleRouteError(res, error);
  }
});

// GET /aletheia/matters/:matterId
aletheiaRouter.get("/matters/:matterId", requireAuth, async (req, res) => {
  try {
    const data = await createAletheiaRepository().getMatterDetail(
      userContext(res),
      req.params.matterId,
    );
    if (!data) return void res.status(404).json({ detail: "Matter not found" });
    res.json(data);
  } catch (error) {
    handleRouteError(res, error);
  }
});

// POST /aletheia/matters/:matterId/work-products
aletheiaRouter.post(
  "/matters/:matterId/work-products",
  requireAuth,
  async (req, res) => {
    const kind = text(req.body?.kind, 80);
    const title = text(req.body?.title, 240);
    const status = text(req.body?.status, 40) || "generated";
    const generatedBy = text(req.body?.generatedBy, 40) || "human";

    if (!WORK_PRODUCT_KINDS.has(kind)) {
      return void res.status(400).json({ detail: "kind is invalid" });
    }
    if (!title) {
      return void res.status(400).json({ detail: "title is required" });
    }
    if (!WORK_PRODUCT_STATUSES.has(status)) {
      return void res.status(400).json({ detail: "status is invalid" });
    }
    if (!GENERATED_BY.has(generatedBy)) {
      return void res.status(400).json({ detail: "generatedBy is invalid" });
    }
    if (
      !req.body?.content ||
      typeof req.body.content !== "object" ||
      Array.isArray(req.body.content)
    ) {
      return void res.status(400).json({ detail: "content must be an object" });
    }

    try {
      const data = await createAletheiaRepository().createWorkProduct(
        userContext(res),
        req.params.matterId,
        {
          kind,
          title,
          status,
          schemaVersion: text(req.body?.schemaVersion, 120) || "aletheia-v0",
          content: objectPayload(req.body.content),
          validationErrors: arrayPayload(req.body?.validationErrors),
          generatedBy: generatedBy as "system" | "agent" | "human",
          model: nullableText(req.body?.model, 120),
        },
      );
      if (!data) return void res.status(404).json({ detail: "Matter not found" });
      res.status(201).json(data);
    } catch (error) {
      handleRouteError(res, error);
    }
  },
);

// POST /aletheia/matters/:matterId/reviews
aletheiaRouter.post("/matters/:matterId/reviews", requireAuth, async (req, res) => {
  const targetType = text(req.body?.targetType, 80);
  const targetId = text(req.body?.targetId, 240);
  const tag = text(req.body?.tag, 80);
  const comment = text(req.body?.comment, 4000);

  if (!REVIEW_TARGET_TYPES.has(targetType)) {
    return void res.status(400).json({ detail: "targetType is invalid" });
  }
  if (!targetId) {
    return void res.status(400).json({ detail: "targetId is required" });
  }
  if (!REVIEW_TAGS.has(tag)) {
    return void res.status(400).json({ detail: "tag is invalid" });
  }
  if (!comment) {
    return void res.status(400).json({ detail: "comment is required" });
  }

  try {
    const data = await createAletheiaRepository().addReview(
      userContext(res),
      req.params.matterId,
      {
        targetType,
        targetId,
        tag,
        comment,
        workProductId: nullableText(req.body?.workProductId, 80),
        evidenceItemId: nullableText(req.body?.evidenceItemId, 80),
        reviewerName: nullableText(req.body?.reviewerName, 240),
      },
    );
    if (!data) return void res.status(404).json({ detail: "Matter not found" });
    res.status(201).json(data);
  } catch (error) {
    handleRouteError(res, error);
  }
});

// POST /aletheia/matters/:matterId/audit-events
aletheiaRouter.post(
  "/matters/:matterId/audit-events",
  requireAuth,
  async (req, res) => {
    const actor = text(req.body?.actor, 40) || "human";
    const action = text(req.body?.action, 120);

    if (!ACTORS.has(actor)) {
      return void res.status(400).json({ detail: "actor is invalid" });
    }
    if (!action) {
      return void res.status(400).json({ detail: "action is required" });
    }

    try {
      const data = await createAletheiaRepository().appendAuditEvent(
        userContext(res),
        req.params.matterId,
        {
          actor: actor as "system" | "agent" | "human",
          action,
          workflowVersion: nullableText(req.body?.workflowVersion, 120),
          model: nullableText(req.body?.model, 120),
          details: objectPayload(req.body?.details),
        },
      );
      if (!data) return void res.status(404).json({ detail: "Matter not found" });
      res.status(201).json(data);
    } catch (error) {
      handleRouteError(res, error);
    }
  },
);

// POST /aletheia/matters/:matterId/agent-runs
aletheiaRouter.post(
  "/matters/:matterId/agent-runs",
  requireAuth,
  async (req, res) => {
    const workflow = text(req.body?.workflow, 120) || "legal_matter_review";
    const goal = text(req.body?.goal, 2000);
    const status = text(req.body?.status, 40) || "queued";

    if (!TEMPLATES.has(workflow)) {
      return void res.status(400).json({ detail: "workflow is invalid" });
    }
    if (!goal) {
      return void res.status(400).json({ detail: "goal is required" });
    }
    if (!["queued", "running"].includes(status)) {
      return void res.status(400).json({ detail: "status is invalid" });
    }

    try {
      const data = await createAletheiaRepository().createAgentRun(
        userContext(res),
        req.params.matterId,
        {
          workflow,
          goal,
          status: status as "queued" | "running",
          modelProfile: nullableText(req.body?.modelProfile, 120),
          metadata: objectPayload(req.body?.metadata),
        },
      );
      if (!data) return void res.status(404).json({ detail: "Matter not found" });
      res.status(201).json(data);
    } catch (error) {
      handleRouteError(res, error);
    }
  },
);
