import type { WorkspaceDatabaseAdapter } from "../database";
import { WorkspaceApiError } from "../errors";
import {
  MIKE_LOCAL_USER_ID,
  assertMikeSafePayload,
  serializeMikeDocument,
  serializeMikeTabularCell,
  type MikeColumnConfig,
} from "../mikeCompatibility";
import type {
  TabularCellRecord,
  TabularColumnRecord,
  TabularReviewDetail,
  TabularSourceRef,
} from "../repositories/tabular";
import { TabularRepository } from "../repositories/tabular";
import { TabularExporter } from "../tabularExport";
import type {
  WorkspaceTabularContext,
  WorkspaceTabularDownload,
  WorkspaceTabularStreamSink,
  WorkspaceTabularV1RuntimePort,
} from "../../../routes/workspaceTabularV1";
import { TabularService } from "./tabular";

const DEFAULT_POLL_MS = 100;
const DEFAULT_STREAM_TIMEOUT_MS = 10 * 60 * 1_000;
const TABULAR_REVIEW_WIRE_PAGE_SIZE = 100;
const MAX_TABULAR_REVIEW_WIRES = 10_000;
const UTC_TIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

function wireTimestamp(value: unknown) {
  if (typeof value !== "string" || !UTC_TIME.test(value)) {
    throw new WorkspaceApiError(
      500,
      "INTERNAL_ERROR",
      "Tabular timestamp metadata is invalid.",
    );
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new WorkspaceApiError(
      500,
      "INTERNAL_ERROR",
      "Tabular timestamp metadata is invalid.",
    );
  }
  return new Date(milliseconds).toISOString();
}

function flatErrorDetails(value: unknown) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [
      string,
      string | number | boolean | null,
    ] => {
      const item = entry[1];
      return (
        item === null ||
        typeof item === "string" ||
        typeof item === "number" ||
        typeof item === "boolean"
      );
    }),
  );
}

function columnWire(column: TabularColumnRecord): MikeColumnConfig {
  return {
    index: column.ordinal,
    name: column.title,
    prompt: column.prompt,
    format: column.format,
    tags: [...column.tags],
  };
}

function cellStatus(cell: TabularCellRecord) {
  return cell.status === "queued" || cell.status === "running"
    ? "processing"
    : cell.status === "complete"
      ? "ready"
      : cell.status === "failed"
        ? "failed"
        : cell.status === "cancelled"
          ? "cancelled"
          : "pending";
}

function terminalCell(cell: TabularCellRecord) {
  return (
    cell.status === "complete" ||
    cell.status === "failed" ||
    cell.status === "cancelled"
  );
}

function wireError(cell: TabularCellRecord) {
  const error = cell.error;
  if (!error) {
    return cell.status === "cancelled"
      ? {
          code: "tabular_generation_cancelled",
          message: "Tabular generation was cancelled.",
          retryable: true,
          details: null,
        }
      : null;
  }
  return {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    details: flatErrorDetails(error.details),
  };
}

