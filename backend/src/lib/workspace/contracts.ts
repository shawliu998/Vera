import { z } from "zod";

import { API_ERROR_CODES } from "./errors";
import { MAX_PAGE_SIZE } from "./pagination";
import {
  BLOCKED_STRUCTURED_KEYS_V1,
  IsoDateTimeSchema,
  NullableWorkspaceIdSchema,
  StructuredErrorSchema,
  UnicodeCodePointStringSchemaV1,
  WorkspaceIdSchema,
} from "./workspacePersistencePrimitivesV1";

export {
  IsoDateTimeSchema,
  NullableWorkspaceIdSchema,
  StructuredErrorSchema,
  WorkspaceIdSchema,
} from "./workspacePersistencePrimitivesV1";

/** Public `/api/v1` contract. Every request object is strict by design. */

export const NonEmptyTextSchema = z.string().trim().min(1);
export const OptionalDescriptionSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_000)
  .nullable();
export const CursorSchema = z.string().min(1).max(512);

export const ProjectStatusSchema = z.enum(["active", "archived", "deleted"]);
export const DocumentStatusSchema = z.enum([
  "pending",
  "processing",
  "ready",
  "failed",
  "unsupported",
  "ocr_required",
]);
export const DocumentVersionSourceSchema = z.enum([
  "upload",
  "user_upload",
  "assistant_edit",
  "user_accept",
  "user_reject",
  "generated",
]);
export const DocumentEditStatusSchema = z.enum([
  "pending",
  "accepted",
  "rejected",
]);
export const ChatScopeSchema = z.enum(["global", "project"]);
export const ChatStatusSchema = z.enum(["active", "archived"]);
export const MessageRoleSchema = z.enum([
  "system",
  "user",
  "assistant",
  "tool",
]);
export const MessageStatusSchema = z.enum([
  "pending",
  "streaming",
  "complete",
  "failed",
  "cancelled",
  "interrupted",
]);
export const ModelProviderSchema = z.enum([
  "openai",
  "deepseek",
  "anthropic",
  "gemini",
  "openai_compatible",
]);
export const CredentialStatusSchema = z.enum([
  "not_configured",
  "configured",
  "unavailable",
]);
export const WorkflowTypeSchema = z.enum(["assistant", "tabular"]);
export const WorkflowStatusSchema = z.enum(["active", "archived"]);
export const RunStatusSchema = z.enum([
  "queued",
  "waiting",
  "running",
  "complete",
  "failed",
  "cancelled",
  "interrupted",
]);
export const StepRunStatusSchema = z.enum([
  "queued",
  "waiting",
  "running",
  "complete",
  "failed",
  "cancelled",
  "interrupted",
  "skipped",
]);
export const TabularOutputTypeSchema = z.enum([
  "text",
  "boolean",
  "enum",
  "number",
]);
export const TabularReviewStatusSchema = z.enum([
  "draft",
  "ready",
  "running",
  "complete",
  "failed",
  "cancelled",
  "archived",
]);
export const TabularCellStatusSchema = z.enum([
  "empty",
  "queued",
  "running",
  "complete",
  "failed",
  "cancelled",
]);
const TabularReviewRequestTitleSchema = UnicodeCodePointStringSchemaV1({
  min: 1,
  max: 240,
  trimForMin: true,
}).transform((value) => value.trim());
const TabularReviewRequestColumnTitleSchema = UnicodeCodePointStringSchemaV1({
  min: 1,
  max: 160,
  trimForMin: true,
}).transform((value) => value.trim());
const TabularReviewRequestColumnPromptSchema = UnicodeCodePointStringSchemaV1({
  min: 1,
  max: 20_000,
  trimForMin: true,
}).transform((value) => value.trim());
const TabularReviewRequestEnumValueSchema = UnicodeCodePointStringSchemaV1({
  min: 1,
  max: 160,
  trimForMin: true,
}).transform((value) => value.trim());
export const JobTypeSchema = z.enum([
  "document_parse",
  "assistant_generate",
  "workflow_run",
  "tabular_cell",
]);
export const JobStatusSchema = z.enum([
  "queued",
  "running",
  "complete",
  "failed",
  "cancelled",
  "interrupted",
]);
export const LegacyImportStatusSchema = z.enum([
  "pending",
  "running",
  "complete",
  "failed",
  "skipped",
]);

export const PageRequestSchema = z
  .object({
    cursor: CursorSchema.nullable().optional(),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
  })
  .strict();

