import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

import type { MikeAssistantStreamEvent } from "../assistantCompatibility";
import { DOCUMENT_STUDIO_DRAFT_TYPES_V20 } from "../documentStudioDraftMetadataV20";
import type { TabularReviewDetail } from "../repositories/tabular";
import type {
  AssistantModelToolCall,
  AssistantToolContext,
  AssistantToolDefinition,
  AssistantToolExecutionResult,
  AssistantToolLifecycleInput,
  AssistantToolLifecycleResult,
} from "./assistantRuntime";
import type { AssistantToolModule } from "./assistantToolRegistry";

export const ASSISTANT_GENERAL_LEGAL_TOOL_MODULE_ID =
  "workspace-general-legal-tools";
export const ASSISTANT_GENERAL_LEGAL_TOOL_ADAPTER_ID =
  "vera-local-general-legal-tools-v1";

const MIN_DOCUMENTS = 2;
const MAX_DOCUMENTS = 50;
const MAX_COLUMNS = 15;
const MAX_MEMO_CHARS = 90_000;
const MAX_TRACKED_GENERATIONS = 256;
const DEFAULT_MAX_WAIT_MS = 15 * 60_000;
const DEFAULT_INITIAL_POLL_MS = 50;
const DEFAULT_MAX_POLL_MS = 1_000;

const ColumnFormat = z.enum(["text", "date", "number", "boolean"]);
const ExtractionColumn = z
  .object({
    name: z.string().trim().min(1).max(120),
    instruction: z.string().trim().min(1).max(4_000),
    format: ColumnFormat.default("text"),
  })
  .strict();
const ExtractionColumns = z
  .array(ExtractionColumn)
  .min(1)
  .max(MAX_COLUMNS)
  .superRefine((columns, context) => {
    const names = columns.map((column) => column.name.toLocaleLowerCase());
    if (new Set(names).size !== names.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Extraction column names must be unique.",
      });
    }
  });
const CanonicalCustomExtractionInput = z
  .object({
    mode: z.literal("custom"),
    title: z.string().trim().min(1).max(240),
    columns: ExtractionColumns,
  })
  .strict();
const CanonicalTimelineInput = z
  .object({
    mode: z.literal("timeline"),
    title: z.string().trim().min(1).max(240).optional(),
  })
  .strict();
const LegacyCustomExtractionInput = z
  .object({
    title: z.string().trim().min(1).max(240),
    columns: ExtractionColumns,
  })
  .strict();
const LegacyTimelineInput = z
  .object({
    preset: z.literal("timeline"),
    title: z.string().trim().min(1).max(240).optional(),
  })
  .strict();
const RunExtractionInput = z
  .union([
    CanonicalCustomExtractionInput,
    CanonicalTimelineInput,
    LegacyCustomExtractionInput,
    LegacyTimelineInput,
  ])
  .transform((input) => {
    if ("mode" in input) return input;
    if ("preset" in input) {
      return { mode: "timeline" as const, title: input.title };
    }
    return {
      mode: "custom" as const,
      title: input.title,
      columns: input.columns,
    };
  });
const CreateMemoInput = z
  .object({
    title: z.string().trim().min(1).max(240),
    documentType: z
      .enum(DOCUMENT_STUDIO_DRAFT_TYPES_V20)
      .default("general_legal_document"),
    contentMarkdown: z.string().trim().min(1).max(MAX_MEMO_CHARS),
  })
  .strict();
const MemoFromReviewInput = z
  .object({
    review_id: z.string().uuid(),
    title: z.string().trim().min(1).max(240).optional(),
  })
  .strict();

type ExtractionColumnInput = z.infer<typeof ExtractionColumn>;
type DocumentSnapshot = Readonly<{ documentId: string; versionId: string }>;
type NormalizedColumn = ExtractionColumnInput &
  Readonly<{
    key: string;
    outputType: "text" | "number" | "boolean";
  }>;
type ReviewBinding = Readonly<{
  kind: "custom_extraction" | "timeline";
  reviewId: string;
  projectId: string;
  modelProfileId: string;
  title: string;
  documents: readonly DocumentSnapshot[];
  columns: readonly NormalizedColumn[];
}>;
type GenerationState = {
  context: AssistantToolContext;
  reviews: Map<string, ReviewBinding>;
  calls: Map<string, ReviewBinding>;
  settledReviewIds: Set<string>;
  emittedReviewIds: Set<string>;
  emittedDraftIds: Set<string>;
  cancellations: Map<string, () => void>;
};

