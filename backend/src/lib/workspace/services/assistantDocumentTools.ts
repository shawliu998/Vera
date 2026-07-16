import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

import type { WorkspaceDatabaseAdapter } from "../database";
import { WorkspaceApiError } from "../errors";
import { assertMikeSafePayload } from "../mikeCompatibility";
import {
  AssistantRetrievalRepository,
  type AssistantRetrievalChunk,
} from "../repositories/assistantRetrieval";
import {
  ChatsRepository,
  type AssistantGenerationSnapshot,
} from "../repositories/chats";
import type { WorkspaceDocumentsRepository } from "../repositories/documents";
import type { AssistantCapabilityHydratorPort } from "./chats";
import type {
  CreateDocumentStudioSuggestionFromToolInput,
  WorkspaceDocumentStudioService,
} from "./documentStudio";
import type {
  AssistantModelToolCall,
  AssistantToolContext,
  AssistantToolDefinition,
  AssistantToolPort,
} from "./assistantRuntime";

const MAX_READ_DOCUMENTS = 8;
const MAX_READ_CHUNKS = 512;
const MAX_READ_TEXT_CHARS = 150_000;
const MAX_TOOL_JSON_CHARS = 180_000;
const MAX_STUDIO_TOOL_EDIT_FIELD_CHARS = 20_000;
const MAX_STUDIO_TOOL_EDIT_INPUT_JSON_CHARS = 90_000;
const MAX_FIND_RESULTS = 40;
const MAX_FIND_CONTEXT_CHARS = 1_000;
const MAX_FIND_EXCERPT_CHARS = 4_000;
const MAX_TRACKED_JOBS = 256;

export const WORKSPACE_ASSISTANT_DOCUMENT_TOOL_ADAPTER_ID =
  "vera-local-document-tools-mike-e32daad-v1";

const DocLabel = z.string().regex(/^doc-(?:0|[1-9]\d?)$/);
const EmptyInput = z.object({}).strict();
const ReadInput = z.object({ doc_id: DocLabel }).strict();
const FetchInput = z
  .object({
    doc_ids: z
      .array(DocLabel)
      .min(1)
      .max(MAX_READ_DOCUMENTS)
      .refine((values) => new Set(values).size === values.length, {
        message: "Document labels must be unique.",
      }),
  })
  .strict();
const FindInput = z
  .object({
    doc_id: DocLabel,
    query: z.string().trim().min(1).max(2_000),
    max_results: z.number().int().min(1).max(MAX_FIND_RESULTS).default(20),
    context_chars: z
      .number()
      .int()
      .min(0)
      .max(MAX_FIND_CONTEXT_CHARS)
      .default(80),
  })
  .strict();
const SuggestStudioEditInput = z
  .object({
    doc_id: DocLabel,
    start_offset: z.number().int().nonnegative(),
    end_offset: z.number().int().nonnegative(),
    exact_deleted: z.string().max(MAX_STUDIO_TOOL_EDIT_FIELD_CHARS),
    inserted_text: z.string().max(MAX_STUDIO_TOOL_EDIT_FIELD_CHARS),
    summary: z.string().trim().min(1).max(500),
  })
  .strict()
  .superRefine((value, context) => {
    if (JSON.stringify(value).length > MAX_STUDIO_TOOL_EDIT_INPUT_JSON_CHARS) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Studio edit input exceeds the safe tool-call budget.",
      });
    }
    if (value.end_offset - value.start_offset !== value.exact_deleted.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["end_offset"],
        message: "Edit offsets must span exact_deleted UTF-16 text.",
      });
    }
    if (value.exact_deleted.length === 0 && value.inserted_text.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["inserted_text"],
        message: "Edit suggestion must change the raw Markdown.",
      });
    }
  });
const ReadStudioDocumentInput = z
  .object({
    doc_id: DocLabel,
    start_offset: z.number().int().nonnegative().default(0),
    max_chars: z.number().int().min(1).max(100_000).default(100_000),
  })
  .strict();

