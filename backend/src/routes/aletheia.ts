import { Router } from "express";
import { createHash } from "node:crypto";
import { createAletheiaRepository } from "../lib/aletheia";
import { redactPublicMatterDocument } from "../lib/aletheia/localRepository";
import { getAuthoritativeRuntimeSettings } from "../lib/aletheia/localControlRepository";
import {
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
  DocumentParseRetryError,
  LocalAdapterNotReadyError,
  MatterOriginalDocumentAuditError,
  MatterOriginalDocumentIntegrityError,
} from "../lib/aletheia/repository";
import type { V1RuntimePersistenceInput } from "../lib/aletheia/v1RuntimePersistence";
import { requireAuth } from "../middleware/auth";
import {
  cleanupUploadedFiles,
  materializeUploadedFile,
  multiFileUpload,
  singleFileUpload,
  uploadedDocumentValidationError,
} from "../lib/upload";
import {
  ExternalSourceFetchPolicyError,
  fetchAllowlistedExternalSource,
} from "../lib/aletheia/externalSourceFetch";
import {
  externalAuditActionHelp,
  isAllowedExternalAuditAction,
} from "../lib/aletheia/auditActionPolicy";
import {
  MalwareScanBlockedError,
  malwareScannerPolicy,
  scanLocalUpload,
} from "../lib/aletheia/malwareScanner";
import { localEncryptionStatus } from "../lib/aletheia/localEnvelopeCrypto";
import { auditAnchorRuntimeStatus } from "../lib/aletheia/auditAnchorJournal";
import { GovernancePolicyError } from "../lib/aletheia/localGovernance";
import {
  ContentDisarmBlockedError,
  contentDisarmPolicy,
  disarmLocalUpload,
} from "../lib/aletheia/contentDisarm";

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

function configuredEvidenceIndexMode(userId: string) {
  const configured = getAuthoritativeRuntimeSettings(userId).evidenceIndex;
  return configured === "Hybrid"
    ? "hybrid"
    : configured === "Semantic"
      ? "semantic"
      : "keyword";
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

function reviewResolutionStatus(value: unknown) {
  const status = text(value, 40);
  return ["accepted", "rejected", "needs_material", "resolved"].includes(status)
    ? status
    : "";
}

function optionalBooleanPayload(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}

function originalDocumentContentDisposition(filename: string) {
  const extension = text(filename.split(".").pop(), 12).toLowerCase();
  const safeExtension = ["pdf", "docx", "xlsx", "txt", "md"].includes(extension)
    ? `.${extension}`
    : "";
  const unicodeBase =
    filename
      .normalize("NFC")
      .replace(/.*[\\/]/, "")
      .replace(/\.[^.]*$/, "")
      .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 100) || "original-document";
  const asciiBase =
    unicodeBase
      .normalize("NFKD")
      .replace(/[^\x20-\x7e]/g, "")
      .replace(/[^A-Za-z0-9._ -]+/g, "-")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^[.-]+|[.-]+$/g, "")
      .toLowerCase()
      .slice(0, 100) || "original-document";
  const unicodeFilename = `${unicodeBase}${safeExtension}`;
  const encodedFilename = encodeURIComponent(unicodeFilename).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${asciiBase}${safeExtension}"; filename*=UTF-8''${encodedFilename}`;
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

const V1_RUNTIME_STATUSES = new Set([
  "queued",
  "working",
  "blocked",
  "review_needed",
  "waiting_for_approval",
  "done",
  "failed",
  "cancelled",
]);

const V1_TRACE_LEVELS = new Set(["debug", "info", "warning", "error"]);
const V1_TOOL_STATUSES = new Set(["started", "succeeded", "failed", "skipped"]);
const V1_AUDIT_ACTORS = new Set(["human", "agent", "system"]);

