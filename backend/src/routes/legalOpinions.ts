import { Router } from "express";
import { createAletheiaRepository } from "../lib/aletheia";
import type { AletheiaRepository, AletheiaUserContext } from "../lib/aletheia/repository";
import { ApprovalRequiredError } from "../lib/aletheia/repository";
import { requireAuth } from "../middleware/auth";

type LegalOpinionRouterOptions = {
  createRepository?: () => AletheiaRepository;
};

function context(res: { locals: Record<string, unknown> }): AletheiaUserContext {
  return {
    userId: String(res.locals.userId),
    userEmail: typeof res.locals.userEmail === "string" ? res.locals.userEmail : undefined,
  };
}

function text(value: unknown, maximum: number) {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function cover(value: unknown) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("cover must be an object.");
  }
  const input = value as Record<string, unknown>;
  const allowed = new Set(["title", "addressee", "limitation", "lawyerReference"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new Error("cover only permits title, addressee, limitation, and lawyerReference.");
  }
  return {
    title: text(input.title, 240) || null,
    addressee: text(input.addressee, 240) || null,
    limitation: text(input.limitation, 2000) || null,
    lawyerReference: text(input.lawyerReference, 240) || null,
  };
}

function disposition(title: string, version: number) {
  const base = (title.normalize("NFKD").replace(/[^A-Za-z0-9._ -]+/g, "-").replace(/\s+/g, "-").slice(0, 90) || "legal-opinion").replace(/^-+|-+$/g, "");
  const unicode = `${title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").trim().slice(0, 90) || "legal-opinion"}-v${version}.docx`;
  return `attachment; filename="${base || "legal-opinion"}-v${version}.docx"; filename*=UTF-8''${encodeURIComponent(unicode)}`;
}

function routeError(res: any, error: unknown) {
  if (error instanceof ApprovalRequiredError) {
    return void res.status(409).json({ code: "approval_required", detail: error.message });
  }
  res.status(400).json({ code: "invalid_input", detail: error instanceof Error ? error.message : "The legal opinion request could not be completed." });
}

export function createLegalOpinionsRouter(options: LegalOpinionRouterOptions = {}) {
  const router = Router();
  const repository = options.createRepository ?? createAletheiaRepository;

  router.post("/matters/:matterId/legal-opinions", requireAuth, async (req, res) => {
    try {
      const answerId = text(req.body?.answerId, 160);
      if (!answerId) throw new Error("answerId is required.");
      const result = await repository().createLegalOpinion(context(res), req.params.matterId, {
        answerId,
        cover: cover(req.body?.cover),
      });
      if (!result) return void res.status(404).json({ code: "not_found", detail: "Matter not found." });
      res.status(201).json(result);
    } catch (error) {
      routeError(res, error);
    }
  });

  router.post("/matters/:matterId/legal-opinions/:opinionId/approve", requireAuth, async (req, res) => {
    try {
      const result = await repository().approveLegalOpinion(context(res), req.params.matterId, req.params.opinionId);
      if (!result) return void res.status(404).json({ code: "not_found", detail: "Legal opinion not found." });
      res.json(result);
    } catch (error) {
      routeError(res, error);
    }
  });

  router.post("/matters/:matterId/legal-opinions/:opinionId/docx", requireAuth, async (req, res) => {
    try {
      const result = await repository().exportLegalOpinionDocx(context(res), req.params.matterId, req.params.opinionId);
      if (!result) return void res.status(404).json({ code: "not_found", detail: "Legal opinion not found." });
      res.status(201).json(result);
    } catch (error) {
      routeError(res, error);
    }
  });

  router.get("/matters/:matterId/legal-opinion-exports/:exportId/download", requireAuth, async (req, res) => {
    try {
      const result = await repository().downloadLegalOpinionDocx(context(res), req.params.matterId, req.params.exportId);
      if (!result) return void res.status(404).json({ code: "not_found", detail: "Legal opinion export not found." });
      res.status(200);
      res.setHeader("Content-Type", result.mimeType);
      res.setHeader("Content-Disposition", disposition(result.title, result.version));
      res.setHeader("Content-Length", String(result.bytes.length));
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.send(result.bytes);
    } catch (error) {
      routeError(res, error);
    }
  });

  return router;
}

export const legalOpinionsRouter = createLegalOpinionsRouter();
