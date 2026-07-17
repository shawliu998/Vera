import { randomUUID } from "node:crypto";
import { z } from "zod";

import {
  MikeAssistantStreamEventSchema,
  type MikeAssistantStreamEvent,
} from "../assistantCompatibility";
import { WorkspaceApiError } from "../errors";
import { assertMikeSafePayload } from "../mikeCompatibility";
import type {
  AssistantClaimIdentity,
  AssistantClaimTransactionPort,
  AssistantConversationMessage,
  AssistantGenerationSnapshot,
  AssistantSourceWrite,
  ChatsRepository,
} from "../repositories/chats";
import { WorkspaceJobLeaseLostError } from "../repositories/jobs";
import type { AssistantRetrievalChunk } from "../repositories/assistantRetrieval";
import type { InferenceOperation } from "../inferencePolicy";

const Id = z.string().uuid();
const MAX_TOOL_ROUNDS = 10;
const MAX_TOOL_CALLS_PER_ROUND = 16;
const MAX_TOTAL_TOOL_CALLS = 32;
const MAX_CONSECUTIVE_TOOL_FAILURES = 3;
const MAX_IDENTICAL_TOOL_NO_PROGRESS = 3;
const MAX_ASSISTANT_CONTENT_CHARS = 200_000;
const MAX_HISTORY_CHARS = 1_000_000;
const MAX_TOOL_RESULT_CHARS = 200_000;
const MAX_ALL_TOOL_RESULTS_CHARS = 1_000_000;
const MAX_REASONING_CHARS = 200_000;
const MAX_TOOL_INPUT_CHARS = 100_000;

type AssistantDeliverableKind = "review" | "xlsx" | "draft" | "docx";
type AssistantPlanStepId =
  | "inspect_sources"
  | "run_workflow"
  | "produce_review"
  | "produce_draft"
  | "finalize";

const PLAN_STEP_TITLES: Record<AssistantPlanStepId, string> = {
  inspect_sources: "Inspect the relevant sources",
  run_workflow: "Run the requested workflow",
  produce_review: "Create the tabular review",
  produce_draft: "Create the legal draft",
  finalize: "Check deliverables and report results",
};

const DELIVERABLE_LABELS: Record<AssistantDeliverableKind, string> = {
  review: "Tabular review",
  xlsx: "Excel workbook",
  draft: "Studio draft",
  docx: "Word document",
};

const DELIVERABLE_RECOVERY_TOOLS: Record<
  AssistantDeliverableKind,
  readonly AssistantToolName[]
> = {
  review: ["run_contract_review", "run_custom_extraction"],
  xlsx: ["run_contract_review", "run_custom_extraction"],
  draft: [
    "create_draft",
    "create_legal_memo",
    "create_memo_from_tabular_review",
  ],
  docx: [
    "create_draft",
    "create_legal_memo",
    "create_memo_from_tabular_review",
  ],
};

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  return serialized === undefined ? "null" : serialized;
}

function failedToolResult(content: string) {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return false;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  if (typeof result.error === "string" && result.error.trim().length > 0) {
    return true;
  }
  if (result.ok === false || result.success === false) return true;
  const nestedReview = result.review;
  if (
    nestedReview &&
    typeof nestedReview === "object" &&
    !Array.isArray(nestedReview) &&
    typeof (nestedReview as Record<string, unknown>).status === "string" &&
    ["failed", "cancelled"].includes(
      String((nestedReview as Record<string, unknown>).status).toLowerCase(),
    )
  ) {
    return true;
  }
  return (
    typeof result.status === "string" &&
    ["failed", "error"].includes(result.status.toLowerCase())
  );
}

function withoutNegatedDeliverableClauses(content: string) {
  return content
    .replace(
      /\b(?:do\s+not|don['’]t|dont|no\s+need\s+to|need\s+not|without|not(?=\s)(?!\s+only\b))\b[\s\S]*?(?=$|[,.;!?，。；！？—–\n]|\b(?:but|instead)\b)/gi,
      " ",
    )
    .replace(
      /(?:不要|无需|无须|不需要|不用|不必|别|勿)[\s\S]*?(?=$|[,.;!?，。；！？—–\n]|但(?:是)?|而是|改为)/g,
      " ",
    );
}

function informationalQuestion(content: string) {
  return (
    /^(?:how|what|why|when|where|who|which|explain|tell\s+me)\b/i.test(
      content,
    ) ||
    /^(?:(?:can|could|would)\s+you\s+(?:explain|tell)\b|(?:should|must|can|could|would|do|does|did|is|are|was|were)\s+(?:i|we)\b)/i.test(
      content,
    ) ||
    /^(?:please\s+)?(?:explain|tell\s+me)\b/i.test(content) ||
    /^(?:如何|怎么|为什么|什么|谁|哪|是否|请问(?:如何|怎么|为什么|什么|谁|哪|是否)|请(?:解释|说明|告诉)|能否(?:解释|说明|告诉))/.test(
      content,
    )
  );
}

function requestedDeliverables(content: string) {
  const request = content
    .replace(/^\[The user attached[\s\S]*?\]\n\n/, "")
    .trim();
  const kinds = new Set<AssistantDeliverableKind>();
  const affirmative = withoutNegatedDeliverableClauses(request).trim();
  if (!affirmative || informationalQuestion(affirmative)) return kinds;
  const action =
    /\b(?:create|generate|prepare|produce|export|draft|write|build|make|provide)\b|\b(?:i\s+)?(?:only\s+|just\s+)?(?:need|want)\b|起草|草拟|生成|制作|创建|导出|输出|整理|形成|做一份|写一份|做成|提供|给我(?:一份)?|我要(?:一份)?|只要|仅要|只需(?:要)?/i;
  const draftWorkProduct =
    /\b(?:legal\s+)?memo(?:randum)?\b|\b(?:fact|facts|factual)\s+summary\b|\banalysis\s+report\b|备忘录|事实摘要|事实梳理|分析报告|法律意见书?/i;
  if (
    /\b(?:draft|write)\b|起草|草拟/i.test(affirmative) ||
    (action.test(affirmative) && draftWorkProduct.test(affirmative))
  ) {
    kinds.add("draft");
  }
  if (
    (action.test(affirmative) &&
      /contract review|review matrix|合同审查|合同审核|风险审查/i.test(
        affirmative,
      )) ||
    /\b(?:review|analyze)\b[\s\S]{0,40}\bcontracts?\b|(?:审查|审核)[\s\S]{0,20}合同/i.test(
      affirmative,
    )
  ) {
    kinds.add("review");
  }
  const tableRequest = affirmative.replace(/\btable\s+of\s+contents\b/gi, "");
  if (
    action.test(tableRequest) &&
    /\bxlsx\b|\bexcel\b|\bspreadsheet\b|\btable\b|\btabular\b|表格|比较表|对比表|电子表格|时间线表/i.test(
      tableRequest,
    )
  ) {
    kinds.add("xlsx");
  }
  if (
    action.test(affirmative) &&
    /\bdocx\b|\bword\s+(?:document|file)\b|Word\s*文档|Word\s*文件/i.test(
      affirmative,
    )
  ) {
    kinds.add("docx");
  }
  return kinds;
}

function planStepForTool(name: AssistantToolName): AssistantPlanStepId {
  if (
    name === "run_contract_review" ||
    name === "get_contract_review" ||
    name === "run_custom_extraction"
  ) {
    return "produce_review";
  }
  if (
    name === "create_draft" ||
    name === "create_legal_memo" ||
    name === "create_memo_from_tabular_review" ||
    name === "suggest_draft_edit" ||
    name === "suggest_studio_edit"
  ) {
    return "produce_draft";
  }
  if (
    name === "list_workflows" ||
    name === "read_workflow" ||
    name === "run_workflow" ||
    name === "get_workflow_run"
  ) {
    return "run_workflow";
  }
  return "inspect_sources";
}

const AssistantToolNameSchema = z.enum([
  "list_documents",
  "read_document",
  "fetch_documents",
  "find_in_document",
  "read_studio_document",
  "suggest_studio_edit",
  "create_draft",
  "read_draft",
  "suggest_draft_edit",
  "list_workflows",
  "read_workflow",
  "run_workflow",
  "get_workflow_run",
  "search_legal_sources",
  "read_legal_source",
  "run_contract_review",
  "get_contract_review",
  "run_custom_extraction",
  "create_legal_memo",
  "create_memo_from_tabular_review",
]);
const TOOL_EVENT_TYPES = new Set([
  "doc_read_start",
  "doc_read",
  "doc_find_start",
  "doc_find",
  "workflow_applied",
  "draft_created",
  "tabular_review_created",
]);

export type AssistantToolName = z.infer<typeof AssistantToolNameSchema>;

const TOOL_CALL_BUDGETS: Partial<Record<AssistantToolName, number>> = {
  search_legal_sources: 4,
  read_legal_source: 12,
  create_draft: 1,
  suggest_draft_edit: 5,
  run_workflow: 2,
  get_workflow_run: 8,
  run_contract_review: 1,
  get_contract_review: 8,
  run_custom_extraction: 2,
  create_legal_memo: 1,
  create_memo_from_tabular_review: 1,
};

export const AssistantModelSourceSchema = z
  .object({
    documentId: Id,
    versionId: Id,
    chunkId: Id.nullable().default(null),
    quote: z
      .string()
      .min(1)
      .max(8_000)
      .refine((quote) => quote.trim().length > 0),
    startOffset: z.number().int().nonnegative(),
    endOffset: z.number().int().nonnegative(),
    locator: z
      .object({
        pageStart: z.number().int().positive().optional(),
        pageEnd: z.number().int().positive().optional(),
        section: z.string().min(1).max(500).optional(),
        startOffset: z.number().int().nonnegative().optional(),
        endOffset: z.number().int().nonnegative().optional(),
      })
      .strict()
      .default({}),
    rank: z.number().int().nonnegative().nullable().default(null),
    score: z.number().finite().nullable().default(null),
    citationOrdinal: z.number().int().nonnegative(),
    citationMetadata: z
      .object({
        citationNumber: z.number().int().positive(),
        label: z.string().min(1).max(500).optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.endOffset < value.startOffset) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endOffset"],
        message: "Source endOffset must not precede startOffset.",
      });
    }
    if (
      value.locator.pageStart !== undefined &&
      value.locator.pageEnd !== undefined &&
      value.locator.pageEnd < value.locator.pageStart
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["locator", "pageEnd"],
        message: "Source pageEnd must not precede pageStart.",
      });
    }
    if (
      (value.locator.startOffset === undefined) !==
      (value.locator.endOffset === undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["locator", "startOffset"],
        message: "Source locator offsets must be paired.",
      });
    }
    if (
      value.locator.startOffset !== undefined &&
      value.locator.endOffset !== undefined &&
      value.locator.endOffset < value.locator.startOffset
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["locator", "endOffset"],
        message: "Source locator endOffset must not precede startOffset.",
      });
    }
  });

