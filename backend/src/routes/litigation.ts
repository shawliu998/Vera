import { Router } from "express";
import multer from "multer";
import { createAletheiaRepository } from "../lib/aletheia";
import {
  ApprovalRequiredError,
  LitigationArtifactDownloadIntegrityError,
  SourceOriginalVerificationHistoryAuditError,
} from "../lib/aletheia/repository";
import {
  LITIGATION_ARTIFACT_KINDS,
  LITIGATION_CLAIM_KINDS,
  LITIGATION_CLAIM_SOURCE_RELATIONS,
  LITIGATION_DATE_PRECISIONS,
  LITIGATION_HELPFULNESS,
  LITIGATION_POSITION_REVIEW_KINDS,
  LITIGATION_POSITION_REVIEW_OUTCOMES,
  LITIGATION_POSITION_REVIEW_RESOLUTIONS,
  LITIGATION_SOURCE_RELATIONS,
  LITIGATION_TASK_PRIORITIES,
  LITIGATION_TASK_STATUSES,
  type CreateSourceSpanInput,
  type LitigationArtifactKind,
} from "../lib/aletheia/litigationDomain";
import { LitigationValidationError } from "../lib/aletheia/litigationStore";
import { DocumentDraftRoundTripError } from "../lib/aletheia/litigationDocumentRoundTrip";
import { GovernancePolicyError } from "../lib/aletheia/localGovernance";
import {
  AuditAnchorConfigurationError,
  AuditAnchorVerificationError,
  auditAnchorConfigFromEnvironment,
  auditAnchorRuntimeStatus,
  findExactMatterAuditAnchorCoverage,
  runAuditAnchorRuntimeNow,
} from "../lib/aletheia/auditAnchorJournal";
import { buildTaskCalendar } from "../lib/aletheia/taskCalendar";
import { listLitigationDocumentTemplates as listBuiltInLitigationDocumentTemplates } from "../lib/aletheia/litigationDocumentTemplates";
import {
  DEFAULT_LITIGATION_DOCUMENT_TEMPLATE_ID,
  DEFAULT_LITIGATION_DOCUMENT_TEMPLATE_VERSION,
} from "../lib/aletheia/litigationDocumentTemplates";
import { requireAuth } from "../middleware/auth";

export const litigationRouter = Router();
const templateUpload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 1, fileSize: 10 * 1024 * 1024, fields: 8 },
});
const documentDraftUpload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 1, fileSize: 10 * 1024 * 1024, fields: 4 },
});

litigationRouter.get(
  "/litigation/document-templates",
  requireAuth,
  (_req, res) => {
    res.json({
      schemaVersion: "aletheia-litigation-document-template-registry-v1",
      templates: listBuiltInLitigationDocumentTemplates(),
    });
  },
);

litigationRouter.get(
  "/matters/:matterId/litigation/document-templates",
  requireAuth,
  async (req, res) => {
    try {
      const custom =
        await createAletheiaRepository().listLitigationDocumentTemplates(
          userContext(res),
          req.params.matterId,
        );
      res.json({
        schemaVersion: "aletheia-litigation-document-template-registry-v2",
        templates: [
          ...listBuiltInLitigationDocumentTemplates().map((item) => ({
            ...item,
            source: "built_in",
          })),
          ...custom,
        ],
      });
    } catch (error) {
      handleError(res, error);
    }
  },
);

litigationRouter.post(
  "/matters/:matterId/litigation/document-templates/import",
  requireAuth,
  templateUpload.single("template"),
  async (req, res) => {
    if (!req.file || !/\.docx$/i.test(req.file.originalname)) {
      return void res
        .status(400)
        .json({ detail: "A DOCX template is required" });
    }
    try {
      const result =
        await createAletheiaRepository().importLitigationDocumentTemplate(
          userContext(res),
          req.params.matterId,
          {
            name:
              cleanText(req.body?.name, 160) ||
              req.file.originalname.replace(/\.docx$/i, ""),
            bytes: req.file.buffer,
          },
        );
      if (!result)
        return void res.status(404).json({ detail: "Matter not found" });
      res.status(201).json(result);
    } catch (error) {
      handleError(res, error);
    }
  },
);

litigationRouter.post(
  "/matters/:matterId/litigation/document-templates/:templateId/publish",
  requireAuth,
  async (req, res) => {
    const checkpointId = cleanText(req.body?.checkpointId, 160);
    if (!checkpointId)
      return void res.status(400).json({ detail: "checkpointId is required" });
    try {
      const result =
        await createAletheiaRepository().publishLitigationDocumentTemplate(
          userContext(res),
          req.params.matterId,
          req.params.templateId,
          checkpointId,
        );
      if (!result)
        return void res.status(404).json({ detail: "Template not found" });
      res.json(result);
    } catch (error) {
      handleError(res, error);
    }
  },
);

litigationRouter.post(
  "/matters/:matterId/litigation/document-templates/:templateId/retire",
  requireAuth,
  async (req, res) => {
    const checkpointId = cleanText(req.body?.checkpointId, 160);
    if (!checkpointId)
      return void res.status(400).json({ detail: "checkpointId is required" });
    try {
      const result =
        await createAletheiaRepository().retireLitigationDocumentTemplate(
          userContext(res),
          req.params.matterId,
          req.params.templateId,
          checkpointId,
        );
      if (!result)
        return void res.status(404).json({ detail: "Template not found" });
      res.json(result);
    } catch (error) {
      handleError(res, error);
    }
  },
);

function userContext(res: { locals: Record<string, unknown> }) {
  return {
    userId: String(res.locals.userId ?? ""),
    userEmail:
      typeof res.locals.userEmail === "string"
        ? res.locals.userEmail
        : undefined,
  };
}

function cleanText(value: unknown, max = 400) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function boundedText(value: unknown, min: number, max: number) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length >= min && text.length <= max ? text : null;
}

function boundedPositiveInteger(value: unknown, max = 1_000_000) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= max
    ? parsed
    : null;
}

function documentDraftSections(value: unknown) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) return null;
  const sections: Array<{ id: string; heading: string; body: string }> = [];
  for (const valueItem of value) {
    if (!valueItem || typeof valueItem !== "object" || Array.isArray(valueItem)) {
      return null;
    }
    const item = valueItem as Record<string, unknown>;
    const id = boundedText(item.id, 1, 80);
    const heading = boundedText(item.heading, 1, 240);
    const body = boundedText(item.body, 0, 50_000);
    if (!id || !/^[a-z][a-z0-9_-]{0,79}$/.test(id) || !heading || body === null) {
      return null;
    }
    sections.push({ id, heading, body });
  }
  if (new Set(sections.map((section) => section.id)).size !== sections.length) {
    return null;
  }
  return sections.reduce((total, section) => total + section.body.length, 0) <= 200_000
    ? sections
    : null;
}

function nullableText(value: unknown, max = 400) {
  return cleanText(value, max) || null;
}

