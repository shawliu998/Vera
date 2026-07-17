import { z } from "zod";

import type { WorkspaceDatabaseAdapter } from "../migrations";
import {
  CommitMarkdownVersionCasV12Schema,
  CreateMarkdownDraftV12Schema,
  RestoreMarkdownVersionCasV12Schema,
  StudioCitationBindingV12Schema,
  StudioDocumentV12Schema,
  StudioDocumentVersionV12Schema,
  type CommitMarkdownVersionCasV12,
  type CreateMarkdownDraftV12,
  type RestoreMarkdownVersionCasV12,
  type StudioCitationBindingV12,
  type StudioDocumentV12,
  type StudioDocumentVersionV12,
  type StudioProjectDocumentV12,
  type StudioVersionCommitV12,
} from "../documentStudioContractsV12";
import {
  AcceptDocumentStudioSuggestionV14Schema,
  CreateDocumentStudioSuggestionV14Schema,
  DOCUMENT_STUDIO_SUGGESTION_PREVIEW_CHARS_V14,
  DocumentStudioSuggestionV14Schema,
  DocumentStudioSuggestionPreviewV14Schema,
  RejectDocumentStudioSuggestionV14Schema,
  type AcceptDocumentStudioSuggestionV14,
  type CreateDocumentStudioSuggestionV14,
  type DocumentStudioSuggestionV14,
  type DocumentStudioSuggestionPreviewPageV14,
  type DocumentStudioSuggestionPreviewV14,
  type RejectDocumentStudioSuggestionV14,
} from "../documentStudioSuggestionContractsV14";
import { TabularRepository } from "./tabular";
import {
  prepareTabularReviewStudioSourceV23,
  readTabularReviewStudioJobLineageV23,
  TabularReviewStudioHandoffPersistenceV23Schema,
  type TabularReviewStudioHandoffPersistenceV23,
} from "../tabularReviewStudioHandoffV23";
import {
  workspaceBlobStorageKey,
  WorkspaceBlobRecordsRepository,
  type WorkspaceBlobRecordsRepository as WorkspaceBlobRecordsRepositoryType,
} from "./blobRecords";

type Row = Record<string, unknown>;

export type WorkspaceDocumentStudioRepositoryErrorCode =
  | "DOCUMENT_STUDIO_INVALID_INPUT"
  | "DOCUMENT_STUDIO_NOT_FOUND"
  | "DOCUMENT_STUDIO_VERSION_CONFLICT"
  | "DOCUMENT_STUDIO_OPERATION_CONFLICT"
  | "DOCUMENT_STUDIO_SCOPE_VIOLATION"
  | "DOCUMENT_STUDIO_RETENTION_BLOCKED"
  | "DOCUMENT_STUDIO_PERSISTENCE_FAILED";

export class WorkspaceDocumentStudioRepositoryError extends Error {
  constructor(
    readonly code: WorkspaceDocumentStudioRepositoryErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WorkspaceDocumentStudioRepositoryError";
  }
}

function studioError(
  code: WorkspaceDocumentStudioRepositoryErrorCode,
  message: string,
  cause?: unknown,
): never {
  throw new WorkspaceDocumentStudioRepositoryError(
    code,
    message,
    cause instanceof Error ? { cause } : undefined,
  );
}

function parseInput<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  try {
    return schema.parse(value);
  } catch (error) {
    studioError("DOCUMENT_STUDIO_INVALID_INPUT", `${label} is invalid.`, error);
  }
}

function parseId(value: string, label: string) {
  const parsed = z.string().uuid().safeParse(value);
  if (!parsed.success) {
    studioError("DOCUMENT_STUDIO_INVALID_INPUT", `${label} is invalid.`);
  }
  return parsed.data;
}

const VERSION_SELECT = `
  version.id AS version_id,
  studio.project_id AS project_id,
  version.document_id AS document_id,
  version.version_number AS version_number,
  version.source AS version_source,
  version.filename AS version_filename,
  version.mime_type AS version_mime_type,
  version.size_bytes AS version_size_bytes,
  version.content_sha256 AS version_content_sha256,
  version.storage_key AS version_storage_key,
  version.page_count AS version_page_count,
  studio.format AS studio_format,
  studio.summary AS studio_summary,
  studio.operation_id AS studio_operation_id,
  studio.created_at AS studio_created_at
`;

const SUGGESTION_SELECT = `
  edit.id AS suggestion_id,
  document.project_id AS project_id,
  edit.document_id AS document_id,
  edit.version_id AS base_version_id,
  edit.message_id AS message_id,
  edit.change_id AS change_id,
  edit.start_offset AS start_offset,
  edit.end_offset AS end_offset,
  edit.offset_scope AS offset_scope,
  edit.offset_unit AS offset_unit,
  edit.deleted_text AS deleted_text,
  edit.inserted_text AS inserted_text,
  edit.context_before AS context_before,
  edit.context_after AS context_after,
  edit.summary AS summary,
  edit.status AS status,
  edit.created_at AS created_at,
  edit.resolved_at AS resolved_at,
  result.version_id AS result_version_id
`;

