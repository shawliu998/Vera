import { randomUUID } from "node:crypto";
import { z } from "zod";

import {
  StructuredErrorSchema,
  UpdateTabularReviewRequestSchema,
  WorkspaceIdSchema,
} from "../contracts";
import { WorkspaceApiError } from "../errors";
import type { PageRequest } from "../pagination";
import {
  TabularRepository,
  TabularSourceRefSchema,
  type TabularCellRecord,
  type TabularColumnRecord,
  type TabularReviewDetail,
  type TabularSourceRef,
} from "../repositories/tabular";
import type { StructuredError } from "../types";
import {
  legacyOutputTypeForFormat,
  formatForLegacyOutputType,
  normalizeTabularCellContent,
  TabularColumnPromptSchemaV7,
  TabularColumnTitleSchemaV7,
  TabularColumnFormatSchema,
  TabularReviewTitleSchemaV7,
  TrimmedTabularTagSchemaV7,
  type TabularCellContent,
  type TabularColumnFormat,
} from "./tabularCompatibility";
import type { JobEnqueuer } from "./jobEnqueuer";

export const MAX_TABULAR_MATRIX_CELLS = 10_000;
export const MAX_TABULAR_CELL_ATTEMPTS = 3;
export const TABULAR_GENERATION_DISABLED_MESSAGE =
  "Tabular generation requires a document-level authoritative extracted-text runtime.";

const DraftColumnInputSchema = z
  .object({
    key: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,63}$/)
      .optional(),
    title: TabularColumnTitleSchemaV7.transform((value) =>
      value.trim(),
    ).optional(),
    outputType: z.enum(["text", "boolean", "enum", "number"]).optional(),
    index: z.number().int().nonnegative().optional(),
    name: TabularColumnTitleSchemaV7.transform((value) =>
      value.trim(),
    ).optional(),
    format: TabularColumnFormatSchema.optional(),
    prompt: TabularColumnPromptSchemaV7.transform((value) =>
      value.trim(),
    ).default(""),
    tags: z.array(TrimmedTabularTagSchemaV7).max(100).optional(),
    enumValues: z.array(TrimmedTabularTagSchemaV7).min(1).max(100).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const outputType =
      value.outputType ?? legacyOutputTypeForFormat(value.format ?? "text");
    const format = value.format ?? formatForLegacyOutputType(outputType);
    if (
      value.outputType !== undefined &&
      value.format !== undefined &&
      legacyOutputTypeForFormat(value.format) !== value.outputType
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["format"],
        message: "format must match outputType.",
      });
    }
    if (!value.title && !value.name) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["title"],
        message: "column title or name is required",
      });
    }
    if (
      outputType === "enum" &&
      !value.enumValues?.length &&
      !value.tags?.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["enumValues"],
        message: "enum/tag columns require enumValues or tags",
      });
    }
    if (outputType !== "enum" && value.enumValues) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["enumValues"],
        message: "enumValues are only valid for enum columns",
      });
    }
    if (format !== "tag" && value.tags?.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tags"],
        message: "tags are only valid for tag columns",
      });
    }
  });

/** Temporary v1 compatibility for Mike's empty-draft POST contract. */
const CreateTabularDraftSchema = z
  .object({
    projectId: WorkspaceIdSchema.nullable().optional(),
    workflowId: WorkspaceIdSchema.nullable().optional(),
    title: TabularReviewTitleSchemaV7.transform((value) => value.trim()),
    documentIds: WorkspaceIdSchema.array().max(1_000).default([]),
    modelProfileId: WorkspaceIdSchema.nullable().optional(),
    columns: DraftColumnInputSchema.array().max(100).default([]),
  })
  .strict();

const UpdateTabularDraftMatrixSchema = z
  .object({
    projectId: WorkspaceIdSchema.nullable().optional(),
    documentIds: WorkspaceIdSchema.array().max(1_000),
    columns: DraftColumnInputSchema.array().max(100),
  })
  .strict();

const sensitiveToken =
  /(?:bearer\s+)[a-z0-9._~+\/-]+|\b(?:sk|key)-[a-z0-9_-]{8,}\b/gi;