export function PageResponseSchema<T extends z.ZodTypeAny>(item: T) {
  return z
    .object({
      items: z.array(item),
      nextCursor: CursorSchema.nullable(),
    })
    .strict();
}

export const ProjectSchema = z
  .object({
    id: WorkspaceIdSchema,
    name: z.string().min(1).max(240),
    description: OptionalDescriptionSchema,
    cmNumber: z.string().trim().min(1).max(160).nullable(),
    practice: z.string().trim().min(1).max(160).nullable(),
    status: ProjectStatusSchema,
    defaultModelProfileId: NullableWorkspaceIdSchema,
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
    archivedAt: IsoDateTimeSchema.nullable(),
  })
  .strict();

export const ProjectFolderSchema = z
  .object({
    id: WorkspaceIdSchema,
    projectId: WorkspaceIdSchema,
    parentFolderId: NullableWorkspaceIdSchema,
    name: z.string().min(1).max(160),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict();

export const DocumentSchema = z
  .object({
    id: WorkspaceIdSchema,
    projectId: NullableWorkspaceIdSchema,
    folderId: NullableWorkspaceIdSchema,
    title: z.string().min(1).max(240),
    filename: z.string().min(1).max(255),
    mimeType: z.string().min(1).max(160),
    sizeBytes: z.number().int().nonnegative(),
    status: DocumentStatusSchema,
    currentVersionId: NullableWorkspaceIdSchema,
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict();

export const DocumentVersionSchema = z
  .object({
    id: WorkspaceIdSchema,
    documentId: WorkspaceIdSchema,
    versionNumber: z.number().int().positive(),
    source: DocumentVersionSourceSchema,
    filename: z.string().min(1).max(255),
    mimeType: z.string().min(1).max(160),
    sizeBytes: z.number().int().nonnegative(),
    contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
    pageCount: z.number().int().nonnegative().nullable(),
    createdAt: IsoDateTimeSchema,
  })
  .strict();

export const DocumentEditSchema = z
  .object({
    id: WorkspaceIdSchema,
    documentId: WorkspaceIdSchema,
    versionId: WorkspaceIdSchema,
    messageId: NullableWorkspaceIdSchema,
    status: DocumentEditStatusSchema,
    summary: z.string().max(2_000).nullable(),
    createdAt: IsoDateTimeSchema,
    resolvedAt: IsoDateTimeSchema.nullable(),
  })
  .strict();

export const DocumentChunkSchema = z
  .object({
    id: WorkspaceIdSchema,
    documentId: WorkspaceIdSchema,
    versionId: WorkspaceIdSchema,
    ordinal: z.number().int().nonnegative(),
    text: z.string().min(1).max(100_000),
    startOffset: z.number().int().nonnegative(),
    endOffset: z.number().int().nonnegative(),
    pageStart: z.number().int().positive().nullable(),
    pageEnd: z.number().int().positive().nullable(),
    createdAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.endOffset < value.startOffset) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endOffset"],
        message: "endOffset must not precede startOffset",
      });
    }
    if (
      value.pageStart !== null &&
      value.pageEnd !== null &&
      value.pageEnd < value.pageStart
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["pageEnd"],
        message: "pageEnd must not precede pageStart",
      });
    }
  });