export class WorkspaceDocumentStudioRepository {
  listSuggestionPreviews(
    projectIdInput: string,
    documentIdInput: string,
  ): DocumentStudioSuggestionPreviewPageV14 {
    const projectId = parseId(projectIdInput, "projectId");
    const documentId = parseId(documentIdInput, "documentId");
    try {
      const rows = this.database
        .prepare(
          `SELECT edit.id AS suggestion_id,
                  document.project_id AS project_id,
                  edit.document_id AS document_id,
                  edit.version_id AS base_version_id,
                  edit.message_id AS message_id,
                  edit.start_offset AS start_offset,
                  edit.end_offset AS end_offset,
                  edit.offset_scope AS offset_scope,
                  edit.offset_unit AS offset_unit,
                  substr(edit.deleted_text, 1, ?) AS deleted_preview,
                  substr(edit.inserted_text, 1, ?) AS inserted_preview,
                  length(edit.deleted_text) > ? AS deleted_truncated,
                  length(edit.inserted_text) > ? AS inserted_truncated,
                  edit.context_before AS context_before,
                  edit.context_after AS context_after,
                  edit.summary AS summary,
                  edit.status AS status,
                  edit.created_at AS created_at
             FROM document_edits edit
             JOIN documents document ON document.id = edit.document_id
             JOIN document_studio_versions base
               ON base.project_id = document.project_id
              AND base.document_id = edit.document_id
              AND base.version_id = edit.version_id
            WHERE document.project_id = ?
              AND document.id = ?
              AND document.document_kind IN ('draft', 'template')
              AND document.deleted_at IS NULL
              AND edit.status = 'pending'
              AND edit.resolved_at IS NULL
              AND edit.start_offset IS NOT NULL
              AND edit.end_offset IS NOT NULL
              AND edit.offset_scope = 'raw_markdown_v1'
              AND edit.offset_unit = 'utf16_code_unit'
            ORDER BY edit.created_at DESC, edit.id DESC
            LIMIT 51`,
        )
        .all(
          DOCUMENT_STUDIO_SUGGESTION_PREVIEW_CHARS_V14,
          DOCUMENT_STUDIO_SUGGESTION_PREVIEW_CHARS_V14,
          DOCUMENT_STUDIO_SUGGESTION_PREVIEW_CHARS_V14,
          DOCUMENT_STUDIO_SUGGESTION_PREVIEW_CHARS_V14,
          projectId,
          documentId,
        );
      return {
        suggestions: rows
          .slice(0, 50)
          .map((row) => this.mapSuggestionPreview(row)),
        hasMore: rows.length > 50,
      };
    } catch (error) {
      if (error instanceof WorkspaceDocumentStudioRepositoryError) throw error;
      studioError(
        "DOCUMENT_STUDIO_PERSISTENCE_FAILED",
        "Studio suggestion previews could not be listed.",
        error,
      );
    }
  }

  private readonly blobRecords: WorkspaceBlobRecordsRepositoryType;
  private readonly now: () => string;