function v1RuntimePayload(
  body: unknown,
): Omit<V1RuntimePersistenceInput, "userId" | "matterId"> | { error: string } {
  const payload = objectPayload(body);
  const workflow = text(payload.workflow, 120) || "legal_matter_review";
  const goal = text(payload.goal, 2000);
  const run = objectPayload(payload.run);
  const runId = text(run.id, 160);
  const agentId = text(run.agent_id, 160);
  const startedAt = text(run.started_at, 80);
  const runStatus = text(run.status, 40);

  if (!TEMPLATES.has(workflow)) return { error: "workflow is invalid" };
  if (!goal) return { error: "goal is required" };
  if (!runId) return { error: "run.id is required" };
  if (!agentId) return { error: "run.agent_id is required" };
  if (!startedAt) return { error: "run.started_at is required" };
  if (!V1_RUNTIME_STATUSES.has(runStatus)) {
    return { error: "run.status is invalid" };
  }

  const traceEvents = arrayPayload(run.trace_events).map((item, index) => {
    const event = objectPayload(item);
    const level = text(event.level, 40) || "info";
    return {
      id: text(event.id, 160) || `${runId}-trace-${index + 1}`,
      timestamp: text(event.timestamp, 80) || startedAt,
      level: V1_TRACE_LEVELS.has(level)
        ? (level as "debug" | "info" | "warning" | "error")
        : "info",
      message: text(event.message, 2000) || "V1 runtime trace event.",
      metadata: objectPayload(event.metadata),
    };
  });

  const toolCalls = arrayPayload(run.tool_calls).map((item, index) => {
    const call = objectPayload(item);
    const status = text(call.status, 40) || "skipped";
    return {
      id: text(call.id, 160) || `${runId}-tool-${index + 1}`,
      name: text(call.name, 160) || "v1_runtime_tool",
      started_at: text(call.started_at, 80) || startedAt,
      ended_at: nullableText(call.ended_at, 80) ?? undefined,
      status: V1_TOOL_STATUSES.has(status)
        ? (status as "started" | "succeeded" | "failed" | "skipped")
        : "skipped",
      input: call.input,
      output: call.output,
      error: nullableText(call.error, 2000) ?? undefined,
    };
  });

  const auditEvents = arrayPayload(payload.auditEvents).map((item, index) => {
    const event = objectPayload(item);
    const actor = text(event.actor_type, 40) || "system";
    return {
      id: text(event.id, 160) || `${runId}-audit-${index + 1}`,
      matter_id: "",
      actor_type: V1_AUDIT_ACTORS.has(actor)
        ? (actor as "human" | "agent" | "system")
        : "system",
      actor_id: text(event.actor_id, 160) || "v1-runtime",
      action: text(event.action, 160) || "v1_runtime_result_persisted",
      artifact_id: nullableText(event.artifact_id, 160) ?? undefined,
      artifact_type: nullableText(event.artifact_type, 160) ?? undefined,
      before_hash: nullableText(event.before_hash, 240) ?? undefined,
      after_hash: nullableText(event.after_hash, 240) ?? undefined,
      timestamp: text(event.timestamp, 80) || startedAt,
    };
  });

  const providerDecision = payload.providerDecision
    ? objectPayload(payload.providerDecision)
    : undefined;
  const tokenUsage = objectPayload(run.token_usage);

  return {
    workflow,
    goal,
    now: nullableText(payload.now, 80) ?? undefined,
    providerDecision: providerDecision
      ? {
          allowed: providerDecision.allowed === true,
          reason:
            text(providerDecision.reason, 1000) ||
            "V1 runtime provider policy decision.",
          externalCall: providerDecision.externalCall === true,
          provider: text(providerDecision.provider, 160) || "deterministic",
          model: text(providerDecision.model, 160) || "deterministic-v1",
          privacyMode: text(providerDecision.privacyMode, 80) || "private",
        }
      : undefined,
    run: {
      id: runId,
      matter_id: "",
      agent_id: agentId,
      started_at: startedAt,
      ended_at: nullableText(run.ended_at, 80) ?? undefined,
      status: runStatus as V1RuntimePersistenceInput["run"]["status"],
      tool_calls: toolCalls,
      trace_events: traceEvents,
      model: nullableText(run.model, 160) ?? undefined,
      token_usage:
        tokenUsage.total_tokens !== undefined
          ? {
              input_tokens: positiveNumber(tokenUsage.input_tokens) ?? 0,
              output_tokens: positiveNumber(tokenUsage.output_tokens) ?? 0,
              total_tokens: positiveNumber(tokenUsage.total_tokens) ?? 0,
            }
          : undefined,
      errors: arrayPayload(run.errors)
        .map((item) => text(item, 1000))
        .filter(Boolean),
    },
    auditEvents,
  };
}