const LIST_DOCUMENTS_TOOL: AssistantToolDefinition = Object.freeze({
  name: "list_documents",
  description:
    "List all documents in the immutable generation snapshot. Returns each chat-local document label, filename, type, and bounded availability metadata.",
  inputSchema: Object.freeze({
    type: "object",
    properties: Object.freeze({}),
    additionalProperties: false,
  }),
});
const READ_DOCUMENT_TOOL: AssistantToolDefinition = Object.freeze({
  name: "read_document",
  description:
    "Read the full extracted text of one immutable document snapshot. Call at most once per document/version in this response; use find_in_document for later targeted checks.",
  inputSchema: Object.freeze({
    type: "object",
    properties: Object.freeze({
      doc_id: Object.freeze({
        type: "string",
        pattern: "^doc-(?:0|[1-9]\\d?)$",
      }),
    }),
    required: Object.freeze(["doc_id"]),
    additionalProperties: false,
  }),
});
const FETCH_DOCUMENTS_TOOL: AssistantToolDefinition = Object.freeze({
  name: "fetch_documents",
  description:
    "Read the full extracted text of several immutable document snapshots in one bounded call. Each document/version may be fetched only once in this response.",
  inputSchema: Object.freeze({
    type: "object",
    properties: Object.freeze({
      doc_ids: Object.freeze({
        type: "array",
        minItems: 1,
        maxItems: MAX_READ_DOCUMENTS,
        uniqueItems: true,
        items: Object.freeze({
          type: "string",
          pattern: "^doc-(?:0|[1-9]\\d?)$",
        }),
      }),
    }),
    required: Object.freeze(["doc_ids"]),
    additionalProperties: false,
  }),
});
const FIND_DOCUMENT_TOOL: AssistantToolDefinition = Object.freeze({
  name: "find_in_document",
  description:
    "Search one immutable document snapshot with Vera's local keyword index. Returns bounded exact excerpts and stable evidence identifiers; it never performs network access.",
  inputSchema: Object.freeze({
    type: "object",
    properties: Object.freeze({
      doc_id: Object.freeze({
        type: "string",
        pattern: "^doc-(?:0|[1-9]\\d?)$",
      }),
      query: Object.freeze({ type: "string", minLength: 1, maxLength: 2_000 }),
      max_results: Object.freeze({
        type: "integer",
        minimum: 1,
        maximum: MAX_FIND_RESULTS,
        default: 20,
      }),
      context_chars: Object.freeze({
        type: "integer",
        minimum: 0,
        maximum: MAX_FIND_CONTEXT_CHARS,
        default: 80,
      }),
    }),
    required: Object.freeze(["doc_id", "query"]),
    additionalProperties: false,
  }),
});
const SUGGEST_STUDIO_EDIT_TOOL: AssistantToolDefinition = Object.freeze({
  name: "suggest_studio_edit",
  description:
    "Create a pending, user-reviewable edit suggestion against the current raw Markdown of an attached Vera Document Studio draft. Offsets are UTF-16 code units in raw Markdown. This never edits the document; the user must explicitly accept or reject the suggestion.",
  inputSchema: Object.freeze({
    type: "object",
    properties: Object.freeze({
      doc_id: Object.freeze({
        type: "string",
        pattern: "^doc-(?:0|[1-9]\\d?)$",
      }),
      start_offset: Object.freeze({ type: "integer", minimum: 0 }),
      end_offset: Object.freeze({ type: "integer", minimum: 0 }),
      exact_deleted: Object.freeze({
        type: "string",
        maxLength: MAX_STUDIO_TOOL_EDIT_FIELD_CHARS,
      }),
      inserted_text: Object.freeze({
        type: "string",
        maxLength: MAX_STUDIO_TOOL_EDIT_FIELD_CHARS,
      }),
      summary: Object.freeze({
        type: "string",
        minLength: 1,
        maxLength: 500,
      }),
    }),
    required: Object.freeze([
      "doc_id",
      "start_offset",
      "end_offset",
      "exact_deleted",
      "inserted_text",
      "summary",
    ]),
    additionalProperties: false,
  }),
});
const READ_STUDIO_DOCUMENT_TOOL: AssistantToolDefinition = Object.freeze({
  name: "read_studio_document",
  description:
    "Read a bounded exact range from an attached Vera Document Studio draft's current raw Markdown. Returned offsets are UTF-16 code units in raw_markdown_v1 and can be passed to suggest_studio_edit. Page through long Markdown with start_offset; never derive edit offsets from parsed chunks.",
  inputSchema: Object.freeze({
    type: "object",
    properties: Object.freeze({
      doc_id: Object.freeze({
        type: "string",
        pattern: "^doc-(?:0|[1-9]\\d?)$",
      }),
      start_offset: Object.freeze({
        type: "integer",
        minimum: 0,
        default: 0,
      }),
      max_chars: Object.freeze({
        type: "integer",
        minimum: 1,
        maximum: 100_000,
        default: 100_000,
      }),
    }),
    required: Object.freeze(["doc_id"]),
    additionalProperties: false,
  }),
});

