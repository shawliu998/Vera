import { z } from "zod";

import {
  IsoDateTimeSchema,
  UnicodeCodePointStringSchemaV1,
  WorkspaceIdSchema,
} from "./workspacePersistencePrimitivesV1";
import { CommitMarkdownVersionCasV12Schema } from "./documentStudioContractsV12";

export const DOCUMENT_STUDIO_SUGGESTION_MAX_TEXT_CHARS_V14 = 200_000;
export const DOCUMENT_STUDIO_SUGGESTION_CONTEXT_CHARS_V14 = 240;

const SuggestionTextSchema = UnicodeCodePointStringSchemaV1({
  max: DOCUMENT_STUDIO_SUGGESTION_MAX_TEXT_CHARS_V14,
});
const ContextSchema = UnicodeCodePointStringSchemaV1({
  max: DOCUMENT_STUDIO_SUGGESTION_CONTEXT_CHARS_V14,
});
const SummarySchema = UnicodeCodePointStringSchemaV1({
  min: 1,
  max: 500,
  trimForMin: true,
});
const OffsetSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

export const DOCUMENT_STUDIO_SUGGESTION_PREVIEW_CHARS_V14 = 160;

const SuggestionPayloadShape = {
  suggestionId: WorkspaceIdSchema,
  projectId: WorkspaceIdSchema,
  documentId: WorkspaceIdSchema,
  baseVersionId: WorkspaceIdSchema,
  messageId: WorkspaceIdSchema,
  changeId: UnicodeCodePointStringSchemaV1({
    min: 1,
    max: 160,
    trimForMin: true,
  }),
  startOffset: OffsetSchema,
  endOffset: OffsetSchema,
  offsetScope: z.literal("raw_markdown_v1"),
  offsetUnit: z.literal("utf16_code_unit"),
  deletedText: SuggestionTextSchema,
  insertedText: SuggestionTextSchema,
  contextBefore: ContextSchema,
  contextAfter: ContextSchema,
  summary: SummarySchema,
};

function validateSuggestionRange(
  value: {
    startOffset: number;
    endOffset: number;
    deletedText: string;
    insertedText: string;
  },
  context: z.RefinementCtx,
) {
  if (value.endOffset - value.startOffset !== value.deletedText.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["endOffset"],
      message: "Suggestion offsets must span exact deleted UTF-16 text.",
    });
  }
  if (value.deletedText.length === 0 && value.insertedText.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["insertedText"],
      message: "Suggestion must change the Markdown content.",
    });
  }
}

export const CreateDocumentStudioSuggestionV14Schema = z
  .object({
    ...SuggestionPayloadShape,
    createdAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine(validateSuggestionRange);

export const DocumentStudioSuggestionV14Schema = z
  .object({
    id: WorkspaceIdSchema,
    projectId: WorkspaceIdSchema,
    documentId: WorkspaceIdSchema,
    baseVersionId: WorkspaceIdSchema,
    messageId: WorkspaceIdSchema.nullable(),
    changeId: SuggestionPayloadShape.changeId,
    startOffset: OffsetSchema,
    endOffset: OffsetSchema,
    offsetScope: z.literal("raw_markdown_v1"),
    offsetUnit: z.literal("utf16_code_unit"),
    deletedText: SuggestionTextSchema,
    insertedText: SuggestionTextSchema,
    contextBefore: ContextSchema,
    contextAfter: ContextSchema,
    summary: SummarySchema,
    status: z.enum(["pending", "accepted", "rejected"]),
    createdAt: IsoDateTimeSchema,
    resolvedAt: IsoDateTimeSchema.nullable(),
    resultVersionId: WorkspaceIdSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    validateSuggestionRange(value, context);
    if ((value.status === "pending") !== (value.resolvedAt === null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["resolvedAt"],
        message: "Suggestion status and resolution time do not match.",
      });
    }
    if (value.status === "accepted" && value.resultVersionId === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["resultVersionId"],
        message: "Accepted suggestion must resolve to an immutable version.",
      });
    }
    if (value.status !== "accepted" && value.resultVersionId !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["resultVersionId"],
        message: "Only accepted suggestions can resolve to a version.",
      });
    }
  });

export const RejectDocumentStudioSuggestionV14Schema = z
  .object({
    projectId: WorkspaceIdSchema,
    documentId: WorkspaceIdSchema,
    suggestionId: WorkspaceIdSchema,
    resolvedAt: IsoDateTimeSchema,
  })
  .strict();

export const AcceptDocumentStudioSuggestionV14Schema = z
  .object({
    commit: CommitMarkdownVersionCasV12Schema,
    suggestionId: WorkspaceIdSchema,
    exactStartOffset: OffsetSchema,
    exactEndOffset: OffsetSchema,
    exactDeletedText: SuggestionTextSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.commit.source !== "user_accept") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["commit", "source"],
        message: "Suggestion acceptance must create a user_accept version.",
      });
    }
    if (
      value.exactEndOffset - value.exactStartOffset !==
      value.exactDeletedText.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["exactEndOffset"],
        message: "Accepted suggestion exact range is invalid.",
      });
    }
  });

export type CreateDocumentStudioSuggestionV14 = z.input<
  typeof CreateDocumentStudioSuggestionV14Schema
>;
export type DocumentStudioSuggestionV14 = z.output<
  typeof DocumentStudioSuggestionV14Schema
>;

export const DocumentStudioSuggestionPreviewV14Schema = z
  .object({
    id: WorkspaceIdSchema,
    projectId: WorkspaceIdSchema,
    documentId: WorkspaceIdSchema,
    baseVersionId: WorkspaceIdSchema,
    messageId: WorkspaceIdSchema.nullable(),
    startOffset: OffsetSchema,
    endOffset: OffsetSchema,
    offsetScope: z.literal("raw_markdown_v1"),
    offsetUnit: z.literal("utf16_code_unit"),
    deletedPreview: UnicodeCodePointStringSchemaV1({
      max: DOCUMENT_STUDIO_SUGGESTION_PREVIEW_CHARS_V14,
    }),
    insertedPreview: UnicodeCodePointStringSchemaV1({
      max: DOCUMENT_STUDIO_SUGGESTION_PREVIEW_CHARS_V14,
    }),
    deletedTruncated: z.boolean(),
    insertedTruncated: z.boolean(),
    contextBefore: ContextSchema,
    contextAfter: ContextSchema,
    summary: SummarySchema,
    status: z.literal("pending"),
    createdAt: IsoDateTimeSchema,
  })
  .strict();

export type DocumentStudioSuggestionPreviewV14 = z.output<
  typeof DocumentStudioSuggestionPreviewV14Schema
>;

export type DocumentStudioSuggestionPreviewPageV14 = Readonly<{
  suggestions: DocumentStudioSuggestionPreviewV14[];
  hasMore: boolean;
}>;
export type RejectDocumentStudioSuggestionV14 = z.input<
  typeof RejectDocumentStudioSuggestionV14Schema
>;
export type AcceptDocumentStudioSuggestionV14 = z.input<
  typeof AcceptDocumentStudioSuggestionV14Schema
>;
