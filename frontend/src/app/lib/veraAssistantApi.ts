// Vera local transport for the Assistant UI ported from Mike
// e32daad5a4c64a5561e04c53ee12411e3c5e7238. The HTTP shapes intentionally
// retain Mike's public field names while generation itself is a durable Vera
// job. No remote-auth SDK, hosted session, or browser-persisted bearer enters
// this boundary.
import {
  veraApiErrorFromResponse,
  veraApiFetch,
  veraApiRequest,
  VeraApiError,
} from "./veraApi";
import { VeraRuntimeConfigurationError } from "./veraRuntime";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CANONICAL_UTC_MILLISECONDS =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_SSE_FRAME_CHARS = 1_000_000;
const MAX_CHAT_MESSAGES = 1_000;
const MAX_CHAT_FILES = 50;
const MAX_CITATIONS = 1_000;
const MAX_MESSAGE_DURABLE_EVENTS = 10;
const MAX_ASSISTANT_ATTEMPTS = 100;
const MAX_ASSISTANT_EVENT_CURSOR = 2_147_483_647;

export const VERA_ASSISTANT_JOB_STATUSES = [
  "queued",
  "running",
  "complete",
  "failed",
  "cancelled",
  "interrupted",
] as const;

export type VeraAssistantJobStatusValue =
  (typeof VERA_ASSISTANT_JOB_STATUSES)[number];

export interface VeraAssistantChat {
  id: string;
  project_id: string | null;
  user_id: string;
  title: string | null;
  created_at: string;
}

export interface VeraAssistantFile {
  filename: string;
  document_id: string;
  version_id: string;
  capability: { can_read: boolean; can_download: boolean };
}

export interface VeraAssistantCitationQuote {
  page: number | string;
  quote: string;
}

export interface VeraAssistantDocumentCitation {
  type: "citation_data";
  kind: "document";
  ref: number;
  doc_id: string;
  document_id: string;
  version_id: string;
  filename: string;
  page: number | string;
  quote: string;
  quotes: VeraAssistantCitationQuote[];
}

export type VeraAssistantLegalAuthorityLocator = Readonly<{
  article?: string;
  section?: string;
  paragraph?: string;
  page?: number;
}>;

export interface VeraAssistantLegalAuthorityCitation {
  type: "citation_data";
  kind: "legal_authority";
  ref: number;
  title: string;
  source_type:
    | "statute"
    | "regulation"
    | "judicial_interpretation"
    | "case"
    | "guidance";
  locator: VeraAssistantLegalAuthorityLocator;
  quote: string;
}

export type VeraAssistantCitation =
  | VeraAssistantDocumentCitation
  | VeraAssistantLegalAuthorityCitation;

export interface VeraAssistantMessage {
  id: string;
  chat_id: string;
  role: "user" | "assistant";
  content: string | Array<{ type: "content"; text: string }>;
  files?: VeraAssistantFile[];
  citations?: VeraAssistantCitation[];
  events?: VeraAssistantMessageEvent[];
  created_at: string;
}

export interface VeraAssistantChatDetail {
  chat: VeraAssistantChat;
  messages: VeraAssistantMessage[];
}

export interface VeraAssistantGenerationAccepted {
  chat_id: string;
  job_id: string;
  prompt_message_id: string;
  output_message_id: string;
  status: "queued";
}

export interface VeraAssistantGenerationStatus {
  job_id: string;
  chat_id: string;
  prompt_message_id: string;
  output_message_id: string;
  status: VeraAssistantJobStatusValue;
  attempt: number;
  max_attempts: number;
  retryable: boolean;
  cancel_requested: boolean;
  terminal: boolean;
  active_attempt: number;
}

export type VeraAssistantStreamEvent =
  | { type: "chat_id"; chatId: string }
  | {
      type: "status";
      job_id: string;
      status: "queued" | "running" | "retrying";
    }
  | { type: "content_delta"; text: string }
  | { type: "content_done" }
  | { type: "reasoning_delta"; text: string }
  | { type: "reasoning_block_end" }
  | {
      type: "tool_call_start";
      name:
        | "list_documents"
        | "read_document"
        | "fetch_documents"
        | "find_in_document"
        | "read_studio_document"
        | "suggest_studio_edit"
        | "create_draft"
        | "read_draft"
        | "suggest_draft_edit"
        | "list_workflows"
        | "read_workflow"
        | "run_workflow"
        | "get_workflow_run"
        | "search_legal_sources"
        | "read_legal_source";
    }
  | { type: "doc_read_start"; filename: string }
  | { type: "doc_read"; filename: string; document_id?: string }
  | { type: "doc_find_start"; filename: string; query: string }
  | {
      type: "doc_find";
      filename: string;
      query: string;
      total_matches: number;
    }
  | { type: "workflow_applied"; workflow_id: string; title: string }
  | {
      type: "draft_created";
      draft_id: string;
      version_id: string;
      title: string;
      route: string;
    }
  | VeraAssistantCitation
  | { type: "complete"; message_id: string; job_id: string }
  | { type: "error"; code?: string; message: string };