const localPath = /(?:\/[Uu]sers\/|\/home\/|[A-Za-z]:\\)[^\s"']+/g;

function redactText(value: string) {
  return value
    .replace(sensitiveToken, "[redacted]")
    .replace(localPath, "[redacted-path]");
}

function sanitizeError(value: unknown): StructuredError {
  const parsed = StructuredErrorSchema.parse(value);
  return StructuredErrorSchema.parse({
    ...parsed,
    message: redactText(parsed.message),
    details:
      parsed.details == null
        ? null
        : Object.fromEntries(
            Object.entries(parsed.details).map(([key, item]) => [
              key,
              typeof item === "string" ? redactText(item) : item,
            ]),
          ),
  });
}

export function failTabularGenerationDisabled(): never {
  throw new WorkspaceApiError(
    409,
    "CONFLICT",
    TABULAR_GENERATION_DISABLED_MESSAGE,
  );
}

function slugKey(value: string, fallback: string) {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  return /^[a-z][a-z0-9_]{0,63}$/.test(slug) ? slug : fallback;
}

function columnRecordFromInput(
  input: z.infer<typeof DraftColumnInputSchema>,
  ids: { reviewId: string; columnId: string; ordinal: number },
): TabularColumnRecord {
  const title = (input.title ?? input.name ?? "").trim();
  const format =
    input.format ?? formatForLegacyOutputType(input.outputType ?? "text");
  const outputType = input.outputType ?? legacyOutputTypeForFormat(format);
  const tags = format === "tag" ? (input.tags ?? input.enumValues ?? []) : [];
  const key =
    input.key ?? slugKey(title, `column_${input.index ?? ids.ordinal}`);
  return {
    id: ids.columnId,
    reviewId: ids.reviewId,
    key,
    title,
    outputType,
    format,
    prompt: input.prompt,
    enumValues: outputType === "enum" ? tags : null,
    tags,
    ordinal: input.index ?? ids.ordinal,
    legacyMetadata: {
      schema: "vera-tabular-column-v2",
      legacyOutputType: input.outputType ?? outputType,
      mikeFormat: format,
    },
  };
}

function validateCellContent(
  column: TabularColumnRecord,
  value: unknown,
): TabularCellContent {
  const parsed = normalizeTabularCellContent(value);
  if (parsed === null) {
    throw new WorkspaceApiError(
      400,
      "VALIDATION_ERROR",
      "A completed cell requires structured content.",
    );
  }
  const summary = redactText(parsed.summary);
  const content = {
    summary,
    ...(parsed.flag ? { flag: parsed.flag } : {}),
    ...(parsed.reasoning === undefined
      ? {}
      : { reasoning: redactText(parsed.reasoning) }),
  };
  if (column.outputType === "enum") {
    const normalized = summary.replace(/^\[\[|\]\]$/g, "");
    if (!column.tags.includes(normalized)) {
      throw new WorkspaceApiError(
        400,
        "VALIDATION_ERROR",
        "Tag cell value is not in the configured value set.",
      );
    }
    return { ...content, summary: normalized };
  }
  if (
    column.outputType === "number" &&
    Number.isNaN(Number(summary.replace(/,/g, "")))
  ) {
    throw new WorkspaceApiError(
      400,
      "VALIDATION_ERROR",
      "Number cell value must contain a number.",
    );
  }
  return content;
}

function sanitizeSourceRefs(
  value: unknown,
  documentId: string,
): TabularSourceRef[] {
  const refs = TabularSourceRefSchema.array().max(1_000).parse(value);
  return refs.map((ref) => {
    if (ref.documentId !== documentId) {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Cell source references must belong to the cell document.",
      );
    }
    return {
      ...ref,
      ...(ref.quote ? { quote: redactText(ref.quote) } : {}),
    };
  });
}

function assertDraftMatrix(
  columns: TabularColumnRecord[],
  documentIds: string[],
) {
  if (new Set(documentIds).size !== documentIds.length) {
    throw new WorkspaceApiError(
      400,
      "VALIDATION_ERROR",
      "Review document ids must be unique.",
    );
  }
  const columnKeys = columns.map((column) => column.key);
  if (new Set(columnKeys).size !== columnKeys.length) {
    throw new WorkspaceApiError(
      400,
      "VALIDATION_ERROR",
      "Review column keys must be unique.",
    );
  }
  const ordinals = columns.map((column) => column.ordinal);
  if (new Set(ordinals).size !== ordinals.length) {
    throw new WorkspaceApiError(
      400,
      "VALIDATION_ERROR",
      "Review column indexes must be unique.",
    );
  }
  if (documentIds.length * columns.length > MAX_TABULAR_MATRIX_CELLS) {
    throw new WorkspaceApiError(
      400,
      "VALIDATION_ERROR",
      `A tabular review cannot exceed ${MAX_TABULAR_MATRIX_CELLS} cells.`,
    );
  }
}

