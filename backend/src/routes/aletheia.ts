import { Router } from "express";
import { createAletheiaRepository } from "../lib/aletheia";
import {
  ACTORS,
  EVIDENCE_RELEVANCE,
  EVIDENCE_SUPPORT_STATUS,
  GENERATED_BY,
  MATTER_MEMORY_CATEGORIES,
  MATTER_STATUSES,
  PLAYBOOK_STATUSES,
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
import {
  ApprovalRequiredError,
  CapabilityNotAvailableError,
  LocalAdapterNotReadyError,
} from "../lib/aletheia/repository";
import { requireAuth } from "../middleware/auth";
import { multiFileUpload, singleFileUpload } from "../lib/upload";

export const aletheiaRouter = Router();

const TOOL_ADAPTER_TOOLS = [
  "list_matters",
  "read_matter",
  "search_matter_documents",
  "read_evidence_item",
  "create_work_product",
  "add_review_tag",
  "append_audit_event",
  "export_audit_pack",
] as const;

const DISABLED_TOOL_ADAPTER_TOOLS = [
  "browser",
  "terminal",
  "external_web_search",
  "email",
  "destructive_file_operations",
];

type ToolAdapterTool = (typeof TOOL_ADAPTER_TOOLS)[number];

function isToolAdapterTool(value: string): value is ToolAdapterTool {
  return (TOOL_ADAPTER_TOOLS as readonly string[]).includes(value);
}

function toolArgs(value: unknown): Record<string, unknown> {
  return objectPayload(value);
}

function retrievalMode(value: unknown) {
  const mode = text(value, 40);
  return mode === "keyword" || mode === "hybrid" || mode === "semantic"
    ? mode
    : undefined;
}

function positiveNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function booleanQuery(value: unknown, fallback: boolean) {
  if (value === undefined) return fallback;
  if (value === true || value === "true" || value === "1") return true;
  if (value === false || value === "false" || value === "0") return false;
  return fallback;
}

function stringQueryList(value: unknown, maxLength: number) {
  const values = Array.isArray(value)
    ? value
    : value === undefined
      ? []
      : [value];
  return values.map((item) => text(item, maxLength)).filter(Boolean);
}

function runBudgetPayload(value: unknown) {
  const payload = objectPayload(value);
  return {
    maxSteps: positiveNumber(payload.maxSteps),
    maxToolCalls: positiveNumber(payload.maxToolCalls),
    maxTokens: positiveNumber(payload.maxTokens),
    maxCostUsd: positiveNumber(payload.maxCostUsd),
    maxWallTimeMs: positiveNumber(payload.maxWallTimeMs),
  };
}

function userContext(res: { locals: Record<string, unknown> }) {
  return {
    userId: res.locals.userId as string,
    userEmail: res.locals.userEmail as string | undefined,
  };
}

function handleRouteError(
  res: { status: (code: number) => { json: (body: unknown) => void } },
  error: unknown,
) {
  if (error instanceof LocalAdapterNotReadyError) {
    return void res.status(501).json({
      detail:
        "Local Aletheia storage is scaffolded but not enabled for API traffic yet.",
    });
  }
  if (error instanceof ApprovalRequiredError) {
    return void res.status(409).json({
      code: "approval_required",
      detail: error.message,
    });
  }
  if (error instanceof CapabilityNotAvailableError) {
    return void res.status(501).json({
      code: "capability_not_available",
      detail: error.message,
    });
  }
  const message = error instanceof Error ? error.message : "Unexpected error";
  res.status(500).json({ detail: message });
}

function auditPackContent(detail: any) {
  return {
    schemaVersion: "aletheia-audit-pack-v0",
    exportedAt: new Date().toISOString(),
    matter: detail.matter,
    documents: detail.documents ?? [],
    workProducts: detail.workProducts ?? [],
    evidence: detail.evidence ?? [],
    reviews: detail.reviews ?? [],
    auditEvents: detail.auditEvents ?? [],
    agentRuns: detail.agentRuns ?? [],
    matterMemory: detail.matterMemory ?? [],
    playbooks: detail.playbooks ?? [],
  };
}

function toolAdapterManifest() {
  return {
    name: "Aletheia Tool Adapter",
    version: "aletheia-tool-adapter-v0",
    policy: {
      posture: "least_privilege",
      localFirst: true,
      dangerousToolsDisabledByDefault: true,
      highRiskActionsRequireHumanApproval: true,
    },
    tools: TOOL_ADAPTER_TOOLS.map((name) => ({ name, enabled: true })),
    disabledTools: DISABLED_TOOL_ADAPTER_TOOLS.map((name) => ({
      name,
      enabled: false,
    })),
  };
}

// GET /aletheia/tool-adapter/tools
aletheiaRouter.get("/tool-adapter/tools", requireAuth, (_req, res) => {
  res.json(toolAdapterManifest());
});

// POST /aletheia/tool-adapter/tools/:toolName/call
aletheiaRouter.post(
  "/tool-adapter/tools/:toolName/call",
  requireAuth,
  async (req, res) => {
    const toolName = text(req.params.toolName, 120);
    if (!isToolAdapterTool(toolName)) {
      return void res.status(404).json({ detail: "Tool is not available" });
    }

    const args = toolArgs(req.body?.args ?? req.body);
    const ctx = userContext(res);
    const repo = createAletheiaRepository();

    try {
      if (toolName === "list_matters") {
        const result = await repo.listMatters(ctx);
        return void res.json({ tool: toolName, result });
      }

      const matterId = text(args.matterId, 120);
      if (!matterId) {
        return void res.status(400).json({ detail: "matterId is required" });
      }

      if (toolName === "read_matter") {
        const result = await repo.getMatterDetail(ctx, matterId);
        if (!result) {
          return void res.status(404).json({ detail: "Matter not found" });
        }
        return void res.json({ tool: toolName, result });
      }

      if (toolName === "search_matter_documents") {
        const query = text(args.query, 400);
        const rawLimit =
          typeof args.limit === "number"
            ? args.limit
            : typeof args.limit === "string"
              ? Number(args.limit)
              : undefined;
        if (!query) {
          return void res.status(400).json({ detail: "query is required" });
        }
        const result = await repo.searchMatterDocuments(ctx, matterId, {
          query,
          limit: Number.isFinite(rawLimit) ? rawLimit : undefined,
          mode: retrievalMode(args.mode),
        });
        if (!result) {
          return void res.status(404).json({ detail: "Matter not found" });
        }
        return void res.json({ tool: toolName, result });
      }

      if (toolName === "read_evidence_item") {
        const evidenceItemId = text(args.evidenceItemId, 120);
        if (!evidenceItemId) {
          return void res
            .status(400)
            .json({ detail: "evidenceItemId is required" });
        }
        const detail: any = await repo.getMatterDetail(ctx, matterId);
        if (!detail) {
          return void res.status(404).json({ detail: "Matter not found" });
        }
        const result = (detail.evidence ?? []).find(
          (item: { id?: string }) => item.id === evidenceItemId,
        );
        if (!result) {
          return void res
            .status(404)
            .json({ detail: "Evidence item not found" });
        }
        return void res.json({ tool: toolName, result });
      }

      if (toolName === "create_work_product") {
        const kind = text(args.kind, 80);
        const title = text(args.title, 240);
        const status = text(args.status, 40) || "generated";
        const generatedBy = text(args.generatedBy, 40) || "agent";

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
          return void res
            .status(400)
            .json({ detail: "generatedBy is invalid" });
        }
        const result = await repo.createWorkProduct(ctx, matterId, {
          kind,
          title,
          status,
          schemaVersion: text(args.schemaVersion, 120) || "aletheia-v0",
          content: objectPayload(args.content),
          validationErrors: arrayPayload(args.validationErrors),
          generatedBy: generatedBy as "system" | "agent" | "human",
          model: nullableText(args.model, 120),
          approvalCheckpointId: nullableText(args.approvalCheckpointId, 120),
        });
        if (!result) {
          return void res.status(404).json({ detail: "Matter not found" });
        }
        return void res.status(201).json({ tool: toolName, result });
      }

      if (toolName === "add_review_tag") {
        const targetType = text(args.targetType, 80);
        const targetId = text(args.targetId, 240);
        const tag = text(args.tag, 80);
        const comment = text(args.comment, 4000);

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
        const result = await repo.addReview(ctx, matterId, {
          targetType,
          targetId,
          tag,
          comment,
          workProductId: nullableText(args.workProductId, 120),
          evidenceItemId: nullableText(args.evidenceItemId, 120),
          reviewerName: nullableText(args.reviewerName, 240),
        });
        if (!result) {
          return void res.status(404).json({ detail: "Matter not found" });
        }
        return void res.status(201).json({ tool: toolName, result });
      }

      if (toolName === "append_audit_event") {
        const actor = text(args.actor, 40) || "agent";
        const action = text(args.action, 120);

        if (!ACTORS.has(actor)) {
          return void res.status(400).json({ detail: "actor is invalid" });
        }
        if (!action) {
          return void res.status(400).json({ detail: "action is required" });
        }
        const result = await repo.appendAuditEvent(ctx, matterId, {
          actor: actor as "system" | "agent" | "human",
          action,
          workflowVersion: nullableText(args.workflowVersion, 120),
          model: nullableText(args.model, 120),
          details: objectPayload(args.details),
        });
        if (!result) {
          return void res.status(404).json({ detail: "Matter not found" });
        }
        return void res.status(201).json({ tool: toolName, result });
      }

      if (toolName === "export_audit_pack") {
        const detail: any = await repo.getMatterDetail(ctx, matterId);
        if (!detail) {
          return void res.status(404).json({ detail: "Matter not found" });
        }
        const result = await repo.createWorkProduct(ctx, matterId, {
          kind: "audit_pack",
          title:
            text(args.title, 240) ||
            `${String(detail.matter?.title ?? "Matter")} Audit Pack`,
          status: "generated",
          schemaVersion: "aletheia-audit-pack-v0",
          content: auditPackContent(detail),
          validationErrors: [],
          generatedBy: "agent",
          model: null,
          approvalCheckpointId: nullableText(args.approvalCheckpointId, 120),
        });
        if (!result) {
          return void res.status(404).json({ detail: "Matter not found" });
        }
        return void res.status(201).json({ tool: toolName, result });
      }

      return void res.status(404).json({ detail: "Tool is not available" });
    } catch (error) {
      handleRouteError(res, error);
    }
  },
);

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
          approvalCheckpointId: nullableText(
            req.body?.approvalCheckpointId,
            120,
          ),
        },
      );
      if (!data)
        return void res.status(404).json({ detail: "Matter not found" });
      res.status(201).json(data);
    } catch (error) {
      handleRouteError(res, error);
    }
  },
);