export type VeraAssistantMessageEvent = Extract<
  VeraAssistantStreamEvent,
  { type: "draft_created" }
>;

export interface VeraAssistantDurableEvent {
  cursor: number;
  attempt: number;
  event: VeraAssistantStreamEvent;
  terminal: boolean;
  created_at: string;
}

export interface VeraAssistantReplay {
  job_id: string;
  status: VeraAssistantJobStatusValue;
  attempt: number;
  terminal: boolean;
  events: VeraAssistantDurableEvent[];
  next_cursor: number;
}

export interface VeraAssistantCancelResult {
  job_id: string;
  status: VeraAssistantJobStatusValue;
  cancel_requested: boolean;
  terminal: boolean;
}

export interface VeraAssistantGenerationMessageInput {
  role: "user" | "assistant";
  content: string;
  files?: Array<{ filename: string; document_id?: string }>;
}

export interface VeraAssistantGenerationInput {
  messages: VeraAssistantGenerationMessageInput[];
  chat_id?: string;
  project_id?: string;
  model_profile_id?: string;
  displayed_doc?: { filename: string; document_id: string };
  attached_documents?: Array<{ filename: string; document_id: string }>;
}

function invalid(label: string): never {
  throw new VeraApiError({
    status: 200,
    code: "INVALID_RESPONSE",
    message: `The Vera API returned invalid ${label}.`,
  });
}

function normalizedKey(key: string) {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toLowerCase();
}

function sensitiveKey(key: string) {
  const name = normalizedKey(key);
  return (
    name === "secret" ||
    name.endsWith("_secret") ||
    name === "api_key" ||
    name.endsWith("_api_key") ||
    name === "credential_ref" ||
    name.endsWith("_credential_ref") ||
    name === "credential_reference" ||
    name.endsWith("_credential_reference") ||
    name === "provider_response" ||
    name === "provider_response_body" ||
    name === "raw_provider_response" ||
    name === "raw_provider_body"
  );
}

/** Fail closed if a provider/credential implementation detail crosses UI IPC. */
export function assertNoVeraAssistantSensitiveFields(value: unknown): void {
  const seen = new Set<object>();
  const visit = (candidate: unknown): void => {
    if (typeof candidate !== "object" || candidate === null) return;
    if (seen.has(candidate)) return;
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    for (const [key, nested] of Object.entries(candidate)) {
      if (sensitiveKey(key)) invalid("Assistant sensitive response field");
      visit(nested);
    }
  };
  visit(value);
}

function record(value: unknown, label: string): Record<string, unknown> {
  assertNoVeraAssistantSensitiveFields(value);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid(label);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
  label = "response",
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    invalid(label);
  }
}

function stringValue(
  value: unknown,
  label: string,
  max = 200_000,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string" ||
    value.length > max ||
    (!allowEmpty && value.trim().length === 0)
  ) {
    return invalid(label);
  }
  return value;
}

function nullableString(
  value: unknown,
  label: string,
  max = 240,
): string | null {
  return value === null ? null : stringValue(value, label, max);
}

function uuid(value: unknown, label: string): string {
  const parsed = stringValue(value, label, 36);
  if (!UUID.test(parsed)) return invalid(label);
  return parsed;
}

function timestamp(value: unknown, label: string): string {
  const parsed = stringValue(value, label, 48);
  const milliseconds = Date.parse(parsed);
  if (
    !CANONICAL_UTC_MILLISECONDS.test(parsed) ||
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== parsed
  ) {
    return invalid(label);
  }
  return parsed;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") return invalid(label);
  return value;
}

function integer(
  value: unknown,
  label: string,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < minimum ||
    Number(value) > maximum
  ) {
    return invalid(label);
  }
  return Number(value);
}

function enumValue<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  label: string,
): Values[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    return invalid(label);
  }
  return value as Values[number];
}

function pageValue(value: unknown, label: string): number | string {
  if (Number.isSafeInteger(value) && Number(value) > 0) return Number(value);
  return stringValue(value, label, 50);
}

export function parseVeraAssistantChat(value: unknown): VeraAssistantChat {
  const raw = record(value, "Assistant chat");
  exactKeys(
    raw,
    ["id", "project_id", "user_id", "title", "created_at"],
    [],
    "Assistant chat",
  );
  return {
    id: uuid(raw.id, "Assistant chat id"),
    project_id:
      raw.project_id === null
        ? null
        : uuid(raw.project_id, "Assistant project id"),
    user_id: uuid(raw.user_id, "Assistant user id"),
    title: nullableString(raw.title, "Assistant chat title"),
    created_at: timestamp(raw.created_at, "Assistant chat timestamp"),
  };
}

function parseCapability(value: unknown) {
  const raw = record(value, "Assistant file capability");
  exactKeys(raw, ["can_read", "can_download"], [], "Assistant file capability");
  return {
    can_read: booleanValue(raw.can_read, "Assistant file read capability"),
    can_download: booleanValue(
      raw.can_download,
      "Assistant file download capability",
    ),
  };
}