const DOCUMENT_TOOLS = Object.freeze([
  LIST_DOCUMENTS_TOOL,
  READ_DOCUMENT_TOOL,
  FETCH_DOCUMENTS_TOOL,
  FIND_DOCUMENT_TOOL,
]);

export type AssistantDocumentToolsOptions = Readonly<{
  studioSuggestions?: Pick<
    WorkspaceDocumentStudioService,
    "createSuggestionFromAssistantTool" | "getDocument"
  >;
  assertModelUse?: (input: {
    projectId: string;
    documentId: string;
    versionId: string;
  }) => void;
}>;

type Row = Record<string, unknown>;

class AssistantDocumentToolError extends Error {
  readonly code = "assistant_tool_failed";
  readonly retryable = false;
  readonly details = null;

  constructor(message = "Assistant document tool failed.") {
    super(message);
    this.name = "AssistantDocumentToolError";
  }
}

function abortError() {
  const error = new Error("Assistant document operation was cancelled.");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw abortError();
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new AssistantDocumentToolError();
  }
  return value;
}

function nullablePositiveInteger(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new AssistantDocumentToolError();
  }
  return parsed;
}

function nullableNonnegativeInteger(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return nonnegativeInteger(value);
}

function nonnegativeInteger(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new AssistantDocumentToolError();
  }
  return parsed;
}

function finiteNumber(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new AssistantDocumentToolError();
  return parsed;
}

function safeJson(value: unknown) {
  assertMikeSafePayload(value);
  const serialized = JSON.stringify(value);
  if (serialized.length > MAX_TOOL_JSON_CHARS) {
    throw new AssistantDocumentToolError(
      "Assistant document result exceeds the local context budget.",
    );
  }
  return serialized;
}

function documentIndex(label: string) {
  return Number(label.slice("doc-".length));
}

function sameContext(
  context: AssistantToolContext,
  snapshot: AssistantGenerationSnapshot,
) {
  return (
    context.jobId === snapshot.jobId &&
    Number.isSafeInteger(context.attempt) &&
    context.attempt >= 1 &&
    context.chatId === snapshot.chatId &&
    context.projectId === snapshot.payload.projectId &&
    context.modelProfileId === snapshot.modelProfileId &&
    isDeepStrictEqual(context.documents, snapshot.documents)
  );
}

function directChunk(row: Row): AssistantRetrievalChunk {
  const text = typeof row.text === "string" ? row.text : null;
  const startOffset = nonnegativeInteger(row.start_offset);
  const endOffset = nonnegativeInteger(row.end_offset);
  if (text === null || endOffset - startOffset !== text.length) {
    throw new AssistantDocumentToolError();
  }
  return {
    chunkId: requiredString(row.chunk_id),
    documentId: requiredString(row.document_id),
    versionId: requiredString(row.version_id),
    filename: requiredString(row.filename),
    ordinal: nonnegativeInteger(row.ordinal),
    text,
    startOffset,
    endOffset,
    pageStart: nullablePositiveInteger(row.page_start),
    pageEnd: nullablePositiveInteger(row.page_end),
    score: finiteNumber(row.ordinal),
  };
}