const AssistantLegalAuthorityLocatorSchema = z
  .object({
    article: z.string().trim().min(1).max(500).optional(),
    section: z.string().trim().min(1).max(500).optional(),
    paragraph: z.string().trim().min(1).max(500).optional(),
    page: z.number().int().positive().optional(),
  })
  .strict();

export const AssistantLegalAuthorityEvidenceSchema = z
  .object({
    kind: z.literal("legal_authority"),
    projectId: Id,
    jobId: Id,
    attempt: z.number().int().positive().max(100),
    readId: Id,
    sourceRef: z.string().trim().min(1).max(500).optional(),
    snapshotId: Id,
    anchorId: Id,
    title: z.string().trim().min(1).max(500),
    exactQuote: z
      .string()
      .min(1)
      .max(8_000)
      .refine((quote) => quote.trim().length > 0),
    locator: AssistantLegalAuthorityLocatorSchema.default({}),
  })
  .strict();

const AssistantLegalAuthorityModelSourceSchema = z
  .object({
    sourceKind: z.literal("legal_authority"),
    readId: Id,
    snapshotId: Id,
    anchorId: Id,
    quote: z
      .string()
      .min(1)
      .max(8_000)
      .refine((quote) => quote.trim().length > 0),
    locator: AssistantLegalAuthorityLocatorSchema.default({}),
    rank: z.number().int().nonnegative().nullable().default(null),
    score: z.number().finite().nullable().default(null),
    citationOrdinal: z.number().int().nonnegative(),
    citationMetadata: z
      .object({
        citationNumber: z.number().int().positive(),
        label: z.string().min(1).max(500).optional(),
      })
      .strict(),
  })
  .strict();

export const AssistantModelCitationSourceSchema = z.union([
  AssistantModelSourceSchema,
  AssistantLegalAuthorityModelSourceSchema,
]);

const ModelToolCallSchema = z
  .object({
    id: z.string().trim().min(1).max(160),
    name: AssistantToolNameSchema,
    input: z.record(z.unknown()),
  })
  .strict();

export const AssistantModelSourcesSchema = z
  .array(AssistantModelSourceSchema)
  .max(200);

export const AssistantModelCitationSourcesSchema = z
  .array(AssistantModelCitationSourceSchema)
  .max(200);

const ModelTurnSchema = z
  .object({
    content: z.string().max(MAX_ASSISTANT_CONTENT_CHARS).default(""),
    toolCalls: z
      .array(ModelToolCallSchema)
      .max(MAX_TOOL_CALLS_PER_ROUND)
      .default([]),
    sources: AssistantModelCitationSourcesSchema.default([]),
  })
  .strict();

const ModelRegistrationSchema = z
  .object({
    adapterId: z.string().trim().min(1).max(160),
    streaming: z.boolean(),
    toolCalling: z.boolean(),
    reasoning: z.boolean().default(false),
  })
  .strict();

export type AssistantModelTurn = z.infer<typeof ModelTurnSchema>;
export type AssistantModelSource = z.infer<typeof AssistantModelSourceSchema>;
export type AssistantModelCitationSource = z.infer<
  typeof AssistantModelCitationSourceSchema
>;
export type AssistantModelToolCall = z.infer<typeof ModelToolCallSchema>;
export type AssistantLegalAuthorityEvidence = z.infer<
  typeof AssistantLegalAuthorityEvidenceSchema
>;

export type AssistantModelMessage =
  | Readonly<{
      role: "user" | "assistant";
      content: string;
      toolCalls?: readonly AssistantModelToolCall[];
    }>
  | Readonly<{
      role: "tool";
      content: string;
      toolCallId: string;
    }>;

export type AssistantToolDefinition = Readonly<{
  name: AssistantToolName;
  description: string;
  inputSchema: Readonly<Record<string, unknown>>;
}>;

export interface AssistantModelPort {
  /** This is the live registered adapter capability, never profile metadata. */
  registeredCapabilities(input: { modelProfileId: string }): Promise<{
    adapterId: string;
    streaming: boolean;
    toolCalling: boolean;
    reasoning?: boolean;
  }>;

  runTurn(input: {
    modelProfileId: string;
    projectId: string | null;
    operation: Extract<InferenceOperation, "assistant" | "workflow_prompt">;
    systemPrompt: string;
    messages: readonly AssistantModelMessage[];
    tools: readonly AssistantToolDefinition[];
    documents: AssistantGenerationSnapshot["documents"];
    evidence: readonly AssistantRetrievalChunk[];
    legalAuthorityEvidence?: readonly AssistantLegalAuthorityEvidence[];
    signal: AbortSignal;
    onTextDelta(delta: string): Promise<void>;
    onReasoningDelta(delta: string): Promise<void>;
    onReasoningBlockEnd(): Promise<void>;
  }): Promise<AssistantModelTurn>;
}

export type AssistantToolContext = Readonly<{
  jobId: string;
  /** Durable fenced jobs.attempt for this exact model execution. */
  attempt: number;
  /** Durable fenced jobs.lease_owner for this exact model execution. */
  leaseOwner: string;
  chatId: string;
  projectId: string | null;
  modelProfileId: string;
  documents: AssistantGenerationSnapshot["documents"];
  /** Evidence actually returned by registered read/search tools in this attempt. */
  evidence?: readonly AssistantRetrievalChunk[];
  /** Durable authority excerpts returned only by read_legal_source in this attempt. */
  legalAuthorityEvidence?: readonly AssistantLegalAuthorityEvidence[];
}>;

export type AssistantToolExecutionResult = Readonly<{
  content: string;
  events?: readonly MikeAssistantStreamEvent[];
  sourceContext?: readonly AssistantRetrievalChunk[];
  legalAuthoritySourceContext?: readonly AssistantLegalAuthorityEvidence[];
}>;

export type AssistantToolLifecycleInput =
  | Readonly<{
      phase: "after_execution";
      context: AssistantToolContext;
      call: AssistantModelToolCall;
      result: AssistantToolExecutionResult;
      signal: AbortSignal;
    }>
  | Readonly<{
      phase: "before_final";
      context: AssistantToolContext;
      signal: AbortSignal;
    }>;

export type AssistantToolLifecycleResult = Readonly<{
  /** Replaces only the current tool result before the next model turn. */
  replacementContent?: string;
  /** Additional durable tool events produced while settlement completes. */
  events?: readonly MikeAssistantStreamEvent[];
}>;