function parseFile(value: unknown): VeraAssistantFile {
  const raw = record(value, "Assistant file");
  exactKeys(
    raw,
    ["filename", "document_id", "version_id", "capability"],
    [],
    "Assistant file",
  );
  return {
    filename: stringValue(raw.filename, "Assistant filename", 500),
    document_id: uuid(raw.document_id, "Assistant document id"),
    version_id: uuid(raw.version_id, "Assistant document version id"),
    capability: parseCapability(raw.capability),
  };
}

export function parseVeraAssistantCitation(
  value: unknown,
): VeraAssistantCitation {
  const raw = record(value, "Assistant citation");
  if (raw.kind === "legal_authority") {
    exactKeys(
      raw,
      ["type", "kind", "ref", "title", "source_type", "locator", "quote"],
      [],
      "Assistant legal authority citation",
    );
    if (raw.type !== "citation_data") {
      return invalid("Assistant legal authority citation type");
    }
    const locator = record(
      raw.locator,
      "Assistant legal authority citation locator",
    );
    exactKeys(
      locator,
      [],
      ["article", "section", "paragraph", "page"],
      "Assistant legal authority citation locator",
    );
    return {
      type: "citation_data",
      kind: "legal_authority",
      ref: integer(raw.ref, "Assistant legal authority citation ref", 1, 200),
      title: stringValue(
        raw.title,
        "Assistant legal authority citation title",
        500,
      ),
      source_type: enumValue(
        raw.source_type,
        [
          "statute",
          "regulation",
          "judicial_interpretation",
          "case",
          "guidance",
        ] as const,
        "Assistant legal authority citation source type",
      ),
      locator: {
        ...(locator.article === undefined
          ? {}
          : {
              article: stringValue(
                locator.article,
                "Assistant legal authority citation article",
                160,
              ),
            }),
        ...(locator.section === undefined
          ? {}
          : {
              section: stringValue(
                locator.section,
                "Assistant legal authority citation section",
                300,
              ),
            }),
        ...(locator.paragraph === undefined
          ? {}
          : {
              paragraph: stringValue(
                locator.paragraph,
                "Assistant legal authority citation paragraph",
                160,
              ),
            }),
        ...(locator.page === undefined
          ? {}
          : {
              page: integer(
                locator.page,
                "Assistant legal authority citation page",
                1,
                1_000_000,
              ),
            }),
      },
      quote: stringValue(
        raw.quote,
        "Assistant legal authority citation quote",
        8_000,
      ),
    };
  }
  exactKeys(
    raw,
    [
      "type",
      "kind",
      "ref",
      "doc_id",
      "document_id",
      "version_id",
      "filename",
      "page",
      "quote",
      "quotes",
    ],
    [],
    "Assistant citation",
  );
  if (raw.type !== "citation_data" || raw.kind !== "document") {
    return invalid("Assistant citation type");
  }
  if (!Array.isArray(raw.quotes) || raw.quotes.length > 100) {
    return invalid("Assistant citation quotes");
  }
  const quotes = raw.quotes.map((item) => {
    const quote = record(item, "Assistant citation quote");
    exactKeys(quote, ["page", "quote"], [], "Assistant citation quote");
    return {
      page: pageValue(quote.page, "Assistant citation quote page"),
      quote: stringValue(quote.quote, "Assistant citation quote", 8_000),
    };
  });
  return {
    type: "citation_data",
    kind: "document",
    ref: integer(raw.ref, "Assistant citation ref", 1),
    doc_id: uuid(raw.doc_id, "Assistant citation document label"),
    document_id: uuid(raw.document_id, "Assistant citation document id"),
    version_id: uuid(raw.version_id, "Assistant citation version id"),
    filename: stringValue(raw.filename, "Assistant citation filename", 500),
    page: pageValue(raw.page, "Assistant citation page"),
    quote: stringValue(raw.quote, "Assistant citation quote", 8_000),
    quotes,
  };
}