export const ChatSchema = z
  .object({
    id: WorkspaceIdSchema,
    projectId: NullableWorkspaceIdSchema,
    scope: ChatScopeSchema,
    title: z.string().min(1).max(240),
    status: ChatStatusSchema,
    modelProfileId: NullableWorkspaceIdSchema,
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict()
  .refine((value) => (value.scope === "project") === Boolean(value.projectId), {
    message:
      "project chats require a projectId and global chats must not include one",
    path: ["projectId"],
  });

export const ChatMessageSchema = z
  .object({
    id: WorkspaceIdSchema,
    chatId: WorkspaceIdSchema,
    role: MessageRoleSchema,
    content: z.string().max(200_000),
    status: MessageStatusSchema,
    modelProfileId: NullableWorkspaceIdSchema,
    jobId: NullableWorkspaceIdSchema,
    createdAt: IsoDateTimeSchema,
    completedAt: IsoDateTimeSchema.nullable(),
  })
  .strict();

export const MessageSourceSchema = z
  .object({
    id: WorkspaceIdSchema,
    messageId: WorkspaceIdSchema,
    documentId: WorkspaceIdSchema,
    versionId: WorkspaceIdSchema,
    chunkId: NullableWorkspaceIdSchema,
    quote: z.string().min(1).max(8_000).nullable(),
    startOffset: z.number().int().nonnegative().nullable(),
    endOffset: z.number().int().nonnegative().nullable(),
    createdAt: IsoDateTimeSchema,
  })
  .strict();

const BaseUrlSchema = z
  .string()
  .url()
  .max(500)
  .refine((value) => {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return false;
    if (url.protocol === "https:") return true;
    if (url.protocol !== "http:") return false;
    return (
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]" ||
      url.hostname === "::1"
    );
  }, "baseUrl must be HTTPS or loopback HTTP without credentials");

export const ModelProfileSchema = z
  .object({
    id: WorkspaceIdSchema,
    name: z.string().min(1).max(120),
    provider: ModelProviderSchema,
    model: z.string().min(1).max(200),
    baseUrl: BaseUrlSchema.nullable(),
    credentialStatus: CredentialStatusSchema,
    contextWindowTokens: z.number().int().positive().max(10_000_000).nullable(),
    maxOutputTokens: z.number().int().positive().max(10_000_000).nullable(),
    enabled: z.boolean(),
    capabilities: z
      .object({
        streaming: z.boolean(),
        toolCalling: z.boolean(),
        structuredOutput: z.boolean(),
        vision: z.boolean(),
      })
      .strict(),
    isDefault: z.boolean(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict();

export const PromptWorkflowStepSchema = z
  .object({
    kind: z.literal("prompt"),
    title: z.string().min(1).max(160),
    prompt: z.string().min(1).max(20_000),
  })
  .strict();

export const DocumentContextWorkflowStepSchema = z
  .object({
    kind: z.literal("document_context"),
    title: z.string().min(1).max(160),
    maxDocuments: z.number().int().min(1).max(100),
    maxChunksPerDocument: z.number().int().min(1).max(100),
  })
  .strict();

const TabularColumnWorkflowStepObjectSchema = z
  .object({
    kind: z.literal("tabular_column"),
    title: z.string().min(1).max(160),
    outputType: TabularOutputTypeSchema,
    prompt: z.string().min(1).max(20_000),
    enumValues: z.array(z.string().min(1).max(160)).min(1).max(100).optional(),
  })
  .strict();

export const WorkflowStepSchema = z
  .discriminatedUnion("kind", [
    PromptWorkflowStepSchema,
    DocumentContextWorkflowStepSchema,
    TabularColumnWorkflowStepObjectSchema,
  ])
  .superRefine((value, context) => {
    if (value.kind !== "tabular_column") return;
    if (value.outputType === "enum" && !value.enumValues?.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["enumValues"],
        message: "enum columns require enumValues",
      });
    }
    if (value.outputType !== "enum" && value.enumValues) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["enumValues"],
        message: "enumValues are only valid for enum columns",
      });
    }
  });
export const TabularColumnWorkflowStepSchema = WorkflowStepSchema.refine(
  (value) => value.kind === "tabular_column",
  "workflow step must be a tabular column",
);

export const WorkflowColumnSchema = z
  .object({
    id: WorkspaceIdSchema,
    workflowId: NullableWorkspaceIdSchema,
    key: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    title: z.string().min(1).max(160),
    outputType: TabularOutputTypeSchema,
    prompt: z.string().min(1).max(20_000),
    enumValues: z.array(z.string().min(1).max(160)).min(1).max(100).nullable(),
    ordinal: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.outputType === "enum" && !value.enumValues?.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["enumValues"],
        message: "enum columns require enumValues",
      });
    }
    if (value.outputType !== "enum" && value.enumValues) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["enumValues"],
        message: "enumValues are only valid for enum columns",
      });
    }
  });

type SafeStructuredValue =
  | string
  | number
  | boolean
  | null
  | SafeStructuredValue[]
  | { [key: string]: SafeStructuredValue };
const blockedStructuredKeys = BLOCKED_STRUCTURED_KEYS_V1;
const rejectBlockedStructuredKeys = (
  value: Record<string, unknown>,
  context: z.RefinementCtx,
) => {
  for (const key of Object.keys(value)) {
    if (blockedStructuredKeys.test(key)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: "unsafe structured key is not allowed",
      });
    }
  }
};
export const SafeStructuredValueSchema: z.ZodType<SafeStructuredValue> = z.lazy(
  () =>
    z.union([
      z.string().max(200_000),
      z.number().finite(),
      z.boolean(),
      z.null(),
      z.array(SafeStructuredValueSchema).max(10_000),
      z
        .record(SafeStructuredValueSchema)
        .superRefine(rejectBlockedStructuredKeys),
    ]),
);
export const WorkflowMetadataSchema = z
  .record(SafeStructuredValueSchema)
  .superRefine(rejectBlockedStructuredKeys);