function excerpt(
  chunk: AssistantRetrievalChunk,
  query: string,
  contextChars: number,
): AssistantRetrievalChunk {
  const exactQuery = query.trim();
  let found = chunk.text.indexOf(exactQuery);
  if (found < 0) {
    const normalizedQuery = exactQuery.toLocaleLowerCase("en-US");
    const normalizedText = chunk.text.toLocaleLowerCase("en-US");
    // Some Unicode case folds change string length. Only reuse a folded index
    // when it is also an authoritative offset into the original chunk.
    if (
      normalizedQuery.length === exactQuery.length &&
      normalizedText.length === chunk.text.length
    ) {
      found = normalizedText.indexOf(normalizedQuery);
    }
  }
  const center = found >= 0 ? found : 0;
  const rawStart = Math.max(0, center - contextChars);
  const desiredEnd = Math.min(
    chunk.text.length,
    center + Math.max(exactQuery.length, 1) + contextChars,
  );
  const rawEnd = Math.min(
    chunk.text.length,
    Math.max(desiredEnd, rawStart + 1),
    rawStart + MAX_FIND_EXCERPT_CHARS,
  );
  const text = chunk.text.slice(rawStart, rawEnd);
  return {
    ...chunk,
    text,
    startOffset: chunk.startOffset + rawStart,
    endOffset: chunk.startOffset + rawEnd,
  };
}

function toolEventFilename(value: string) {
  if (value.length < 1 || value.length > 500) {
    throw new AssistantDocumentToolError();
  }
  return value;
}

/**
 * The local Assistant's complete document-tool boundary. It reads only rows
 * identified by the durable generation snapshot. No path, blob, URL, or
 * caller-supplied database identifier crosses this port.
 */
export class WorkspaceAssistantDocumentTools implements AssistantToolPort {
  private readonly reads = new Map<string, Set<string>>();
  private readonly studioReads = new Map<
    string,
    Map<string, Array<{ startOffset: number; endOffset: number }>>
  >();

  constructor(
    private readonly database: WorkspaceDatabaseAdapter,
    private readonly chats: ChatsRepository,
    private readonly retrieval = new AssistantRetrievalRepository(database),
    private readonly options: AssistantDocumentToolsOptions = {},
  ) {}

  private assertSnapshotModelUse(snapshot: AssistantGenerationSnapshot) {
    if (!this.options.assertModelUse || snapshot.payload.projectId === null) {
      return;
    }
    for (const document of snapshot.documents) {
      this.options.assertModelUse({
        projectId: snapshot.payload.projectId,
        documentId: document.documentId,
        versionId: document.versionId,
      });
    }
  }

  private snapshot(context: AssistantToolContext) {
    const snapshot = this.chats.generationSnapshot(context.jobId);
    if (!sameContext(context, snapshot)) {
      throw new AssistantDocumentToolError(
        "Assistant generation snapshot changed before document access.",
      );
    }
    this.assertSnapshotModelUse(snapshot);
    this.chats.assertGenerationDocumentsCurrent(context.jobId);
    return snapshot;
  }

  assertModelUse(context: AssistantToolContext) {
    this.snapshot(context);
  }

  private hasStudioSuggestionTarget(snapshot: AssistantGenerationSnapshot) {
    if (
      !this.options.studioSuggestions ||
      snapshot.payload.projectId === null ||
      snapshot.documents.length === 0
    ) {
      return false;
    }
    return snapshot.documents.some((document) =>
      this.isStudioSuggestionTarget(snapshot.payload.projectId!, document),
    );
  }

  private isStudioSuggestionTarget(
    projectId: string,
    document: { documentId: string; versionId: string },
  ) {
    return Boolean(
      this.database
        .prepare(
          `SELECT 1 AS present
             FROM documents document
             JOIN document_studio_versions studio
               ON studio.project_id = document.project_id
              AND studio.document_id = document.id
              AND studio.version_id = document.current_version_id
            WHERE document.project_id = ?
              AND document.id = ?
              AND document.current_version_id = ?
              AND document.document_kind IN ('draft', 'template')
              AND document.deleted_at IS NULL`,
        )
        .get(projectId, document.documentId, document.versionId),
    );
  }