function metadata(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function sourceSpan(value: unknown): CreateSourceSpanInput | null | "invalid" {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return "invalid";
  const source = value as Record<string, unknown>;
  const sourceChunkId = cleanText(source.sourceChunkId, 160);
  const quoteStart = Number(source.quoteStart);
  const quoteEnd = Number(source.quoteEnd);
  if (
    !sourceChunkId ||
    !Number.isInteger(quoteStart) ||
    !Number.isInteger(quoteEnd)
  ) {
    return "invalid";
  }
  return { sourceChunkId, quoteStart, quoteEnd };
}

function validIsoDate(value: string) {
  return Boolean(value) && Number.isFinite(Date.parse(value));
}

function decision(value: unknown) {
  return value === "confirmed" || value === "rejected" ? value : null;
}

function taskPriority(value: unknown) {
  const priority = cleanText(value, 20) || "normal";
  return LITIGATION_TASK_PRIORITIES.has(priority)
    ? (priority as "high" | "normal" | "low")
    : null;
}

function taskStatusFilter(value: unknown) {
  const status = cleanText(value, 20) || "open";
  return status === "all" || LITIGATION_TASK_STATUSES.has(status)
    ? (status as "open" | "completed" | "all")
    : null;
}

function artifactContentDisposition(
  title: string,
  version: number,
  extension: "docx" | "zip",
) {
  const unicodeBase =
    title
      .normalize("NFC")
      .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 100) || "litigation-artifact";
  const asciiBase =
    unicodeBase
      .normalize("NFKD")
      .replace(/[^\x20-\x7e]/g, "")
      .replace(/[^A-Za-z0-9._ -]+/g, "-")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^[.-]+|[.-]+$/g, "")
      .toLowerCase()
      .slice(0, 100) || "litigation-artifact";
  const asciiFilename = `${asciiBase}-v${version}.${extension}`;
  const unicodeFilename = `${unicodeBase}-v${version}.${extension}`;
  const encodedFilename = encodeURIComponent(unicodeFilename).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodedFilename}`;
}

function handleError(res: any, error: unknown) {
  if (
    error instanceof AuditAnchorConfigurationError ||
    error instanceof AuditAnchorVerificationError
  ) {
    return void res.status(409).json({
      detail: error.message,
      code:
        error instanceof AuditAnchorConfigurationError
          ? "audit_anchor_unavailable"
          : "audit_anchor_verification_failed",
    });
  }
  if (error instanceof DocumentDraftRoundTripError) {
    return void res
      .status(error.status)
      .json({ detail: error.message, code: error.code });
  }
  if (error instanceof GovernancePolicyError) {
    return void res
      .status(error.status)
      .json({ detail: error.message, code: error.code });
  }
  if (error instanceof LitigationArtifactDownloadIntegrityError) {
    return void res
      .status(error.status)
      .json({ detail: error.message, code: error.code });
  }
  if (error instanceof SourceOriginalVerificationHistoryAuditError) {
    return void res
      .status(error.status)
      .json({ detail: error.message, code: error.code });
  }
  if (error instanceof ApprovalRequiredError) {
    return void res
      .status(409)
      .json({ detail: error.message, code: "approval_required" });
  }
  if (error instanceof LitigationValidationError) {
    const conflict = /conflict|stale|withdrawn|immutable|latest document version/i.test(
      error.message,
    );
    return void res.status(conflict ? 409 : 400).json({ detail: error.message });
  }
  if (
    error instanceof Error &&
    error.message.includes("UNIQUE constraint failed")
  ) {
    return void res
      .status(409)
      .json({ detail: "The relationship already exists." });
  }
  console.error("Litigation route failed", error);
  res.status(500).json({ detail: "Litigation operation failed." });
}

litigationRouter.get(
  "/matters/:matterId/litigation",
  requireAuth,
  async (req, res) => {
    try {
      const data = await createAletheiaRepository().getLitigationWorkspace(
        userContext(res),
        req.params.matterId,
      );
      if (!data)
        return void res.status(404).json({ detail: "Matter not found" });
      res.json(data);
    } catch (error) {
      handleError(res, error);
    }
  },
);

litigationRouter.get(
  "/matters/:matterId/litigation/audit-exports/preview",
  requireAuth,
  async (req, res) => {
    try {
      const data =
        await createAletheiaRepository().getLitigationMatterAuditExportPreview(
          userContext(res),
          req.params.matterId,
        );
      if (!data)
        return void res.status(404).json({ detail: "Matter not found" });
      res.json(data);
    } catch (error) {
      handleError(res, error);
    }
  },
);

litigationRouter.get(
  "/matters/:matterId/litigation/audit-exports",
  requireAuth,
  async (req, res) => {
    try {
      const data =
        await createAletheiaRepository().listLitigationMatterAuditExports(
          userContext(res),
          req.params.matterId,
        );
      if (!data)
        return void res.status(404).json({ detail: "Matter not found" });
      res.json(data);
    } catch (error) {
      handleError(res, error);
    }
  },
);

litigationRouter.post(
  "/matters/:matterId/litigation/audit-exports",
  requireAuth,
  async (req, res) => {
    const approvalCheckpointId = cleanText(
      req.body?.approvalCheckpointId,
      160,
    );
    if (!approvalCheckpointId) {
      return void res
        .status(400)
        .json({ detail: "approvalCheckpointId is required" });
    }
    try {
      const data =
        await createAletheiaRepository().createLitigationMatterAuditExport(
          userContext(res),
          req.params.matterId,
          {
            approvalCheckpointId,
            governanceApprovalRequestId: nullableText(
              req.body?.governanceApprovalRequestId,
              160,
            ),
          },
        );
      if (!data)
        return void res.status(404).json({ detail: "Matter not found" });
      res.status(201).json(data);
    } catch (error) {
      handleError(res, error);
    }
  },
);

const SIGNOFF_ANCHOR_ASSURANCE =
  "This proves exact inclusion in an operator-key-signed local audit head. It is not a qualified electronic signature, trusted timestamp, or independent notarization.";

function signoffAnchorCoverage(target: any) {
  const runtime = auditAnchorRuntimeStatus();
  if (!runtime.enabled) {
    return {
      schema_version: "aletheia-litigation-signoff-anchor-proof-v1",
      configured: false,
      anchored: false,
      can_anchor: false,
      exact_current_matter_head: target.exactCurrentMatterHead,
      runtime,
      assurance: SIGNOFF_ANCHOR_ASSURANCE,
    };
  }
  const config = auditAnchorConfigFromEnvironment();
  const coverage = findExactMatterAuditAnchorCoverage({
    ...config,
    matterId: target.matterId,
    eventSequence: target.auditEventSequence,
    eventHash: target.auditEventHash,
  });
  return {
    schema_version: "aletheia-litigation-signoff-anchor-proof-v1",
    configured: true,
    anchored: Boolean(coverage),
    can_anchor:
      target.canAnchor && target.exactCurrentMatterHead && !coverage,
    exact_current_matter_head: target.exactCurrentMatterHead,
    target: {
      signoff_id: target.signoffId,
      signoff_hash: target.signoffHash,
      audit_event_id: target.auditEventId,
      audit_event_sequence: target.auditEventSequence,
      audit_event_hash: target.auditEventHash,
    },
    coverage,
    runtime,
    assurance: SIGNOFF_ANCHOR_ASSURANCE,
  };
}

litigationRouter.get(
  "/matters/:matterId/litigation/audit-exports/:exportId/signoffs/:signoffId/anchor-proof",
  requireAuth,
  async (req, res) => {
    try {
      const target =
        await createAletheiaRepository().getLitigationMatterAuditSignoffAnchorTarget(
          userContext(res),
          req.params.matterId,
          req.params.exportId,
          req.params.signoffId,
        );
      if (!target)
        return void res.status(404).json({ detail: "Counsel sign-off not found" });
      res.json(signoffAnchorCoverage(target));
    } catch (error) {
      handleError(res, error);
    }
  },
);

litigationRouter.post(
  "/matters/:matterId/litigation/audit-exports/:exportId/signoffs/:signoffId/anchor",
  requireAuth,
  async (req, res) => {
    try {
      const target =
        await createAletheiaRepository().authorizeLitigationMatterAuditSignoffAnchor(
          userContext(res),
          req.params.matterId,
          req.params.exportId,
          req.params.signoffId,
        ) as any;
      if (!target)
        return void res.status(404).json({ detail: "Counsel sign-off not found" });
      if (!target.exactCurrentMatterHead) {
        return void res.status(409).json({
          detail:
            "Direct anchoring requires the counsel sign-off event to remain the current matter audit head.",
          code: "audit_anchor_head_advanced",
        });
      }
      const existingProof = signoffAnchorCoverage(target);
      if (existingProof.anchored) {
        return void res.status(200).json(existingProof);
      }
      runAuditAnchorRuntimeNow(`litigation_signoff:${target.signoffId}`);
      const proof = signoffAnchorCoverage(target);
      if (!proof.anchored) {
        throw new AuditAnchorVerificationError(
          "The signed audit anchor does not exactly cover the counsel sign-off event.",
        );
      }
      res.status(201).json(proof);
    } catch (error) {
      handleError(res, error);
    }
  },
);

litigationRouter.get(
  "/matters/:matterId/litigation/audit-exports/:exportId",
  requireAuth,
  async (req, res) => {
    try {
      const data =
        await createAletheiaRepository().getLitigationMatterAuditExport(
          userContext(res),
          req.params.matterId,
          req.params.exportId,
        );
      if (!data)
        return void res.status(404).json({ detail: "Audit export not found" });
      res.json(data);
    } catch (error) {
      handleError(res, error);
    }
  },
);

litigationRouter.get(
  "/matters/:matterId/litigation/audit-exports/:exportId/signoffs",
  requireAuth,
  async (req, res) => {
    try {
      const data =
        await createAletheiaRepository().listLitigationMatterAuditExportSignoffs(
          userContext(res),
          req.params.matterId,
          req.params.exportId,
        );
      if (!data)
        return void res.status(404).json({ detail: "Audit export not found" });
      res.json(data);
    } catch (error) {
      handleError(res, error);
    }
  },
);

litigationRouter.post(
  "/matters/:matterId/litigation/audit-exports/:exportId/signoffs",
  requireAuth,
  async (req, res) => {
    const exportHash = cleanText(req.body?.exportHash, 160);
    const checklistHash = cleanText(req.body?.checklistHash, 160);
    const matterStateHash = cleanText(req.body?.matterStateHash, 160);
    const signerName = cleanText(req.body?.signerName, 160);
    const attestation = cleanText(req.body?.attestation, 1_000);
    const comment = cleanText(req.body?.comment, 2_000);
    if (
      !exportHash ||
      !checklistHash ||
      !matterStateHash ||
      !signerName ||
      !attestation ||
      !comment
    ) {
      return void res.status(400).json({
        detail:
          "exportHash, checklistHash, matterStateHash, signerName, attestation, and comment are required",
      });
    }
    try {
      const data =
        await createAletheiaRepository().signLitigationMatterAuditExport(
          userContext(res),
          req.params.matterId,
          req.params.exportId,
          {
            exportHash,
            checklistHash,
            matterStateHash,
            signerName,
            professionalIdentifier: nullableText(
              req.body?.professionalIdentifier,
              160,
            ),
            attestation,
            comment,
          },
        );
      if (!data)
        return void res.status(404).json({ detail: "Audit export not found" });
      res.status(201).json(data);
    } catch (error) {
      handleError(res, error);
    }
  },
);

litigationRouter.post(
  "/matters/:matterId/litigation/document-drafts/:documentId/versions/:versionId/docx-export",
  requireAuth,
  async (req, res) => {
    try {
      const data = await createAletheiaRepository().exportLitigationDocumentDraftDocx(
        userContext(res),
        req.params.matterId,
        req.params.documentId,
        req.params.versionId,
      ) as
        | {
            bytes: Buffer;
            filename: string;
            fileSha256: string;
            bindingHash: string;
            version: number;
          }
        | null;
      if (!data) {
        return void res.status(404).json({ detail: "Document draft version not found" });
      }
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      );
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${data.filename}"`,
      );
      res.setHeader("X-Vera-File-Sha256", data.fileSha256);
      res.setHeader("X-Vera-Binding-Sha256", data.bindingHash);
      res.send(data.bytes);
    } catch (error) {
      handleError(res, error);
    }
  },
);