export interface AssistantGeneralLegalTabularPort {
  get(id: string): TabularReviewDetail;
  createPresetReviewWithId(id: string, value: unknown): TabularReviewDetail;
  runReview(id: string): { review: TabularReviewDetail };
  cancelReview(id: string): TabularReviewDetail;
}

export type GeneralLegalDraftInput = Readonly<{
  documentId: string;
  versionId: string;
  operationId: string;
  title: string;
  content: string;
  documentType: (typeof DOCUMENT_STUDIO_DRAFT_TYPES_V20)[number];
}>;

export type GeneralLegalDraftResult = Readonly<{
  documentId: string;
  versionId: string;
  title: string;
}>;

export type AssistantGeneralLegalToolsOptions = Readonly<{
  assertCurrentDocuments: (
    projectId: string,
    documents: readonly DocumentSnapshot[],
  ) => void;
  createDraft: (
    context: AssistantToolContext,
    input: GeneralLegalDraftInput,
  ) => Promise<GeneralLegalDraftResult>;
  available?: () => boolean;
  maxWaitMs?: number;
  initialPollMs?: number;
  maxPollMs?: number;
  delay?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}>;

export class AssistantGeneralLegalToolError extends Error {
  readonly code = "assistant_tool_failed";
  readonly retryable = false;
  readonly details = null;

  constructor(
    message = "Assistant general legal tool rejected the operation.",
  ) {
    super(message);
    this.name = "AssistantGeneralLegalToolError";
  }
}

const TIMELINE_COLUMNS: readonly ExtractionColumnInput[] = Object.freeze([
  {
    name: "Date",
    instruction:
      "Extract the exact event date or date range; preserve the source wording when it is uncertain.",
    format: "date",
  },
  {
    name: "Event",
    instruction: "State the material event concisely and neutrally.",
    format: "text",
  },
  {
    name: "Participants",
    instruction:
      "Identify the people, entities, courts, or authorities involved.",
    format: "text",
  },
  {
    name: "Source file",
    instruction: "Identify the source document for the event.",
    format: "text",
  },
  {
    name: "Original evidence",
    instruction: "Provide the supporting source language or state Not found.",
    format: "text",
  },
  {
    name: "Potential significance",
    instruction:
      "State the possible legal or procedural significance without overstating certainty.",
    format: "text",
  },
  {
    name: "Open questions",
    instruction:
      "List facts or dates that still require confirmation; otherwise state None identified.",
    format: "text",
  },
]);

function toolDefinition(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: readonly string[],
): AssistantToolDefinition {
  return {
    name: name as AssistantToolDefinition["name"],
    description,
    inputSchema: {
      type: "object",
      properties,
      required: [...required],
      additionalProperties: false,
    },
  };
}

const COLUMN_SCHEMA = Object.freeze({
  type: "object",
  properties: Object.freeze({
    name: Object.freeze({ type: "string", minLength: 1, maxLength: 120 }),
    instruction: Object.freeze({
      type: "string",
      minLength: 1,
      maxLength: 4_000,
    }),
    format: Object.freeze({
      type: "string",
      enum: Object.freeze(["text", "date", "number", "boolean"]),
    }),
  }),
  required: Object.freeze(["name", "instruction"]),
  additionalProperties: false,
});

const TITLE_SCHEMA = Object.freeze({
  type: "string",
  minLength: 1,
  maxLength: 240,
});

const CUSTOM_EXTRACTION_SCHEMA = Object.freeze({
  type: "object",
  properties: Object.freeze({
    mode: Object.freeze({ type: "string", enum: Object.freeze(["custom"]) }),
    title: TITLE_SCHEMA,
    columns: Object.freeze({
      type: "array",
      minItems: 1,
      maxItems: MAX_COLUMNS,
      items: COLUMN_SCHEMA,
    }),
  }),
  required: Object.freeze(["mode", "title", "columns"]),
  additionalProperties: false,
});

const TIMELINE_EXTRACTION_SCHEMA = Object.freeze({
  type: "object",
  properties: Object.freeze({
    mode: Object.freeze({
      type: "string",
      enum: Object.freeze(["timeline"]),
    }),
    title: TITLE_SCHEMA,
  }),
  required: Object.freeze(["mode"]),
  additionalProperties: false,
});

