import {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import { z, ZodError } from "zod";

import {
  cleanupRequestUploadedFiles,
  materializeUploadedFile,
  singleFileUpload,
  type UploadPathRemover,
} from "../lib/upload";
import {
  DOCUMENT_STUDIO_DOCX_MIME_TYPE,
  DOCUMENT_STUDIO_MAX_DOCX_BYTES,
  DocumentStudioDocxError,
  type DocumentStudioDocxWarning,
} from "../lib/workspace/documentStudioDocx";
import { WorkspaceApiError } from "../lib/workspace/errors";
import { DocumentStudioDraftTypeV20Schema } from "../lib/workspace/documentStudioDraftMetadataV20";
import {
  DOCUMENT_STUDIO_TEMPLATE_MAX_CONTENT_BYTES_V21,
  DOCUMENT_STUDIO_TEMPLATE_MAX_CONTENT_CHARS_V21,
  DOCUMENT_STUDIO_TEMPLATE_MAX_SECTIONS_V21,
} from "../lib/workspace/documentStudioTemplatesV21";
import { MIKE_LOCAL_USER_ID } from "../lib/workspace/mikeCompatibility";
import { TransportSafeSourceMetadataV11Schema } from "../lib/workspace/sourceFoundationContractsV11";
import {
  sendWorkspaceV1Download,
  type WorkspaceV1Context,
} from "./workspaceV1";

const Id = z.string().uuid();
const Title = z
  .string()
  .trim()
  .min(1)
  .refine(
    (value) => [...value].length <= 240,
    "Title must contain at most 240 characters.",
  )
  .refine(
    (value) => !/[\u0000-\u001f\u007f-\u009f]/u.test(value),
    "Title contains unsupported control characters.",
  );
const Content = z
  .string()
  .max(2_000_000)
  .refine(
    (value) =>
      !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value),
    "Document content contains unsupported control characters.",
  );
const Summary = z
  .string()
  .trim()
  .min(1)
  .refine(
    (value) => [...value].length <= 500,
    "Summary must contain at most 500 characters.",
  )
  .refine(
    (value) => !/[\u0000-\u001f\u007f-\u009f]/u.test(value),
    "Summary contains unsupported control characters.",
  );

const CreateDraft = z
  .object({
    title: Title,
    folder_id: Id.nullable().optional(),
    document_type: DocumentStudioDraftTypeV20Schema.optional(),
  })
  .strict();

const CreateDraftFromAssistant = z
  .object({ chat_id: Id, assistant_message_id: Id })
  .strict();
const CreateDraftFromWorkflow = z.object({ workflow_run_id: Id }).strict();
const CreateDraftFromTabular = z.object({ review_id: Id }).strict();
const CopyTemplate = z.object({ title: Title.optional() }).strict();
const CreateDraftFromTemplate = z
  .object({ title: Title.optional(), folder_id: Id.nullable().optional() })
  .strict();
const EmptySuggestionDecision = z.object({}).strict();

const DraftListCursorPayload = z
  .object({
    project_id: Id,
    updated_at: z.string().datetime({ precision: 3 }),
    draft_id: Id,
  })
  .strict();
const DraftListQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().min(1).max(512).optional(),
  })
  .strict();

function decodeDraftListCursor(
  value: string | undefined,
  expectedProjectId: string,
) {
  if (!value) return null;
  try {
    const parsed = DraftListCursorPayload.parse(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
    );
    if (parsed.project_id !== expectedProjectId) throw new Error("scope");
    return parsed;
  } catch {
    throw new WorkspaceApiError(
      422,
      "VALIDATION_ERROR",
      "Draft list cursor is invalid.",
    );
  }
}

function encodeDraftListCursor(
  value: {
    updatedAt: string;
    documentId: string;
  } | null,
  projectId: string,
) {
  return value
    ? Buffer.from(
        JSON.stringify({
          project_id: projectId,
          updated_at: value.updatedAt,
          draft_id: value.documentId,
        }),
        "utf8",
      ).toString("base64url")
    : null;
}

const ReadDocumentQuery = z
  .object({
    version_id: Id.optional(),
  })
  .strict();

const SaveDocument = z
  .object({
    expected_version_id: Id,
    content: Content,
    source: z.enum(["user_upload", "assistant_edit"]),
    citation_anchor_ids: z.array(Id).max(200).optional(),
    summary: Summary.nullable().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.citation_anchor_ids) {
      const unique = new Set(value.citation_anchor_ids);
      if (unique.size !== value.citation_anchor_ids.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["citation_anchor_ids"],
          message: "Citation anchors must be unique.",
        });
      }
    }
    if (Buffer.byteLength(value.content, "utf8") > 4_000_000) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["content"],
        message: "Document content exceeds the UTF-8 byte limit.",
      });
    }
  });

const RestoreVersion = z
  .object({
    expected_current_version_id: Id,
  })
  .strict();

const ImportDocxFields = z
  .object({
    expected_version_id: Id,
  })
  .strict();

const DOCX_WARNING_CODES = [
  "DOCX_IMAGES_IGNORED",
  "DOCX_FORMATTING_SIMPLIFIED",
  "DOCX_CONVERTER_WARNING",
  "MARKDOWN_IMAGES_OMITTED",
  "MARKDOWN_HTML_AS_TEXT",
  "MARKDOWN_BLOCKQUOTE_SIMPLIFIED",
] as const satisfies readonly DocumentStudioDocxWarning["code"][];
const DocxWarningCode = z.enum(DOCX_WARNING_CODES);
const DocxWarningCodes = z
  .array(DocxWarningCode)
  .max(DOCX_WARNING_CODES.length)
  .superRefine((codes, context) => {
    if (new Set(codes).size !== codes.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "DOCX warning codes must be unique.",
      });
    }
  });