export const WorkflowJurisdictionsSchema = z
  .array(z.string().trim().min(1).max(160))
  .max(100);

const WorkflowBaseSchema = z
  .object({
    id: WorkspaceIdSchema,
    projectId: NullableWorkspaceIdSchema,
    title: z.string().min(1).max(200),
    description: OptionalDescriptionSchema,
    status: WorkflowStatusSchema,
    steps: z.array(WorkflowStepSchema).max(100),
    language: z.string().min(1).max(160),
    practice: z.string().min(1).max(160),
    jurisdictions: WorkflowJurisdictionsSchema,
    metadata: WorkflowMetadataSchema,
    isBuiltin: z.boolean(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict();

export const AssistantWorkflowSchema = WorkflowBaseSchema.extend({
  type: z.literal("assistant"),
  skillMarkdown: z.string().max(100_000),
});

export const TabularWorkflowSchema = WorkflowBaseSchema.extend({
  type: z.literal("tabular"),
  columns: z.array(WorkflowColumnSchema).max(100),
});

export const WorkflowSchema = z.discriminatedUnion("type", [
  AssistantWorkflowSchema,
  TabularWorkflowSchema,
]);

export const WorkflowRunSchema = z
  .object({
    id: WorkspaceIdSchema,
    workflowId: WorkspaceIdSchema,
    projectId: NullableWorkspaceIdSchema,
    status: RunStatusSchema,
    modelProfileId: NullableWorkspaceIdSchema,
    jobId: NullableWorkspaceIdSchema,
    input: SafeStructuredValueSchema,
    output: SafeStructuredValueSchema.nullable(),
    startedAt: IsoDateTimeSchema.nullable(),
    completedAt: IsoDateTimeSchema.nullable(),
    error: StructuredErrorSchema.nullable(),
    createdAt: IsoDateTimeSchema,
  })
  .strict();

export const WorkflowStepRunSchema = z
  .object({
    id: WorkspaceIdSchema,
    workflowRunId: WorkspaceIdSchema,
    ordinal: z.number().int().nonnegative(),
    step: WorkflowStepSchema,
    status: StepRunStatusSchema,
    input: SafeStructuredValueSchema,
    output: SafeStructuredValueSchema.nullable(),
    error: StructuredErrorSchema.nullable(),
    startedAt: IsoDateTimeSchema.nullable(),
    completedAt: IsoDateTimeSchema.nullable(),
  })
  .strict();

export const TabularReviewSchema = z
  .object({
    id: WorkspaceIdSchema,
    projectId: NullableWorkspaceIdSchema,
    workflowId: NullableWorkspaceIdSchema,
    title: z.string().min(1).max(240),
    status: TabularReviewStatusSchema,
    documentIds: z.array(WorkspaceIdSchema).max(1_000),
    modelProfileId: NullableWorkspaceIdSchema,
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict();

export const TabularColumnSchema = z
  .object({
    id: WorkspaceIdSchema,
    reviewId: WorkspaceIdSchema,
    key: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    title: z.string().min(1).max(160),
    outputType: TabularOutputTypeSchema,
    prompt: z.string().min(1).max(20_000),
    enumValues: z.array(z.string().min(1).max(160)).min(1).max(100).nullable(),
    ordinal: z.number().int().nonnegative(),
  })
  .strict();

export const TabularCellValueSchema = z.union([
  z.string().max(20_000),
  z.boolean(),
  z.number().finite(),
  z.null(),
]);
export const TabularCellSchema = z
  .object({
    id: WorkspaceIdSchema,
    reviewId: WorkspaceIdSchema,
    documentId: WorkspaceIdSchema,
    columnId: WorkspaceIdSchema,
    outputType: TabularOutputTypeSchema,
    value: TabularCellValueSchema,
    status: TabularCellStatusSchema,
    error: StructuredErrorSchema.nullable(),
    jobId: NullableWorkspaceIdSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.value === null) return;
    const valid =
      (value.outputType === "text" && typeof value.value === "string") ||
      (value.outputType === "boolean" && typeof value.value === "boolean") ||
      (value.outputType === "number" && typeof value.value === "number") ||
      (value.outputType === "enum" && typeof value.value === "string");
    if (!valid)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["value"],
        message: "value does not match outputType",
      });
  });

export const TabularReviewChatSchema = z
  .object({
    id: WorkspaceIdSchema,
    reviewId: WorkspaceIdSchema,
    title: z.string().min(1).max(240),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict();

export const TabularReviewChatMessageSchema = z
  .object({
    id: WorkspaceIdSchema,
    reviewChatId: WorkspaceIdSchema,
    role: z.enum(["user", "assistant", "tool"]),
    content: z.string().max(200_000),
    status: MessageStatusSchema,
    createdAt: IsoDateTimeSchema,
    completedAt: IsoDateTimeSchema.nullable(),
  })
  .strict();

export const JobSchema = z
  .object({
    id: WorkspaceIdSchema,
    type: JobTypeSchema,
    status: JobStatusSchema,
    resourceType: z.enum([
      "document",
      "chat",
      "workflow_run",
      "tabular_cell",
      "tabular_review",
      "project",
    ]),
    resourceId: WorkspaceIdSchema,
    // A persisted queued job has not been claimed yet, so attempt=0 is valid.
    attempt: z.number().int().nonnegative(),
    maxAttempts: z.number().int().positive().max(100),
    error: StructuredErrorSchema.nullable(),
    retryable: z.boolean(),
    createdAt: IsoDateTimeSchema,
    startedAt: IsoDateTimeSchema.nullable(),
    completedAt: IsoDateTimeSchema.nullable(),
  })
  .strict();

export const WorkspaceSettingsSchema = z
  .object({
    id: z.literal("workspace"),
    locale: z.enum(["zh-CN", "en-US"]),
    theme: z.enum(["system", "light", "dark"]),
    defaultModelProfileId: NullableWorkspaceIdSchema,
    defaultProjectId: NullableWorkspaceIdSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict();

export const LegacyImportRecordSchema = z
  .object({
    id: WorkspaceIdSchema,
    sourceKind: z.literal("legacy_workspace"),
    sourceRecordId: z.string().min(1).max(200),
    targetProjectId: NullableWorkspaceIdSchema,
    status: LegacyImportStatusSchema,
    errorCode: z.string().min(1).max(120).nullable(),
    createdAt: IsoDateTimeSchema,
    completedAt: IsoDateTimeSchema.nullable(),
  })
  .strict();

// Request schemas intentionally omit id, user identity, file location, and credentials.
export const CreateProjectRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(240),
    description: OptionalDescriptionSchema.optional(),
    cmNumber: z.string().trim().min(1).max(160).nullable().optional(),
    practice: z.string().trim().min(1).max(160).nullable().optional(),
  })
  .strict();

export const UpdateProjectRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(240).optional(),
    description: OptionalDescriptionSchema.optional(),
    cmNumber: z.string().trim().min(1).max(160).nullable().optional(),
    practice: z.string().trim().min(1).max(160).nullable().optional(),
    status: z.enum(["active", "archived"]).optional(),
  })
  .strict()
  .refine(
    (value) => Object.keys(value).length > 0,
    "at least one update is required",
  );

export const CreateProjectFolderRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    parentFolderId: NullableWorkspaceIdSchema.optional(),
  })
  .strict();

