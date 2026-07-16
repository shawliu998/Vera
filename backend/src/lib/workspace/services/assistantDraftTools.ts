import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

import type { WorkspaceDatabaseAdapter } from "../database";
import { assertMikeSafePayload } from "../mikeCompatibility";
import type {
  AssistantGenerationSnapshot,
  ChatsRepository,
} from "../repositories/chats";
import type {
  CreateDocumentStudioSuggestionFromToolInput,
  WorkspaceDocumentStudioService,
} from "./documentStudio";
import type {
  AssistantModelSource,
  AssistantModelToolCall,
  AssistantToolContext,
  AssistantToolDefinition,
} from "./assistantRuntime";
import {
  hashAssistantActionInput,
  type WorkspaceAssistantActionLedger,
} from "./assistantActionLedger";
import type { AssistantToolModule } from "./assistantToolRegistry";

const MAX_CREATE_INPUT_JSON_CHARS = 98_000;
const MAX_DRAFT_CONTENT_CHARS = 90_000;
const MAX_READ_CHARS = 100_000;
const MAX_RESULT_JSON_CHARS = 150_000;
const MAX_EDIT_TEXT_CHARS = 20_000;
const MAX_SOURCE_REFERENCES = 200;
const MAX_TRACKED_ATTEMPTS = 256;
const MAX_READ_RANGES_PER_DRAFT = 32;

const Id = z.string().uuid();
const DraftEvidenceSource = z
  .object({
    evidenceId: Id,
    exactQuote: z.string().min(1).max(8_000),
  })
  .strict();

export const WORKSPACE_ASSISTANT_DRAFT_TOOL_MODULE_ID =
  "workspace-draft-tools-v1";

const DocumentType = z.enum([
  "legal_research_memo",
  "legal_opinion",
  "contract_review_memo",
  "due_diligence_report",
  "litigation_strategy_memo",
  "lawyer_letter",
  "contract_clause",
  "general_legal_document",
]);
const UniqueIds = z
  .array(Id)
  .max(MAX_SOURCE_REFERENCES)
  .refine((ids) => new Set(ids).size === ids.length, {
    message: "Source identifiers must be unique.",
  });
const CreateDraftInput = z
  .object({
    title: z.string().trim().min(1).max(240),
    documentType: DocumentType,
    contentMarkdown: z.string().max(MAX_DRAFT_CONTENT_CHARS),
    sourceSnapshotIds: UniqueIds.optional(),
    citationAnchorIds: UniqueIds.optional(),
    evidenceSources: z
      .array(DraftEvidenceSource)
      .max(MAX_SOURCE_REFERENCES)
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (JSON.stringify(value).length > MAX_CREATE_INPUT_JSON_CHARS) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Draft creation input exceeds the Assistant tool budget.",
      });
    }
  });
const ReadDraftInput = z
  .object({
    draftId: Id,
    startOffset: z.number().int().nonnegative().default(0),
    maxChars: z.number().int().min(1).max(MAX_READ_CHARS).default(40_000),
  })
  .strict();
const SuggestDraftEditInput = z
  .object({
    draftId: Id,
    revision: Id,
    startOffset: z.number().int().nonnegative(),
    endOffset: z.number().int().nonnegative(),
    exactDeletedText: z.string().max(MAX_EDIT_TEXT_CHARS),
    insertedText: z.string().max(MAX_EDIT_TEXT_CHARS),
    summary: z.string().trim().min(1).max(500),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.endOffset - value.startOffset !== value.exactDeletedText.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endOffset"],
        message: "Edit offsets must span exactDeletedText UTF-16 text.",
      });
    }
    if (
      value.exactDeletedText.length === 0 &&
      value.insertedText.length === 0
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["insertedText"],
        message: "Draft suggestion must change the raw Markdown.",
      });
    }
  });

