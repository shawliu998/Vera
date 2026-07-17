import { z } from "zod";

import {
  DocumentStudioDraftOriginV20Schema,
  DocumentStudioDraftTypeV20Schema,
  type DocumentStudioDraftOriginV20,
  type DocumentStudioDraftTypeV20,
} from "../documentStudioDraftMetadataV20";
import type { WorkspaceDatabaseAdapter } from "../migrations";

const Id = z.string().uuid();
const IsoDateTime = z.string().datetime({ precision: 3, offset: false });

export type DocumentStudioDraftListCursor = Readonly<{
  updatedAt: string;
  documentId: string;
}>;

export type DocumentStudioDraftSummary = Readonly<{
  documentId: string;
  projectId: string;
  title: string;
  documentType: DocumentStudioDraftTypeV20;
  currentVersionId: string;
  currentVersionNumber: number;
  updatedAt: string;
  sourceCount: number;
  pendingSuggestionCount: number;
  originType: DocumentStudioDraftOriginV20 | "tabular";
}>;

export type DocumentStudioDraftSummaryPage = Readonly<{
  drafts: readonly DocumentStudioDraftSummary[];
  hasMore: boolean;
  nextCursor: DocumentStudioDraftListCursor | null;
}>;

export class WorkspaceDocumentStudioDraftsRepository {
  constructor(private readonly database: WorkspaceDatabaseAdapter) {}

  listProjectDrafts(input: {
    projectId: string;
    limit: number;
    cursor?: DocumentStudioDraftListCursor | null;
  }): DocumentStudioDraftSummaryPage {
    const projectId = Id.parse(input.projectId);
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100
    ) {
      throw new Error("Draft summary limit is invalid.");
    }
    const cursor = input.cursor
      ? {
          updatedAt: IsoDateTime.parse(input.cursor.updatedAt),
          documentId: Id.parse(input.cursor.documentId),
        }
      : null;
    const rows = this.database
      .prepare(
        `SELECT document.id AS document_id,
                document.title AS title,
                coalesce(metadata.document_type, 'general_legal_document') AS document_type,
                document.current_version_id AS current_version_id,
                version.version_number AS current_version_number,
                document.updated_at AS updated_at,
                CASE WHEN EXISTS (
                  SELECT 1 FROM tabular_review_studio_handoffs handoff
                   WHERE handoff.project_id = document.project_id
                     AND handoff.document_id = document.id
                ) THEN 'tabular'
                ELSE coalesce(metadata.origin_type, 'unknown') END AS origin_type,
                (
                  SELECT count(*)
                    FROM document_version_citation_anchors citation
                   WHERE citation.project_id = document.project_id
                     AND citation.document_id = document.id
                     AND citation.version_id = document.current_version_id
                ) AS source_count,
                (
                  SELECT count(*)
                    FROM document_edits edit
                   WHERE edit.document_id = document.id
                     AND edit.status = 'pending'
                     AND edit.resolved_at IS NULL
                     AND EXISTS (
                       SELECT 1
                         FROM document_studio_versions base
                        WHERE base.project_id = document.project_id
                          AND base.document_id = document.id
                          AND base.version_id = edit.version_id
                     )
                ) AS pending_suggestion_count
           FROM documents document
           JOIN projects project
             ON project.id = document.project_id
            AND project.status IN ('active', 'archived')
           JOIN document_versions version
             ON version.document_id = document.id
            AND version.id = document.current_version_id
            AND version.deleted_at IS NULL
           JOIN document_studio_versions studio
             ON studio.project_id = document.project_id
            AND studio.document_id = document.id
            AND studio.version_id = document.current_version_id
           LEFT JOIN document_studio_draft_metadata metadata
             ON metadata.project_id = document.project_id
            AND metadata.document_id = document.id
          WHERE document.project_id = ?
            AND document.document_kind = 'draft'
            AND document.deleted_at IS NULL
            AND (
              ? IS NULL OR document.updated_at < ? OR
              (document.updated_at = ? AND document.id < ?)
            )
          ORDER BY document.updated_at DESC, document.id DESC
          LIMIT ?`,
      )
      .all(
        projectId,
        cursor?.updatedAt ?? null,
        cursor?.updatedAt ?? null,
        cursor?.updatedAt ?? null,
        cursor?.documentId ?? null,
        input.limit + 1,
      );
    const drafts = rows.slice(0, input.limit).map((row) => {
      const documentType = DocumentStudioDraftTypeV20Schema.parse(
        row.document_type,
      );
      const currentVersionNumber = Number(row.current_version_number);
      const sourceCount = Number(row.source_count);
      const pendingSuggestionCount = Number(row.pending_suggestion_count);
      if (
        !Number.isSafeInteger(currentVersionNumber) ||
        currentVersionNumber < 1 ||
        !Number.isSafeInteger(sourceCount) ||
        sourceCount < 0 ||
        !Number.isSafeInteger(pendingSuggestionCount) ||
        pendingSuggestionCount < 0
      ) {
        throw new Error("Draft summary counters are invalid.");
      }
      const originType: DocumentStudioDraftOriginV20 | "tabular" =
        row.origin_type === "tabular"
          ? "tabular"
          : DocumentStudioDraftOriginV20Schema.parse(row.origin_type);
      return {
        documentId: Id.parse(row.document_id),
        projectId,
        title: z.string().min(1).max(240).parse(row.title),
        documentType,
        currentVersionId: Id.parse(row.current_version_id),
        currentVersionNumber,
        updatedAt: IsoDateTime.parse(row.updated_at),
        sourceCount,
        pendingSuggestionCount,
        originType,
      };
    });
    const last = drafts.at(-1) ?? null;
    return {
      drafts,
      hasMore: rows.length > input.limit,
      nextCursor:
        rows.length > input.limit && last
          ? { updatedAt: last.updatedAt, documentId: last.documentId }
          : null,
    };
  }
}
