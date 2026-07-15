import { z } from "zod";
import { WORKSPACE_LOCAL_PRINCIPAL_ID } from "./principal";

/**
 * Locked Mike e32daad wire compatibility. This is deliberately a transport
 * boundary: local domain records never inherit Mike's cloud identity/storage.
 */
/** Stable, non-secret principal used only by the single-user desktop boundary. */
export const MIKE_LOCAL_USER_ID = WORKSPACE_LOCAL_PRINCIPAL_ID;
const Id = z.string().uuid();
const Time = z.string().datetime({ offset: true });
const Text = z.string().trim().min(1).max(20_000);
const fileTypes = [
  "pdf",
  "docx",
  "doc",
  "xlsx",
  "xlsm",
  "xls",
  "pptx",
  "ppt",
  "txt",
  "md",
] as const;
const DownloadUrl = z
  .string()
  .regex(/^\/api\/v1\/downloads\/[A-Za-z0-9_-]{16,256}$/);
const opaqueDownloadUrl = (value: unknown): value is string =>
  typeof value === "string" && DownloadUrl.safeParse(value).success;
const sensitiveKey = (key: string) =>
  /(?:secret|api[_-]?key|credential|password|authorization|token|storage_path|pdf_storage_path)/i.test(
    key,
  );
const strictObject = <T extends z.ZodRawShape>(shape: T) =>
  z.object(shape).strict();

export type MikeProjectWire = {
  id: string;
  user_id: string;
  name: string;
  cm_number: string | null;
  practice: string | null;
  shared_with: string[];
  created_at: string;
  updated_at: string;
  is_owner: boolean;
  owner_display_name: string | null;
  owner_email: string | null;
  documents: MikeDocumentWire[];
  folders: MikeFolderWire[];
  document_count: number;
  chat_count: number;
  review_count: number;
};
export type MikeFolderWire = {
  id: string;
  project_id: string;
  user_id: string;
  name: string;
  parent_folder_id: string | null;
  created_at: string;
  updated_at: string;
};
export type MikeDocumentWire = {
  id: string;
  user_id: string;
  project_id: string | null;
  folder_id: string | null;
  filename: string;
  owner_email: string | null;
  owner_display_name: string | null;
  file_type: MikeFileType | null;
  storage_path: null;
  pdf_storage_path: "local-preview" | null;
  size_bytes: number | null;
  page_count: number | null;
  structure_tree: null;
  status: "pending" | "processing" | "ready" | "error";
  created_at: string | null;
  updated_at: string | null;
  active_version_number: number | null;
  latest_version_number: number | null;
};
export type MikeDocumentVersionWire = {
  id: string;
  version_number: number | null;
  source: string;
  created_at: string;
  filename: string | null;
  file_type?: MikeFileType | null;
  size_bytes?: number | null;
  page_count?: number | null;
  deleted_at?: string | null;
  deleted_by?: string | null;
};
export type MikeFileType =
  | "pdf"
  | "docx"
  | "doc"
  | "xlsx"
  | "xlsm"
  | "xls"
  | "pptx"
  | "ppt"
  | "txt"
  | "md";