export interface AssistantToolPort {
  /** Revalidates snapshot payload-use policy immediately before model input. */
  assertModelUse?(context: AssistantToolContext): void | Promise<void>;
  registeredTools(context: AssistantToolContext): Promise<{
    adapterId: string;
    tools: readonly AssistantToolDefinition[];
  }>;

  execute(input: {
    context: AssistantToolContext;
    call: AssistantModelToolCall;
    signal: AbortSignal;
  }): Promise<AssistantToolExecutionResult>;

  /**
   * Settles module-owned durable work without asking the model to poll. The
   * after-execution phase may replace the result sent to the next model turn;
   * the final guard may only emit recovery events.
   */
  settleLifecycle?(
    input: AssistantToolLifecycleInput,
  ): Promise<AssistantToolLifecycleResult | null>;
}

export type AssistantLegalAuthoritySourceWrite = Readonly<{
  id: string;
  readId: string;
  anchorId: string;
  citationOrdinal: number;
  citationMetadata: Readonly<{
    citationNumber: number;
    label?: string;
  }>;
}>;

export interface AssistantLegalAuthorityCommitPort {
  bindAssistantAuthoritySourcesInCurrentTransaction(input: {
    owner: {
      projectId: string;
      jobId: string;
      attempt: number;
      leaseOwner: string;
      researchSessionId: string;
    };
    messageId: string;
    sources: readonly AssistantLegalAuthoritySourceWrite[];
  }): void;
}

/** Optional live fan-out after the same-database durable outbox accepts data. */
export interface AssistantBestEffortEventPort {
  publish(jobId: string, event: MikeAssistantStreamEvent): Promise<void>;
}

export type AssistantRuntimeOptions = Readonly<{
  tools?: AssistantToolPort;
  events?: AssistantBestEffortEventPort;
  onEventFailure?: (failure: {
    code: "assistant_event_publish_failed";
  }) => void;
  clock?: () => Date;
  createId?: () => string;
  legalAuthorityCommit?: AssistantLegalAuthorityCommitPort;
}>;

function abortError() {
  const error = new Error("Assistant generation aborted.");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw abortError();
}

function isAbort(error: unknown, signal: AbortSignal) {
  return (
    signal.aborted ||
    (error instanceof Error &&
      (error.name === "AbortError" || /abort/i.test(error.message)))
  );
}

function safeModelFailure(error: unknown) {
  const record =
    error && typeof error === "object"
      ? (error as Record<string, unknown>)
      : null;
  const allowedCodes = new Set([
    "assistant_model_failed",
    "assistant_tool_failed",
    "assistant_adapter_unavailable",
    "assistant_timeout",
    "assistant_rate_limited",
    "assistant_context_limit",
    "assistant_output_invalid",
  ]);
  const code =
    typeof record?.code === "string" && allowedCodes.has(record.code)
      ? record.code
      : error instanceof WorkspaceApiError &&
          error.code === "PRECONDITION_FAILED"
        ? "assistant_adapter_unavailable"
        : "assistant_model_failed";
  return {
    code,
    message: "Assistant generation failed.",
    retryable: record?.retryable === true,
    details: null,
  };
}

function validateToolDefinitions(value: unknown): AssistantToolDefinition[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    throw new WorkspaceApiError(
      503,
      "PRECONDITION_FAILED",
      "A registered Assistant tool adapter is required.",
    );
  }
  const names = new Set<string>();
  const tools = value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new WorkspaceApiError(
        503,
        "PRECONDITION_FAILED",
        "Assistant tool registration is invalid.",
      );
    }
    const record = item as Record<string, unknown>;
    const name = AssistantToolNameSchema.parse(record.name);
    if (names.has(name)) {
      throw new WorkspaceApiError(
        503,
        "PRECONDITION_FAILED",
        "Assistant tool registration contains duplicate names.",
      );
    }
    names.add(name);
    if (
      typeof record.description !== "string" ||
      record.description.trim().length < 1 ||
      record.description.length > 4_000 ||
      !record.inputSchema ||
      typeof record.inputSchema !== "object" ||
      Array.isArray(record.inputSchema)
    ) {
      throw new WorkspaceApiError(
        503,
        "PRECONDITION_FAILED",
        "Assistant tool registration is invalid.",
      );
    }
    const tool: AssistantToolDefinition = {
      name,
      description: record.description,
      inputSchema: record.inputSchema as Record<string, unknown>,
    };
    const serialized = JSON.stringify(tool);
    if (serialized.length > 100_000) {
      throw new WorkspaceApiError(
        503,
        "PRECONDITION_FAILED",
        "Assistant tool registration exceeds the safe limit.",
      );
    }
    assertMikeSafePayload(tool);
    return tool;
  });
  return tools;
}

function buildMikeSystemPrompt(input: {
  tools: readonly AssistantToolDefinition[];
  documents: AssistantGenerationSnapshot["documents"];
}) {
  // Adapted from Mike prompts.ts/contextBuilders.ts/streaming.ts at locked SHA
  // e32daad5a4c64a5561e04c53ee12411e3c5e7238. Remote research/MCP/cloud
  // instructions are omitted and advertised tools exactly match the live
  // registered local port.
  let prompt = `You are Vera, a local-first AI legal assistant for lawyers and legal professionals. Help analyze documents, answer legal questions, and draft legal work product.

CORE RULES:
- Be precise, professional, and evidence-aware.
- Do not fabricate document content.
- Distinguish Matter facts from legal propositions. Use Matter document evidence for factual claims and read legal-authority evidence for legal propositions.
- Never invent a statute, regulation, judicial interpretation, case, court, case number, quotation, citation, or source locator. Model memory is not an authoritative legal source.
- A legal search result or summary is only a candidate. Read the source before relying on it, consider effective dates and status, identify adverse as well as supporting authority, and state when the available basis is insufficient.
- When the user requests deliverable legal work product and create_draft is registered, create a new Draft instead of placing an unnecessarily long document in chat. Never overwrite an existing Draft or accept an edit suggestion for the user.
- Before create_draft, form a bounded Draft Plan with a title, document type, and ordered sections. Draft section by section against the evidence actually read, then submit one coherent Markdown document. Do not expose internal planning unless it helps the user, and do not invent content merely to fill a template section; mark material gaps explicitly.
- For Draft citations, submit only evidenceSources returned by document or legal-authority read tools in this attempt, using the returned evidence id and its exact quote. Never submit sourceSnapshotIds, citationAnchorIds, or identifiers outside the current evidence; the backend reverifies durable ownership.
- Use at most 10 tool-use rounds and 32 total tool calls per response. Batch independent tool calls and leave room for the final answer.
- Per response, use at most 4 legal searches, 12 legal-source reads, 1 direct Draft creation, 2 custom extractions, 1 legal memo, 1 memo-from-Review handoff, 5 Draft suggestions, 2 Workflow runs, and 8 Workflow status reads. When a budget is exhausted, stop that activity, answer from evidence already read, and disclose the limitation.
- If run_contract_review or get_contract_review returns asynchronous=true, immediately call get_contract_review with that exact review id; never start a replacement Review. Continue until the Review is terminal or the 8-read budget is exhausted. Do not present a normal final answer while the Review is still running; if the read budget is exhausted, state that it remains in progress and direct the user to the returned Review route.
- For custom field extraction or a case timeline, call run_custom_extraction once. Use mode=custom with explicit columns for custom extraction, or mode=timeline for timelines. The runtime waits for the exact Review to become terminal; never invent a polling tool or start a duplicate Review.
- When the user also requests a memo from a completed custom extraction or timeline, call create_memo_from_tabular_review with that exact Review id. For a standalone memo based on evidence read in this run, call create_legal_memo. Do not use either tool to replace the automatic contract-review memo handoff.
- Use only the registered tools listed below. Never directly attempt shell, Python, arbitrary network access, MCP, CourtListener, cloud storage, dynamic tools, or multi-agent delegation. A registered legal-research tool may use its fixed backend provider boundary; do not invent or call provider tools directly.
- Read each relevant document/version at most once per response. After a read/fetch tool returns document text, use that result or find_in_document for targeted checks.
- Chat-local labels such as "doc-0" are internal. Use them only in tool arguments and citation data; refer to documents by filename in prose.
- Do not use emojis.

EVIDENCE CITATIONS (Mike-compatible local protocol):
- Put sequential markers [1], [2], and so on exactly where cited claims appear.
- At the very end, append <CITATIONS> followed by a JSON array and </CITATIONS>.
- For Matter documents, each entry must remain {"ref":1,"doc_id":"doc-0","quotes":[{"page":1,"quote":"exact verbatim text"}]}.
- For a durable read_legal_source excerpt, use {"ref":1,"legal_authority":{"snapshot_id":"<returned snapshot UUID>","anchor_id":"<returned anchor UUID>"},"quotes":[{"quote":"exact returned excerpt"}]}. Never cite search_legal_sources metadata, a transient source, or a technical-PoC read.
- Use exactly one short verbatim quote per marker in local mode. Refs must be contiguous in first-appearance order; document doc_id values must be advertised chat-local labels, and legal authority identifiers must come from a durable read in this response.
- Omit the entire <CITATIONS> block when there are no citations. Never show doc-N labels elsewhere in the answer.

REGISTERED LOCAL TOOLS:
${input.tools.map((tool) => `- ${tool.name}: ${tool.description}`).join("\n")}`;
  if (input.documents.length > 0) {
    prompt += `

AVAILABLE DOCUMENT SNAPSHOTS:
${input.documents.map((document, index) => `- doc-${index}: document_id=${document.documentId}, version_id=${document.versionId}`).join("\n")}

You do not retain document content between turns. For any response involving an available document's contents, call a registered read/fetch/find tool during this response before making factual claims.`;
  }
  return prompt;
}