const TOOLS = Object.freeze([
  {
    name: "run_custom_extraction" as const,
    description:
      "Create and run a durable Tabular Review over the attached Matter documents. Use mode=custom with a title and 1-15 custom columns, or mode=timeline for the timeline preset. The runtime waits for terminal completion; do not poll or create a duplicate Review.",
    inputSchema: {
      type: "object",
      oneOf: [CUSTOM_EXTRACTION_SCHEMA, TIMELINE_EXTRACTION_SCHEMA],
    },
  },
  toolDefinition(
    "create_legal_memo",
    "Create a new, non-overwriting Studio legal memo from Markdown already prepared from the evidence read in this run. The returned Draft can be exported as DOCX.",
    {
      title: { type: "string", minLength: 1, maxLength: 240 },
      documentType: {
        type: "string",
        enum: [...DOCUMENT_STUDIO_DRAFT_TYPES_V20],
      },
      contentMarkdown: {
        type: "string",
        minLength: 1,
        maxLength: MAX_MEMO_CHARS,
      },
    },
    ["title", "contentMarkdown"],
  ),
  toolDefinition(
    "create_memo_from_tabular_review",
    "Create a new Studio memo containing the real structured results of a completed Tabular Review. Use this after custom extraction or the timeline preset; the returned Draft can be exported as DOCX.",
    {
      review_id: { type: "string", format: "uuid" },
      title: { type: "string", minLength: 1, maxLength: 240 },
    },
    ["review_id"],
  ),
]);

function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.output<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new AssistantGeneralLegalToolError(
      "Assistant tool input is invalid.",
    );
  }
  return parsed.data as z.output<T>;
}

function deterministicUuid(material: string) {
  const bytes = Buffer.from(
    createHash("sha256").update(material).digest().subarray(0, 16),
  );
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function generationKey(context: AssistantToolContext) {
  return `${context.jobId}\0${context.attempt}`;
}

function reviewRoute(projectId: string, reviewId: string) {
  return `/projects/${projectId}/tabular-reviews/${reviewId}`;
}

function draftRoute(projectId: string, documentId: string) {
  return `/projects/${projectId}/documents/${documentId}/studio`;
}

function terminal(status: TabularReviewDetail["review"]["status"]) {
  return ["complete", "failed", "cancelled", "archived"].includes(status);
}

function throwIfAborted(signal: AbortSignal) {
  if (!signal.aborted) return;
  const error = new Error("Assistant general legal operation was cancelled.");
  error.name = "AbortError";
  throw error;
}

function attachedDocuments(context: AssistantToolContext) {
  if (!context.projectId) {
    throw new AssistantGeneralLegalToolError("This tool requires a Matter.");
  }
  const documents = context.documents
    .filter((document) => document.attached)
    .map(({ documentId, versionId }) => ({ documentId, versionId }))
    .sort(
      (left, right) =>
        left.documentId.localeCompare(right.documentId) ||
        left.versionId.localeCompare(right.versionId),
    );
  if (
    documents.length < MIN_DOCUMENTS ||
    documents.length > MAX_DOCUMENTS ||
    new Set(documents.map((document) => document.documentId)).size !==
      documents.length
  ) {
    throw new AssistantGeneralLegalToolError(
      `Attach between ${MIN_DOCUMENTS} and ${MAX_DOCUMENTS} unique current Matter documents.`,
    );
  }
  return documents;
}

function normalizedKey(name: string, index: number) {
  const ascii = name
    .normalize("NFKD")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 56);
  return `${ascii || "column"}_${index + 1}`;
}

function normalizeColumns(columns: readonly ExtractionColumnInput[]) {
  return columns.map(
    (column, index): NormalizedColumn => ({
      ...column,
      key: normalizedKey(column.name, index),
      outputType:
        column.format === "number"
          ? "number"
          : column.format === "boolean"
            ? "boolean"
            : "text",
    }),
  );
}