const IsoDateTime = z.string().datetime({ offset: true });
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const SafeFilename = z
  .string()
  .min(1)
  .max(240)
  .refine((value) => !/[\u0000-\u001f\u007f-\u009f\\/]/u.test(value));
const OpaqueDocumentContent = Content.superRefine((value, context) => {
  if (Buffer.byteLength(value, "utf8") > 4_000_000) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Document content exceeds the UTF-8 byte limit.",
    });
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Document content contains unsupported control characters.",
    });
  }
});
const OpaqueExactQuote = z
  .string()
  .refine(
    (value) => [...value].length <= 8_000,
    "Citation quote exceeds the character limit.",
  )
  .refine((value) => value.trim().length > 0, "Citation quote is required.")
  .refine(
    (value) =>
      !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value),
    "Citation quote contains unsupported control characters.",
  );
const StudioVersionResponse = z
  .object({
    id: Id,
    version_number: z.number().int().positive(),
    source: z.enum(["user_upload", "assistant_edit", "user_accept"]),
    filename: SafeFilename,
    mime_type: z.literal("text/markdown"),
    size_bytes: z.number().int().nonnegative().max(4_000_000),
    content_sha256: Sha256,
    created_at: IsoDateTime,
    citation_anchor_ids: z.array(Id).max(200),
  })
  .strict();
const StudioCitationAnchorResponse = z
  .object({
    id: Id,
    snapshot_id: Id,
    ordinal: z.number().int().nonnegative(),
    exact_quote: OpaqueExactQuote,
    quote_sha256: Sha256,
    locator: TransportSafeSourceMetadataV11Schema,
  })
  .strict();
const StudioDocumentResponse = z
  .object({
    document_id: Id,
    project_id: Id,
    title: Title,
    filename: SafeFilename,
    format: z.literal("markdown"),
    current_version_id: Id,
    version: StudioVersionResponse,
    content: OpaqueDocumentContent,
    citation_anchors: z.array(StudioCitationAnchorResponse).max(200),
    capabilities: z
      .object({
        docx_import: z.literal(true),
        docx_export: z.literal(true),
      })
      .strict(),
  })
  .strict();
const StudioDocxImportResponse = z
  .object({
    document: StudioDocumentResponse,
    warnings: DocxWarningCodes,
  })
  .strict();
const StudioDocxFilename = SafeFilename.refine(
  (value) => value.toLowerCase().endsWith(".docx"),
  "DOCX filename must use the .docx extension.",
);
const StudioDocxExportResponse = z
  .object({
    filename: StudioDocxFilename,
    contentType: z.literal(DOCUMENT_STUDIO_DOCX_MIME_TYPE),
    bytes: z
      .instanceof(Uint8Array)
      .refine(
        (value) =>
          value.byteLength > 0 &&
          value.byteLength <= DOCUMENT_STUDIO_MAX_DOCX_BYTES,
        "DOCX export has an invalid size.",
      ),
    warningCodes: DocxWarningCodes,
  })
  .strict();
const StudioVersionListResponse = z
  .object({
    current_version_id: Id,
    versions: z.array(StudioVersionResponse).max(10_000),
  })
  .strict();
const StudioSuggestionResponse = z
  .object({
    id: Id,
    project_id: Id,
    document_id: Id,
    base_version_id: Id,
    message_id: Id.nullable(),
    change_id: z.string().min(1).max(160),
    start_offset: z.number().int().nonnegative(),
    end_offset: z.number().int().nonnegative(),
    offset_scope: z.literal("raw_markdown_v1"),
    offset_unit: z.literal("utf16_code_unit"),
    deleted_text: z.string().max(200_000),
    inserted_text: z.string().max(200_000),
    context_before: z.string().max(241),
    context_after: z.string().max(241),
    summary: Summary,
    status: z.enum(["pending", "accepted", "rejected"]),
    created_at: IsoDateTime,
    resolved_at: IsoDateTime.nullable(),
    result_version_id: Id.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.end_offset - value.start_offset !== value.deleted_text.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["end_offset"],
        message: "Suggestion offsets do not match deleted text.",
      });
    }
  });
const StudioSuggestionPreviewResponse = z
  .object({
    id: Id,
    project_id: Id,
    document_id: Id,
    base_version_id: Id,
    message_id: Id.nullable(),
    start_offset: z.number().int().nonnegative(),
    end_offset: z.number().int().nonnegative(),
    offset_scope: z.literal("raw_markdown_v1"),
    offset_unit: z.literal("utf16_code_unit"),
    deleted_preview: z.string().max(320),
    inserted_preview: z.string().max(320),
    deleted_truncated: z.boolean(),
    inserted_truncated: z.boolean(),
    context_before: z.string().max(241),
    context_after: z.string().max(241),
    summary: Summary,
    status: z.literal("pending"),
    created_at: IsoDateTime,
  })
  .strict();
const StudioSuggestionListResponse = z
  .object({
    suggestions: z.array(StudioSuggestionPreviewResponse).max(50),
    has_more: z.boolean(),
  })
  .strict();
const StudioSuggestionDecisionResponse = z
  .object({ suggestion: StudioSuggestionResponse })
  .strict();
const StudioSuggestionAcceptanceResponse = z
  .object({
    suggestion: StudioSuggestionResponse,
    document: StudioDocumentResponse,
  })
  .strict();