function parseMessage(value: unknown): VeraAssistantMessage {
  const raw = record(value, "Assistant message");
  exactKeys(
    raw,
    ["id", "chat_id", "role", "content", "created_at"],
    ["files", "citations", "events"],
    "Assistant message",
  );
  const role = enumValue(raw.role, ["user", "assistant"] as const, "role");
  let content: VeraAssistantMessage["content"];
  if (typeof raw.content === "string") {
    content = stringValue(
      raw.content,
      "Assistant message content",
      200_000,
      true,
    );
  } else {
    if (!Array.isArray(raw.content) || raw.content.length > 1) {
      return invalid("Assistant message content");
    }
    content = raw.content.map((item) => {
      const block = record(item, "Assistant content block");
      exactKeys(block, ["type", "text"], [], "Assistant content block");
      if (block.type !== "content")
        return invalid("Assistant content block type");
      return {
        type: "content" as const,
        text: stringValue(block.text, "Assistant content text", 200_000, true),
      };
    });
  }
  const files = raw.files;
  const citations = raw.citations;
  const events = raw.events;
  if (
    files !== undefined &&
    (!Array.isArray(files) || files.length > MAX_CHAT_FILES)
  ) {
    return invalid("Assistant message files");
  }
  if (
    citations !== undefined &&
    (!Array.isArray(citations) || citations.length > MAX_CITATIONS)
  ) {
    return invalid("Assistant message citations");
  }
  if (
    events !== undefined &&
    (!Array.isArray(events) || events.length > MAX_MESSAGE_DURABLE_EVENTS)
  ) {
    return invalid("Assistant message durable events");
  }
  if (events !== undefined && role !== "assistant") {
    return invalid("Assistant message durable event ownership");
  }
  const durableEvents = events?.map((item) => {
    const event = parseVeraAssistantStreamEvent(item);
    if (event.type !== "draft_created") {
      return invalid("Assistant message durable event type");
    }
    return event;
  });
  return {
    id: uuid(raw.id, "Assistant message id"),
    chat_id: uuid(raw.chat_id, "Assistant message chat id"),
    role,
    content,
    ...(files === undefined ? {} : { files: files.map(parseFile) }),
    ...(citations === undefined
      ? {}
      : { citations: citations.map(parseVeraAssistantCitation) }),
    ...(durableEvents === undefined ? {} : { events: durableEvents }),
    created_at: timestamp(raw.created_at, "Assistant message timestamp"),
  };
}

export function parseVeraAssistantChatDetail(
  value: unknown,
): VeraAssistantChatDetail {
  const raw = record(value, "Assistant chat detail");
  exactKeys(raw, ["chat", "messages"], [], "Assistant chat detail");
  if (!Array.isArray(raw.messages) || raw.messages.length > MAX_CHAT_MESSAGES) {
    return invalid("Assistant chat messages");
  }
  const chat = parseVeraAssistantChat(raw.chat);
  const messages = raw.messages.map(parseMessage);
  if (messages.some((message) => message.chat_id !== chat.id)) {
    return invalid("Assistant message ownership");
  }
  for (const message of messages) {
    for (const event of message.events ?? []) {
      if (
        chat.project_id === null ||
        event.route !==
          `/projects/${chat.project_id}/documents/${event.draft_id}/studio`
      ) {
        return invalid("Assistant message Draft Matter ownership");
      }
    }
  }
  return { chat, messages };
}

export function parseVeraAssistantAccepted(
  value: unknown,
): VeraAssistantGenerationAccepted {
  const raw = record(value, "Assistant generation acceptance");
  exactKeys(
    raw,
    ["chat_id", "job_id", "prompt_message_id", "output_message_id", "status"],
    [],
    "Assistant generation acceptance",
  );
  if (raw.status !== "queued") return invalid("Assistant generation status");
  return {
    chat_id: uuid(raw.chat_id, "Assistant accepted chat id"),
    job_id: uuid(raw.job_id, "Assistant accepted job id"),
    prompt_message_id: uuid(
      raw.prompt_message_id,
      "Assistant prompt message id",
    ),
    output_message_id: uuid(
      raw.output_message_id,
      "Assistant output message id",
    ),
    status: "queued",
  };
}

export function parseVeraAssistantGenerationStatus(
  value: unknown,
): VeraAssistantGenerationStatus {
  const raw = record(value, "Assistant generation status");
  exactKeys(
    raw,
    [
      "job_id",
      "chat_id",
      "prompt_message_id",
      "output_message_id",
      "status",
      "attempt",
      "max_attempts",
      "retryable",
      "cancel_requested",
      "terminal",
      "active_attempt",
    ],
    [],
    "Assistant generation status",
  );
  const status = enumValue(
    raw.status,
    VERA_ASSISTANT_JOB_STATUSES,
    "Assistant generation state",
  );
  const terminal = booleanValue(raw.terminal, "Assistant terminal state");
  if (
    terminal !==
    ["complete", "failed", "cancelled", "interrupted"].includes(status)
  ) {
    return invalid("Assistant terminal relationship");
  }
  return {
    job_id: uuid(raw.job_id, "Assistant job id"),
    chat_id: uuid(raw.chat_id, "Assistant job chat id"),
    prompt_message_id: uuid(raw.prompt_message_id, "Assistant job prompt id"),
    output_message_id: uuid(raw.output_message_id, "Assistant job output id"),
    status,
    attempt: integer(
      raw.attempt,
      "Assistant job attempt",
      0,
      MAX_ASSISTANT_ATTEMPTS,
    ),
    max_attempts: integer(
      raw.max_attempts,
      "Assistant job max attempts",
      1,
      MAX_ASSISTANT_ATTEMPTS,
    ),
    retryable: booleanValue(raw.retryable, "Assistant retryability"),
    cancel_requested: booleanValue(
      raw.cancel_requested,
      "Assistant cancel request state",
    ),
    terminal,
    active_attempt: integer(
      raw.active_attempt,
      "Assistant active attempt",
      1,
      MAX_ASSISTANT_ATTEMPTS,
    ),
  };
}

const TOOL_NAMES = [
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
] as const;