export type MikeChatWire = {
  id: string;
  project_id: string | null;
  user_id: string;
  creator_display_name: string | null;
  title: string | null;
  created_at: string;
};
export type MikeAssistantEvent =
  | { type: "reasoning" | "content"; text: string; isStreaming?: boolean }
  | { type: "error"; message: string }
  | { type: "thinking"; isStreaming?: boolean }
  | { type: "tool_call_start"; name: string; isStreaming?: boolean }
  | {
      type: "ask_inputs";
      items: Array<
        | {
            id: string;
            kind: "choice";
            question: string;
            options: Array<{ value: string }>;
            allow_other: boolean;
            other_label: string;
            response_prefix?: string;
          }
        | {
            id: string;
            kind: "documents";
            document_types: string[];
            response_prefix?: string;
          }
      >;
    }
  | {
      type: "ask_inputs_response";
      responses: Array<
        | {
            id: string;
            kind: "choice";
            question: string;
            answer?: string;
            skipped?: boolean;
          }
        | {
            id: string;
            kind: "documents";
            filenames: string[];
            skipped?: boolean;
          }
      >;
    }
  | {
      type: "doc_read";
      filename: string;
      document_id?: string;
      isStreaming?: boolean;
    }
  | {
      type: "doc_find";
      filename: string;
      query: string;
      total_matches: number;
      isStreaming?: boolean;
    }
  | {
      type: "doc_created";
      filename: string;
      download_url: string;
      document_id?: string;
      version_id?: string;
      version_number?: number | null;
      isStreaming?: boolean;
    }
  | { type: "doc_download"; filename: string; download_url: string }
  | {
      type: "doc_replicated";
      filename: string;
      count: number;
      copies?: Array<{
        new_filename: string;
        document_id: string;
        version_id: string;
      }>;
      error?: string;
      isStreaming?: boolean;
    }
  | {
      type: "doc_edited";
      filename: string;
      document_id: string;
      version_id: string;
      version_number?: number | null;
      download_url: string;
      annotations: Array<{
        edit_id: string;
        document_id: string;
        version_id: string;
        change_id: string;
        del_w_id: string;
        ins_w_id: string;
        deleted_text: string;
        inserted_text: string;
        status: "pending" | "accepted" | "rejected";
      }>;
      error?: string;
      isStreaming?: boolean;
    }
  | { type: "workflow_applied"; workflow_id: string; title: string };
export type MikeMessageWire = {
  id: string;
  chat_id: string;
  role: "user" | "assistant";
  content: string | MikeAssistantEvent[] | null;
  files: { filename: string; document_id?: string }[];
  citations: unknown[];
  created_at: string;
};
export type MikeWorkflowWire = {
  id: string;
  user_id: string | null;
  metadata: {
    title: string;
    description: string | null;
    type: "assistant" | "tabular";
    contributors: Array<{
      name: string;
      organisation: string | null;
      role: string | null;
      linkedin: string | null;
    }>;
    language: string;
    version: string | null;
    practice: string | null;
    jurisdictions: string[] | null;
  };
  skill_md: string | null;
  columns_config: MikeColumnConfig[] | null;
  is_system: boolean;
  created_at: string;
  shared_by_name: string | null;
  allow_edit: boolean;
  is_owner: boolean;
  open_source_submission: null;
};
export type MikeColumnConfig = {
  index: number;
  name: string;
  prompt: string;
  format:
    | "text"
    | "bulleted_list"
    | "number"
    | "percentage"
    | "monetary_amount"
    | "currency"
    | "yes_no"
    | "date"
    | "tag";
  tags: string[];
};
export type WorkspaceTabularFormat = MikeColumnConfig["format"];
export type WorkspaceTabularCellStatus =
  | "pending"
  | "processing"
  | "ready"
  | "failed"
  | "cancelled";
const workspaceToMikeFormat: Record<
  WorkspaceTabularFormat,
  MikeColumnConfig["format"]
> = {
  text: "text",
  bulleted_list: "bulleted_list",
  number: "number",
  percentage: "percentage",
  monetary_amount: "monetary_amount",
  currency: "currency",
  yes_no: "yes_no",
  date: "date",
  tag: "tag",
};
const mikeToWorkspaceFormat: Record<
  MikeColumnConfig["format"],
  WorkspaceTabularFormat