const StudioDraftSummaryResponse = z
  .object({
    draft_id: Id,
    project_id: Id,
    title: Title,
    document_type: DocumentStudioDraftTypeV20Schema,
    current_version_id: Id,
    current_version_number: z.number().int().positive(),
    updated_at: z.string().datetime({ precision: 3 }),
    source_count: z.number().int().nonnegative(),
    pending_suggestion_count: z.number().int().nonnegative(),
    origin_type: z.enum([
      "manual",
      "assistant",
      "workflow",
      "tabular",
      "unknown",
    ]),
  })
  .strict();
const StudioDraftSummaryListResponse = z
  .object({
    items: z.array(StudioDraftSummaryResponse).max(100),
    has_more: z.boolean(),
    next_cursor: z.string().min(1).max(512).nullable(),
  })
  .strict();
const TemplateScope = z.enum(["builtin", "project"]);
const DraftPlanSectionResponse = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
    heading: z.string().trim().min(1).max(120),
    purpose: z.string().trim().min(1).max(500),
    required_sources: z.array(z.string().trim().min(1).max(120)).max(8),
  })
  .strict();
const DraftPlanResponse = z
  .object({
    title: Title,
    document_type: DocumentStudioDraftTypeV20Schema,
    sections: z
      .array(DraftPlanSectionResponse)
      .min(1)
      .max(DOCUMENT_STUDIO_TEMPLATE_MAX_SECTIONS_V21),
  })
  .strict();
const TemplateSummaryResponse = z
  .object({
    template_id: Id,
    scope: TemplateScope,
    title: Title,
    description: z.string().trim().min(1).max(500),
    document_type: DocumentStudioDraftTypeV20Schema,
    section_count: z
      .number()
      .int()
      .min(1)
      .max(DOCUMENT_STUDIO_TEMPLATE_MAX_SECTIONS_V21),
    updated_at: IsoDateTime,
  })
  .strict();
const TemplateResponse = TemplateSummaryResponse.extend({
  content: z
    .string()
    .min(1)
    .max(DOCUMENT_STUDIO_TEMPLATE_MAX_CONTENT_CHARS_V21)
    .refine(
      (value) =>
        Buffer.byteLength(value, "utf8") <=
        DOCUMENT_STUDIO_TEMPLATE_MAX_CONTENT_BYTES_V21,
    ),
  plan: DraftPlanResponse,
}).strict();
const TemplateListResponse = z
  .object({ items: z.array(TemplateSummaryResponse).max(100) })
  .strict();
const TemplateDetailResponse = z
  .object({ template: TemplateResponse })
  .strict();
const TemplateDraftResponse = z
  .object({ document: StudioDocumentResponse, plan: DraftPlanResponse })
  .strict();
const UpdateTemplate = z
  .object({
    title: Title.optional(),
    description: z.string().trim().min(1).max(500).optional(),
    content: TemplateResponse.shape.content.optional(),
    plan: DraftPlanResponse.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one template field is required.",
  });

type TemplateDomain = {
  templateId: string;
  scope: "builtin" | "project";
  title: string;
  description: string;
  documentType: z.infer<typeof DocumentStudioDraftTypeV20Schema>;
  sectionCount?: number;
  updatedAt: string;
  content?: string;
  plan?: {
    title: string;
    documentType: z.infer<typeof DocumentStudioDraftTypeV20Schema>;
    sections: readonly {
      id: string;
      heading: string;
      purpose: string;
      requiredSources: readonly string[];
    }[];
  };
};

function draftPlanWire(plan: NonNullable<TemplateDomain["plan"]>) {
  return {
    title: plan.title,
    document_type: plan.documentType,
    sections: plan.sections.map((section) => ({
      id: section.id,
      heading: section.heading,
      purpose: section.purpose,
      required_sources: [...section.requiredSources],
    })),
  };
}

function draftPlanDomain(plan: z.infer<typeof DraftPlanResponse>) {
  return {
    title: plan.title,
    documentType: plan.document_type,
    sections: plan.sections.map((section) => ({
      id: section.id,
      heading: section.heading,
      purpose: section.purpose,
      requiredSources: section.required_sources,
    })),
  };
}

function templateSummaryWire(template: TemplateDomain) {
  const sectionCount = template.sectionCount ?? template.plan?.sections.length;
  return {
    template_id: template.templateId,
    scope: template.scope,
    title: template.title,
    description: template.description,
    document_type: template.documentType,
    section_count: sectionCount,
    updated_at: template.updatedAt,
  };
}

function templateWire(template: TemplateDomain) {
  if (template.content === undefined || template.plan === undefined) {
    throw new WorkspaceApiError(
      500,
      "INTERNAL_ERROR",
      "Document template detail is incomplete.",
    );
  }
  return {
    ...templateSummaryWire(template),
    content: template.content,
    plan: draftPlanWire(template.plan),
  };
}

export type WorkspaceDocumentStudioCreateInput = {
  title: string;
  folderId: string | null;
  documentType?: z.infer<typeof DocumentStudioDraftTypeV20Schema>;
};

export type WorkspaceDocumentStudioSaveInput = {
  expectedVersionId: string;
  content: string;
  source: "user_upload" | "assistant_edit";
  citationAnchorIds: string[];
  summary: string | null;
};

export type WorkspaceDocumentStudioRestoreInput = {
  expectedCurrentVersionId: string;
};

export type WorkspaceDocumentStudioDocxWarningCode =
  (typeof DOCX_WARNING_CODES)[number];

export type WorkspaceDocumentStudioImportInput = {
  expectedVersionId: string;
  filename: string;
  mimeType: string;
  buffer: Buffer;
};

export type WorkspaceDocumentStudioImportResult = {
  document: unknown;
  warningCodes: WorkspaceDocumentStudioDocxWarningCode[];
};