  constructor(
    private readonly database: WorkspaceDatabaseAdapter,
    options: {
      blobRecords?: WorkspaceBlobRecordsRepositoryType;
      now?: () => string;
    } = {},
  ) {
    this.blobRecords =
      options.blobRecords ?? new WorkspaceBlobRecordsRepository(database);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  getProjectDocument(
    projectId: string,
    documentId: string,
  ): StudioProjectDocumentV12 | null {
    parseId(projectId, "projectId");
    parseId(documentId, "documentId");
    try {
      const row = this.database
        .prepare(
          `SELECT
             document.id AS document_id,
             document.project_id AS document_project_id,
             document.folder_id AS document_folder_id,
             document.document_kind AS document_kind,
             document.title AS document_title,
             document.filename AS document_filename,
             document.mime_type AS document_mime_type,
             document.size_bytes AS document_size_bytes,
             document.parse_status AS document_parse_status,
             document.current_version_id AS document_current_version_id,
             document.created_at AS document_created_at,
             document.updated_at AS document_updated_at,
             ${VERSION_SELECT}
           FROM documents document
           JOIN document_versions version
             ON version.document_id = document.id
            AND version.id = document.current_version_id
            AND version.deleted_at IS NULL
           JOIN document_studio_versions studio
             ON studio.document_id = document.id
            AND studio.version_id = version.id
            AND studio.project_id = document.project_id
          WHERE document.project_id = ?
            AND document.id = ?
            AND document.document_kind IN ('draft', 'template')
            AND document.deleted_at IS NULL`,
        )
        .get(projectId, documentId);
      if (!row) return null;
      return {
        document: this.mapDocument(row),
        currentVersion: this.mapVersion(row),
      };
    } catch (error) {
      if (error instanceof WorkspaceDocumentStudioRepositoryError) throw error;
      studioError(
        "DOCUMENT_STUDIO_PERSISTENCE_FAILED",
        "Studio document could not be read.",
        error,
      );
    }
  }

  getVersion(
    projectId: string,
    documentId: string,
    versionId: string,
  ): StudioDocumentVersionV12 | null {
    parseId(projectId, "projectId");
    parseId(documentId, "documentId");
    parseId(versionId, "versionId");
    try {
      const row = this.selectVersion(projectId, documentId, versionId);
      return row ? this.mapVersion(row) : null;
    } catch (error) {
      if (error instanceof WorkspaceDocumentStudioRepositoryError) throw error;
      studioError(
        "DOCUMENT_STUDIO_PERSISTENCE_FAILED",
        "Studio document version could not be read.",
        error,
      );
    }
  }

  listVersions(
    projectId: string,
    documentId: string,
  ): StudioDocumentVersionV12[] {
    parseId(projectId, "projectId");
    parseId(documentId, "documentId");
    try {
      return this.database
        .prepare(
          `SELECT ${VERSION_SELECT}
             FROM document_studio_versions studio
             JOIN documents document
               ON document.id = studio.document_id
              AND document.project_id = studio.project_id
             JOIN document_versions version
               ON version.document_id = studio.document_id
              AND version.id = studio.version_id
            WHERE studio.project_id = ?
              AND studio.document_id = ?
              AND document.deleted_at IS NULL
              AND version.deleted_at IS NULL
            ORDER BY version.version_number ASC, version.id ASC`,
        )
        .all(projectId, documentId)
        .map((row) => this.mapVersion(row));
    } catch (error) {
      if (error instanceof WorkspaceDocumentStudioRepositoryError) throw error;
      studioError(
        "DOCUMENT_STUDIO_PERSISTENCE_FAILED",
        "Studio document versions could not be listed.",
        error,
      );
    }
  }

  listVersionCitationAnchors(
    projectId: string,
    documentId: string,
    versionId: string,
  ): StudioCitationBindingV12[] {
    parseId(projectId, "projectId");
    parseId(documentId, "documentId");
    parseId(versionId, "versionId");
    try {
      return this.database
        .prepare(
          `SELECT project_id, document_id, version_id, anchor_id, ordinal,
                  created_at
             FROM document_version_citation_anchors
            WHERE project_id = ? AND document_id = ? AND version_id = ?
            ORDER BY ordinal ASC, anchor_id ASC`,
        )
        .all(projectId, documentId, versionId)
        .map((row) =>
          StudioCitationBindingV12Schema.parse({
            projectId: row.project_id,
            documentId: row.document_id,
            versionId: row.version_id,
            anchorId: row.anchor_id,
            ordinal: Number(row.ordinal),
            createdAt: row.created_at,
          }),
        );
    } catch (error) {
      if (error instanceof WorkspaceDocumentStudioRepositoryError) throw error;
      studioError(
        "DOCUMENT_STUDIO_PERSISTENCE_FAILED",
        "Studio version citations could not be listed.",
        error,
      );
    }
  }

  listSuggestions(
    projectId: string,
    documentId: string,
  ): DocumentStudioSuggestionV14[] {
    parseId(projectId, "projectId");
    parseId(documentId, "documentId");
    try {
      return this.database
        .prepare(
          `SELECT ${SUGGESTION_SELECT}
             FROM document_edits edit
             JOIN documents document
               ON document.id = edit.document_id
             JOIN document_studio_versions base
               ON base.project_id = document.project_id
              AND base.document_id = edit.document_id
              AND base.version_id = edit.version_id
             LEFT JOIN document_studio_versions result
               ON result.document_id = edit.document_id
              AND result.operation_id = 'studio-suggestion:' || edit.id
            WHERE document.project_id = ?
              AND document.id = ?
              AND document.document_kind IN ('draft', 'template')
              AND document.deleted_at IS NULL
              AND edit.start_offset IS NOT NULL
              AND edit.end_offset IS NOT NULL
              AND edit.offset_scope = 'raw_markdown_v1'
              AND edit.offset_unit = 'utf16_code_unit'
            ORDER BY CASE edit.status WHEN 'pending' THEN 0 ELSE 1 END,
                     edit.created_at DESC, edit.id DESC
            LIMIT 200`,
        )
        .all(projectId, documentId)
        .map((row) => this.mapSuggestion(row));
    } catch (error) {
      if (error instanceof WorkspaceDocumentStudioRepositoryError) throw error;
      studioError(
        "DOCUMENT_STUDIO_PERSISTENCE_FAILED",
        "Studio suggestions could not be listed.",
        error,
      );
    }
  }

  getSuggestion(
    projectId: string,
    documentId: string,
    suggestionId: string,
  ): DocumentStudioSuggestionV14 | null {
    parseId(projectId, "projectId");
    parseId(documentId, "documentId");
    parseId(suggestionId, "suggestionId");
    try {
      const row = this.selectSuggestion(projectId, documentId, suggestionId);
      return row ? this.mapSuggestion(row) : null;
    } catch (error) {
      if (error instanceof WorkspaceDocumentStudioRepositoryError) throw error;
      studioError(
        "DOCUMENT_STUDIO_PERSISTENCE_FAILED",
        "Studio suggestion could not be read.",
        error,
      );
    }
  }

  createSuggestion(
    input: CreateDocumentStudioSuggestionV14,
  ): DocumentStudioSuggestionV14 {
    const parsed = parseInput(
      CreateDocumentStudioSuggestionV14Schema,
      input,
      "Studio suggestion input",
    );
    return this.persist(() => {
      const binding = this.database
        .prepare(
          `SELECT document.current_version_id
             FROM documents document
             JOIN projects project
               ON project.id = document.project_id AND project.status = 'active'
             JOIN document_studio_versions studio
               ON studio.project_id = document.project_id
              AND studio.document_id = document.id
              AND studio.version_id = ?
            WHERE document.project_id = ?
              AND document.id = ?
              AND document.document_kind IN ('draft', 'template')
              AND document.deleted_at IS NULL`,
        )
        .get(parsed.baseVersionId, parsed.projectId, parsed.documentId);
      if (!binding) {
        studioError(
          "DOCUMENT_STUDIO_NOT_FOUND",
          "Studio suggestion base was not found.",
        );
      }
      if (binding.current_version_id !== parsed.baseVersionId) {
        studioError(
          "DOCUMENT_STUDIO_VERSION_CONFLICT",
          "Studio suggestion base is stale.",
        );
      }
      const message = this.database
        .prepare(
          `SELECT message.id
             FROM chat_messages message
             JOIN chats chat ON chat.id = message.chat_id
            WHERE message.id = ?
              AND message.role = 'assistant'
              AND message.status IN ('pending', 'streaming', 'complete')
              AND chat.project_id = ?
              AND chat.scope = 'project'`,
        )
        .get(parsed.messageId, parsed.projectId);
      if (!message) {
        studioError(
          "DOCUMENT_STUDIO_NOT_FOUND",
          "Assistant suggestion source was not found.",
        );
      }
      const existing = this.database
        .prepare(
          `SELECT ${SUGGESTION_SELECT}
             FROM document_edits edit
             JOIN documents document ON document.id = edit.document_id
             LEFT JOIN document_studio_versions result
               ON result.document_id = edit.document_id
              AND result.operation_id = 'studio-suggestion:' || edit.id
            WHERE edit.version_id = ? AND edit.change_id = ?`,
        )
        .get(parsed.baseVersionId, parsed.changeId);
      if (existing) {
        const suggestion = this.mapSuggestion(existing);
        if (
          suggestion.status === "pending" &&
          suggestion.projectId === parsed.projectId &&
          suggestion.documentId === parsed.documentId &&
          suggestion.messageId === parsed.messageId &&
          suggestion.startOffset === parsed.startOffset &&
          suggestion.endOffset === parsed.endOffset &&
          suggestion.deletedText === parsed.deletedText &&
          suggestion.insertedText === parsed.insertedText &&
          suggestion.contextBefore === parsed.contextBefore &&
          suggestion.contextAfter === parsed.contextAfter &&
          suggestion.summary === parsed.summary
        ) {
          return suggestion;
        }
        studioError(
          "DOCUMENT_STUDIO_OPERATION_CONFLICT",
          "Assistant suggestion change id has already been used.",
        );
      }
      const pendingCount = Number(
        this.database
          .prepare(
            `SELECT count(*) AS total
               FROM document_edits
              WHERE document_id = ? AND status = 'pending'`,
          )
          .get(parsed.documentId)?.total,
      );
      if (!Number.isSafeInteger(pendingCount) || pendingCount < 0) {
        studioError(
          "DOCUMENT_STUDIO_PERSISTENCE_FAILED",
          "Studio suggestion pending count is invalid.",
        );
      }
      if (pendingCount >= 50) {
        studioError(
          "DOCUMENT_STUDIO_OPERATION_CONFLICT",
          "Studio document already has the maximum pending suggestions.",
        );
      }
      this.database
        .prepare(
          `INSERT INTO document_edits (
             id, document_id, version_id, message_id, change_id,
             deleted_text, inserted_text, context_before, context_after,
             summary, status, created_at, resolved_at, start_offset,
             end_offset, offset_scope, offset_unit
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL,
                     ?, ?, 'raw_markdown_v1', 'utf16_code_unit')`,
        )
        .run(
          parsed.suggestionId,
          parsed.documentId,
          parsed.baseVersionId,
          parsed.messageId,
          parsed.changeId,
          parsed.deletedText,
          parsed.insertedText,
          parsed.contextBefore,
          parsed.contextAfter,
          parsed.summary,
          parsed.createdAt,
          parsed.startOffset,
          parsed.endOffset,
        );
      return this.requireSuggestionInTransaction(
        parsed.projectId,
        parsed.documentId,
        parsed.suggestionId,
      );
    });
  }

  rejectSuggestion(
    input: RejectDocumentStudioSuggestionV14,
  ): DocumentStudioSuggestionV14 {
    const parsed = parseInput(
      RejectDocumentStudioSuggestionV14Schema,
      input,
      "Studio suggestion rejection",
    );
    return this.persist(() => {
      const suggestion = this.requireSuggestionInTransaction(
        parsed.projectId,
        parsed.documentId,
        parsed.suggestionId,
      );
      if (suggestion.status !== "pending") {
        studioError(
          "DOCUMENT_STUDIO_OPERATION_CONFLICT",
          "Studio suggestion has already been resolved.",
        );
      }
      const document = this.database
        .prepare(
          `SELECT document.current_version_id
             FROM documents document
             JOIN projects project
               ON project.id = document.project_id AND project.status = 'active'
            WHERE document.project_id = ? AND document.id = ?
              AND document.document_kind IN ('draft', 'template')
              AND document.deleted_at IS NULL`,
        )
        .get(parsed.projectId, parsed.documentId);
      if (!document) {
        studioError(
          "DOCUMENT_STUDIO_NOT_FOUND",
          "Studio document was not found.",
        );
      }
      const update = this.database
        .prepare(
          `UPDATE document_edits
              SET status = 'rejected', resolved_at = ?
            WHERE id = ? AND document_id = ? AND version_id = ?
              AND status = 'pending' AND resolved_at IS NULL`,
        )
        .run(
          parsed.resolvedAt,
          parsed.suggestionId,
          parsed.documentId,
          suggestion.baseVersionId,
        ) as { changes?: number };
      if (Number(update.changes ?? 0) !== 1) {
        studioError(
          "DOCUMENT_STUDIO_OPERATION_CONFLICT",
          "Studio suggestion could not be rejected exactly once.",
        );
      }
      return this.requireSuggestionInTransaction(
        parsed.projectId,
        parsed.documentId,
        parsed.suggestionId,
      );
    });
  }

  acceptSuggestionCas(input: AcceptDocumentStudioSuggestionV14): {
    suggestion: DocumentStudioSuggestionV14;
    commit: StudioVersionCommitV12;
  } {
    const parsed = parseInput(
      AcceptDocumentStudioSuggestionV14Schema,
      input,
      "Studio suggestion acceptance",
    );
    return this.persist(() => {
      const suggestion = this.requireSuggestionInTransaction(
        parsed.commit.projectId,
        parsed.commit.documentId,
        parsed.suggestionId,
      );
      if (suggestion.status !== "pending") {
        studioError(
          "DOCUMENT_STUDIO_OPERATION_CONFLICT",
          "Studio suggestion has already been resolved.",
        );
      }
      const durableSource = this.database
        .prepare(
          `SELECT message.id
             FROM chat_messages message
             JOIN chats chat ON chat.id = message.chat_id
             JOIN jobs job ON job.id = message.job_id
            WHERE message.id = ?
              AND message.role = 'assistant'
              AND message.status = 'complete'
              AND chat.project_id = ?
              AND chat.scope = 'project'
              AND job.type = 'assistant_generate'
              AND job.status = 'complete'
              AND job.resource_type = 'chat'
              AND job.resource_id = chat.id
              AND json_extract(job.payload_json, '$.schema') =
                    'vera-assistant-generation-v1'
              AND json_extract(job.payload_json, '$.chatId') = chat.id
              AND json_extract(job.payload_json, '$.projectId') = ?
              AND json_extract(job.payload_json, '$.outputMessageId') =
                    message.id`,
        )
        .get(
          suggestion.messageId,
          parsed.commit.projectId,
          parsed.commit.projectId,
        );
      if (!durableSource) {
        studioError(
          "DOCUMENT_STUDIO_OPERATION_CONFLICT",
          "Assistant suggestion has no completed durable source message.",
        );
      }
      if (
        suggestion.baseVersionId !== parsed.commit.expectedCurrentVersionId ||
        suggestion.startOffset !== parsed.exactStartOffset ||
        suggestion.endOffset !== parsed.exactEndOffset ||
        suggestion.deletedText !== parsed.exactDeletedText ||
        parsed.commit.operationId !== `studio-suggestion:${suggestion.id}`
      ) {
        studioError(
          "DOCUMENT_STUDIO_OPERATION_CONFLICT",
          "Prepared acceptance does not match the immutable suggestion.",
        );
      }
      const inheritedCitationIds = this.listCitationAnchorIdsRaw(
        parsed.commit.projectId,
        parsed.commit.documentId,
        suggestion.baseVersionId,
      );
      if (
        inheritedCitationIds.length !==
          parsed.commit.citationAnchorIds.length ||
        inheritedCitationIds.some(
          (anchorId, index) =>
            anchorId !== parsed.commit.citationAnchorIds[index],
        )
      ) {
        studioError(
          "DOCUMENT_STUDIO_OPERATION_CONFLICT",
          "Prepared acceptance citations do not match the base version.",
        );
      }
      const commit = this.commitMarkdownVersionInTransaction(parsed.commit);
      const update = this.database
        .prepare(
          `UPDATE document_edits
              SET status = 'accepted', resolved_at = ?
            WHERE id = ? AND document_id = ? AND version_id = ?
              AND status = 'pending' AND resolved_at IS NULL`,
        )
        .run(
          parsed.commit.createdAt,
          suggestion.id,
          suggestion.documentId,
          suggestion.baseVersionId,
        ) as { changes?: number };
      if (Number(update.changes ?? 0) !== 1) {
        studioError(
          "DOCUMENT_STUDIO_OPERATION_CONFLICT",
          "Studio suggestion could not be accepted exactly once.",
        );
      }
      return {
        suggestion: this.requireSuggestionInTransaction(
          parsed.commit.projectId,
          parsed.commit.documentId,
          suggestion.id,
        ),
        commit,
      };
    });
  }

  createMarkdownDraft(
    input: CreateMarkdownDraftV12,
    handoffInput?: TabularReviewStudioHandoffPersistenceV23,
  ): StudioVersionCommitV12 {
    const parsed = parseInput(
      CreateMarkdownDraftV12Schema,
      input,
      "Studio draft input",
    );
    const handoff = handoffInput
      ? parseInput(
          TabularReviewStudioHandoffPersistenceV23Schema,
          handoffInput,
          "Tabular Studio handoff",
        )
      : null;
    return this.persist(() => {
      const project = this.database
        .prepare("SELECT id FROM projects WHERE id = ? AND status = 'active'")
        .get(parsed.projectId);
      if (!project) {
        studioError("DOCUMENT_STUDIO_NOT_FOUND", "Project was not found.");
      }
      if (handoff) {
        if (
          handoff.projectId !== parsed.projectId ||
          handoff.documentId !== parsed.documentId ||
          handoff.versionId !== parsed.versionId ||
          handoff.createdAt !== parsed.createdAt ||
          parsed.documentKind !== "draft" ||
          parsed.draftDocumentType !== "contract_review_memo" ||
          parsed.draftOriginType !== "unknown" ||
          parsed.draftOriginRef !== null ||
          parsed.citationAnchorIds.length === 0
        ) {
          studioError(
            "DOCUMENT_STUDIO_OPERATION_CONFLICT",
            "Prepared Tabular handoff does not match the Studio Draft.",
          );
        }
        const current = new TabularRepository(this.database).requireDetail(
          handoff.reviewId,
        );
        let prepared: ReturnType<typeof prepareTabularReviewStudioSourceV23>;
        try {
          const jobLineage = readTabularReviewStudioJobLineageV23({
            database: this.database,
            projectId: handoff.projectId,
            detail: current,
          });
          prepared = prepareTabularReviewStudioSourceV23({
            projectId: handoff.projectId,
            detail: current,
            jobLineage,
          });
        } catch (error) {
          studioError(
            "DOCUMENT_STUDIO_OPERATION_CONFLICT",
            "Tabular review changed before its Studio Draft was committed.",
            error,
          );
        }
        if (
          current.review.updatedAt !== handoff.expectedReviewUpdatedAt ||
          prepared.reviewStateSha256 !== handoff.reviewStateSha256 ||
          prepared.sourceManifestJson !== handoff.sourceManifestJson ||
          prepared.sourceManifestSha256 !== handoff.sourceManifestSha256 ||
          prepared.identitySha256 !== handoff.identitySha256
        ) {
          studioError(
            "DOCUMENT_STUDIO_OPERATION_CONFLICT",
            "Tabular review changed before its Studio Draft was committed.",
          );
        }
      }
      if (parsed.folderId !== null) {
        const folder = this.database
          .prepare("SELECT project_id FROM project_subfolders WHERE id = ?")
          .get(parsed.folderId);
        if (!folder || folder.project_id !== parsed.projectId) {
          studioError("DOCUMENT_STUDIO_NOT_FOUND", "Folder was not found.");
        }
      }
      this.assertCitationScope(parsed.projectId, parsed.citationAnchorIds);
      const storageKey = workspaceBlobStorageKey({
        kind: "original",
        documentId: parsed.documentId,
        versionId: parsed.versionId,
      });
      this.database
        .prepare(
          `INSERT INTO documents (
             id, project_id, folder_id, title, filename, mime_type, size_bytes,
             parse_status, current_version_id, deleted_at, created_at,
             updated_at, document_kind
           ) VALUES (?, ?, ?, ?, ?, 'text/markdown', ?, 'pending', NULL, NULL,
                     ?, ?, ?)`,
        )
        .run(
          parsed.documentId,
          parsed.projectId,
          parsed.folderId,
          parsed.title,
          parsed.filename,
          parsed.sizeBytes,
          parsed.createdAt,
          parsed.createdAt,
          parsed.documentKind,
        );
      this.database
        .prepare(
          `INSERT INTO document_versions (
             id, document_id, version_number, source, filename, mime_type,
             size_bytes, content_sha256, storage_key, created_at
           ) VALUES (?, ?, 1, ?, ?, 'text/markdown', ?, ?, ?, ?)`,
        )
        .run(
          parsed.versionId,
          parsed.documentId,
          parsed.source,
          parsed.filename,
          parsed.sizeBytes,
          parsed.contentSha256,
          storageKey,
          parsed.createdAt,
        );
      this.insertStudioMetadata({
        projectId: parsed.projectId,
        documentId: parsed.documentId,
        versionId: parsed.versionId,
        summary: parsed.summary,
        operationId: parsed.operationId,
        createdAt: parsed.createdAt,
      });
      this.insertCitationBindings(
        parsed.projectId,
        parsed.documentId,
        parsed.versionId,
        parsed.citationAnchorIds,
        parsed.createdAt,
      );
      this.database
        .prepare(
          `UPDATE documents
              SET current_version_id = ?, updated_at = ?
            WHERE id = ? AND project_id = ? AND current_version_id IS NULL`,
        )
        .run(
          parsed.versionId,
          parsed.createdAt,
          parsed.documentId,
          parsed.projectId,
        );
      this.database
        .prepare(
          `INSERT INTO document_studio_draft_metadata (
             document_id, project_id, document_type, origin_type, origin_ref,
             created_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          parsed.documentId,
          parsed.projectId,
          parsed.draftDocumentType,
          parsed.draftOriginType,
          parsed.draftOriginRef,
          parsed.createdAt,
        );
      if (handoff) {
        this.database
          .prepare(
            `INSERT INTO tabular_review_studio_handoffs (
               id, identity_sha256, project_id, review_id,
               review_state_sha256, source_manifest_json,
               source_manifest_sha256, template_reducer_revision_sha256,
               document_id, version_id, document_type, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            handoff.id,
            handoff.identitySha256,
            handoff.projectId,
            handoff.reviewId,
            handoff.reviewStateSha256,
            handoff.sourceManifestJson,
            handoff.sourceManifestSha256,
            handoff.templateReducerRevisionSha256,
            handoff.documentId,
            handoff.versionId,
            handoff.documentType,
            handoff.createdAt,
          );
      }
      this.insertParseJob(
        parsed.jobId,
        parsed.documentId,
        parsed.versionId,
        parsed.createdAt,
      );
      this.blobRecords.registerStoredInTransaction({
        id: parsed.blobRecordId,
        locator: {
          kind: "original",
          documentId: parsed.documentId,
          versionId: parsed.versionId,
        },
        contentSha256: parsed.contentSha256,
        sizeBytes: parsed.sizeBytes,
        storedSizeBytes: parsed.storedSizeBytes,
      });
      return this.commitProjection(
        parsed.projectId,
        parsed.documentId,
        parsed.versionId,
        parsed.jobId,
      );
    });
  }

  commitMarkdownVersionCas(
    input: CommitMarkdownVersionCasV12,
  ): StudioVersionCommitV12 {
    const parsed = parseInput(
      CommitMarkdownVersionCasV12Schema,
      input,
      "Studio version commit",
    );
    return this.persist(() => this.commitMarkdownVersionInTransaction(parsed));
  }

  restoreVersionCas(
    input: RestoreMarkdownVersionCasV12,
  ): StudioVersionCommitV12 {
    const parsed = parseInput(
      RestoreMarkdownVersionCasV12Schema,
      input,
      "Studio version restore",
    );
    return this.persist(() => {
      const restored = this.selectVersion(
        parsed.projectId,
        parsed.documentId,
        parsed.restoreFromVersionId,
      );
      if (!restored) {
        studioError(
          "DOCUMENT_STUDIO_NOT_FOUND",
          "The Studio version selected for restore was not found.",
        );
      }
      const target = this.mapVersion(restored);
      if (
        parsed.contentSha256 !== target.contentSha256 ||
        parsed.sizeBytes !== target.sizeBytes
      ) {
        studioError(
          "DOCUMENT_STUDIO_PERSISTENCE_FAILED",
          "Prepared restore bytes do not match the immutable target version.",
        );
      }
      const citationAnchorIds = this.listCitationAnchorIdsRaw(
        parsed.projectId,
        parsed.documentId,
        parsed.restoreFromVersionId,
      );
      return this.commitMarkdownVersionInTransaction({
        projectId: parsed.projectId,
        documentId: parsed.documentId,
        expectedCurrentVersionId: parsed.expectedCurrentVersionId,
        versionId: parsed.versionId,
        jobId: parsed.jobId,
        source: "user_upload",
        filename: target.filename,
        summary: parsed.summary,
        operationId: parsed.operationId,
        citationAnchorIds,
        createdAt: parsed.createdAt,
        blobRecordId: parsed.blobRecordId,
        contentSha256: parsed.contentSha256,
        sizeBytes: parsed.sizeBytes,
        storedSizeBytes: parsed.storedSizeBytes,
      });
    });
  }

  private commitMarkdownVersionInTransaction(
    input: z.output<typeof CommitMarkdownVersionCasV12Schema>,
  ): StudioVersionCommitV12 {
    const document = this.database
      .prepare(
        `SELECT document.current_version_id
           FROM documents document
           JOIN projects project
             ON project.id = document.project_id AND project.status = 'active'
          WHERE document.project_id = ? AND document.id = ?
            AND document.document_kind IN ('draft', 'template')
            AND document.deleted_at IS NULL`,
      )
      .get(input.projectId, input.documentId);
    if (!document) {
      studioError(
        "DOCUMENT_STUDIO_NOT_FOUND",
        "Studio document was not found.",
      );
    }
    if (document.current_version_id !== input.expectedCurrentVersionId) {
      studioError(
        "DOCUMENT_STUDIO_VERSION_CONFLICT",
        "Studio document changed since it was opened.",
      );
    }
    if (
      !this.selectVersion(
        input.projectId,
        input.documentId,
        input.expectedCurrentVersionId,
      )
    ) {
      studioError(
        "DOCUMENT_STUDIO_NOT_FOUND",
        "Expected Studio base version was not found.",
      );
    }
    if (input.operationId !== null) {
      const existing = this.database
        .prepare(
          `SELECT version_id FROM document_studio_versions
            WHERE document_id = ? AND operation_id = ?`,
        )
        .get(input.documentId, input.operationId);
      if (existing) {
        studioError(
          "DOCUMENT_STUDIO_OPERATION_CONFLICT",
          "Studio operation id has already been used for this document.",
        );
      }
    }
    this.assertCitationScope(input.projectId, input.citationAnchorIds);
    const versionNumber =
      Number(
        this.database
          .prepare(
            `SELECT coalesce(max(version_number), 0) AS version_number
               FROM document_versions WHERE document_id = ?`,
          )
          .get(input.documentId)?.version_number ?? 0,
      ) + 1;
    const storageKey = workspaceBlobStorageKey({
      kind: "original",
      documentId: input.documentId,
      versionId: input.versionId,
    });
    this.database
      .prepare(
        `INSERT INTO document_versions (
           id, document_id, version_number, source, filename, mime_type,
           size_bytes, content_sha256, storage_key, created_at
         ) VALUES (?, ?, ?, ?, ?, 'text/markdown', ?, ?, ?, ?)`,
      )
      .run(
        input.versionId,
        input.documentId,
        versionNumber,
        input.source,
        input.filename,
        input.sizeBytes,
        input.contentSha256,
        storageKey,
        input.createdAt,
      );
    this.insertStudioMetadata(input);
    this.insertCitationBindings(
      input.projectId,
      input.documentId,
      input.versionId,
      input.citationAnchorIds,
      input.createdAt,
    );
    this.database
      .prepare(
        `UPDATE documents
            SET current_version_id = ?, filename = ?, mime_type = 'text/markdown',
                size_bytes = ?, parse_status = 'pending',
                parse_error_code = NULL, parse_error_json = NULL,
                updated_at = ?
          WHERE project_id = ? AND id = ? AND current_version_id = ?
            AND document_kind IN ('draft', 'template')
            AND deleted_at IS NULL`,
      )
      .run(
        input.versionId,
        input.filename,
        input.sizeBytes,
        input.createdAt,
        input.projectId,
        input.documentId,
        input.expectedCurrentVersionId,
      );
    const current = this.database
      .prepare(
        "SELECT current_version_id FROM documents WHERE project_id = ? AND id = ?",
      )
      .get(input.projectId, input.documentId);
    if (current?.current_version_id !== input.versionId) {
      studioError(
        "DOCUMENT_STUDIO_VERSION_CONFLICT",
        "Studio document changed while the version was being committed.",
      );
    }
    this.insertParseJob(
      input.jobId,
      input.documentId,
      input.versionId,
      input.createdAt,
    );
    this.blobRecords.registerStoredInTransaction({
      id: input.blobRecordId,
      locator: {
        kind: "original",
        documentId: input.documentId,
        versionId: input.versionId,
      },
      contentSha256: input.contentSha256,
      sizeBytes: input.sizeBytes,
      storedSizeBytes: input.storedSizeBytes,
    });
    return this.commitProjection(
      input.projectId,
      input.documentId,
      input.versionId,
      input.jobId,
    );
  }

  private selectVersion(
    projectId: string,
    documentId: string,
    versionId: string,
  ): Row | undefined {
    return this.database
      .prepare(
        `SELECT ${VERSION_SELECT}
           FROM document_studio_versions studio
           JOIN documents document
             ON document.id = studio.document_id
            AND document.project_id = studio.project_id
           JOIN document_versions version
             ON version.document_id = studio.document_id
            AND version.id = studio.version_id
          WHERE studio.project_id = ?
            AND studio.document_id = ?
            AND studio.version_id = ?
            AND document.document_kind IN ('draft', 'template')
            AND document.deleted_at IS NULL
            AND version.deleted_at IS NULL`,
      )
      .get(projectId, documentId, versionId);
  }

  private selectSuggestion(
    projectId: string,
    documentId: string,
    suggestionId: string,
  ): Row | undefined {
    return this.database
      .prepare(
        `SELECT ${SUGGESTION_SELECT}
           FROM document_edits edit
           JOIN documents document ON document.id = edit.document_id
           JOIN document_studio_versions base
             ON base.project_id = document.project_id
            AND base.document_id = edit.document_id
            AND base.version_id = edit.version_id
           LEFT JOIN document_studio_versions result
             ON result.document_id = edit.document_id
            AND result.operation_id = 'studio-suggestion:' || edit.id
          WHERE document.project_id = ?
            AND document.id = ?
            AND edit.id = ?
            AND document.document_kind IN ('draft', 'template')
            AND document.deleted_at IS NULL
            AND edit.start_offset IS NOT NULL
            AND edit.end_offset IS NOT NULL
            AND edit.offset_scope = 'raw_markdown_v1'
            AND edit.offset_unit = 'utf16_code_unit'`,
      )
      .get(projectId, documentId, suggestionId);
  }

  private requireSuggestionInTransaction(
    projectId: string,
    documentId: string,
    suggestionId: string,
  ): DocumentStudioSuggestionV14 {
    const row = this.selectSuggestion(projectId, documentId, suggestionId);
    if (!row) {
      studioError(
        "DOCUMENT_STUDIO_NOT_FOUND",
        "Studio suggestion was not found.",
      );
    }
    return this.mapSuggestion(row);
  }

  private mapSuggestion(row: Row): DocumentStudioSuggestionV14 {
    try {
      return DocumentStudioSuggestionV14Schema.parse({
        id: row.suggestion_id,
        projectId: row.project_id,
        documentId: row.document_id,
        baseVersionId: row.base_version_id,
        messageId: row.message_id,
        changeId: row.change_id,
        startOffset: Number(row.start_offset),
        endOffset: Number(row.end_offset),
        offsetScope: row.offset_scope,
        offsetUnit: row.offset_unit,
        deletedText: row.deleted_text,
        insertedText: row.inserted_text,
        contextBefore: row.context_before,
        contextAfter: row.context_after,
        summary: row.summary,
        status: row.status,
        createdAt: row.created_at,
        resolvedAt: row.resolved_at,
        resultVersionId: row.result_version_id,
      });
    } catch (error) {
      studioError(
        "DOCUMENT_STUDIO_PERSISTENCE_FAILED",
        "Persisted Studio suggestion is invalid.",
        error,
      );
    }
  }

  private mapSuggestionPreview(row: Row): DocumentStudioSuggestionPreviewV14 {
    const deletedTruncated = Number(row.deleted_truncated);
    const insertedTruncated = Number(row.inserted_truncated);
    if (
      (deletedTruncated !== 0 && deletedTruncated !== 1) ||
      (insertedTruncated !== 0 && insertedTruncated !== 1)
    ) {
      studioError(
        "DOCUMENT_STUDIO_PERSISTENCE_FAILED",
        "Persisted Studio suggestion preview flags are invalid.",
      );
    }
    try {
      return DocumentStudioSuggestionPreviewV14Schema.parse({
        id: row.suggestion_id,
        projectId: row.project_id,
        documentId: row.document_id,
        baseVersionId: row.base_version_id,
        messageId: row.message_id,
        startOffset: Number(row.start_offset),
        endOffset: Number(row.end_offset),
        offsetScope: row.offset_scope,
        offsetUnit: row.offset_unit,
        deletedPreview: row.deleted_preview,
        insertedPreview: row.inserted_preview,
        deletedTruncated: deletedTruncated === 1,
        insertedTruncated: insertedTruncated === 1,
        contextBefore: row.context_before,
        contextAfter: row.context_after,
        summary: row.summary,
        status: row.status,
        createdAt: row.created_at,
      });
    } catch (error) {
      studioError(
        "DOCUMENT_STUDIO_PERSISTENCE_FAILED",
        "Persisted Studio suggestion preview is invalid.",
        error,
      );
    }
  }

  private mapDocument(row: Row): StudioDocumentV12 {
    try {
      return StudioDocumentV12Schema.parse({
        id: row.document_id,
        projectId: row.document_project_id,
        folderId: row.document_folder_id,
        documentKind: row.document_kind,
        title: row.document_title,
        filename: row.document_filename,
        mimeType: row.document_mime_type,
        sizeBytes: Number(row.document_size_bytes),
        parseStatus: row.document_parse_status,
        currentVersionId: row.document_current_version_id,
        createdAt: row.document_created_at,
        updatedAt: row.document_updated_at,
      });
    } catch (error) {
      studioError(
        "DOCUMENT_STUDIO_PERSISTENCE_FAILED",
        "Persisted Studio document is invalid.",
        error,
      );
    }
  }

  private mapVersion(row: Row): StudioDocumentVersionV12 {
    const projectId = String(row.project_id);
    const documentId = String(row.document_id);
    const versionId = String(row.version_id);
    const expectedStorageKey = workspaceBlobStorageKey({
      kind: "original",
      documentId,
      versionId,
    });
    if (row.version_storage_key !== expectedStorageKey) {
      studioError(
        "DOCUMENT_STUDIO_PERSISTENCE_FAILED",
        "Persisted Studio version storage key is not deterministic.",
      );
    }
    try {
      return StudioDocumentVersionV12Schema.parse({
        id: versionId,
        projectId,
        documentId,
        versionNumber: Number(row.version_number),
        source: row.version_source,
        filename: row.version_filename,
        mimeType: row.version_mime_type,
        sizeBytes: Number(row.version_size_bytes),
        contentSha256: row.version_content_sha256,
        storageKey: row.version_storage_key,
        pageCount:
          row.version_page_count == null
            ? null
            : Number(row.version_page_count),
        format: row.studio_format,
        summary: row.studio_summary,
        operationId: row.studio_operation_id,
        createdAt: row.studio_created_at,
        citationAnchorIds: this.listCitationAnchorIdsRaw(
          projectId,
          documentId,
          versionId,
        ),
      });
    } catch (error) {
      if (error instanceof WorkspaceDocumentStudioRepositoryError) throw error;
      studioError(
        "DOCUMENT_STUDIO_PERSISTENCE_FAILED",
        "Persisted Studio document version is invalid.",
        error,
      );
    }
  }

  private listCitationAnchorIdsRaw(
    projectId: string,
    documentId: string,
    versionId: string,
  ) {
    return this.database
      .prepare(
        `SELECT anchor_id FROM document_version_citation_anchors
          WHERE project_id = ? AND document_id = ? AND version_id = ?
          ORDER BY ordinal ASC, anchor_id ASC`,
      )
      .all(projectId, documentId, versionId)
      .map((row) => String(row.anchor_id));
  }

  private assertCitationScope(projectId: string, anchorIds: readonly string[]) {
    for (const anchorId of anchorIds) {
      const anchor = this.database
        .prepare(
          "SELECT id FROM source_citation_anchors WHERE project_id = ? AND id = ?",
        )
        .get(projectId, anchorId);
      if (!anchor) {
        studioError(
          "DOCUMENT_STUDIO_NOT_FOUND",
          "Citation anchor was not found.",
        );
      }
    }
  }

  private insertStudioMetadata(input: {
    projectId: string;
    documentId: string;
    versionId: string;
    summary: string | null;
    operationId: string | null;
    createdAt: string;
  }) {
    this.database
      .prepare(
        `INSERT INTO document_studio_versions (
           project_id, document_id, version_id, format, summary, operation_id,
           created_at
         ) VALUES (?, ?, ?, 'markdown', ?, ?, ?)`,
      )
      .run(
        input.projectId,
        input.documentId,
        input.versionId,
        input.summary,
        input.operationId,
        input.createdAt,
      );
  }

  private insertCitationBindings(
    projectId: string,
    documentId: string,
    versionId: string,
    anchorIds: readonly string[],
    createdAt: string,
  ) {
    anchorIds.forEach((anchorId, ordinal) => {
      this.database
        .prepare(
          `INSERT INTO document_version_citation_anchors (
             project_id, document_id, version_id, anchor_id, ordinal,
             created_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(projectId, documentId, versionId, anchorId, ordinal, createdAt);
    });
  }

  private insertParseJob(
    jobId: string,
    documentId: string,
    versionId: string,
    at: string,
  ) {
    this.database
      .prepare(
        `INSERT INTO jobs (
           id, type, status, resource_type, resource_id, attempt, max_attempts,
           retryable, payload_json, scheduled_at, created_at, updated_at
         ) VALUES (?, 'document_parse', 'queued', 'document', ?, 0, 3, 1,
                   ?, ?, ?, ?)`,
      )
      .run(
        jobId,
        documentId,
        JSON.stringify({ documentId, versionId }),
        at,
        at,
        at,
      );
  }

  private commitProjection(
    projectId: string,
    documentId: string,
    versionId: string,
    jobId: string,
  ): StudioVersionCommitV12 {
    const document = this.getProjectDocument(projectId, documentId);
    const version = this.getVersion(projectId, documentId, versionId);
    if (!document || !version) {
      studioError(
        "DOCUMENT_STUDIO_PERSISTENCE_FAILED",
        "Studio commit could not be reloaded.",
      );
    }
    return {
      ...document,
      version,
      jobId,
      citationAnchorIds: [...version.citationAnchorIds],
      replayed: false,
    };
  }

  private persist<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Preserve the primary failure.
      }
      if (error instanceof WorkspaceDocumentStudioRepositoryError) throw error;
      studioError(
        "DOCUMENT_STUDIO_PERSISTENCE_FAILED",
        "Document Studio data could not be persisted.",
        error,
      );
    }
  }
}
