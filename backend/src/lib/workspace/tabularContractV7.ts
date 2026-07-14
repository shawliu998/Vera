import { z } from "zod";

import {
  IsoDateTimeSchema,
  NullableWorkspaceIdSchema,
  StructuredErrorSchema,
  UnicodeCodePointStringSchemaV1,
  type StructuredErrorV1,
  WorkspaceIdSchema,
} from "./workspacePersistencePrimitivesV1";

export {
  IsoDateTimeSchema,
  NullableWorkspaceIdSchema,
  StructuredErrorSchema,
  UnicodeCodePointStringSchemaV1,
  WorkspaceIdSchema,
  type StructuredErrorV1,
} from "./workspacePersistencePrimitivesV1";

export const TABULAR_CONTRACT_V7_MANIFEST = {
  version: "tabular-contract-v7",
  limits: {
    reviewDocuments: 1000,
    reviewColumns: 100,
    reviewCells: 10000,
    reviewTitle: 240,
    columnKey: 120,
    columnTitle: 240,
    columnPrompt: 20000,
    tag: 160,
    tags: 100,
    cellContent: 100000,
    sourceQuote: 8000,
    sourceRefs: 1000,
    chatAnnotations: 1000,
  },
  enums: {
    formats: [
      "text",
      "bulleted_list",
      "number",
      "percentage",
      "monetary_amount",
      "currency",
      "yes_no",
      "date",
      "tag",
    ],
    outputTypes: ["text", "boolean", "enum", "number"],
    flags: ["green", "grey", "yellow", "red"],
    reviewStatuses: [
      "draft",
      "ready",
      "running",
      "complete",
      "failed",
      "cancelled",
      "archived",
    ],
    cellStatuses: [
      "empty",
      "queued",
      "running",
      "complete",
      "failed",
      "cancelled",
    ],
    chatStatuses: ["active", "archived"],
    messageRoles: ["user", "assistant", "tool"],
    messageStatuses: [
      "pending",
      "streaming",
      "complete",
      "failed",
      "cancelled",
      "interrupted",
    ],
    mikeCellStatuses: ["pending", "generating", "done", "error"],
  },
  legacyMapping: {
    formatForOutputType: {
      text: "text",
      boolean: "yes_no",
      enum: "tag",
      number: "number",
    },
    outputTypeForFormat: {
      text: "text",
      bulleted_list: "text",
      number: "number",
      percentage: "text",
      monetary_amount: "text",
      currency: "text",
      yes_no: "boolean",
      date: "text",
      tag: "enum",
    },
  },
  cellStatusToMikeStatus: {
    empty: "pending",
    queued: "generating",
    running: "generating",
    complete: "done",
    failed: "error",
    cancelled: "error",
  },
  content: {
    keys: ["summary", "flag", "reasoning"],
    required: ["summary"],
    optional: ["flag", "reasoning"],
  },
  stringLength: {
    unit: "unicode_code_points",
    rejectUnpairedSurrogates: true,
    rejectNul: true,
  },
  nulRecovery: {
    schema: "tabular-v7-nul-recovery-snapshot-v1",
    replacement: "\uFFFD",
    table: "tabular_v7_nul_recovery_snapshots",
    lockTriggers: {
      insert: "tabular_v7_nul_recovery_snapshots_lock_insert",
      update: "tabular_v7_nul_recovery_snapshots_lock_update",
      delete: "tabular_v7_nul_recovery_snapshots_lock_delete",
    },
    lifecycleTriggers: {
      reviewDeletePurge:
        "tabular_v7_nul_recovery_snapshots_purge_review_delete",
    },
    liveWriteTriggers: {
      reviewTitleInsert: "tabular_reviews_title_mike_insert",
      reviewTitleUpdate: "tabular_reviews_title_mike_update",
      columnTextInsert: "tabular_review_columns_text_mike_insert",
      columnTextUpdate: "tabular_review_columns_text_mike_update",
    },
    fields: [
      "tabular_reviews.title",
      "tabular_review_columns.title",
      "tabular_review_columns.prompt",
      "tabular_review_columns.enum_values_json string items",
    ],
  },
} as const;

export const TABULAR_COLUMN_FORMATS =
  TABULAR_CONTRACT_V7_MANIFEST.enums.formats;
