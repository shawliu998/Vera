import { Router } from "express";
import { createAletheiaRepository } from "../lib/aletheia";
import {
  isValidLegalResearchRequest,
  LEGAL_ISSUE_TREE_SCHEMA,
  LegalIssueTreeError,
  validateLegalIssueTree,
} from "../lib/aletheia/legalIssues";
import type { AletheiaRepository, AletheiaUserContext } from "../lib/aletheia/repository";
import { requireAuth } from "../middleware/auth";

type WorkProduct = {
  id: string;
  kind: string;
  content: Record<string, unknown>;
  version?: number;
  created_at?: string;
};

type LegalResearchIssuesRouterOptions = {
  createRepository?: () => AletheiaRepository;
};

class LegalResearchIssuesRouteError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
    this.name = "LegalResearchIssuesRouteError";
  }
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function userContext(res: { locals: Record<string, unknown> }): AletheiaUserContext {
  return {
    userId: String(res.locals.userId),
    userEmail: typeof res.locals.userEmail === "string" ? res.locals.userEmail : undefined,
  };
}

function workProducts(detail: unknown): WorkProduct[] {
  const products = object(detail).workProducts;
  if (!Array.isArray(products)) return [];
  return products.flatMap((value) => {
    const product = object(value);
    if (typeof product.id !== "string" || typeof product.kind !== "string") return [];
    return [{
      id: product.id,
      kind: product.kind,
      content: object(product.content),
      version: typeof product.version === "number" ? product.version : undefined,
      created_at: typeof product.created_at === "string" ? product.created_at : undefined,
    }];
  });
}

function ownedResearchRequest(detail: unknown, requestId: string) {
  const request = workProducts(detail).find(
    (product) => product.id === requestId && product.kind === "legal_research_request",
  );
  if (!request) {
    throw new LegalResearchIssuesRouteError("The requested local research record was not found.", 404, "not_found");
  }
  if (!isValidLegalResearchRequest(request.content)) {
    throw new LegalResearchIssuesRouteError("The research request is malformed.", 409, "invalid_state");
  }
  return request;
}

function latestIssueTree(detail: unknown, requestId: string) {
  const candidates = workProducts(detail).filter((product) =>
    product.kind === "legal_research_issue_tree" &&
    product.content.schemaVersion === LEGAL_ISSUE_TREE_SCHEMA &&
    product.content.requestId === requestId,
  );
  return candidates.sort((left, right) =>
    Number(right.version ?? 0) - Number(left.version ?? 0) ||
    String(right.created_at ?? "").localeCompare(String(left.created_at ?? "")),
  )[0] ?? null;
}

function routeError(res: { status: (status: number) => { json: (body: unknown) => void } }, error: unknown) {
  if (error instanceof LegalResearchIssuesRouteError) {
    return void res.status(error.status).json({ code: error.code, detail: error.message });
  }
  if (error instanceof LegalIssueTreeError) {
    return void res.status(400).json({ code: error.code, detail: error.message });
  }
  res.status(500).json({ code: "legal_issue_tree_failed", detail: "The local legal issue tree could not be completed." });
}

export function createLegalResearchIssuesRouter(options: LegalResearchIssuesRouterOptions = {}) {
  const router = Router();
  const repository = options.createRepository ?? createAletheiaRepository;

  router.post("/matters/:matterId/research/requests/:requestId/issues", requireAuth, async (req, res) => {
    try {
      const ctx = userContext(res);
      const detail = await repository().getMatterDetail(ctx, req.params.matterId);
      if (!detail) return void res.status(404).json({ code: "not_found", detail: "Matter not found." });
      ownedResearchRequest(detail, req.params.requestId);
      const tree = validateLegalIssueTree(req.body);
      const result = await repository().createWorkProduct(ctx, req.params.matterId, {
        kind: "legal_research_issue_tree",
        title: "Legal issue tree",
        status: "accepted",
        schemaVersion: LEGAL_ISSUE_TREE_SCHEMA,
        content: {
          schemaVersion: LEGAL_ISSUE_TREE_SCHEMA,
          requestId: req.params.requestId,
          tree,
        },
        validationErrors: [],
        generatedBy: "human",
        model: null,
      });
      if (!result) return void res.status(404).json({ code: "not_found", detail: "Matter not found." });
      await repository().appendAuditEvent(ctx, req.params.matterId, {
        actor: "human",
        action: "legal_research_issue_tree_recorded",
        workflowVersion: LEGAL_ISSUE_TREE_SCHEMA,
        model: null,
        details: {
          issueTreeId: (result as WorkProduct).id,
          requestId: req.params.requestId,
          nodeCount: tree.nodeCount,
          maxDepth: tree.maxDepth,
          statusCounts: tree.statusCounts,
          treeHash: tree.treeHash,
          contentHash: (result as Record<string, unknown>).content_hash ?? null,
        },
      });
      res.status(201).json(result);
    } catch (error) {
      routeError(res, error);
    }
  });

  router.get("/matters/:matterId/research/requests/:requestId/issues", requireAuth, async (req, res) => {
    try {
      const ctx = userContext(res);
      const detail = await repository().getMatterDetail(ctx, req.params.matterId);
      if (!detail) return void res.status(404).json({ code: "not_found", detail: "Matter not found." });
      ownedResearchRequest(detail, req.params.requestId);
      const issueTree = latestIssueTree(detail, req.params.requestId);
      if (!issueTree) return void res.status(404).json({ code: "not_found", detail: "No local issue tree exists for this research request." });
      res.json(issueTree);
    } catch (error) {
      routeError(res, error);
    }
  });

  return router;
}

export const legalResearchIssuesRouter = createLegalResearchIssuesRouter();