const CREATE_DRAFT_TOOL: AssistantToolDefinition = Object.freeze({
  name: "create_draft",
  description:
    "Create a new Vera Document Studio Draft in the current Matter. This never overwrites an existing document. Durable citations are rebuilt server-side from the current Assistant run; returned route opens the new Draft.",
  inputSchema: Object.freeze({
    type: "object",
    properties: Object.freeze({
      title: Object.freeze({ type: "string", minLength: 1, maxLength: 240 }),
      documentType: Object.freeze({
        type: "string",
        enum: Object.freeze([...DocumentType.options]),
      }),
      contentMarkdown: Object.freeze({
        type: "string",
        maxLength: MAX_DRAFT_CONTENT_CHARS,
      }),
      sourceSnapshotIds: Object.freeze({
        type: "array",
        maxItems: MAX_SOURCE_REFERENCES,
        uniqueItems: true,
        items: Object.freeze({ type: "string", format: "uuid" }),
      }),
      citationAnchorIds: Object.freeze({
        type: "array",
        maxItems: MAX_SOURCE_REFERENCES,
        uniqueItems: true,
        items: Object.freeze({ type: "string", format: "uuid" }),
      }),
      evidenceSources: Object.freeze({
        type: "array",
        maxItems: MAX_SOURCE_REFERENCES,
        description:
          "Exact evidence returned by a document read/search in this Assistant attempt. Durable snapshots and anchors are rebuilt server-side.",
        items: Object.freeze({
          type: "object",
          properties: Object.freeze({
            evidenceId: Object.freeze({ type: "string", format: "uuid" }),
            exactQuote: Object.freeze({
              type: "string",
              minLength: 1,
              maxLength: 8_000,
            }),
          }),
          required: Object.freeze(["evidenceId", "exactQuote"]),
          additionalProperties: false,
        }),
      }),
    }),
    required: Object.freeze(["title", "documentType", "contentMarkdown"]),
    additionalProperties: false,
  }),
});

const READ_DRAFT_TOOL: AssistantToolDefinition = Object.freeze({
  name: "read_draft",
  description:
    "Read a bounded range of the current raw Markdown and its current revision. Offsets are UTF-16 code units. Read the exact edit range before calling suggest_draft_edit.",
  inputSchema: Object.freeze({
    type: "object",
    properties: Object.freeze({
      draftId: Object.freeze({ type: "string", format: "uuid" }),
      startOffset: Object.freeze({ type: "integer", minimum: 0, default: 0 }),
      maxChars: Object.freeze({
        type: "integer",
        minimum: 1,
        maximum: MAX_READ_CHARS,
        default: 40_000,
      }),
    }),
    required: Object.freeze(["draftId"]),
    additionalProperties: false,
  }),
});

const SUGGEST_DRAFT_EDIT_TOOL: AssistantToolDefinition = Object.freeze({
  name: "suggest_draft_edit",
  description:
    "Create a pending edit suggestion against the exact current Draft revision and exact raw Markdown previously read in this Assistant attempt. This never changes the Draft; only the user can accept or reject it in Studio.",
  inputSchema: Object.freeze({
    type: "object",
    properties: Object.freeze({
      draftId: Object.freeze({ type: "string", format: "uuid" }),
      revision: Object.freeze({ type: "string", format: "uuid" }),
      startOffset: Object.freeze({ type: "integer", minimum: 0 }),
      endOffset: Object.freeze({ type: "integer", minimum: 0 }),
      exactDeletedText: Object.freeze({
        type: "string",
        maxLength: MAX_EDIT_TEXT_CHARS,
      }),
      insertedText: Object.freeze({
        type: "string",
        maxLength: MAX_EDIT_TEXT_CHARS,
      }),
      summary: Object.freeze({ type: "string", minLength: 1, maxLength: 500 }),
    }),
    required: Object.freeze([
      "draftId",
      "revision",
      "startOffset",
      "endOffset",
      "exactDeletedText",
      "insertedText",
      "summary",
    ]),
    additionalProperties: false,
  }),
});

const DRAFT_TOOLS = Object.freeze([
  CREATE_DRAFT_TOOL,
  READ_DRAFT_TOOL,
  SUGGEST_DRAFT_EDIT_TOOL,
]);

type ReadRange = Readonly<{ startOffset: number; endOffset: number }>;
type DraftReadMap = Map<string, ReadRange[]>;

class AssistantDraftToolError extends Error {
  readonly code = "assistant_tool_failed";
  readonly retryable = false;
  readonly details = null;

  constructor(message = "Assistant Draft tool failed.") {
    super(message);
    this.name = "AssistantDraftToolError";
  }
}

function abortError() {
  const error = new Error("Assistant Draft operation was cancelled.");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw abortError();
}

