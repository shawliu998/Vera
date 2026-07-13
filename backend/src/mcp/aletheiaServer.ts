#!/usr/bin/env node
import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { createAletheiaRepository } from "../lib/aletheia";
import {
  GENERATED_BY,
  REVIEW_TAGS,
  REVIEW_TARGET_TYPES,
  WORK_PRODUCT_KINDS,
  WORK_PRODUCT_STATUSES,
  arrayPayload,
  nullableText,
  objectPayload,
  text,
} from "../lib/aletheia/domain";
import {
  externalAuditActionHelp,
  isAllowedExternalAuditAction,
} from "../lib/aletheia/auditActionPolicy";
import { ApprovalRequiredError } from "../lib/aletheia/repository";
import type { AletheiaUserContext } from "../lib/aletheia/repository";

function userContext(): AletheiaUserContext {
  return {
    userId: process.env.ALETHEIA_LOCAL_USER_ID ?? "local-user",
    userEmail:
      process.env.ALETHEIA_LOCAL_USER_EMAIL ?? "local@aletheia.internal",
  };
}

function repository() {
  return createAletheiaRepository();
}

function jsonToolResult(result: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(result, null, 2),
      },
    ],
  };
}

function errorToolResult(error: unknown) {
  const isApprovalError = error instanceof ApprovalRequiredError;
  const message = error instanceof Error ? error.message : "Tool call failed";
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            error: isApprovalError ? "approval_required" : "tool_error",
            detail: message,
          },
          null,
          2,
        ),
      },
    ],
  };
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

async function requireMatter(matterId: string) {
  const detail = await repository().getMatterDetail(userContext(), matterId);
  if (!detail) throw new Error("Matter not found");
  return detail as any;
}

const server = new McpServer({
  name: "aletheia-tool-adapter",
  version: "0.1.0",
});

