import { createHash } from "node:crypto";
import { z } from "zod";

import {
  IsoDateTimeSchema,
  UnicodeCodePointStringSchemaV1,
  WorkspaceIdSchema,
} from "./workspacePersistencePrimitivesV1";

export const DOCUMENT_KINDS_V12 = ["source", "draft", "template"] as const;
export const DOCUMENT_STUDIO_KINDS_V12 = ["draft", "template"] as const;
export const DOCUMENT_STUDIO_VERSION_SOURCES_V12 = [
  "user_upload",
  "assistant_edit",
  "user_accept",
] as const;

export const DocumentKindV12Schema = z.enum(DOCUMENT_KINDS_V12);
export const DocumentStudioKindV12Schema = z.enum(DOCUMENT_STUDIO_KINDS_V12);
export const DocumentStudioVersionSourceV12Schema = z.enum(
  DOCUMENT_STUDIO_VERSION_SOURCES_V12,
);

const MAX_MARKDOWN_CODE_POINTS = 4_000_000;
const MAX_MARKDOWN_BYTES = 4 * 1024 * 1024;
const UNSUPPORTED_MARKDOWN_CONTROL =
  /[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export function canonicalizeDocumentStudioMarkdownV12(value: string): string {
  return value;
}

export const CanonicalDocumentStudioMarkdownV12Schema =
  UnicodeCodePointStringSchemaV1({ max: MAX_MARKDOWN_CODE_POINTS })
    .superRefine((value, context) => {
      if (Buffer.byteLength(value, "utf8") > MAX_MARKDOWN_BYTES) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Studio Markdown exceeds the bounded UTF-8 size",
        });
      }
      if (UNSUPPORTED_MARKDOWN_CONTROL.test(value)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Studio Markdown contains an unsupported control character",
        });
      }
    })
    .transform(canonicalizeDocumentStudioMarkdownV12);

export function documentStudioMarkdownSha256V12(value: string): string {
  const canonical = CanonicalDocumentStudioMarkdownV12Schema.parse(value);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const SafeMarkdownFilenameSchema = UnicodeCodePointStringSchemaV1({
  min: 1,
  max: 240,
  trimForMin: true,
}).superRefine((value, context) => {
  if (
    value.includes("/") ||
    value.includes("\\") ||
    value === "." ||
    value === ".." ||
    !value.toLowerCase().endsWith(".md")
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Studio filename must be a safe .md file name",
    });
  }
});
const TitleSchema = UnicodeCodePointStringSchemaV1({
  min: 1,
  max: 240,
  trimForMin: true,
});
const SummarySchema = UnicodeCodePointStringSchemaV1({ max: 500 }).nullable();
const OperationIdSchema = UnicodeCodePointStringSchemaV1({
  min: 1,
  max: 120,
  trimForMin: true,
}).nullable();
const ByteCountSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
const CitationAnchorIdsSchema = z
  .array(WorkspaceIdSchema)
  .max(200)
  .superRefine((ids, context) => {
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "citationAnchorIds must not contain duplicates",
      });
    }
  });

const PreparedMarkdownBlobShape = {
  blobRecordId: WorkspaceIdSchema,
  contentSha256: Sha256Schema,
  sizeBytes: ByteCountSchema,
  storedSizeBytes: ByteCountSchema,
};

export const CreateMarkdownDraftV12Schema = z
  .object({
    projectId: WorkspaceIdSchema,
    documentId: WorkspaceIdSchema,
    versionId: WorkspaceIdSchema,
    jobId: WorkspaceIdSchema,
    folderId: WorkspaceIdSchema.nullable(),
    documentKind: DocumentStudioKindV12Schema,
    title: TitleSchema,
    filename: SafeMarkdownFilenameSchema,
    source: z.enum(["user_upload", "assistant_edit"]).default("user_upload"),
    summary: SummarySchema,
    operationId: OperationIdSchema,
    citationAnchorIds: CitationAnchorIdsSchema,
    createdAt: IsoDateTimeSchema,
    ...PreparedMarkdownBlobShape,
  })
  .strict();