export const UpdateProjectFolderRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    parentFolderId: NullableWorkspaceIdSchema.optional(),
  })
  .strict()
  .refine(
    (value) => Object.keys(value).length > 0,
    "at least one update is required",
  );

export const CreateDocumentRequestSchema = z
  .object({
    projectId: NullableWorkspaceIdSchema.optional(),
    folderId: NullableWorkspaceIdSchema.optional(),
    title: z.string().trim().min(1).max(240),
    filename: z.string().trim().min(1).max(255),
    mimeType: z.string().trim().min(1).max(160),
    sizeBytes: z.number().int().nonnegative().max(2_147_483_647),
  })
  .strict();

export const CreateDocumentVersionRequestSchema = z
  .object({
    filename: z.string().trim().min(1).max(255),
    mimeType: z.string().trim().min(1).max(160),
    sizeBytes: z.number().int().nonnegative().max(2_147_483_647),
  })
  .strict();

export const ResolveDocumentEditRequestSchema = z
  .object({
    decision: z.enum(["accepted", "rejected"]),
  })
  .strict();

export const CreateChatRequestSchema = z
  .object({
    projectId: NullableWorkspaceIdSchema.optional(),
    title: z.string().trim().min(1).max(240).optional(),
    modelProfileId: NullableWorkspaceIdSchema.optional(),
  })
  .strict();