function reviewBinding(
  context: AssistantToolContext,
  input: z.infer<typeof RunExtractionInput>,
): ReviewBinding {
  const documents = attachedDocuments(context);
  const timeline = input.mode === "timeline";
  const title = timeline ? (input.title ?? "Matter Timeline") : input.title;
  const columns = normalizeColumns(timeline ? TIMELINE_COLUMNS : input.columns);
  const material = {
    schema: "vera-assistant-general-extraction-v1",
    kind: timeline ? "timeline" : "custom_extraction",
    projectId: context.projectId!,
    modelProfileId: context.modelProfileId,
    title,
    documents,
    columns,
  } as const;
  return {
    kind: material.kind,
    reviewId: deterministicUuid(JSON.stringify([context.jobId, material])),
    projectId: material.projectId,
    modelProfileId: material.modelProfileId,
    title,
    documents,
    columns,
  };
}

function cellText(cell: TabularReviewDetail["cells"][number] | undefined) {
  if (!cell) return "Not found";
  if (cell.content?.summary.trim()) return cell.content.summary.trim();
  if (typeof cell.value === "string" && cell.value.trim())
    return cell.value.trim();
  if (typeof cell.value === "number" || typeof cell.value === "boolean") {
    return String(cell.value);
  }
  return "Not found";
}

function escapeTableCell(value: string) {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>").slice(0, 2_000);
}

function memoText(value: string) {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 2_000);
}

function missingMemoValue(value: string) {
  return /^(?:not found|none identified|unknown|n\/a|未发现|未找到|无|未知)$/iu.test(
    value.trim(),
  );
}

function timelineFactSummaryContent(
  detail: TabularReviewDetail,
  title: string,
  projectId: string,
) {
  const columnIds = new Map(
    detail.columns.map((column) => [
      column.title.toLocaleLowerCase(),
      column.id,
    ]),
  );
  const valueFor = (documentId: string, title: string) => {
    const columnId = columnIds.get(title.toLocaleLowerCase());
    return memoText(
      cellText(
        columnId
          ? detail.cells.find(
              (cell) =>
                cell.documentId === documentId && cell.columnId === columnId,
            )
          : undefined,
      ),
    );
  };
  const rows = detail.review.documentIds.map((documentId, index) => ({
    documentId,
    sourceNumber: index + 1,
    date: valueFor(documentId, "Date"),
    event: valueFor(documentId, "Event"),
    participants: valueFor(documentId, "Participants"),
    source: valueFor(documentId, "Source file"),
    evidence: valueFor(documentId, "Original evidence"),
    significance: valueFor(documentId, "Potential significance"),
    questions: valueFor(documentId, "Open questions"),
  }));
  const sourceLabel = (row: (typeof rows)[number]) =>
    missingMemoValue(row.source) ? `来源材料 ${row.sourceNumber}` : row.source;
  const eventRows = rows.filter((row) => !missingMemoValue(row.event));
  const participantValues = [
    ...new Map(
      rows
        .filter((row) => !missingMemoValue(row.participants))
        .map((row) => [row.participants.toLocaleLowerCase(), row.participants]),
    ).values(),
  ];
  const supportedFacts = eventRows.filter(
    (row) => !missingMemoValue(row.evidence),
  );
  const gaps = eventRows.flatMap((row) => {
    const items: string[] = [];
    if (missingMemoValue(row.date)) {
      items.push(`事件缺少明确日期：${row.event}（${sourceLabel(row)}）`);
    }
    if (missingMemoValue(row.evidence)) {
      items.push(`事件缺少可用原文依据：${row.event}（${sourceLabel(row)}）`);
    }
    return items;
  });
  const incompleteRows = rows.filter((row) => missingMemoValue(row.event));
  const incompleteCells = detail.cells.filter((cell) =>
    ["failed", "cancelled"].includes(cell.status),
  );
  const confirmationItems = rows
    .filter((row) => !missingMemoValue(row.questions))
    .map(
      (row) =>
        `${row.questions}（${missingMemoValue(row.event) ? sourceLabel(row) : row.event}）`,
    );
  const bullets = (items: readonly string[], empty: string) =>
    items.length > 0 ? items.map((item) => `- ${item}`) : [`- ${empty}`];
  const timeline = eventRows.map((row) => {
    const date = missingMemoValue(row.date) ? "日期未发现" : row.date;
    const significance = missingMemoValue(row.significance)
      ? ""
      : `；可能意义：${row.significance}`;
    return `- **${date}** — ${row.event}（${sourceLabel(row)}${significance}）`;
  });
  const facts = supportedFacts.map(
    (row) => `- ${row.event}（${sourceLabel(row)}；原文依据：${row.evidence}）`,
  );
  const missing = [
    ...incompleteRows.map((row) => `${sourceLabel(row)}未提取到明确事件。`),
    ...(incompleteCells.length > 0
      ? [`有 ${incompleteCells.length} 个提取单元未成功完成。`]
      : []),
  ];
  const lines = [
    `# ${title}`,
    "",
    `本摘要仅整理已完成结构化 Review [${detail.review.title}](${reviewRoute(projectId, detail.review.id)}) 中持久化的单元结果，不补充或推测材料外事实。`,
    "",
    "## 材料范围",
    "",
    `- Review 材料数：${detail.review.documentIds.length}`,
    `- 已完成提取单元：${detail.cells.filter((cell) => cell.status === "complete").length}/${detail.cells.length}`,
    "",
    "## 核心时间线",
    "",
    ...bullets(timeline, "未从 Review 中提取到明确事件。"),
    "",
    "## 主要参与方",
    "",
    ...bullets(participantValues, "未发现明确参与方。"),
    "",
    "## 已明确事实",
    "",
    ...bullets(facts, "未发现同时具有明确事件和原文依据的记录。"),
    "",
    "## 存在矛盾或材料缺口",
    "",
    "- 本摘要不自动推断材料之间是否矛盾；以下仅列示 Review 中可直接识别的缺口。",
    ...bullets(gaps, "未识别到缺少日期或原文依据的事件。"),
    "",
    "## 缺失材料",
    "",
    ...bullets(missing, "Review 未标记具体缺失材料。"),
    "",
    "## 待律师确认事项",
    "",
    ...bullets(confirmationItems, "Review 未提取到明确待确认事项。"),
    "",
    "请在对外使用前回到 Review 和源文件核对日期、原文及材料完整性。",
  ];
  return lines.join("\n").slice(0, MAX_MEMO_CHARS);
}

