import { z } from "zod";

import { MIKE_LOCAL_USER_ID } from "./mikeCompatibility";
import type {
  AssistantMessageSource,
  ChatMessageAttachment,
} from "./repositories/chats";
import type { AssistantLegalAuthoritySourceV22 } from "./legalResearchPersistenceContractsV22";
import type { Chat, ChatMessage } from "./types";

const Id = z.string().uuid();
const SafeText = z.string().max(200_000);
const MikeChatLimitSchema = z.union([
  z
    .string()
    .regex(/^[1-9]\d*$/)
    .max(64)
    .transform((value) => {
      const parsed = BigInt(value);
      return parsed > 100n ? 100 : Number(parsed);
    }),
  z
    .number()
    .int()
    .positive()
    .finite()
    .transform((value) => Math.min(value, 100)),
]);

export const MikeChatListQuerySchema = z
  .object({
    limit: MikeChatLimitSchema.optional(),
    cursor: z.string().min(1).max(512).optional(),
    project_id: Id.nullable().optional(),
  })
  .strict();

export const MikeCreateChatRequestSchema = z
  .object({
    project_id: Id.nullable().optional(),
    title: z.string().trim().min(1).max(240).optional(),
    model_profile_id: Id.nullable().optional(),
  })
  .strict();

export const MikeUpdateChatRequestSchema = z
  .object({ title: z.string().trim().min(1).max(240) })
  .strict();

const MikeInputFileSchema = z
  .object({
    filename: z.string().trim().min(1).max(500),
    document_id: Id.optional(),
  })
  .strict();

const MikeInputWorkflowSchema = z
  .object({ id: Id, title: z.string().trim().min(1).max(240) })
  .strict();

const MikeInputMessageSchema = z
  .object({
    role: z.enum(["user", "assistant"]),
    content: z.string().max(100_000),
    files: z.array(MikeInputFileSchema).max(50).optional(),
    workflow: MikeInputWorkflowSchema.optional(),
  })
  .strict();

const AskInputsResponseSchema = z
  .object({
    responses: z
      .array(
        z.discriminatedUnion("kind", [
          z
            .object({
              id: z.string().min(1).max(160),
              kind: z.literal("choice"),
              question: z.string().max(4_000),
              answer: z.string().max(20_000).optional(),
              skipped: z.boolean().optional(),
            })
            .strict(),
          z
            .object({
              id: z.string().min(1).max(160),
              kind: z.literal("documents"),
              filenames: z.array(z.string().min(1).max(500)).max(50),
              skipped: z.boolean().optional(),
            })
            .strict(),
        ]),
      )
      .max(100),
  })
  .strict();

export const MikeChatGenerationRequestSchema = z
  .object({
    messages: z.array(MikeInputMessageSchema).min(1).max(200),
    chat_id: Id.optional(),
    project_id: Id.optional(),
    model: z.string().trim().min(1).max(240).optional(),
    model_profile_id: Id.optional(),
    ask_inputs_response: AskInputsResponseSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.messages.at(-1)?.role !== "user") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["messages"],
        message: "The final message must be a user message.",
      });
    }
    if (value.model && value.model_profile_id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["model"],
        message: "Use either model or model_profile_id, not both.",
      });
    }
    const workflowIndex = value.messages.findIndex(
      (message) => message.workflow !== undefined,
    );
    if (workflowIndex >= 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["messages", workflowIndex, "workflow"],
        message:
          "Assistant workflow snapshots are not enabled for local generation.",
      });
    }
    if (value.ask_inputs_response !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ask_inputs_response"],
        message:
          "Assistant ask-input responses are not enabled for local generation.",
      });
    }
  });

const ProjectDocumentSchema = z
  .object({ filename: z.string().trim().min(1).max(500), document_id: Id })
  .strict();