function userContext(res: { locals: Record<string, unknown> }) {
  return {
    userId: res.locals.userId as string,
    userEmail: res.locals.userEmail as string | undefined,
  };
}

async function auditBlockedContentDisarm(
  res: { locals: Record<string, unknown> },
  matterId: string,
  error: unknown,
) {
  if (!(error instanceof ContentDisarmBlockedError)) return;
  try {
    await createAletheiaRepository().appendAuditEvent(
      userContext(res),
      matterId,
      {
        actor: "system",
        action: "content_disarm_blocked",
        workflowVersion: "aletheia-local-cdr-v1",
        model: null,
        details: {
          code: error.code,
          result: error.result.metadata,
        },
      },
    );
  } catch {
    // The original fail-closed result remains authoritative if audit cannot be
    // attached because the matter does not exist or is inaccessible.
  }
}

function handleRouteError(
  res: { status: (code: number) => { json: (body: unknown) => void } },
  error: unknown,
) {
  if (error instanceof ExternalSourceFetchPolicyError) {
    return void res.status(error.statusCode).json({
      code: "external_source_policy",
      detail: error.message,
    });
  }
  if (error instanceof MalwareScanBlockedError) {
    return void res
      .status(error.code === "malware_detected" ? 422 : 503)
      .json({ code: error.code, detail: error.message });
  }
  if (error instanceof ContentDisarmBlockedError) {
    const status =
      error.code === "cdr_unsupported"
        ? 415
        : error.code === "cdr_unavailable"
          ? 503
          : 422;
    return void res.status(status).json({
      code: error.code,
      detail: error.message,
      cdr: error.result.metadata,
    });
  }
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
  if (error instanceof DocumentParseRetryError) {
    return void res.status(error.status).json({
      code: error.code,
      detail: error.message,
      ...(error.document
        ? { document: redactPublicMatterDocument(error.document) }
        : {}),
    });
  }
  if (error instanceof MatterOriginalDocumentIntegrityError) {
    return void res.status(error.status).json({
      code: error.code,
      detail: error.message,
    });
  }
  if (error instanceof MatterOriginalDocumentAuditError) {
    return void res.status(error.status).json({
      code: error.code,
      detail: error.message,
    });
  }
  if (error instanceof GovernancePolicyError) {
    return void res
      .status(error.code === "EVIDENCE_LOCKED" ? 403 : error.status)
      .json({
        code: error.code,
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

function enforcedSecurityPolicy() {
  const applicationEncryption = localEncryptionStatus();
  return {
    schemaVersion: "aletheia-security-policy-v3",
    authority: "backend",
    localOnly: true,
    storageDriver: "local",
    externalModelsEnabled: false,
    finalExportPolicy: "fail_closed",
    approvalRequiredFor: [
      "audit_pack_export",
      "feedback_dataset_export",
      "final_memo_export",
      "litigation_artifact_export",
      "litigation_matter_audit_export",
      "litigation_template_publish",
      "litigation_template_retire",
      "external_source_use",
      "matter_purge",
    ],
    auditIntegrity: "per_matter_hmac_hash_chain",
    auditAnchor: auditAnchorRuntimeStatus(),
    filesystemPermissions: "owner_only",
    encryptionAtRest: {
      application: applicationEncryption,
      volume:
        process.env.ALETHEIA_ENCRYPTED_VOLUME_ATTESTED === "true"
          ? "operator_attested_encrypted_volume"
          : "not_attested",
    },
    retentionDays:
      positiveNumber(Number(process.env.ALETHEIA_RETENTION_DAYS)) ?? null,
    malwareScanning: malwareScannerPolicy(),
    contentDisarm: contentDisarmPolicy(),
  };
}

aletheiaRouter.get("/security-policy", requireAuth, (_req, res) => {
  res.json(enforcedSecurityPolicy());
});

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
          mode:
            retrievalMode(args.mode) ??
            configuredEvidenceIndexMode(String(res.locals.userId)),
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
        const action = text(args.action, 120);

        if (!action) {
          return void res.status(400).json({ detail: "action is required" });
        }
        if (!isAllowedExternalAuditAction("agent", action)) {
          return void res.status(403).json({
            detail: externalAuditActionHelp("agent"),
          });
        }
        const result = await repo.appendAuditEvent(ctx, matterId, {
          actor: "agent",
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

// GET /aletheia/search?q=...&limit=...
aletheiaRouter.get("/search", requireAuth, async (req, res) => {
  const query = text(req.query.q, 400);
  if (query.length < 2) {
    return void res
      .status(400)
      .json({ detail: "q must contain at least 2 characters" });
  }

  let limit = 20;
  if (req.query.limit !== undefined) {
    if (typeof req.query.limit !== "string" || !/^\d+$/.test(req.query.limit)) {
      return void res
        .status(400)
        .json({ detail: "limit must be an integer from 1 to 50" });
    }
    limit = Number(req.query.limit);
    if (limit < 1 || limit > 50) {
      return void res
        .status(400)
        .json({ detail: "limit must be an integer from 1 to 50" });
    }
  }

  try {
    const data = await createAletheiaRepository().searchGlobal(
      userContext(res),
      { query, limit },
    );
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

aletheiaRouter.post(
  "/matters/:matterId/archive",
  requireAuth,
  async (req, res) => {
    try {
      const data = await createAletheiaRepository().archiveMatter(
        userContext(res),
        req.params.matterId,
      );
      if (!data)
        return void res.status(404).json({ detail: "Matter not found" });
      res.json(data);
    } catch (error) {
      handleRouteError(res, error);
    }
  },
);

aletheiaRouter.post(
  "/matters/:matterId/purge",
  requireAuth,
  async (req, res) => {
    if (text(req.body?.confirmMatterId, 120) !== req.params.matterId) {
      return void res.status(400).json({
        detail: "confirmMatterId must exactly match the matter being purged",
      });
    }
    const approvalCheckpointId = text(req.body?.approvalCheckpointId, 120);
    if (!approvalCheckpointId) {
      return void res.status(409).json({
        code: "approval_required",
        detail: "An approved matter_purge checkpoint is required.",
      });
    }
    try {
      const data = await createAletheiaRepository().purgeMatter(
        userContext(res),
        req.params.matterId,
        approvalCheckpointId,
      );
      if (!data)
        return void res.status(404).json({ detail: "Matter not found" });
      res.json(data);
    } catch (error) {
      handleRouteError(res, error);
    }
  },
);

aletheiaRouter.post(
  "/deletion-tombstones/:tombstoneId/retry-cleanup",
  requireAuth,
  async (req, res) => {
    try {
      const data = await createAletheiaRepository().retryPurgeCleanup(
        userContext(res),
        req.params.tombstoneId,
      );
      if (!data) {
        return void res
          .status(404)
          .json({ detail: "Deletion tombstone not found" });
      }
      res.json(data);
    } catch (error) {
      handleRouteError(res, error);
    }
  },
);

// POST /aletheia/matters/:matterId/external-source/fetch
// Retrieval is separate from work-product persistence: callers must still
// create a reviewable workpaper and audit chain from the returned capture.
aletheiaRouter.post(
  "/matters/:matterId/external-source/fetch",
  requireAuth,
  async (req, res) => {
    const sourceUrl = text(req.body?.url, 4000);
    if (!sourceUrl)
      return void res.status(400).json({ detail: "url is required" });
    if (req.body?.externalAccessOptIn !== true) {
      return void res.status(403).json({
        code: "external_source_policy",
        detail:
          "Explicit per-matter external-source authorization is required.",
      });
    }
    const approvalCheckpointId = text(req.body?.approvalCheckpointId, 120);
    if (!approvalCheckpointId) {
      return void res.status(409).json({
        code: "approval_required",
        detail: "An approved external_source_use checkpoint is required.",
      });
    }
    try {
      const repo = createAletheiaRepository();
      const ctx = userContext(res);
      const matter = await repo.getMatterDetail(ctx, req.params.matterId);
      if (!matter)
        return void res.status(404).json({ detail: "Matter not found" });
      const approved = await repo.hasApprovedCheckpoint(
        ctx,
        req.params.matterId,
        approvalCheckpointId,
        "external_source_use",
        {
          sourceUrlHash: `sha256:${createHash("sha256")
            .update(sourceUrl)
            .digest("hex")}`,
        },
      );
      if (!approved) {
        return void res.status(409).json({
          code: "approval_required",
          detail: "The external-source approval is missing or invalid.",
        });
      }
      await repo.appendAuditEvent(ctx, req.params.matterId, {
        actor: "system",
        action: "external_source_fetch_authorized",
        workflowVersion: "hermes-external-source-capture-v1",
        model: null,
        details: { approvalCheckpointId },
      });
      const capture = await fetchAllowlistedExternalSource({
        url: sourceUrl,
        externalAccessOptIn: true,
      });
      await repo.appendAuditEvent(ctx, req.params.matterId, {
        actor: "system",
        action: "external_source_fetch_completed",
        workflowVersion: "hermes-external-source-capture-v1",
        model: null,
        details: {
          approvalCheckpointId,
          host: capture.host,
          urlHash: capture.urlHash,
          snapshotHash: capture.snapshotHash,
          responseBytes: capture.responseBytes,
        },
      });
      res.json({
        schemaVersion: "hermes-external-source-capture-v1",
        matterId: req.params.matterId,
        ...capture,
      });
    } catch (error) {
      handleRouteError(res, error);
    }
  },
);

// POST /aletheia/matters/:matterId/work-products
aletheiaRouter.post(
  "/matters/:matterId/work-products",
  requireAuth,
  async (req, res) => {
    const kind = text(req.body?.kind, 80);
    const title = text(req.body?.title, 240);
    const status = text(req.body?.status, 40) || "generated";
    const generatedBy = text(req.body?.generatedBy, 40) || "human";
    const schemaVersion = text(req.body?.schemaVersion, 120) || "aletheia-v0";

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
    if (schemaVersion.startsWith("vera-legal-research-")) {
      return void res.status(403).json({
        code: "research_broker_required",
        detail:
          "Vera legal-research records must be created through the controlled Research Broker workflow.",
      });
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
          schemaVersion,
          content: objectPayload(req.body.content),
          validationErrors: arrayPayload(req.body?.validationErrors),
          generatedBy: generatedBy as "system" | "agent" | "human",
          model: nullableText(req.body?.model, 120),
          approvalCheckpointId: nullableText(
            req.body?.approvalCheckpointId,
            120,
          ),
          governanceApprovalRequestId: nullableText(
            req.body?.governanceApprovalRequestId,
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

// POST /aletheia/matters/:matterId/reviews/:reviewId/resolution
aletheiaRouter.post(
  "/matters/:matterId/reviews/:reviewId/resolution",
  requireAuth,
  async (req, res) => {
    const status = reviewResolutionStatus(req.body?.status);
    if (!status) {
      return void res.status(400).json({ detail: "status is invalid" });
    }

    try {
      const data = await createAletheiaRepository().resolveReview(
        userContext(res),
        req.params.matterId,
        req.params.reviewId,
        {
          status: status as
            | "accepted"
            | "rejected"
            | "needs_material"
            | "resolved",
          comment: nullableText(req.body?.comment, 4000),
          createEvalCase: optionalBooleanPayload(req.body?.createEvalCase),
        },
      );
      if (!data) {
        return void res
          .status(404)
          .json({ detail: "Matter or review comment not found" });
      }
      res.json(data);
    } catch (error) {
      handleRouteError(res, error);
    }
  },
);

// POST /aletheia/matters/:matterId/shareholder-graphs/:graphId/approve
aletheiaRouter.post(
  "/matters/:matterId/shareholder-graphs/:graphId/approve",
  requireAuth,
  async (req, res) => {
    try {
      const data =
        await createAletheiaRepository().approveShareholderPenetrationGraph(
          userContext(res),
          req.params.matterId,
          req.params.graphId,
        );
      if (!data) {
        return void res
          .status(404)
          .json({ detail: "Matter or shareholder graph not found" });
      }
      res.json(data);
    } catch (error) {
      handleRouteError(res, error);
    }
  },
);

// POST /aletheia/matters/:matterId/legal-qa/:answerId/approve
aletheiaRouter.post(
  "/matters/:matterId/legal-qa/:answerId/approve",
  requireAuth,
  async (req, res) => {
    try {
      const data = await createAletheiaRepository().approveLegalQaAnswer(
        userContext(res),
        req.params.matterId,
        req.params.answerId,
      );
      if (!data)
        return void res
          .status(404)
          .json({ detail: "Matter or Legal Q&A answer not found" });
      res.json(data);
    } catch (error) {
      handleRouteError(res, error);
    }
  },
);

// POST /aletheia/matters/:matterId/word-addin/:handoffId/approve
aletheiaRouter.post(
  "/matters/:matterId/word-addin/:handoffId/approve",
  requireAuth,
  async (req, res) => {
    try {
      const data = await createAletheiaRepository().approveWordAddinHandoff(
        userContext(res),
        req.params.matterId,
        req.params.handoffId,
      );
      if (!data)
        return void res
          .status(404)
          .json({ detail: "Matter or Word Add-in handoff not found" });
      res.json(data);
    } catch (error) {
      handleRouteError(res, error);
    }
  },
);

// POST /aletheia/matters/:matterId/preference-learning/:memoryItemId/approve
aletheiaRouter.post(
  "/matters/:matterId/preference-learning/:memoryItemId/approve",
  requireAuth,
  async (req, res) => {
    try {
      const data =
        await createAletheiaRepository().approvePreferenceLearningCandidate(
          userContext(res),
          req.params.matterId,
          req.params.memoryItemId,
        );
      if (!data)
        return void res
          .status(404)
          .json({ detail: "Matter or preference candidate not found" });
      res.json(data);
    } catch (error) {
      handleRouteError(res, error);
    }
  },
);

// GET /aletheia/matters/:matterId/eval-cases
aletheiaRouter.get(
  "/matters/:matterId/eval-cases",
  requireAuth,
  async (req, res) => {
    try {
      const data = await createAletheiaRepository().listReviewDerivedEvalCases(
        userContext(res),
        req.params.matterId,
      );
      if (!data)
        return void res.status(404).json({ detail: "Matter not found" });
      res.json({
        schema_version: "aletheia-review-derived-eval-local-v0",
        matter_id: req.params.matterId,
        eval_cases: data,
        local_only: true,
      });
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
    const action = text(req.body?.action, 120);

    if (!action) {
      return void res.status(400).json({ detail: "action is required" });
    }
    if (!isAllowedExternalAuditAction("human", action)) {
      return void res.status(403).json({
        detail: externalAuditActionHelp("human"),
      });
    }

    try {
      const data = await createAletheiaRepository().appendAuditEvent(
        userContext(res),
        req.params.matterId,
        {
          actor: "human",
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
        "litigation_artifact_export",
        "litigation_matter_audit_export",
        "litigation_template_publish",
        "litigation_template_retire",
        "external_source_use",
        "matter_purge",
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
            | "final_memo_export"
            | "litigation_artifact_export"
            | "litigation_matter_audit_export"
            | "litigation_template_publish"
            | "litigation_template_retire"
            | "external_source_use"
            | "matter_purge",
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

// POST /aletheia/matters/:matterId/skills/approve-candidate
aletheiaRouter.post(
  "/matters/:matterId/skills/approve-candidate",
  requireAuth,
  async (req, res) => {
    const candidate = objectPayload(req.body?.candidate);
    if (Object.keys(candidate).length === 0) {
      return void res
        .status(400)
        .json({ detail: "candidate skill payload is required" });
    }

    try {
      const data = await createAletheiaRepository().approveSkillCandidate(
        userContext(res),
        req.params.matterId,
        {
          candidate,
          approvalComment: nullableText(req.body?.approvalComment, 4000),
        },
      );
      if (!data) {
        return void res.status(404).json({ detail: "Matter not found" });
      }
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

// POST /aletheia/matters/:matterId/v1/runtime-results
aletheiaRouter.post(
  "/matters/:matterId/v1/runtime-results",
  requireAuth,
  async (req, res) => {
    const input = v1RuntimePayload(req.body);
    if ("error" in input) {
      return void res.status(400).json({ detail: input.error });
    }

    try {
      const data = await createAletheiaRepository().persistV1RuntimeResult(
        userContext(res),
        req.params.matterId,
        input,
      );
      if (!data) {
        return void res.status(404).json({ detail: "Matter not found" });
      }
      res.status(201).json({
        schema_version: "aletheia-v1-runtime-persistence-route-local-v0",
        local_only: true,
        run: data,
      });
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

// POST /aletheia/matters/:matterId/v1/export-package
aletheiaRouter.post(
  "/matters/:matterId/v1/export-package",
  requireAuth,
  async (req, res) => {
    try {
      const data = await createAletheiaRepository().createLocalExportPackage(
        userContext(res),
        req.params.matterId,
        {
          approvalCheckpointId: nullableText(
            req.body?.approvalCheckpointId,
            120,
          ),
          governanceApprovalRequestId: nullableText(
            req.body?.governanceApprovalRequestId,
            120,
          ),
          includeChunks: optionalBooleanPayload(req.body?.includeChunks),
          chunkLimit: positiveNumber(req.body?.chunkLimit),
        },
      );
      if (!data) {
        return void res.status(404).json({ detail: "Matter not found" });
      }
      res.status(201).json(data);
    } catch (error) {
      handleRouteError(res, error);
    }
  },
);

// POST /aletheia/matters/:matterId/eval-cases/export
aletheiaRouter.post(
  "/matters/:matterId/eval-cases/export",
  requireAuth,
  async (req, res) => {
    try {
      const data = await createAletheiaRepository().createDurableEvalExport(
        userContext(res),
        req.params.matterId,
        {
          approvalCheckpointId: nullableText(
            req.body?.approvalCheckpointId,
            120,
          ),
          governanceApprovalRequestId: nullableText(
            req.body?.governanceApprovalRequestId,
            120,
          ),
          includeClosed: optionalBooleanPayload(req.body?.includeClosed),
        },
      );
      if (!data) {
        return void res.status(404).json({ detail: "Matter not found" });
      }
      res.status(201).json(data);
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
    const upload = req.file;
    if (!upload) {
      return void res.status(400).json({ detail: "file is required" });
    }

    try {
      const repo = createAletheiaRepository();
      const ctx = userContext(res);
      if (
        !(await repo.preflightMatterDocumentWrite(ctx, req.params.matterId))
      ) {
        return void res.status(404).json({ detail: "Matter not found" });
      }
      if (!upload.path) throw new Error("Temporary upload path is missing");
      const malwareScan = await scanLocalUpload(upload.path);
      const file = await materializeUploadedFile(upload);
      const validationError = await uploadedDocumentValidationError(file);
      if (validationError) {
        return void res.status(415).json({ detail: validationError });
      }
      const contentDisarm = await disarmLocalUpload(
        upload.path,
        file.originalname,
      );
      const data = await repo.uploadMatterDocument(ctx, req.params.matterId, {
        filename: file.originalname,
        mimeType: file.mimetype,
        sizeBytes: file.size,
        buffer: file.buffer,
        malwareScan,
        contentDisarm,
      });
      if (!data)
        return void res.status(404).json({ detail: "Matter not found" });
      res.status(201).json(redactPublicMatterDocument(data));
    } catch (error) {
      await auditBlockedContentDisarm(res, req.params.matterId, error);
      handleRouteError(res, error);
    } finally {
      await cleanupUploadedFiles([upload]);
    }
  },
);

// POST /aletheia/matters/:matterId/documents/:documentId/retry-parse
aletheiaRouter.post(
  "/matters/:matterId/documents/:documentId/retry-parse",
  requireAuth,
  async (req, res) => {
    try {
      const data = await createAletheiaRepository().retryMatterDocumentParse(
        userContext(res),
        req.params.matterId,
        req.params.documentId,
      );
      if (!data) {
        return void res.status(404).json({ detail: "Document not found" });
      }
      res.json(redactPublicMatterDocument(data));
    } catch (error) {
      handleRouteError(res, error);
    }
  },
);

// GET /aletheia/matters/:matterId/documents/:documentId/original
aletheiaRouter.get(
  "/matters/:matterId/documents/:documentId/original",
  requireAuth,
  async (req, res) => {
    try {
      const data =
        await createAletheiaRepository().downloadMatterOriginalDocument(
          userContext(res),
          req.params.matterId,
          req.params.documentId,
        );
      if (!data) {
        return void res.status(404).json({ detail: "Document not found" });
      }
      res.status(200);
      res.setHeader("Content-Type", data.mimeType);
      res.setHeader(
        "Content-Disposition",
        originalDocumentContentDisposition(data.filename),
      );
      res.setHeader("Content-Length", String(data.bytes.length));
      res.setHeader("X-Aletheia-Content-SHA256", data.sha256);
      res.setHeader(
        "Access-Control-Expose-Headers",
        "Content-Disposition, Content-Length, X-Aletheia-Content-SHA256",
      );
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Security-Policy", "sandbox");
      res.setHeader("Accept-Ranges", "none");
      res.send(data.bytes);
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
    try {
      const repo = createAletheiaRepository();
      const ctx = userContext(res);
      if (
        !(await repo.preflightMatterDocumentWrite(ctx, req.params.matterId))
      ) {
        return void res.status(404).json({ detail: "Matter not found" });
      }
      if (files.length === 0) {
        return void res.status(400).json({ detail: "files are required" });
      }
      const documents: unknown[] = [];
      const errors: Array<{ filename: string; detail: string }> = [];

      for (const upload of files) {
        try {
          if (!upload.path) throw new Error("Temporary upload path is missing");
          const malwareScan = await scanLocalUpload(upload.path);
          const file = await materializeUploadedFile(upload);
          const validationError = await uploadedDocumentValidationError(file);
          if (validationError) throw new Error(validationError);
          const contentDisarm = await disarmLocalUpload(
            upload.path,
            file.originalname,
          );
          const data = await repo.uploadMatterDocument(
            ctx,
            req.params.matterId,
            {
              filename: file.originalname,
              mimeType: file.mimetype,
              sizeBytes: file.size,
              buffer: file.buffer,
              malwareScan,
              contentDisarm,
            },
          );
          if (!data) {
            return void res.status(404).json({ detail: "Matter not found" });
          }
          documents.push(redactPublicMatterDocument(data));
        } catch (error) {
          await auditBlockedContentDisarm(res, req.params.matterId, error);
          errors.push({
            filename: upload.originalname,
            detail:
              error instanceof Error ? error.message : "Document upload failed",
          });
        } finally {
          await cleanupUploadedFiles([upload]);
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
    } catch (error) {
      handleRouteError(res, error);
    } finally {
      await cleanupUploadedFiles(files);
    }
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
    const mode =
      retrievalMode(req.query.mode) ??
      configuredEvidenceIndexMode(String(res.locals.userId));
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
