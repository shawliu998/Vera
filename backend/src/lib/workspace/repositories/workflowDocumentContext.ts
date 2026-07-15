import { z } from "zod";

import { searchSafeFtsQuery } from "../../searchSafeFtsQuery";
import type { WorkspaceDatabaseAdapter } from "../database";
import { WorkspaceApiError } from "../errors";
import type { AssistantRetrievalChunk } from "./assistantRetrieval";

const WorkspaceId = z.string().uuid();

export const WORKFLOW_DOCUMENT_CONTEXT_LIMITS = Object.freeze({
  maxDocuments: 20,
  maxChunksPerDocument: 20,
  maxChunks: 100,
  maxTextChars: 100_000,
  maxQueryChars: 2_000,
});

export type WorkflowDocumentSnapshot = Readonly<{
  documentId: string;
  versionId: string;
  filename: string;
}>;

export type WorkflowDocumentContextResult = Readonly<{
  documents: readonly WorkflowDocumentSnapshot[];
  evidence: readonly AssistantRetrievalChunk[];
}>;

type Row = Record<string, unknown>;

function persistedString(value: unknown, label: string) {
  if (typeof value !== "string" || value.length === 0) {
    throw new WorkspaceApiError(
      500,
      "INTERNAL_ERROR",
      `Invalid persisted workflow ${label}.`,
    );
  }
  return value;
}

function persistedInteger(value: unknown, label: string, nullable = false) {
  if (nullable && value == null) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new WorkspaceApiError(
      500,
      "INTERNAL_ERROR",
      `Invalid persisted workflow ${label}.`,
    );
  }
  return parsed;
}

function mapDocument(row: Row): WorkflowDocumentSnapshot {
  return {
    documentId: persistedString(row.document_id, "document id"),
    versionId: persistedString(row.version_id, "document version id"),
    filename: persistedString(row.filename, "document filename"),
  };
}

function mapChunk(row: Row): AssistantRetrievalChunk {
  const text = typeof row.text === "string" ? row.text : null;
  const score = Number(row.fts_score);
  const startOffset = persistedInteger(row.start_offset, "chunk start offset")!;
  const endOffset = persistedInteger(row.end_offset, "chunk end offset")!;
  if (
    text === null ||
    !Number.isFinite(score) ||
    endOffset < startOffset ||
    endOffset - startOffset !== text.length
  ) {
    throw new WorkspaceApiError(
      500,
      "INTERNAL_ERROR",
      "Invalid persisted workflow retrieval chunk.",
    );
  }
  return {
    chunkId: persistedString(row.chunk_id, "chunk id"),
    documentId: persistedString(row.document_id, "chunk document id"),
    versionId: persistedString(row.version_id, "chunk version id"),
    filename: persistedString(row.filename, "chunk filename"),
    ordinal: persistedInteger(row.ordinal, "chunk ordinal")!,
    text,
    startOffset,
    endOffset,
    pageStart: persistedInteger(row.page_start, "chunk page start", true),
    pageEnd: persistedInteger(row.page_end, "chunk page end", true),
    score,
  };
}

function requireBoundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new WorkspaceApiError(
      400,
      "VALIDATION_ERROR",
      `${label} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return value;
}

const QUERY_STOP_WORDS = new Set([
  "about",
  "additional",
  "against",
  "document",
  "documents",
  "evidence",
  "find",
  "instructions",
  "language",
  "only",
  "period",
  "review",
  "state",
  "summarize",
  "that",
  "this",
  "with",
]);

function boundedFtsQueries(query: string) {
  const values: string[] = [];
  const add = (candidate: string | null) => {
    if (candidate && !values.includes(candidate)) values.push(candidate);
  };
  add(searchSafeFtsQuery(query));
  const tokens = query.match(/[\p{L}\p{N}][\p{L}\p{N}_-]{2,}/gu) ?? [];
  for (const token of tokens) {
    const normalized = token.toLocaleLowerCase("en-US");
    if (
      values.length >= 13 ||
      QUERY_STOP_WORDS.has(normalized) ||
      /^[0-9a-f]{8,}(?:-[0-9a-f-]+)?$/i.test(token)
    ) {
      continue;
    }
    add(searchSafeFtsQuery(token));
  }
  return values;
}

/**
 * Read-only, current-version project retrieval for Workflow document_context
 * steps. It shares the workspace FTS query normalizer and never reads blob
 * paths, arbitrary files, network resources, or historical document versions.
 */
export class WorkflowDocumentContextRepository {
  constructor(
    private readonly database: WorkspaceDatabaseAdapter,
    private readonly options: {
      assertModelUse?: (input: {
        projectId: string;
        documentId: string;
        versionId: string;
      }) => void;
    } = {},
  ) {}

  private assertModelUse(
    projectId: string,
    documents: readonly WorkflowDocumentSnapshot[],
  ) {
    for (const document of documents) {
      this.options.assertModelUse?.({
        projectId,
        documentId: document.documentId,
        versionId: document.versionId,
      });
    }
  }

  retrieve(input: {
    projectId: string;
    query: string;
    documentIds: readonly string[];
    maxDocuments: number;
    maxChunksPerDocument: number;
    signal: AbortSignal;
  }): WorkflowDocumentContextResult {
    const projectId = WorkspaceId.parse(input.projectId);
    const maxDocuments = requireBoundedInteger(
      Math.min(
        input.maxDocuments,
        WORKFLOW_DOCUMENT_CONTEXT_LIMITS.maxDocuments,
      ),
      1,
      WORKFLOW_DOCUMENT_CONTEXT_LIMITS.maxDocuments,
      "Workflow document limit",
    );
    const maxChunksPerDocument = requireBoundedInteger(
      Math.min(
        input.maxChunksPerDocument,
        WORKFLOW_DOCUMENT_CONTEXT_LIMITS.maxChunksPerDocument,
      ),
      1,
      WORKFLOW_DOCUMENT_CONTEXT_LIMITS.maxChunksPerDocument,
      "Workflow chunk limit",
    );
    const requested = [
      ...new Set(input.documentIds.map((id) => WorkspaceId.parse(id))),
    ];
    if (requested.length > maxDocuments) {
      throw new WorkspaceApiError(
        400,
        "VALIDATION_ERROR",
        "Workflow input selects more documents than the document_context budget.",
      );
    }
    if (input.signal.aborted) throw this.abortError();

    const predicates = [
      "document.project_id = ?",
      "document.deleted_at IS NULL",
      "document.parse_status = 'ready'",
      "document.current_version_id = version.id",
      "version.deleted_at IS NULL",
    ];
    const parameters: unknown[] = [projectId];
    if (requested.length > 0) {
      predicates.push(`document.id IN (${requested.map(() => "?").join(",")})`);
      parameters.push(...requested);
    }
    parameters.push(maxDocuments);
    const rows = this.database
      .prepare(
        `SELECT document.id AS document_id,
                version.id AS version_id,
                version.filename
           FROM documents document
           JOIN document_versions version
             ON version.document_id = document.id
          WHERE ${predicates.join(" AND ")}
          ORDER BY document.updated_at DESC, document.id ASC
          LIMIT ?`,
      )
      .all(...parameters);
    let documents = rows.map(mapDocument);
    if (requested.length > 0) {
      const byId = new Map(
        documents.map((document) => [document.documentId, document]),
      );
      if (requested.some((id) => !byId.has(id))) {
        throw new WorkspaceApiError(
          409,
          "CONFLICT",
          "Every selected workflow document must be ready, current, and owned by the run project.",
        );
      }
      documents = requested.map((id) => byId.get(id)!);
    }
    this.assertModelUse(projectId, documents);

    const query = input.query
      .trim()
      .slice(0, WORKFLOW_DOCUMENT_CONTEXT_LIMITS.maxQueryChars);
    const ftsQueries = boundedFtsQueries(query);
    if (ftsQueries.length === 0 || documents.length === 0) {
      return { documents, evidence: [] };
    }

    const evidence: AssistantRetrievalChunk[] = [];
    let remainingChars = WORKFLOW_DOCUMENT_CONTEXT_LIMITS.maxTextChars;
    try {
      for (const document of documents) {
        if (input.signal.aborted) throw this.abortError();
        if (
          evidence.length >= WORKFLOW_DOCUMENT_CONTEXT_LIMITS.maxChunks ||
          remainingChars <= 0
        ) {
          break;
        }
        const limit = Math.min(
          maxChunksPerDocument,
          WORKFLOW_DOCUMENT_CONTEXT_LIMITS.maxChunks - evidence.length,
        );
        const chunksById = new Map<string, AssistantRetrievalChunk>();
        for (const ftsQuery of ftsQueries) {
          if (chunksById.size >= limit) break;
          const chunks = this.database
            .prepare(
              `SELECT chunk.id AS chunk_id,
                    chunk.document_id,
                    chunk.version_id,
                    version.filename,
                    chunk.ordinal,
                    chunk.text,
                    chunk.start_offset,
                    chunk.end_offset,
                    chunk.page_start,
                    chunk.page_end,
                    bm25(document_chunks_fts) AS fts_score
               FROM document_chunks_fts f
               JOIN document_chunks chunk ON chunk.rowid = f.rowid
               JOIN documents current_document
                 ON current_document.id = chunk.document_id
               JOIN document_versions version
                 ON version.id = chunk.version_id
                AND version.document_id = chunk.document_id
              WHERE document_chunks_fts MATCH ?
                AND chunk.document_id = ?
                AND chunk.version_id = ?
                AND current_document.project_id = ?
                AND current_document.deleted_at IS NULL
                AND current_document.parse_status = 'ready'
                AND current_document.current_version_id = chunk.version_id
                AND version.deleted_at IS NULL
              ORDER BY fts_score ASC, chunk.ordinal ASC, chunk.id ASC
              LIMIT ?`,
            )
            .all(
              ftsQuery,
              document.documentId,
              document.versionId,
              projectId,
              limit - chunksById.size,
            )
            .map(mapChunk);
          for (const chunk of chunks) {
            if (!chunksById.has(chunk.chunkId)) {
              chunksById.set(chunk.chunkId, chunk);
            }
          }
        }
        for (const chunk of chunksById.values()) {
          if (remainingChars <= 0) break;
          const text = chunk.text.slice(0, remainingChars);
          if (!text) break;
          evidence.push({
            ...chunk,
            text,
            endOffset: chunk.startOffset + text.length,
          });
          remainingChars -= text.length;
        }
      }
    } catch (error) {
      if (error instanceof WorkspaceApiError || this.isAbort(error))
        throw error;
      const message = error instanceof Error ? error.message : "";
      if (
        /no such table:\s*document_chunks_fts|no such module:\s*fts5|unable to use function MATCH/i.test(
          message,
        )
      ) {
        throw new WorkspaceApiError(
          503,
          "PRECONDITION_FAILED",
          "Workspace full-text retrieval is unavailable.",
        );
      }
      if (/fts5:\s*syntax error|malformed\s+(?:MATCH|fts5)/i.test(message)) {
        throw new WorkspaceApiError(
          400,
          "VALIDATION_ERROR",
          "Workflow retrieval query cannot be processed.",
        );
      }
      throw error;
    }
    this.assertModelUse(projectId, documents);
    return { documents, evidence };
  }

  private abortError() {
    const error = new Error("Workflow document retrieval aborted.");
    error.name = "AbortError";
    return error;
  }

  private isAbort(error: unknown) {
    return error instanceof Error && error.name === "AbortError";
  }
}