litigationRouter.post(
  "/matters/:matterId/litigation/document-drafts/:documentId/docx-import",
  requireAuth,
  documentDraftUpload.single("document"),
  async (req, res) => {
    const changeSummary = boundedText(req.body?.changeSummary, 3, 1_000);
    if (!req.file || !/\.docx$/i.test(req.file.originalname) || !changeSummary) {
      return void res.status(400).json({
        detail: "A DOCX document and a 3-1000 character change summary are required",
      });
    }
    try {
      const data = await createAletheiaRepository().importLitigationDocumentDraftDocx(
        userContext(res),
        req.params.matterId,
        req.params.documentId,
        {
          filename: req.file.originalname,
          bytes: req.file.buffer,
          changeSummary,
        },
      );
      if (!data) return void res.status(404).json({ detail: "Document draft not found" });
      res.status(201).json(data);
    } catch (error) {
      handleError(res, error);
    }
  },
);

litigationRouter.post(
  "/matters/:matterId/litigation/retrieval-manifests",
  requireAuth,
  async (req, res) => {
    const focus = cleanText(req.body?.focus, 500);
    if (!focus)
      return void res.status(400).json({ detail: "focus is required" });
    try {
      const data =
        await createAletheiaRepository().createLitigationRetrievalManifest(
          userContext(res),
          req.params.matterId,
          { focus },
        );
      if (!data)
        return void res.status(404).json({ detail: "Matter not found" });
      res.status(201).json(data);
    } catch (error) {
      handleError(res, error);
    }
  },
);

litigationRouter.get(
  "/matters/:matterId/litigation/retrieval-manifests/:manifestId",
  requireAuth,
  async (req, res) => {
    try {
      const data =
        await createAletheiaRepository().getLitigationRetrievalManifest(
          userContext(res),
          req.params.matterId,
          req.params.manifestId,
        );
      if (!data)
        return void res.status(404).json({ detail: "Manifest not found" });
      res.json(data);
    } catch (error) {
      handleError(res, error);
    }
  },
);

litigationRouter.post(
  "/matters/:matterId/litigation/retrieval-manifests/:manifestId/excerpts",
  requireAuth,
  async (req, res) => {
    const chunkId = cleanText(req.body?.chunkId, 160);
    const comment = cleanText(req.body?.comment, 2_000);
    if (!chunkId || !comment)
      return void res
        .status(400)
        .json({ detail: "chunkId and comment are required" });
    try {
      const data =
        await createAletheiaRepository().confirmLitigationRetrievalExcerpt(
          userContext(res),
          req.params.matterId,
          req.params.manifestId,
          { chunkId, comment },
        );
      if (!data)
        return void res
          .status(404)
          .json({ detail: "Open manifest or candidate not found" });
      res.status(201).json(data);
    } catch (error) {
      handleError(res, error);
    }
  },
);

litigationRouter.post(
  "/matters/:matterId/litigation/retrieval-excerpts/:excerptId/withdraw",
  requireAuth,
  async (req, res) => {
    const comment = cleanText(req.body?.comment, 2_000);
    if (!comment)
      return void res.status(400).json({ detail: "comment is required" });
    try {
      const data =
        await createAletheiaRepository().withdrawLitigationRetrievalExcerpt(
          userContext(res),
          req.params.matterId,
          req.params.excerptId,
          { comment },
        );
      if (!data)
        return void res
          .status(404)
          .json({ detail: "Confirmed excerpt not found" });
      res.json(data);
    } catch (error) {
      handleError(res, error);
    }
  },
);

litigationRouter.get(
  "/matters/:matterId/litigation/legal-authorities",
  requireAuth,
  async (req, res) => {
    try {
      const data =
        await createAletheiaRepository().listLitigationLegalAuthorities(
          userContext(res),
          req.params.matterId,
        );
      if (!data)
        return void res.status(404).json({ detail: "Matter not found" });
      res.json(data);
    } catch (error) {
      handleError(res, error);
    }
  },
);

litigationRouter.post(
  "/matters/:matterId/litigation/legal-authorities",
  requireAuth,
  async (req, res) => {
    try {
      const data =
        await createAletheiaRepository().createLitigationLegalAuthorityVersion(
          userContext(res),
          req.params.matterId,
          {
            authorityType: cleanText(req.body?.authorityType, 80),
            title: cleanText(req.body?.title, 500),
            issuer: cleanText(req.body?.issuer, 500),
            officialIdentifier: cleanText(req.body?.officialIdentifier, 500),
            versionLabel: cleanText(req.body?.versionLabel, 200),
            sourceReference: cleanText(req.body?.sourceReference, 2_000),
            content: cleanText(req.body?.content, 500_000),
            effectiveFrom: cleanText(req.body?.effectiveFrom, 20),
            effectiveTo: cleanText(req.body?.effectiveTo, 20),
          },
        );
      if (!data)
        return void res.status(404).json({ detail: "Matter not found" });
      res.status(201).json(data);
    } catch (error) {
      handleError(res, error);
    }
  },
);

litigationRouter.get(
  "/matters/:matterId/litigation/legal-authorities/:authorityVersionId",
  requireAuth,
  async (req, res) => {
    try {
      const data =
        await createAletheiaRepository().getLitigationLegalAuthorityVersion(
          userContext(res),
          req.params.matterId,
          req.params.authorityVersionId,
        );
      if (!data)
        return void res
          .status(404)
          .json({ detail: "Authority version not found" });
      res.json(data);
    } catch (error) {
      handleError(res, error);
    }
  },
);

litigationRouter.post(
  "/matters/:matterId/litigation/legal-authorities/:authorityVersionId/verify",
  requireAuth,
  async (req, res) => {
    const comment = cleanText(req.body?.comment, 2_000);
    if (!comment)
      return void res.status(400).json({ detail: "comment is required" });
    try {
      const data =
        await createAletheiaRepository().verifyLitigationLegalAuthorityVersion(
          userContext(res),
          req.params.matterId,
          req.params.authorityVersionId,
          { comment },
        );
      if (!data)
        return void res
          .status(404)
          .json({ detail: "Draft authority version not found" });
      res.json(data);
    } catch (error) {
      handleError(res, error);
    }
  },
);

litigationRouter.post(
  "/matters/:matterId/litigation/legal-authorities/:authorityVersionId/retire",
  requireAuth,
  async (req, res) => {
    const comment = cleanText(req.body?.comment, 2_000);
    if (!comment)
      return void res.status(400).json({ detail: "comment is required" });
    try {
      const data =
        await createAletheiaRepository().retireLitigationLegalAuthorityVersion(
          userContext(res),
          req.params.matterId,
          req.params.authorityVersionId,
          { comment },
        );
      if (!data)
        return void res
          .status(404)
          .json({ detail: "Verified authority version not found" });
      res.json(data);
    } catch (error) {
      handleError(res, error);
    }
  },
);