// POST /aletheia/matters/:matterId/gate-snapshots
aletheiaRouter.post(
  "/matters/:matterId/gate-snapshots",
  requireAuth,
  async (req, res) => {
    const action = text(req.body?.action, 80);
    if (action !== "final_memo_export") {
      return void res.status(400).json({ detail: "action is invalid" });
    }

    try {
      const data = await createAletheiaRepository().persistGateSnapshot(
        userContext(res),
        req.params.matterId,
        {
          action,
          approvalCheckpointId: nullableText(
            req.body?.approvalCheckpointId,
            120,
          ),
          content: objectPayload(req.body?.content),
        },
      );
      if (!data)
        return void res.status(404).json({ detail: "Matter not found" });
      res.status(201).json(data);
    } catch (error) {
      handleRouteError(res, error);
    }
  },
);

// POST /aletheia/matters/:matterId/reviews
aletheiaRouter.post(
  "/matters/:matterId/reviews",
  requireAuth,
  async (req, res) => {
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
      if (!data)
        return void res.status(404).json({ detail: "Matter not found" });
      res.status(201).json(data);
    } catch (error) {
      handleRouteError(res, error);
    }
  },
);

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
      if (!data)
        return void res.status(404).json({ detail: "Matter not found" });
      res.status(201).json(data);
    } catch (error) {
      handleRouteError(res, error);
    }
  },
);