> = {
  text: "text",
  bulleted_list: "bulleted_list",
  number: "number",
  percentage: "percentage",
  monetary_amount: "monetary_amount",
  currency: "currency",
  yes_no: "yes_no",
  date: "date",
  tag: "tag",
};
export function toMikeTabularFormat(
  format: WorkspaceTabularFormat,
): MikeColumnConfig["format"] {
  return workspaceToMikeFormat[format];
}
export function fromMikeTabularFormat(
  format: MikeColumnConfig["format"],
): WorkspaceTabularFormat {
  return mikeToWorkspaceFormat[format];
}
export function toMikeTabularStatus(
  status: WorkspaceTabularCellStatus,
): MikeTabularCellWire["status"] {
  switch (status) {
    case "processing":
      return "generating";
    case "ready":
      return "done";
    case "failed":
    case "cancelled":
      return "error";
    default:
      return "pending";
  }
}
export function fromMikeTabularStatus(
  status: MikeTabularCellWire["status"],
): Exclude<WorkspaceTabularCellStatus, "cancelled"> {
  switch (status) {
    case "generating":
      return "processing";
    case "done":
      return "ready";
    case "error":
      return "failed";
    default:
      return "pending";
  }
}
export type MikeTabularCellWire = {
  id: string;
  review_id: string;
  document_id: string;
  column_index: number;
  content: {
    summary: string;
    flag?: "green" | "grey" | "yellow" | "red";
    reasoning?: string;
  } | null;
  status: "pending" | "generating" | "done" | "error";
  created_at: string;
};
export type MikeDocumentCitation = {
  type: "citation_data";
  kind: "document";
  ref: number;
  doc_id: string;
  document_id: string;
  filename: string;
  quote: string;
  page: number | string;
  version_id?: string | null;
  version_number?: number | null;
  sheet?: string;
  cell?: string;
  quotes?: Array<{
    page: number | string;
    quote: string;
    sheet?: string;
    cell?: string;
  }>;
};
export type MikeSseEvent =
  | { type: "chat_id"; chatId: string }
  | { type: "content_delta"; text: string }
  | { type: "content_done" }
  | { type: "reasoning_delta"; text: string }
  | { type: "reasoning_block_end" }
  | { type: "tool_call_start"; name: string }
  | {
      type: "workflow_applied";
      workflow_id: string;
      title: string;
    }
  | {
      type: "citations";
      status: "started" | "partial" | "final";
      citations: MikeDocumentCitation[];
    }
  | { type: "error"; message: string }
  | {
      type: "cell_update";
      document_id: string;
      column_index: number;
      content: {
        summary: string;
        flag?: "green" | "grey" | "yellow" | "red";
        reasoning?: string;
      } | null;
      status: "generating" | "done" | "error";
    }
  | { type: "chat_title"; chatId: string; title: string };