  private recordStudioRead(
    executionId: string,
    document: { documentId: string; versionId: string },
    range: { startOffset: number; endOffset: number },
  ) {
    const byDocument = this.studioReads.get(executionId) ?? new Map();
    const key = `${document.documentId}\0${document.versionId}`;
    const ranges = byDocument.get(key) ?? [];
    if (ranges.length >= 32) {
      throw new AssistantDocumentToolError(
        "Assistant Studio read range limit was reached.",
      );
    }
    ranges.push(range);
    byDocument.set(key, ranges);
    this.studioReads.delete(executionId);
    this.studioReads.set(executionId, byDocument);
    while (this.studioReads.size > MAX_TRACKED_JOBS) {
      const oldest = this.studioReads.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.studioReads.delete(oldest);
    }
  }

  private hasExactStudioRead(
    executionId: string,
    document: { documentId: string; versionId: string },
    startOffset: number,
    endOffset: number,
  ) {
    const ranges = this.studioReads
      .get(executionId)
      ?.get(`${document.documentId}\0${document.versionId}`);
    return Boolean(
      ranges?.some(
        (range) =>
          startOffset >= range.startOffset && endOffset <= range.endOffset,
      ),
    );
  }

  private resolveDocument(
    snapshot: AssistantGenerationSnapshot,
    label: string,
  ) {
    const document = snapshot.documents[documentIndex(label)];
    if (!document) {
      throw new AssistantDocumentToolError(
        "Assistant document label is outside the generation snapshot.",
      );
    }
    return { label, ...document };
  }

  private metadata(snapshot: AssistantGenerationSnapshot, label: string) {
    const document = this.resolveDocument(snapshot, label);
    const row = this.database
      .prepare(
        `SELECT document.id AS document_id,version.id AS version_id,
                version.filename,version.mime_type,version.page_count,
                count(chunk.id) AS chunk_count,
                coalesce(sum(length(chunk.text)),0) AS text_chars
           FROM documents document
           JOIN document_versions version
             ON version.id=? AND version.document_id=document.id
           LEFT JOIN document_chunks chunk
             ON chunk.document_id=document.id AND chunk.version_id=version.id
          WHERE document.id=?
            AND document.deleted_at IS NULL
            AND version.deleted_at IS NULL
            AND document.current_version_id=version.id
            AND document.parse_status='ready'
          GROUP BY document.id,version.id,version.filename,version.mime_type,
                   version.page_count`,
      )
      .get(document.versionId, document.documentId);
    if (!row) {
      throw new AssistantDocumentToolError(
        "Assistant document snapshot is not readable.",
      );
    }
    return {
      doc_id: label,
      document_id: requiredString(row.document_id),
      version_id: requiredString(row.version_id),
      filename: toolEventFilename(requiredString(row.filename)),
      mime_type: requiredString(row.mime_type),
      page_count: nullableNonnegativeInteger(row.page_count),
      chunk_count: nonnegativeInteger(row.chunk_count),
      text_chars: nonnegativeInteger(row.text_chars),
    };
  }