export const CommitMarkdownVersionCasV12Schema = z
  .object({
    projectId: WorkspaceIdSchema,
    documentId: WorkspaceIdSchema,
    expectedCurrentVersionId: WorkspaceIdSchema,
    versionId: WorkspaceIdSchema,
    jobId: WorkspaceIdSchema,
    source: DocumentStudioVersionSourceV12Schema,
    filename: SafeMarkdownFilenameSchema,
    summary: SummarySchema,
    operationId: OperationIdSchema,
    citationAnchorIds: CitationAnchorIdsSchema,
    createdAt: IsoDateTimeSchema,
    ...PreparedMarkdownBlobShape,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.versionId === value.expectedCurrentVersionId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["versionId"],
        message: "A Studio commit must create a new immutable version",
      });
    }
  });

export const RestoreMarkdownVersionCasV12Schema = z
  .object({
    projectId: WorkspaceIdSchema,
    documentId: WorkspaceIdSchema,
    expectedCurrentVersionId: WorkspaceIdSchema,
    restoreFromVersionId: WorkspaceIdSchema,
    versionId: WorkspaceIdSchema,
    jobId: WorkspaceIdSchema,
    blobRecordId: WorkspaceIdSchema,
    contentSha256: Sha256Schema,
    sizeBytes: ByteCountSchema,
    storedSizeBytes: ByteCountSchema,
    summary: SummarySchema,
    operationId: OperationIdSchema,
    createdAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.versionId === value.expectedCurrentVersionId ||
      value.versionId === value.restoreFromVersionId
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["versionId"],
        message: "A Studio restore must create a new immutable version",
      });
    }
  });

export const StudioDocumentV12Schema = z
  .object({
    id: WorkspaceIdSchema,
    projectId: WorkspaceIdSchema,
    folderId: WorkspaceIdSchema.nullable(),
    documentKind: DocumentStudioKindV12Schema,
    title: TitleSchema,
    filename: SafeMarkdownFilenameSchema,
    mimeType: z.literal("text/markdown"),
    sizeBytes: ByteCountSchema,
    parseStatus: z.enum([
      "pending",
      "processing",
      "ready",
      "failed",
      "unsupported",
      "ocr_required",
    ]),
    currentVersionId: WorkspaceIdSchema,
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict();

export const StudioCitationBindingV12Schema = z
  .object({
    projectId: WorkspaceIdSchema,
    documentId: WorkspaceIdSchema,
    versionId: WorkspaceIdSchema,
    anchorId: WorkspaceIdSchema,
    ordinal: z.number().int().nonnegative(),
    createdAt: IsoDateTimeSchema,
  })
  .strict();

export const StudioDocumentVersionV12Schema = z
  .object({
    id: WorkspaceIdSchema,
    projectId: WorkspaceIdSchema,
    documentId: WorkspaceIdSchema,
    versionNumber: z.number().int().positive(),
    source: DocumentStudioVersionSourceV12Schema,
    filename: SafeMarkdownFilenameSchema,
    mimeType: z.literal("text/markdown"),
    sizeBytes: ByteCountSchema,
    contentSha256: Sha256Schema,
    storageKey: z.string().min(1).max(1024),
    pageCount: z.number().int().nonnegative().nullable(),
    format: z.literal("markdown"),
    summary: SummarySchema,
    operationId: OperationIdSchema,
    createdAt: IsoDateTimeSchema,
    citationAnchorIds: z.array(WorkspaceIdSchema).max(200),
  })
  .strict();

export type DocumentKindV12 = z.infer<typeof DocumentKindV12Schema>;
export type DocumentStudioKindV12 = z.infer<typeof DocumentStudioKindV12Schema>;
export type CreateMarkdownDraftV12 = z.input<
  typeof CreateMarkdownDraftV12Schema
>;
export type CommitMarkdownVersionCasV12 = z.input<
  typeof CommitMarkdownVersionCasV12Schema
>;
export type RestoreMarkdownVersionCasV12 = z.input<
  typeof RestoreMarkdownVersionCasV12Schema
>;
export type StudioDocumentV12 = z.output<typeof StudioDocumentV12Schema>;
export type StudioCitationBindingV12 = z.output<
  typeof StudioCitationBindingV12Schema
>;
export type StudioDocumentVersionV12 = z.output<
  typeof StudioDocumentVersionV12Schema
>;

export type StudioProjectDocumentV12 = {
  document: StudioDocumentV12;
  currentVersion: StudioDocumentVersionV12;
};

export type StudioVersionCommitV12 = StudioProjectDocumentV12 & {
  version: StudioDocumentVersionV12;
  jobId: string;
  citationAnchorIds: string[];
  replayed: false;
};