export function parseVeraAssistantStreamEvent(
  value: unknown,
): VeraAssistantStreamEvent {
  const raw = record(value, "Assistant stream event");
  const type = stringValue(raw.type, "Assistant event type", 80);
  switch (type) {
    case "chat_id":
      exactKeys(raw, ["type", "chatId"], [], "Assistant chat event");
      return { type, chatId: uuid(raw.chatId, "Assistant chat event id") };
    case "status":
      exactKeys(
        raw,
        ["type", "job_id", "status"],
        [],
        "Assistant status event",
      );
      return {
        type,
        job_id: uuid(raw.job_id, "Assistant status job id"),
        status: enumValue(
          raw.status,
          ["queued", "running", "retrying"] as const,
          "Assistant status event state",
        ),
      };
    case "content_delta":
    case "reasoning_delta":
      exactKeys(raw, ["type", "text"], [], "Assistant delta event");
      return {
        type,
        text: stringValue(raw.text, "Assistant event text", 200_000, true),
      };
    case "content_done":
    case "reasoning_block_end":
      exactKeys(raw, ["type"], [], "Assistant boundary event");
      return { type };
    case "tool_call_start":
      exactKeys(raw, ["type", "name"], [], "Assistant tool event");
      return {
        type,
        name: enumValue(raw.name, TOOL_NAMES, "Assistant tool name"),
      };
    case "doc_read_start":
      exactKeys(raw, ["type", "filename"], [], "Assistant document read event");
      return {
        type,
        filename: stringValue(raw.filename, "Assistant filename", 500),
      };
    case "doc_read":
      exactKeys(
        raw,
        ["type", "filename"],
        ["document_id"],
        "Assistant document read event",
      );
      return {
        type,
        filename: stringValue(raw.filename, "Assistant filename", 500),
        ...(raw.document_id === undefined
          ? {}
          : { document_id: uuid(raw.document_id, "Assistant document id") }),
      };
    case "doc_find_start":
      exactKeys(
        raw,
        ["type", "filename", "query"],
        [],
        "Assistant document search event",
      );
      return {
        type,
        filename: stringValue(raw.filename, "Assistant filename", 500),
        query: stringValue(raw.query, "Assistant document query", 2_000),
      };
    case "doc_find":
      exactKeys(
        raw,
        ["type", "filename", "query", "total_matches"],
        [],
        "Assistant document search event",
      );
      return {
        type,
        filename: stringValue(raw.filename, "Assistant filename", 500),
        query: stringValue(raw.query, "Assistant document query", 2_000),
        total_matches: integer(raw.total_matches, "Assistant document matches"),
      };
    case "workflow_applied":
      exactKeys(
        raw,
        ["type", "workflow_id", "title"],
        [],
        "Assistant workflow event",
      );
      return {
        type,
        workflow_id: uuid(raw.workflow_id, "Assistant workflow id"),
        title: stringValue(raw.title, "Assistant workflow title", 240),
      };
    case "draft_created": {
      exactKeys(
        raw,
        ["type", "draft_id", "version_id", "title", "route"],
        [],
        "Assistant Draft event",
      );
      const draftId = uuid(raw.draft_id, "Assistant Draft id");
      const route = stringValue(raw.route, "Assistant Draft route", 240);
      if (
        !new RegExp(
          `^/projects/[0-9a-f-]{36}/documents/${draftId}/studio$`,
        ).test(route)
      ) {
        return invalid("Assistant Draft route ownership");
      }
      return {
        type,
        draft_id: draftId,
        version_id: uuid(raw.version_id, "Assistant Draft version id"),
        title: stringValue(raw.title, "Assistant Draft title", 240),
        route,
      };
    }
    case "citation_data":
      return parseVeraAssistantCitation(raw);
    case "complete":
      exactKeys(
        raw,
        ["type", "message_id", "job_id"],
        [],
        "Assistant completion event",
      );
      return {
        type,
        message_id: uuid(raw.message_id, "Assistant completed message id"),
        job_id: uuid(raw.job_id, "Assistant completed job id"),
      };
    case "error":
      exactKeys(raw, ["type", "message"], ["code"], "Assistant error event");
      return {
        type,
        ...(raw.code === undefined
          ? {}
          : { code: stringValue(raw.code, "Assistant error code", 160) }),
        message: stringValue(raw.message, "Assistant error message", 2_000),
      };
    default:
      return invalid("Assistant event type");
  }
}