export const MikeAssistantEventSchema = z.discriminatedUnion("type", [
  strictObject({
    type: z.literal("reasoning"),
    text: Text,
    isStreaming: z.boolean().optional(),
  }),
  strictObject({
    type: z.literal("content"),
    text: Text,
    isStreaming: z.boolean().optional(),
  }),
  strictObject({ type: z.literal("error"), message: Text }),
  strictObject({
    type: z.literal("thinking"),
    isStreaming: z.boolean().optional(),
  }),
  strictObject({
    type: z.literal("tool_call_start"),
    name: Text,
    isStreaming: z.boolean().optional(),
  }),
  strictObject({
    type: z.literal("ask_inputs"),
    items: z
      .array(
        z.discriminatedUnion("kind", [
          strictObject({
            id: Text,
            kind: z.literal("choice"),
            question: Text,
            options: z
              .array(strictObject({ value: Text }))
              .min(1)
              .max(100),
            allow_other: z.boolean(),
            other_label: Text,
            response_prefix: z.string().max(2_000).optional(),
          }),
          strictObject({
            id: Text,
            kind: z.literal("documents"),
            document_types: z.array(Text).max(100),
            response_prefix: z.string().max(2_000).optional(),
          }),
        ]),
      )
      .max(100),
  }),
  strictObject({
    type: z.literal("ask_inputs_response"),
    responses: z
      .array(
        z.discriminatedUnion("kind", [
          strictObject({
            id: Text,
            kind: z.literal("choice"),
            question: Text,
            answer: z.string().max(20_000).optional(),
            skipped: z.boolean().optional(),
          }),
          strictObject({
            id: Text,
            kind: z.literal("documents"),
            filenames: z.array(Text).max(100),
            skipped: z.boolean().optional(),
          }),
        ]),
      )
      .max(100),
  }),
  strictObject({
    type: z.literal("doc_read"),
    filename: Text,
    document_id: Id.optional(),
    isStreaming: z.boolean().optional(),
  }),
  strictObject({
    type: z.literal("doc_find"),
    filename: Text,
    query: Text,
    total_matches: z.number().int().nonnegative(),
    isStreaming: z.boolean().optional(),
  }),
  strictObject({
    type: z.literal("doc_created"),
    filename: Text,
    download_url: DownloadUrl,
    document_id: Id.optional(),
    version_id: Id.optional(),
    version_number: z.number().int().positive().nullable().optional(),
    isStreaming: z.boolean().optional(),
  }),
  strictObject({
    type: z.literal("doc_download"),
    filename: Text,
    download_url: DownloadUrl,
  }),
  strictObject({
    type: z.literal("doc_replicated"),
    filename: Text,
    count: z.number().int().nonnegative(),
    copies: z
      .array(
        strictObject({ new_filename: Text, document_id: Id, version_id: Id }),
      )
      .max(1_000)
      .optional(),
    error: z.string().max(20_000).optional(),
    isStreaming: z.boolean().optional(),
  }),
  strictObject({
    type: z.literal("doc_edited"),
    filename: Text,
    document_id: Id,
    version_id: Id,
    version_number: z.number().int().positive().nullable().optional(),
    download_url: DownloadUrl,
    annotations: z
      .array(
        strictObject({
          edit_id: Id,
          document_id: Id,
          version_id: Id,
          change_id: Id,
          del_w_id: Text,
          ins_w_id: Text,
          deleted_text: z.string().max(100_000),
          inserted_text: z.string().max(100_000),
          status: z.enum(["pending", "accepted", "rejected"]),
        }),
      )
      .max(10_000),
    error: z.string().max(20_000).optional(),
    isStreaming: z.boolean().optional(),
  }),
  strictObject({
    type: z.literal("workflow_applied"),
    workflow_id: Id,
    title: Text,
  }),
]);
export const MikeDocumentCitationSchema = strictObject({
  type: z.literal("citation_data"),
  kind: z.literal("document"),
  ref: z.number().int().positive(),
  // Mike's doc_id is the model-visible document label, not the database UUID.
  doc_id: Text,
  document_id: Id,
  filename: Text,
  quote: z.string().trim().min(1).max(100_000),
  page: z.union([
    z.number().int().positive(),
    z.string().trim().min(1).max(80),
  ]),
  version_id: Id.nullable().optional(),
  version_number: z.number().int().positive().nullable().optional(),
  sheet: z.string().trim().max(240).optional(),
  cell: z.string().trim().max(80).optional(),
  quotes: z
    .array(
      strictObject({
        page: z.union([
          z.number().int().positive(),
          z.string().trim().min(1).max(80),
        ]),
        quote: z.string().trim().min(1).max(100_000),
        sheet: z.string().trim().max(240).optional(),
        cell: z.string().trim().max(80).optional(),
      }),
    )
    .max(3)
    .optional(),
});
export const MikeSseEventSchema = z.discriminatedUnion("type", [
  strictObject({ type: z.literal("chat_id"), chatId: Id }),
  strictObject({
    type: z.literal("content_delta"),
    text: z.string().max(200_000),
  }),
  strictObject({ type: z.literal("content_done") }),
  strictObject({
    type: z.literal("reasoning_delta"),
    text: z.string().max(200_000),
  }),
  strictObject({ type: z.literal("reasoning_block_end") }),
  strictObject({ type: z.literal("tool_call_start"), name: Text }),
  strictObject({
    type: z.literal("workflow_applied"),
    workflow_id: Id,
    title: Text,
  }),
  strictObject({
    type: z.literal("citations"),
    status: z.enum(["started", "partial", "final"]),
    citations: z.array(MikeDocumentCitationSchema).max(1_000),
  }),
  strictObject({
    type: z.literal("error"),
    message: Text,
  }),
  strictObject({
    type: z.literal("cell_update"),
    document_id: Id,
    column_index: z.number().int().nonnegative(),
    content: strictObject({
      summary: z.string().max(100_000),
      flag: z.enum(["green", "grey", "yellow", "red"]).optional(),
      reasoning: z.string().max(100_000).optional(),
    }).nullable(),
    status: z.enum(["generating", "done", "error"]),
  }),
  strictObject({ type: z.literal("chat_title"), chatId: Id, title: Text }),
]);
export const MikeProjectCreateSchema = strictObject({
  name: z.string().trim().min(1).max(240),
  // Vera local extension: Project is the generic container for documents,
  // chats, workflows, and tabular reviews. Mike clients may omit this field.
  description: z.string().trim().min(1).max(2_000).nullable().optional(),
  cm_number: z.string().trim().max(120).nullable().optional(),
  practice: z.string().trim().max(160).nullable().optional(),
  shared_with: z.array(z.string().email()).max(0).optional(),
}).superRefine((value, ctx) => {
  if (value.shared_with?.length)
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["shared_with"],
      message: "Sharing is unsupported in local mode.",
    });
});
export const MikeDocumentInputSchema = strictObject({
  filename: z.string().trim().min(1).max(500),
  file_type: z.string().trim().max(40).nullable().optional(),
  size_bytes: z.number().int().nonnegative().nullable().optional(),
});
export const MikeChatDetailSchema = strictObject({
  chat: strictObject({
    id: Id,
    project_id: Id.nullable(),
    user_id: z.literal(MIKE_LOCAL_USER_ID),
    title: z.string().nullable(),
    created_at: Time,
  }),
  messages: z
    .array(
      strictObject({
        id: Id,
        chat_id: Id,
        role: z.enum(["user", "assistant"]),
        content: z.union([
          z.string().max(200_000),
          z.array(MikeAssistantEventSchema).max(10_000),
          z.null(),
        ]),
        files: z
          .array(strictObject({ filename: Text, document_id: Id.optional() }))
          .max(1000)
          .default([]),
        citations: z.array(MikeDocumentCitationSchema).max(1000).default([]),
        created_at: Time,
      }),
    )
    .max(10_000),
});
const ColumnSchema = strictObject({
  index: z.number().int().nonnegative(),
  name: Text,
  prompt: z.string().max(20_000),
  format: z
    .enum([
      "text",
      "bulleted_list",
      "number",
      "percentage",
      "monetary_amount",
      "currency",
      "yes_no",
      "date",
      "tag",
    ])
    .default("text"),
  tags: z.array(Text).max(100).default([]),
});
export const MikeWorkflowCreateSchema = strictObject({
  metadata: strictObject({
    title: z.string().trim().min(1).max(240),
    type: z.enum(["assistant", "tabular"]),
    language: z.string().trim().min(1).max(80).optional(),
    practice: z.string().trim().max(160).nullable().optional(),
    jurisdictions: z.array(Text).max(100).optional(),
  }),
  skill_md: z.string().max(100_000).optional(),
  columns_config: z.array(ColumnSchema).max(100).optional(),
});
export const MikeTabularCreateSchema = strictObject({
  title: z.string().trim().max(240).optional(),
  document_ids: z.array(Id).max(1000).default([]),
  columns_config: z.array(ColumnSchema).max(100).default([]),
  workflow_id: Id.nullable().optional(),
  project_id: Id.nullable().optional(),
  // Local-client extension: Mike's cloud service selected a model outside the
  // review payload, while Vera persists the explicit local profile binding.
  model_profile_id: Id.nullable().optional(),
  shared_with: z.array(z.string().email()).max(0).optional(),
}).superRefine((value, ctx) => {
  if (value.shared_with?.length)
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["shared_with"],
      message: "Sharing is unsupported in local mode.",
    });
});
export const MikeErrorSchema = strictObject({
  detail: Text,
  code: z.string().trim().min(1).max(120).optional(),
  error: strictObject({
    code: z.string().trim().min(1).max(120),
    message: Text,
  }).optional(),
});
export const MikeDocumentVersionSchema = strictObject({
  id: Id,
  version_number: z.number().int().positive().nullable(),
  source: Text,
  created_at: Time,
  filename: z.string().trim().min(1).max(500).nullable(),
  file_type: z.enum(fileTypes).nullable().optional(),
  size_bytes: z.number().int().nonnegative().nullable().optional(),
  page_count: z.number().int().nonnegative().nullable().optional(),
  deleted_at: Time.nullable().optional(),
  deleted_by: z.string().trim().min(1).max(240).nullable().optional(),
});
export const MikeWorkflowSchema = strictObject({
  id: Id,
  user_id: Id.nullable(),
  metadata: strictObject({
    title: Text,
    description: z.string().max(20_000).nullable(),
    type: z.enum(["assistant", "tabular"]),
    contributors: z
      .array(
        strictObject({
          name: Text,
          organisation: z.string().max(240).nullable(),
          role: z.string().max(240).nullable(),
          linkedin: z.string().url().max(2_000).nullable(),
        }),
      )
      .max(100),
    language: Text,
    version: z.string().max(120).nullable(),
    practice: z.string().trim().max(160).nullable(),
    jurisdictions: z.array(Text).max(100).nullable(),
  }),
  skill_md: z.string().max(100_000).nullable(),
  columns_config: z.array(ColumnSchema).max(100).nullable(),
  is_system: z.boolean(),
  created_at: Time,
  shared_by_name: z.string().max(240).nullable(),
  allow_edit: z.boolean(),
  is_owner: z.boolean(),
  open_source_submission: z.null(),
});
export const MikeTabularCellSchema = strictObject({
  id: Id,
  review_id: Id,
  document_id: Id,
  column_index: z.number().int().nonnegative(),
  content: strictObject({
    summary: z.string().max(100_000),
    flag: z.enum(["green", "grey", "yellow", "red"]).optional(),
    reasoning: z.string().max(100_000).optional(),
  }).nullable(),
  status: z.enum(["pending", "generating", "done", "error"]),
  created_at: Time,
});
export const MIKE_SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
} as const;
export function mikeSseFrame(value: MikeSseEvent) {
  return `data: ${JSON.stringify(parseMikeSseEvent(value))}\n\n`;
}
export function mikeSseDone() {
  return "data: [DONE]\n\n";
}
export function mikeError(
  detail: string,
  code?: string,
  standard?: { error: { code: string; message: string } },
) {
  return {
    detail,
    ...(code ? { code } : {}),
    ...(standard ? { error: standard.error } : {}),
  };
}
export class MikeCompatibilityError extends Error {
  constructor(
    readonly code: "UNSUPPORTED",
    detail: string,
  ) {
    super(detail);
  }
}
function rejectRemoteSharing(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const sharedWith = (value as Record<string, unknown>).shared_with;
  if (Array.isArray(sharedWith) && sharedWith.length > 0) {
    throw new MikeCompatibilityError(
      "UNSUPPORTED",
      "Sharing is unsupported in local mode.",
    );
  }
}
export function parseMikeProjectCreate(value: unknown) {
  rejectRemoteSharing(value);
  const parsed = MikeProjectCreateSchema.parse(value);
  assertMikeSafePayload(parsed);
  return parsed;
}
export function parseMikeDocumentInput(value: unknown) {
  const parsed = MikeDocumentInputSchema.parse(value);
  assertMikeSafePayload(parsed);
  return parsed;
}
export function parseMikeChatDetail(value: unknown) {
  const parsed = MikeChatDetailSchema.parse(value);
  assertMikeSafePayload(parsed);
  return parsed;
}
export function parseMikeWorkflowCreate(value: unknown) {
  const parsed = MikeWorkflowCreateSchema.parse(value);
  assertMikeSafePayload(parsed);
  return parsed;
}
export function parseMikeTabularCreate(value: unknown) {
  rejectRemoteSharing(value);
  const parsed = MikeTabularCreateSchema.parse(value);
  assertMikeSafePayload(parsed);
  return parsed;
}
export function parseMikeAssistantEvent(value: unknown) {
  const parsed = MikeAssistantEventSchema.parse(value);
  assertMikeSafePayload(parsed);
  return parsed as MikeAssistantEvent;
}
export function parseMikeSseEvent(value: unknown) {
  const parsed = MikeSseEventSchema.parse(value);
  assertMikeSafePayload(parsed);
  return parsed as MikeSseEvent;
}
export function parseMikeWorkflow(value: unknown) {
  const parsed = MikeWorkflowSchema.parse(value);
  assertMikeSafePayload(parsed);
  return parsed;
}
export function parseMikeTabularCell(value: unknown) {
  const parsed = MikeTabularCellSchema.parse(value);
  assertMikeSafePayload(parsed);
  return parsed;
}
const documentStatus = (
  status:
    | "pending"
    | "processing"
    | "ready"
    | "failed"
    | "unsupported"
    | "ocr_required",
) =>
  status === "failed" || status === "unsupported" || status === "ocr_required"
    ? "error"
    : status;