// POST /aletheia/matters/:matterId/approvals
aletheiaRouter.post(
  "/matters/:matterId/approvals",
  requireAuth,
  async (req, res) => {
    const action = text(req.body?.action, 80);
    if (
      ![
        "audit_pack_export",
        "feedback_dataset_export",
        "final_memo_export",
      ].includes(action)
    ) {
      return void res.status(400).json({ detail: "action is invalid" });
    }

    try {
      const data = await createAletheiaRepository().requestApproval(
        userContext(res),
        req.params.matterId,
        {
          action: action as
            | "audit_pack_export"
            | "feedback_dataset_export"
            | "final_memo_export",
          prompt: nullableText(req.body?.prompt, 1000),
          requestedPayload: objectPayload(req.body?.requestedPayload),
        },
      );
      if (!data)
        return void res.status(404).json({ detail: "Matter not found" });
      res.status(201).json(data);
    } catch (error) {
      handleRouteError(res, error);
    }
  },
);

// POST /aletheia/matters/:matterId/approvals/:checkpointId/decision
aletheiaRouter.post(
  "/matters/:matterId/approvals/:checkpointId/decision",
  requireAuth,
  async (req, res) => {
    const decision = text(req.body?.decision, 40);
    if (!["approved", "rejected", "edited", "responded"].includes(decision)) {
      return void res.status(400).json({ detail: "decision is invalid" });
    }

    try {
      const data = await createAletheiaRepository().decideApproval(
        userContext(res),
        req.params.matterId,
        req.params.checkpointId,
        {
          decision: decision as
            | "approved"
            | "rejected"
            | "edited"
            | "responded",
          comment: nullableText(req.body?.comment, 1000),
          editedPayload: objectPayload(req.body?.editedPayload),
          response: nullableText(req.body?.response, 4000),
        },
      );
      if (!data) {
        return void res
          .status(404)
          .json({ detail: "Matter or approval checkpoint not found" });
      }
      res.json(data);
    } catch (error) {
      handleRouteError(res, error);
    }
  },
);