export type WorkspaceDocumentStudioExportResult = {
  filename: string;
  contentType: typeof DOCUMENT_STUDIO_DOCX_MIME_TYPE;
  bytes: Uint8Array;
  warningCodes: WorkspaceDocumentStudioDocxWarningCode[];
};

/** The dedicated Studio HTTP seam; implementations must enforce Project scope again. */
export interface WorkspaceDocumentStudioV1Port {
  listStudioTemplates?(
    context: WorkspaceV1Context,
    projectId: string,
  ): Promise<unknown>;
  getStudioTemplate?(
    context: WorkspaceV1Context,
    projectId: string,
    templateId: string,
  ): Promise<unknown>;
  copyStudioTemplate?(
    context: WorkspaceV1Context,
    projectId: string,
    templateId: string,
    title?: string,
  ): Promise<unknown>;
  updateStudioTemplate?(
    context: WorkspaceV1Context,
    projectId: string,
    templateId: string,
    input: {
      title?: string;
      description?: string;
      content?: string;
      plan?: ReturnType<typeof draftPlanDomain>;
    },
  ): Promise<unknown>;
  createStudioDocumentFromTemplate?(
    context: WorkspaceV1Context,
    projectId: string,
    templateId: string,
    input: { title?: string; folderId: string | null },
  ): Promise<unknown>;
  listStudioDrafts?(
    context: WorkspaceV1Context,
    projectId: string,
    input: {
      limit: number;
      cursor: { updatedAt: string; documentId: string } | null;
    },
  ): Promise<unknown>;
  createStudioDocument(
    context: WorkspaceV1Context,
    projectId: string,
    input: WorkspaceDocumentStudioCreateInput,
  ): Promise<unknown>;
  createStudioDocumentFromAssistantMessage?(
    context: WorkspaceV1Context,
    projectId: string,
    chatId: string,
    assistantMessageId: string,
  ): Promise<unknown>;
  createStudioDocumentFromWorkflowRun?(
    context: WorkspaceV1Context,
    projectId: string,
    workflowRunId: string,
  ): Promise<unknown>;
  createStudioDocumentFromTabularReview?(
    context: WorkspaceV1Context,
    projectId: string,
    reviewId: string,
  ): Promise<unknown>;
  getStudioDocument(
    context: WorkspaceV1Context,
    projectId: string,
    documentId: string,
    versionId?: string,
  ): Promise<unknown>;
  saveStudioDocument(
    context: WorkspaceV1Context,
    projectId: string,
    documentId: string,
    input: WorkspaceDocumentStudioSaveInput,
  ): Promise<unknown>;
  listStudioDocumentVersions(
    context: WorkspaceV1Context,
    projectId: string,
    documentId: string,
  ): Promise<unknown>;
  restoreStudioDocumentVersion(
    context: WorkspaceV1Context,
    projectId: string,
    documentId: string,
    versionId: string,
    input: WorkspaceDocumentStudioRestoreInput,
  ): Promise<unknown>;
  importStudioDocumentDocx(
    context: WorkspaceV1Context,
    projectId: string,
    documentId: string,
    input: WorkspaceDocumentStudioImportInput,
  ): Promise<WorkspaceDocumentStudioImportResult>;
  exportStudioDocumentDocx(
    context: WorkspaceV1Context,
    projectId: string,
    documentId: string,
    versionId?: string,
  ): Promise<WorkspaceDocumentStudioExportResult>;
  listStudioSuggestions?(
    context: WorkspaceV1Context,
    projectId: string,
    documentId: string,
  ): Promise<unknown>;
  getStudioSuggestion?(
    context: WorkspaceV1Context,
    projectId: string,
    documentId: string,
    suggestionId: string,
  ): Promise<unknown>;
  acceptStudioSuggestion?(
    context: WorkspaceV1Context,
    projectId: string,
    documentId: string,
    suggestionId: string,
  ): Promise<unknown>;
  rejectStudioSuggestion?(
    context: WorkspaceV1Context,
    projectId: string,
    documentId: string,
    suggestionId: string,
  ): Promise<unknown>;
}

export type WorkspaceDocumentStudioV1RouterOptions = {
  requireAuthentication?: boolean;
  principal?: (request: Request) => string | undefined;
  uploadPathRemover?: UploadPathRemover;
};

type AsyncHandler = (request: Request, response: Response) => Promise<void>;

function asyncRoute(handler: AsyncHandler) {
  return (request: Request, response: Response, next: NextFunction) => {
    void handler(request, response).catch(next);
  };
}

function contextFor(
  request: Request,
  options: WorkspaceDocumentStudioV1RouterOptions,
): WorkspaceV1Context {
  const response = request.res as Response | undefined;
  const candidate =
    options.principal?.(request) ??
    response?.locals.userId ??
    (request as Request & { userId?: unknown }).userId;
  if (
    options.requireAuthentication &&
    (typeof candidate !== "string" || !Id.safeParse(candidate).success)
  ) {
    throw new WorkspaceApiError(
      401,
      "UNAUTHORIZED",
      "Authentication is required.",
    );
  }
  if (typeof candidate === "string" && Id.safeParse(candidate).success) {
    return { principalId: candidate };
  }
  return { principalId: MIKE_LOCAL_USER_ID };
}

function idParam(request: Request, name: string): string {
  return Id.parse(request.params[name]);
}