function reviewMemoContent(
  detail: TabularReviewDetail,
  title: string,
  projectId: string,
) {
  const columns = [...detail.columns].sort(
    (left, right) => left.ordinal - right.ordinal,
  );
  const lines = [
    `# ${title}`,
    "",
    `This memo summarizes the completed structured review [${detail.review.title}](${reviewRoute(projectId, detail.review.id)}).`,
    "",
    `| Source document | ${columns.map((column) => escapeTableCell(column.title)).join(" | ")} |`,
    `| --- | ${columns.map(() => "---").join(" | ")} |`,
  ];
  let omitted = 0;
  detail.review.documentIds.forEach((documentId, documentIndex) => {
    const row = [
      `Source document ${documentIndex + 1}`,
      ...columns.map((column) =>
        escapeTableCell(
          cellText(
            detail.cells.find(
              (cell) =>
                cell.documentId === documentId && cell.columnId === column.id,
            ),
          ),
        ),
      ),
    ];
    const line = `| ${row.join(" | ")} |`;
    if (lines.join("\n").length + line.length <= MAX_MEMO_CHARS - 500) {
      lines.push(line);
    } else {
      omitted += 1;
    }
  });
  if (omitted > 0) {
    lines.push(
      "",
      `_${omitted} additional source-document rows remain available in the linked Review._`,
    );
  }
  lines.push(
    "",
    "## Follow-up",
    "",
    "Confirm material gaps and conclusions against the linked Review and source documents before relying on this memo.",
  );
  return lines.join("\n");
}

export class WorkspaceAssistantGeneralLegalToolModule implements AssistantToolModule {
  readonly id = ASSISTANT_GENERAL_LEGAL_TOOL_MODULE_ID;
  readonly adapterId = ASSISTANT_GENERAL_LEGAL_TOOL_ADAPTER_ID;
  private readonly generations = new Map<string, GenerationState>();
  private readonly highestAttempts = new Map<string, number>();
  private readonly maxWaitMs: number;
  private readonly initialPollMs: number;
  private readonly maxPollMs: number;
  private readonly delay: (
    milliseconds: number,
    signal: AbortSignal,
  ) => Promise<void>;