  private chunks(snapshot: AssistantGenerationSnapshot, label: string) {
    const document = this.resolveDocument(snapshot, label);
    const rows = this.database
      .prepare(
        `SELECT chunk.id AS chunk_id,chunk.document_id,chunk.version_id,
                version.filename,chunk.ordinal,chunk.text,
                chunk.start_offset,chunk.end_offset,
                chunk.page_start,chunk.page_end
           FROM document_chunks chunk
           JOIN documents document
             ON document.id=chunk.document_id
           JOIN document_versions version
             ON version.id=chunk.version_id
            AND version.document_id=document.id
          WHERE chunk.document_id=? AND chunk.version_id=?
            AND document.deleted_at IS NULL
            AND version.deleted_at IS NULL
            AND document.current_version_id=version.id
            AND document.parse_status='ready'
          ORDER BY chunk.ordinal,chunk.id
          LIMIT ?`,
      )
      .all(document.documentId, document.versionId, MAX_READ_CHUNKS + 1);
    if (rows.length === 0 || rows.length > MAX_READ_CHUNKS) {
      throw new AssistantDocumentToolError(
        "Assistant document exceeds the local chunk budget; use find_in_document for targeted retrieval.",
      );
    }
    const chunks = rows.map(directChunk);
    const totalText = chunks.reduce(
      (total, chunk) => total + chunk.text.length,
      0,
    );
    if (totalText > MAX_READ_TEXT_CHARS) {
      throw new AssistantDocumentToolError(
        "Assistant document exceeds the local text budget; use find_in_document for targeted retrieval.",
      );
    }
    return chunks;
  }

  private markRead(
    jobId: string,
    documents: readonly { documentId: string; versionId: string }[],
  ) {
    const current = this.reads.get(jobId) ?? new Set<string>();
    const keys = documents.map(
      (document) => `${document.documentId}\0${document.versionId}`,
    );
    if (keys.some((key) => current.has(key))) {
      throw new AssistantDocumentToolError(
        "Assistant document snapshot was already read during this response.",
      );
    }
    for (const key of keys) current.add(key);
    this.reads.delete(jobId);
    this.reads.set(jobId, current);
    while (this.reads.size > MAX_TRACKED_JOBS) {
      const oldest = this.reads.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.reads.delete(oldest);
    }
  }

  async registeredTools(context: AssistantToolContext) {
    const snapshot = this.snapshot(context);
    this.reads.delete(context.jobId);
    this.studioReads.delete(`${context.jobId}\0${context.attempt}`);
    return {
      adapterId: WORKSPACE_ASSISTANT_DOCUMENT_TOOL_ADAPTER_ID,
      tools: this.hasStudioSuggestionTarget(snapshot)
        ? [
            ...DOCUMENT_TOOLS,
            READ_STUDIO_DOCUMENT_TOOL,
            SUGGEST_STUDIO_EDIT_TOOL,
          ]
        : DOCUMENT_TOOLS,
    };
  }