function multipartFields(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function uploadedDocxFile(request: Request): Express.Multer.File {
  if (!request.file) {
    throw new WorkspaceApiError(
      422,
      "VALIDATION_ERROR",
      "A single DOCX file field named file is required.",
    );
  }
  return request.file;
}

async function withUploadedDocx<T>(
  request: Request,
  handler: (file: Express.Multer.File) => Promise<T>,
  removePath?: UploadPathRemover,
): Promise<T> {
  const file = uploadedDocxFile(request);
  let materialized: Express.Multer.File | undefined;
  let cleaned = false;
  try {
    materialized = await materializeUploadedFile(file);
    if (
      !Buffer.isBuffer(materialized.buffer) ||
      materialized.buffer.length < 1
    ) {
      throw new WorkspaceApiError(
        422,
        "VALIDATION_ERROR",
        "A non-empty DOCX file is required.",
      );
    }
    // The in-memory Buffer no longer depends on the temporary file. Remove the
    // file before the persistence handler runs so a cleanup failure can never
    // turn a committed version into an apparent failed import.
    await cleanupRequestUploadedFiles(request, [materialized], removePath);
    cleaned = true;
    return await handler(materialized);
  } finally {
    if (!cleaned) {
      await cleanupRequestUploadedFiles(
        request,
        [materialized ?? file],
        removePath,
      );
    }
  }
}

function parseUploadedDocx(
  file: Express.Multer.File,
  expectedVersionId: string,
): WorkspaceDocumentStudioImportInput {
  const filename = file.originalname?.trim();
  if (
    !filename ||
    filename.length > 240 ||
    filename === "." ||
    filename === ".." ||
    /[\u0000-\u001f\u007f-\u009f\\/]/u.test(filename) ||
    !filename.toLowerCase().endsWith(".docx")
  ) {
    throw new WorkspaceApiError(
      422,
      "VALIDATION_ERROR",
      "The uploaded file must have a safe .docx filename.",
    );
  }
  const mimeType = String(file.mimetype ?? "")
    .trim()
    .toLowerCase();
  if (
    mimeType !== "" &&
    mimeType !== "application/octet-stream" &&
    mimeType !== DOCUMENT_STUDIO_DOCX_MIME_TYPE
  ) {
    throw new WorkspaceApiError(
      422,
      "VALIDATION_ERROR",
      "The uploaded file has an unsupported DOCX MIME type.",
    );
  }
  if (!Buffer.isBuffer(file.buffer) || file.buffer.length < 1) {
    throw new WorkspaceApiError(
      422,
      "VALIDATION_ERROR",
      "A non-empty DOCX file is required.",
    );
  }
  if (file.buffer.length > DOCUMENT_STUDIO_MAX_DOCX_BYTES) {
    throw new WorkspaceApiError(
      413,
      "VALIDATION_ERROR",
      "The DOCX file exceeds the 10 MB limit.",
    );
  }
  return {
    expectedVersionId,
    filename,
    mimeType,
    buffer: file.buffer,
  };
}

function safeJson<T>(
  response: Response,
  schema: z.ZodType<T>,
  payload: unknown,
  status = 200,
) {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new WorkspaceApiError(
      500,
      "INTERNAL_ERROR",
      "Studio response could not be serialized safely.",
    );
  }
  response.status(status).json(parsed.data);
}

function requireDraftOriginMethod<T>(method: T | undefined): T {
  if (method === undefined) {
    throw new WorkspaceApiError(
      503,
      "PRECONDITION_FAILED",
      "Studio draft handoff is unavailable.",
    );
  }
  return method;
}

function requireSuggestionMethod<T>(method: T | undefined): T {
  if (method === undefined) {
    throw new WorkspaceApiError(
      503,
      "PRECONDITION_FAILED",
      "Document Studio suggestions are unavailable.",
    );
  }
  return method;
}

function sendCreatedDraft(response: Response, payload: unknown) {
  const parsed = StudioDocumentResponse.safeParse(payload);
  if (!parsed.success) {
    throw new WorkspaceApiError(
      500,
      "INTERNAL_ERROR",
      "Studio draft handoff response could not be serialized safely.",
    );
  }
  response.set(
    "Location",
    `/api/v1/projects/${parsed.data.project_id}/studio/documents/${parsed.data.document_id}`,
  );
  safeJson(response, StudioDocumentResponse, parsed.data, 201);
}

function safeDocxExport(payload: unknown) {
  const parsed = StudioDocxExportResponse.safeParse(payload);
  if (!parsed.success) {
    throw new WorkspaceApiError(
      500,
      "INTERNAL_ERROR",
      "Studio DOCX response could not be serialized safely.",
    );
  }
  return parsed.data;
}

function setDocxDownloadHeaders(
  response: Response,
  warningCodes: readonly WorkspaceDocumentStudioDocxWarningCode[],
) {
  response.set({
    "X-Vera-Warning-Codes": warningCodes.join(","),
    "Access-Control-Expose-Headers":
      "Content-Disposition, Content-Length, X-Vera-Warning-Codes",
  });
}

const MultipartErrorCodes = new Set([
  "LIMIT_PART_COUNT",
  "LIMIT_FILE_SIZE",
  "LIMIT_FILE_COUNT",
  "LIMIT_FIELD_KEY",
  "LIMIT_FIELD_VALUE",
  "LIMIT_FIELD_COUNT",
  "LIMIT_UNEXPECTED_FILE",
  "MISSING_FIELD_NAME",
]);