export const TABULAR_OUTPUT_TYPES =
  TABULAR_CONTRACT_V7_MANIFEST.enums.outputTypes;
export const TABULAR_CELL_FLAGS = TABULAR_CONTRACT_V7_MANIFEST.enums.flags;
export const TABULAR_REVIEW_STATUSES =
  TABULAR_CONTRACT_V7_MANIFEST.enums.reviewStatuses;
export const TABULAR_CELL_STATUSES =
  TABULAR_CONTRACT_V7_MANIFEST.enums.cellStatuses;
export const TABULAR_CHAT_STATUSES =
  TABULAR_CONTRACT_V7_MANIFEST.enums.chatStatuses;
export const TABULAR_MESSAGE_ROLES =
  TABULAR_CONTRACT_V7_MANIFEST.enums.messageRoles;
export const TABULAR_MESSAGE_STATUSES =
  TABULAR_CONTRACT_V7_MANIFEST.enums.messageStatuses;

export type TabularColumnFormat = (typeof TABULAR_COLUMN_FORMATS)[number];
export type LegacyTabularOutputType = (typeof TABULAR_OUTPUT_TYPES)[number];
export type TabularCellFlag = (typeof TABULAR_CELL_FLAGS)[number];
export type TabularReviewStatus = (typeof TABULAR_REVIEW_STATUSES)[number];
export type TabularCellStatus = (typeof TABULAR_CELL_STATUSES)[number];
export type TabularChatStatus = (typeof TABULAR_CHAT_STATUSES)[number];
export type TabularMessageRole = (typeof TABULAR_MESSAGE_ROLES)[number];
export type TabularMessageStatus = (typeof TABULAR_MESSAGE_STATUSES)[number];
export type MikeTabularStatus =
  (typeof TABULAR_CONTRACT_V7_MANIFEST.enums.mikeCellStatuses)[number];

export const TabularReviewTitleSchemaV7 = UnicodeCodePointStringSchemaV1({
  min: 1,
  max: TABULAR_CONTRACT_V7_MANIFEST.limits.reviewTitle,
  trimForMin: true,
});
export const TabularColumnKeySchemaV7 = UnicodeCodePointStringSchemaV1({
  min: 1,
  max: TABULAR_CONTRACT_V7_MANIFEST.limits.columnKey,
  trimForMin: true,
});
export const TabularColumnTitleSchemaV7 = UnicodeCodePointStringSchemaV1({
  min: 1,
  max: TABULAR_CONTRACT_V7_MANIFEST.limits.columnTitle,
  trimForMin: true,
});
export const TabularColumnPromptSchemaV7 = UnicodeCodePointStringSchemaV1({
  max: TABULAR_CONTRACT_V7_MANIFEST.limits.columnPrompt,
});
export const TabularTagSchemaV7 = UnicodeCodePointStringSchemaV1({
  min: 1,
  max: TABULAR_CONTRACT_V7_MANIFEST.limits.tag,
  trimForMin: true,
});
export const TrimmedTabularTagSchemaV7 = TabularTagSchemaV7.transform((value) =>
  value.trim(),
);
export const TabularCellTextSchemaV7 = UnicodeCodePointStringSchemaV1({
  max: TABULAR_CONTRACT_V7_MANIFEST.limits.cellContent,
});
export const TabularSourceQuoteSchemaV7 = UnicodeCodePointStringSchemaV1({
  min: 1,
  max: TABULAR_CONTRACT_V7_MANIFEST.limits.sourceQuote,
});

export type TabularCellContent = {
  summary: string;
  flag?: TabularCellFlag;
  reasoning?: string;
};
export type TabularCellContentOrNull = TabularCellContent | null;
export type TabularLegacyCellValue = string | boolean | number | null;
export type TabularReviewV7 = {
  id: string;
  projectId: string | null;
  workflowId: string | null;
  title: string;
  status: TabularReviewStatus;
  documentIds: string[];
  modelProfileId: string | null;
  createdAt: string;
  updatedAt: string;
};
export type TabularCellV7 = {
  id: string;
  reviewId: string;
  documentId: string;
  columnId: string;
  outputType: LegacyTabularOutputType;
  value: TabularLegacyCellValue;
  status: TabularCellStatus;
  error: StructuredErrorV1 | null;
  jobId: string | null;
  updatedAt: string;
};

