import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

import type { MikeAssistantStreamEvent } from "../assistantCompatibility";
import { DOCUMENT_STUDIO_DRAFT_TYPES_V20 } from "../documentStudioDraftMetadataV20";
import type { TabularReviewDetail } from "../repositories/tabular";
import type { TabularStudioHandoffKind } from "../tabularStudioHandoff";
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

export type GeneralLegalTabularDraftInput = Readonly<{
  reviewId: string;
  kind: Exclude<TabularStudioHandoffKind, "contract_review_memo">;
  documentId: string;
  versionId: string;
  operationId: string;
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
  createDraftFromTabularReview: (
    context: AssistantToolContext,
    input: GeneralLegalTabularDraftInput,
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

function hasTimelineColumnSnapshot(detail: TabularReviewDetail) {
  const persisted = [...detail.columns]
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((column) => ({
      ordinal: column.ordinal,
      key: column.key,
      name: column.title,
      instruction: column.prompt,
      outputType: column.outputType,
    }));
  const timeline = normalizeColumns(TIMELINE_COLUMNS).map(
    (column, ordinal) => ({
      ordinal,
      key: column.key,
      name: column.name,
      instruction: column.instruction,
      outputType: column.outputType,
    }),
  );
  return isDeepStrictEqual(persisted, timeline);
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
    if (binding) this.assertBinding(detail, binding);
    if (detail.review.workflowId !== null) {
      throw new AssistantGeneralLegalToolError(
        "A memo can only be created from a completed Assistant custom extraction or timeline Review.",
      );
    }
    const timeline =
      binding?.kind === "custom_extraction"
        ? false
        : hasTimelineColumnSnapshot(detail);
    if (!binding && !timeline) {
      throw new AssistantGeneralLegalToolError(
        "Cannot safely determine this Review's extraction preset. Re-run the custom extraction or timeline before creating a memo.",
      );
    }
    if (binding?.kind === "timeline" && !timeline) {
      throw new AssistantGeneralLegalToolError(
        "The persisted Review columns no longer match the timeline preset.",
      );
    }
    const title =
      input.title ??
      (timeline
        ? `${detail.review.title} — 案件事实摘要`
        : `${detail.review.title} Memo`);
    const operationId = `assistant-review-memo:${deterministicUuid(JSON.stringify([context.jobId, input.review_id, title]))}`;
    const result = await this.options.createDraftFromTabularReview(context, {
      reviewId: input.review_id,
      kind: timeline ? "case_fact_summary" : "custom_extraction_summary",
      documentId: deterministicUuid(`${operationId}:document`),
      versionId: deterministicUuid(`${operationId}:version`),
      operationId,
      title,
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