  async execute(input: {
    context: AssistantToolContext;
    call: AssistantModelToolCall;
    signal: AbortSignal;
  }) {
    throwIfAborted(input.signal);
    const snapshot = this.snapshot(input.context);
    const { call } = input;

    if (call.name === "list_documents") {
      EmptyInput.parse(call.input);
      const documents = snapshot.documents.map((_, index) =>
        this.metadata(snapshot, `doc-${index}`),
      );
      const content = safeJson({ documents });
      this.snapshot(input.context);
      throwIfAborted(input.signal);
      return { content, sourceContext: [] };
    }

    if (call.name === "read_document") {
      const parsed = ReadInput.parse(call.input);
      const document = this.resolveDocument(snapshot, parsed.doc_id);
      this.markRead(input.context.jobId, [document]);
      const metadata = this.metadata(snapshot, parsed.doc_id);
      const chunks = this.chunks(snapshot, parsed.doc_id);
      const content = safeJson({
        document: metadata,
        evidence: chunks.map((chunk) => ({
          evidence_id: chunk.chunkId,
          ordinal: chunk.ordinal,
          page_start: chunk.pageStart,
          page_end: chunk.pageEnd,
          start_offset: chunk.startOffset,
          end_offset: chunk.endOffset,
          text: chunk.text,
        })),
      });
      this.snapshot(input.context);
      throwIfAborted(input.signal);
      return {
        content,
        events: [
          { type: "doc_read_start" as const, filename: metadata.filename },
          {
            type: "doc_read" as const,
            filename: metadata.filename,
            document_id: metadata.document_id,
          },
        ],
        sourceContext: chunks,
      };
    }

    if (call.name === "fetch_documents") {
      const parsed = FetchInput.parse(call.input);
      const documents = parsed.doc_ids.map((label) =>
        this.resolveDocument(snapshot, label),
      );
      this.markRead(input.context.jobId, documents);
      const results: unknown[] = [];
      const evidence: AssistantRetrievalChunk[] = [];
      const events: Array<
        | { type: "doc_read_start"; filename: string }
        | { type: "doc_read"; filename: string; document_id: string }
      > = [];
      for (const label of parsed.doc_ids) {
        throwIfAborted(input.signal);
        const metadata = this.metadata(snapshot, label);
        const chunks = this.chunks(snapshot, label);
        evidence.push(...chunks);
        events.push(
          { type: "doc_read_start", filename: metadata.filename },
          {
            type: "doc_read",
            filename: metadata.filename,
            document_id: metadata.document_id,
          },
        );
        results.push({
          document: metadata,
          evidence: chunks.map((chunk) => ({
            evidence_id: chunk.chunkId,
            ordinal: chunk.ordinal,
            page_start: chunk.pageStart,
            page_end: chunk.pageEnd,
            start_offset: chunk.startOffset,
            end_offset: chunk.endOffset,
            text: chunk.text,
          })),
        });
      }
      const content = safeJson({ documents: results });
      this.snapshot(input.context);
      throwIfAborted(input.signal);
      return {
        content,
        events,
        sourceContext: evidence,
      };
    }

    if (call.name === "find_in_document") {
      const parsed = FindInput.parse(call.input);
      const document = this.resolveDocument(snapshot, parsed.doc_id);
      const metadata = this.metadata(snapshot, parsed.doc_id);
      const limit = Math.min(
        parsed.max_results,
        snapshot.retrievalLimit,
        MAX_FIND_RESULTS,
      );
      const results = this.retrieval
        .retrieve({
          chatId: snapshot.chatId,
          query: parsed.query,
          allowedDocumentIds: [document.documentId],
          currentVersionOnly: true,
          limit,
        })
        .filter(
          (chunk) =>
            chunk.documentId === document.documentId &&
            chunk.versionId === document.versionId,
        )
        .map((chunk) => excerpt(chunk, parsed.query, parsed.context_chars));
      const content = safeJson({
        document: metadata,
        query: parsed.query,
        returned_matches: results.length,
        result_limit: limit,
        evidence: results.map((chunk) => ({
          evidence_id: chunk.chunkId,
          ordinal: chunk.ordinal,
          page_start: chunk.pageStart,
          page_end: chunk.pageEnd,
          start_offset: chunk.startOffset,
          end_offset: chunk.endOffset,
          text: chunk.text,
        })),
      });
      this.snapshot(input.context);
      throwIfAborted(input.signal);
      return {
        content,
        events: [
          {
            type: "doc_find_start" as const,
            filename: metadata.filename,
            query: parsed.query,
          },
          {
            type: "doc_find" as const,
            filename: metadata.filename,
            query: parsed.query,
            total_matches: results.length,
          },
        ],
        sourceContext: results,
      };
    }

    if (call.name === "read_studio_document") {
      const parsed = ReadStudioDocumentInput.parse(call.input);
      const document = this.resolveDocument(snapshot, parsed.doc_id);
      if (
        snapshot.payload.projectId === null ||
        !this.options.studioSuggestions ||
        !this.isStudioSuggestionTarget(snapshot.payload.projectId, document)
      ) {
        throw new AssistantDocumentToolError(
          "Raw Document Studio Markdown is unavailable for this generation.",
        );
      }
      const studio = await this.options.studioSuggestions.getDocument(
        snapshot.payload.projectId,
        document.documentId,
        document.versionId,
      );
      if (parsed.start_offset > studio.content.length) {
        throw new AssistantDocumentToolError(
          "Studio read offset is outside the raw Markdown.",
        );
      }
      const endOffset = Math.min(
        studio.content.length,
        parsed.start_offset + parsed.max_chars,
      );
      const text = studio.content.slice(parsed.start_offset, endOffset);
      this.recordStudioRead(
        `${snapshot.jobId}\0${input.context.attempt}`,
        document,
        {
          startOffset: parsed.start_offset,
          endOffset,
        },
      );
      const content = safeJson({
        document: {
          document_id: document.documentId,
          version_id: document.versionId,
          offset_scope: "raw_markdown_v1",
          offset_unit: "utf16_code_unit",
          content_length: studio.content.length,
        },
        range: {
          start_offset: parsed.start_offset,
          end_offset: endOffset,
          text,
          complete: endOffset === studio.content.length,
        },
      });
      this.snapshot(input.context);
      throwIfAborted(input.signal);
      return { content, sourceContext: [] };
    }

    if (call.name === "suggest_studio_edit") {
      const parsed = SuggestStudioEditInput.parse(call.input);
      const document = this.resolveDocument(snapshot, parsed.doc_id);
      if (
        snapshot.payload.projectId === null ||
        !this.options.studioSuggestions ||
        !this.isStudioSuggestionTarget(snapshot.payload.projectId, document)
      ) {
        throw new AssistantDocumentToolError(
          "Document Studio suggestions are unavailable for this generation.",
        );
      }
      if (
        !this.hasExactStudioRead(
          `${snapshot.jobId}\0${input.context.attempt}`,
          document,
          parsed.start_offset,
          parsed.end_offset,
        )
      ) {
        throw new AssistantDocumentToolError(
          "Studio suggestion range was not read from exact raw Markdown in this generation.",
        );
      }
      const suggestion =
        await this.options.studioSuggestions.createSuggestionFromAssistantTool({
          projectId: snapshot.payload.projectId,
          documentId: document.documentId,
          baseVersionId: document.versionId,
          messageId: snapshot.outputMessageId,
          jobId: snapshot.jobId,
          attempt: input.context.attempt,
          toolCallId: call.id,
          startOffset: parsed.start_offset,
          endOffset: parsed.end_offset,
          exactDeletedText: parsed.exact_deleted,
          insertedText: parsed.inserted_text,
          summary: parsed.summary,
        } satisfies CreateDocumentStudioSuggestionFromToolInput);
      const content = safeJson({
        suggestion: {
          id: suggestion.id,
          document_id: suggestion.documentId,
          base_version_id: suggestion.baseVersionId,
          status: suggestion.status,
          offset_scope: suggestion.offsetScope,
          offset_unit: suggestion.offsetUnit,
          start_offset: suggestion.startOffset,
          end_offset: suggestion.endOffset,
        },
        requires_explicit_user_acceptance: true,
        document_content_changed: false,
      });
      this.snapshot(input.context);
      throwIfAborted(input.signal);
      return { content, sourceContext: [] };
    }

    throw new AssistantDocumentToolError(
      "Assistant requested a tool outside the local document adapter.",
    );
  }
}

/** Real, read-only capability hydration for persisted chat attachments. */
export class WorkspaceAssistantCapabilityHydrator implements AssistantCapabilityHydratorPort {
  constructor(
    private readonly database: WorkspaceDatabaseAdapter,
    private readonly documents: WorkspaceDocumentsRepository,
  ) {}

  hydrate(input: { documentId: string; versionId: string }) {
    const document = this.documents.getDocument(input.documentId);
    const version = document
      ? this.documents.getVersion(input.documentId, input.versionId)
      : null;
    if (!document || !version) {
      throw new WorkspaceApiError(
        404,
        "NOT_FOUND",
        "Assistant attachment document version was not found.",
      );
    }
    const canRead = Boolean(
      this.database
        .prepare(
          `SELECT 1 AS present FROM document_chunks
            WHERE document_id=? AND version_id=? LIMIT 1`,
        )
        .get(input.documentId, input.versionId),
    );
    const record = this.documents.getBlobRecordsRepository()?.getByLocator({
      kind: "original",
      documentId: input.documentId,
      versionId: input.versionId,
    });
    return { can_read: canRead, can_download: record?.state === "stored" };
  }
}

export { DOCUMENT_TOOLS };
