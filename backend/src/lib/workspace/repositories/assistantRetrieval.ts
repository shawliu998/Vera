import type { WorkspaceDatabaseAdapter } from "../database";
import { WorkspaceApiError } from "../errors";
import { searchSafeFtsQuery } from "../../searchSafeFtsQuery";

type Row = Record<string, unknown>;

export type AssistantRetrievalChunk = Readonly<{
  chunkId: string;
  documentId: string;
  versionId: string;
  filename: string;
  ordinal: number;
  text: string;
  startOffset: number;
  endOffset: number;
  pageStart: number | null;
  pageEnd: number | null;
  score: number;
}>;

function persistedString(value: unknown, label: string) {
  if (typeof value !== "string" || value.length === 0) {
    throw new WorkspaceApiError(
      500,
      "INTERNAL_ERROR",
      `Invalid persisted ${label}.`,
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
      `Invalid persisted ${label}.`,
    );
  }
  return parsed;
}

function mapChunk(row: Row): AssistantRetrievalChunk {
  const score = Number(row.fts_score);
  if (!Number.isFinite(score)) {
    throw new WorkspaceApiError(
      500,
      "INTERNAL_ERROR",
      "Invalid persisted retrieval score.",
    );
  }
  return {
    chunkId: persistedString(row.chunk_id, "retrieval chunk id"),
    documentId: persistedString(row.document_id, "retrieval document id"),
    versionId: persistedString(row.version_id, "retrieval version id"),
    filename: persistedString(row.filename, "retrieval filename"),
    ordinal: persistedInteger(row.ordinal, "retrieval chunk ordinal")!,
    text:
      typeof row.text === "string"
        ? row.text
        : (() => {
            throw new WorkspaceApiError(
              500,
              "INTERNAL_ERROR",
              "Invalid persisted retrieval text.",
            );
          })(),
    startOffset: persistedInteger(row.start_offset, "retrieval start offset")!,
    endOffset: persistedInteger(row.end_offset, "retrieval end offset")!,
    pageStart: persistedInteger(row.page_start, "retrieval page start", true),
    pageEnd: persistedInteger(row.page_end, "retrieval page end", true),
    score,
  };
}

export class AssistantRetrievalRepository {
  constructor(private readonly database: WorkspaceDatabaseAdapter) {}

  retrieve(input: {
    chatId: string;
    query: string;
    allowedDocumentIds: readonly string[];
    currentVersionOnly: boolean;
    limit: number;
  }): AssistantRetrievalChunk[] {
    if (!input.currentVersionOnly) {
      throw new WorkspaceApiError(
        409,
        "PRECONDITION_FAILED",
        "Assistant retrieval is restricted to current document versions.",
      );
    }
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 200
    ) {
      throw new WorkspaceApiError(
        400,
        "VALIDATION_ERROR",
        "Retrieval limit must be between 1 and 200.",
      );
    }
    const allowed = [...new Set(input.allowedDocumentIds)];
    if (allowed.length > 50) {
      throw new WorkspaceApiError(
        400,
        "VALIDATION_ERROR",
        "At most 50 documents may be retrieved.",
      );
    }
    if (allowed.length === 0) return [];
    const query = searchSafeFtsQuery(input.query);
    if (!query) return [];
    if (
      allowed.some(
        (id) => typeof id !== "string" || id.length === 0 || id.length > 160,
      )
    ) {
      throw new WorkspaceApiError(
        400,
        "VALIDATION_ERROR",
        "Retrieval document ids are invalid.",
      );
    }
    const chat = this.database
      .prepare(
        "SELECT id,project_id,scope FROM chats WHERE id=? AND status='active'",
      )
      .get(input.chatId);
    if (!chat) {
      throw new WorkspaceApiError(404, "NOT_FOUND", "Active chat not found.");
    }
    const placeholders = allowed.map(() => "?").join(",");
    const scopePredicate =
      chat.scope === "project"
        ? "document.project_id = ?"
        : `document.project_id IS NULL AND EXISTS (
             SELECT 1
               FROM chat_message_attachments attachment
               JOIN chat_messages message ON message.id=attachment.message_id
              WHERE message.chat_id=?
                AND attachment.document_id=document.id
                AND attachment.version_id=version.id
           )`;
    if (chat.scope !== "project" && chat.scope !== "global") {
      throw new WorkspaceApiError(
        500,
        "INTERNAL_ERROR",
        "Invalid persisted chat scope.",
      );
    }
    if (
      (chat.scope === "project" &&
        (typeof chat.project_id !== "string" ||
          chat.project_id.length === 0)) ||
      (chat.scope === "global" && chat.project_id !== null)
    ) {
      throw new WorkspaceApiError(
        500,
        "INTERNAL_ERROR",
        "Invalid persisted chat project scope.",
      );
    }
    const scopeValue =
      chat.scope === "project" ? chat.project_id : input.chatId;
    try {
      return this.database
        .prepare(
          `SELECT chunk.id AS chunk_id,chunk.document_id,chunk.version_id,
                  version.filename,chunk.ordinal,chunk.text,
                  chunk.start_offset,chunk.end_offset,
                  chunk.page_start,chunk.page_end,
                  bm25(document_chunks_fts) AS fts_score
           FROM document_chunks_fts f
           JOIN document_chunks chunk ON chunk.rowid=f.rowid
           JOIN documents document ON document.id=chunk.document_id
           JOIN document_versions version
             ON version.id=chunk.version_id
            AND version.document_id=document.id
          WHERE document_chunks_fts MATCH ?
            AND document.id IN (${placeholders})
            AND document.deleted_at IS NULL
            AND version.deleted_at IS NULL
            AND document.current_version_id=version.id
            AND ${scopePredicate}
          ORDER BY fts_score ASC,
                   document.id,chunk.version_id,chunk.ordinal,chunk.id
          LIMIT ?`,
        )
        .all(query, ...allowed, scopeValue, input.limit)
        .map(mapChunk);
    } catch (error) {
      if (error instanceof WorkspaceApiError) throw error;
      const message = error instanceof Error ? error.message : "";
      if (
        /no such table:\s*document_chunks_fts|no such module:\s*fts5/i.test(
          message,
        )
      ) {
        throw new WorkspaceApiError(
          503,
          "PRECONDITION_FAILED",
          "Workspace full-text retrieval is unavailable.",
        );
      }
      if (
        /(?:fts5:\s*syntax error|malformed\s+(?:MATCH|fts5)\s+(?:expression|query)|unterminated\s+(?:string|quote))/i.test(
          message,
        )
      ) {
        throw new WorkspaceApiError(
          400,
          "VALIDATION_ERROR",
          "Assistant retrieval query cannot be processed.",
        );
      }
      throw new WorkspaceApiError(
        500,
        "INTERNAL_ERROR",
        "Assistant retrieval failed.",
      );
    }
  }
}