litigationRouter.post(
  "/matters/:matterId/litigation/position-authorities",
  requireAuth,
  async (req, res) => {
    try {
      const data =
        await createAletheiaRepository().linkLitigationPositionAuthority(
          userContext(res),
          req.params.matterId,
          {
            claimId: cleanText(req.body?.claimId, 160),
            authorityVersionId: cleanText(req.body?.authorityVersionId, 160),
            applicabilityDate: cleanText(req.body?.applicabilityDate, 20),
            provisionReference: cleanText(req.body?.provisionReference, 500),
            exactQuote: cleanText(req.body?.exactQuote, 8_000),
            rationale: cleanText(req.body?.rationale, 2_000),
          },
        );
      if (!data)
        return void res.status(404).json({ detail: "Matter not found" });
      res.status(201).json(data);
    } catch (error) {
      handleError(res, error);
    }
  },
);

litigationRouter.post(
  "/matters/:matterId/litigation/position-authorities/:positionAuthorityId/withdraw",
  requireAuth,
  async (req, res) => {
    const comment = cleanText(req.body?.comment, 2_000);
    if (!comment)
      return void res.status(400).json({ detail: "comment is required" });
    try {
      const data =
        await createAletheiaRepository().withdrawLitigationPositionAuthority(
          userContext(res),
          req.params.matterId,
          req.params.positionAuthorityId,
          { comment },
        );
      if (!data)
        return void res
          .status(404)
          .json({ detail: "Active position authority not found" });
      res.json(data);
    } catch (error) {
      handleError(res, error);
    }
  },
);

litigationRouter.put(
  "/matters/:matterId/litigation/profile",
  requireAuth,
  async (req, res) => {
    const exhibitStart = Number(req.body?.exhibitStart);
    const paginationPolicy = cleanText(req.body?.paginationPolicy, 40);
    const documentTemplateId =
      cleanText(req.body?.documentTemplateId, 120) ||
      DEFAULT_LITIGATION_DOCUMENT_TEMPLATE_ID;
    const documentTemplateVersion =
      req.body?.documentTemplateVersion === undefined
        ? DEFAULT_LITIGATION_DOCUMENT_TEMPLATE_VERSION
        : Number(req.body.documentTemplateVersion);
    if (!Number.isSafeInteger(exhibitStart)) {
      return void res.status(400).json({ detail: "exhibitStart is invalid" });
    }
    if (!new Set(["auto", "source_native"]).has(paginationPolicy)) {
      return void res
        .status(400)
        .json({ detail: "paginationPolicy is invalid" });
    }
    if (!documentTemplateId || !Number.isSafeInteger(documentTemplateVersion)) {
      return void res
        .status(400)
        .json({ detail: "document template selection is invalid" });
    }
    try {
      const data = await createAletheiaRepository().updateLitigationProfile(
        userContext(res),
        req.params.matterId,
        {
          organizationName: nullableText(req.body?.organizationName, 240),
          court: nullableText(req.body?.court, 240),
          caseNumber: nullableText(req.body?.caseNumber, 160),
          exhibitPrefix: cleanText(req.body?.exhibitPrefix, 20),
          exhibitStart,
          paginationPolicy: paginationPolicy as "auto" | "source_native",
          documentTemplateId,
          documentTemplateVersion,
        },
      );
      if (!data)
        return void res.status(404).json({ detail: "Matter not found" });
      res.json(data);
    } catch (error) {
      handleError(res, error);
    }
  },
);

litigationRouter.post(
  "/matters/:matterId/litigation/artifacts/:kind",
  requireAuth,
  async (req, res) => {
    const kind = cleanText(req.params.kind, 80);
    if (!LITIGATION_ARTIFACT_KINDS.has(kind)) {
      return void res.status(400).json({ detail: "artifact kind is invalid" });
    }
    try {
      const data = await createAletheiaRepository().generateLitigationArtifact(
        userContext(res),
        req.params.matterId,
        kind as LitigationArtifactKind,
      );
      if (!data)
        return void res.status(404).json({ detail: "Matter not found" });
      res.status(201).json(data);
    } catch (error) {
      handleError(res, error);
    }
  },
);

litigationRouter.post(
  "/matters/:matterId/litigation/artifacts/:artifactId/document-draft",
  requireAuth,
  async (req, res) => {
    const artifactId = boundedText(req.params.artifactId, 1, 160);
    if (!artifactId)
      return void res.status(400).json({ detail: "artifactId is invalid" });
    try {
      const data = await createAletheiaRepository().createLitigationDocumentDraft(
        userContext(res),
        req.params.matterId,
        { artifactId },
      );
      if (!data)
        return void res.status(404).json({ detail: "Current artifact not found" });
      res.status(201).json(data);
    } catch (error) {
      handleError(res, error);
    }
  },
);

litigationRouter.get(
  "/matters/:matterId/litigation/document-drafts",
  requireAuth,
  async (req, res) => {
    try {
      const data = await createAletheiaRepository().listLitigationDocumentDrafts(
        userContext(res),
        req.params.matterId,
      );
      if (!data) return void res.status(404).json({ detail: "Matter not found" });
      res.json({ document_drafts: data });
    } catch (error) {
      handleError(res, error);
    }
  },
);

litigationRouter.get(
  "/matters/:matterId/litigation/document-drafts/:documentId",
  requireAuth,
  async (req, res) => {
    try {
      const data = await createAletheiaRepository().getLitigationDocumentDraft(
        userContext(res),
        req.params.matterId,
        req.params.documentId,
      );
      if (!data) return void res.status(404).json({ detail: "Document draft not found" });
      res.json(data);
    } catch (error) {
      handleError(res, error);
    }
  },
);

litigationRouter.post(
  "/matters/:matterId/litigation/document-drafts/:documentId/versions",
  requireAuth,
  async (req, res) => {
    const baseVersion = boundedPositiveInteger(req.body?.baseVersion);
    const changeSummary = boundedText(req.body?.changeSummary, 3, 1_000);
    const sections = documentDraftSections(req.body?.sections);
    if (!baseVersion || !changeSummary || !sections) {
      return void res.status(400).json({ detail: "Document version payload is invalid" });
    }
    try {
      const data = await createAletheiaRepository().appendLitigationDocumentDraftVersion(
        userContext(res),
        req.params.matterId,
        req.params.documentId,
        { baseVersion, changeSummary, sections },
      );
      if (!data) return void res.status(404).json({ detail: "Document draft not found" });
      res.status(201).json(data);
    } catch (error) {
      handleError(res, error);
    }
  },
);

litigationRouter.get(
  "/matters/:matterId/litigation/document-drafts/:documentId/diff",
  requireAuth,
  async (req, res) => {
    const fromVersion = boundedPositiveInteger(req.query.fromVersion);
    const toVersion = boundedPositiveInteger(req.query.toVersion);
    if (!fromVersion || !toVersion) {
      return void res.status(400).json({ detail: "fromVersion and toVersion are required" });
    }
    try {
      const data = await createAletheiaRepository().diffLitigationDocumentDraftVersions(
        userContext(res),
        req.params.matterId,
        req.params.documentId,
        fromVersion,
        toVersion,
      );
      if (!data) return void res.status(404).json({ detail: "Document draft version not found" });
      res.json(data);
    } catch (error) {
      handleError(res, error);
    }
  },
);

litigationRouter.post(
  "/matters/:matterId/litigation/document-drafts/:documentId/versions/:versionId/review",
  requireAuth,
  async (req, res) => {
    const decision = req.body?.decision;
    const reason = boundedText(req.body?.reason, 10, 2_000);
    if ((decision !== "approved" && decision !== "rejected") || !reason) {
      return void res.status(400).json({ detail: "Review payload is invalid" });
    }
    try {
      const data = await createAletheiaRepository().reviewLitigationDocumentDraftVersion(
        userContext(res),
        req.params.matterId,
        req.params.documentId,
        req.params.versionId,
        { decision, reason },
      );
      if (!data) return void res.status(404).json({ detail: "Document draft version not found" });
      res.json(data);
    } catch (error) {
      handleError(res, error);
    }
  },
);

litigationRouter.post(
  "/matters/:matterId/litigation/document-drafts/:documentId/withdraw",
  requireAuth,
  async (req, res) => {
    const reason = boundedText(req.body?.reason, 3, 2_000);
    if (!reason) return void res.status(400).json({ detail: "Withdrawal reason is invalid" });
    try {
      const data = await createAletheiaRepository().withdrawLitigationDocumentDraft(
        userContext(res),
        req.params.matterId,
        req.params.documentId,
        { reason },
      );
      if (!data) return void res.status(404).json({ detail: "Document draft not found" });
      res.json(data);
    } catch (error) {
      handleError(res, error);
    }
  },
);

