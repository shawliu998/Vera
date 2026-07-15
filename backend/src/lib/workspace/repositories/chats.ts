import { isDeepStrictEqual } from "node:util";

import {
  MikeAssistantStreamEventSchema,
  type MikeAssistantStreamEvent,
} from "../assistantCompatibility";
import type { WorkspaceDatabaseAdapter } from "../database";
import { WorkspaceApiError } from "../errors";
import { assertMikeSafePayload } from "../mikeCompatibility";
import {
  normalizePageRequest,
  type Page,
  type PageRequest,
} from "../pagination";
import type { Chat, ChatMessage, MessageSource } from "../types";
import {
  WorkspaceJobLeaseLostError,
  type WorkspaceJobsRepository,
} from "./jobs";

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
export const ASSISTANT_GENERATION_EVENT_PAGE_LIMIT = 100;
const ASSISTANT_GENERATION_EVENT_PAGE_CHAR_LIMIT = 2_000_000;
const ASSISTANT_GENERATION_EVENT_MAX_SEQUENCE = 2_147_483_647;
const JOB_STATUSES = [
  "queued",
  "running",
  "complete",
  "failed",
  "cancelled",
  "interrupted",
] as const;

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

export interface AssistantGenerationJobControlPort
  extends AssistantJobEnqueuerPort {
  getJob(id: string): {
    id: string;
    type: string;
    status: (typeof JOB_STATUSES)[number];
    resourceType: string;
    resourceId: string;
    attempt: number;
    maxAttempts: number;
    retryable: boolean;
    cancelRequestedAt: string | null;
  } | null;
  transitionJobInCurrentTransaction(
    id: string,
    event:
      | { type: "cancel"; at: string; reason?: string | null }
      | { type: "retry"; at: string },
  ): {
    id: string;
    type: string;
    status: string;
    attempt: number;
    maxAttempts: number;
  };
  requestCancellation(
    id: string,
    reason?: string | null,
  ): {
    id: string;
    status: string;
    cancelRequestedAt: string | null;
  };
}

export type AssistantClaimIdentity = Readonly<{
  jobId: string;
  leaseOwner: string;
  attempt: number;
  at: string;
}>;

export type AssistantClaimTransactionPort = Pick<
  WorkspaceJobsRepository,
  | "assertClaimInCurrentTransaction"
  | "finishClaimInCurrentTransaction"
  | "transitionJobInCurrentTransaction"
>;

export type AssistantGenerationStatus = Readonly<{
  jobId: string;
  chatId: string;
  promptMessageId: string;
  outputMessageId: string;
  status: (typeof JOB_STATUSES)[number];
  attempt: number;
  activeAttempt: number;
  maxAttempts: number;
  retryable: boolean;
  cancelRequested: boolean;
  terminal: boolean;
}>;

export type AssistantGenerationEventRecord = Readonly<{
  cursor: number;
  attempt: number;
  event: MikeAssistantStreamEvent;
  terminal: boolean;
  createdAt: string;
}>;