export class WorkspaceTabularV1RuntimeAdapter
  implements WorkspaceTabularV1RuntimePort
{
  private readonly exporter: TabularExporter;
  private readonly pollMs: number;
  private readonly streamTimeoutMs: number;
  private readonly delay: (milliseconds: number) => Promise<void>;

  constructor(
    private readonly database: WorkspaceDatabaseAdapter,
    private readonly repository: TabularRepository,
    private readonly service: TabularService,
    options: {
      pollMs?: number;
      streamTimeoutMs?: number;
      delay?: (milliseconds: number) => Promise<void>;
    } = {},
  ) {
    this.exporter = new TabularExporter(repository);
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.streamTimeoutMs =
      options.streamTimeoutMs ?? DEFAULT_STREAM_TIMEOUT_MS;
    this.delay =
      options.delay ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)));
    if (
      !Number.isSafeInteger(this.pollMs) ||
      this.pollMs < 1 ||
      !Number.isSafeInteger(this.streamTimeoutMs) ||
      this.streamTimeoutMs < this.pollMs
    ) {
      throw new Error("Tabular stream polling configuration is invalid.");
    }
  }

  private assertPrincipal(context: WorkspaceTabularContext) {
    if (context.principalId !== MIKE_LOCAL_USER_ID) {
      throw new WorkspaceApiError(
        404,
        "NOT_FOUND",
        "Tabular review not found.",
      );
    }
  }

  private reviewWire(detail: TabularReviewDetail) {
    const row = this.database
      .prepare("SELECT practice FROM tabular_reviews WHERE id = ?")
      .get(detail.review.id);
    const value = {
      id: detail.review.id,
      project_id: detail.review.projectId,
      user_id: MIKE_LOCAL_USER_ID,
      title: detail.review.title,
      columns_config: detail.columns.map(columnWire),
      document_ids: [...detail.review.documentIds],
      workflow_id: detail.review.workflowId,
      model_profile_id: detail.review.modelProfileId,
      status: detail.review.status,
      practice: row?.practice == null ? null : String(row.practice),
      shared_with: [] as string[],
      is_owner: true,
      created_at: wireTimestamp(detail.review.createdAt),
      updated_at: wireTimestamp(detail.review.updatedAt),
      document_count: detail.review.documentIds.length,
    };
    assertMikeSafePayload(value);
    return value;
  }

  private sourceWire(source: TabularSourceRef) {
    const chunk =
      source.chunkId == null
        ? null
        : this.database
            .prepare(
              `SELECT page_start, page_end
                 FROM document_chunks
                WHERE id = ? AND document_id = ? AND version_id = ?`,
            )
            .get(source.chunkId, source.documentId, source.versionId);
    return {
      document_id: source.documentId,
      version_id: source.versionId ?? null,
      chunk_id: source.chunkId ?? null,
      quote: source.quote ?? null,
      start_offset: source.startOffset ?? null,
      end_offset: source.endOffset ?? null,
      page_start: chunk?.page_start == null ? null : Number(chunk.page_start),
      page_end: chunk?.page_end == null ? null : Number(chunk.page_end),
    };
  }

  private cellCreatedAt(cellId: string) {
    const row = this.database
      .prepare("SELECT created_at FROM tabular_cells WHERE id = ?")
      .get(cellId);
    if (!row || typeof row.created_at !== "string") {
      throw new WorkspaceApiError(
        500,
        "INTERNAL_ERROR",
        "Tabular cell metadata is unavailable.",
      );
    }
    return wireTimestamp(row.created_at);
  }

  private cellWire(cell: TabularCellRecord, columns: TabularColumnRecord[]) {
    const column = columns.find((candidate) => candidate.id === cell.columnId);
    if (!column) {
      throw new WorkspaceApiError(
        500,
        "INTERNAL_ERROR",
        "Tabular column metadata is unavailable.",
      );
    }
    const base = serializeMikeTabularCell({
      id: cell.id,
      reviewId: cell.reviewId,
      documentId: cell.documentId,
      columnIndex: column.ordinal,
      ...(cell.content
        ? {
            summary: cell.content.summary,
            flag: cell.content.flag,
            reasoning: cell.content.reasoning,
          }
        : {}),
      status: cellStatus(cell),
      createdAt: this.cellCreatedAt(cell.id),
    });
    const value = {
      ...base,
      error: wireError(cell),
      sources: cell.sourceRefs.map((source) => this.sourceWire(source)),
      attempt: cell.attempt,
      updated_at: wireTimestamp(cell.updatedAt),
      completed_at:
        cell.completedAt === null ? null : wireTimestamp(cell.completedAt),
    };
    assertMikeSafePayload(value);
    return value;
  }

  private documentWires(detail: TabularReviewDetail) {
    if (detail.review.documentIds.length === 0) return [];
    const placeholders = detail.review.documentIds.map(() => "?").join(",");
    const rows = this.database
      .prepare(
        `SELECT document.id, document.project_id, document.folder_id,
                document.filename, document.mime_type, document.size_bytes,
                document.parse_status, document.created_at, document.updated_at,
                current.version_number AS active_version_number,
                current.page_count,
                (SELECT max(version_number) FROM document_versions latest
                  WHERE latest.document_id = document.id
                    AND latest.deleted_at IS NULL) AS latest_version_number,
                EXISTS(
                  SELECT 1 FROM workspace_blob_records preview
                   WHERE preview.kind = 'preview'
                     AND preview.document_id = document.id
                     AND preview.version_id = document.current_version_id
                     AND preview.state = 'stored'
                ) AS has_preview
           FROM documents document
           LEFT JOIN document_versions current
             ON current.id = document.current_version_id
            AND current.document_id = document.id
          WHERE document.id IN (${placeholders})
            AND document.deleted_at IS NULL`,
      )
      .all(...detail.review.documentIds);
    const byId = new Map(rows.map((row) => [String(row.id), row]));
    return detail.review.documentIds.map((documentId) => {
      const row = byId.get(documentId);
      if (!row) {
        throw new WorkspaceApiError(
          500,
          "INTERNAL_ERROR",
          "Review document metadata is unavailable.",
        );
      }
      return serializeMikeDocument({
        id: documentId,
        projectId:
          row.project_id == null ? null : String(row.project_id),
        folderId: row.folder_id == null ? null : String(row.folder_id),
        filename: String(row.filename),
        mimeType: row.mime_type == null ? null : String(row.mime_type),
        sizeBytes: Number(row.size_bytes),
        pageCount: row.page_count == null ? null : Number(row.page_count),
        status: String(row.parse_status) as Parameters<
          typeof serializeMikeDocument
        >[0]["status"],
        createdAt: wireTimestamp(row.created_at),
        updatedAt: wireTimestamp(row.updated_at),
        activeVersionNumber:
          row.active_version_number == null
            ? null
            : Number(row.active_version_number),
        latestVersionNumber:
          row.latest_version_number == null
            ? null
            : Number(row.latest_version_number),
        hasPreview: Number(row.has_preview) === 1,
      });
    });
  }

  private detailWire(detail: TabularReviewDetail) {
    const value = {
      review: this.reviewWire(detail),
      cells: detail.cells.map((cell) =>
        this.cellWire(cell, detail.columns),
      ),
      documents: this.documentWires(detail),
    };
    assertMikeSafePayload(value);
    return value;
  }

  async listTabularReviews(
    context: WorkspaceTabularContext,
    query: { projectId?: string },
  ) {
    this.assertPrincipal(context);
    const values: ReturnType<WorkspaceTabularV1RuntimeAdapter["reviewWire"]>[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const page = this.service.list({
        ...(query.projectId ? { projectId: query.projectId } : {}),
        limit: TABULAR_REVIEW_WIRE_PAGE_SIZE,
        cursor,
      });
      for (const review of page.items) {
        if (values.length >= MAX_TABULAR_REVIEW_WIRES) {
          throw new WorkspaceApiError(
            413,
            "VALIDATION_ERROR",
            "Tabular review list exceeds the local client limit.",
          );
        }
        values.push(
          this.reviewWire(this.repository.requireDetail(review.id)),
        );
      }
      cursor = page.nextCursor;
      if (cursor !== null) {
        if (seenCursors.has(cursor)) {
          throw new WorkspaceApiError(
            500,
            "INTERNAL_ERROR",
            "Tabular review pagination did not advance.",
          );
        }
        seenCursors.add(cursor);
      }
    } while (cursor !== null);
    return values;
  }

  async createTabularReview(
    context: WorkspaceTabularContext,
    value: unknown,
  ) {
    this.assertPrincipal(context);
    const input = value as Record<string, unknown>;
    const detail = this.service.create({
      title: input.title,
      documentIds: input.document_ids,
      columns: input.columns_config,
      projectId: input.project_id,
      workflowId: input.workflow_id,
      modelProfileId: input.model_profile_id,
    });
    return this.reviewWire(detail);
  }

  async getTabularReview(
    context: WorkspaceTabularContext,
    reviewId: string,
  ) {
    this.assertPrincipal(context);
    return this.detailWire(this.service.get(reviewId));
  }

  async updateTabularReview(
    context: WorkspaceTabularContext,
    reviewId: string,
    value: unknown,
  ) {
    this.assertPrincipal(context);
    const input = value as Record<string, unknown>;
    let detail = this.service.get(reviewId);
    if (input.document_ids !== undefined || input.columns_config !== undefined) {
      detail = this.service.updateDraftMatrix(reviewId, {
        projectId:
          input.project_id === undefined
            ? detail.review.projectId
            : input.project_id,
        documentIds: input.document_ids ?? detail.review.documentIds,
        columns:
          input.columns_config ?? detail.columns.map(columnWire),
      });
    } else if (input.project_id !== undefined) {
      throw new WorkspaceApiError(
        400,
        "VALIDATION_ERROR",
        "project_id requires a document matrix update.",
      );
    }
    if (input.title !== undefined || input.model_profile_id !== undefined) {
      detail = this.service.update(reviewId, {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.model_profile_id !== undefined
          ? { modelProfileId: input.model_profile_id }
          : {}),
      });
    }
    return this.reviewWire(detail);
  }

  async deleteTabularReview(
    context: WorkspaceTabularContext,
    reviewId: string,
  ) {
    this.assertPrincipal(context);
    this.service.delete(reviewId);
  }

  async clearTabularCells(
    context: WorkspaceTabularContext,
    reviewId: string,
    input: { document_ids: string[] },
  ) {
    this.assertPrincipal(context);
    this.service.clearCells(reviewId, input.document_ids);
  }

  private cellUpdate(
    cell: TabularCellRecord,
    columns: TabularColumnRecord[],
  ) {
    const column = columns.find((candidate) => candidate.id === cell.columnId);
    if (!column) throw new Error("Tabular column is unavailable.");
    return {
      type: "cell_update" as const,
      document_id: cell.documentId,
      column_index: column.ordinal,
      content: cell.content,
      status:
        cell.status === "complete"
          ? ("done" as const)
          : cell.status === "failed" || cell.status === "cancelled"
            ? ("error" as const)
            : ("generating" as const),
    };
  }

  async generateTabularReview(
    context: WorkspaceTabularContext,
    reviewId: string,
    sink: WorkspaceTabularStreamSink,
  ) {
    this.assertPrincipal(context);
    this.service.reconcileGenerationJobs();
    this.service.runReview(reviewId);
    const initial = this.service.get(reviewId);
    const targets = new Set(
      initial.cells
        .filter(
          (cell) => cell.status === "queued" || cell.status === "running",
        )
        .map((cell) => cell.id),
    );
    const signatures = new Map<string, string>();
    const startedAt = Date.now();
    for (;;) {
      if (sink.closed?.()) return;
      this.service.reconcileGenerationJobs();
      const detail = this.service.get(reviewId);
      for (const cell of detail.cells.filter((item) => targets.has(item.id))) {
        const signature = JSON.stringify({
          status: cell.status,
          content: cell.content,
          error: cell.error,
          updatedAt: cell.updatedAt,
        });
        if (signatures.get(cell.id) !== signature) {
          sink.write(this.cellUpdate(cell, detail.columns));
          signatures.set(cell.id, signature);
        }
      }
      if (
        [...targets].every((cellId) => {
          const cell = detail.cells.find((candidate) => candidate.id === cellId);
          return cell !== undefined && terminalCell(cell);
        })
      ) {
        return;
      }
      if (Date.now() - startedAt >= this.streamTimeoutMs) {
        // The Mike generation stream is deliberately cell_update-only. The
        // durable detail endpoint remains authoritative when this bounded
        // observation window ends, and the route emits the normal [DONE].
        return;
      }
      await this.delay(this.pollMs);
    }
  }

  private cellByCoordinates(
    reviewId: string,
    documentId: string,
    columnIndex: number,
  ) {
    const detail = this.service.get(reviewId);
    const column = detail.columns.find(
      (candidate) => candidate.ordinal === columnIndex,
    );
    const cell = column
      ? detail.cells.find(
          (candidate) =>
            candidate.documentId === documentId &&
            candidate.columnId === column.id,
        )
      : undefined;
    if (!column || !cell) {
      throw new WorkspaceApiError(
        404,
        "NOT_FOUND",
        "Tabular cell not found.",
      );
    }
    return { detail, cell };
  }

  async retryTabularCell(
    context: WorkspaceTabularContext,
    reviewId: string,
    input: { document_id: string; column_index: number },
  ) {
    this.assertPrincipal(context);
    const { cell } = this.cellByCoordinates(
      reviewId,
      input.document_id,
      input.column_index,
    );
    const queued = this.service.regenerateCell(cell.id);
    const detail = this.service.get(reviewId);
    return this.cellWire(queued, detail.columns);
  }

  async cancelTabularCell(
    context: WorkspaceTabularContext,
    reviewId: string,
    input: {
      cell_id?: string;
      document_id?: string;
      column_index?: number;
      reason?: string;
    },
  ) {
    this.assertPrincipal(context);
    const detail = this.service.get(reviewId);
    const cell = input.cell_id
      ? detail.cells.find((candidate) => candidate.id === input.cell_id)
      : this.cellByCoordinates(
          reviewId,
          input.document_id!,
          input.column_index!,
        ).cell;
    if (!cell) {
      throw new WorkspaceApiError(
        404,
        "NOT_FOUND",
        "Tabular cell not found.",
      );
    }
    const cancelled = this.service.cancelCell(
      reviewId,
      cell.id,
      input.reason,
    );
    return this.cellWire(cancelled, detail.columns);
  }

  async exportTabularReview(
    context: WorkspaceTabularContext,
    reviewId: string,
    format: "csv" | "xlsx",
  ): Promise<WorkspaceTabularDownload> {
    this.assertPrincipal(context);
    const detail = this.service.get(reviewId);
    const basename = `Vera-${detail.review.id}`;
    return format === "csv"
      ? {
          filename: `${basename}.csv`,
          contentType: "text/csv; charset=utf-8",
          body: this.exporter.csv(reviewId),
        }
      : {
          filename: `${basename}.xlsx`,
          contentType:
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          body: await this.exporter.xlsx(reviewId),
        };
  }
}