litigationRouter.post(
  "/matters/:matterId/litigation/deadlines/:deadlineId/task",
  requireAuth,
  async (req, res) => {
    const priority = taskPriority(req.body?.priority);
    if (!priority) {
      return void res.status(400).json({ detail: "priority is invalid" });
    }
    try {
      const result =
        (await createAletheiaRepository().createTaskFromLitigationDeadline(
          userContext(res),
          req.params.matterId,
          req.params.deadlineId,
          {
            title: nullableText(req.body?.title, 1000),
            priority,
            note: nullableText(req.body?.note, 4000),
          },
        )) as { task: unknown; created: boolean } | null;
      if (!result) {
        return void res.status(404).json({
          detail:
            "Confirmed or completed deadline not found in this litigation matter",
        });
      }
      res.status(result.created ? 201 : 200).json(result.task);
    } catch (error) {
      handleError(res, error);
    }
  },
);

litigationRouter.get("/tasks", requireAuth, async (req, res) => {
  const status = taskStatusFilter(req.query.status);
  if (!status) {
    return void res.status(400).json({ detail: "status is invalid" });
  }
  try {
    const tasks = await createAletheiaRepository().listTasks(
      userContext(res),
      status,
    );
    res.json(tasks);
  } catch (error) {
    handleError(res, error);
  }
});

litigationRouter.post(
  "/task-notifications/claim",
  requireAuth,
  async (_req, res) => {
    try {
      res.json(
        await createAletheiaRepository().claimTaskNotifications(
          userContext(res),
        ),
      );
    } catch (error) {
      handleError(res, error);
    }
  },
);

litigationRouter.post(
  "/task-notifications/:deliveryId/ack",
  requireAuth,
  async (req, res) => {
    const leaseToken = cleanText(req.body?.leaseToken, 160);
    const outcome = cleanText(req.body?.outcome, 20);
    const failureCode = nullableText(req.body?.failureCode, 80);
    if (!/^[a-zA-Z0-9_-]{1,160}$/.test(req.params.deliveryId)) {
      return void res.status(400).json({ detail: "deliveryId is invalid" });
    }
    if (!/^[a-zA-Z0-9-]{1,160}$/.test(leaseToken)) {
      return void res.status(400).json({ detail: "leaseToken is invalid" });
    }
    if (outcome !== "delivered" && outcome !== "failed") {
      return void res.status(400).json({ detail: "outcome is invalid" });
    }
    if (failureCode && !/^[a-z0-9_-]{1,80}$/.test(failureCode)) {
      return void res.status(400).json({ detail: "failureCode is invalid" });
    }
    try {
      const data = await createAletheiaRepository().acknowledgeTaskNotification(
        userContext(res),
        req.params.deliveryId,
        { leaseToken, outcome, failureCode },
      );
      if (!data)
        return void res
          .status(409)
          .json({ detail: "Notification lease is stale" });
      res.json(data);
    } catch (error) {
      handleError(res, error);
    }
  },
);

litigationRouter.get("/tasks/calendar.ics", requireAuth, async (req, res) => {
  const status = taskStatusFilter(req.query.status);
  if (!status) {
    return void res.status(400).json({ detail: "status is invalid" });
  }
  try {
    const tasks = await createAletheiaRepository().exportTaskCalendar(
      userContext(res),
      status,
    );
    const bytes = Buffer.from(buildTaskCalendar(tasks), "utf8");
    res.status(200);
    res.setHeader("Content-Type", "text/calendar; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="aletheia-tasks.ics"; filename*=UTF-8''aletheia-tasks.ics`,
    );
    res.setHeader("Content-Length", String(bytes.length));
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.send(bytes);
  } catch (error) {
    handleError(res, error);
  }
});

litigationRouter.post(
  "/tasks/:taskId/complete",
  requireAuth,
  async (req, res) => {
    try {
      const task = await createAletheiaRepository().completeTask(
        userContext(res),
        req.params.taskId,
      );
      if (!task) return void res.status(404).json({ detail: "Task not found" });
      res.json(task);
    } catch (error) {
      handleError(res, error);
    }
  },
);

litigationRouter.post(
  "/tasks/:taskId/reopen",
  requireAuth,
  async (req, res) => {
    try {
      const task = await createAletheiaRepository().reopenTask(
        userContext(res),
        req.params.taskId,
      );
      if (!task) return void res.status(404).json({ detail: "Task not found" });
      res.json(task);
    } catch (error) {
      handleError(res, error);
    }
  },
);

litigationRouter.post(
  "/matters/:matterId/litigation/artifacts/:workProductId/export-approval/votes",
  requireAuth,
  async (req, res) => {
    const approvalCheckpointId = cleanText(req.body?.approvalCheckpointId, 160);
    const decision = cleanText(req.body?.decision, 40);
    if (!approvalCheckpointId) {
      return void res
        .status(400)
        .json({ detail: "approvalCheckpointId is required" });
    }
    if (decision !== "approved" && decision !== "rejected") {
      return void res
        .status(400)
        .json({ detail: "decision must be approved or rejected" });
    }
    try {
      const data =
        await createAletheiaRepository().voteLitigationArtifactExportApproval(
          userContext(res),
          req.params.matterId,
          req.params.workProductId,
          {
            approvalCheckpointId,
            decision,
            comment: nullableText(req.body?.comment, 1_000),
          },
        );
      if (!data)
        return void res.status(404).json({ detail: "Artifact not found" });
      res.json(data);
    } catch (error) {
      handleError(res, error);
    }
  },
);

litigationRouter.get(
  "/matters/:matterId/litigation/artifacts/:workProductId/export-approval",
  requireAuth,
  async (req, res) => {
    try {
      const data =
        await createAletheiaRepository().getLitigationArtifactExportApproval(
          userContext(res),
          req.params.matterId,
          req.params.workProductId,
        );
      if (!data)
        return void res.status(404).json({ detail: "Artifact not found" });
      res.json(data);
    } catch (error) {
      handleError(res, error);
    }
  },
);

litigationRouter.post(
  "/matters/:matterId/litigation/artifacts/:workProductId/export",
  requireAuth,
  async (req, res) => {
    const approvalCheckpointId = cleanText(req.body?.approvalCheckpointId, 160);
    const restrictedGovernanceApprovalRequestId = nullableText(
      req.body?.restrictedGovernanceApprovalRequestId,
      160,
    );
    const format = ["docx", "json", "zip"].includes(req.body?.format)
      ? (req.body.format as "docx" | "json" | "zip")
      : "docx";
    if (!approvalCheckpointId) {
      return void res
        .status(400)
        .json({ detail: "approvalCheckpointId is required" });
    }
    try {
      const data = await createAletheiaRepository().exportLitigationArtifact(
        userContext(res),
        req.params.matterId,
        req.params.workProductId,
        approvalCheckpointId,
        format,
        restrictedGovernanceApprovalRequestId,
      );
      if (!data)
        return void res.status(404).json({ detail: "Artifact not found" });
      const publicExport = { ...(data as Record<string, unknown>) };
      delete publicExport.exportPath;
      res.status(201).json(publicExport);
    } catch (error) {
      handleError(res, error);
    }
  },
);

litigationRouter.get(
  "/matters/:matterId/litigation/exports/:exportId/download",
  requireAuth,
  async (req, res) => {
    try {
      const data = await createAletheiaRepository().downloadLitigationArtifact(
        userContext(res),
        req.params.matterId,
        req.params.exportId,
      );
      if (!data) {
        return void res.status(404).json({ detail: "Export not found" });
      }
      res.status(200);
      res.setHeader("Content-Type", data.mimeType);
      res.setHeader(
        "Content-Disposition",
        artifactContentDisposition(data.title, data.version, data.format),
      );
      res.setHeader("Content-Length", String(data.bytes.length));
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.send(data.bytes);
    } catch (error) {
      handleError(res, error);
    }
  },
);

litigationRouter.get(
  "/matters/:matterId/litigation/eval-runs",
  requireAuth,
  async (req, res) => {
    try {
      const data = await createAletheiaRepository().listLitigationEvalRuns(
        userContext(res),
        req.params.matterId,
      );
      if (!data)
        return void res.status(404).json({ detail: "Matter not found" });
      res.json(data);
    } catch (error) {
      handleError(res, error);
    }
  },
);

litigationRouter.post(
  "/matters/:matterId/litigation/agent-runs/:runId/review",
  requireAuth,
  async (req, res) => {
    try {
      const data =
        await createAletheiaRepository().requestLitigationAgentOutputReview(
          userContext(res),
          req.params.matterId,
          req.params.runId,
        );
      if (!data)
        return void res.status(404).json({ detail: "Matter not found" });
      res.status(201).json(data);
    } catch (error) {
      handleError(res, error);
    }
  },
);