// POST /aletheia/matters/:matterId/memory
aletheiaRouter.post(
  "/matters/:matterId/memory",
  requireAuth,
  async (req, res) => {
    const category = text(req.body?.category, 80);
    const title = text(req.body?.title, 240);
    const body = text(req.body?.body, 4000);
    const source = text(req.body?.source, 40) || "human";

    if (!MATTER_MEMORY_CATEGORIES.has(category)) {
      return void res.status(400).json({ detail: "category is invalid" });
    }
    if (!title)
      return void res.status(400).json({ detail: "title is required" });
    if (!body) return void res.status(400).json({ detail: "body is required" });
    if (!["human", "review", "system"].includes(source)) {
      return void res.status(400).json({ detail: "source is invalid" });
    }

    try {
      const data = await createAletheiaRepository().addMatterMemory(
        userContext(res),
        req.params.matterId,
        {
          category: category as
            | "confirmed_fact"
            | "output_preference"
            | "excluded_path"
            | "missing_material"
            | "reviewer_feedback",
          title,
          body,
          source: source as "human" | "review" | "system",
          metadata: objectPayload(req.body?.metadata),
        },
      );
      if (!data)
        return void res.status(404).json({ detail: "Matter not found" });
      res.status(201).json(data);
    } catch (error) {
      handleRouteError(res, error);
    }
  },
);

// POST /aletheia/matters/:matterId/playbooks
aletheiaRouter.post(
  "/matters/:matterId/playbooks",
  requireAuth,
  async (req, res) => {
    const name = text(req.body?.name, 240);
    const description = nullableText(req.body?.description, 1000);
    const version = nullableText(req.body?.version, 80) ?? "v0.1";
    const status = text(req.body?.status, 40) || "draft";

    if (!name) return void res.status(400).json({ detail: "name is required" });
    if (!PLAYBOOK_STATUSES.has(status) || status !== "draft") {
      return void res
        .status(400)
        .json({ detail: "playbooks must be drafted before approval" });
    }

    try {
      const data = await createAletheiaRepository().createPlaybook(
        userContext(res),
        req.params.matterId,
        {
          name,
          description,
          version,
          content: objectPayload(req.body?.content),
        },
      );
      if (!data)
        return void res.status(404).json({ detail: "Matter not found" });
      res.status(201).json(data);
    } catch (error) {
      handleRouteError(res, error);
    }
  },
);

// POST /aletheia/matters/:matterId/playbooks/improvement-proposals
aletheiaRouter.post(
  "/matters/:matterId/playbooks/improvement-proposals",
  requireAuth,
  async (req, res) => {
    const includeReviewTags = arrayPayload(req.body?.includeReviewTags)
      .map((item) => text(item, 80))
      .filter((item) => REVIEW_TAGS.has(item));
    try {
      const data = await createAletheiaRepository().proposePlaybookImprovement(
        userContext(res),
        req.params.matterId,
        {
          sourcePlaybookId: nullableText(req.body?.sourcePlaybookId, 120),
          title: nullableText(req.body?.title, 240),
          reviewerNote: nullableText(req.body?.reviewerNote, 2000),
          includeReviewTags,
        },
      );
      if (!data)
        return void res.status(404).json({ detail: "Matter not found" });
      res.status(201).json(data);
    } catch (error) {
      handleRouteError(res, error);
    }
  },
);