function safeJson(value: unknown) {
  assertMikeSafePayload(value);
  const content = JSON.stringify(value);
  if (content.length > MAX_RESULT_JSON_CHARS) {
    throw new AssistantDraftToolError(
      "Assistant Draft result exceeds the local context budget.",
    );
  }
  return content;
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

function executionKey(context: AssistantToolContext) {
  return `${context.jobId}\0${context.attempt}`;
}

function deterministicUuid(seed: string) {
  const bytes = Buffer.from(
    createHash("sha256").update(seed).digest().subarray(0, 16),
  );
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function draftWriteIdentity(
  context: AssistantToolContext,
  input: z.infer<typeof CreateDraftInput>,
) {
  const semanticHash = createHash("sha256")
    .update(
      JSON.stringify({
        title: input.title,
        documentType: input.documentType,
        contentMarkdown: input.contentMarkdown,
        evidenceSources: input.evidenceSources ?? [],
      }),
    )
    .digest("hex");
  const seed = `${context.jobId}\0create_draft\0${semanticHash}`;
  return {
    documentId: deterministicUuid(`${seed}\0document`),
    versionId: deterministicUuid(`${seed}\0version`),
    jobId: deterministicUuid(`${seed}\0parse-job`),
    operationId: `assistant-draft:${context.jobId}:${semanticHash}`,
  };
}

function assistantSuggestionChangeId(
  jobId: string,
  input: z.infer<typeof SuggestDraftEditInput>,
) {
  return `assistant-tool:${createHash("sha256")
    .update(
      `${jobId}\0${input.draftId}\0${input.revision}\0${input.startOffset}\0${input.endOffset}\0${input.exactDeletedText}\0${input.insertedText}\0${input.summary}`,
      "utf8",
    )
    .digest("hex")}`;
}

/**
 * Project-scoped Draft capability backed exclusively by Document Studio.
 * No renderer/model-supplied path, version for creation, or source record is
 * trusted. Every operation rehydrates the durable Assistant generation and
 * rechecks the active Matter/Draft relationship in SQLite.
 */
export class WorkspaceAssistantDraftToolModule implements AssistantToolModule {
  readonly id = WORKSPACE_ASSISTANT_DRAFT_TOOL_MODULE_ID;
  private readonly reads = new Map<string, DraftReadMap>();

  constructor(
    private readonly database: WorkspaceDatabaseAdapter,
    private readonly chats: Pick<
      ChatsRepository,
      "generationSnapshot" | "assertGenerationDocumentsCurrent"
    >,
    private readonly studio: Pick<
      WorkspaceDocumentStudioService,
      | "createDraft"
      | "getDocument"
      | "getSuggestion"
      | "createSuggestionFromAssistantTool"
    >,
    private readonly rebuildEvidenceAnchors: (
      projectId: string,
      content: string,
      sources: readonly AssistantModelSource[],
    ) => string[],
    private readonly actions: Pick<
      WorkspaceAssistantActionLedger,
      "reserve" | "complete"
    >,
  ) {}

  private evidenceSources(
    context: AssistantToolContext,
    requested: readonly z.infer<typeof DraftEvidenceSource>[],
  ): AssistantModelSource[] {
    const available = context.evidence ?? [];
    const used = new Set<string>();
    return requested.map((request, index) => {
      const chunk = available.find(
        (candidate) => candidate.chunkId === request.evidenceId,
      );
      const relativeStart = chunk?.text.indexOf(request.exactQuote) ?? -1;
      if (
        !chunk ||
        relativeStart < 0 ||
        chunk.text.indexOf(request.exactQuote, relativeStart + 1) >= 0 ||
        used.has(request.evidenceId)
      ) {
        throw new AssistantDraftToolError(
          "Draft evidence was not read in this Assistant attempt or does not exactly match durable Matter content.",
        );
      }
      used.add(request.evidenceId);
      const startOffset = chunk.startOffset + relativeStart;
      const endOffset = startOffset + request.exactQuote.length;
      return {
        documentId: chunk.documentId,
        versionId: chunk.versionId,
        chunkId: chunk.chunkId,
        quote: request.exactQuote,
        startOffset,
        endOffset,
        locator: {
          ...(chunk.pageStart === null ? {} : { pageStart: chunk.pageStart }),
          ...(chunk.pageEnd === null ? {} : { pageEnd: chunk.pageEnd }),
          startOffset,
          endOffset,
        },
        rank: chunk.ordinal,
        score: chunk.score,
        citationOrdinal: index,
        citationMetadata: {
          citationNumber: index + 1,
          label: chunk.filename,
        },
      };
    });
  }

  private snapshot(context: AssistantToolContext) {
    const snapshot = this.chats.generationSnapshot(context.jobId);
    if (!sameContext(context, snapshot)) {
      throw new AssistantDraftToolError(
        "Assistant generation snapshot changed before Draft access.",
      );
    }
    this.chats.assertGenerationDocumentsCurrent(context.jobId);
    return snapshot;
  }

  private projectId(snapshot: AssistantGenerationSnapshot) {
    if (snapshot.payload.projectId === null) {
      throw new AssistantDraftToolError(
        "Draft tools require an active Matter-scoped Assistant run.",
      );
    }
    return snapshot.payload.projectId;
  }

  private currentDraftVersion(projectId: string, draftId: string) {
    const row = this.database
      .prepare(
        `SELECT document.current_version_id
           FROM documents document
           JOIN projects project
             ON project.id = document.project_id AND project.status = 'active'
           JOIN document_studio_versions studio
             ON studio.project_id = document.project_id
            AND studio.document_id = document.id
            AND studio.version_id = document.current_version_id
          WHERE document.project_id = ?
            AND document.id = ?
            AND document.document_kind = 'draft'
            AND document.deleted_at IS NULL`,
      )
      .get(projectId, draftId);
    if (!row || typeof row.current_version_id !== "string") {
      throw new AssistantDraftToolError(
        "Draft was not found in the current active Matter.",
      );
    }
    return row.current_version_id;
  }

  private rememberRead(
    context: AssistantToolContext,
    draftId: string,
    revision: string,
    range: ReadRange,
  ) {
    const key = executionKey(context);
    const byDraft = this.reads.get(key) ?? new Map<string, ReadRange[]>();
    const draftKey = `${draftId}\0${revision}`;
    const ranges = byDraft.get(draftKey) ?? [];
    if (ranges.length >= MAX_READ_RANGES_PER_DRAFT) {
      throw new AssistantDraftToolError(
        "Assistant Draft read range limit was reached.",
      );
    }
    ranges.push(range);
    byDraft.set(draftKey, ranges);
    this.reads.delete(key);
    this.reads.set(key, byDraft);
    while (this.reads.size > MAX_TRACKED_ATTEMPTS) {
      const oldest = this.reads.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.reads.delete(oldest);
    }
  }

  private wasRead(
    context: AssistantToolContext,
    draftId: string,
    revision: string,
    startOffset: number,
    endOffset: number,
  ) {
    return Boolean(
      this.reads
        .get(executionKey(context))
        ?.get(`${draftId}\0${revision}`)
        ?.some(
          (range) =>
            startOffset >= range.startOffset && endOffset <= range.endOffset,
        ),
    );
  }

  async registeredTools(context: AssistantToolContext) {
    const snapshot = this.snapshot(context);
    this.reads.delete(executionKey(context));
    return snapshot.payload.projectId === null ? [] : DRAFT_TOOLS;
  }

  assertModelUse(context: AssistantToolContext) {
    this.snapshot(context);
  }

  async execute(input: {
    context: AssistantToolContext;
    call: AssistantModelToolCall;
    signal: AbortSignal;
  }) {
    throwIfAborted(input.signal);
    const snapshot = this.snapshot(input.context);
    const projectId = this.projectId(snapshot);

    if (input.call.name === "create_draft") {
      const parsed = CreateDraftInput.parse(input.call.input);
      // Validate every model-visible field before the irreversible create. The
      // Markdown body is intentionally not echoed in the result.
      assertMikeSafePayload({ title: parsed.title });
      if (
        (parsed.sourceSnapshotIds?.length ?? 0) > 0 ||
        (parsed.citationAnchorIds?.length ?? 0) > 0
      ) {
        throw new AssistantDraftToolError(
          "Draft durable source identifiers are rebuilt by the server; submit evidenceSources read in this attempt instead.",
        );
      }
      const writeIdentity = draftWriteIdentity(input.context, parsed);
      const actionInput = {
        title: parsed.title,
        documentType: parsed.documentType,
        contentMarkdown: parsed.contentMarkdown,
        evidenceSources: parsed.evidenceSources ?? [],
      };
      const actionKey = writeIdentity.operationId;
      const reservation = this.actions.reserve({
        jobId: input.context.jobId,
        attempt: input.context.attempt,
        leaseOwner: input.context.leaseOwner,
        projectId,
        actionKey,
        actionType: "create_draft",
        input: actionInput,
      });
      if (
        reservation.record.status === "complete" &&
        (reservation.record.resourceType !== "draft" ||
          reservation.record.resourceId !== writeIdentity.documentId)
      ) {
        throw new AssistantDraftToolError(
          "Completed Draft action identity does not match its durable resource.",
        );
      }
      const evidenceSources = this.evidenceSources(
        input.context,
        parsed.evidenceSources ?? [],
      );
      const citationAnchorIds = this.rebuildEvidenceAnchors(
        projectId,
        parsed.contentMarkdown,
        evidenceSources,
      );
      const existingStatement = this.database.prepare(
        `SELECT document.id,document.project_id,document.document_kind,
                  document.current_version_id,document.deleted_at,
                  studio.version_id,studio.operation_id,
                  metadata.document_type,metadata.origin_type,
                  metadata.origin_ref
             FROM documents document
             LEFT JOIN document_studio_versions studio
               ON studio.document_id = document.id
              AND studio.version_id = document.current_version_id
             LEFT JOIN document_studio_draft_metadata metadata
               ON metadata.project_id = document.project_id
              AND metadata.document_id = document.id
            WHERE document.id = ?`,
      );
      let existing = existingStatement.get(writeIdentity.documentId);
      if (
        existing &&
        (existing.project_id !== projectId ||
          existing.document_kind !== "draft" ||
          existing.deleted_at !== null ||
          existing.current_version_id !== writeIdentity.versionId ||
          existing.version_id !== writeIdentity.versionId ||
          existing.operation_id !== writeIdentity.operationId)
      ) {
        throw new AssistantDraftToolError(
          "The replay-safe Draft identity is already bound to another resource.",
        );
      }
      let existingDraft: Awaited<
        ReturnType<WorkspaceDocumentStudioService["getDocument"]>
      > | null = null;
      if (existing) {
        existingDraft = await this.studio.getDocument(
          projectId,
          writeIdentity.documentId,
        );
        if (
          existingDraft.document.id !== writeIdentity.documentId ||
          existingDraft.version.id !== writeIdentity.versionId ||
          existingDraft.document.title !== parsed.title ||
          existingDraft.content !== parsed.contentMarkdown ||
          !isDeepStrictEqual(
            existingDraft.version.citationAnchorIds,
            citationAnchorIds,
          )
        ) {
          throw new AssistantDraftToolError(
            "An existing replay-safe Draft identity does not match this action.",
          );
        }
        if (
          existing.document_type == null &&
          existing.origin_type == null &&
          existing.origin_ref == null
        ) {
          // A v19 create_draft may have committed its immutable document before
          // the additive v20 metadata table existed. The action ledger has
          // rebound this retry to the same canonical input hash and the full
          // durable body/citations were verified above before this repair.
          const inserted = this.database
            .prepare(
              `INSERT INTO document_studio_draft_metadata (
                 document_id,project_id,document_type,origin_type,origin_ref,
                 created_at
               )
               SELECT document.id,document.project_id,?,'assistant',?,?
                 FROM documents document
                 JOIN document_studio_versions studio
                   ON studio.project_id = document.project_id
                  AND studio.document_id = document.id
                  AND studio.version_id = document.current_version_id
                WHERE document.id = ?
                  AND document.project_id = ?
                  AND document.document_kind = 'draft'
                  AND document.deleted_at IS NULL
                  AND document.current_version_id = ?
                  AND studio.operation_id = ?
                  AND NOT EXISTS (
                    SELECT 1 FROM document_studio_draft_metadata metadata
                     WHERE metadata.document_id = document.id
                  )`,
            )
            .run(
              parsed.documentType,
              snapshot.outputMessageId,
              snapshot.createdAt,
              writeIdentity.documentId,
              projectId,
              writeIdentity.versionId,
              writeIdentity.operationId,
            ) as { changes?: number };
          if (Number(inserted.changes ?? 0) !== 1) {
            throw new AssistantDraftToolError(
              "Legacy Draft metadata could not be rebound safely.",
            );
          }
          existing = existingStatement.get(writeIdentity.documentId);
        }
        if (
          existing?.document_type !== parsed.documentType ||
          existing?.origin_type !== "assistant" ||
          existing?.origin_ref !== snapshot.outputMessageId
        ) {
          throw new AssistantDraftToolError(
            "The replay-safe Draft metadata belongs to another action.",
          );
        }
      }
      throwIfAborted(input.signal);
      const created = existingDraft
        ? existingDraft
        : await this.studio.createDraft({
            projectId,
            title: parsed.title,
            content: parsed.contentMarkdown,
            source: "assistant_edit",
            citationAnchorIds,
            documentType: parsed.documentType,
            originType: "assistant",
            originRef: snapshot.outputMessageId,
            writeIdentity,
          });
      if (
        created.document.id !== writeIdentity.documentId ||
        created.version.id !== writeIdentity.versionId ||
        created.document.title !== parsed.title ||
        created.content !== parsed.contentMarkdown ||
        !isDeepStrictEqual(created.version.citationAnchorIds, citationAnchorIds)
      ) {
        throw new AssistantDraftToolError(
          "An existing replay-safe Draft identity does not match this action.",
        );
      }
      this.actions.complete({
        jobId: input.context.jobId,
        attempt: input.context.attempt,
        leaseOwner: input.context.leaseOwner,
        projectId,
        actionKey,
        actionType: "create_draft",
        input: actionInput,
        resourceType: "draft",
        resourceId: created.document.id,
      });
      return {
        content: safeJson({
          draftId: created.document.id,
          versionId: created.version.id,
          title: created.document.title,
          route: `/projects/${projectId}/documents/${created.document.id}/studio`,
        }),
        events: [
          {
            type: "draft_created" as const,
            draft_id: created.document.id,
            version_id: created.version.id,
            title: created.document.title,
            route: `/projects/${projectId}/documents/${created.document.id}/studio`,
          },
        ],
        sourceContext: [],
      };
    }

    if (input.call.name === "read_draft") {
      const parsed = ReadDraftInput.parse(input.call.input);
      const expectedVersionId = this.currentDraftVersion(
        projectId,
        parsed.draftId,
      );
      const draft = await this.studio.getDocument(projectId, parsed.draftId);
      if (
        draft.document.currentVersionId !== expectedVersionId ||
        draft.version.id !== expectedVersionId ||
        this.currentDraftVersion(projectId, parsed.draftId) !==
          expectedVersionId
      ) {
        throw new AssistantDraftToolError(
          "Draft changed while its current revision was being read.",
        );
      }
      if (parsed.startOffset > draft.content.length) {
        throw new AssistantDraftToolError(
          "Draft read offset is outside the raw Markdown.",
        );
      }
      const endOffset = Math.min(
        draft.content.length,
        parsed.startOffset + parsed.maxChars,
      );
      this.snapshot(input.context);
      throwIfAborted(input.signal);
      const content = safeJson({
        draftId: parsed.draftId,
        versionId: expectedVersionId,
        revision: expectedVersionId,
        title: draft.document.title,
        offsetScope: "raw_markdown_v1",
        offsetUnit: "utf16_code_unit",
        contentLength: draft.content.length,
        range: {
          startOffset: parsed.startOffset,
          endOffset,
          text: draft.content.slice(parsed.startOffset, endOffset),
          complete: endOffset === draft.content.length,
        },
      });
      this.rememberRead(input.context, parsed.draftId, expectedVersionId, {
        startOffset: parsed.startOffset,
        endOffset,
      });
      return {
        content,
        sourceContext: [],
      };
    }

    if (input.call.name === "suggest_draft_edit") {
      const parsed = SuggestDraftEditInput.parse(input.call.input);
      if (
        this.currentDraftVersion(projectId, parsed.draftId) !== parsed.revision
      ) {
        throw new AssistantDraftToolError(
          "Draft revision is stale; read the current Draft before suggesting an edit.",
        );
      }
      if (
        !this.wasRead(
          input.context,
          parsed.draftId,
          parsed.revision,
          parsed.startOffset,
          parsed.endOffset,
        )
      ) {
        throw new AssistantDraftToolError(
          "Draft suggestion range was not read from this exact revision in the current Assistant attempt.",
        );
      }
      const draft = await this.studio.getDocument(
        projectId,
        parsed.draftId,
        parsed.revision,
      );
      if (
        draft.document.currentVersionId !== parsed.revision ||
        draft.version.id !== parsed.revision ||
        parsed.endOffset > draft.content.length ||
        draft.content.slice(parsed.startOffset, parsed.endOffset) !==
          parsed.exactDeletedText
      ) {
        throw new AssistantDraftToolError(
          "Draft suggestion no longer exactly matches the current raw Markdown.",
        );
      }
      const actionInput = {
        draftId: parsed.draftId,
        revision: parsed.revision,
        startOffset: parsed.startOffset,
        endOffset: parsed.endOffset,
        exactDeletedText: parsed.exactDeletedText,
        insertedText: parsed.insertedText,
        summary: parsed.summary,
      };
      const actionKey = `assistant-suggestion:${hashAssistantActionInput(actionInput)}`;
      const reservation = this.actions.reserve({
        jobId: input.context.jobId,
        attempt: input.context.attempt,
        leaseOwner: input.context.leaseOwner,
        projectId,
        actionKey,
        actionType: "suggest_draft_edit",
        input: actionInput,
      });
      if (
        reservation.record.status === "complete" &&
        (reservation.record.resourceType !== "draft_suggestion" ||
          reservation.record.resourceId === null)
      ) {
        throw new AssistantDraftToolError(
          "Completed Draft suggestion action has an invalid durable resource.",
        );
      }
      throwIfAborted(input.signal);
      const suggestion =
        reservation.record.status === "complete"
          ? await this.studio.getSuggestion(
              projectId,
              parsed.draftId,
              reservation.record.resourceId as string,
            )
          : await this.studio.createSuggestionFromAssistantTool({
              projectId,
              documentId: parsed.draftId,
              baseVersionId: parsed.revision,
              messageId: snapshot.outputMessageId,
              jobId: snapshot.jobId,
              attempt: input.context.attempt,
              toolCallId: input.call.id,
              startOffset: parsed.startOffset,
              endOffset: parsed.endOffset,
              exactDeletedText: parsed.exactDeletedText,
              insertedText: parsed.insertedText,
              summary: parsed.summary,
            } satisfies CreateDocumentStudioSuggestionFromToolInput);
      if (
        suggestion.projectId !== projectId ||
        suggestion.documentId !== parsed.draftId ||
        suggestion.baseVersionId !== parsed.revision ||
        suggestion.messageId !== snapshot.outputMessageId ||
        suggestion.changeId !==
          assistantSuggestionChangeId(snapshot.jobId, parsed) ||
        suggestion.startOffset !== parsed.startOffset ||
        suggestion.endOffset !== parsed.endOffset ||
        suggestion.deletedText !== parsed.exactDeletedText ||
        suggestion.insertedText !== parsed.insertedText ||
        suggestion.summary !== parsed.summary
      ) {
        throw new AssistantDraftToolError(
          "Durable Draft suggestion does not match the reserved Assistant action.",
        );
      }
      this.actions.complete({
        jobId: input.context.jobId,
        attempt: input.context.attempt,
        leaseOwner: input.context.leaseOwner,
        projectId,
        actionKey,
        actionType: "suggest_draft_edit",
        input: actionInput,
        resourceType: "draft_suggestion",
        resourceId: suggestion.id,
      });
      return {
        content: safeJson({
          suggestionId: suggestion.id,
          draftId: suggestion.documentId,
          revision: suggestion.baseVersionId,
          status: suggestion.status,
          requiresExplicitUserAcceptance: suggestion.status === "pending",
          documentContentChanged: suggestion.status === "accepted",
          route: `/projects/${projectId}/documents/${suggestion.documentId}/studio`,
        }),
        sourceContext: [],
      };
    }

    throw new AssistantDraftToolError(
      "Assistant requested a tool outside the Draft module.",
    );
  }
}

export { DRAFT_TOOLS };