export const MikeProjectChatGenerationRequestSchema = z
  .object({
    messages: z.array(MikeInputMessageSchema).min(1).max(200),
    chat_id: Id.optional(),
    model: z.string().trim().min(1).max(240).optional(),
    model_profile_id: Id.optional(),
    displayed_doc: ProjectDocumentSchema.optional(),
    attached_documents: z.array(ProjectDocumentSchema).max(50).optional(),
    ask_inputs_response: AskInputsResponseSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.messages.at(-1)?.role !== "user") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["messages"],
        message: "The final message must be a user message.",
      });
    }
    if (value.model && value.model_profile_id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["model"],
        message: "Use either model or model_profile_id, not both.",
      });
    }
    const workflowIndex = value.messages.findIndex(
      (message) => message.workflow !== undefined,
    );
    if (workflowIndex >= 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["messages", workflowIndex, "workflow"],
        message:
          "Assistant workflow snapshots are not enabled for local generation.",
      });
    }
    if (value.ask_inputs_response !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ask_inputs_response"],
        message:
          "Assistant ask-input responses are not enabled for local generation.",
      });
    }
  });

export const AssistantGenerationInputSchema = z
  .object({
    chatId: Id,
    prompt: z.string().trim().min(1).max(100_000),
    modelProfileId: Id.optional(),
    modelSelector: z.string().trim().min(1).max(240).optional(),
    allowedDocumentIds: z.array(Id).max(50).default([]),
    attachmentDocumentIds: z.array(Id).max(50).default([]),
    retrievalLimit: z.number().int().min(1).max(200).default(40),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.modelProfileId && value.modelSelector) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["modelSelector"],
        message: "Only one model selector may be provided.",
      });
    }
    const allowed = new Set(value.allowedDocumentIds);
    for (const documentId of value.attachmentDocumentIds) {
      if (!allowed.has(documentId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["attachmentDocumentIds"],
          message: "Every attachment must be included in allowedDocumentIds.",
        });
        break;
      }
    }
  });

export type AssistantGenerationInput = z.infer<
  typeof AssistantGenerationInputSchema
>;

export type MikeNormalizedGeneration = Readonly<{
  chatId: string | null;
  projectId: string | null;
  prompt: string;
  modelProfileId: string | null;
  modelSelector: string | null;
  allowedDocumentIds: string[];
  attachmentDocumentIds: string[];
}>;

function unique(values: readonly (string | undefined)[]) {
  return [
    ...new Set(values.filter((value): value is string => Boolean(value))),
  ];
}

export function parseMikeChatGeneration(
  value: unknown,
): MikeNormalizedGeneration {
  const parsed = MikeChatGenerationRequestSchema.parse(value);
  const prompt = parsed.messages.at(-1)!;
  const attachments = unique(
    prompt.files?.map((file) => file.document_id) ?? [],
  );
  return {
    chatId: parsed.chat_id ?? null,
    projectId: parsed.project_id ?? null,
    prompt: prompt.content,
    modelProfileId: parsed.model_profile_id ?? null,
    modelSelector: parsed.model ?? null,
    allowedDocumentIds: attachments,
    attachmentDocumentIds: attachments,
  };
}

export function parseMikeProjectChatGeneration(
  projectId: string,
  value: unknown,
): MikeNormalizedGeneration {
  const parsed = MikeProjectChatGenerationRequestSchema.parse(value);
  const prompt = parsed.messages.at(-1)!;
  const messageAttachments =
    prompt.files?.map((file) => file.document_id) ?? [];
  const explicitAttachments =
    parsed.attached_documents?.map((document) => document.document_id) ?? [];
  const attachmentDocumentIds = unique([
    ...messageAttachments,
    ...explicitAttachments,
  ]);
  const allowedDocumentIds = unique([
    ...attachmentDocumentIds,
    parsed.displayed_doc?.document_id,
  ]);
  return {
    chatId: parsed.chat_id ?? null,
    projectId,
    prompt: prompt.content,
    modelProfileId: parsed.model_profile_id ?? null,
    modelSelector: parsed.model ?? null,
    allowedDocumentIds,
    attachmentDocumentIds,
  };
}