export const TabularColumnFormatSchema = z.enum(TABULAR_COLUMN_FORMATS);
export const LegacyTabularOutputTypeSchema = z.enum(TABULAR_OUTPUT_TYPES);
export const TabularReviewStatusSchema = z.enum(TABULAR_REVIEW_STATUSES);
export const TabularCellStatusSchema = z.enum(TABULAR_CELL_STATUSES);
export const TabularCellContentSchema = z
  .object({
    summary: TabularCellTextSchemaV7,
    flag: z.enum(TABULAR_CELL_FLAGS).optional(),
    reasoning: TabularCellTextSchemaV7.optional(),
  })
  .strict();
export const TabularCellContentOrNullSchema =
  TabularCellContentSchema.nullable();
export const LegacyCellValueSchema = z.union([
  z.string(),
  z.boolean(),
  z.number().finite(),
  z.null(),
]);
export const TabularSourceRefSchema = z
  .object({
    documentId: WorkspaceIdSchema,
    versionId: WorkspaceIdSchema.nullable().optional(),
    chunkId: WorkspaceIdSchema.nullable().optional(),
    quote: TabularSourceQuoteSchemaV7.nullable().optional(),
    startOffset: z.number().int().nonnegative().nullable().optional(),
    endOffset: z.number().int().nonnegative().nullable().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.startOffset == null) !== (value.endOffset == null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [value.startOffset == null ? "startOffset" : "endOffset"],
        message: "source offsets must be provided together",
      });
    }
    if (
      value.startOffset != null &&
      value.endOffset != null &&
      value.endOffset < value.startOffset
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endOffset"],
        message: "endOffset must not precede startOffset",
      });
    }
    if (value.chunkId != null && value.versionId == null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["versionId"],
        message: "chunk sources require a versionId",
      });
    }
    if (value.startOffset != null && value.versionId == null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["versionId"],
        message: "offset sources require a versionId",
      });
    }
  });
export type TabularSourceRef = z.infer<typeof TabularSourceRefSchema>;

export const MikeColumnConfigSchema = z
  .object({
    index: z.number().int().nonnegative(),
    name: TabularColumnTitleSchemaV7.transform((value) => value.trim()),
    prompt: TabularColumnPromptSchemaV7.default(""),
    format: TabularColumnFormatSchema.default("text"),
    tags: z
      .array(TrimmedTabularTagSchemaV7)
      .max(TABULAR_CONTRACT_V7_MANIFEST.limits.tags)
      .default([]),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.format !== "tag" && value.tags.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tags"],
        message: "tags are only valid for tag columns",
      });
    }
  });

export function legacyOutputTypeForFormat(
  format: TabularColumnFormat,
): LegacyTabularOutputType {
  return TABULAR_CONTRACT_V7_MANIFEST.legacyMapping.outputTypeForFormat[
    format
  ] as LegacyTabularOutputType;
}

export function formatForLegacyOutputType(
  outputType: unknown,
): TabularColumnFormat {
  if (
    outputType === "text" ||
    outputType === "boolean" ||
    outputType === "enum" ||
    outputType === "number"
  ) {
    return TABULAR_CONTRACT_V7_MANIFEST.legacyMapping.formatForOutputType[
      outputType
    ] as TabularColumnFormat;
  }
  return "text";
}

export function mikeStatusForCellStatus(status: string): MikeTabularStatus {
  if (status === "queued" || status === "running") return "generating";
  if (status === "complete") return "done";
  if (status === "failed" || status === "cancelled") return "error";
  return "pending";
}

export function normalizeTabularCellContent(
  value: unknown,
): TabularCellContentOrNull {
  if (value == null || value === "") return null;
  if (typeof value === "object" && !Array.isArray(value)) {
    return TabularCellContentOrNullSchema.parse(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return TabularCellContentOrNullSchema.parse(parsed);
      }
    } catch {
      // Treat legacy raw text as a summary.
    }
    return TabularCellContentSchema.parse({
      summary: trimmed,
      flag: "grey",
      reasoning: "",
    });
  }
  if (typeof value === "boolean") {
    return TabularCellContentSchema.parse({
      summary: value ? "Yes" : "No",
      flag: "grey",
      reasoning: "",
    });
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return TabularCellContentSchema.parse({
      summary: String(value),
      flag: "grey",
      reasoning: "",
    });
  }
  return null;
}

