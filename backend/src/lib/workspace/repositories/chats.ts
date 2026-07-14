import { isDeepStrictEqual } from "node:util";

import type { WorkspaceDatabaseAdapter } from "../database";
import { WorkspaceApiError } from "../errors";
import {
  normalizePageRequest,
  type Page,
  type PageRequest,
} from "../pagination";
import type { Chat, ChatMessage, MessageSource } from "../types";
import type { WorkspaceJobsRepository } from "./jobs";

type Row = Record<string, unknown>;

const CHAT_SCOPES = ["global", "project"] as const;
const CHAT_STATUSES = ["active", "archived"] as const;
const MESSAGE_ROLES = ["system", "user", "assistant", "tool"] as const;
const MESSAGE_STATUSES = [
  "pending",
  "streaming",
  "complete",
  "failed",
  "cancelled",
  "interrupted",
] as const;
export const ASSISTANT_GENERATION_DOCUMENT_LIMIT = 50;
export const ASSISTANT_PROJECT_CHAT_LIST_LIMIT = 200;

function corrupt(message: string): never {
  throw new WorkspaceApiError(500, "INTERNAL_ERROR", message);
}

function requiredString(value: unknown, label: string) {
  if (typeof value !== "string" || value.length === 0) {
    corrupt(`Invalid persisted ${label}.`);
  }
  return value;
}

function nullableString(value: unknown, label: string) {
  if (value == null) return null;
  return requiredString(value, label);
}

function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    corrupt(`Invalid persisted ${label}.`);
  }
  return value as T;
}

function nullableInteger(value: unknown, label: string) {
  if (value == null) return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    corrupt(`Invalid persisted ${label}.`);
  }
  return number;
}

function requiredInteger(value: unknown, label: string) {
  const parsed = nullableInteger(value, label);
  if (parsed === null) corrupt(`Invalid persisted ${label}.`);
  return parsed;
}

function parseObjectJson(
  value: unknown,
  allowedKeys: readonly string[],
  label: string,
): Record<string, string | number | boolean | null> {
  if (typeof value !== "string") corrupt(`Invalid persisted ${label}.`);
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    const record = parsed as Record<string, unknown>;
    if (
      Object.keys(record).some((key) => !allowedKeys.includes(key)) ||
      Object.values(record).some(
        (item) =>
          item !== null &&
          typeof item !== "string" &&
          typeof item !== "number" &&
          typeof item !== "boolean",
      )
    ) {
      throw new Error("unsafe shape");
    }
    return record as Record<string, string | number | boolean | null>;
  } catch {
    corrupt(`Invalid persisted ${label}.`);
  }
}

function mapChat(row: Row): Chat {
  const projectId = nullableString(row.project_id, "chat project id");
  const scope = enumValue(row.scope, CHAT_SCOPES, "chat scope");
  if ((scope === "project") !== (projectId !== null)) {
    corrupt("Invalid persisted chat scope relationship.");
  }
  return {
    id: requiredString(row.id, "chat id"),
    projectId,
    scope,
    title: requiredString(row.title, "chat title"),
    status: enumValue(row.status, CHAT_STATUSES, "chat status"),
    modelProfileId: nullableString(
      row.model_profile_id,
      "chat model profile id",
    ),
    createdAt: requiredString(row.created_at, "chat createdAt"),
    updatedAt: requiredString(row.updated_at, "chat updatedAt"),
  };
}

function mapMessage(row: Row): ChatMessage {
  return {
    id: requiredString(row.id, "message id"),
    chatId: requiredString(row.chat_id, "message chat id"),
    role: enumValue(row.role, MESSAGE_ROLES, "message role"),
    content:
      typeof row.content === "string"
        ? row.content
        : corrupt("Invalid persisted message content."),
    status: enumValue(row.status, MESSAGE_STATUSES, "message status"),
    modelProfileId: nullableString(
      row.model_profile_id,
      "message model profile id",
    ),
    jobId: nullableString(row.job_id, "message job id"),
    createdAt: requiredString(row.created_at, "message createdAt"),
    completedAt: nullableString(row.completed_at, "message completedAt"),
  };
}

export type AssistantSourceLocator = Readonly<{
  pageStart?: number;
  pageEnd?: number;
  section?: string;
  startOffset?: number;
  endOffset?: number;
}>;

export type AssistantCitationMetadata = Readonly<{
  citationNumber?: number;
  label?: string;
}>;

function parseLocator(value: unknown): AssistantSourceLocator {
  const record = parseObjectJson(
    value,
    ["pageStart", "pageEnd", "section", "startOffset", "endOffset"],
    "message source locator",
  );
  for (const key of ["pageStart", "pageEnd"] as const) {
    const item = record[key];
    if (
      item !== undefined &&
      (typeof item !== "number" || !Number.isSafeInteger(item) || item <= 0)
    ) {
      corrupt("Invalid persisted message source locator.");
    }
  }
  for (const key of ["startOffset", "endOffset"] as const) {
    const item = record[key];
    if (
      item !== undefined &&
      (typeof item !== "number" || !Number.isSafeInteger(item) || item < 0)
    ) {
      corrupt("Invalid persisted message source locator.");
    }
  }
  if (
    record.section !== undefined &&
    (typeof record.section !== "string" ||
      record.section.length === 0 ||
      record.section.length > 500)
  ) {
    corrupt("Invalid persisted message source locator.");
  }
  if (
    typeof record.pageStart === "number" &&
    typeof record.pageEnd === "number" &&
    record.pageEnd < record.pageStart
  ) {
    corrupt("Invalid persisted message source locator.");
  }
  if (
    (record.startOffset === undefined) !== (record.endOffset === undefined) ||
    (typeof record.startOffset === "number" &&
      typeof record.endOffset === "number" &&
      record.endOffset < record.startOffset)
  ) {
    corrupt("Invalid persisted message source locator.");
  }
  return record as AssistantSourceLocator;
}