// POST /aletheia/matters/:matterId/playbooks/:playbookId/approve
aletheiaRouter.post(
  "/matters/:matterId/playbooks/:playbookId/approve",
  requireAuth,
  async (req, res) => {
    try {
      const data = await createAletheiaRepository().approvePlaybook(
        userContext(res),
        req.params.matterId,
        req.params.playbookId,
      );
      if (!data) {
        return void res
          .status(404)
          .json({ detail: "Matter or playbook not found" });
      }
      res.json(data);
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
          budget: runBudgetPayload(req.body?.budget),
          metadata: objectPayload(req.body?.metadata),
        },
      );
      if (!data)
        return void res.status(404).json({ detail: "Matter not found" });
      res.status(201).json(data);
    } catch (error) {
      handleRouteError(res, error);
    }
  },
);

// POST /aletheia/matters/:matterId/agent-runs/:runId/resume
aletheiaRouter.post(
  "/matters/:matterId/agent-runs/:runId/resume",
  requireAuth,
  async (req, res) => {
    const checkpointId = text(req.body?.checkpointId, 120);
    if (!checkpointId) {
      return void res.status(400).json({ detail: "checkpointId is required" });
    }
    try {
      const data = await createAletheiaRepository().resumeAgentRun(
        userContext(res),
        req.params.matterId,
        req.params.runId,
        {
          checkpointId,
          note: nullableText(req.body?.note, 1000),
        },
      );
      if (!data) {
        return void res
          .status(404)
          .json({ detail: "Matter, run, or checkpoint not found" });
      }
      res.json(data);
    } catch (error) {
      handleRouteError(res, error);
    }
  },
);

// POST /aletheia/matters/:matterId/evidence-matrix
aletheiaRouter.post(
  "/matters/:matterId/evidence-matrix",
  requireAuth,
  async (req, res) => {
    try {
      const data = await createAletheiaRepository().generateEvidenceMatrix(
        userContext(res),
        req.params.matterId,
      );
      if (!data)
        return void res.status(404).json({ detail: "Matter not found" });
      res.status(201).json(data);
    } catch (error) {
      handleRouteError(res, error);
    }
  },
);

// POST /aletheia/matters/:matterId/issue-map
aletheiaRouter.post(
  "/matters/:matterId/issue-map",
  requireAuth,
  async (req, res) => {
    try {
      const data = await createAletheiaRepository().generateIssueMap(
        userContext(res),
        req.params.matterId,
      );
      if (!data)
        return void res.status(404).json({ detail: "Matter not found" });
      res.status(201).json(data);
    } catch (error) {
      handleRouteError(res, error);
    }
  },
);

// POST /aletheia/matters/:matterId/draft-memo
aletheiaRouter.post(
  "/matters/:matterId/draft-memo",
  requireAuth,
  async (req, res) => {
    try {
      const data = await createAletheiaRepository().generateDraftMemo(
        userContext(res),
        req.params.matterId,
      );
      if (!data)
        return void res.status(404).json({ detail: "Matter not found" });
      res.status(201).json(data);
    } catch (error) {
      handleRouteError(res, error);
    }
  },
);

// POST /aletheia/matters/:matterId/evidence-items
aletheiaRouter.post(
  "/matters/:matterId/evidence-items",
  requireAuth,
  async (req, res) => {
    const sourceChunkId = text(req.body?.sourceChunkId, 120);
    const claimId = text(req.body?.claimId, 240);
    const relevance = text(req.body?.relevance, 40) || "direct";
    const supportStatus = text(req.body?.supportStatus, 40) || "supports";
    const confidence = nullableText(req.body?.confidence, 40);

    if (!sourceChunkId) {
      return void res.status(400).json({ detail: "sourceChunkId is required" });
    }
    if (!EVIDENCE_RELEVANCE.has(relevance)) {
      return void res.status(400).json({ detail: "relevance is invalid" });
    }
    if (!EVIDENCE_SUPPORT_STATUS.has(supportStatus)) {
      return void res.status(400).json({ detail: "supportStatus is invalid" });
    }
    if (confidence && !RISK_LEVELS.has(confidence)) {
      return void res.status(400).json({ detail: "confidence is invalid" });
    }

    try {
      const data = await createAletheiaRepository().createEvidenceItem(
        userContext(res),
        req.params.matterId,
        {
          sourceChunkId,
          claimId: claimId || null,
          relevance: relevance as "direct" | "indirect" | "weak",
          supportStatus: supportStatus as
            | "supports"
            | "contradicts"
            | "insufficient",
          workProductId: nullableText(req.body?.workProductId, 80),
          confidence: confidence as "low" | "medium" | "high" | null,
          metadata: objectPayload(req.body?.metadata),
        },
      );
      if (!data) {
        return void res
          .status(404)
          .json({ detail: "Matter or source chunk not found" });
      }
      res.status(201).json(data);
    } catch (error) {
      handleRouteError(res, error);
    }
  },
);