export const UpdateChatRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(240).optional(),
    status: ChatStatusSchema.optional(),
    modelProfileId: NullableWorkspaceIdSchema.optional(),
  })
  .strict()
  .refine(
    (value) => Object.keys(value).length > 0,
    "at least one update is required",
  );

export const CreateChatMessageRequestSchema = z
  .object({
    content: z.string().trim().min(1).max(100_000),
    modelProfileId: NullableWorkspaceIdSchema.optional(),
  })
  .strict();

export const CreateModelProfileRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    provider: ModelProviderSchema,
    model: z.string().trim().min(1).max(200),
    baseUrl: BaseUrlSchema.nullable().optional(),
    contextWindowTokens: z
      .number()
      .int()
      .positive()
      .max(10_000_000)
      .nullable()
      .optional(),
    maxOutputTokens: z
      .number()
      .int()
      .positive()
      .max(10_000_000)
      .nullable()
      .optional(),
    capabilities: z
      .object({
        streaming: z.boolean(),
        toolCalling: z.boolean(),
        structuredOutput: z.boolean(),
        vision: z.boolean(),
      })
      .strict()
      .optional(),
    enabled: z.boolean().optional(),
    isDefault: z.boolean().optional(),
  })
  .strict();

export const UpdateModelProfileRequestSchema =
  CreateModelProfileRequestSchema.partial().refine(
    (value) => Object.keys(value).length > 0,
    "at least one update is required",
  );

const WorkflowColumnInputSchema = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    title: z.string().trim().min(1).max(160),
    outputType: TabularOutputTypeSchema,
    prompt: z.string().trim().min(1).max(20_000),
    enumValues: z
      .array(z.string().trim().min(1).max(160))
      .min(1)
      .max(100)
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.outputType === "enum" && !value.enumValues?.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["enumValues"],
        message: "enum columns require enumValues",
      });
    }
    if (value.outputType !== "enum" && value.enumValues) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["enumValues"],
        message: "enumValues are only valid for enum columns",
      });
    }
  });

const TabularReviewColumnInputSchema = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    title: TabularReviewRequestColumnTitleSchema,
    outputType: TabularOutputTypeSchema,
    prompt: TabularReviewRequestColumnPromptSchema,
    enumValues: z
      .array(TabularReviewRequestEnumValueSchema)
      .min(1)
      .max(100)
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.outputType === "enum" && !value.enumValues?.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["enumValues"],
        message: "enum columns require enumValues",
      });
    }
    if (value.outputType !== "enum" && value.enumValues) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["enumValues"],
        message: "enumValues are only valid for enum columns",
      });
    }
  });

export const CreateAssistantWorkflowRequestSchema = z
  .object({
    type: z.literal("assistant"),
    projectId: NullableWorkspaceIdSchema.optional(),
    title: z.string().trim().min(1).max(200),
    description: OptionalDescriptionSchema.optional(),
    skillMarkdown: z.string().trim().max(100_000).default(""),
    steps: z.array(WorkflowStepSchema).max(100).default([]),
    language: z.string().trim().min(1).max(160).optional(),
    practice: z.string().trim().min(1).max(160).optional(),
    jurisdictions: WorkflowJurisdictionsSchema.optional(),
    metadata: WorkflowMetadataSchema.optional(),
  })
  .strict();

export const CreateTabularWorkflowRequestSchema = z
  .object({
    type: z.literal("tabular"),
    projectId: NullableWorkspaceIdSchema.optional(),
    title: z.string().trim().min(1).max(200),
    description: OptionalDescriptionSchema.optional(),
    columns: z.array(WorkflowColumnInputSchema).max(100).default([]),
    steps: z.array(WorkflowStepSchema).max(100).default([]),
    language: z.string().trim().min(1).max(160).optional(),
    practice: z.string().trim().min(1).max(160).optional(),
    jurisdictions: WorkflowJurisdictionsSchema.optional(),
    metadata: WorkflowMetadataSchema.optional(),
  })
  .strict();