function parseCitationMetadata(value: unknown): AssistantCitationMetadata {
  const record = parseObjectJson(
    value,
    ["citationNumber", "label"],
    "message citation metadata",
  );
  if (
    record.citationNumber !== undefined &&
    (typeof record.citationNumber !== "number" ||
      !Number.isSafeInteger(record.citationNumber) ||
      record.citationNumber <= 0)
  ) {
    corrupt("Invalid persisted message citation metadata.");
  }
  if (
    record.label !== undefined &&
    (typeof record.label !== "string" ||
      record.label.length === 0 ||
      record.label.length > 500)
  ) {
    corrupt("Invalid persisted message citation metadata.");
  }
  return record as AssistantCitationMetadata;
}

export type AssistantMessageSource = MessageSource & {
  filename: string;
  rank: number | null;
  score: number | null;
  citationOrdinal: number;
  locator: AssistantSourceLocator;
  citationMetadata: AssistantCitationMetadata;
};

function mapSource(row: Row): AssistantMessageSource {
  const locator = parseLocator(row.locator_json ?? "{}");
  const citationMetadata = parseCitationMetadata(
    row.citation_metadata_json ?? "{}",
  );
  const score = row.score == null ? null : Number(row.score);
  if (score !== null && !Number.isFinite(score)) {
    corrupt("Invalid persisted message source score.");
  }
  const startOffset = nullableInteger(
    row.start_offset,
    "message source start offset",
  );
  const endOffset = nullableInteger(
    row.end_offset,
    "message source end offset",
  );
  if (
    (startOffset === null) !== (endOffset === null) ||
    (startOffset !== null && endOffset !== null && endOffset < startOffset)
  ) {
    corrupt("Invalid persisted message source offsets.");
  }
  return {
    id: requiredString(row.id, "message source id"),
    messageId: requiredString(row.message_id, "message source message id"),
    documentId: requiredString(row.document_id, "message source document id"),
    versionId: requiredString(row.version_id, "message source version id"),
    filename: requiredString(row.filename, "message source filename"),
    chunkId: nullableString(row.chunk_id, "message source chunk id"),
    quote: row.quote == null ? null : String(row.quote),
    startOffset,
    endOffset,
    rank: nullableInteger(row.rank, "message source rank"),
    score,
    citationOrdinal: requiredInteger(
      row.citation_ordinal ?? row.rank ?? 0,
      "message citation ordinal",
    ),
    locator,
    citationMetadata,
    createdAt: requiredString(row.created_at, "message source createdAt"),
  };
}

export type ChatMessageAttachment = Readonly<{
  id: string;
  messageId: string;
  ordinal: number;
  documentId: string;
  versionId: string;
  filename: string;
  mimeType: string;
  createdAt: string;
}>;

function mapAttachment(row: Row): ChatMessageAttachment {
  return {
    id: requiredString(row.id, "chat attachment id"),
    messageId: requiredString(row.message_id, "chat attachment message id"),
    ordinal: requiredInteger(row.ordinal, "chat attachment ordinal"),
    documentId: requiredString(row.document_id, "chat attachment document id"),
    versionId: requiredString(row.version_id, "chat attachment version id"),
    filename: requiredString(row.filename, "chat attachment filename"),
    mimeType: requiredString(row.mime_type, "chat attachment mime type"),
    createdAt: requiredString(row.created_at, "chat attachment createdAt"),
  };
}

export type AssistantGenerationDocumentSnapshot = Readonly<{
  documentId: string;
  versionId: string;
  attached: boolean;
}>;

export type AssistantGenerationJobPayload = Readonly<{
  schema: "vera-assistant-generation-v1";
  chatId: string;
  projectId: string | null;
  promptMessageId: string;
  outputMessageId: string;
  modelProfileId: string;
  documents: readonly AssistantGenerationDocumentSnapshot[];
  retrieval: Readonly<{
    currentVersionOnly: true;
    limit: number;
  }>;
}>;

export type AssistantGenerationSnapshot = Readonly<{
  jobId: string;
  chatId: string;
  promptMessageId: string;
  outputMessageId: string;
  modelProfileId: string;
  currentVersionOnly: true;
  retrievalLimit: number;
  documents: readonly AssistantGenerationDocumentSnapshot[];
  payload: AssistantGenerationJobPayload;
  prompt: string;
  createdAt: string;
}>;

export type AssistantConversationMessage = Readonly<{
  id: string;
  role: "user" | "assistant";
  content: string;
  attachments: readonly Readonly<{
    documentId: string;
    versionId: string;
    filename: string;
  }>[];
}>;

export interface AssistantJobEnqueuerPort {
  enqueueJobInCurrentTransaction(input: {
    id: string;
    type: "assistant_generate";
    payload: AssistantGenerationJobPayload;
    resourceType: "chat";
    resourceId: string;
    maxAttempts: number;
    now: string;
    idempotencyKey?: null;
    queuedAt?: string;
  }): { id: string; type: string; status: string };
}

export type AssistantClaimIdentity = Readonly<{
  jobId: string;
  leaseOwner: string;
  attempt: number;
  at: string;
}>;

export type AssistantClaimTransactionPort = Pick<
  WorkspaceJobsRepository,
  "assertClaimInCurrentTransaction" | "finishClaimInCurrentTransaction"
>;

export type AssistantSourceWrite = Readonly<{
  id: string;
  documentId: string;
  versionId: string;
  chunkId: string | null;
  quote: string | null;
  startOffset: number | null;
  endOffset: number | null;
  locator: AssistantSourceLocator;
  rank: number | null;
  score: number | null;
  citationOrdinal: number;
  citationMetadata: AssistantCitationMetadata;
}>;

export class ChatsRepository {
  constructor(readonly database: WorkspaceDatabaseAdapter) {}