function formatHistory(
  history: readonly AssistantConversationMessage[],
  snapshot: AssistantGenerationSnapshot,
): AssistantModelMessage[] {
  if (history.length > 200) {
    throw new WorkspaceApiError(
      409,
      "PRECONDITION_FAILED",
      "Assistant conversation history exceeds the safe limit.",
    );
  }
  const labelByDocument = new Map(
    snapshot.documents.map((document, index) => [
      document.documentId,
      `doc-${index}`,
    ]),
  );
  let total = 0;
  return history.map((message) => {
    let content = message.content;
    if (message.role === "user" && message.attachments.length > 0) {
      const attachments = message.attachments.map((attachment) => {
        const label = labelByDocument.get(attachment.documentId);
        return label
          ? `- ${label}: ${attachment.filename}`
          : `- ${attachment.filename}`;
      });
      content = `[The user attached the following document(s) to this message:\n${attachments.join("\n")}]\n\n${content}`;
    }
    total += content.length;
    if (total > MAX_HISTORY_CHARS) {
      throw new WorkspaceApiError(
        409,
        "PRECONDITION_FAILED",
        "Assistant conversation history exceeds the safe limit.",
      );
    }
    return { role: message.role, content };
  });
}

function validateSourceContext(
  value: readonly AssistantRetrievalChunk[] | undefined,
  snapshot: AssistantGenerationSnapshot,
) {
  const allowed = new Set(
    snapshot.documents.map(
      (document) => `${document.documentId}\0${document.versionId}`,
    ),
  );
  const chunks = value ?? [];
  if (chunks.length > 2_000) {
    throw new WorkspaceApiError(
      502,
      "JOB_FAILED",
      "Assistant tool evidence exceeded the safe limit.",
    );
  }
  for (const chunk of chunks) {
    if (
      !allowed.has(`${chunk.documentId}\0${chunk.versionId}`) ||
      typeof chunk.chunkId !== "string" ||
      typeof chunk.text !== "string" ||
      !Number.isSafeInteger(chunk.ordinal) ||
      chunk.ordinal < 0 ||
      !Number.isSafeInteger(chunk.startOffset) ||
      chunk.startOffset < 0 ||
      !Number.isSafeInteger(chunk.endOffset) ||
      chunk.endOffset < chunk.startOffset ||
      chunk.endOffset - chunk.startOffset !== chunk.text.length ||
      !Number.isFinite(chunk.score)
    ) {
      throw new WorkspaceApiError(
        502,
        "JOB_FAILED",
        "Assistant tool returned evidence outside the immutable snapshot.",
      );
    }
  }
  return chunks;
}

function validateLegalAuthoritySourceContext(
  value: readonly AssistantLegalAuthorityEvidence[] | undefined,
  context: AssistantToolContext,
) {
  const parsed = z
    .array(AssistantLegalAuthorityEvidenceSchema)
    .max(600)
    .parse(value ?? []);
  if (!context.projectId && parsed.length > 0) {
    throw new WorkspaceApiError(
      502,
      "JOB_FAILED",
      "Global Assistant chats cannot receive Matter legal authority evidence.",
    );
  }
  const anchors = new Set<string>();
  for (const evidence of parsed) {
    if (
      evidence.projectId !== context.projectId ||
      evidence.jobId !== context.jobId ||
      evidence.attempt !== context.attempt ||
      anchors.has(evidence.anchorId)
    ) {
      throw new WorkspaceApiError(
        502,
        "JOB_FAILED",
        "Assistant legal authority evidence is outside the current Matter job attempt.",
      );
    }
    anchors.add(evidence.anchorId);
  }
  return parsed;
}

export class AssistantRuntimeService {
  constructor(
    private readonly chats: ChatsRepository,
    private readonly claims: AssistantClaimTransactionPort,
    private readonly model: AssistantModelPort,
    private readonly options: AssistantRuntimeOptions = {},
  ) {}

  private now() {
    return (this.options.clock ?? (() => new Date()))().toISOString();
  }

  private createId() {
    return (this.options.createId ?? randomUUID)();
  }

  private assertClaim(
    snapshot: AssistantGenerationSnapshot,
    input: { jobId: string; leaseOwner: string; attempt: number },
  ) {
    const claim: AssistantClaimIdentity = {
      jobId: input.jobId,
      leaseOwner: input.leaseOwner,
      attempt: input.attempt,
      at: this.now(),
    };
    this.chats.assertGenerationClaim(snapshot, claim, this.claims);
    return claim;
  }

  private sourceWrites(
    result: AssistantModelTurn,
    evidence: readonly AssistantRetrievalChunk[],
    legalAuthorityEvidence: readonly AssistantLegalAuthorityEvidence[],
    answerContent: string,
  ): {
    documents: AssistantSourceWrite[];
    legalAuthorities: AssistantLegalAuthoritySourceWrite[];
  } {
    const chunks = new Map(evidence.map((chunk) => [chunk.chunkId, chunk]));
    const chunksByDocument = new Map<string, AssistantRetrievalChunk[]>();
    for (const chunk of evidence) {
      const key = `${chunk.documentId}\0${chunk.versionId}`;
      const documentChunks = chunksByDocument.get(key) ?? [];
      documentChunks.push(chunk);
      chunksByDocument.set(key, documentChunks);
    }
    const legalAuthoritiesByAnchor = new Map(
      legalAuthorityEvidence.map((authority) => [
        authority.anchorId,
        authority,
      ]),
    );
    const documentWrites: AssistantSourceWrite[] = [];
    const legalAuthorityWrites: AssistantLegalAuthoritySourceWrite[] = [];
    for (const source of result.sources) {
      if ("anchorId" in source) {
        const authority = legalAuthoritiesByAnchor.get(source.anchorId);
        if (
          !authority ||
          authority.readId !== source.readId ||
          authority.snapshotId !== source.snapshotId ||
          authority.exactQuote !== source.quote ||
          JSON.stringify(authority.locator) !== JSON.stringify(source.locator)
        ) {
          throw new WorkspaceApiError(
            502,
            "JOB_FAILED",
            "Assistant cited a legal authority outside an exact durable read in this attempt.",
          );
        }
        legalAuthorityWrites.push({
          id: this.createId(),
          readId: source.readId,
          anchorId: source.anchorId,
          citationOrdinal: source.citationOrdinal,
          citationMetadata: source.citationMetadata,
        });
        continue;
      }
      let candidates: readonly AssistantRetrievalChunk[];
      if (source.chunkId) {
        const chunk = chunks.get(source.chunkId);
        if (
          !chunk ||
          chunk.documentId !== source.documentId ||
          chunk.versionId !== source.versionId
        ) {
          throw new WorkspaceApiError(
            502,
            "JOB_FAILED",
            "Assistant model cited a chunk outside tool evidence.",
          );
        }
        candidates = [chunk];
      } else {
        candidates =
          chunksByDocument.get(`${source.documentId}\0${source.versionId}`) ??
          [];
      }
      if (candidates.length === 0) {
        throw new WorkspaceApiError(
          502,
          "JOB_FAILED",
          "Assistant model cited a document outside tool evidence.",
        );
      }
      const exactQuoteCandidates = candidates.filter((chunk) => {
        const relativeStart = source.startOffset - chunk.startOffset;
        return (
          relativeStart >= 0 &&
          source.endOffset === source.startOffset + source.quote.length &&
          source.endOffset <= chunk.endOffset &&
          chunk.text.slice(
            relativeStart,
            relativeStart + source.quote.length,
          ) === source.quote
        );
      });
      if (exactQuoteCandidates.length === 0) {
        throw new WorkspaceApiError(
          502,
          "JOB_FAILED",
          "Assistant citation quote and offsets do not match exact tool evidence.",
        );
      }
      const ranges = [
        [
          source.locator.startOffset ?? null,
          source.locator.endOffset ?? null,
        ] as const,
      ].filter(
        (range): range is readonly [number, number] =>
          range[0] !== null && range[1] !== null,
      );
      if (
        ranges.length > 0 &&
        !exactQuoteCandidates.some((chunk) =>
          ranges.every(
            ([startOffset, endOffset]) =>
              startOffset >= chunk.startOffset && endOffset <= chunk.endOffset,
          ),
        )
      ) {
        throw new WorkspaceApiError(
          502,
          "JOB_FAILED",
          "Assistant citation offsets fall outside exact tool evidence.",
        );
      }
      documentWrites.push({
        id: this.createId(),
        documentId: source.documentId,
        versionId: source.versionId,
        chunkId: source.chunkId,
        quote: source.quote,
        startOffset: source.startOffset,
        endOffset: source.endOffset,
        locator: source.locator,
        rank: source.rank,
        score: source.score,
        citationOrdinal: source.citationOrdinal,
        citationMetadata: source.citationMetadata,
      });
    }
    const expectedNumbers = result.sources.map((_, index) => index + 1);
    const ordinals = result.sources
      .map((source) => source.citationOrdinal)
      .sort((left, right) => left - right);
    const citationNumbers = result.sources
      .map((source) => source.citationMetadata.citationNumber)
      .sort((left, right) => (left ?? 0) - (right ?? 0));
    const markerNumbers = [
      ...new Set(
        [...answerContent.matchAll(/\[(\d+)\]/g)].map((match) =>
          Number(match[1]),
        ),
      ),
    ].sort((left, right) => left - right);
    const consistent =
      ordinals.length === expectedNumbers.length &&
      ordinals.every((ordinal, index) => ordinal === index) &&
      citationNumbers.length === expectedNumbers.length &&
      citationNumbers.every(
        (citationNumber, index) => citationNumber === expectedNumbers[index],
      ) &&
      result.sources.every(
        (source) =>
          source.citationMetadata.citationNumber === source.citationOrdinal + 1,
      ) &&
      markerNumbers.length === expectedNumbers.length &&
      markerNumbers.every(
        (markerNumber, index) => markerNumber === expectedNumbers[index],
      );
    if (!consistent) {
      throw new WorkspaceApiError(
        502,
        "JOB_FAILED",
        "Assistant citation markers and source references must be unique, continuous, and bidirectionally consistent.",
      );
    }
    return {
      documents: documentWrites,
      legalAuthorities: legalAuthorityWrites,
    };
  }