export type AssistantGenerationEventPage = Readonly<{
  jobId: string;
  status: AssistantGenerationStatus["status"];
  attempt: number;
  terminal: boolean;
  events: readonly AssistantGenerationEventRecord[];
  nextCursor: number;
}>;

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

  private hasV10AssistantEventSchema() {
    return Boolean(
      this.database
        .prepare(
          "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='assistant_generation_events'",
        )
        .get(),
    );
  }

  private requireV10AssistantEventSchema() {
    if (!this.hasV10AssistantEventSchema()) {
      throw new WorkspaceApiError(
        503,
        "PRECONDITION_FAILED",
        "Assistant durable event migration is not installed.",
      );
    }
  }

  private activeGenerationAttempt(status: string, attempt: number) {
    const active = status === "queued" ? attempt + 1 : Math.max(attempt, 1);
    if (!Number.isSafeInteger(active) || active < 1 || active > 100) {
      corrupt("Invalid persisted Assistant generation attempt.");
    }
    return active;
  }

  private generationStatusInCurrentTransaction(
    jobId: string,
  ): AssistantGenerationStatus {
    const row = this.database
      .prepare(
        `SELECT snapshot.job_id,snapshot.chat_id,snapshot.prompt_message_id,
                snapshot.output_message_id,job.status,job.attempt,
                job.max_attempts,job.retryable,job.cancel_requested_at
           FROM assistant_generation_snapshots snapshot
           JOIN jobs job
             ON job.id=snapshot.job_id
            AND job.type='assistant_generate'
            AND job.resource_type='chat'
            AND job.resource_id=snapshot.chat_id
          WHERE snapshot.job_id=?`,
      )
      .get(jobId);
    if (!row) {
      throw new WorkspaceApiError(
        404,
        "NOT_FOUND",
        "Assistant generation job not found.",
      );
    }
    const status = enumValue(row.status, JOB_STATUSES, "generation job status");
    const attempt = requiredInteger(row.attempt, "generation job attempt");
    const maxAttempts = requiredInteger(
      row.max_attempts,
      "generation job max attempts",
    );
    if (maxAttempts < 1 || maxAttempts > 100 || attempt > maxAttempts) {
      corrupt("Invalid persisted Assistant generation attempt bounds.");
    }
    const retryable = requiredInteger(
      row.retryable,
      "generation job retryable flag",
    );
    if (retryable !== 0 && retryable !== 1) {
      corrupt("Invalid persisted Assistant generation retryable flag.");
    }
    return {
      jobId: requiredString(row.job_id, "generation job id"),
      chatId: requiredString(row.chat_id, "generation chat id"),
      promptMessageId: requiredString(
        row.prompt_message_id,
        "generation prompt message id",
      ),
      outputMessageId: requiredString(
        row.output_message_id,
        "generation output message id",
      ),
      status,
      attempt,
      activeAttempt: this.activeGenerationAttempt(status, attempt),
      maxAttempts,
      retryable: retryable === 1,
      cancelRequested: row.cancel_requested_at !== null,
      terminal: ["complete", "failed", "cancelled", "interrupted"].includes(
        status,
      ),
    };
  }

  private insertGenerationEventInCurrentTransaction(input: {
    jobId: string;
    attempt: number;
    event: MikeAssistantStreamEvent;
    terminal?: boolean;
    now: string;
  }): AssistantGenerationEventRecord {
    this.requireV10AssistantEventSchema();
    const event = MikeAssistantStreamEventSchema.parse(input.event);
    assertMikeSafePayload(event);
    const terminal = input.terminal === true;
    if (terminal !== (event.type === "complete" || event.type === "error")) {
      throw new WorkspaceApiError(
        500,
        "INTERNAL_ERROR",
        "Assistant terminal event classification is invalid.",
      );
    }
    if (
      !Number.isSafeInteger(input.attempt) ||
      input.attempt < 1 ||
      input.attempt > 100
    ) {
      throw new WorkspaceApiError(
        500,
        "INTERNAL_ERROR",
        "Assistant event attempt is invalid.",
      );
    }
    const serialized = JSON.stringify(event);
    const sequence = requiredInteger(
      this.database
        .prepare(
          `SELECT coalesce(max(sequence),0)+1 AS sequence
             FROM assistant_generation_events WHERE job_id=?`,
        )
        .get(input.jobId)?.sequence,
      "next Assistant event sequence",
    );
    if (sequence > ASSISTANT_GENERATION_EVENT_MAX_SEQUENCE) {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Assistant event sequence limit reached.",
      );
    }
    try {
      this.database
        .prepare(
          `INSERT INTO assistant_generation_events
            (job_id,sequence,attempt,event_type,event_json,terminal,created_at)
           VALUES (?,?,?,?,?,?,?)`,
        )
        .run(
          input.jobId,
          sequence,
          input.attempt,
          event.type,
          serialized,
          terminal ? 1 : 0,
          input.now,
        );
    } catch (error) {
      if (/idx_assistant_generation_events_terminal/i.test(String(error))) {
        throw new WorkspaceApiError(
          409,
          "CONFLICT",
          "Assistant generation attempt already has a terminal event.",
        );
      }
      throw error;
    }
    return {
      cursor: sequence,
      attempt: input.attempt,
      event,
      terminal,
      createdAt: input.now,
    };
  }

  private hasGenerationEvent(input: {
    jobId: string;
    attempt: number;
    eventType: MikeAssistantStreamEvent["type"];
    status?: string;
  }) {
    const parameters: unknown[] = [
      input.jobId,
      input.attempt,
      input.eventType,
    ];
    const statusClause = input.status
      ? "AND json_extract(event_json,'$.status')=?"
      : "";
    if (input.status) parameters.push(input.status);
    return Boolean(
      this.database
        .prepare(
          `SELECT 1 AS present FROM assistant_generation_events
            WHERE job_id=? AND attempt=? AND event_type=? ${statusClause}
            LIMIT 1`,
        )
        .get(...parameters),
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
      this.requireV10AssistantEventSchema();
      this.insertGenerationEventInCurrentTransaction({
        jobId: input.jobId,
        attempt: 1,
        event: { type: "chat_id", chatId: input.chatId },
        now: input.now,
      });
      this.insertGenerationEventInCurrentTransaction({
        jobId: input.jobId,
        attempt: 1,
        event: {
          type: "status",
          job_id: input.jobId,
          status: "queued",
        },
        now: input.now,
      });
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

  beginGenerationAttempt(input: {
    snapshot: AssistantGenerationSnapshot;
    claim: AssistantClaimIdentity;
    claims: AssistantClaimTransactionPort;
    now: string;
  }) {
    return this.transaction(() => {
      this.requireV10AssistantEventSchema();
      input.claims.assertClaimInCurrentTransaction({
        id: input.claim.jobId,
        type: "assistant_generate",
        resourceType: "chat",
        resourceId: input.snapshot.chatId,
        leaseOwner: input.claim.leaseOwner,
        attempt: input.claim.attempt,
        at: input.now,
        payload: input.snapshot.payload,
      });
      const status = this.generationStatusInCurrentTransaction(
        input.claim.jobId,
      );
      if (
        status.status !== "running" ||
        status.activeAttempt !== input.claim.attempt
      ) {
        throw new WorkspaceJobLeaseLostError();
      }
      if (
        !this.hasGenerationEvent({
          jobId: status.jobId,
          attempt: status.activeAttempt,
          eventType: "chat_id",
        })
      ) {
        this.insertGenerationEventInCurrentTransaction({
          jobId: status.jobId,
          attempt: status.activeAttempt,
          event: { type: "chat_id", chatId: status.chatId },
          now: input.now,
        });
      }
      if (
        status.activeAttempt > 1 &&
        !this.hasGenerationEvent({
          jobId: status.jobId,
          attempt: status.activeAttempt,
          eventType: "status",
          status: "retrying",
        })
      ) {
        this.insertGenerationEventInCurrentTransaction({
          jobId: status.jobId,
          attempt: status.activeAttempt,
          event: {
            type: "status",
            job_id: status.jobId,
            status: "retrying",
          },
          now: input.now,
        });
      }
      if (
        !this.hasGenerationEvent({
          jobId: status.jobId,
          attempt: status.activeAttempt,
          eventType: "status",
          status: "running",
        })
      ) {
        this.insertGenerationEventInCurrentTransaction({
          jobId: status.jobId,
          attempt: status.activeAttempt,
          event: {
            type: "status",
            job_id: status.jobId,
            status: "running",
          },
          now: input.now,
        });
      }
      return status;
    });
  }

  appendGenerationEvent(input: {
    snapshot: AssistantGenerationSnapshot;
    claim: AssistantClaimIdentity;
    claims: AssistantClaimTransactionPort;
    event: MikeAssistantStreamEvent;
    now: string;
  }) {
    if (input.event.type === "complete" || input.event.type === "error") {
      throw new WorkspaceApiError(
        500,
        "INTERNAL_ERROR",
        "Assistant terminal events must be committed with the terminal job state.",
      );
    }
    return this.transaction(() => {
      input.claims.assertClaimInCurrentTransaction({
        id: input.claim.jobId,
        type: "assistant_generate",
        resourceType: "chat",
        resourceId: input.snapshot.chatId,
        leaseOwner: input.claim.leaseOwner,
        attempt: input.claim.attempt,
        at: input.now,
        payload: input.snapshot.payload,
      });
      const status = this.generationStatusInCurrentTransaction(
        input.claim.jobId,
      );
      if (
        status.status !== "running" ||
        status.activeAttempt !== input.claim.attempt
      ) {
        throw new WorkspaceJobLeaseLostError();
      }
      return this.insertGenerationEventInCurrentTransaction({
        jobId: status.jobId,
        attempt: status.activeAttempt,
        event: input.event,
        now: input.now,
      });
    });
  }

  private terminalEvent(status: AssistantGenerationStatus) {
    if (status.status === "complete") {
      return MikeAssistantStreamEventSchema.parse({
        type: "complete",
        message_id: status.outputMessageId,
        job_id: status.jobId,
      });
    }
    const values = {
      cancelled: {
        code: "assistant_cancelled",
        message: "Assistant generation was cancelled.",
      },
      interrupted: {
        code: "assistant_generation_interrupted",
        message: "Assistant generation was interrupted.",
      },
      failed: {
        code: "assistant_generation_failed",
        message: "Assistant generation failed.",
      },
    } as const;
    const value =
      status.status === "cancelled" ||
      status.status === "interrupted" ||
      status.status === "failed"
        ? values[status.status]
        : corrupt("Assistant terminal event requested for an active job.");
    return MikeAssistantStreamEventSchema.parse({
      type: "error",
      code: value.code,
      message: value.message,
    });
  }

  private reconcileGenerationTerminalInCurrentTransaction(
    status: AssistantGenerationStatus,
    now: string,
  ) {
    if (!status.terminal) return status;
    const output = this.database
      .prepare("SELECT status FROM chat_messages WHERE id=? AND job_id=?")
      .get(status.outputMessageId, status.jobId);
    if (!output) corrupt("Assistant generation output message is missing.");
    const outputStatus = enumValue(
      output.status,
      MESSAGE_STATUSES,
      "Assistant output message status",
    );
    if (status.status === "complete") {
      if (outputStatus !== "complete") {
        corrupt("Completed Assistant job is missing its completed message.");
      }
    } else {
      const expected = status.status;
      if (outputStatus === "pending" || outputStatus === "streaming") {
        this.database
          .prepare(
            `UPDATE chat_messages
                SET status=?,error_code=?,updated_at=?,completed_at=?
              WHERE id=? AND job_id=? AND status IN ('pending','streaming')`,
          )
          .run(
            expected,
            expected === "cancelled"
              ? "assistant_cancelled"
              : expected === "interrupted"
                ? "assistant_generation_interrupted"
                : "assistant_generation_failed",
            now,
            now,
            status.outputMessageId,
            status.jobId,
          );
      } else if (outputStatus !== expected) {
        corrupt("Assistant job and output message terminal states diverged.");
      }
    }
    if (
      !this.database
        .prepare(
          `SELECT 1 AS present FROM assistant_generation_events
            WHERE job_id=? AND attempt=? AND terminal=1`,
        )
        .get(status.jobId, status.activeAttempt)
    ) {
      if (status.status === "complete") {
        this.insertGenerationEventInCurrentTransaction({
          jobId: status.jobId,
          attempt: status.activeAttempt,
          event: { type: "content_done" },
          now,
        });
      }
      this.insertGenerationEventInCurrentTransaction({
        jobId: status.jobId,
        attempt: status.activeAttempt,
        event: this.terminalEvent(status),
        terminal: true,
        now,
      });
    }
    return status;
  }

  generationStatus(jobId: string) {
    this.requireV10AssistantEventSchema();
    return this.transaction(() => {
      const status = this.generationStatusInCurrentTransaction(jobId);
      return this.reconcileGenerationTerminalInCurrentTransaction(
        status,
        new Date().toISOString(),
      );
    });
  }

  listGenerationStatuses(chatId: string, limit = 20) {
    this.require(chatId);
    this.requireV10AssistantEventSchema();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
      throw new WorkspaceApiError(
        400,
        "VALIDATION_ERROR",
        "Assistant generation status limit must be between 1 and 20.",
      );
    }
    return this.transaction(() => {
      const rows = this.database
        .prepare(
          `SELECT snapshot.job_id
             FROM assistant_generation_snapshots snapshot
            WHERE snapshot.chat_id=?
            ORDER BY snapshot.created_at DESC,snapshot.job_id DESC
            LIMIT ?`,
        )
        .all(chatId, limit);
      const now = new Date().toISOString();
      return rows.map((row) => {
        const status = this.generationStatusInCurrentTransaction(
          requiredString(row.job_id, "generation job id"),
        );
        return this.reconcileGenerationTerminalInCurrentTransaction(status, now);
      });
    });
  }

  listGenerationEvents(
    jobId: string,
    input: { cursor?: number; limit?: number } = {},
  ): AssistantGenerationEventPage {
    this.requireV10AssistantEventSchema();
    const cursor = input.cursor ?? 0;
    const limit = input.limit ?? ASSISTANT_GENERATION_EVENT_PAGE_LIMIT;
    if (
      !Number.isSafeInteger(cursor) ||
      cursor < 0 ||
      cursor > ASSISTANT_GENERATION_EVENT_MAX_SEQUENCE
    ) {
      throw new WorkspaceApiError(
        400,
        "VALIDATION_ERROR",
        "Assistant event cursor is invalid.",
      );
    }
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > ASSISTANT_GENERATION_EVENT_PAGE_LIMIT
    ) {
      throw new WorkspaceApiError(
        400,
        "VALIDATION_ERROR",
        `Assistant event limit must be between 1 and ${ASSISTANT_GENERATION_EVENT_PAGE_LIMIT}.`,
      );
    }
    return this.transaction(() => {
      let status = this.generationStatusInCurrentTransaction(jobId);
      status = this.reconcileGenerationTerminalInCurrentTransaction(
        status,
        new Date().toISOString(),
      );
      const maximum = requiredInteger(
        this.database
          .prepare(
            `SELECT coalesce(max(sequence),0) AS sequence
               FROM assistant_generation_events WHERE job_id=?`,
          )
          .get(jobId)?.sequence,
        "Assistant event maximum cursor",
      );
      if (cursor > maximum) {
        throw new WorkspaceApiError(
          409,
          "CONFLICT",
          "Assistant event cursor is ahead of the durable stream.",
        );
      }
      const rows = this.database
        .prepare(
          `SELECT sequence,attempt,event_json,terminal,created_at
             FROM assistant_generation_events
            WHERE job_id=? AND attempt=? AND sequence>?
            ORDER BY sequence
            LIMIT ?`,
        )
        .all(jobId, status.activeAttempt, cursor, limit);
      const events: AssistantGenerationEventRecord[] = [];
      let characters = 0;
      for (const row of rows) {
        if (typeof row.event_json !== "string") {
          corrupt("Invalid persisted Assistant event JSON.");
        }
        characters += row.event_json.length;
        if (
          characters > ASSISTANT_GENERATION_EVENT_PAGE_CHAR_LIMIT &&
          events.length > 0
        ) {
          break;
        }
        let event: MikeAssistantStreamEvent;
        try {
          event = MikeAssistantStreamEventSchema.parse(
            JSON.parse(row.event_json),
          );
          assertMikeSafePayload(event);
        } catch {
          corrupt("Invalid persisted Assistant event payload.");
        }
        const terminal = requiredInteger(
          row.terminal,
          "Assistant event terminal flag",
        );
        if (terminal !== 0 && terminal !== 1) {
          corrupt("Invalid persisted Assistant event terminal flag.");
        }
        events.push({
          cursor: requiredInteger(row.sequence, "Assistant event cursor"),
          attempt: requiredInteger(row.attempt, "Assistant event attempt"),
          event,
          terminal: terminal === 1,
          createdAt: requiredString(row.created_at, "Assistant event createdAt"),
        });
      }
      return {
        jobId,
        status: status.status,
        attempt: status.activeAttempt,
        terminal: status.terminal,
        events,
        nextCursor: events.at(-1)?.cursor ?? cursor,
      };
    });
  }

  cancelQueuedGeneration(input: {
    jobId: string;
    reason?: string | null;
    now: string;
    jobs: AssistantGenerationJobControlPort;
  }) {
    return this.transaction(() => {
      const status = this.generationStatusInCurrentTransaction(input.jobId);
      if (status.status !== "queued") {
        throw new WorkspaceApiError(
          409,
          "CONFLICT",
          "Only a queued Assistant generation may be cancelled atomically.",
        );
      }
      const cancelled = input.jobs.transitionJobInCurrentTransaction(
        input.jobId,
        { type: "cancel", at: input.now, reason: input.reason },
      );
      if (cancelled.status !== "cancelled") {
        corrupt("Assistant queued cancellation did not reach a terminal state.");
      }
      const updated = this.database
        .prepare(
          `UPDATE chat_messages
              SET status='cancelled',error_code='assistant_cancelled',
                  updated_at=?,completed_at=?
            WHERE id=? AND job_id=? AND status='pending'`,
        )
        .run(input.now, input.now, status.outputMessageId, input.jobId) as {
        changes?: unknown;
      };
      if (Number(updated?.changes ?? 0) !== 1) {
        corrupt("Assistant queued cancellation did not update its output message.");
      }
      const terminalStatus = this.generationStatusInCurrentTransaction(
        input.jobId,
      );
      this.insertGenerationEventInCurrentTransaction({
        jobId: input.jobId,
        attempt: terminalStatus.activeAttempt,
        event: this.terminalEvent(terminalStatus),
        terminal: true,
        now: input.now,
      });
      return terminalStatus;
    });
  }

  retryGeneration(input: {
    jobId: string;
    now: string;
    jobs: AssistantGenerationJobControlPort;
  }) {
    return this.transaction(() => {
      const status = this.generationStatusInCurrentTransaction(input.jobId);
      if (
        (status.status !== "failed" && status.status !== "interrupted") ||
        !status.retryable ||
        status.attempt >= status.maxAttempts
      ) {
        throw new WorkspaceApiError(
          409,
          "CONFLICT",
          "Assistant generation is not eligible for retry.",
        );
      }
      const retried = input.jobs.transitionJobInCurrentTransaction(
        input.jobId,
        { type: "retry", at: input.now },
      );
      if (retried.status !== "queued") {
        corrupt("Assistant retry did not return to the queued state.");
      }
      const reset = this.database
        .prepare(
          `UPDATE chat_messages
              SET content='',status='pending',error_code=NULL,
                  updated_at=?,completed_at=NULL
            WHERE id=? AND job_id=? AND status IN ('failed','interrupted')`,
        )
        .run(input.now, status.outputMessageId, input.jobId) as {
        changes?: unknown;
      };
      if (Number(reset?.changes ?? 0) !== 1) {
        corrupt("Assistant retry did not reset its output message.");
      }
      this.database
        .prepare("DELETE FROM message_sources WHERE message_id=?")
        .run(status.outputMessageId);
      const queued = this.generationStatusInCurrentTransaction(input.jobId);
      this.insertGenerationEventInCurrentTransaction({
        jobId: queued.jobId,
        attempt: queued.activeAttempt,
        event: { type: "chat_id", chatId: queued.chatId },
        now: input.now,
      });
      this.insertGenerationEventInCurrentTransaction({
        jobId: queued.jobId,
        attempt: queued.activeAttempt,
        event: {
          type: "status",
          job_id: queued.jobId,
          status: "retrying",
        },
        now: input.now,
      });
      this.insertGenerationEventInCurrentTransaction({
        jobId: queued.jobId,
        attempt: queued.activeAttempt,
        event: { type: "status", job_id: queued.jobId, status: "queued" },
        now: input.now,
      });
      return queued;
    });
  }

  commitGenerationCancellation(input: {
    snapshot: AssistantGenerationSnapshot;
    claim: AssistantClaimIdentity;
    claims: AssistantClaimTransactionPort;
    content?: string;
    now: string;
  }) {
    return this.transaction(() => {
      const fence = this.database
        .prepare(
          `SELECT cancel_requested_at,cancellation_reason
             FROM jobs
            WHERE id=? AND type='assistant_generate'
              AND resource_type='chat' AND resource_id=?
              AND status='running' AND lease_owner=? AND attempt=?
              AND lease_expires_at>?`,
        )
        .get(
          input.claim.jobId,
          input.snapshot.chatId,
          input.claim.leaseOwner,
          input.claim.attempt,
          input.now,
        );
      if (!fence) throw new WorkspaceJobLeaseLostError();
      if (fence.cancel_requested_at === null) return false;
      const cancelled = input.claims.transitionJobInCurrentTransaction(
        input.claim.jobId,
        {
          type: "cancel",
          at: input.now,
          reason:
            typeof fence.cancellation_reason === "string"
              ? fence.cancellation_reason
              : "Assistant generation cancellation requested.",
        },
      );
      if (cancelled.status !== "cancelled") {
        corrupt("Assistant claimed cancellation did not reach a terminal state.");
      }
      const updated = this.database
        .prepare(
          `UPDATE chat_messages
              SET content=?,status='cancelled',error_code='assistant_cancelled',
                  updated_at=?,completed_at=?
            WHERE id=? AND job_id=? AND status='pending'`,
        )
        .run(
          input.content ?? "",
          input.now,
          input.now,
          input.snapshot.outputMessageId,
          input.claim.jobId,
        ) as { changes?: unknown };
      if (Number(updated?.changes ?? 0) !== 1) {
        corrupt("Assistant claimed cancellation did not update its output message.");
      }
      const terminalStatus = this.generationStatusInCurrentTransaction(
        input.claim.jobId,
      );
      this.insertGenerationEventInCurrentTransaction({
        jobId: input.claim.jobId,
        attempt: terminalStatus.activeAttempt,
        event: this.terminalEvent(terminalStatus),
        terminal: true,
        now: input.now,
      });
      return true;
    });
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
      this.insertGenerationEventInCurrentTransaction({
        jobId: input.claim.jobId,
        attempt: input.claim.attempt,
        event: { type: "content_done" },
        now: input.now,
      });
      this.insertGenerationEventInCurrentTransaction({
        jobId: input.claim.jobId,
        attempt: input.claim.attempt,
        event: {
          type: "complete",
          message_id: input.snapshot.outputMessageId,
          job_id: input.claim.jobId,
        },
        terminal: true,
        now: input.now,
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
      this.insertGenerationEventInCurrentTransaction({
        jobId: input.claim.jobId,
        attempt: input.claim.attempt,
        event: {
          type: "error",
          code: input.error.code,
          message: input.error.message,
        },
        terminal: true,
        now: input.now,
      });
    });
  }
}