  private transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Preserve the original failure.
      }
      throw error;
    }
  }

  private hasV5AssistantSchema() {
    return Boolean(
      this.database
        .prepare(
          "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='assistant_generation_snapshots'",
        )
        .get(),
    );
  }

  get(id: string) {
    const row = this.database.prepare("SELECT * FROM chats WHERE id=?").get(id);
    return row ? mapChat(row) : null;
  }

  require(id: string) {
    const value = this.get(id);
    if (!value) {
      throw new WorkspaceApiError(404, "NOT_FOUND", "Chat not found.");
    }
    return value;
  }

  list(
    input: PageRequest & {
      projectId?: string | null;
      status?: Chat["status"];
    } = {},
  ): Page<Chat> {
    const page = normalizePageRequest(input);
    let cursor: { updatedAt: string; id: string } | null = null;
    if (page.cursor) {
      try {
        const parsed = JSON.parse(
          Buffer.from(page.cursor, "base64url").toString("utf8"),
        ) as Record<string, unknown>;
        if (
          typeof parsed.updatedAt !== "string" ||
          typeof parsed.id !== "string"
        ) {
          throw new Error("invalid cursor");
        }
        cursor = { updatedAt: parsed.updatedAt, id: parsed.id };
      } catch {
        throw new WorkspaceApiError(
          400,
          "VALIDATION_ERROR",
          "Invalid pagination cursor.",
        );
      }
    }
    const clauses: string[] = [];
    const parameters: unknown[] = [];
    if (input.projectId !== undefined) {
      clauses.push("project_id IS ?");
      parameters.push(input.projectId);
    }
    if (input.status) {
      clauses.push("status=?");
      parameters.push(input.status);
    }
    if (cursor) {
      clauses.push("(updated_at < ? OR (updated_at=? AND id<?))");
      parameters.push(cursor.updatedAt, cursor.updatedAt, cursor.id);
    }
    const rows = this.database
      .prepare(
        `SELECT * FROM chats ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
          ORDER BY updated_at DESC,id DESC LIMIT ?`,
      )
      .all(...parameters, page.limit + 1);
    const items = rows.slice(0, page.limit).map(mapChat);
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        rows.length > page.limit && last
          ? Buffer.from(
              JSON.stringify({ updatedAt: last.updatedAt, id: last.id }),
            ).toString("base64url")
          : null,
    };
  }

  listProjectChats(projectId: string) {
    const rows = this.database
      .prepare(
        `SELECT * FROM chats
          WHERE project_id=?
          ORDER BY created_at DESC,id DESC
          LIMIT ?`,
      )
      .all(projectId, ASSISTANT_PROJECT_CHAT_LIST_LIMIT + 1);
    if (rows.length > ASSISTANT_PROJECT_CHAT_LIST_LIMIT) {
      throw new WorkspaceApiError(
        409,
        "PRECONDITION_FAILED",
        `Project chat history exceeds the safe limit of ${ASSISTANT_PROJECT_CHAT_LIST_LIMIT}; an explicit pagination protocol is required.`,
      );
    }
    return rows.map(mapChat);
  }

  create(input: {
    id: string;
    projectId: string | null;
    title: string;
    modelProfileId: string | null;
    now: string;
  }) {
    const scope = input.projectId ? "project" : "global";
    this.database
      .prepare(
        "INSERT INTO chats (id,project_id,scope,title,model_profile_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
      )
      .run(
        input.id,
        input.projectId,
        scope,
        input.title,
        input.modelProfileId,
        input.now,
        input.now,
      );
    return this.require(input.id);
  }

  update(
    id: string,
    input: {
      title?: string;
      status?: Chat["status"];
      modelProfileId?: string | null;
      now: string;
    },
  ) {
    const current = this.require(id);
    this.database
      .prepare(
        "UPDATE chats SET title=?,status=?,model_profile_id=?,updated_at=? WHERE id=?",
      )
      .run(
        input.title ?? current.title,
        input.status ?? current.status,
        input.modelProfileId === undefined
          ? current.modelProfileId
          : input.modelProfileId,
        input.now,
        id,
      );
    return this.require(id);
  }

  activeJobsForChat(chatId: string) {
    this.require(chatId);
    return this.database
      .prepare(
        `SELECT id,status FROM jobs
          WHERE resource_type='chat' AND resource_id=?
            AND status IN ('queued','running')
          ORDER BY created_at,id`,
      )
      .all(chatId)
      .map((row) => ({
        id: requiredString(row.id, "chat job id"),
        status: enumValue(
          row.status,
          ["queued", "running"] as const,
          "active chat job status",
        ),
      }));
  }

  assertNoActiveGeneration(chatId: string) {
    this.require(chatId);
    const active = this.database
      .prepare(
        `SELECT id FROM jobs
          WHERE type='assistant_generate'
            AND resource_type='chat' AND resource_id=?
            AND status IN ('queued','running')
          LIMIT 1`,
      )
      .get(chatId);
    if (active) {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Only one Assistant generation may be active for a chat.",
      );
    }
  }

  delete(id: string) {
    return this.transaction(() => {
      this.require(id);
      const active = this.database
        .prepare(
          `SELECT id FROM jobs
            WHERE resource_type='chat' AND resource_id=?
              AND status IN ('queued','running') LIMIT 1`,
        )
        .get(id);
      if (active) {
        throw new WorkspaceApiError(
          409,
          "CONFLICT",
          "Chat deletion is blocked while generation jobs are active.",
        );
      }
      this.database
        .prepare(
          `DELETE FROM jobs
            WHERE resource_type='chat' AND resource_id=?
              AND status IN ('complete','failed','cancelled','interrupted')`,
        )
        .run(id);
      this.database.prepare("DELETE FROM chats WHERE id=?").run(id);
    });
  }

  private nextSequence(chatId: string) {
    const row = this.database
      .prepare(
        "SELECT coalesce(max(sequence),-1)+1 AS sequence FROM chat_messages WHERE chat_id=?",
      )
      .get(chatId);
    return requiredInteger(row?.sequence, "next chat message sequence");
  }

  private insertMessage(input: {
    id: string;
    chatId: string;
    sequence: number;
    role: ChatMessage["role"];
    content: string;
    status: ChatMessage["status"];
    modelProfileId: string | null;
    jobId: string | null;
    now: string;
  }) {
    const completedAt = [
      "complete",
      "failed",
      "cancelled",
      "interrupted",
    ].includes(input.status)
      ? input.now
      : null;
    this.database
      .prepare(
        `INSERT INTO chat_messages
          (id,chat_id,sequence,role,content,status,model_profile_id,job_id,created_at,updated_at,completed_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        input.id,
        input.chatId,
        input.sequence,
        input.role,
        input.content,
        input.status,
        input.modelProfileId,
        input.jobId,
        input.now,
        input.now,
        completedAt,
      );
    const row = this.database
      .prepare("SELECT * FROM chat_messages WHERE id=?")
      .get(input.id);
    if (!row) corrupt("Chat message insert was not persisted.");
    return mapMessage(row);
  }

  createMessage(input: {
    id: string;
    chatId: string;
    role: ChatMessage["role"];
    content: string;
    modelProfileId: string | null;
    now: string;
  }) {
    return this.transaction(() => {
      this.require(input.chatId);
      const created = this.insertMessage({
        ...input,
        sequence: this.nextSequence(input.chatId),
        status: "pending",
        jobId: null,
      });
      this.database
        .prepare("UPDATE chats SET updated_at=? WHERE id=?")
        .run(input.now, input.chatId);
      return created;
    });
  }

  updateMessage(
    id: string,
    input: { status: ChatMessage["status"]; content?: string; now: string },
  ) {
    const row = this.database
      .prepare("SELECT * FROM chat_messages WHERE id=?")
      .get(id);
    if (!row) {
      throw new WorkspaceApiError(404, "NOT_FOUND", "Message not found.");
    }
    const prior = enumValue(row.status, MESSAGE_STATUSES, "message status");
    const allowed: Record<ChatMessage["status"], ChatMessage["status"][]> = {
      pending: ["streaming", "complete", "failed", "cancelled", "interrupted"],
      streaming: ["complete", "failed", "cancelled", "interrupted"],
      complete: [],
      failed: [],
      cancelled: [],
      interrupted: [],
    };
    if (!allowed[prior].includes(input.status)) {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Message status transition is not allowed.",
      );
    }
    const completedAt = [
      "complete",
      "failed",
      "cancelled",
      "interrupted",
    ].includes(input.status)
      ? input.now
      : null;
    this.database
      .prepare(
        "UPDATE chat_messages SET status=?,content=?,updated_at=?,completed_at=? WHERE id=?",
      )
      .run(
        input.status,
        input.content ?? String(row.content),
        input.now,
        completedAt,
        id,
      );
    const updated = this.database
      .prepare("SELECT * FROM chat_messages WHERE id=?")
      .get(id);
    if (!updated) corrupt("Updated message was not persisted.");
    return mapMessage(updated);
  }

  messages(chatId: string) {
    this.require(chatId);
    return this.database
      .prepare(
        "SELECT * FROM chat_messages WHERE chat_id=? ORDER BY sequence ASC",
      )
      .all(chatId)
      .map(mapMessage);
  }

  private assertSourceRelationship(input: {
    messageId: string;
    documentId: string;
    versionId: string;
    chunkId: string | null;
  }) {
    const context = this.database
      .prepare(
        `SELECT c.project_id chat_project_id,
                d.project_id document_project_id,
                v.filename source_filename
           FROM chat_messages m
           JOIN chats c ON c.id=m.chat_id
           JOIN documents d ON d.id=? AND d.deleted_at IS NULL
           JOIN document_versions v
             ON v.id=? AND v.document_id=d.id AND v.deleted_at IS NULL
          WHERE m.id=?`,
      )
      .get(input.documentId, input.versionId, input.messageId);
    if (!context) {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Source document/version/message relationship is invalid.",
      );
    }
    if (
      context.chat_project_id == null &&
      context.document_project_id != null
    ) {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Global chat sources must be standalone documents.",
      );
    }
    if (
      context.chat_project_id != null &&
      String(context.chat_project_id) !== String(context.document_project_id)
    ) {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Project chat sources must belong to its project.",
      );
    }
    if (input.chunkId) {
      const chunk = this.database
        .prepare(
          "SELECT id FROM document_chunks WHERE id=? AND document_id=? AND version_id=?",
        )
        .get(input.chunkId, input.documentId, input.versionId);
      if (!chunk) {
        throw new WorkspaceApiError(
          409,
          "CONFLICT",
          "Source chunk relationship is invalid.",
        );
      }
    }
    return {
      filename: requiredString(
        context.source_filename,
        "message source filename snapshot",
      ),
    };
  }

  private insertSource(
    input: AssistantSourceWrite & { messageId: string; now: string },
  ) {
    const relationship = this.assertSourceRelationship(input);
    if (this.hasV5AssistantSchema()) {
      this.database
        .prepare(
          `INSERT INTO message_sources
            (id,message_id,document_id,version_id,filename_snapshot,chunk_id,quote,start_offset,end_offset,
             locator_json,rank,score,citation_ordinal,citation_metadata_json,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          input.id,
          input.messageId,
          input.documentId,
          input.versionId,
          relationship.filename,
          input.chunkId,
          input.quote,
          input.startOffset,
          input.endOffset,
          JSON.stringify(input.locator),
          input.rank,
          input.score,
          input.citationOrdinal,
          JSON.stringify(input.citationMetadata),
          input.now,
        );
    } else {
      this.database
        .prepare(
          `INSERT INTO message_sources
            (id,message_id,document_id,version_id,chunk_id,quote,start_offset,end_offset,
             locator_json,rank,score,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          input.id,
          input.messageId,
          input.documentId,
          input.versionId,
          input.chunkId,
          input.quote,
          input.startOffset,
          input.endOffset,
          JSON.stringify(input.locator),
          input.rank,
          input.score,
          input.now,
        );
    }
    const inserted = this.database
      .prepare(
        this.hasV5AssistantSchema()
          ? `SELECT source.*,source.filename_snapshot AS filename
               FROM message_sources source
              WHERE source.id=?`
          : `SELECT source.*,version.filename
               FROM message_sources source
               JOIN document_versions version
                 ON version.id=source.version_id
                AND version.document_id=source.document_id
              WHERE source.id=?`,
      )
      .get(input.id);
    if (!inserted) corrupt("Message source insert was not persisted.");
    return mapSource(inserted);
  }

  addSource(input: AssistantSourceWrite & { messageId: string; now: string }) {
    return this.insertSource(input);
  }

  sources(messageId: string) {
    const row = this.database
      .prepare("SELECT id FROM chat_messages WHERE id=?")
      .get(messageId);
    if (!row) {
      throw new WorkspaceApiError(404, "NOT_FOUND", "Message not found.");
    }
    return this.database
      .prepare(
        this.hasV5AssistantSchema()
          ? `SELECT source.*,source.filename_snapshot AS filename
               FROM message_sources source
              WHERE source.message_id=?
              ORDER BY source.citation_ordinal ASC,source.id ASC`
          : `SELECT source.*,version.filename
               FROM message_sources source
               JOIN document_versions version
                 ON version.id=source.version_id
                AND version.document_id=source.document_id
              WHERE source.message_id=?
              ORDER BY source.rank ASC,source.id ASC`,
      )
      .all(messageId)
      .map(mapSource);
  }

  attachments(messageId: string) {
    if (!this.hasV5AssistantSchema()) return [] as ChatMessageAttachment[];
    const message = this.database
      .prepare("SELECT id FROM chat_messages WHERE id=?")
      .get(messageId);
    if (!message) {
      throw new WorkspaceApiError(404, "NOT_FOUND", "Message not found.");
    }
    return this.database
      .prepare(
        `SELECT attachment.*,
                attachment.filename_snapshot AS filename,
                attachment.mime_type_snapshot AS mime_type
           FROM chat_message_attachments attachment
          WHERE attachment.message_id=?
          ORDER BY attachment.ordinal,attachment.id`,
      )
      .all(messageId)
      .map(mapAttachment);
  }

  detail(chatId: string) {
    const chat = this.require(chatId);
    const messages = this.messages(chatId).map((item) => ({
      ...item,
      attachments: this.attachments(item.id),
      sources: this.sources(item.id),
    }));
    return { chat, messages };
  }

  resolveModelProfileId(chatId: string) {
    const row = this.database
      .prepare(
        `SELECT coalesce(
           chat.model_profile_id,
           project.default_model_profile_id,
           setting.default_model_profile_id
         ) AS model_profile_id
           FROM chats chat
           LEFT JOIN projects project ON project.id=chat.project_id
           LEFT JOIN workspace_settings setting ON setting.id='workspace'
          WHERE chat.id=?`,
      )
      .get(chatId);
    if (!row) {
      throw new WorkspaceApiError(404, "NOT_FOUND", "Chat not found.");
    }
    return nullableString(row.model_profile_id, "resolved model profile id");
  }

  private resolveGenerationDocumentsInCurrentTransaction(input: {
    chat: Chat;
    allowedDocumentIds: readonly string[];
    attachments: readonly { documentId: string; attachmentId: string }[];
  }): Array<
    AssistantGenerationDocumentSnapshot & { attachmentId: string | null }
  > {
    const allowed = [...new Set(input.allowedDocumentIds)];
    const attachmentIds = new Map(
      input.attachments.map((attachment) => [
        attachment.documentId,
        attachment.attachmentId,
      ]),
    );
    const attachments = new Set(attachmentIds.keys());
    const requested = [...new Set([...allowed, ...attachments])];
    if (
      requested.length > 50 ||
      attachmentIds.size !== input.attachments.length
    ) {
      throw new WorkspaceApiError(
        400,
        "VALIDATION_ERROR",
        "At most 50 unique documents may be attached in one Assistant turn.",
      );
    }
    if (input.chat.scope === "global") {
      const unbound = allowed.find(
        (documentId) => !attachments.has(documentId),
      );
      if (unbound) {
        throw new WorkspaceApiError(
          409,
          "PRECONDITION_FAILED",
          "Global chat retrieval is limited to explicitly attached standalone documents.",
        );
      }
    }
    const requestedById = new Map<string, string>();
    if (requested.length > 0) {
      const placeholders = requested.map(() => "?").join(",");
      const rows = this.database
        .prepare(
          `SELECT document.id AS document_id,version.id AS version_id
             FROM documents document
             JOIN document_versions version
               ON version.id=document.current_version_id
              AND version.document_id=document.id
            WHERE document.id IN (${placeholders})
              AND document.project_id IS ?
              AND document.deleted_at IS NULL
              AND version.deleted_at IS NULL`,
        )
        .all(...requested, input.chat.projectId);
      for (const row of rows) {
        requestedById.set(
          requiredString(row.document_id, "generation document id"),
          requiredString(row.version_id, "generation version id"),
        );
      }
      if (requested.some((documentId) => !requestedById.has(documentId))) {
        throw new WorkspaceApiError(
          409,
          "CONFLICT",
          "Generation documents must exist, be current, and remain in the chat scope.",
        );
      }
    }
    if (input.chat.scope === "project") {
      const rows = this.database
        .prepare(
          `SELECT document.id AS document_id,version.id AS version_id
             FROM documents document
             JOIN document_versions version
               ON version.id=document.current_version_id
              AND version.document_id=document.id
            WHERE document.project_id=?
              AND document.deleted_at IS NULL
              AND version.deleted_at IS NULL
            ORDER BY document.created_at,document.id
            LIMIT ?`,
        )
        .all(input.chat.projectId, ASSISTANT_GENERATION_DOCUMENT_LIMIT + 1);
      if (rows.length > ASSISTANT_GENERATION_DOCUMENT_LIMIT) {
        throw new WorkspaceApiError(
          409,
          "PRECONDITION_FAILED",
          `Project Assistant generation supports at most ${ASSISTANT_GENERATION_DOCUMENT_LIMIT} current documents; bounded project pagination is required.`,
        );
      }
      return rows.map((row) => {
        const documentId = requiredString(
          row.document_id,
          "generation document id",
        );
        return {
          documentId,
          versionId: requiredString(row.version_id, "generation version id"),
          attached: attachments.has(documentId),
          attachmentId: attachmentIds.get(documentId) ?? null,
        };
      });
    }

    const inherited = new Map<string, string>();
    const historicalRows = this.database
      .prepare(
        `SELECT attachment.document_id,attachment.version_id
           FROM chat_message_attachments attachment
           JOIN chat_messages message ON message.id=attachment.message_id
          WHERE message.chat_id=?
          ORDER BY message.sequence DESC,attachment.ordinal DESC,attachment.id DESC`,
      )
      .all(input.chat.id);
    for (const row of historicalRows) {
      const documentId = requiredString(
        row.document_id,
        "historical attachment document id",
      );
      if (!inherited.has(documentId)) {
        inherited.set(
          documentId,
          requiredString(row.version_id, "historical attachment version id"),
        );
      }
    }
    for (const [documentId, versionId] of inherited) {
      if (attachments.has(documentId)) continue;
      const current = this.database
        .prepare(
          `SELECT version.id AS version_id
             FROM documents document
             JOIN document_versions version
               ON version.id=document.current_version_id
              AND version.document_id=document.id
            WHERE document.id=? AND document.project_id IS NULL
              AND document.deleted_at IS NULL
              AND version.deleted_at IS NULL`,
        )
        .get(documentId);
      if (!current || current.version_id !== versionId) {
        throw new WorkspaceApiError(
          409,
          "PRECONDITION_FAILED",
          "A global chat attachment was deleted or replaced and must be explicitly re-attached before generation.",
        );
      }
    }
    const documentIds = [
      ...new Set([...inherited.keys(), ...attachments]),
    ].sort();
    if (documentIds.length > ASSISTANT_GENERATION_DOCUMENT_LIMIT) {
      throw new WorkspaceApiError(
        409,
        "PRECONDITION_FAILED",
        `Global Assistant generation supports at most ${ASSISTANT_GENERATION_DOCUMENT_LIMIT} inherited documents.`,
      );
    }
    return documentIds.map((documentId) => ({
      documentId,
      versionId: requestedById.get(documentId) ?? inherited.get(documentId)!,
      attached: attachments.has(documentId),
      attachmentId: attachmentIds.get(documentId) ?? null,
    }));
  }

  createGeneration(input: {
    chatId: string;
    promptMessageId: string;
    outputMessageId: string;
    jobId: string;
    modelProfileId: string;
    prompt: string;
    allowedDocumentIds: readonly string[];
    attachments: readonly { documentId: string; attachmentId: string }[];
    retrievalLimit: number;
    maxAttempts: number;
    now: string;
    jobs: AssistantJobEnqueuerPort;
  }) {
    if (!this.hasV5AssistantSchema()) {
      throw new WorkspaceApiError(
        503,
        "PRECONDITION_FAILED",
        "Assistant runtime migration is not installed.",
      );
    }
    return this.transaction(() => {
      const chat = this.require(input.chatId);
      this.assertNoActiveGeneration(chat.id);
      if (chat.status !== "active") {
        throw new WorkspaceApiError(
          409,
          "PRECONDITION_FAILED",
          "Chat must be active before generation.",
        );
      }
      if (chat.projectId) {
        const project = this.database
          .prepare("SELECT status FROM projects WHERE id=?")
          .get(chat.projectId);
        if (!project || project.status !== "active") {
          throw new WorkspaceApiError(
            409,
            "PRECONDITION_FAILED",
            "Project must be active before generation.",
          );
        }
      }
      const profile = this.database
        .prepare("SELECT enabled FROM model_profiles WHERE id=?")
        .get(input.modelProfileId);
      if (!profile || Number(profile.enabled) !== 1) {
        throw new WorkspaceApiError(
          409,
          "PRECONDITION_FAILED",
          "An enabled model profile is required before generation.",
        );
      }
      const documents = this.resolveGenerationDocumentsInCurrentTransaction({
        chat,
        allowedDocumentIds: input.allowedDocumentIds,
        attachments: input.attachments,
      });
      const sequence = this.nextSequence(input.chatId);
      const promptMessage = this.insertMessage({
        id: input.promptMessageId,
        chatId: input.chatId,
        sequence,
        role: "user",
        content: input.prompt,
        status: "complete",
        modelProfileId: input.modelProfileId,
        jobId: null,
        now: input.now,
      });
      for (const [ordinal, document] of documents.entries()) {
        const relationship = this.database
          .prepare(
            `SELECT document.id,version.filename,version.mime_type
               FROM documents document
               JOIN document_versions version
                 ON version.id=? AND version.document_id=document.id
              WHERE document.id=?
                AND document.deleted_at IS NULL
                AND version.deleted_at IS NULL
                AND document.current_version_id=version.id
                AND document.project_id IS ?`,
          )
          .get(document.versionId, document.documentId, chat.projectId);
        if (!relationship) {
          throw new WorkspaceApiError(
            409,
            "CONFLICT",
            "Generation documents must be current and remain in the chat scope.",
          );
        }
        if (document.attached) {
          if (!document.attachmentId) {
            corrupt(
              "Attached generation document is missing an attachment id.",
            );
          }
          this.database
            .prepare(
              `INSERT INTO chat_message_attachments
                (id,message_id,ordinal,document_id,version_id,
                 filename_snapshot,mime_type_snapshot,created_at)
               VALUES (?,?,?,?,?,?,?,?)`,
            )
            .run(
              document.attachmentId,
              input.promptMessageId,
              ordinal,
              document.documentId,
              document.versionId,
              relationship.filename,
              relationship.mime_type,
              input.now,
            );
        }
      }
      const payload: AssistantGenerationJobPayload = {
        schema: "vera-assistant-generation-v1",
        chatId: chat.id,
        projectId: chat.projectId,
        promptMessageId: input.promptMessageId,
        outputMessageId: input.outputMessageId,
        modelProfileId: input.modelProfileId,
        documents: documents.map(({ documentId, versionId, attached }) => ({
          documentId,
          versionId,
          attached,
        })),
        retrieval: {
          currentVersionOnly: true,
          limit: input.retrievalLimit,
        },
      };
      const job = input.jobs.enqueueJobInCurrentTransaction({
        id: input.jobId,
        type: "assistant_generate",
        payload,
        resourceType: "chat",
        resourceId: chat.id,
        maxAttempts: input.maxAttempts,
        now: input.now,
        queuedAt: input.now,
        idempotencyKey: null,
      });
      if (
        job.id !== input.jobId ||
        job.type !== "assistant_generate" ||
        job.status !== "queued"
      ) {
        throw new WorkspaceApiError(
          500,
          "INTERNAL_ERROR",
          "Assistant generation job was not enqueued in the queued state.",
        );
      }
      const outputMessage = this.insertMessage({
        id: input.outputMessageId,
        chatId: input.chatId,
        sequence: sequence + 1,
        role: "assistant",
        content: "",
        status: "pending",
        modelProfileId: input.modelProfileId,
        jobId: input.jobId,
        now: input.now,
      });
      this.database
        .prepare(
          `INSERT INTO assistant_generation_snapshots
            (job_id,chat_id,prompt_message_id,output_message_id,model_profile_id,
             current_version_only,retrieval_limit,created_at)
           VALUES (?,?,?,?,?,1,?,?)`,
        )
        .run(
          input.jobId,
          input.chatId,
          input.promptMessageId,
          input.outputMessageId,
          input.modelProfileId,
          input.retrievalLimit,
          input.now,
        );
      for (const [ordinal, document] of documents.entries()) {
        this.database
          .prepare(
            `INSERT INTO assistant_generation_documents
              (job_id,ordinal,document_id,version_id,attached)
             VALUES (?,?,?,?,?)`,
          )
          .run(
            input.jobId,
            ordinal,
            document.documentId,
            document.versionId,
            document.attached ? 1 : 0,
          );
      }
      this.database
        .prepare("UPDATE chats SET updated_at=? WHERE id=?")
        .run(input.now, input.chatId);
      return { jobId: input.jobId, promptMessage, outputMessage, payload };
    });
  }

  generationSnapshot(jobId: string): AssistantGenerationSnapshot {
    const row = this.database
      .prepare(
        `SELECT snapshot.*,prompt.content AS prompt
           FROM assistant_generation_snapshots snapshot
           JOIN chat_messages prompt ON prompt.id=snapshot.prompt_message_id
          WHERE snapshot.job_id=?`,
      )
      .get(jobId);
    if (!row) {
      throw new WorkspaceApiError(
        404,
        "NOT_FOUND",
        "Assistant generation snapshot not found.",
      );
    }
    if (Number(row.current_version_only) !== 1) {
      corrupt("Invalid persisted assistant retrieval version boundary.");
    }
    const documents = this.database
      .prepare(
        `SELECT document_id,version_id,attached
           FROM assistant_generation_documents
          WHERE job_id=? ORDER BY ordinal`,
      )
      .all(jobId)
      .map((document) => ({
        documentId: requiredString(
          document.document_id,
          "generation document id",
        ),
        versionId: requiredString(document.version_id, "generation version id"),
        attached: Number(document.attached) === 1,
      }));
    const chatId = requiredString(row.chat_id, "generation chat id");
    const chat = this.require(chatId);
    const payload: AssistantGenerationJobPayload = {
      schema: "vera-assistant-generation-v1",
      chatId,
      projectId: chat.projectId,
      promptMessageId: requiredString(
        row.prompt_message_id,
        "generation prompt message id",
      ),
      outputMessageId: requiredString(
        row.output_message_id,
        "generation output message id",
      ),
      modelProfileId: requiredString(
        row.model_profile_id,
        "generation model profile id",
      ),
      documents,
      retrieval: {
        currentVersionOnly: true,
        limit: requiredInteger(
          row.retrieval_limit,
          "generation retrieval limit",
        ),
      },
    };
    const job = this.database
      .prepare("SELECT payload_json FROM jobs WHERE id=?")
      .get(jobId);
    if (!job || typeof job.payload_json !== "string") {
      corrupt("Assistant generation job payload is missing.");
    }
    try {
      if (!isDeepStrictEqual(JSON.parse(job.payload_json), payload)) {
        corrupt("Assistant generation job payload drifted from its snapshot.");
      }
    } catch (error) {
      if (error instanceof WorkspaceApiError) throw error;
      corrupt("Assistant generation job payload is invalid.");
    }
    return {
      jobId,
      chatId,
      promptMessageId: payload.promptMessageId,
      outputMessageId: payload.outputMessageId,
      modelProfileId: payload.modelProfileId,
      currentVersionOnly: true,
      retrievalLimit: payload.retrieval.limit,
      documents,
      payload,
      prompt:
        typeof row.prompt === "string"
          ? row.prompt
          : corrupt("Invalid persisted generation prompt."),
      createdAt: requiredString(row.created_at, "generation createdAt"),
    };
  }

  generationHistory(jobId: string): AssistantConversationMessage[] {
    const snapshot = this.generationSnapshot(jobId);
    const rows = this.database
      .prepare(
        `SELECT message.*
           FROM chat_messages message
           JOIN chat_messages output
             ON output.id=? AND output.chat_id=message.chat_id
          WHERE message.chat_id=?
            AND message.sequence < output.sequence
            AND message.role IN ('user','assistant')
            AND message.status='complete'
          ORDER BY message.sequence,message.id`,
      )
      .all(snapshot.outputMessageId, snapshot.chatId);
    const history = rows.map((row): AssistantConversationMessage => {
      const message = mapMessage(row);
      if (message.role !== "user" && message.role !== "assistant") {
        corrupt("Invalid persisted assistant conversation role.");
      }
      return {
        id: message.id,
        role: message.role,
        content: message.content,
        attachments: this.attachments(message.id).map((attachment) => ({
          documentId: attachment.documentId,
          versionId: attachment.versionId,
          filename: attachment.filename,
        })),
      };
    });
    if (
      history.length === 0 ||
      history.at(-1)?.id !== snapshot.promptMessageId ||
      history.at(-1)?.role !== "user"
    ) {
      corrupt("Assistant generation history is missing its immutable prompt.");
    }
    return history;
  }

  assertGenerationDocumentsCurrent(jobId: string) {
    const stale = this.database
      .prepare(
        `SELECT 1 AS stale
           FROM assistant_generation_documents snapshot_document
           LEFT JOIN documents document
             ON document.id=snapshot_document.document_id
           LEFT JOIN document_versions version
             ON version.id=snapshot_document.version_id
            AND version.document_id=snapshot_document.document_id
          WHERE snapshot_document.job_id=?
            AND (
              document.id IS NULL OR
              document.deleted_at IS NOT NULL OR
              version.id IS NULL OR
              version.deleted_at IS NOT NULL OR
              document.current_version_id IS NOT snapshot_document.version_id
            )
          LIMIT 1`,
      )
      .get(jobId);
    if (stale) {
      throw new WorkspaceApiError(
        409,
        "PRECONDITION_FAILED",
        "Assistant generation document snapshots are no longer current.",
      );
    }
  }

  assertGenerationClaim(
    snapshot: AssistantGenerationSnapshot,
    claim: AssistantClaimIdentity,
    claims: AssistantClaimTransactionPort,
  ) {
    return this.transaction(() =>
      claims.assertClaimInCurrentTransaction({
        id: claim.jobId,
        type: "assistant_generate",
        resourceType: "chat",
        resourceId: snapshot.chatId,
        leaseOwner: claim.leaseOwner,
        attempt: claim.attempt,
        at: claim.at,
        payload: snapshot.payload,
      }),
    );
  }

  commitGenerationComplete(input: {
    snapshot: AssistantGenerationSnapshot;
    claim: AssistantClaimIdentity;
    claims: AssistantClaimTransactionPort;
    content: string;
    sources: readonly AssistantSourceWrite[];
    now: string;
  }) {
    return this.transaction(() => {
      const claimInput = {
        id: input.claim.jobId,
        type: "assistant_generate" as const,
        resourceType: "chat" as const,
        resourceId: input.snapshot.chatId,
        leaseOwner: input.claim.leaseOwner,
        attempt: input.claim.attempt,
        at: input.now,
        payload: input.snapshot.payload,
      };
      input.claims.assertClaimInCurrentTransaction(claimInput);
      this.assertGenerationDocumentsCurrent(input.claim.jobId);
      const persisted = this.generationSnapshot(input.claim.jobId);
      if (!isDeepStrictEqual(persisted.payload, input.snapshot.payload)) {
        corrupt("Assistant generation snapshot changed before commit.");
      }
      const output = this.database
        .prepare("SELECT status FROM chat_messages WHERE id=? AND job_id=?")
        .get(input.snapshot.outputMessageId, input.claim.jobId);
      if (!output || output.status !== "pending") {
        throw new WorkspaceApiError(
          409,
          "CONFLICT",
          "Assistant output message is not pending.",
        );
      }
      for (const source of input.sources) {
        const allowed = this.database
          .prepare(
            `SELECT 1 AS allowed FROM assistant_generation_documents
              WHERE job_id=? AND document_id=? AND version_id=?`,
          )
          .get(input.claim.jobId, source.documentId, source.versionId);
        if (!allowed) {
          throw new WorkspaceApiError(
            409,
            "CONFLICT",
            "Assistant source is outside the immutable generation snapshot.",
          );
        }
        this.insertSource({
          ...source,
          messageId: input.snapshot.outputMessageId,
          now: input.now,
        });
      }
      this.database
        .prepare(
          `UPDATE chat_messages
              SET content=?,status='complete',updated_at=?,completed_at=?
            WHERE id=? AND job_id=? AND status='pending'`,
        )
        .run(
          input.content,
          input.now,
          input.now,
          input.snapshot.outputMessageId,
          input.claim.jobId,
        );
      input.claims.finishClaimInCurrentTransaction({
        id: claimInput.id,
        type: claimInput.type,
        resourceType: claimInput.resourceType,
        resourceId: claimInput.resourceId,
        leaseOwner: claimInput.leaseOwner,
        attempt: claimInput.attempt,
        payload: claimInput.payload,
        event: {
          type: "complete",
          at: input.now,
          result: { messageId: input.snapshot.outputMessageId },
        },
      });
      return this.detail(input.snapshot.chatId);
    });
  }

  commitGenerationFailure(input: {
    snapshot: AssistantGenerationSnapshot;
    claim: AssistantClaimIdentity;
    claims: AssistantClaimTransactionPort;
    error: {
      code: string;
      message: string;
      retryable: boolean;
      details?: unknown;
    };
    content?: string;
    now: string;
  }) {
    return this.transaction(() => {
      const claimInput = {
        id: input.claim.jobId,
        type: "assistant_generate" as const,
        resourceType: "chat" as const,
        resourceId: input.snapshot.chatId,
        leaseOwner: input.claim.leaseOwner,
        attempt: input.claim.attempt,
        at: input.now,
        payload: input.snapshot.payload,
      };
      input.claims.assertClaimInCurrentTransaction(claimInput);
      this.database
        .prepare(
          `UPDATE chat_messages
              SET content=?,status='failed',error_code=?,updated_at=?,completed_at=?
            WHERE id=? AND job_id=? AND status='pending'`,
        )
        .run(
          input.content ?? "",
          input.error.code,
          input.now,
          input.now,
          input.snapshot.outputMessageId,
          input.claim.jobId,
        );
      input.claims.finishClaimInCurrentTransaction({
        id: claimInput.id,
        type: claimInput.type,
        resourceType: claimInput.resourceType,
        resourceId: claimInput.resourceId,
        leaseOwner: claimInput.leaseOwner,
        attempt: claimInput.attempt,
        payload: claimInput.payload,
        event: { type: "fail", at: input.now, error: input.error },
      });
    });
  }
}