export const MikeChatSchema = z
  .object({
    id: Id,
    project_id: Id.nullable(),
    user_id: Id,
    title: z.string().max(240).nullable(),
    created_at: z.string().datetime(),
  })
  .strict();

const HydratedCapabilitySchema = z
  .object({ can_read: z.boolean(), can_download: z.boolean() })
  .strict();

export type AssistantHydratedCapability = z.infer<
  typeof HydratedCapabilitySchema
>;

const MikeFileSchema = z
  .object({
    filename: z.string().min(1).max(500),
    document_id: Id,
    version_id: Id,
    capability: HydratedCapabilitySchema,
  })
  .strict();

const MikeDocumentCitationSchema = z
  .object({
    type: z.literal("citation_data"),
    kind: z.literal("document"),
    ref: z.number().int().positive(),
    doc_id: Id,
    document_id: Id,
    version_id: Id,
    filename: z.string().min(1).max(500),
    page: z.union([z.number().int().positive(), z.string().min(1).max(50)]),
    quote: z
      .string()
      .min(1)
      .max(8_000)
      .refine((quote) => quote.trim().length > 0),
    quotes: z
      .array(
        z
          .object({
            page: z.union([
              z.number().int().positive(),
              z.string().min(1).max(50),
            ]),
            quote: z
              .string()
              .min(1)
              .max(8_000)
              .refine((quote) => quote.trim().length > 0),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();

const MikeLegalAuthorityLocatorSchema = z
  .object({
    article: z.string().trim().min(1).max(160).optional(),
    section: z.string().trim().min(1).max(300).optional(),
    paragraph: z.string().trim().min(1).max(160).optional(),
    page: z.number().int().positive().max(1_000_000).optional(),
  })
  .strict();

const MikeLegalAuthorityCitationSchema = z
  .object({
    type: z.literal("citation_data"),
    kind: z.literal("legal_authority"),
    ref: z.number().int().positive().max(200),
    title: z.string().trim().min(1).max(500),
    source_type: z.enum([
      "statute",
      "regulation",
      "judicial_interpretation",
      "case",
      "guidance",
    ]),
    locator: MikeLegalAuthorityLocatorSchema,
    quote: z
      .string()
      .min(1)
      .max(8_000)
      .refine((quote) => quote.trim().length > 0),
  })
  .strict();

const MikeAssistantCitationSchema = z.discriminatedUnion("kind", [
  MikeDocumentCitationSchema,
  MikeLegalAuthorityCitationSchema,
]);

const MikeServerMessageSchema = z
  .object({
    id: Id,
    chat_id: Id,
    role: z.enum(["user", "assistant"]),
    content: z.union([
      SafeText,
      z.array(
        z.object({ type: z.literal("content"), text: SafeText }).strict(),
      ),
    ]),
    files: z.array(MikeFileSchema).optional(),
    citations: z.array(MikeAssistantCitationSchema).max(1_000).optional(),
    events: z
      .array(
        z.discriminatedUnion("type", [
          z.object({
            type: z.literal("draft_created"),
            draft_id: Id,
            version_id: Id,
            title: z.string().min(1).max(240),
            route: z
              .string()
              .regex(
                /^\/projects\/[0-9a-f-]{36}\/documents\/[0-9a-f-]{36}\/studio$/,
              ),
          }).strict(),
          z.object({
            type: z.literal("tabular_review_created"),
            review_id: Id,
            title: z.string().min(1).max(240),
            route: z
              .string()
              .regex(
                /^\/projects\/[0-9a-f-]{36}\/tabular-reviews\/[0-9a-f-]{36}$/,
              ),
            document_count: z.number().int().min(2).max(50),
          }).strict(),
        ]),
      )
      .max(10)
      .optional(),
    created_at: z.string().datetime(),
  })
  .strict();

export const MikeChatDetailSchema = z
  .object({
    chat: MikeChatSchema,
    messages: z.array(MikeServerMessageSchema),
  })
  .strict();

export const MikeGenerationAcceptedSchema = z
  .object({
    chat_id: Id,
    job_id: Id,
    prompt_message_id: Id,
    output_message_id: Id,
    status: z.literal("queued"),
  })
  .strict();

export const MikeGenerationStatusSchema = z
  .object({
    job_id: Id,
    chat_id: Id,
    prompt_message_id: Id,
    output_message_id: Id,
    status: z.enum([
      "queued",
      "running",
      "complete",
      "failed",
      "cancelled",
      "interrupted",
    ]),
    attempt: z.number().int().nonnegative().max(100),
    active_attempt: z.number().int().positive().max(100),
    max_attempts: z.number().int().positive().max(100),
    retryable: z.boolean(),
    cancel_requested: z.boolean(),
    terminal: z.boolean(),
  })
  .strict();

export const MikeGenerationControlSchema = z
  .object({
    job_id: Id,
    status: z.enum([
      "queued",
      "running",
      "complete",
      "failed",
      "cancelled",
      "interrupted",
    ]),
    cancel_requested: z.boolean(),
    terminal: z.boolean(),
  })
  .strict();

export const MikeGenerationEventRecordSchema = z
  .object({
    cursor: z.number().int().positive().max(2_147_483_647),
    attempt: z.number().int().positive().max(100),
    event: z.lazy(() => MikeAssistantStreamEventSchema),
    terminal: z.boolean(),
    created_at: z.string().datetime(),
  })
  .strict();

export const MikeGenerationReplaySchema = z
  .object({
    job_id: Id,
    status: z.enum([
      "queued",
      "running",
      "complete",
      "failed",
      "cancelled",
      "interrupted",
    ]),
    attempt: z.number().int().positive().max(100),
    terminal: z.boolean(),
    events: z.array(MikeGenerationEventRecordSchema).max(100),
    next_cursor: z.number().int().nonnegative().max(2_147_483_647),
  })
  .strict();

export const MikeAssistantStreamEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("chat_id"), chatId: Id }).strict(),
  z
    .object({
      type: z.literal("status"),
      job_id: Id,
      status: z.enum(["queued", "running", "retrying"]),
    })
    .strict(),
  z.object({ type: z.literal("content_delta"), text: SafeText }).strict(),
  z.object({ type: z.literal("content_done") }).strict(),
  z.object({ type: z.literal("reasoning_delta"), text: SafeText }).strict(),
  z.object({ type: z.literal("reasoning_block_end") }).strict(),
  z
    .object({
      type: z.literal("tool_call_start"),
      name: z.enum([
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
      ]),
    })
    .strict(),
  z
    .object({
      type: z.literal("doc_read_start"),
      filename: z.string().min(1).max(500),
    })
    .strict(),
  z
    .object({
      type: z.literal("doc_read"),
      filename: z.string().min(1).max(500),
      document_id: Id.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("doc_find_start"),
      filename: z.string().min(1).max(500),
      query: z.string().min(1).max(2_000),
    })
    .strict(),
  z
    .object({
      type: z.literal("doc_find"),
      filename: z.string().min(1).max(500),
      query: z.string().min(1).max(2_000),
      total_matches: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      type: z.literal("workflow_applied"),
      workflow_id: Id,
      title: z.string().min(1).max(240),
    })
    .strict(),
  z
    .object({
      type: z.literal("draft_created"),
      draft_id: Id,
      version_id: Id,
      title: z.string().min(1).max(240),
      route: z
        .string()
        .regex(/^\/projects\/[0-9a-f-]{36}\/documents\/[0-9a-f-]{36}\/studio$/),
    })
    .strict(),
  z
    .object({
      type: z.literal("tabular_review_created"),
      review_id: Id,
      title: z.string().min(1).max(240),
      route: z
        .string()
        .regex(
          /^\/projects\/[0-9a-f-]{36}\/tabular-reviews\/[0-9a-f-]{36}$/,
        ),
      document_count: z.number().int().min(2).max(50),
    })
    .strict(),
  MikeDocumentCitationSchema,
  z
    .object({ type: z.literal("complete"), message_id: Id, job_id: Id })
    .strict(),
  z
    .object({
      type: z.literal("error"),
      code: z.string().min(1).max(160).optional(),
      message: z.string().min(1).max(2_000),
    })
    .strict(),
]);

export type MikeAssistantStreamEvent = z.infer<
  typeof MikeAssistantStreamEventSchema
>;

export function toMikeChat(chat: Chat) {
  return MikeChatSchema.parse({
    id: chat.id,
    project_id: chat.projectId,
    user_id: MIKE_LOCAL_USER_ID,
    title: chat.title || null,
    created_at: chat.createdAt,
  });
}

function toMikeCitation(source: AssistantMessageSource) {
  if (typeof source.quote !== "string" || source.quote.trim().length === 0) {
    return null;
  }
  const page =
    typeof source.locator.pageStart === "number"
      ? source.locator.pageEnd &&
        source.locator.pageEnd !== source.locator.pageStart
        ? `${source.locator.pageStart}-${source.locator.pageEnd}`
        : source.locator.pageStart
      : 1;
  const quote = source.quote;
  return MikeDocumentCitationSchema.parse({
    type: "citation_data",
    kind: "document",
    ref: source.citationMetadata.citationNumber ?? source.citationOrdinal + 1,
    doc_id: source.documentId,
    document_id: source.documentId,
    version_id: source.versionId,
    filename: source.filename,
    page,
    quote,
    quotes: [{ page, quote }],
  });
}

function toMikeLegalAuthorityCitation(
  source: AssistantLegalAuthoritySourceV22,
) {
  return MikeLegalAuthorityCitationSchema.parse({
    type: "citation_data",
    kind: "legal_authority",
    ref: source.citationMetadata.citationNumber,
    title: source.title,
    source_type: source.sourceType,
    locator: source.locator,
    quote: source.exactQuote,
  });
}

export function toMikeChatDetail(input: {
  chat: Chat;
  messages: readonly (ChatMessage & {
    attachments: readonly (ChatMessageAttachment & {
      capability: AssistantHydratedCapability;
    })[];
    sources: readonly AssistantMessageSource[];
    legalAuthoritySources?: readonly AssistantLegalAuthoritySourceV22[];
    events?: readonly Extract<
      MikeAssistantStreamEvent,
      { type: "draft_created" | "tabular_review_created" }
    >[];
  })[];
}) {
  return MikeChatDetailSchema.parse({
    chat: toMikeChat(input.chat),
    messages: input.messages
      .filter(
        (message) => message.role === "user" || message.role === "assistant",
      )
      .map((message) => {
        const citations = [
          ...message.sources
            .map(toMikeCitation)
            .filter((citation): citation is NonNullable<typeof citation> =>
              Boolean(citation),
            ),
          ...(message.legalAuthoritySources ?? []).map(
            toMikeLegalAuthorityCitation,
          ),
        ].sort((left, right) => left.ref - right.ref);
        return {
          id: message.id,
          chat_id: message.chatId,
          role: message.role,
          content:
            message.role === "assistant"
              ? [{ type: "content", text: message.content }]
              : message.content,
          ...(message.attachments.length
            ? {
                files: message.attachments.map((attachment) => ({
                  filename: attachment.filename,
                  document_id: attachment.documentId,
                  version_id: attachment.versionId,
                  capability: attachment.capability,
                })),
              }
            : {}),
          ...(citations.length ? { citations } : {}),
          ...(message.events?.length ? { events: message.events } : {}),
          created_at: message.createdAt,
        };
      }),
  });
}