export class TabularService {
  constructor(
    private readonly repository: TabularRepository,
    private readonly jobs: JobEnqueuer,
    private readonly clock: () => Date = () => new Date(),
    private readonly idFactory: () => string = randomUUID,
  ) {}

  private now() {
    return this.clock().toISOString();
  }

  list(
    request: PageRequest & {
      projectId?: string;
      includeArchived?: boolean;
    } = {},
  ) {
    return this.repository.list(request);
  }

  get(id: string) {
    return this.repository.requireDetail(id);
  }

  create(value: unknown) {
    const input = CreateTabularDraftSchema.parse(value);
    const reviewId = this.idFactory();
    const columns = input.columns.map((column, ordinal) =>
      columnRecordFromInput(column, {
        reviewId,
        columnId: this.idFactory(),
        ordinal,
      }),
    );
    assertDraftMatrix(columns, input.documentIds);
    const documentProjectId = this.repository.documentProjectForDraft(
      input.documentIds,
    );
    const projectId = input.projectId ?? documentProjectId;
    if (
      documentProjectId !== null &&
      projectId !== null &&
      documentProjectId !== projectId
    ) {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Every review document must belong to the selected project.",
      );
    }
    const now = this.now();
    const cells = input.documentIds.flatMap((documentId) =>
      columns.map((column) => ({
        id: this.idFactory(),
        documentId,
        columnId: column.id,
        outputType: column.outputType,
      })),
    );
    return this.repository.create({
      id: reviewId,
      projectId,
      workflowId: input.workflowId ?? null,
      modelProfileId: input.modelProfileId ?? null,
      title: input.title,
      documentIds: input.documentIds,
      columns,
      cells,
      now,
    });
  }

  updateDraftMatrix(id: string, value: unknown) {
    const input = UpdateTabularDraftMatrixSchema.parse(value);
    const existing = this.repository.requireDetail(id);
    const columns = input.columns.map((column, ordinal) =>
      columnRecordFromInput(column, {
        reviewId: id,
        columnId: this.idFactory(),
        ordinal,
      }),
    );
    assertDraftMatrix(columns, input.documentIds);
    const documentProjectId = this.repository.documentProjectForDraft(
      input.documentIds,
    );
    const requestedProjectId =
      input.projectId === undefined
        ? existing.review.projectId
        : input.projectId;
    const projectId = requestedProjectId ?? documentProjectId;
    if (
      documentProjectId !== null &&
      projectId !== null &&
      documentProjectId !== projectId
    ) {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Every review document must belong to the selected project.",
      );
    }
    const now = this.now();
    return this.repository.replaceDraftMatrix({
      id,
      projectId,
      workflowId: existing.review.workflowId,
      modelProfileId: existing.review.modelProfileId,
      title: existing.review.title,
      documentIds: input.documentIds,
      columns,
      cells: input.documentIds.flatMap((documentId) =>
        columns.map((column) => ({
          id: this.idFactory(),
          documentId,
          columnId: column.id,
          outputType: column.outputType,
        })),
      ),
      now,
    });
  }

  update(id: string, value: unknown) {
    const input = UpdateTabularReviewRequestSchema.parse(value);
    if (input.status === "cancelled") {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Use cancelReview so active cell jobs are cancelled atomically.",
      );
    }
    const existing = this.repository.require(id);
    if (existing.status === "running" && input.status !== undefined) {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "A running review cannot change status.",
      );
    }
    return this.repository.update(id, { ...input, now: this.now() });
  }

  archive(id: string) {
    const review = this.repository.require(id);
    if (review.status === "running") {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Cancel the running review before archiving it.",
      );
    }
    return this.repository.archive(id, this.now());
  }

  delete(id: string) {
    this.repository.delete(id);
  }

  runReview(reviewId: string): {
    review: TabularReviewDetail;
    queued: number;
    skipped: number;
  } {
    const detail = this.repository.requireDetail(reviewId);
    if (["archived", "cancelled"].includes(detail.review.status)) {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Tabular review is not runnable.",
      );
    }
    if (detail.review.documentIds.length === 0 || detail.columns.length === 0) {
      throw new WorkspaceApiError(
        412,
        "PRECONDITION_FAILED",
        "Add at least one document and one column before running a tabular review.",
      );
    }
    const defaults = this.repository.workspaceDefaults();
    const projectId = detail.review.projectId ?? defaults.defaultProjectId;
    if (!projectId) {
      throw new WorkspaceApiError(
        412,
        "PRECONDITION_FAILED",
        "Review project is unavailable.",
      );
    }
    const project = this.repository.requireActiveProject(projectId);
    if (detail.review.workflowId) {
      this.repository.requireActiveTabularWorkflow(detail.review.workflowId);
    }
    void project;
    return failTabularGenerationDisabled();
  }

  startCell(cellId: string) {
    const cell = this.repository.requireCell(cellId);
    if (!cell.jobId) {
      throw new WorkspaceApiError(
        500,
        "INTERNAL_ERROR",
        "Tabular cell job is unavailable.",
      );
    }
    const now = this.now();
    return this.repository.startCell(cellId, now, () =>
      this.jobs.transitionInCurrentTransaction(cell.jobId!, {
        type: "start",
        at: now,
      }),
    );
  }

  completeCell(cellId: string, value: unknown, sourceRefs: unknown = []) {
    const cell = this.repository.requireCell(cellId);
    if (!cell.jobId) {
      throw new WorkspaceApiError(
        500,
        "INTERNAL_ERROR",
        "Tabular cell job is unavailable.",
      );
    }
    const detail = this.repository.requireDetail(cell.reviewId);
    const column = detail.columns.find((item) => item.id === cell.columnId);
    if (!column) {
      throw new WorkspaceApiError(
        500,
        "INTERNAL_ERROR",
        "Tabular column is unavailable.",
      );
    }
    const safeValue = validateCellContent(column, value);
    const safeRefs = sanitizeSourceRefs(sourceRefs, cell.documentId);
    const now = this.now();
    return this.repository.completeCell(cellId, safeValue, safeRefs, now, () =>
      this.jobs.transitionInCurrentTransaction(cell.jobId!, {
        type: "complete",
        at: now,
        result: { content: safeValue, sourceCount: safeRefs.length },
      }),
    );
  }

  failCell(cellId: string, error: unknown) {
    const cell = this.repository.requireCell(cellId);
    if (!cell.jobId) {
      throw new WorkspaceApiError(
        500,
        "INTERNAL_ERROR",
        "Tabular cell job is unavailable.",
      );
    }
    const safeError = sanitizeError(error);
    const now = this.now();
    return this.repository.failCell(cellId, safeError, now, () =>
      this.jobs.transitionInCurrentTransaction(cell.jobId!, {
        type: "fail",
        at: now,
        error: safeError,
      }),
    );
  }

  retryCell(cellId: string): TabularCellRecord {
    const cell = this.repository.requireCell(cellId);
    if (
      cell.status !== "failed" ||
      !cell.error?.retryable ||
      cell.attempt >= MAX_TABULAR_CELL_ATTEMPTS
    ) {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Tabular cell is not retryable.",
      );
    }
    const detail = this.repository.requireDetail(cell.reviewId);
    if (["archived", "cancelled"].includes(detail.review.status)) {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Tabular review is not retryable.",
      );
    }
    const defaults = this.repository.workspaceDefaults();
    const projectId = detail.review.projectId ?? defaults.defaultProjectId;
    if (!projectId) {
      throw new WorkspaceApiError(
        412,
        "PRECONDITION_FAILED",
        "Review project is unavailable.",
      );
    }
    const project = this.repository.requireActiveProject(projectId);
    if (detail.review.workflowId) {
      this.repository.requireActiveTabularWorkflow(detail.review.workflowId);
    }
    void project;
    return failTabularGenerationDisabled();
  }

  cancelReview(reviewId: string) {
    const now = this.now();
    return this.repository.cancelReview(reviewId, now, (jobIds) => {
      for (const jobId of jobIds) {
        const job = this.jobs.get(jobId);
        if (!job)
          throw new WorkspaceApiError(
            500,
            "INTERNAL_ERROR",
            "Cell job not found.",
          );
        if (job.status !== "queued" && job.status !== "running") {
          throw new WorkspaceApiError(
            409,
            "CONFLICT",
            "Cell and job terminal states are inconsistent.",
          );
        }
        this.jobs.transitionInCurrentTransaction(jobId, {
          type: "cancel",
          at: now,
          reason: "Tabular review cancelled by user.",
        });
      }
    });
  }
}