litigationRouter.post(
  "/matters/:matterId/litigation/agent-output-reviews/:reviewId/decision",
  requireAuth,
  async (req, res) => {
    const decisionValue = cleanText(req.body?.decision, 20);
    const comment = cleanText(req.body?.comment, 2_000);
    if (decisionValue !== "approved" && decisionValue !== "rejected") {
      return void res.status(400).json({ detail: "decision is invalid" });
    }
    try {
      const data =
        await createAletheiaRepository().decideLitigationAgentOutputReview(
          userContext(res),
          req.params.matterId,
          req.params.reviewId,
          { decision: decisionValue, comment },
        );
      if (!data)
        return void res.status(404).json({ detail: "Review not found" });
      res.json(data);
    } catch (error) {
      handleError(res, error);
    }
  },
);

litigationRouter.post(
  "/matters/:matterId/litigation/agent-runs/:runId/steps/:stepId/findings/:findingIndex/review",
  requireAuth,
  async (req, res) => {
    const assessment = cleanText(req.body?.assessment, 20);
    const reason = cleanText(req.body?.reason, 2_000);
    const findingIndex = Number(req.params.findingIndex);
    if (!["supported", "partial", "unsupported"].includes(assessment)) {
      return void res.status(400).json({ detail: "assessment is invalid" });
    }
    if (!Number.isInteger(findingIndex) || findingIndex < 0) {
      return void res.status(400).json({ detail: "findingIndex is invalid" });
    }
    try {
      const data =
        await createAletheiaRepository().reviewLitigationAgentFinding(
          userContext(res),
          req.params.matterId,
          req.params.runId,
          req.params.stepId,
          findingIndex,
          {
            assessment: assessment as "supported" | "partial" | "unsupported",
            reason,
          },
        );
      if (!data)
        return void res.status(404).json({ detail: "Matter not found" });
      res.status(201).json(data);
    } catch (error) {
      handleError(res, error);
    }
  },
);

litigationRouter.post(
  "/matters/:matterId/litigation/agent-runs/:runId/steps/:stepId/findings/:findingIndex/semantic-check",
  requireAuth,
  async (req, res) => {
    const findingIndex = Number(req.params.findingIndex);
    if (!Number.isInteger(findingIndex) || findingIndex < 0) {
      return void res.status(400).json({ detail: "findingIndex is invalid" });
    }
    try {
      const data = await createAletheiaRepository().runLitigationAgentFindingSemanticCheck(
        userContext(res),
        req.params.matterId,
        req.params.runId,
        req.params.stepId,
        findingIndex,
      );
      if (!data) return void res.status(404).json({ detail: "Matter not found" });
      res.status(201).json(data);
    } catch (error) {
      handleError(res, error);
    }
  },
);

litigationRouter.post(
  "/matters/:matterId/litigation/eval-runs",
  requireAuth,
  async (req, res) => {
    try {
      const data = await createAletheiaRepository().runLitigationEvalSuite(
        userContext(res),
        req.params.matterId,
      );
      if (!data)
        return void res.status(404).json({ detail: "Matter not found" });
      res.status(201).json(data);
    } catch (error) {
      handleError(res, error);
    }
  },
);

litigationRouter.post(
  "/matters/:matterId/litigation/source-spans/:sourceSpanId/verify-original",
  requireAuth,
  async (req, res) => {
    const reason = cleanText(req.body?.reason, 2000);
    try {
      const data =
        await createAletheiaRepository().verifyLitigationSourceSpanOriginal(
          userContext(res),
          req.params.matterId,
          req.params.sourceSpanId,
          reason,
        );
      if (!data) {
        return void res
          .status(404)
          .json({ detail: "Source citation not found" });
      }
      res.status(201).json(data);
    } catch (error) {
      handleError(res, error);
    }
  },
);

litigationRouter.get(
  "/matters/:matterId/litigation/source-spans/:sourceSpanId/original-verification-history",
  requireAuth,
  async (req, res) => {
    try {
      const result =
        await createAletheiaRepository().listLitigationSourceSpanOriginalVerificationHistory(
          userContext(res),
          req.params.matterId,
          req.params.sourceSpanId,
        );
      if (!result) {
        return void res.status(404).json({ detail: "Source citation not found" });
      }
      res.json(result);
    } catch (error) {
      handleError(res, error);
    }
  },
);

litigationRouter.post(
  "/matters/:matterId/litigation/source-spans/:sourceSpanId/verifications/:verificationId/withdraw",
  requireAuth,
  async (req, res) => {
    const reason =
      typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    try {
      const data =
        await createAletheiaRepository().withdrawLitigationSourceSpanOriginalVerification(
          userContext(res),
          req.params.matterId,
          req.params.sourceSpanId,
          req.params.verificationId,
          reason,
        );
      if (!data) {
        return void res.status(404).json({ detail: "Source verification not found" });
      }
      res.status(201).json(data);
    } catch (error) {
      handleError(res, error);
    }
  },
);

litigationRouter.post(
  "/matters/:matterId/litigation/facts",
  requireAuth,
  async (req, res) => {
    const statement = cleanText(req.body?.statement, 4000);
    const source = sourceSpan(req.body?.source);
    const datePrecision = cleanText(req.body?.datePrecision, 40) || "unknown";
    const sourceRelation =
      cleanText(req.body?.sourceRelation, 40) || "supports";
    const helpfulness = cleanText(req.body?.helpfulness, 40) || "unknown";
    const confidence = cleanText(req.body?.confidence, 20) || null;
    if (!statement) {
      return void res.status(400).json({ detail: "statement is required" });
    }
    if (source === "invalid") {
      return void res.status(400).json({ detail: "source is invalid" });
    }
    if (!LITIGATION_DATE_PRECISIONS.has(datePrecision)) {
      return void res.status(400).json({ detail: "datePrecision is invalid" });
    }
    if (!LITIGATION_SOURCE_RELATIONS.has(sourceRelation)) {
      return void res.status(400).json({ detail: "sourceRelation is invalid" });
    }
    if (!LITIGATION_HELPFULNESS.has(helpfulness)) {
      return void res.status(400).json({ detail: "helpfulness is invalid" });
    }
    if (confidence && !["low", "medium", "high"].includes(confidence)) {
      return void res.status(400).json({ detail: "confidence is invalid" });
    }
    try {
      const data = await createAletheiaRepository().createLitigationFact(
        userContext(res),
        req.params.matterId,
        {
          statement,
          occurredAt: nullableText(req.body?.occurredAt, 80),
          datePrecision,
          sourceRelation,
          helpfulness,
          confidence: confidence as "low" | "medium" | "high" | null,
          source,
          createdBy: "human",
          metadata: metadata(req.body?.metadata),
        },
      );
      if (!data)
        return void res.status(404).json({ detail: "Matter not found" });
      res.status(201).json(data);
    } catch (error) {
      handleError(res, error);
    }
  },
);

litigationRouter.post(
  "/matters/:matterId/litigation/facts/:factId/decision",
  requireAuth,
  async (req, res) => {
    const next = decision(req.body?.decision);
    if (!next)
      return void res.status(400).json({ detail: "decision is invalid" });
    try {
      const data = await createAletheiaRepository().decideLitigationFact(
        userContext(res),
        req.params.matterId,
        req.params.factId,
        { decision: next, comment: nullableText(req.body?.comment, 2000) },
      );
      if (!data) {
        return void res
          .status(404)
          .json({ detail: "Open fact proposal not found" });
      }
      res.json(data);
    } catch (error) {
      handleError(res, error);
    }
  },
);

litigationRouter.post(
  "/matters/:matterId/litigation/claims",
  requireAuth,
  async (req, res) => {
    const kind = cleanText(req.body?.kind, 40);
    const title = cleanText(req.body?.title, 1000);
    const confidence = cleanText(req.body?.confidence, 20) || null;
    const source = sourceSpan(req.body?.source);
    const sourceRelation =
      cleanText(req.body?.sourceRelation, 40) || "supports";
    if (!LITIGATION_CLAIM_KINDS.has(kind)) {
      return void res.status(400).json({ detail: "kind is invalid" });
    }
    if (!title)
      return void res.status(400).json({ detail: "title is required" });
    if (confidence && !["low", "medium", "high"].includes(confidence)) {
      return void res.status(400).json({ detail: "confidence is invalid" });
    }
    if (source === "invalid") {
      return void res.status(400).json({ detail: "source is invalid" });
    }
    if (!LITIGATION_CLAIM_SOURCE_RELATIONS.has(sourceRelation)) {
      return void res.status(400).json({ detail: "sourceRelation is invalid" });
    }
    try {
      const data = await createAletheiaRepository().createLitigationClaim(
        userContext(res),
        req.params.matterId,
        {
          kind,
          title,
          legalBasis: nullableText(req.body?.legalBasis, 4000),
          confidence: confidence as "low" | "medium" | "high" | null,
          uncertainty: nullableText(req.body?.uncertainty, 4000),
          parentClaimId: nullableText(req.body?.parentClaimId, 160),
          burdenPartyId: nullableText(req.body?.burdenPartyId, 160),
          source,
          sourceRelation: sourceRelation as
            | "authority"
            | "supports"
            | "contradicts",
          createdBy: "human",
          metadata: metadata(req.body?.metadata),
        },
      );
      if (!data)
        return void res.status(404).json({ detail: "Matter not found" });
      res.status(201).json(data);
    } catch (error) {
      handleError(res, error);
    }
  },
);