  async execute(input: {
    jobId: string;
    leaseOwner: string;
    attempt: number;
    signal: AbortSignal;
  }) {
    const snapshot = this.chats.generationSnapshot(input.jobId);
    const initialClaim = this.assertClaim(snapshot, input);
    throwIfAborted(input.signal);
    const queuedEvents: MikeAssistantStreamEvent[] = [];
    let partialContent = "";
    let completedMessageId: string;
    try {
      this.chats.beginGenerationAttempt({
        snapshot,
        claim: initialClaim,
        claims: this.claims,
        now: this.now(),
      });
      const persistEvent = (event: MikeAssistantStreamEvent) => {
        const parsed = MikeAssistantStreamEventSchema.parse(event);
        this.chats.appendGenerationEvent({
          snapshot,
          claim: initialClaim,
          claims: this.claims,
          event: parsed,
          now: this.now(),
        });
        queuedEvents.push(parsed);
      };
      this.chats.assertGenerationDocumentsCurrent(input.jobId);
      if (!this.options.tools) {
        throw new WorkspaceApiError(
          503,
          "PRECONDITION_FAILED",
          "A registered Assistant tool adapter is required.",
        );
      }
      const modelRegistration = ModelRegistrationSchema.parse(
        await this.model.registeredCapabilities({
          modelProfileId: snapshot.modelProfileId,
        }),
      );
      if (!modelRegistration.streaming || !modelRegistration.toolCalling) {
        throw new WorkspaceApiError(
          503,
          "PRECONDITION_FAILED",
          "The registered model adapter lacks Mike streaming/tool capability.",
        );
      }
      assertMikeSafePayload(modelRegistration);
      const toolContext: AssistantToolContext = {
        jobId: input.jobId,
        attempt: input.attempt,
        leaseOwner: input.leaseOwner,
        chatId: snapshot.chatId,
        projectId: snapshot.payload.projectId,
        modelProfileId: snapshot.modelProfileId,
        documents: snapshot.documents,
      };
      const toolRegistration =
        await this.options.tools.registeredTools(toolContext);
      if (
        !toolRegistration ||
        typeof toolRegistration.adapterId !== "string" ||
        toolRegistration.adapterId.trim().length === 0 ||
        toolRegistration.adapterId.length > 160
      ) {
        throw new WorkspaceApiError(
          503,
          "PRECONDITION_FAILED",
          "Assistant tool adapter registration is invalid.",
        );
      }
      const tools = validateToolDefinitions(toolRegistration.tools);
      assertMikeSafePayload({ adapterId: toolRegistration.adapterId, tools });
      const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
      const systemPrompt = buildMikeSystemPrompt({
        tools,
        documents: snapshot.documents,
      });
      const messages = formatHistory(
        this.chats.generationHistory(input.jobId),
        snapshot,
      );
      assertMikeSafePayload({ systemPrompt, messages });
      const evidenceByChunk = new Map<string, AssistantRetrievalChunk>();
      const legalAuthorityEvidenceByAnchor = new Map<
        string,
        AssistantLegalAuthorityEvidence
      >();
      let totalOutputChars = 0;
      let totalReasoningChars = 0;
      let totalToolResultChars = 0;
      let usedEvidenceTool = false;
      const usedToolCallIds = new Set<string>();
      const toolCallsByName = new Map<AssistantToolName, number>();
      const identicalToolResults = new Map<
        string,
        { content: string; count: number }
      >();
      let totalToolCalls = 0;
      let consecutiveToolFailures = 0;
      let deliverableRecoveryAttempted = false;
      let finalTurn: AssistantModelTurn | null = null;
      let fullText = "";
      const latestUserContent =
        [...messages].reverse().find((message) => message.role === "user")
          ?.content ?? "";
      const planGoal =
        latestUserContent
          .replace(/^\[The user attached[\s\S]*?\]\n\n/, "")
          .trim()
          .slice(0, 500) || "Complete the requested legal task";
      const planId = this.createId();
      const expectedDeliverables = requestedDeliverables(latestUserContent);
      const completedDeliverables = new Map<
        AssistantDeliverableKind,
        { artifactId: string; route: string }
      >();
      const tabularArtifacts = new Map<
        string,
        { artifactId: string; route: string }
      >();
      const planSteps = new Map<
        AssistantPlanStepId,
        "pending" | "in_progress" | "completed" | "failed"
      >();
      if (expectedDeliverables.size > 0 && snapshot.documents.length > 0) {
        planSteps.set("inspect_sources", "pending");
      }
      if (
        expectedDeliverables.has("review") ||
        expectedDeliverables.has("xlsx")
      ) {
        planSteps.set("produce_review", "pending");
      }
      if (
        expectedDeliverables.has("draft") ||
        expectedDeliverables.has("docx")
      ) {
        planSteps.set("produce_draft", "pending");
      }
      if (expectedDeliverables.size > 0) planSteps.set("finalize", "pending");
      let planEmitted = false;

      const emitPlan = () => {
        if (planSteps.size === 0) return;
        const stepOrder: readonly AssistantPlanStepId[] = [
          "inspect_sources",
          "run_workflow",
          "produce_review",
          "produce_draft",
          "finalize",
        ];
        persistEvent(
          MikeAssistantStreamEventSchema.parse({
            type: "task_plan",
            plan_id: planId,
            goal: planGoal,
            steps: stepOrder
              .filter((id) => planSteps.has(id))
              .map((id) => ({
                id,
                title: PLAN_STEP_TITLES[id],
                status: planSteps.get(id)!,
              })),
            deliverables: [...expectedDeliverables].map((kind) => {
              const artifact = completedDeliverables.get(kind);
              return {
                kind,
                label: DELIVERABLE_LABELS[kind],
                status: artifact
                  ? ("completed" as const)
                  : ("pending" as const),
                ...(artifact
                  ? {
                      artifact_id: artifact.artifactId,
                      route: artifact.route,
                    }
                  : {}),
              };
            }),
          }),
        );
        planEmitted = true;
      };

      const updatePlanStep = (
        stepId: AssistantPlanStepId,
        status: "in_progress" | "completed" | "failed",
        detail?: string,
      ) => {
        if (!planSteps.has(stepId)) planSteps.set(stepId, "pending");
        if (!planSteps.has("finalize")) planSteps.set("finalize", "pending");
        if (!planEmitted) emitPlan();
        planSteps.set(stepId, status);
        persistEvent(
          MikeAssistantStreamEventSchema.parse({
            type: "task_step_update",
            plan_id: planId,
            step_id: stepId,
            status,
            ...(detail ? { detail } : {}),
          }),
        );
      };

      const expectDeliverablesForTool = (name: AssistantToolName) => {
        let changed = false;
        if (
          name === "run_contract_review" ||
          name === "get_contract_review" ||
          name === "run_custom_extraction"
        ) {
          for (const kind of ["review", "xlsx"] as const) {
            if (expectedDeliverables.has(kind)) continue;
            expectedDeliverables.add(kind);
            changed = true;
          }
        }
        if (
          name === "create_draft" ||
          name === "create_legal_memo" ||
          name === "create_memo_from_tabular_review"
        ) {
          for (const kind of ["draft", "docx"] as const) {
            if (expectedDeliverables.has(kind)) continue;
            expectedDeliverables.add(kind);
            changed = true;
          }
        }
        const stepId = planStepForTool(name);
        if (!planSteps.has(stepId)) {
          planSteps.set(stepId, "pending");
          changed = true;
        }
        if (!planSteps.has("finalize")) {
          planSteps.set("finalize", "pending");
          changed = true;
        }
        if (changed || !planEmitted) emitPlan();
        return stepId;
      };

      const completeArtifact = (
        kinds: readonly AssistantDeliverableKind[],
        artifactId: string,
        route: string,
      ) => {
        let changed = false;
        for (const kind of kinds) {
          if (!expectedDeliverables.has(kind)) continue;
          if (!completedDeliverables.has(kind)) {
            completedDeliverables.set(kind, { artifactId, route });
            changed = true;
          }
        }
        if (changed) emitPlan();
      };
      const persistToolEvents = (
        events: readonly MikeAssistantStreamEvent[] | undefined,
        terminalRecovery = false,
      ) => {
        if (events !== undefined && !Array.isArray(events)) {
          throw new WorkspaceApiError(
            502,
            "JOB_FAILED",
            "Assistant tool emitted invalid events.",
          );
        }
        const recoveredTabularArtifacts: Array<{
          artifactId: string;
          route: string;
        }> = [];
        for (const event of events ?? []) {
          const parsed = MikeAssistantStreamEventSchema.parse(event);
          if (!TOOL_EVENT_TYPES.has(parsed.type)) {
            throw new WorkspaceApiError(
              502,
              "JOB_FAILED",
              "Assistant tool emitted a non-tool event.",
            );
          }
          if (
            parsed.type === "draft_created" &&
            (snapshot.payload.projectId === null ||
              parsed.route !==
                `/projects/${snapshot.payload.projectId}/documents/${parsed.draft_id}/studio`)
          ) {
            throw new WorkspaceApiError(
              502,
              "JOB_FAILED",
              "Assistant Draft event is outside the current Matter.",
            );
          }
          if (
            parsed.type === "tabular_review_created" &&
            (snapshot.payload.projectId === null ||
              parsed.route !==
                `/projects/${snapshot.payload.projectId}/tabular-reviews/${parsed.review_id}`)
          ) {
            throw new WorkspaceApiError(
              502,
              "JOB_FAILED",
              "Assistant Tabular Review event is outside the current Matter.",
            );
          }
          assertMikeSafePayload(parsed);
          persistEvent(parsed);
          if (parsed.type === "tabular_review_created") {
            tabularArtifacts.set(parsed.review_id, {
              artifactId: parsed.review_id,
              route: parsed.route,
            });
            if (terminalRecovery) {
              recoveredTabularArtifacts.push({
                artifactId: parsed.review_id,
                route: parsed.route,
              });
            }
          }
          if (parsed.type === "draft_created") {
            completeArtifact(["draft", "docx"], parsed.draft_id, parsed.route);
          }
        }
        if (terminalRecovery) {
          for (const artifact of recoveredTabularArtifacts) {
            completeArtifact(
              ["review", "xlsx"],
              artifact.artifactId,
              artifact.route,
            );
          }
        }
      };

      const completeTerminalReviewFromResult = (content: string) => {
        let value: unknown;
        try {
          value = JSON.parse(content);
        } catch {
          return;
        }
        if (!value || typeof value !== "object" || Array.isArray(value)) return;
        const review = (value as Record<string, unknown>).review;
        if (!review || typeof review !== "object" || Array.isArray(review)) {
          return;
        }
        const result = review as Record<string, unknown>;
        if (
          result.terminal !== true ||
          result.status !== "complete" ||
          typeof result.review_id !== "string"
        ) {
          return;
        }
        const artifact = tabularArtifacts.get(result.review_id);
        if (artifact) {
          completeArtifact(
            ["review", "xlsx"],
            artifact.artifactId,
            artifact.route,
          );
        }
      };

      if (planSteps.size > 0) emitPlan();

      for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
        throwIfAborted(input.signal);
        this.assertClaim(snapshot, input);
        await this.options.tools.assertModelUse?.(toolContext);
        throwIfAborted(input.signal);
        this.assertClaim(snapshot, input);
        let roundDeltaChars = 0;
        const roundDeltas: string[] = [];
        const bufferRoundContent = [...expectedDeliverables].some(
          (kind) => !completedDeliverables.has(kind),
        );
        let roundReasoningOpen = false;
        const turn = ModelTurnSchema.parse(
          await this.model.runTurn({
            modelProfileId: snapshot.modelProfileId,
            projectId: snapshot.payload.projectId,
            operation: "assistant",
            systemPrompt,
            messages,
            tools,
            documents: snapshot.documents,
            evidence: [...evidenceByChunk.values()],
            legalAuthorityEvidence: [
              ...legalAuthorityEvidenceByAnchor.values(),
            ],
            signal: input.signal,
            onTextDelta: async (delta) => {
              throwIfAborted(input.signal);
              if (typeof delta !== "string" || delta.length > 100_000) {
                throw new WorkspaceApiError(
                  502,
                  "JOB_FAILED",
                  "Assistant model emitted an invalid text delta.",
                );
              }
              roundDeltaChars += delta.length;
              roundDeltas.push(delta);
              totalOutputChars += delta.length;
              if (totalOutputChars > MAX_ASSISTANT_CONTENT_CHARS) {
                throw new WorkspaceApiError(
                  502,
                  "JOB_FAILED",
                  "Assistant model text deltas exceeded the limit.",
                );
              }
              if (!bufferRoundContent) {
                const nextPartial = partialContent + delta;
                assertMikeSafePayload(nextPartial);
                persistEvent(
                  MikeAssistantStreamEventSchema.parse({
                    type: "content_delta",
                    text: delta,
                  }),
                );
                partialContent = nextPartial;
              }
            },
            onReasoningDelta: async (delta) => {
              throwIfAborted(input.signal);
              if (typeof delta !== "string" || delta.length > 100_000) {
                throw new WorkspaceApiError(
                  502,
                  "JOB_FAILED",
                  "Assistant model emitted an invalid reasoning delta.",
                );
              }
              totalReasoningChars += delta.length;
              if (totalReasoningChars > MAX_REASONING_CHARS) {
                throw new WorkspaceApiError(
                  502,
                  "JOB_FAILED",
                  "Assistant model reasoning exceeded the safe limit.",
                );
              }
              assertMikeSafePayload(delta);
              roundReasoningOpen = true;
              persistEvent(
                MikeAssistantStreamEventSchema.parse({
                  type: "reasoning_delta",
                  text: delta,
                }),
              );
            },
            onReasoningBlockEnd: async () => {
              throwIfAborted(input.signal);
              if (!roundReasoningOpen) return;
              roundReasoningOpen = false;
              persistEvent(
                MikeAssistantStreamEventSchema.parse({
                  type: "reasoning_block_end",
                }),
              );
            },
          }),
        );
        throwIfAborted(input.signal);
        this.assertClaim(snapshot, input);
        if (roundReasoningOpen) {
          persistEvent(
            MikeAssistantStreamEventSchema.parse({
              type: "reasoning_block_end",
            }),
          );
        }
        assertMikeSafePayload(turn.content);
        if (roundDeltas.length > 0 && roundDeltas.join("") !== turn.content) {
          throw new WorkspaceApiError(
            502,
            "JOB_FAILED",
            "Assistant model stream drifted from its final turn content.",
          );
        }
        if (roundDeltaChars === 0 && turn.content.length > 0) {
          totalOutputChars += turn.content.length;
          if (totalOutputChars > MAX_ASSISTANT_CONTENT_CHARS) {
            throw new WorkspaceApiError(
              502,
              "JOB_FAILED",
              "Assistant model content exceeded the limit.",
            );
          }
        }
        const persistRoundContent = () => {
          if (
            fullText.length + turn.content.length >
            MAX_ASSISTANT_CONTENT_CHARS
          ) {
            throw new WorkspaceApiError(
              502,
              "JOB_FAILED",
              "Assistant model content exceeded the limit.",
            );
          }
          const deltas =
            bufferRoundContent && roundDeltas.length > 0
              ? roundDeltas
              : roundDeltas.length === 0 && turn.content.length > 0
                ? [turn.content]
                : [];
          for (const delta of deltas) {
            const nextPartial = partialContent + delta;
            assertMikeSafePayload(nextPartial);
            persistEvent(
              MikeAssistantStreamEventSchema.parse({
                type: "content_delta",
                text: delta,
              }),
            );
            partialContent = nextPartial;
          }
          fullText += turn.content;
        };

        if (turn.toolCalls.length === 0) {
          if (turn.content.length === 0) {
            throw new WorkspaceApiError(
              502,
              "JOB_FAILED",
              "Assistant model returned neither content nor tool calls.",
            );
          }
          if (snapshot.documents.length > 0 && !usedEvidenceTool) {
            throw new WorkspaceApiError(
              502,
              "JOB_FAILED",
              "Assistant must use registered document tools before answering from snapshots.",
            );
          }
          const finalSettlement = await this.options.tools.settleLifecycle?.({
            phase: "before_final",
            context: {
              ...toolContext,
              evidence: [...evidenceByChunk.values()],
              legalAuthorityEvidence: [
                ...legalAuthorityEvidenceByAnchor.values(),
              ],
            },
            signal: input.signal,
          });
          throwIfAborted(input.signal);
          this.assertClaim(snapshot, input);
          if (
            finalSettlement !== undefined &&
            finalSettlement !== null &&
            (typeof finalSettlement !== "object" ||
              finalSettlement.replacementContent !== undefined)
          ) {
            throw new WorkspaceApiError(
              502,
              "JOB_FAILED",
              "Assistant final lifecycle settlement is invalid.",
            );
          }
          persistToolEvents(finalSettlement?.events, true);
          const missingDeliverables = [...expectedDeliverables].filter(
            (kind) => !completedDeliverables.has(kind),
          );
          if (missingDeliverables.length > 0) {
            const recoveryTools = [
              ...new Set(
                missingDeliverables.flatMap((kind) =>
                  DELIVERABLE_RECOVERY_TOOLS[kind].filter((name) =>
                    toolsByName.has(name),
                  ),
                ),
              ),
            ];
            const canRecoverEveryDeliverable = missingDeliverables.every(
              (kind) =>
                DELIVERABLE_RECOVERY_TOOLS[kind].some((name) =>
                  toolsByName.has(name),
                ),
            );
            const hasToolAndFinalRoundsRemaining = round + 2 < MAX_TOOL_ROUNDS;
            if (
              !deliverableRecoveryAttempted &&
              canRecoverEveryDeliverable &&
              recoveryTools.length > 0 &&
              hasToolAndFinalRoundsRemaining
            ) {
              deliverableRecoveryAttempted = true;
              messages.push({ role: "assistant", content: turn.content });
              messages.push({
                role: "user",
                content: `Delivery recovery: the prior response cannot be finalized because these requested deliverables are still missing: ${missingDeliverables
                  .map((kind) => `${DELIVERABLE_LABELS[kind]} (${kind})`)
                  .join(
                    ", ",
                  )}. Call the appropriate registered artifact tool now (${recoveryTools.join(", ")}). Do not repeat or treat the prior final text as completion. This recovery opportunity is allowed once; after the tool result, report only the actual outcome.`,
              });
              updatePlanStep(
                "finalize",
                "in_progress",
                `Recovering missing deliverables once: ${missingDeliverables.join(", ")}.`,
              );
              continue;
            }
            updatePlanStep(
              "finalize",
              "failed",
              `Missing required deliverables: ${missingDeliverables.join(", ")}.`,
            );
            throw new WorkspaceApiError(
              502,
              "JOB_FAILED",
              `Assistant cannot finish before creating the requested deliverables: ${missingDeliverables.join(", ")}.`,
            );
          }
          persistRoundContent();
          if (planEmitted) {
            updatePlanStep("finalize", "in_progress");
            updatePlanStep("finalize", "completed");
          }
          finalTurn = turn;
          break;
        }
        if (turn.sources.length > 0) {
          throw new WorkspaceApiError(
            502,
            "JOB_FAILED",
            "Assistant sources are only accepted on the final model turn.",
          );
        }
        persistRoundContent();
        messages.push({
          role: "assistant",
          content: turn.content,
          toolCalls: turn.toolCalls,
        });
        for (const call of turn.toolCalls) {
          if (usedToolCallIds.has(call.id)) {
            throw new WorkspaceApiError(
              502,
              "JOB_FAILED",
              "Assistant model reused a tool call id.",
            );
          }
          usedToolCallIds.add(call.id);
          totalToolCalls += 1;
          const planStepId = expectDeliverablesForTool(call.name);
          if (totalToolCalls > MAX_TOTAL_TOOL_CALLS) {
            updatePlanStep(
              planStepId,
              "failed",
              "The Assistant stopped after reaching the total tool-call limit.",
            );
            throw new WorkspaceApiError(
              502,
              "JOB_FAILED",
              "Assistant exceeded the total tool-call limit.",
            );
          }
          updatePlanStep(planStepId, "in_progress");
          if (JSON.stringify(call.input).length > MAX_TOOL_INPUT_CHARS) {
            throw new WorkspaceApiError(
              502,
              "JOB_FAILED",
              "Assistant tool input exceeded the safe limit.",
            );
          }
          assertMikeSafePayload(call.input);
          if (!toolsByName.has(call.name)) {
            throw new WorkspaceApiError(
              502,
              "JOB_FAILED",
              "Assistant model requested an unregistered tool.",
            );
          }
          throwIfAborted(input.signal);
          this.assertClaim(snapshot, input);
          persistEvent(
            MikeAssistantStreamEventSchema.parse({
              type: "tool_call_start",
              name: call.name,
            }),
          );
          const usedForName = toolCallsByName.get(call.name) ?? 0;
          const nameBudget = TOOL_CALL_BUDGETS[call.name];
          const executionContext: AssistantToolContext = {
            ...toolContext,
            evidence: [...evidenceByChunk.values()],
            legalAuthorityEvidence: [
              ...legalAuthorityEvidenceByAnchor.values(),
            ],
          };
          const didExecute =
            nameBudget === undefined || usedForName < nameBudget;
          let executed: AssistantToolExecutionResult;
          try {
            executed = didExecute
              ? await this.options.tools.execute({
                  context: executionContext,
                  call,
                  signal: input.signal,
                })
              : {
                  content: JSON.stringify({
                    error: "tool_budget_exhausted",
                    tool: call.name,
                    limit: nameBudget,
                    instruction:
                      "Stop this activity, answer from evidence already read, and disclose the limitation.",
                  }),
                };
          } catch (error) {
            updatePlanStep(
              planStepId,
              "failed",
              "The tool failed before producing a usable result.",
            );
            throw error;
          }
          if (nameBudget !== undefined && usedForName < nameBudget) {
            toolCallsByName.set(call.name, usedForName + 1);
          }
          throwIfAborted(input.signal);
          this.assertClaim(snapshot, input);
          if (
            !executed ||
            typeof executed.content !== "string" ||
            executed.content.length > MAX_TOOL_RESULT_CHARS
          ) {
            throw new WorkspaceApiError(
              502,
              "JOB_FAILED",
              "Assistant tool result is invalid or too large.",
            );
          }
          totalToolResultChars += executed.content.length;
          if (totalToolResultChars > MAX_ALL_TOOL_RESULTS_CHARS) {
            throw new WorkspaceApiError(
              502,
              "JOB_FAILED",
              "Assistant tool results exceeded the aggregate limit.",
            );
          }
          assertMikeSafePayload(executed.content);
          persistToolEvents(executed.events);
          const sourceContext = validateSourceContext(
            executed.sourceContext,
            snapshot,
          );
          if (sourceContext.length > 0) usedEvidenceTool = true;
          for (const chunk of sourceContext) {
            evidenceByChunk.set(chunk.chunkId, chunk);
          }
          const legalAuthoritySourceContext =
            validateLegalAuthoritySourceContext(
              executed.legalAuthoritySourceContext,
              toolContext,
            );
          for (const authority of legalAuthoritySourceContext) {
            const existing = legalAuthorityEvidenceByAnchor.get(
              authority.anchorId,
            );
            if (
              existing &&
              JSON.stringify(existing) !== JSON.stringify(authority)
            ) {
              throw new WorkspaceApiError(
                502,
                "JOB_FAILED",
                "Assistant legal authority evidence changed within one attempt.",
              );
            }
            legalAuthorityEvidenceByAnchor.set(authority.anchorId, authority);
          }
          if (legalAuthorityEvidenceByAnchor.size > 600) {
            throw new WorkspaceApiError(
              502,
              "JOB_FAILED",
              "Assistant legal authority evidence exceeded the safe limit.",
            );
          }
          messages.push({
            role: "tool",
            toolCallId: call.id,
            content: executed.content,
          });
          if (didExecute && this.options.tools.settleLifecycle) {
            const settlement = await this.options.tools.settleLifecycle({
              phase: "after_execution",
              context: executionContext,
              call,
              result: executed,
              signal: input.signal,
            });
            throwIfAborted(input.signal);
            this.assertClaim(snapshot, input);
            if (
              settlement !== null &&
              (typeof settlement !== "object" ||
                (settlement.replacementContent !== undefined &&
                  typeof settlement.replacementContent !== "string"))
            ) {
              throw new WorkspaceApiError(
                502,
                "JOB_FAILED",
                "Assistant tool lifecycle settlement is invalid.",
              );
            }
            if (settlement?.replacementContent !== undefined) {
              const replacement = settlement.replacementContent;
              if (replacement.length > MAX_TOOL_RESULT_CHARS) {
                throw new WorkspaceApiError(
                  502,
                  "JOB_FAILED",
                  "Assistant settled tool result is too large.",
                );
              }
              const settledTotal =
                totalToolResultChars -
                executed.content.length +
                replacement.length;
              if (settledTotal > MAX_ALL_TOOL_RESULTS_CHARS) {
                throw new WorkspaceApiError(
                  502,
                  "JOB_FAILED",
                  "Assistant settled tool results exceeded the aggregate limit.",
                );
              }
              assertMikeSafePayload(replacement);
              totalToolResultChars = settledTotal;
              messages[messages.length - 1] = {
                role: "tool",
                toolCallId: call.id,
                content: replacement,
              };
            }
            persistToolEvents(settlement?.events);
          }
          const finalToolMessage = messages[messages.length - 1];
          if (finalToolMessage?.role !== "tool") {
            throw new WorkspaceApiError(
              502,
              "JOB_FAILED",
              "Assistant tool result message is missing.",
            );
          }
          completeTerminalReviewFromResult(finalToolMessage.content);
          const toolFailed = failedToolResult(finalToolMessage.content);
          consecutiveToolFailures = toolFailed
            ? consecutiveToolFailures + 1
            : 0;
          const identicalKey = `${call.name}\0${canonicalJson(call.input)}`;
          const previousIdentical = identicalToolResults.get(identicalKey);
          const identicalCount =
            previousIdentical?.content === finalToolMessage.content
              ? previousIdentical.count + 1
              : 1;
          identicalToolResults.set(identicalKey, {
            content: finalToolMessage.content,
            count: identicalCount,
          });
          if (toolFailed) {
            updatePlanStep(
              planStepId,
              "failed",
              "The tool returned an error result.",
            );
          } else {
            updatePlanStep(planStepId, "completed");
          }
          if (consecutiveToolFailures >= MAX_CONSECUTIVE_TOOL_FAILURES) {
            throw new WorkspaceApiError(
              502,
              "JOB_FAILED",
              "Assistant stopped after three consecutive tool failures.",
            );
          }
          if (identicalCount >= MAX_IDENTICAL_TOOL_NO_PROGRESS) {
            updatePlanStep(
              planStepId,
              "failed",
              "The same tool request repeated without progress.",
            );
            throw new WorkspaceApiError(
              502,
              "JOB_FAILED",
              "Assistant repeated an identical tool request without progress.",
            );
          }
        }
      }

      if (!finalTurn) {
        throw new WorkspaceApiError(
          502,
          "JOB_FAILED",
          "Assistant exceeded the ten-round Mike tool limit.",
        );
      }
      assertMikeSafePayload(finalTurn.sources);
      const sources = this.sourceWrites(
        finalTurn,
        [...evidenceByChunk.values()],
        [...legalAuthorityEvidenceByAnchor.values()],
        fullText,
      );
      assertMikeSafePayload(fullText);
      if (partialContent !== fullText) {
        throw new WorkspaceApiError(
          502,
          "JOB_FAILED",
          "Assistant event content drifted from persisted content.",
        );
      }
      throwIfAborted(input.signal);
      this.chats.commitGenerationComplete({
        snapshot,
        claim: { ...initialClaim, at: this.now() },
        claims: this.claims,
        content: fullText,
        sources: sources.documents,
        beforeComplete:
          sources.legalAuthorities.length > 0
            ? () => {
                if (
                  !snapshot.payload.projectId ||
                  !this.options.legalAuthorityCommit
                ) {
                  throw new WorkspaceApiError(
                    503,
                    "PRECONDITION_FAILED",
                    "Durable Assistant legal authority source binding is unavailable.",
                  );
                }
                this.options.legalAuthorityCommit.bindAssistantAuthoritySourcesInCurrentTransaction(
                  {
                    owner: {
                      projectId: snapshot.payload.projectId,
                      jobId: input.jobId,
                      attempt: input.attempt,
                      leaseOwner: input.leaseOwner,
                      researchSessionId: `${input.jobId}:${input.attempt}`,
                    },
                    messageId: snapshot.outputMessageId,
                    sources: sources.legalAuthorities,
                  },
                );
              }
            : undefined,
        now: this.now(),
      });
      completedMessageId = snapshot.outputMessageId;
      queuedEvents.push(
        MikeAssistantStreamEventSchema.parse({ type: "content_done" }),
      );
      queuedEvents.push(
        MikeAssistantStreamEventSchema.parse({
          type: "complete",
          message_id: completedMessageId,
          job_id: input.jobId,
        }),
      );
    } catch (error) {
      if (
        isAbort(error, input.signal) ||
        error instanceof WorkspaceJobLeaseLostError
      ) {
        if (isAbort(error, input.signal)) {
          try {
            const cancelled = this.chats.commitGenerationCancellation({
              snapshot,
              claim: { ...initialClaim, at: this.now() },
              claims: this.claims,
              content: partialContent,
              now: this.now(),
            });
            if (cancelled) {
              const terminal = MikeAssistantStreamEventSchema.parse({
                type: "error",
                code: "assistant_cancelled",
                message: "Assistant generation was cancelled.",
              });
              queuedEvents.push(terminal);
              if (this.options.events) {
                try {
                  for (const event of queuedEvents) {
                    await this.options.events.publish(input.jobId, event);
                  }
                } catch {
                  this.options.onEventFailure?.({
                    code: "assistant_event_publish_failed",
                  });
                }
              }
              return {
                messageId: snapshot.outputMessageId,
                status: "cancelled" as const,
              };
            }
          } catch (cancellationError) {
            if (!(cancellationError instanceof WorkspaceJobLeaseLostError)) {
              throw cancellationError;
            }
          }
        }
        throw error;
      }
      const failure = safeModelFailure(error);
      this.chats.commitGenerationFailure({
        snapshot,
        claim: { ...initialClaim, at: this.now() },
        claims: this.claims,
        error: failure,
        content: partialContent,
        now: this.now(),
      });
      queuedEvents.push(
        MikeAssistantStreamEventSchema.parse({
          type: "error",
          code: failure.code,
          message: failure.message,
        }),
      );
      if (this.options.events) {
        try {
          for (const event of queuedEvents) {
            await this.options.events.publish(input.jobId, event);
          }
        } catch {
          this.options.onEventFailure?.({
            code: "assistant_event_publish_failed",
          });
        }
      }
      if (error instanceof WorkspaceApiError) throw error;
      throw new WorkspaceApiError(
        502,
        "JOB_FAILED",
        "Assistant generation failed.",
      );
    }
    if (this.options.events) {
      try {
        for (const event of queuedEvents) {
          await this.options.events.publish(input.jobId, event);
        }
      } catch {
        this.options.onEventFailure?.({
          code: "assistant_event_publish_failed",
        });
      }
    }
    return { messageId: completedMessageId };
  }
}