export function parseVeraAssistantReplay(value: unknown): VeraAssistantReplay {
  const raw = record(value, "Assistant replay");
  exactKeys(
    raw,
    ["job_id", "status", "attempt", "terminal", "events", "next_cursor"],
    [],
    "Assistant replay",
  );
  if (!Array.isArray(raw.events) || raw.events.length > 100) {
    return invalid("Assistant replay events");
  }
  const jobId = uuid(raw.job_id, "Assistant replay job id");
  const events = raw.events.map((item) => {
    const event = record(item, "Assistant durable event");
    exactKeys(
      event,
      ["cursor", "attempt", "event", "terminal", "created_at"],
      [],
      "Assistant durable event",
    );
    return {
      cursor: integer(
        event.cursor,
        "Assistant event cursor",
        1,
        MAX_ASSISTANT_EVENT_CURSOR,
      ),
      attempt: integer(
        event.attempt,
        "Assistant event attempt",
        1,
        MAX_ASSISTANT_ATTEMPTS,
      ),
      event: parseVeraAssistantStreamEvent(event.event),
      terminal: booleanValue(event.terminal, "Assistant event terminal state"),
      created_at: timestamp(event.created_at, "Assistant event timestamp"),
    };
  });
  for (let index = 1; index < events.length; index += 1) {
    if (events[index].cursor <= events[index - 1].cursor) {
      return invalid("Assistant event cursor order");
    }
  }
  const nextCursor = integer(
    raw.next_cursor,
    "Assistant next cursor",
    0,
    MAX_ASSISTANT_EVENT_CURSOR,
  );
  if (events.length > 0 && nextCursor < events.at(-1)!.cursor) {
    return invalid("Assistant next cursor relationship");
  }
  return {
    job_id: jobId,
    status: enumValue(
      raw.status,
      VERA_ASSISTANT_JOB_STATUSES,
      "Assistant replay status",
    ),
    attempt: integer(
      raw.attempt,
      "Assistant replay attempt",
      1,
      MAX_ASSISTANT_ATTEMPTS,
    ),
    terminal: booleanValue(raw.terminal, "Assistant replay terminal state"),
    events,
    next_cursor: nextCursor,
  };
}

function safeId(value: string, label: string): string {
  if (!UUID.test(value)) {
    throw new VeraRuntimeConfigurationError(`The Vera ${label} is invalid.`);
  }
  return value;
}

function validateGenerationInput(input: VeraAssistantGenerationInput): void {
  if (input.messages.length === 0 || input.messages.length > 200) {
    throw new VeraRuntimeConfigurationError(
      "A Vera Assistant turn requires bounded conversation messages.",
    );
  }
  if (input.messages.at(-1)?.role !== "user") {
    throw new VeraRuntimeConfigurationError(
      "The final Vera Assistant message must be from the user.",
    );
  }
  if (input.chat_id) safeId(input.chat_id, "chat id");
  if (input.project_id) safeId(input.project_id, "project id");
  if (input.model_profile_id)
    safeId(input.model_profile_id, "model profile id");
  for (const message of input.messages) {
    if (message.content.length > 100_000) {
      throw new VeraRuntimeConfigurationError(
        "A Vera Assistant message exceeds the safe size.",
      );
    }
    if (message.files && message.files.length > MAX_CHAT_FILES) {
      throw new VeraRuntimeConfigurationError(
        "A Vera Assistant message has too many documents.",
      );
    }
    for (const file of message.files ?? []) {
      if (file.document_id) safeId(file.document_id, "document id");
    }
  }
}

export async function listVeraAssistantChats(
  input: { limit?: number; projectId?: string | null } = {},
  signal?: AbortSignal,
): Promise<VeraAssistantChat[]> {
  if (input.projectId) safeId(input.projectId, "project id");
  const raw = await veraApiRequest<unknown>("/chat", {
    query: { limit: input.limit, project_id: input.projectId },
    signal,
  });
  if (!Array.isArray(raw) || raw.length > 100)
    return invalid("Assistant chat list");
  return raw.map(parseVeraAssistantChat);
}

export async function listVeraProjectAssistantChats(
  projectId: string,
  signal?: AbortSignal,
): Promise<VeraAssistantChat[]> {
  const raw = await veraApiRequest<unknown>(
    `/projects/${safeId(projectId, "project id")}/chats`,
    { signal },
  );
  if (!Array.isArray(raw) || raw.length > 10_000) {
    return invalid("project Assistant chat list");
  }
  return raw.map(parseVeraAssistantChat);
}

export async function createVeraAssistantChat(
  input: {
    projectId?: string | null;
    title?: string;
    modelProfileId?: string | null;
  } = {},
): Promise<{ id: string }> {
  if (input.projectId) safeId(input.projectId, "project id");
  if (input.modelProfileId) safeId(input.modelProfileId, "model profile id");
  const raw = await veraApiRequest<unknown>("/chat/create", {
    method: "POST",
    json: {
      ...(input.projectId === undefined ? {} : { project_id: input.projectId }),
      ...(input.title ? { title: input.title } : {}),
      ...(input.modelProfileId === undefined
        ? {}
        : { model_profile_id: input.modelProfileId }),
    },
  });
  const parsed = record(raw, "Assistant chat creation");
  exactKeys(parsed, ["id"], [], "Assistant chat creation");
  return { id: uuid(parsed.id, "created Assistant chat id") };
}

export async function getVeraAssistantChat(
  chatId: string,
  signal?: AbortSignal,
): Promise<VeraAssistantChatDetail> {
  return parseVeraAssistantChatDetail(
    await veraApiRequest<unknown>(`/chat/${safeId(chatId, "chat id")}`, {
      signal,
    }),
  );
}