  constructor(
    private readonly tabular: () => AssistantGeneralLegalTabularPort,
    private readonly options: AssistantGeneralLegalToolsOptions,
  ) {
    this.maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
    this.initialPollMs = options.initialPollMs ?? DEFAULT_INITIAL_POLL_MS;
    this.maxPollMs = options.maxPollMs ?? DEFAULT_MAX_POLL_MS;
    this.delay =
      options.delay ??
      ((milliseconds, signal) =>
        new Promise<void>((resolve, reject) => {
          if (signal.aborted) {
            const error = new Error(
              "Assistant general legal operation was cancelled.",
            );
            error.name = "AbortError";
            reject(error);
            return;
          }
          const timeout = setTimeout(resolve, milliseconds);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timeout);
              const error = new Error(
                "Assistant general legal operation was cancelled.",
              );
              error.name = "AbortError";
              reject(error);
            },
            { once: true },
          );
        }));
  }

  private key(context: AssistantToolContext) {
    return generationKey(context);
  }

  async registeredTools(context: AssistantToolContext) {
    if (!context.projectId || this.options.available?.() === false) return [];
    const highest = this.highestAttempts.get(context.jobId);
    if (highest !== undefined && context.attempt < highest) {
      throw new AssistantGeneralLegalToolError(
        "General legal tool registration is older than the current job attempt.",
      );
    }
    this.highestAttempts.delete(context.jobId);
    this.highestAttempts.set(context.jobId, context.attempt);
    for (const [key, state] of this.generations) {
      if (state.context.jobId !== context.jobId) continue;
      for (const release of state.cancellations.values()) release();
      this.generations.delete(key);
    }
    this.generations.set(this.key(context), {
      context,
      reviews: new Map(),
      calls: new Map(),
      settledReviewIds: new Set(),
      emittedReviewIds: new Set(),
      emittedDraftIds: new Set(),
      cancellations: new Map(),
    });
    while (this.generations.size > MAX_TRACKED_GENERATIONS) {
      const key = this.generations.keys().next().value as string | undefined;
      if (!key) break;
      this.generations.delete(key);
    }
    while (this.highestAttempts.size > MAX_TRACKED_GENERATIONS) {
      const key = this.highestAttempts.keys().next().value as
        | string
        | undefined;
      if (!key) break;
      this.highestAttempts.delete(key);
    }
    return TOOLS;
  }

  private generation(context: AssistantToolContext) {
    const state = this.generations.get(this.key(context));
    if (
      !state ||
      state.context.chatId !== context.chatId ||
      state.context.projectId !== context.projectId ||
      state.context.modelProfileId !== context.modelProfileId ||
      !isDeepStrictEqual(state.context.documents, context.documents)
    ) {
      throw new AssistantGeneralLegalToolError(
        "General legal tools are not registered for this job attempt.",
      );
    }
    return state;
  }

  private assertBinding(detail: TabularReviewDetail, binding: ReviewBinding) {
    const columns = [...detail.columns]
      .sort((left, right) => left.ordinal - right.ordinal)
      .map((column) => ({
        key: column.key,
        name: column.title,
        instruction: column.prompt,
        outputType: column.outputType,
      }));
    const expectedColumns = binding.columns.map((column) => ({
      key: column.key,
      name: column.name,
      instruction: column.instruction,
      outputType: column.outputType,
    }));
    if (
      detail.review.id !== binding.reviewId ||
      detail.review.projectId !== binding.projectId ||
      detail.review.modelProfileId !== binding.modelProfileId ||
      detail.review.title !== binding.title ||
      detail.review.workflowId !== null ||
      !isDeepStrictEqual(
        detail.review.documentIds,
        binding.documents.map((item) => item.documentId),
      ) ||
      !isDeepStrictEqual(columns, expectedColumns)
    ) {
      throw new AssistantGeneralLegalToolError(
        "Extraction Review does not match this Assistant generation.",
      );
    }
    this.options.assertCurrentDocuments(binding.projectId, binding.documents);
  }

  private reviewEvent(state: GenerationState, binding: ReviewBinding) {
    if (state.emittedReviewIds.has(binding.reviewId)) return [];
    state.emittedReviewIds.add(binding.reviewId);
    return [
      {
        type: "tabular_review_created",
        review_id: binding.reviewId,
        title: binding.title,
        route: reviewRoute(binding.projectId, binding.reviewId),
        document_count: binding.documents.length,
      } satisfies MikeAssistantStreamEvent,
    ];
  }

  private reviewResult(
    detail: TabularReviewDetail,
    binding: ReviewBinding,
    events: readonly MikeAssistantStreamEvent[] = [],
  ): AssistantToolExecutionResult {
    const progress = detail.cells.reduce(
      (counts, cell) => {
        if (cell.status === "complete") counts.complete += 1;
        if (cell.status === "failed") counts.failed += 1;
        if (cell.status === "cancelled") counts.cancelled += 1;
        return counts;
      },
      { total: detail.cells.length, complete: 0, failed: 0, cancelled: 0 },
    );
    return {
      content: JSON.stringify({
        schema_version: "vera-assistant-general-extraction-v1",
        kind: binding.kind,
        review: {
          review_id: binding.reviewId,
          title: binding.title,
          status: detail.review.status,
          terminal: terminal(detail.review.status),
          route: reviewRoute(binding.projectId, binding.reviewId),
          document_count: binding.documents.length,
          progress,
        },
        asynchronous: !terminal(detail.review.status),
        instruction: terminal(detail.review.status)
          ? "Use the Review route to inspect results and export XLSX."
          : "The runtime is still waiting for this exact Review; do not create a duplicate.",
      }),
      ...(events.length > 0 ? { events } : {}),
    };
  }

  private retainCancellation(
    state: GenerationState,
    binding: ReviewBinding,
    signal: AbortSignal,
  ) {
    state.cancellations.get(binding.reviewId)?.();
    const cancel = () => {
      signal.removeEventListener("abort", onAbort);
      state.cancellations.delete(binding.reviewId);
    };
    const onAbort = () => {
      try {
        const detail = this.tabular().get(binding.reviewId);
        if (!terminal(detail.review.status))
          this.tabular().cancelReview(binding.reviewId);
      } finally {
        cancel();
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    state.cancellations.set(binding.reviewId, cancel);
  }

  private async startExtraction(
    context: AssistantToolContext,
    callId: string,
    input: z.infer<typeof RunExtractionInput>,
    signal: AbortSignal,
  ) {
    const state = this.generation(context);
    const binding = reviewBinding(context, input);
    this.options.assertCurrentDocuments(binding.projectId, binding.documents);
    let detail: TabularReviewDetail;
    try {
      detail = this.tabular().get(binding.reviewId);
      this.assertBinding(detail, binding);
    } catch {
      try {
        detail = this.tabular().createPresetReviewWithId(binding.reviewId, {
          projectId: binding.projectId,
          workflowId: null,
          title: binding.title,
          documentIds: binding.documents.map((item) => item.documentId),
          modelProfileId: binding.modelProfileId,
          columns: binding.columns.map((column) => ({
            key: column.key,
            title: column.name,
            prompt: column.instruction,
            outputType: column.outputType,
          })),
        });
      } catch {
        detail = this.tabular().get(binding.reviewId);
        this.assertBinding(detail, binding);
      }
    }
    state.reviews.set(binding.reviewId, binding);
    state.calls.set(callId, binding);
    if (!terminal(detail.review.status))
      detail = this.tabular().runReview(binding.reviewId).review;
    if (!terminal(detail.review.status))
      this.retainCancellation(state, binding, signal);
    return this.reviewResult(detail, binding, this.reviewEvent(state, binding));
  }

  private draftResult(
    state: GenerationState,
    projectId: string,
    result: GeneralLegalDraftResult,
  ): AssistantToolExecutionResult {
    const events: MikeAssistantStreamEvent[] = [];
    if (!state.emittedDraftIds.has(result.documentId)) {
      state.emittedDraftIds.add(result.documentId);
      events.push({
        type: "draft_created",
        draft_id: result.documentId,
        version_id: result.versionId,
        title: result.title,
        route: draftRoute(projectId, result.documentId),
      });
    }
    return {
      content: JSON.stringify({
        schema_version: "vera-assistant-general-legal-memo-v1",
        memo: {
          draft_id: result.documentId,
          version_id: result.versionId,
          title: result.title,
          route: draftRoute(projectId, result.documentId),
        },
        asynchronous: false,
      }),
      events,
    };
  }

  private async createMemo(context: AssistantToolContext, value: unknown) {
    const state = this.generation(context);
    const input = parse(CreateMemoInput, value);
    const operationId = `assistant-legal-memo:${deterministicUuid(JSON.stringify([context.jobId, input]))}`;
    const result = await this.options.createDraft(context, {
      documentId: deterministicUuid(`${operationId}:document`),
      versionId: deterministicUuid(`${operationId}:version`),
      operationId,
      title: input.title,
      content: input.contentMarkdown,
      documentType: input.documentType ?? "general_legal_document",
    });
    return this.draftResult(state, context.projectId!, result);
  }

  private async memoFromReview(context: AssistantToolContext, value: unknown) {
    const state = this.generation(context);
    const input = parse(MemoFromReviewInput, value);
    const detail = this.tabular().get(input.review_id);
    if (
      detail.review.projectId !== context.projectId ||
      detail.review.status !== "complete"
    ) {
      throw new AssistantGeneralLegalToolError(
        "A memo requires a completed Tabular Review in this Matter.",
      );
    }
    const attached = attachedDocuments(context);
    this.options.assertCurrentDocuments(context.projectId!, attached);
    if (
      !isDeepStrictEqual(
        detail.review.documentIds,
        attached.map((item) => item.documentId),
      )
    ) {
      throw new AssistantGeneralLegalToolError(
        "The Review does not match the attached current documents.",
      );
    }
    const binding = state.reviews.get(input.review_id);
    const timeline = binding?.kind === "timeline";
    const title =
      input.title ??
      (timeline
        ? `${detail.review.title} — 案件事实摘要`
        : `${detail.review.title} Memo`);
    const operationId = `assistant-review-memo:${deterministicUuid(JSON.stringify([context.jobId, input.review_id, title]))}`;
    const result = await this.options.createDraft(context, {
      documentId: deterministicUuid(`${operationId}:document`),
      versionId: deterministicUuid(`${operationId}:version`),
      operationId,
      title,
      content: timeline
        ? timelineFactSummaryContent(detail, title, context.projectId!)
        : reviewMemoContent(detail, title, context.projectId!),
      documentType: "general_legal_document",
    });
    return this.draftResult(state, context.projectId!, result);
  }

  async execute(input: {
    context: AssistantToolContext;
    call: AssistantModelToolCall;
    signal: AbortSignal;
  }): Promise<AssistantToolExecutionResult> {
    throwIfAborted(input.signal);
    switch (input.call.name as string) {
      case "run_custom_extraction":
        return this.startExtraction(
          input.context,
          input.call.id,
          parse(RunExtractionInput, input.call.input),
          input.signal,
        );
      case "create_legal_memo":
        return this.createMemo(input.context, input.call.input);
      case "create_memo_from_tabular_review":
        return this.memoFromReview(input.context, input.call.input);
      default:
        throw new AssistantGeneralLegalToolError(
          "Unsupported general legal Assistant tool.",
        );
    }
  }

  private async waitForTerminal(reviewId: string, signal: AbortSignal) {
    let detail = this.tabular().get(reviewId);
    const deadline = Date.now() + this.maxWaitMs;
    let pollMs = this.initialPollMs;
    while (!terminal(detail.review.status)) {
      throwIfAborted(signal);
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new AssistantGeneralLegalToolError(
          "The extraction Review did not finish within the runtime wait limit.",
        );
      }
      await this.delay(Math.min(pollMs, remainingMs), signal);
      detail = this.tabular().get(reviewId);
      pollMs = Math.min(this.maxPollMs, pollMs * 2);
    }
    return detail;
  }

  async settleLifecycle(
    input: AssistantToolLifecycleInput,
  ): Promise<AssistantToolLifecycleResult | null> {
    if (input.phase === "after_execution") {
      if ((input.call.name as string) !== "run_custom_extraction") return null;
      const state = this.generation(input.context);
      const binding = state.calls.get(input.call.id);
      if (!binding) return null;
      const detail = await this.waitForTerminal(binding.reviewId, input.signal);
      this.assertBinding(detail, binding);
      state.cancellations.get(binding.reviewId)?.();
      state.settledReviewIds.add(binding.reviewId);
      return {
        replacementContent: this.reviewResult(detail, binding).content,
      };
    }
    const state = this.generation(input.context);
    const events: MikeAssistantStreamEvent[] = [];
    for (const binding of state.reviews.values()) {
      if (state.settledReviewIds.has(binding.reviewId)) continue;
      const detail = await this.waitForTerminal(binding.reviewId, input.signal);
      this.assertBinding(detail, binding);
      state.cancellations.get(binding.reviewId)?.();
      state.settledReviewIds.add(binding.reviewId);
      events.push(...this.reviewEvent(state, binding));
    }
    return events.length > 0 ? { events } : null;
  }
}