litigationRouter.post(
  "/matters/:matterId/litigation/claims/:claimId/reviews",
  requireAuth,
  async (req, res) => {
    const kind = cleanText(req.body?.kind, 40);
    const reason = cleanText(req.body?.reason, 4000);
    const requestedOutcome = cleanText(req.body?.requestedOutcome, 40);
    const parentReviewId = nullableText(req.body?.parentReviewId, 100);
    if (!LITIGATION_POSITION_REVIEW_KINDS.has(kind)) {
      return void res.status(400).json({ detail: "kind is invalid" });
    }
    if (!reason) {
      return void res.status(400).json({ detail: "reason is required" });
    }
    if (!LITIGATION_POSITION_REVIEW_OUTCOMES.has(requestedOutcome)) {
      return void res
        .status(400)
        .json({ detail: "requestedOutcome is invalid" });
    }
    try {
      const data = await createAletheiaRepository().createPositionReview(
        userContext(res),
        req.params.matterId,
        req.params.claimId,
        {
          kind: kind as "objection" | "reconsideration" | "withdrawal",
          reason,
          requestedOutcome: requestedOutcome as
            | "confirmed"
            | "rejected"
            | "withdrawn",
          parentReviewId,
        },
      );
      if (!data) {
        return void res.status(404).json({ detail: "Claim not found" });
      }
      res.status(201).json(data);
    } catch (error) {
      handleError(res, error);
    }
  },
);

litigationRouter.post(
  "/matters/:matterId/litigation/position-reviews/:reviewId/resolve",
  requireAuth,
  async (req, res) => {
    const resolution = cleanText(req.body?.resolution, 40);
    if (!LITIGATION_POSITION_REVIEW_RESOLUTIONS.has(resolution)) {
      return void res.status(400).json({ detail: "resolution is invalid" });
    }
    try {
      const data = await createAletheiaRepository().resolvePositionReview(
        userContext(res),
        req.params.matterId,
        req.params.reviewId,
        {
          resolution: resolution as "upheld" | "granted" | "dismissed",
          comment: nullableText(req.body?.comment, 4000),
        },
      );
      if (!data) {
        return void res
          .status(404)
          .json({ detail: "Position review not found" });
      }
      res.json(data);
    } catch (error) {
      handleError(res, error);
    }
  },
);

litigationRouter.post(
  "/matters/:matterId/litigation/position-reviews/:reviewId/withdraw",
  requireAuth,
  async (req, res) => {
    try {
      const data = await createAletheiaRepository().withdrawPositionReview(
        userContext(res),
        req.params.matterId,
        req.params.reviewId,
      );
      if (!data) {
        return void res
          .status(404)
          .json({ detail: "Position review not found" });
      }
      res.json(data);
    } catch (error) {
      handleError(res, error);
    }
  },
);

litigationRouter.post(
  "/matters/:matterId/litigation/claims/:claimId/decision",
  requireAuth,
  async (req, res) => {
    const next = decision(req.body?.decision);
    if (!next)
      return void res.status(400).json({ detail: "decision is invalid" });
    try {
      const data = await createAletheiaRepository().decideLitigationClaim(
        userContext(res),
        req.params.matterId,
        req.params.claimId,
        { decision: next, comment: nullableText(req.body?.comment, 2000) },
      );
      if (!data) {
        return void res
          .status(404)
          .json({ detail: "Open claim proposal not found" });
      }
      res.json(data);
    } catch (error) {
      handleError(res, error);
    }
  },
);

litigationRouter.post(
  "/matters/:matterId/litigation/claims/:claimId/elements",
  requireAuth,
  async (req, res) => {
    const title = cleanText(req.body?.title, 1000);
    const sequence = Number(req.body?.sequence ?? 0);
    if (!title)
      return void res.status(400).json({ detail: "title is required" });
    if (!Number.isInteger(sequence) || sequence < 0) {
      return void res.status(400).json({ detail: "sequence is invalid" });
    }
    try {
      const data = await createAletheiaRepository().createLitigationElement(
        userContext(res),
        req.params.matterId,
        req.params.claimId,
        {
          title,
          sequence,
          description: nullableText(req.body?.description, 4000),
          createdBy: "human",
          metadata: metadata(req.body?.metadata),
        },
      );
      if (!data)
        return void res.status(404).json({ detail: "Claim not found" });
      res.status(201).json(data);
    } catch (error) {
      handleError(res, error);
    }
  },
);

litigationRouter.post(
  "/matters/:matterId/litigation/elements/:elementId/decision",
  requireAuth,
  async (req, res) => {
    const next = decision(req.body?.decision);
    if (!next)
      return void res.status(400).json({ detail: "decision is invalid" });
    try {
      const data = await createAletheiaRepository().decideLitigationElement(
        userContext(res),
        req.params.matterId,
        req.params.elementId,
        { decision: next, comment: nullableText(req.body?.comment, 2000) },
      );
      if (!data) {
        return void res
          .status(404)
          .json({ detail: "Open element proposal not found" });
      }
      res.json(data);
    } catch (error) {
      handleError(res, error);
    }
  },
);

litigationRouter.post(
  "/matters/:matterId/litigation/elements/:elementId/facts",
  requireAuth,
  async (req, res) => {
    const factId = cleanText(req.body?.factId, 160);
    const relation = cleanText(req.body?.relation, 40);
    if (!factId || !["supports", "contradicts"].includes(relation)) {
      return void res
        .status(400)
        .json({ detail: "factId or relation is invalid" });
    }
    try {
      const data = await createAletheiaRepository().linkLitigationElementFact(
        userContext(res),
        req.params.matterId,
        req.params.elementId,
        {
          factId,
          relation: relation as "supports" | "contradicts",
          note: nullableText(req.body?.note, 2000),
        },
      );
      if (!data) {
        return void res
          .status(404)
          .json({ detail: "Element or fact not found" });
      }
      res.status(201).json(data);
    } catch (error) {
      handleError(res, error);
    }
  },
);

litigationRouter.post(
  "/matters/:matterId/litigation/procedural-events",
  requireAuth,
  async (req, res) => {
    const eventType = cleanText(req.body?.eventType, 120);
    const title = cleanText(req.body?.title, 1000);
    const source = sourceSpan(req.body?.source);
    if (!eventType || !title) {
      return void res
        .status(400)
        .json({ detail: "eventType and title are required" });
    }
    if (source === "invalid") {
      return void res.status(400).json({ detail: "source is invalid" });
    }
    try {
      const data =
        await createAletheiaRepository().createLitigationProceduralEvent(
          userContext(res),
          req.params.matterId,
          {
            eventType,
            title,
            occurredAt: nullableText(req.body?.occurredAt, 80),
            source,
            createdBy: "human",
            metadata: metadata(req.body?.metadata),
          },
        );
      if (!data)
        return void res.status(404).json({ detail: "Matter not found" });
      res.status(201).json(data);
    } catch (error) {
      handleError(res, error);
    }
  },
);

litigationRouter.post(
  "/matters/:matterId/litigation/procedural-events/:eventId/decision",
  requireAuth,
  async (req, res) => {
    const next = decision(req.body?.decision);
    if (!next)
      return void res.status(400).json({ detail: "decision is invalid" });
    try {
      const data =
        await createAletheiaRepository().decideLitigationProceduralEvent(
          userContext(res),
          req.params.matterId,
          req.params.eventId,
          { decision: next, comment: nullableText(req.body?.comment, 2000) },
        );
      if (!data) {
        return void res
          .status(404)
          .json({ detail: "Open procedural event proposal not found" });
      }
      res.json(data);
    } catch (error) {
      handleError(res, error);
    }
  },
);

litigationRouter.post(
  "/matters/:matterId/litigation/procedural-events/:eventId/corrections",
  requireAuth,
  async (req, res) => {
    const title = cleanText(req.body?.title, 500);
    const occurredAt = cleanText(req.body?.occurredAt, 80);
    const reason = boundedText(req.body?.reason, 10, 2_000);
    const source = sourceSpan(req.body?.source);
    if (!title || !occurredAt || !reason || !Number.isFinite(Date.parse(occurredAt))) {
      return void res.status(400).json({
        detail: "title, valid occurredAt, and a 10-2000 character reason are required",
      });
    }
    if (source === "invalid") {
      return void res.status(400).json({ detail: "source is invalid" });
    }
    try {
      const data = await createAletheiaRepository().correctLitigationProceduralEvent(
        userContext(res),
        req.params.matterId,
        req.params.eventId,
        { title, occurredAt, reason, source },
      );
      if (!data) {
        return void res.status(404).json({
          detail: "Current confirmed procedural event not found",
        });
      }
      res.status(201).json(data);
    } catch (error) {
      handleError(res, error);
    }
  },
);