const DocxErrorMessages: Record<DocumentStudioDocxError["code"], string> = {
  MARKDOWN_INVALID: "The Studio document cannot be exported to DOCX.",
  MARKDOWN_TOO_LARGE: "The Studio document exceeds the DOCX export limit.",
  MARKDOWN_TOO_COMPLEX: "The Studio document is too complex to export safely.",
  DOCX_INVALID: "The uploaded DOCX file is invalid.",
  DOCX_TOO_LARGE: "The DOCX file exceeds the 10 MB limit.",
  DOCX_UNSAFE_PATH: "The uploaded DOCX contains an unsafe package path.",
  DOCX_ACTIVE_CONTENT: "The uploaded DOCX contains unsupported active content.",
  DOCX_EXTERNAL_RELATIONSHIP:
    "The uploaded DOCX contains an external relationship.",
  DOCX_TRACKED_CHANGES:
    "DOCX files with tracked changes must be resolved before import.",
  DOCX_CONVERSION_FAILED: "The DOCX file could not be converted safely.",
};

function errorPayload(error: unknown) {
  if (error instanceof ZodError) {
    const details = error.issues.map((issue) => ({
      path: issue.path.join(".") || "request",
      message: issue.message,
    }));
    return {
      status: 422,
      body: {
        detail: "Invalid request.",
        code: "VALIDATION_ERROR",
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid request.",
          retryable: false,
          details,
        },
      },
    };
  }
  if (error instanceof DocumentStudioDocxError) {
    const status =
      error.code === "DOCX_TOO_LARGE" || error.code === "MARKDOWN_TOO_LARGE"
        ? 413
        : 422;
    const message = DocxErrorMessages[error.code];
    return {
      status,
      body: {
        detail: message,
        code: "VALIDATION_ERROR",
        error: {
          code: "VALIDATION_ERROR",
          message,
          retryable: false,
        },
      },
    };
  }
  const uploadErrorCode =
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    MultipartErrorCodes.has(error.code)
      ? error.code
      : null;
  if (uploadErrorCode) {
    const status = uploadErrorCode === "LIMIT_FILE_SIZE" ? 413 : 422;
    const code = "VALIDATION_ERROR";
    const message =
      status === 413
        ? "The DOCX file exceeds the 10 MB limit."
        : "Invalid DOCX multipart upload.";
    return {
      status,
      body: {
        detail: message,
        code,
        error: { code, message, retryable: false },
      },
    };
  }
  if (error instanceof WorkspaceApiError) {
    return {
      status: error.status,
      body: {
        detail: error.message,
        code: error.code,
        error: { ...error.toResponse().error, retryable: false },
      },
    };
  }
  return {
    status: 500,
    body: {
      detail: "Internal server error.",
      code: "INTERNAL_ERROR",
      error: {
        code: "INTERNAL_ERROR",
        message: "Internal server error.",
        retryable: false,
      },
    },
  };
}