export function legacyValueForContent(
  content: TabularCellContentOrNull,
  outputType: LegacyTabularOutputType,
): string | boolean | number | null {
  if (!content) return null;
  const summary = content.summary.trim();
  if (!summary) return null;
  if (outputType === "boolean") {
    if (/^\[\[?yes\]?\]?$/i.test(summary) || /^yes$/i.test(summary)) {
      return true;
    }
    if (/^\[\[?no\]?\]?$/i.test(summary) || /^no$/i.test(summary)) {
      return false;
    }
    return summary;
  }
  if (outputType === "number") {
    const normalized = summary.replace(/,/g, "");
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : summary;
  }
  return summary;
}

export function parseTags(value: unknown): string[] {
  if (value == null || value === "") return [];
  const parsed =
    typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  return z
    .array(TrimmedTabularTagSchemaV7)
    .max(TABULAR_CONTRACT_V7_MANIFEST.limits.tags)
    .parse(parsed);
}

export function normalizeMikeColumns(
  columns: unknown,
): Array<z.infer<typeof MikeColumnConfigSchema>> {
  const parsed = z
    .array(MikeColumnConfigSchema)
    .max(TABULAR_CONTRACT_V7_MANIFEST.limits.reviewColumns)
    .parse(columns);
  const seenIndexes = new Set<number>();
  for (const column of parsed) {
    if (seenIndexes.has(column.index)) {
      throw new z.ZodError([
        {
          code: z.ZodIssueCode.custom,
          path: ["columns_config"],
          message: "column indexes must be unique",
        },
      ]);
    }
    seenIndexes.add(column.index);
  }
  return parsed.map((column) => ({
    index: column.index,
    name: column.name,
    prompt: column.prompt,
    format: column.format,
    tags: column.format === "tag" ? column.tags : [],
  }));
}

export const TabularReviewSchemaV7 = z
  .object({
    id: WorkspaceIdSchema,
    projectId: NullableWorkspaceIdSchema,
    workflowId: NullableWorkspaceIdSchema,
    title: TabularReviewTitleSchemaV7,
    status: TabularReviewStatusSchema,
    documentIds: WorkspaceIdSchema.array().max(
      TABULAR_CONTRACT_V7_MANIFEST.limits.reviewDocuments,
    ),
    modelProfileId: NullableWorkspaceIdSchema,
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict();

export const TabularColumnRecordSchemaV7 = z
  .object({
    id: WorkspaceIdSchema,
    reviewId: WorkspaceIdSchema,
    key: TabularColumnKeySchemaV7,
    title: TabularColumnTitleSchemaV7,
    outputType: LegacyTabularOutputTypeSchema,
    format: TabularColumnFormatSchema,
    prompt: TabularColumnPromptSchemaV7,
    enumValues: z
      .array(TabularTagSchemaV7)
      .max(TABULAR_CONTRACT_V7_MANIFEST.limits.tags)
      .nullable(),
    tags: z
      .array(TabularTagSchemaV7)
      .max(TABULAR_CONTRACT_V7_MANIFEST.limits.tags),
    ordinal: z.number().int().nonnegative(),
    legacyMetadata: z.record(z.string(), z.unknown()),
  })
  .strict();

export const TabularCellRecordSchemaV7 = z
  .object({
    id: WorkspaceIdSchema,
    reviewId: WorkspaceIdSchema,
    documentId: WorkspaceIdSchema,
    columnId: WorkspaceIdSchema,
    outputType: LegacyTabularOutputTypeSchema,
    value: LegacyCellValueSchema,
    content: TabularCellContentOrNullSchema,
    status: TabularCellStatusSchema,
    error: StructuredErrorSchema.nullable(),
    jobId: NullableWorkspaceIdSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict();

export const TabularChatMessageStatusSchema = z.enum(TABULAR_MESSAGE_STATUSES);
export const TabularChatMessageRoleSchema = z.enum(TABULAR_MESSAGE_ROLES);
export const TabularChatStatusSchema = z.enum(TABULAR_CHAT_STATUSES);