export async function renameVeraAssistantChat(
  chatId: string,
  title: string,
): Promise<void> {
  const next = title.trim();
  if (!next || next.length > 240) {
    throw new VeraRuntimeConfigurationError("The Vera chat title is invalid.");
  }
  await veraApiRequest<void>(`/chat/${safeId(chatId, "chat id")}`, {
    method: "PATCH",
    json: { title: next },
  });
}

export async function deleteVeraAssistantChat(chatId: string): Promise<void> {
  await veraApiRequest<void>(`/chat/${safeId(chatId, "chat id")}`, {
    method: "DELETE",
  });
}

export async function startVeraAssistantGeneration(
  input: VeraAssistantGenerationInput,
): Promise<VeraAssistantGenerationAccepted> {
  validateGenerationInput(input);
  const projectId = input.project_id;
  const path = projectId
    ? `/projects/${safeId(projectId, "project id")}/chat`
    : "/chat";
  const body = projectId
    ? {
        messages: input.messages,
        ...(input.chat_id ? { chat_id: input.chat_id } : {}),
        ...(input.model_profile_id
          ? { model_profile_id: input.model_profile_id }
          : {}),
        ...(input.displayed_doc ? { displayed_doc: input.displayed_doc } : {}),
        ...(input.attached_documents
          ? { attached_documents: input.attached_documents }
          : {}),
      }
    : {
        messages: input.messages,
        ...(input.chat_id ? { chat_id: input.chat_id } : {}),
        ...(input.model_profile_id
          ? { model_profile_id: input.model_profile_id }
          : {}),
      };
  return parseVeraAssistantAccepted(
    await veraApiRequest<unknown>(path, { method: "POST", json: body }),
  );
}

export async function getVeraAssistantJob(
  jobId: string,
  signal?: AbortSignal,
): Promise<VeraAssistantGenerationStatus> {
  return parseVeraAssistantGenerationStatus(
    await veraApiRequest<unknown>(
      `/assistant/jobs/${safeId(jobId, "Assistant job id")}`,
      { signal },
    ),
  );
}

export async function listVeraAssistantJobs(
  chatId: string,
  limit = 20,
  signal?: AbortSignal,
): Promise<VeraAssistantGenerationStatus[]> {
  const raw = await veraApiRequest<unknown>("/assistant/jobs", {
    query: {
      chat_id: safeId(chatId, "chat id"),
      limit: Math.max(1, Math.min(20, Math.trunc(limit))),
    },
    signal,
  });
  const response = record(raw, "Assistant job list");
  exactKeys(response, ["items"], [], "Assistant job list");
  if (!Array.isArray(response.items) || response.items.length > 20) {
    return invalid("Assistant job list items");
  }
  const items = response.items.map(parseVeraAssistantGenerationStatus);
  if (items.some((item) => item.chat_id !== chatId)) {
    return invalid("Assistant job list ownership");
  }
  return items;
}

export async function replayVeraAssistantJob(
  jobId: string,
  cursor = 0,
  signal?: AbortSignal,
): Promise<VeraAssistantReplay> {
  const headers = new Headers({ Accept: "application/json" });
  if (cursor > 0)
    headers.set("Last-Event-ID", String(integer(cursor, "cursor")));
  const replay = parseVeraAssistantReplay(
    await veraApiRequest<unknown>(
      `/assistant/jobs/${safeId(jobId, "Assistant job id")}/events`,
      { headers, signal },
    ),
  );
  if (replay.job_id !== jobId) return invalid("Assistant replay ownership");
  return replay;
}

export async function* parseVeraAssistantSseResponse(
  response: Response,
  signal?: AbortSignal,
): AsyncGenerator<
  | { kind: "event"; cursor: number; event: VeraAssistantStreamEvent }
  | { kind: "done" }
> {
  if (!response.ok) throw await veraApiErrorFromResponse(response);
  const contentType = response.headers.get("content-type") ?? "";
  if (!/^text\/event-stream(?:\s*;|$)/i.test(contentType) || !response.body) {
    return invalid("Assistant event stream");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let doneSeen = false;
  let eventCount = 0;
  try {
    while (true) {
      if (signal?.aborted) throw signal.reason;
      const result = await reader.read();
      if (result.done) {
        buffer += decoder.decode();
        break;
      }
      buffer += decoder.decode(result.value, { stream: true });
      while (true) {
        const separator = /\r?\n\r?\n/.exec(buffer);
        if (!separator || separator.index === undefined) break;
        const frame = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator[0].length);
        if (!frame) continue;
        if (frame.length > MAX_SSE_FRAME_CHARS || doneSeen) {
          return invalid("Assistant event stream frame");
        }
        const lines = frame.split(/\r?\n/);
        if (lines.length === 1 && lines[0] === ": keep-alive") {
          continue;
        }
        if (lines.length === 1 && lines[0] === "data: [DONE]") {
          doneSeen = true;
          yield { kind: "done" };
          continue;
        }
        if (
          lines.length !== 2 ||
          !/^id: [1-9]\d*$/.test(lines[0]) ||
          !lines[1].startsWith("data: ")
        ) {
          return invalid("Assistant event stream frame");
        }
        const cursor = Number(lines[0].slice(4));
        if (!Number.isSafeInteger(cursor))
          return invalid("Assistant event cursor");
        let value: unknown;
        try {
          value = JSON.parse(lines[1].slice(6));
        } catch {
          return invalid("Assistant event JSON");
        }
        yield {
          kind: "event",
          cursor,
          event: parseVeraAssistantStreamEvent(value),
        };
        eventCount += 1;
        if (eventCount > 100_000) return invalid("Assistant event stream size");
      }
      if (buffer.length > MAX_SSE_FRAME_CHARS) {
        return invalid("Assistant event stream buffer");
      }
    }
    if (buffer.length !== 0) return invalid("Assistant event stream ending");
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The protocol or caller abort remains the useful failure.
    }
  }
}