export function createWorkspaceDocumentStudioV1Router(
  port: WorkspaceDocumentStudioV1Port,
  options: WorkspaceDocumentStudioV1RouterOptions = {},
): Router {
  const router = Router();
  router.use((_request, response, next) => {
    response.set({
      "Cache-Control": "private, no-store",
      Pragma: "no-cache",
      Expires: "0",
    });
    next();
  });
  const authenticateDocxUpload: RequestHandler = (request, _response, next) => {
    try {
      contextFor(request, options);
      idParam(request, "projectId");
      idParam(request, "documentId");
      next();
    } catch (error) {
      next(error);
    }
  };
  const uploadDocx = singleFileUpload("file", {
    maxFileSizeBytes: DOCUMENT_STUDIO_MAX_DOCX_BYTES,
    maxFields: 1,
    maxFieldSizeBytes: 256,
    // Busboy emits LIMIT_PART_COUNT when the count reaches the configured
    // value, so retain one parser slot of headroom for the exact field+file
    // contract. The one-field/one-file limits still reject a third part.
    maxParts: 3,
    maxHeaderPairs: 32,
    onError: (error, _request, _response, next) => next(error),
    removePath: options.uploadPathRemover,
  });

  router.post(
    "/projects/:projectId/studio/documents",
    asyncRoute(async (request, response) => {
      const input = CreateDraft.parse(request.body);
      safeJson(
        response,
        StudioDocumentResponse,
        await port.createStudioDocument(
          contextFor(request, options),
          idParam(request, "projectId"),
          {
            title: input.title,
            folderId: input.folder_id ?? null,
            documentType: input.document_type ?? "general_legal_document",
          },
        ),
        201,
      );
    }),
  );

  router.get(
    "/projects/:projectId/studio/templates",
    asyncRoute(async (request, response) => {
      const projectId = idParam(request, "projectId");
      const method = port.listStudioTemplates;
      if (!method)
        throw new WorkspaceApiError(
          503,
          "PRECONDITION_FAILED",
          "Document templates are unavailable.",
        );
      const items = (await method.call(
        port,
        contextFor(request, options),
        projectId,
      )) as TemplateDomain[];
      safeJson(response, TemplateListResponse, {
        items: items.map(templateSummaryWire),
      });
    }),
  );

  router.get(
    "/projects/:projectId/studio/templates/:templateId",
    asyncRoute(async (request, response) => {
      const method = port.getStudioTemplate;
      if (!method)
        throw new WorkspaceApiError(
          503,
          "PRECONDITION_FAILED",
          "Document templates are unavailable.",
        );
      const template = (await method.call(
        port,
        contextFor(request, options),
        idParam(request, "projectId"),
        idParam(request, "templateId"),
      )) as TemplateDomain;
      safeJson(response, TemplateDetailResponse, {
        template: templateWire(template),
      });
    }),
  );

  router.patch(
    "/projects/:projectId/studio/templates/:templateId",
    asyncRoute(async (request, response) => {
      const input = UpdateTemplate.parse(request.body ?? {});
      const method = port.updateStudioTemplate;
      if (!method)
        throw new WorkspaceApiError(
          503,
          "PRECONDITION_FAILED",
          "Document templates are unavailable.",
        );
      const template = (await method.call(
        port,
        contextFor(request, options),
        idParam(request, "projectId"),
        idParam(request, "templateId"),
        {
          title: input.title,
          description: input.description,
          content: input.content,
          plan: input.plan ? draftPlanDomain(input.plan) : undefined,
        },
      )) as TemplateDomain;
      safeJson(response, TemplateDetailResponse, {
        template: templateWire(template),
      });
    }),
  );

  router.post(
    "/projects/:projectId/studio/templates/:templateId/copies",
    asyncRoute(async (request, response) => {
      const input = CopyTemplate.parse(request.body ?? {});
      const method = port.copyStudioTemplate;
      if (!method)
        throw new WorkspaceApiError(
          503,
          "PRECONDITION_FAILED",
          "Document templates are unavailable.",
        );
      const template = (await method.call(
        port,
        contextFor(request, options),
        idParam(request, "projectId"),
        idParam(request, "templateId"),
        input.title,
      )) as TemplateDomain;
      safeJson(
        response,
        TemplateDetailResponse,
        { template: templateWire(template) },
        201,
      );
    }),
  );

  router.post(
    "/projects/:projectId/studio/templates/:templateId/drafts",
    asyncRoute(async (request, response) => {
      const input = CreateDraftFromTemplate.parse(request.body ?? {});
      const method = port.createStudioDocumentFromTemplate;
      if (!method)
        throw new WorkspaceApiError(
          503,
          "PRECONDITION_FAILED",
          "Document templates are unavailable.",
        );
      const result = (await method.call(
        port,
        contextFor(request, options),
        idParam(request, "projectId"),
        idParam(request, "templateId"),
        { title: input.title, folderId: input.folder_id ?? null },
      )) as {
        document: unknown;
        plan: NonNullable<TemplateDomain["plan"]>;
      };
      safeJson(
        response,
        TemplateDraftResponse,
        {
          document: result.document,
          plan: draftPlanWire(result.plan),
        },
        201,
      );
    }),
  );

  router.get(
    "/projects/:projectId/studio/drafts",
    asyncRoute(async (request, response) => {
      const query = DraftListQuery.parse(request.query);
      const projectId = idParam(request, "projectId");
      const cursor = decodeDraftListCursor(query.cursor, projectId);
      const method = port.listStudioDrafts;
      if (!method) {
        throw new WorkspaceApiError(
          503,
          "PRECONDITION_FAILED",
          "Draft summary listing is unavailable.",
        );
      }
      const result = (await method.call(
        port,
        contextFor(request, options),
        projectId,
        {
          limit: query.limit,
          cursor: cursor
            ? {
                updatedAt: cursor.updated_at,
                documentId: cursor.draft_id,
              }
            : null,
        },
      )) as {
        drafts: readonly {
          documentId: string;
          projectId: string;
          title: string;
          documentType: z.infer<typeof DocumentStudioDraftTypeV20Schema>;
          currentVersionId: string;
          currentVersionNumber: number;
          updatedAt: string;
          sourceCount: number;
          pendingSuggestionCount: number;
          originType:
            | "manual"
            | "assistant"
            | "workflow"
            | "tabular"
            | "unknown";
        }[];
        hasMore: boolean;
        nextCursor: { updatedAt: string; documentId: string } | null;
      };
      safeJson(response, StudioDraftSummaryListResponse, {
        items: result.drafts.map((draft) => ({
          draft_id: draft.documentId,
          project_id: draft.projectId,
          title: draft.title,
          document_type: draft.documentType,
          current_version_id: draft.currentVersionId,
          current_version_number: draft.currentVersionNumber,
          updated_at: draft.updatedAt,
          source_count: draft.sourceCount,
          pending_suggestion_count: draft.pendingSuggestionCount,
          origin_type: draft.originType,
        })),
        has_more: result.hasMore,
        next_cursor: encodeDraftListCursor(result.nextCursor, projectId),
      });
    }),
  );

  router.post(
    "/projects/:projectId/studio/drafts/from-assistant",
    asyncRoute(async (request, response) => {
      const input = CreateDraftFromAssistant.parse(request.body ?? {});
      const method = requireDraftOriginMethod(
        port.createStudioDocumentFromAssistantMessage,
      );
      sendCreatedDraft(
        response,
        await method.call(
          port,
          contextFor(request, options),
          idParam(request, "projectId"),
          input.chat_id,
          input.assistant_message_id,
        ),
      );
    }),
  );

  router.post(
    "/projects/:projectId/studio/drafts/from-workflow",
    asyncRoute(async (request, response) => {
      const input = CreateDraftFromWorkflow.parse(request.body ?? {});
      const method = requireDraftOriginMethod(
        port.createStudioDocumentFromWorkflowRun,
      );
      sendCreatedDraft(
        response,
        await method.call(
          port,
          contextFor(request, options),
          idParam(request, "projectId"),
          input.workflow_run_id,
        ),
      );
    }),
  );

  router.post(
    "/projects/:projectId/studio/drafts/from-tabular",
    asyncRoute(async (request, response) => {
      const input = CreateDraftFromTabular.parse(request.body ?? {});
      const method = requireDraftOriginMethod(
        port.createStudioDocumentFromTabularReview,
      );
      sendCreatedDraft(
        response,
        await method.call(
          port,
          contextFor(request, options),
          idParam(request, "projectId"),
          input.review_id,
        ),
      );
    }),
  );

  router.get(
    "/projects/:projectId/studio/documents/:documentId",
    asyncRoute(async (request, response) => {
      const query = ReadDocumentQuery.parse(request.query);
      safeJson(
        response,
        StudioDocumentResponse,
        await port.getStudioDocument(
          contextFor(request, options),
          idParam(request, "projectId"),
          idParam(request, "documentId"),
          query.version_id,
        ),
      );
    }),
  );

  router.get(
    "/projects/:projectId/studio/documents/:documentId/suggestions/:suggestionId",
    asyncRoute(async (request, response) => {
      const method = requireSuggestionMethod(port.getStudioSuggestion);
      safeJson(
        response,
        StudioSuggestionDecisionResponse,
        await method.call(
          port,
          contextFor(request, options),
          idParam(request, "projectId"),
          idParam(request, "documentId"),
          idParam(request, "suggestionId"),
        ),
      );
    }),
  );

  router.put(
    "/projects/:projectId/studio/documents/:documentId",
    asyncRoute(async (request, response) => {
      const input = SaveDocument.parse(request.body);
      safeJson(
        response,
        StudioDocumentResponse,
        await port.saveStudioDocument(
          contextFor(request, options),
          idParam(request, "projectId"),
          idParam(request, "documentId"),
          {
            expectedVersionId: input.expected_version_id,
            content: input.content,
            source: input.source,
            citationAnchorIds: input.citation_anchor_ids ?? [],
            summary: input.summary ?? null,
          },
        ),
        201,
      );
    }),
  );

  router.post(
    "/projects/:projectId/studio/documents/:documentId/import-docx",
    authenticateDocxUpload,
    uploadDocx,
    asyncRoute(async (request, response) => {
      const result = await withUploadedDocx(
        request,
        (file) => {
          const fields = ImportDocxFields.parse(multipartFields(request.body));
          return port.importStudioDocumentDocx(
            contextFor(request, options),
            idParam(request, "projectId"),
            idParam(request, "documentId"),
            parseUploadedDocx(file, fields.expected_version_id),
          );
        },
        options.uploadPathRemover,
      );
      safeJson(
        response,
        StudioDocxImportResponse,
        { document: result.document, warnings: result.warningCodes },
        201,
      );
    }),
  );

  router.get(
    "/projects/:projectId/studio/documents/:documentId/export-docx",
    asyncRoute(async (request, response) => {
      const query = ReadDocumentQuery.parse(request.query);
      const result = safeDocxExport(
        await port.exportStudioDocumentDocx(
          contextFor(request, options),
          idParam(request, "projectId"),
          idParam(request, "documentId"),
          query.version_id,
        ),
      );
      setDocxDownloadHeaders(response, result.warningCodes);
      sendWorkspaceV1Download(request, response, {
        filename: result.filename,
        contentType: result.contentType,
        body: result.bytes,
        contentLength: result.bytes.byteLength,
        disposition: "attachment",
      });
    }),
  );

  router.get(
    "/projects/:projectId/studio/documents/:documentId/versions",
    asyncRoute(async (request, response) => {
      safeJson(
        response,
        StudioVersionListResponse,
        await port.listStudioDocumentVersions(
          contextFor(request, options),
          idParam(request, "projectId"),
          idParam(request, "documentId"),
        ),
      );
    }),
  );

  router.get(
    "/projects/:projectId/studio/documents/:documentId/suggestions",
    asyncRoute(async (request, response) => {
      const method = requireSuggestionMethod(port.listStudioSuggestions);
      safeJson(
        response,
        StudioSuggestionListResponse,
        await method.call(
          port,
          contextFor(request, options),
          idParam(request, "projectId"),
          idParam(request, "documentId"),
        ),
      );
    }),
  );

  router.post(
    "/projects/:projectId/studio/documents/:documentId/suggestions/:suggestionId/accept",
    asyncRoute(async (request, response) => {
      EmptySuggestionDecision.parse(request.body ?? {});
      const method = requireSuggestionMethod(port.acceptStudioSuggestion);
      safeJson(
        response,
        StudioSuggestionAcceptanceResponse,
        await method.call(
          port,
          contextFor(request, options),
          idParam(request, "projectId"),
          idParam(request, "documentId"),
          idParam(request, "suggestionId"),
        ),
        201,
      );
    }),
  );

  router.post(
    "/projects/:projectId/studio/documents/:documentId/suggestions/:suggestionId/reject",
    asyncRoute(async (request, response) => {
      EmptySuggestionDecision.parse(request.body ?? {});
      const method = requireSuggestionMethod(port.rejectStudioSuggestion);
      safeJson(
        response,
        StudioSuggestionDecisionResponse,
        await method.call(
          port,
          contextFor(request, options),
          idParam(request, "projectId"),
          idParam(request, "documentId"),
          idParam(request, "suggestionId"),
        ),
      );
    }),
  );

  router.post(
    "/projects/:projectId/studio/documents/:documentId/versions/:versionId/restore",
    asyncRoute(async (request, response) => {
      const input = RestoreVersion.parse(request.body);
      safeJson(
        response,
        StudioDocumentResponse,
        await port.restoreStudioDocumentVersion(
          contextFor(request, options),
          idParam(request, "projectId"),
          idParam(request, "documentId"),
          idParam(request, "versionId"),
          {
            expectedCurrentVersionId: input.expected_current_version_id,
          },
        ),
        201,
      );
    }),
  );

  router.use(
    (
      error: unknown,
      _request: Request,
      response: Response,
      next: NextFunction,
    ) => {
      if (response.headersSent) return next(error);
      const mapped = errorPayload(error);
      response.status(mapped.status).json(mapped.body);
    },
  );
  return router;
}