// GET /aletheia/matters/:matterId/v1/source-index
aletheiaRouter.get(
  "/matters/:matterId/v1/source-index",
  requireAuth,
  async (req, res) => {
    const rawLimit =
      typeof req.query.chunkLimit === "string"
        ? Number(req.query.chunkLimit)
        : undefined;
    const documentIds = stringQueryList(req.query.documentId, 120);

    try {
      const data = await createAletheiaRepository().listV1SourceIndex(
        userContext(res),
        req.params.matterId,
        {
          includeChunks: booleanQuery(req.query.includeChunks, true),
          includeEvidenceLinks: booleanQuery(
            req.query.includeEvidenceLinks,
            true,
          ),
          chunkLimit: Number.isFinite(rawLimit) ? rawLimit : undefined,
          documentIds,
        },
      );
      if (!data) {
        return void res.status(404).json({ detail: "Matter not found" });
      }
      res.json(data);
    } catch (error) {
      handleRouteError(res, error);
    }
  },
);

// POST /aletheia/matters/:matterId/documents
aletheiaRouter.post(
  "/matters/:matterId/documents",
  requireAuth,
  singleFileUpload("file"),
  async (req, res) => {
    const file = req.file;
    if (!file) {
      return void res.status(400).json({ detail: "file is required" });
    }

    try {
      const data = await createAletheiaRepository().uploadMatterDocument(
        userContext(res),
        req.params.matterId,
        {
          filename: file.originalname,
          mimeType: file.mimetype,
          sizeBytes: file.size,
          buffer: file.buffer,
        },
      );
      if (!data)
        return void res.status(404).json({ detail: "Matter not found" });
      res.status(201).json(data);
    } catch (error) {
      handleRouteError(res, error);
    }
  },
);

// POST /aletheia/matters/:matterId/documents/batch
aletheiaRouter.post(
  "/matters/:matterId/documents/batch",
  requireAuth,
  multiFileUpload("files", 100),
  async (req, res) => {
    const files = Array.isArray(req.files)
      ? (req.files as Express.Multer.File[])
      : [];
    if (files.length === 0) {
      return void res.status(400).json({ detail: "files are required" });
    }

    const repo = createAletheiaRepository();
    const ctx = userContext(res);
    const documents: unknown[] = [];
    const errors: Array<{ filename: string; detail: string }> = [];

    for (const file of files) {
      try {
        const data = await repo.uploadMatterDocument(ctx, req.params.matterId, {
          filename: file.originalname,
          mimeType: file.mimetype,
          sizeBytes: file.size,
          buffer: file.buffer,
        });
        if (!data) {
          return void res.status(404).json({ detail: "Matter not found" });
        }
        documents.push(data);
      } catch (error) {
        errors.push({
          filename: file.originalname,
          detail:
            error instanceof Error ? error.message : "Document upload failed",
        });
      }
    }

    res.status(errors.length > 0 ? 207 : 201).json({
      schema_version: "aletheia-document-import-batch-v0",
      matter_id: req.params.matterId,
      total: files.length,
      imported: documents.length,
      failed: errors.length,
      documents,
      errors,
    });
  },
);

// GET /aletheia/matters/:matterId/documents/search?q=...
aletheiaRouter.get(
  "/matters/:matterId/documents/search",
  requireAuth,
  async (req, res) => {
    const query = text(req.query.q, 400);
    const rawLimit =
      typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
    const mode = retrievalMode(req.query.mode);
    if (!query) {
      return void res.status(400).json({ detail: "q is required" });
    }

    try {
      const data = await createAletheiaRepository().searchMatterDocuments(
        userContext(res),
        req.params.matterId,
        {
          query,
          limit: Number.isFinite(rawLimit) ? rawLimit : undefined,
          mode,
        },
      );
      if (!data)
        return void res.status(404).json({ detail: "Matter not found" });
      res.json(data);
    } catch (error) {
      handleRouteError(res, error);
    }
  },
);