async function waitForAssistantReconnect(
  delayMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("The operation was aborted.", "AbortError");
  }
  await new Promise<void>((resolve, reject) => {
    const onTimer = () => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const onAbort = () => {
      globalThis.clearTimeout(timer);
      reject(
        signal?.reason instanceof Error
          ? signal.reason
          : new DOMException("The operation was aborted.", "AbortError"),
      );
    };
    const timer = globalThis.setTimeout(onTimer, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Consume a durable job until its attempt emits `[DONE]`. A normal idle EOF
 * reconnects from the last acknowledged cursor; disconnecting this reader
 * never calls the cancellation endpoint.
 */
export async function* streamVeraAssistantJob(
  jobId: string,
  options: { cursor?: number; signal?: AbortSignal } = {},
): AsyncGenerator<{ cursor: number; event: VeraAssistantStreamEvent }> {
  const safeJobId = safeId(jobId, "Assistant job id");
  let cursor = integer(
    options.cursor ?? 0,
    "Assistant event cursor",
    0,
    MAX_ASSISTANT_EVENT_CURSOR,
  );
  let consecutiveIdleDisconnects = 0;
  while (!options.signal?.aborted) {
    const headers = new Headers({ Accept: "text/event-stream" });
    if (cursor > 0) headers.set("Last-Event-ID", String(cursor));
    const response = await veraApiFetch(`/assistant/jobs/${safeJobId}/events`, {
      headers,
      signal: options.signal,
    });
    let terminal = false;
    let receivedEvent = false;
    for await (const item of parseVeraAssistantSseResponse(
      response,
      options.signal,
    )) {
      if (item.kind === "done") {
        terminal = true;
        break;
      }
      if (item.cursor <= cursor) {
        return invalid("Assistant event cursor order");
      }
      cursor = item.cursor;
      receivedEvent = true;
      yield item;
    }
    if (terminal) return;
    const status = await getVeraAssistantJob(safeJobId, options.signal);
    if (status.terminal) return;
    consecutiveIdleDisconnects = receivedEvent
      ? 0
      : consecutiveIdleDisconnects + 1;
    await waitForAssistantReconnect(
      Math.min(2_000, 250 * 2 ** Math.min(consecutiveIdleDisconnects, 3)),
      options.signal,
    );
  }
  if (options.signal?.aborted) {
    throw options.signal.reason instanceof Error
      ? options.signal.reason
      : new DOMException("The operation was aborted.", "AbortError");
  }
}

export async function cancelVeraAssistantJob(
  jobId: string,
  reason?: string,
): Promise<VeraAssistantCancelResult> {
  const raw = record(
    await veraApiRequest<unknown>(
      `/assistant/jobs/${safeId(jobId, "Assistant job id")}/cancel`,
      {
        method: "POST",
        json: reason?.trim() ? { reason: reason.trim() } : {},
      },
    ),
    "Assistant cancellation",
  );
  exactKeys(
    raw,
    ["job_id", "status", "cancel_requested", "terminal"],
    [],
    "Assistant cancellation",
  );
  return {
    job_id: uuid(raw.job_id, "cancelled Assistant job id"),
    status: enumValue(
      raw.status,
      VERA_ASSISTANT_JOB_STATUSES,
      "Assistant cancellation state",
    ),
    cancel_requested: booleanValue(
      raw.cancel_requested,
      "Assistant cancellation request state",
    ),
    terminal: booleanValue(
      raw.terminal,
      "Assistant cancellation terminal state",
    ),
  };
}

async function restartJob(
  jobId: string,
  action: "retry" | "regenerate",
): Promise<VeraAssistantGenerationAccepted> {
  return parseVeraAssistantAccepted(
    await veraApiRequest<unknown>(
      `/assistant/jobs/${safeId(jobId, "Assistant job id")}/${action}`,
      { method: "POST", json: {} },
    ),
  );
}

export function retryVeraAssistantJob(jobId: string) {
  return restartJob(jobId, "retry");
}

export function regenerateVeraAssistantJob(jobId: string) {
  return restartJob(jobId, "regenerate");
}
