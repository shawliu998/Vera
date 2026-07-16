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
const MAX_ASSISTANT_CONTENT_CHARS = 200_000;
const MAX_HISTORY_CHARS = 1_000_000;
const MAX_TOOL_RESULT_CHARS = 200_000;
const MAX_ALL_TOOL_RESULTS_CHARS = 1_000_000;
const MAX_REASONING_CHARS = 200_000;
const MAX_TOOL_INPUT_CHARS = 100_000;

const AssistantToolNameSchema = z.enum([
  "list_documents",
  "read_document",
  "fetch_documents",
  "find_in_document",
  "read_studio_document",
  "suggest_studio_edit",
  "list_workflows",
  "read_workflow",
]);
const TOOL_EVENT_TYPES = new Set([
  "doc_read_start",
  "doc_read",
  "doc_find_start",
  "doc_find",
  "workflow_applied",
]);

export type AssistantToolName = z.infer<typeof AssistantToolNameSchema>;

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

const ModelTurnSchema = z
  .object({
    content: z.string().max(MAX_ASSISTANT_CONTENT_CHARS).default(""),
    toolCalls: z
      .array(ModelToolCallSchema)
      .max(MAX_TOOL_CALLS_PER_ROUND)
      .default([]),
    sources: AssistantModelSourcesSchema.default([]),
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
export type AssistantModelToolCall = z.infer<typeof ModelToolCallSchema>;

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
  chatId: string;
  projectId: string | null;
  modelProfileId: string;
  documents: AssistantGenerationSnapshot["documents"];
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
  }): Promise<{
    content: string;
    events?: readonly MikeAssistantStreamEvent[];
    sourceContext?: readonly AssistantRetrievalChunk[];
  }>;
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
- Use at most 10 tool-use rounds per response. Batch independent tool calls and leave room for the final answer.
- Use only the registered tools listed below. Never attempt shell, Python, network, MCP, CourtListener, cloud storage, dynamic tools, or multi-agent delegation.
- Read each relevant document/version at most once per response. After a read/fetch tool returns document text, use that result or find_in_document for targeted checks.
- Chat-local labels such as "doc-0" are internal. Use them only in tool arguments and citation data; refer to documents by filename in prose.
- Do not use emojis.

DOCUMENT CITATIONS (Mike-compatible local protocol):
- Put sequential markers [1], [2], and so on exactly where cited claims appear.
- At the very end, append <CITATIONS> followed by a JSON array and </CITATIONS>.
- Each entry must be {"ref":1,"doc_id":"doc-0","quotes":[{"page":1,"quote":"exact verbatim text"}]}.
- Use exactly one short verbatim quote per marker in local mode. Refs must be contiguous in first-appearance order and doc_id must be an advertised chat-local label.
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
    answerContent: string,
  ): AssistantSourceWrite[] {
    const chunks = new Map(evidence.map((chunk) => [chunk.chunkId, chunk]));
    const chunksByDocument = new Map<string, AssistantRetrievalChunk[]>();
    for (const chunk of evidence) {
      const key = `${chunk.documentId}\0${chunk.versionId}`;
      const documentChunks = chunksByDocument.get(key) ?? [];
      documentChunks.push(chunk);
      chunksByDocument.set(key, documentChunks);
    }
    const writes = result.sources.map((source) => {
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
      return {
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
      };
    });
    const expectedNumbers = writes.map((_, index) => index + 1);
    const ordinals = [...writes]
      .map((source) => source.citationOrdinal)
      .sort((left, right) => left - right);
    const citationNumbers = [...writes]
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
      writes.every(
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
    return writes;
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
      let totalOutputChars = 0;
      let totalReasoningChars = 0;
      let totalToolResultChars = 0;
      let usedEvidenceTool = false;
      const usedToolCallIds = new Set<string>();
      let finalTurn: AssistantModelTurn | null = null;
      let fullText = "";

      for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
        throwIfAborted(input.signal);
        this.assertClaim(snapshot, input);
        await this.options.tools.assertModelUse?.(toolContext);
        throwIfAborted(input.signal);
        this.assertClaim(snapshot, input);
        let roundDeltaChars = 0;
        const roundDeltas: string[] = [];
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
              const nextPartial = partialContent + delta;
              assertMikeSafePayload(nextPartial);
              persistEvent(
                MikeAssistantStreamEventSchema.parse({
                  type: "content_delta",
                  text: delta,
                }),
              );
              partialContent = nextPartial;
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
          const nextPartial = partialContent + turn.content;
          assertMikeSafePayload(nextPartial);
          persistEvent(
            MikeAssistantStreamEventSchema.parse({
              type: "content_delta",
              text: turn.content,
            }),
          );
          partialContent = nextPartial;
        }
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
        fullText += turn.content;

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
          const executed = await this.options.tools.execute({
            context: toolContext,
            call,
            signal: input.signal,
          });
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
          for (const event of executed.events ?? []) {
            const parsed = MikeAssistantStreamEventSchema.parse(event);
            if (!TOOL_EVENT_TYPES.has(parsed.type)) {
              throw new WorkspaceApiError(
                502,
                "JOB_FAILED",
                "Assistant tool emitted a non-tool event.",
              );
            }
            assertMikeSafePayload(parsed);
            persistEvent(parsed);
          }
          const sourceContext = validateSourceContext(
            executed.sourceContext,
            snapshot,
          );
          if (sourceContext.length > 0) usedEvidenceTool = true;
          for (const chunk of sourceContext) {
            evidenceByChunk.set(chunk.chunkId, chunk);
          }
          messages.push({
            role: "tool",
            toolCallId: call.id,
            content: executed.content,
          });
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
        sources,
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