export function serializeMikeProject(input: {
  id: string;
  name: string;
  cmNumber?: string | null;
  practice?: string | null;
  createdAt: string;
  updatedAt: string;
  documents?: MikeDocumentWire[];
  folders?: MikeFolderWire[];
  documentCount?: number;
  chatCount?: number;
  reviewCount?: number;
}): MikeProjectWire {
  return {
    id: input.id,
    user_id: MIKE_LOCAL_USER_ID,
    name: input.name,
    cm_number: input.cmNumber ?? null,
    practice: input.practice ?? null,
    shared_with: [],
    created_at: input.createdAt,
    updated_at: input.updatedAt,
    is_owner: true,
    owner_display_name: "Local User",
    owner_email: null,
    documents: input.documents ?? [],
    folders: input.folders ?? [],
    document_count: input.documentCount ?? 0,
    chat_count: input.chatCount ?? 0,
    review_count: input.reviewCount ?? 0,
  };
}
const fileTypeSet = new Set<string>(fileTypes);
const mimeFileTypes: Record<string, MikeFileType> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "docx",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-excel.sheet.macroEnabled.12": "xlsm",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    "pptx",
  "application/vnd.ms-powerpoint": "ppt",
  "text/plain": "txt",
  "text/markdown": "md",
};
export function mikeFileTypeFor(
  filename: string,
  mimeType: string | null | undefined,
): MikeFileType | null {
  const extension = filename.includes(".")
    ? filename.split(".").pop()?.toLowerCase()
    : undefined;
  const filenameType =
    extension && fileTypeSet.has(extension)
      ? (extension as MikeFileType)
      : null;
  const mimeTypeMapped = mimeType
    ? (mimeFileTypes[mimeType.toLowerCase().trim()] ?? null)
    : null;
  return filenameType && mimeTypeMapped && filenameType !== mimeTypeMapped
    ? null
    : (filenameType ?? mimeTypeMapped);
}
export function serializeMikeDocument(input: {
  id: string;
  projectId: string | null;
  folderId: string | null;
  filename: string;
  mimeType: string | null;
  sizeBytes: number;
  pageCount: number | null;
  status:
    | "pending"
    | "processing"
    | "ready"
    | "failed"
    | "unsupported"
    | "ocr_required";
  createdAt: string;
  updatedAt: string;
  activeVersionNumber?: number | null;
  latestVersionNumber?: number | null;
  hasPreview: boolean;
}): MikeDocumentWire {
  return {
    id: input.id,
    user_id: MIKE_LOCAL_USER_ID,
    project_id: input.projectId,
    folder_id: input.folderId,
    filename: input.filename,
    owner_email: null,
    owner_display_name: "Local User",
    file_type: mikeFileTypeFor(input.filename, input.mimeType),
    storage_path: null,
    pdf_storage_path: input.hasPreview ? "local-preview" : null,
    size_bytes: input.sizeBytes,
    page_count: input.pageCount,
    structure_tree: null,
    status: documentStatus(input.status),
    created_at: input.createdAt,
    updated_at: input.updatedAt,
    active_version_number: input.activeVersionNumber ?? null,
    latest_version_number: input.latestVersionNumber ?? null,
  };
}
export function serializeMikeDocumentVersion(input: {
  id: string;
  versionNumber: number | null;
  source: string;
  filename: string | null;
  mimeType?: string | null;
  sizeBytes?: number | null;
  pageCount?: number | null;
  createdAt: string;
  deletedAt?: string | null;
  deletedBy?: string | null;
}): MikeDocumentVersionWire {
  return {
    id: input.id,
    version_number: input.versionNumber,
    source: input.source,
    created_at: input.createdAt,
    filename: input.filename,
    file_type: input.filename
      ? mikeFileTypeFor(input.filename, input.mimeType)
      : null,
    size_bytes: input.sizeBytes ?? null,
    page_count: input.pageCount ?? null,
    deleted_at: input.deletedAt ?? null,
    deleted_by: input.deletedBy ?? null,
  };
}
export function serializeMikeChat(input: {
  id: string;
  projectId: string | null;
  title: string;
  createdAt: string;
}): MikeChatWire {
  return {
    id: input.id,
    project_id: input.projectId,
    user_id: MIKE_LOCAL_USER_ID,
    creator_display_name: "Local User",
    title: input.title,
    created_at: input.createdAt,
  };
}
export function serializeMikeWorkflow(input: {
  id: string;
  title: string;
  type: "assistant" | "tabular";
  description?: string | null;
  language?: string;
  version?: string | null;
  practice?: string | null;
  jurisdictions?: string[] | null;
  skillMd?: string | null;
  columnsConfig?: MikeColumnConfig[] | null;
  createdAt: string;
  isSystem?: boolean;
}): MikeWorkflowWire {
  return {
    id: input.id,
    user_id: input.isSystem ? null : MIKE_LOCAL_USER_ID,
    metadata: {
      title: input.title,
      description: input.description ?? null,
      type: input.type,
      contributors: [],
      language: input.language ?? "en",
      version: input.version ?? null,
      practice: input.practice ?? null,
      jurisdictions: input.jurisdictions ?? [],
    },
    skill_md: input.skillMd ?? "",
    columns_config: input.columnsConfig ?? [],
    is_system: input.isSystem ?? false,
    created_at: input.createdAt,
    shared_by_name: null,
    allow_edit: !input.isSystem,
    is_owner: !input.isSystem,
    open_source_submission: null,
  };
}
export function serializeMikeTabularCell(input: {
  id: string;
  reviewId: string;
  documentId: string;
  columnIndex: number;
  summary?: string;
  flag?: "green" | "grey" | "yellow" | "red";
  reasoning?: string | null;
  status: WorkspaceTabularCellStatus;
  createdAt: string;
}): MikeTabularCellWire {
  return {
    id: input.id,
    review_id: input.reviewId,
    document_id: input.documentId,
    column_index: input.columnIndex,
    content:
      input.summary === undefined
        ? null
        : {
            summary: input.summary,
            ...(input.flag ? { flag: input.flag } : {}),
            ...(input.reasoning ? { reasoning: input.reasoning } : {}),
          },
    status: toMikeTabularStatus(input.status),
    created_at: input.createdAt,
  };
}
export function assertMikeSafePayload(value: unknown) {
  if (typeof value === "string") {
    if (
      /(?:^file:|^[A-Za-z]:[\\/]|^\\\\|\/(?:Users|home|tmp|var|private|etc|opt|mnt|Volumes)(?:\/|$))/i.test(
        value,
      ) ||
      /(?:api[_-]?key|secret|password|credential)\s*[:=]/i.test(value) ||
      /\bbearer\s+\S+/i.test(value) ||
      /\bsk-[A-Za-z0-9_-]{20,}\b/.test(value) ||
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/.test(value)
    )
      throw new Error("Unsafe Mike compatibility payload value.");
    return;
  }
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) assertMikeSafePayload(item);
    return;
  }
  for (const key of Object.keys(value as Record<string, unknown>)) {
    const child = (value as Record<string, unknown>)[key];
    if (key === "storage_path" && child === null) continue;
    if (
      key === "pdf_storage_path" &&
      (child === null || child === "local-preview")
    )
      continue;
    if (key === "download_url" && opaqueDownloadUrl(child)) continue;
    if (sensitiveKey(key))
      throw new Error("Unsafe Mike compatibility payload key.");
    assertMikeSafePayload(child);
  }
}