server.registerTool(
  "list_matters",
  {
    title: "List Matters",
    description:
      "List Aletheia matters visible to the configured local or authenticated user.",
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  async () => {
    try {
      return jsonToolResult(await repository().listMatters(userContext()));
    } catch (error) {
      return errorToolResult(error);
    }
  },
);

server.registerTool(
  "read_matter",
  {
    title: "Read Matter",
    description:
      "Read one matter with documents, work products, evidence, reviews, audit events, run traces, memory, and playbooks.",
    inputSchema: {
      matterId: z.string().min(1),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  async ({ matterId }) => {
    try {
      return jsonToolResult(await requireMatter(matterId));
    } catch (error) {
      return errorToolResult(error);
    }
  },
);

server.registerTool(
  "search_matter_documents",
  {
    title: "Search Matter Documents",
    description:
      "Run local retrieval over source documents already uploaded to a matter.",
    inputSchema: {
      matterId: z.string().min(1),
      query: z.string().min(1),
      limit: z.number().int().positive().max(50).optional(),
      mode: z.enum(["keyword", "hybrid", "semantic"]).optional(),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  async ({ matterId, query, limit, mode }) => {
    try {
      const result = await repository().searchMatterDocuments(
        userContext(),
        matterId,
        { query, limit, mode },
      );
      if (!result) throw new Error("Matter not found");
      return jsonToolResult(result);
    } catch (error) {
      return errorToolResult(error);
    }
  },
);

server.registerTool(
  "read_evidence_item",
  {
    title: "Read Evidence Item",
    description:
      "Read one source-linked evidence item from a matter without exposing unrelated matters.",
    inputSchema: {
      matterId: z.string().min(1),
      evidenceItemId: z.string().min(1),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  async ({ matterId, evidenceItemId }) => {
    try {
      const detail = await requireMatter(matterId);
      const evidence = (detail.evidence ?? []).find(
        (item: { id?: string }) => item.id === evidenceItemId,
      );
      if (!evidence) throw new Error("Evidence item not found");
      return jsonToolResult(evidence);
    } catch (error) {
      return errorToolResult(error);
    }
  },
);

server.registerTool(
  "create_work_product",
  {
    title: "Create Work Product",
    description:
      "Create a structured Aletheia work product. High-risk kinds still require the configured approval gate.",
    inputSchema: {
      matterId: z.string().min(1),
      kind: z.string().min(1),
      title: z.string().min(1),
      status: z.string().optional(),
      schemaVersion: z.string().optional(),
      content: z.record(z.string(), z.unknown()).optional(),
      validationErrors: z.array(z.unknown()).optional(),
      generatedBy: z.string().optional(),
      model: z.string().nullable().optional(),
      approvalCheckpointId: z.string().nullable().optional(),
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
    },
  },
  async (args) => {
    try {
      const kind = text(args.kind, 80);
      const status = text(args.status, 40) || "generated";
      const generatedBy = text(args.generatedBy, 40) || "agent";
      if (!WORK_PRODUCT_KINDS.has(kind)) throw new Error("kind is invalid");
      if (!WORK_PRODUCT_STATUSES.has(status)) {
        throw new Error("status is invalid");
      }
      if (!GENERATED_BY.has(generatedBy)) {
        throw new Error("generatedBy is invalid");
      }
      const result = await repository().createWorkProduct(
        userContext(),
        args.matterId,
        {
          kind,
          title: text(args.title, 240),
          status,
          schemaVersion: text(args.schemaVersion, 120) || "aletheia-v0",
          content: objectPayload(args.content),
          validationErrors: arrayPayload(args.validationErrors),
          generatedBy: generatedBy as "system" | "agent" | "human",
          model: nullableText(args.model, 120),
          approvalCheckpointId: nullableText(args.approvalCheckpointId, 120),
        },
      );
      if (!result) throw new Error("Matter not found");
      return jsonToolResult(result);
    } catch (error) {
      return errorToolResult(error);
    }
  },
);

server.registerTool(
  "add_review_tag",
  {
    title: "Add Review Tag",
    description:
      "Attach a human or agent review tag to a matter, work product, claim, memo section, or evidence item.",
    inputSchema: {
      matterId: z.string().min(1),
      targetType: z.string().min(1),
      targetId: z.string().min(1),
      tag: z.string().min(1),
      comment: z.string().min(1),
      workProductId: z.string().nullable().optional(),
      evidenceItemId: z.string().nullable().optional(),
      reviewerName: z.string().nullable().optional(),
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
    },
  },
  async (args) => {
    try {
      const targetType = text(args.targetType, 80);
      const tag = text(args.tag, 80);
      if (!REVIEW_TARGET_TYPES.has(targetType)) {
        throw new Error("targetType is invalid");
      }
      if (!REVIEW_TAGS.has(tag)) throw new Error("tag is invalid");
      const result = await repository().addReview(
        userContext(),
        args.matterId,
        {
          targetType,
          targetId: text(args.targetId, 240),
          tag,
          comment: text(args.comment, 4000),
          workProductId: nullableText(args.workProductId, 120),
          evidenceItemId: nullableText(args.evidenceItemId, 120),
          reviewerName: nullableText(args.reviewerName, 240),
        },
      );
      if (!result) throw new Error("Matter not found");
      return jsonToolResult(result);
    } catch (error) {
      return errorToolResult(error);
    }
  },
);

server.registerTool(
  "append_audit_event",
  {
    title: "Append Audit Event",
    description:
      "Append an auditable event to a matter. Use for provenance, not free-form memory.",
    inputSchema: {
      matterId: z.string().min(1),
      actor: z.string().optional(),
      action: z.string().min(1),
      workflowVersion: z.string().nullable().optional(),
      model: z.string().nullable().optional(),
      details: z.record(z.string(), z.unknown()).optional(),
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
    },
  },
  async (args) => {
    try {
      const action = text(args.action, 120);
      if (!isAllowedExternalAuditAction("agent", action)) {
        throw new Error(externalAuditActionHelp("agent"));
      }
      const result = await repository().appendAuditEvent(
        userContext(),
        args.matterId,
        {
          actor: "agent",
          action,
          workflowVersion: nullableText(args.workflowVersion, 120),
          model: nullableText(args.model, 120),
          details: objectPayload(args.details),
        },
      );
      if (!result) throw new Error("Matter not found");
      return jsonToolResult(result);
    } catch (error) {
      return errorToolResult(error);
    }
  },
);

server.registerTool(
  "export_audit_pack",
  {
    title: "Export Audit Pack",
    description:
      "Create an approval-gated audit pack work product. Requires an approved checkpoint ID.",
    inputSchema: {
      matterId: z.string().min(1),
      title: z.string().optional(),
      approvalCheckpointId: z.string().nullable().optional(),
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
    },
  },
  async ({ matterId, title, approvalCheckpointId }) => {
    try {
      const detail = await requireMatter(matterId);
      const result = await repository().createWorkProduct(
        userContext(),
        matterId,
        {
          kind: "audit_pack",
          title: text(title, 240) || `${detail.matter.title} Audit Pack`,
          status: "generated",
          schemaVersion: "aletheia-audit-pack-v0",
          content: auditPackContent(detail),
          validationErrors: [],
          generatedBy: "agent",
          model: null,
          approvalCheckpointId: nullableText(approvalCheckpointId, 120),
        },
      );
      if (!result) throw new Error("Matter not found");
      return jsonToolResult(result);
    } catch (error) {
      return errorToolResult(error);
    }
  },
);

async function main() {
  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  console.error("[aletheia-mcp] fatal", error);
  process.exit(1);
});