litigationRouter.get(
  "/matters/:matterId/litigation/court-calendars",
  requireAuth,
  async (req, res) => {
    try {
      const data = await createAletheiaRepository().listLitigationCourtCalendarVersions(
        userContext(res),
        req.params.matterId,
      );
      if (!data) return void res.status(404).json({ detail: "Matter not found" });
      res.json(data);
    } catch (error) {
      handleError(res, error);
    }
  },
);

litigationRouter.post(
  "/matters/:matterId/litigation/court-calendars",
  requireAuth,
  async (req, res) => {
    try {
      const data = await createAletheiaRepository().createLitigationCourtCalendarVersion(
        userContext(res),
        req.params.matterId,
        {
          courtIdentifier: cleanText(req.body?.courtIdentifier, 300),
          name: cleanText(req.body?.name, 500),
          versionLabel: cleanText(req.body?.versionLabel, 300),
          sourceAuthorityVersionId: cleanText(req.body?.sourceAuthorityVersionId, 160),
          effectiveFrom: cleanText(req.body?.effectiveFrom, 20),
          effectiveTo: cleanText(req.body?.effectiveTo, 20),
          weeklyNonWorkingDays: req.body?.weeklyNonWorkingDays,
          overrides: req.body?.overrides,
        },
      );
      if (!data) return void res.status(404).json({ detail: "Matter not found" });
      res.status(201).json(data);
    } catch (error) {
      handleError(res, error);
    }
  },
);

litigationRouter.post(
  "/matters/:matterId/litigation/court-calendars/:versionId/verify",
  requireAuth,
  async (req, res) => {
    const comment = cleanText(req.body?.comment, 2_000);
    if (!comment) return void res.status(400).json({ detail: "comment is required" });
    try {
      const data = await createAletheiaRepository().verifyLitigationCourtCalendarVersion(
        userContext(res),
        req.params.matterId,
        req.params.versionId,
        { comment },
      );
      if (!data) return void res.status(404).json({ detail: "Draft court calendar version not found" });
      res.json(data);
    } catch (error) {
      handleError(res, error);
    }
  },
);

litigationRouter.post(
  "/matters/:matterId/litigation/court-calendars/:versionId/retire",
  requireAuth,
  async (req, res) => {
    const comment = cleanText(req.body?.comment, 2_000);
    if (!comment) return void res.status(400).json({ detail: "comment is required" });
    try {
      const data = await createAletheiaRepository().retireLitigationCourtCalendarVersion(
        userContext(res),
        req.params.matterId,
        req.params.versionId,
        { comment },
      );
      if (!data) return void res.status(404).json({ detail: "Active court calendar version not found" });
      res.json(data);
    } catch (error) {
      handleError(res, error);
    }
  },
);

litigationRouter.get(
  "/matters/:matterId/litigation/deadline-rules",
  requireAuth,
  async (req, res) => {
    try {
      const data = await createAletheiaRepository().listLitigationDeadlineRules(
        userContext(res),
        req.params.matterId,
      );
      if (!data)
        return void res.status(404).json({ detail: "Matter not found" });
      res.json(data);
    } catch (error) {
      handleError(res, error);
    }
  },
);

litigationRouter.post(
  "/matters/:matterId/litigation/deadline-rules",
  requireAuth,
  async (req, res) => {
    try {
      const data =
        await createAletheiaRepository().createLitigationDeadlineRule(
          userContext(res),
          req.params.matterId,
          {
            name: cleanText(req.body?.name, 500),
            triggerEventType: cleanText(req.body?.triggerEventType, 200),
            authorityVersionId: cleanText(req.body?.authorityVersionId, 160),
            provisionReference: cleanText(req.body?.provisionReference, 500),
            exactQuote: cleanText(req.body?.exactQuote, 8_000),
            offsetDays: Number(req.body?.offsetDays),
            countingBasis: cleanText(req.body?.countingBasis, 40),
            courtCalendarVersionId: cleanText(req.body?.courtCalendarVersionId, 160),
            startPolicy: cleanText(req.body?.startPolicy, 40),
          },
        );
      if (!data)
        return void res.status(404).json({ detail: "Matter not found" });
      res.status(201).json(data);
    } catch (error) {
      handleError(res, error);
    }
  },
);

litigationRouter.post(
  "/matters/:matterId/litigation/deadline-rules/:ruleId/verify",
  requireAuth,
  async (req, res) => {
    const comment = cleanText(req.body?.comment, 2_000);
    if (!comment)
      return void res.status(400).json({ detail: "comment is required" });
    try {
      const data =
        await createAletheiaRepository().verifyLitigationDeadlineRule(
          userContext(res),
          req.params.matterId,
          req.params.ruleId,
          { comment },
        );
      if (!data)
        return void res.status(404).json({ detail: "Draft rule not found" });
      res.json(data);
    } catch (error) {
      handleError(res, error);
    }
  },
);

litigationRouter.post(
  "/matters/:matterId/litigation/deadline-rules/:ruleId/calculate",
  requireAuth,
  async (req, res) => {
    const eventId = cleanText(req.body?.eventId, 160);
    const title = cleanText(req.body?.title, 1_000);
    if (!eventId || !title)
      return void res
        .status(400)
        .json({ detail: "eventId and title are required" });
    try {
      const data =
        await createAletheiaRepository().calculateLitigationDeadlineFromRule(
          userContext(res),
          req.params.matterId,
          req.params.ruleId,
          { eventId, title },
        );
      if (!data)
        return void res.status(404).json({ detail: "Verified rule not found" });
      res.status(201).json(data);
    } catch (error) {
      handleError(res, error);
    }
  },
);

litigationRouter.post(
  "/matters/:matterId/litigation/deadline-rules/:ruleId/retire",
  requireAuth,
  async (req, res) => {
    const comment = cleanText(req.body?.comment, 2_000);
    if (!comment)
      return void res.status(400).json({ detail: "comment is required" });
    try {
      const data =
        await createAletheiaRepository().retireLitigationDeadlineRule(
          userContext(res),
          req.params.matterId,
          req.params.ruleId,
          { comment },
        );
      if (!data)
        return void res.status(404).json({ detail: "Active rule not found" });
      res.json(data);
    } catch (error) {
      handleError(res, error);
    }
  },
);

litigationRouter.post(
  "/matters/:matterId/litigation/deadlines",
  requireAuth,
  async (req, res) => {
    const title = cleanText(req.body?.title, 1000);
    const dueAt = cleanText(req.body?.dueAt, 80);
    const ruleLabel = cleanText(req.body?.ruleLabel, 1000);
    const ruleVersion = cleanText(req.body?.ruleVersion, 120);
    const calculation = cleanText(req.body?.calculation, 4000);
    const source = sourceSpan(req.body?.source);
    if (
      !title ||
      !validIsoDate(dueAt) ||
      !ruleLabel ||
      !ruleVersion ||
      !calculation
    ) {
      return void res
        .status(400)
        .json({ detail: "Deadline fields are invalid" });
    }
    if (source === "invalid") {
      return void res.status(400).json({ detail: "source is invalid" });
    }
    try {
      const data = await createAletheiaRepository().createLitigationDeadline(
        userContext(res),
        req.params.matterId,
        {
          title,
          dueAt,
          triggeringEventId: nullableText(req.body?.triggeringEventId, 160),
          ruleLabel,
          ruleVersion,
          calculation,
          source,
          createdBy: "human",
          metadata: metadata(req.body?.metadata),
        },
      );
      if (!data)
        return void res.status(404).json({ detail: "Matter not found" });
      res.status(201).json(data);
    } catch (error) {
      handleError(res, error);
    }
  },
);

litigationRouter.post(
  "/matters/:matterId/litigation/deadlines/:deadlineId/decision",
  requireAuth,
  async (req, res) => {
    const next = decision(req.body?.decision);
    if (!next)
      return void res.status(400).json({ detail: "decision is invalid" });
    try {
      const data = await createAletheiaRepository().decideLitigationDeadline(
        userContext(res),
        req.params.matterId,
        req.params.deadlineId,
        { decision: next, comment: nullableText(req.body?.comment, 2000) },
      );
      if (!data) {
        return void res
          .status(404)
          .json({ detail: "Open deadline proposal not found" });
      }
      res.json(data);
    } catch (error) {
      handleError(res, error);
    }
  },
);