export const CreateWorkflowRequestSchema = z.discriminatedUnion("type", [
  CreateAssistantWorkflowRequestSchema,
  CreateTabularWorkflowRequestSchema,
]);

export const UpdateWorkflowRequestSchema = z
  .object({
    projectId: NullableWorkspaceIdSchema.optional(),
    title: z.string().trim().min(1).max(200).optional(),
    description: OptionalDescriptionSchema.optional(),
    status: WorkflowStatusSchema.optional(),
    skillMarkdown: z.string().trim().max(100_000).optional(),
    steps: z.array(WorkflowStepSchema).max(100).optional(),
    columns: z.array(WorkflowColumnInputSchema).max(100).optional(),
    language: z.string().trim().min(1).max(160).optional(),
    practice: z.string().trim().min(1).max(160).optional(),
    jurisdictions: WorkflowJurisdictionsSchema.optional(),
    metadata: WorkflowMetadataSchema.optional(),
  })
  .strict()
  .refine(
    (value) => Object.keys(value).length > 0,
    "at least one update is required",
  );

export const CreateWorkflowRunRequestSchema = z
  .object({
    projectId: NullableWorkspaceIdSchema.optional(),
    modelProfileId: NullableWorkspaceIdSchema.optional(),
  })
  .strict();

export const CreateTabularReviewRequestSchema = z
  .object({
    projectId: NullableWorkspaceIdSchema.optional(),
    workflowId: NullableWorkspaceIdSchema.optional(),
    title: TabularReviewRequestTitleSchema,
    documentIds: z.array(WorkspaceIdSchema).max(1_000).default([]),
    modelProfileId: NullableWorkspaceIdSchema.optional(),
    columns: z.array(TabularReviewColumnInputSchema).max(100).default([]),
  })
  .strict();

export const UpdateTabularReviewRequestSchema = z
  .object({
    title: TabularReviewRequestTitleSchema.optional(),
    status: z.enum(["draft", "ready", "archived", "cancelled"]).optional(),
    modelProfileId: NullableWorkspaceIdSchema.optional(),
  })
  .strict()
  .refine(
    (value) => Object.keys(value).length > 0,
    "at least one update is required",
  );

export const GenerateTabularCellRequestSchema = z
  .object({
    modelProfileId: NullableWorkspaceIdSchema.optional(),
  })
  .strict();

export const CreateTabularReviewChatRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(240).optional(),
  })
  .strict();

export const CreateTabularReviewChatMessageRequestSchema = z
  .object({
    content: z.string().trim().min(1).max(100_000),
    modelProfileId: NullableWorkspaceIdSchema.optional(),
  })
  .strict();

export const CancelJobRequestSchema = z.object({}).strict();

export const UpdateWorkspaceSettingsRequestSchema = z
  .object({
    locale: z.enum(["zh-CN", "en-US"]).optional(),
    theme: z.enum(["system", "light", "dark"]).optional(),
    defaultModelProfileId: NullableWorkspaceIdSchema.optional(),
    defaultProjectId: NullableWorkspaceIdSchema.optional(),
  })
  .strict()
  .refine(
    (value) => Object.keys(value).length > 0,
    "at least one update is required",
  );

export const IdParamsSchema = z.object({ id: WorkspaceIdSchema }).strict();

export const ApiErrorSchema = z
  .object({
    detail: z.string().min(1).max(2_000),
    code: z.enum(API_ERROR_CODES),
    error: z
      .object({
        code: z.enum(API_ERROR_CODES),
        message: z.string().min(1).max(2_000),
        retryable: z.boolean(),
        requestId: z.string().min(1).max(120).optional(),
        details: z
          .array(
            z
              .object({
                path: z.string().max(500),
                message: z.string().min(1).max(2_000),
              })
              .strict(),
          )
          .max(100)
          .optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.code !== value.error.code) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["code"],
        message: "top-level and nested error codes must match",
      });
    }
    if (value.detail !== value.error.message) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["detail"],
        message: "top-level detail and nested error message must match",
      });
    }
  });

export type CreateProjectRequest = z.infer<typeof CreateProjectRequestSchema>;
export type CreateDocumentRequest = z.infer<typeof CreateDocumentRequestSchema>;
export type CreateWorkflowRequest = z.infer<typeof CreateWorkflowRequestSchema>;
export type CreateTabularReviewRequest = z.infer<
  typeof CreateTabularReviewRequestSchema
>;
export type ApiErrorResponse = z.infer<typeof ApiErrorSchema>;
