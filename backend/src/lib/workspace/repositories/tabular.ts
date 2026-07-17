import { Buffer } from "node:buffer";

import type { WorkspaceDatabaseAdapter } from "../database";
import { WorkspaceApiError } from "../errors";
import {
  normalizePageRequest,
  type Page,
  type PageRequest,
} from "../pagination";
import type {
  StructuredError,
  TabularCell,
  TabularCellStatus,
  TabularReview,
} from "../types";
import {
  legacyOutputTypeForFormat,
  legacyValueForContent,
  normalizeTabularCellContent,
  type LegacyTabularOutputType,
  type TabularCellContent,
} from "../services/tabularCompatibility";
import {
  assertTabularSourceRefsV7,
  mapTabularCellV7,
  mapTabularChatMessageV7,
  mapTabularChatV7,
  mapTabularColumnV7,
  mapTabularReviewV7,
  TabularSourceRefSchema,
  type TabularCellRecord,
  type TabularChatMessageRecord,
  type TabularChatRecord,
  type TabularColumnRecord,
  type TabularLegacyCellValue,
  type TabularReviewDetail,
  type TabularSourceRef,
} from "../tabularPersistenceV7";

export {
  TabularSourceRefSchema,
  type TabularCellRecord,
  type TabularChatMessageRecord,
  type TabularChatRecord,
  type TabularColumnRecord,
  type TabularLegacyCellValue,
  type TabularReviewDetail,
  type TabularSourceRef,
} from "../tabularPersistenceV7";

export const MAX_TABULAR_EXPORT_SOURCE_BYTES = 8 * 1024 * 1024;
export type TabularDocumentSnapshot = {
  documentId: string;
  versionId: string;
  contentSha256: string;
  textSha256: string;
  textBytes: number;
  chunkCount: number;
};
export type TabularDocumentSnapshotText = TabularDocumentSnapshot & {
  id: string;
  title: string;
  filename: string;
  text: string;
};
export type TabularExportRow = {
  documentId: string;
  documentTitle: string;
  cells: TabularCellRecord[];
};
export type TabularExportData = {
  review: TabularReview;
  columns: TabularColumnRecord[];
  rows: TabularExportRow[];
};
export type NewTabularReviewRecord = {
  id: string;
  projectId: string | null;
  workflowId: string | null;
  modelProfileId: string | null;
  title: string;
  documentIds: string[];
  columns: TabularColumnRecord[];
  cells: Array<{
    id: string;
    documentId: string;
    columnId: string;
    outputType: LegacyTabularOutputType;
  }>;
  now: string;
};

const encodeCursor = (value: { updatedAt: string; id: string }) =>
  Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

function decodeCursor(cursor: string | null) {
  if (!cursor) return null;
  try {
    const value = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    if (
      typeof value.updatedAt !== "string" ||
      !value.updatedAt ||
      typeof value.id !== "string" ||
      !value.id
    ) {
      throw new Error("invalid cursor");
    }
    return { updatedAt: value.updatedAt, id: value.id };
  } catch {
    throw new WorkspaceApiError(
      400,
      "VALIDATION_ERROR",
      "Invalid pagination cursor.",
    );
  }
}

const serialize = (value: unknown) => JSON.stringify(value);

function tabularColumnsConfigJson(columns: TabularColumnRecord[]) {
  return serialize(
    [...columns]
      .sort(
        (left, right) =>
          left.ordinal - right.ordinal || left.id.localeCompare(right.id),
      )
      .map((column) => ({
        index: column.ordinal,
        name: column.title,
        prompt: column.prompt,
        format: column.format,
        tags: column.tags,
      })),
  );
}

function failDocumentSnapshot(
  status: number,
  code: "VALIDATION_ERROR" | "PRECONDITION_FAILED" | "CONFLICT",
  message: string,
): never {
  throw new WorkspaceApiError(status, code, message);
}

export class TabularRepository {
  private mikeSemanticsAvailable: boolean | null = null;

  constructor(readonly database: WorkspaceDatabaseAdapter) {}

  private transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const value = operation();
      this.database.exec("COMMIT");
      return value;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Preserve the original failure.
      }
      throw error;
    }
  }

  private hasColumn(table: string, column: string) {
    return this.database
      .prepare(`PRAGMA table_info("${table}")`)
      .all()
      .some((row) => String(row.name) === column);
  }

  private hasMikeSemantics() {
    if (this.mikeSemanticsAvailable === null) {
      this.mikeSemanticsAvailable = this.hasColumn(
        "tabular_review_columns",
        "format",
      );
    }
    return this.mikeSemanticsAvailable;
  }

  private assertSourceRefs(
    documentId: string,
    sourceRefs: TabularSourceRef[],
    persisted = false,
  ) {
    assertTabularSourceRefsV7(this.database, documentId, sourceRefs, persisted);
  }

  list(
    request: PageRequest & {
      projectId?: string;
      includeArchived?: boolean;
    } = {},
  ): Page<TabularReview> {
    const page = normalizePageRequest(request);
    const cursor = decodeCursor(page.cursor);
    const conditions = [
      request.includeArchived ? "1 = 1" : "status <> 'archived'",
    ];
    const parameters: unknown[] = [];
    if (request.projectId) {
      conditions.push("project_id = ?");
      parameters.push(request.projectId);
    }
    if (cursor) {
      conditions.push("(updated_at < ? OR (updated_at = ? AND id < ?))");
      parameters.push(cursor.updatedAt, cursor.updatedAt, cursor.id);
    }
    parameters.push(page.limit + 1);
    const rows = this.database
      .prepare(
        `SELECT * FROM tabular_reviews
         WHERE ${conditions.join(" AND ")}
         ORDER BY updated_at DESC, id DESC LIMIT ?`,
      )
      .all(...parameters);
    const items = rows
      .slice(0, page.limit)
      .map((row) => mapTabularReviewV7(row, this.documentIds(String(row.id))));
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        rows.length > page.limit && last
          ? encodeCursor({ updatedAt: last.updatedAt, id: last.id })
          : null,
    };
  }

  get(id: string): TabularReview | null {
    const row = this.database
      .prepare("SELECT * FROM tabular_reviews WHERE id = ?")
      .get(id);
    return row ? mapTabularReviewV7(row, this.documentIds(id)) : null;
  }

  private documentIds(reviewId: string) {
    return this.database
      .prepare(
        `SELECT document_id FROM tabular_review_documents
         WHERE review_id = ? ORDER BY ordinal ASC, document_id ASC`,
      )
      .all(reviewId)
      .map((row) => String(row.document_id));
  }

  require(id: string) {
    const review = this.get(id);
    if (!review)
      throw new WorkspaceApiError(
        404,
        "NOT_FOUND",
        "Tabular review not found.",
      );
    return review;
  }

  getDetail(id: string): TabularReviewDetail | null {
    const review = this.get(id);
    if (!review) return null;
    const columns = this.database
      .prepare(
        "SELECT * FROM tabular_review_columns WHERE review_id = ? ORDER BY ordinal ASC, id ASC",
      )
      .all(id)
      .map(mapTabularColumnV7);
    const cellRows = this.database
      .prepare("SELECT * FROM tabular_cells WHERE review_id = ?")
      .all(id)
      .map(mapTabularCellV7);
    const documentOrder = new Map(
      review.documentIds.map((documentId, ordinal) => [documentId, ordinal]),
    );
    const columnOrder = new Map(
      columns.map((column) => [column.id, column.ordinal]),
    );
    cellRows.sort(
      (left, right) =>
        (documentOrder.get(left.documentId) ?? Number.MAX_SAFE_INTEGER) -
          (documentOrder.get(right.documentId) ?? Number.MAX_SAFE_INTEGER) ||
        (columnOrder.get(left.columnId) ?? Number.MAX_SAFE_INTEGER) -
          (columnOrder.get(right.columnId) ?? Number.MAX_SAFE_INTEGER) ||
        left.id.localeCompare(right.id),
    );
    if (cellRows.length !== columns.length * review.documentIds.length) {
      throw new WorkspaceApiError(
        500,
        "INTERNAL_ERROR",
        "Persisted tabular matrix is incomplete.",
      );
    }
    const columnsById = new Map(columns.map((column) => [column.id, column]));
    const documentIds = new Set(review.documentIds);
    for (const cell of cellRows) {
      const column = columnsById.get(cell.columnId);
      const validEnum =
        column?.outputType !== "enum" ||
        cell.value === null ||
        !column.enumValues?.length ||
        (typeof cell.value === "string" &&
          Boolean(column.enumValues?.includes(cell.value)));
      const validCompletion =
        cell.status !== "complete" ||
        (cell.content !== null &&
          cell.completedAt !== null &&
          cell.error === null);
      const validFailure = cell.status !== "failed" || cell.error !== null;
      let validSources = true;
      try {
        this.assertSourceRefs(cell.documentId, cell.sourceRefs, true);
      } catch {
        validSources = false;
      }
      if (
        !column ||
        column.outputType !== cell.outputType ||
        !documentIds.has(cell.documentId) ||
        !validEnum ||
        !validCompletion ||
        !validFailure ||
        !validSources
      ) {
        throw new WorkspaceApiError(
          500,
          "INTERNAL_ERROR",
          "Persisted tabular cell violates its review configuration.",
        );
      }
    }
    return { review, columns, cells: cellRows };
  }

  requireDetail(id: string) {
    const detail = this.getDetail(id);
    if (!detail)
      throw new WorkspaceApiError(
        404,
        "NOT_FOUND",
        "Tabular review not found.",
      );
    return detail;
  }

  workspaceDefaults() {
    const row = this.database
      .prepare(
        `SELECT default_project_id, default_model_profile_id
         FROM workspace_settings WHERE id = 'workspace'`,
      )
      .get();
    if (!row) {
      throw new WorkspaceApiError(
        500,
        "INTERNAL_ERROR",
        "Workspace settings are unavailable.",
      );
    }
    return {
      defaultProjectId:
        row.default_project_id == null ? null : String(row.default_project_id),
      defaultModelProfileId:
        row.default_model_profile_id == null
          ? null
          : String(row.default_model_profile_id),
    };
  }

  requireActiveProject(projectId: string) {
    const row = this.database
      .prepare(
        "SELECT status, default_model_profile_id FROM projects WHERE id = ?",
      )
      .get(projectId);
    if (!row)
      throw new WorkspaceApiError(404, "NOT_FOUND", "Project not found.");
    if (row.status !== "active") {
      throw new WorkspaceApiError(409, "CONFLICT", "Project is not active.");
    }
    return {
      id: projectId,
      defaultModelProfileId:
        row.default_model_profile_id == null
          ? null
          : String(row.default_model_profile_id),
    };
  }

  requireEnabledModelProfile(modelProfileId: string) {
    const row = this.database
      .prepare("SELECT enabled FROM model_profiles WHERE id = ?")
      .get(modelProfileId);
    if (!row)
      throw new WorkspaceApiError(404, "NOT_FOUND", "Model profile not found.");
    if (Number(row.enabled) !== 1) {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Model profile is disabled.",
      );
    }
    return { id: modelProfileId };
  }

  modelProfileContextWindowTokens(modelProfileId: string) {
    const row = this.database
      .prepare(
        "SELECT context_window_tokens, enabled FROM model_profiles WHERE id = ?",
      )
      .get(modelProfileId);
    if (!row || Number(row.enabled) !== 1) {
      throw new WorkspaceApiError(404, "NOT_FOUND", "Model profile not found.");
    }
    return row.context_window_tokens == null
      ? null
      : Number(row.context_window_tokens);
  }

  requireActiveTabularWorkflow(workflowId: string) {
    const row = this.database
      .prepare("SELECT type, status FROM workflows WHERE id = ?")
      .get(workflowId);
    if (!row)
      throw new WorkspaceApiError(404, "NOT_FOUND", "Workflow not found.");
    if (row.type !== "tabular" || row.status !== "active") {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Tabular workflow is not active.",
      );
    }
    return { id: workflowId };
  }

  requireReadyDocuments(projectId: string, documentIds: string[]) {
    if (documentIds.length === 0) {
      throw new WorkspaceApiError(
        400,
        "VALIDATION_ERROR",
        "Documents are required.",
      );
    }
    const placeholders = documentIds.map(() => "?").join(", ");
    const rows = this.database
      .prepare(
        `SELECT id, project_id, parse_status, deleted_at FROM documents
         WHERE id IN (${placeholders})`,
      )
      .all(...documentIds);
    const byId = new Map(rows.map((row) => [String(row.id), row]));
    for (const id of documentIds) {
      const row = byId.get(id);
      if (!row || row.deleted_at != null) {
        throw new WorkspaceApiError(404, "NOT_FOUND", "Document not found.");
      }
      if (row.project_id == null || String(row.project_id) !== projectId) {
        throw new WorkspaceApiError(
          409,
          "CONFLICT",
          "Every review document must belong to the selected project.",
        );
      }
      if (row.parse_status !== "ready") {
        throw new WorkspaceApiError(
          409,
          "CONFLICT",
          "Every review document must be ready.",
        );
      }
    }
  }

  currentDocumentSnapshots(
    projectId: string,
    documentIds: string[],
    _maxTextBytes: number,
  ): TabularDocumentSnapshot[] {
    this.requireReadyDocuments(projectId, documentIds);
    failDocumentSnapshot(
      409,
      "CONFLICT",
      "Tabular generation requires a document-level authoritative extracted-text snapshot reader.",
    );
  }

  readDocumentSnapshotText(input: {
    documentId: string;
    versionId: string;
    contentSha256: string;
    textSha256?: string;
    textBytes?: number;
    maxTextBytes: number;
  }): TabularDocumentSnapshotText {
    void input;
    failDocumentSnapshot(
      409,
      "CONFLICT",
      "Tabular generation requires a document-level authoritative extracted-text snapshot reader.",
    );
  }

  documentProjectForDraft(documentIds: string[]) {
    if (documentIds.length === 0) return null;
    const placeholders = documentIds.map(() => "?").join(", ");
    const rows = this.database
      .prepare(
        `SELECT id, project_id, deleted_at FROM documents
         WHERE id IN (${placeholders})`,
      )
      .all(...documentIds);
    const byId = new Map(rows.map((row) => [String(row.id), row]));
    let projectId: string | null = null;
    for (const id of documentIds) {
      const row = byId.get(id);
      if (!row || row.deleted_at != null) {
        throw new WorkspaceApiError(404, "NOT_FOUND", "Document not found.");
      }
      if (row.project_id == null) {
        throw new WorkspaceApiError(
          409,
          "CONFLICT",
          "Tabular review documents require a project.",
        );
      }
      const candidate = String(row.project_id);
      if (projectId !== null && projectId !== candidate) {
        throw new WorkspaceApiError(
          409,
          "CONFLICT",
          "Every review document must belong to the same project.",
        );
      }
      projectId = candidate;
    }
    return projectId;
  }

  create(input: NewTabularReviewRecord) {
    return this.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO tabular_reviews
            (id, project_id, workflow_id, model_profile_id, title, status,
             document_ids_json, columns_config_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.projectId,
          input.workflowId,
          input.modelProfileId,
          input.title,
          serialize(input.documentIds),
          tabularColumnsConfigJson(input.columns),
          input.now,
          input.now,
        );
      const membershipStatement = this.database.prepare(
        `INSERT INTO tabular_review_documents
          (review_id, document_id, ordinal, created_at)
         VALUES (?, ?, ?, ?)`,
      );
      input.documentIds.forEach((documentId, ordinal) => {
        membershipStatement.run(input.id, documentId, ordinal, input.now);
      });
      const hasMikeSemantics = this.hasMikeSemantics();
      const columnStatement = this.database.prepare(
        hasMikeSemantics
          ? `INSERT INTO tabular_review_columns
              (id, review_id, key, title, output_type, prompt, enum_values_json,
               ordinal, created_at, updated_at, format, tags_json,
               legacy_output_type, legacy_metadata_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          : `INSERT INTO tabular_review_columns
              (id, review_id, key, title, output_type, prompt, enum_values_json,
               ordinal, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const column of input.columns) {
        const args = [
          column.id,
          input.id,
          column.key,
          column.title,
          column.outputType,
          column.prompt,
          column.enumValues == null ? null : serialize(column.enumValues),
          column.ordinal,
          input.now,
          input.now,
        ];
        columnStatement.run(
          ...(hasMikeSemantics
            ? [
                ...args,
                column.format,
                serialize(column.tags),
                column.legacyMetadata.legacyOutputType == null
                  ? column.outputType
                  : String(column.legacyMetadata.legacyOutputType),
                serialize(column.legacyMetadata),
              ]
            : args),
        );
      }
      const cellStatement = this.database.prepare(
        `INSERT INTO tabular_cells
          (id, review_id, document_id, column_id, output_type, status,
           citations_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'empty', '[]', ?, ?)`,
      );
      for (const cell of input.cells) {
        cellStatement.run(
          cell.id,
          input.id,
          cell.documentId,
          cell.columnId,
          cell.outputType,
          input.now,
          input.now,
        );
      }
      return this.requireDetail(input.id);
    });
  }

  replaceDraftMatrix(input: NewTabularReviewRecord) {
    return this.transaction(() => {
      const existing = this.require(input.id);
      if (existing.status !== "draft" && existing.status !== "ready") {
        throw new WorkspaceApiError(
          409,
          "CONFLICT",
          "Only a draft review matrix can be replaced.",
        );
      }
      this.database
        .prepare("DELETE FROM tabular_cells WHERE review_id = ?")
        .run(input.id);
      this.database
        .prepare("DELETE FROM tabular_review_columns WHERE review_id = ?")
        .run(input.id);
      this.database
        .prepare("DELETE FROM tabular_review_documents WHERE review_id = ?")
        .run(input.id);
      this.database
        .prepare(
          `UPDATE tabular_reviews
           SET project_id = ?, model_profile_id = ?, workflow_id = ?,
               document_ids_json = ?, columns_config_json = ?, status = 'draft',
               updated_at = ?
           WHERE id = ?`,
        )
        .run(
          input.projectId,
          input.modelProfileId,
          input.workflowId,
          serialize(input.documentIds),
          tabularColumnsConfigJson(input.columns),
          input.now,
          input.id,
        );
      const membershipStatement = this.database.prepare(
        `INSERT INTO tabular_review_documents
          (review_id, document_id, ordinal, created_at)
         VALUES (?, ?, ?, ?)`,
      );
      input.documentIds.forEach((documentId, ordinal) => {
        membershipStatement.run(input.id, documentId, ordinal, input.now);
      });
      const hasMikeSemantics = this.hasMikeSemantics();
      const columnStatement = this.database.prepare(
        hasMikeSemantics
          ? `INSERT INTO tabular_review_columns
              (id, review_id, key, title, output_type, prompt, enum_values_json,
               ordinal, created_at, updated_at, format, tags_json,
               legacy_output_type, legacy_metadata_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          : `INSERT INTO tabular_review_columns
              (id, review_id, key, title, output_type, prompt, enum_values_json,
               ordinal, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const column of input.columns) {
        const args = [
          column.id,
          input.id,
          column.key,
          column.title,
          column.outputType,
          column.prompt,
          column.enumValues == null ? null : serialize(column.enumValues),
          column.ordinal,
          input.now,
          input.now,
        ];
        columnStatement.run(
          ...(hasMikeSemantics
            ? [
                ...args,
                column.format,
                serialize(column.tags),
                column.legacyMetadata.legacyOutputType == null
                  ? column.outputType
                  : String(column.legacyMetadata.legacyOutputType),
                serialize(column.legacyMetadata),
              ]
            : args),
        );
      }
      const cellStatement = this.database.prepare(
        `INSERT INTO tabular_cells
          (id, review_id, document_id, column_id, output_type, status,
           citations_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'empty', '[]', ?, ?)`,
      );
      for (const cell of input.cells) {
        cellStatement.run(
          cell.id,
          input.id,
          cell.documentId,
          cell.columnId,
          cell.outputType,
          input.now,
          input.now,
        );
      }
      return this.requireDetail(input.id);
    });
  }

  update(
    id: string,
    input: {
      title?: string;
      status?: "draft" | "ready" | "archived" | "cancelled";
      modelProfileId?: string | null;
      now: string;
    },
  ) {
    const existing = this.require(id);
    this.database
      .prepare(
        `UPDATE tabular_reviews
         SET title = ?, status = ?, model_profile_id = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        input.title ?? existing.title,
        input.status ?? existing.status,
        input.modelProfileId === undefined
          ? existing.modelProfileId
          : input.modelProfileId,
        input.now,
        id,
      );
    return this.requireDetail(id);
  }

  archive(id: string, now: string) {
    return this.update(id, { status: "archived", now });
  }

  delete(id: string) {
    const review = this.require(id);
    if (review.status === "running") {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Cancel the running review first.",
      );
    }
    const handoffTable = this.database
      .prepare(
        "SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = 'tabular_review_studio_handoffs'",
      )
      .get();
    if (
      handoffTable &&
      this.database
        .prepare(
          "SELECT 1 AS present FROM tabular_review_studio_handoffs WHERE review_id = ? LIMIT 1",
        )
        .get(id)
    ) {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "A review with a Studio handoff must be archived, not deleted.",
      );
    }
    this.database.prepare("DELETE FROM tabular_reviews WHERE id = ?").run(id);
  }

  queueCell(
    input: {
      cellId: string;
      jobId: string;
      nextAttempt: number;
      now: string;
      allowedStatuses?: TabularCellStatus[];
    },
    enqueueJob: () => { id: string },
  ) {
    return this.transaction(() =>
      this.queueCellInTransaction(input, enqueueJob),
    );
  }

  private queueCellInTransaction(
    input: {
      cellId: string;
      jobId: string;
      nextAttempt: number;
      now: string;
      allowedStatuses?: TabularCellStatus[];
    },
    enqueueJob: () => { id: string },
  ) {
    const cell = this.requireCell(input.cellId);
    const allowed = input.allowedStatuses ?? ["empty", "failed"];
    if (!allowed.includes(cell.status)) {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Tabular cell cannot be queued.",
      );
    }
    if (
      !Number.isSafeInteger(input.nextAttempt) ||
      input.nextAttempt <= cell.attempt
    ) {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Tabular cell generation is stale.",
      );
    }
    const job = enqueueJob();
    if (job.id !== input.jobId) {
      throw new WorkspaceApiError(
        500,
        "INTERNAL_ERROR",
        "Tabular job state mismatch.",
      );
    }
    this.database
      .prepare(
        `UPDATE tabular_cells
         SET status = 'queued', job_id = ?, attempt = ?, value_json = NULL,
             content = NULL, citations_json = '[]', error_json = NULL,
             error_code = NULL, completed_at = NULL, updated_at = ?
         WHERE id = ?`,
      )
      .run(input.jobId, input.nextAttempt, input.now, input.cellId);
    this.database
      .prepare(
        "UPDATE tabular_reviews SET status = 'running', updated_at = ? WHERE id = ?",
      )
      .run(input.now, cell.reviewId);
    return this.requireCell(input.cellId);
  }

  queueCells(
    inputs: Array<{
      cellId: string;
      jobId: string;
      nextAttempt: number;
      now: string;
      allowedStatuses?: TabularCellStatus[];
      enqueueJob: () => { id: string };
    }>,
  ) {
    return this.transaction(() =>
      inputs.map(({ enqueueJob, ...input }) =>
        this.queueCellInTransaction(input, enqueueJob),
      ),
    );
  }

  getCell(id: string): TabularCellRecord | null {
    const row = this.database
      .prepare("SELECT * FROM tabular_cells WHERE id = ?")
      .get(id);
    return row ? mapTabularCellV7(row) : null;
  }

  requireCell(id: string) {
    const cell = this.getCell(id);
    if (!cell)
      throw new WorkspaceApiError(404, "NOT_FOUND", "Tabular cell not found.");
    return cell;
  }

  startCell(cellId: string, now: string, startJob: () => { id: string }) {
    return this.transaction(() => {
      const cell = this.requireCell(cellId);
      if (cell.status !== "queued" || !cell.jobId) {
        throw new WorkspaceApiError(
          409,
          "CONFLICT",
          "Tabular cell is not queued.",
        );
      }
      const job = startJob();
      if (job.id !== cell.jobId) {
        throw new WorkspaceApiError(
          500,
          "INTERNAL_ERROR",
          "Tabular job state mismatch.",
        );
      }
      this.database
        .prepare(
          "UPDATE tabular_cells SET status = 'running', updated_at = ? WHERE id = ?",
        )
        .run(now, cellId);
      return this.requireCell(cellId);
    });
  }

  startClaimedCell(
    cellId: string,
    now: string,
    assertJob: () => { id: string },
  ) {
    return this.transaction(() => {
      const cell = this.requireCell(cellId);
      if (
        !cell.jobId ||
        (cell.status !== "queued" && cell.status !== "running")
      ) {
        throw new WorkspaceApiError(
          409,
          "CONFLICT",
          "Tabular cell is not claimed.",
        );
      }
      const job = assertJob();
      if (job.id !== cell.jobId) {
        throw new WorkspaceApiError(
          500,
          "INTERNAL_ERROR",
          "Tabular job state mismatch.",
        );
      }
      if (cell.status === "queued") {
        this.database
          .prepare(
            "UPDATE tabular_cells SET status = 'running', updated_at = ? WHERE id = ?",
          )
          .run(now, cellId);
      }
      return this.requireCell(cellId);
    });
  }

  completeCell(
    cellId: string,
    value: TabularLegacyCellValue | TabularCellContent,
    sourceRefs: TabularSourceRef[],
    now: string,
    completeJob: () => { id: string },
  ) {
    return this.transaction(() => {
      const cell = this.requireCell(cellId);
      if (cell.status !== "running" || !cell.jobId) {
        throw new WorkspaceApiError(
          409,
          "CONFLICT",
          "Tabular cell is not running.",
        );
      }
      this.assertSourceRefs(cell.documentId, sourceRefs);
      const content = normalizeTabularCellContent(value);
      if (!content) {
        throw new WorkspaceApiError(
          400,
          "VALIDATION_ERROR",
          "A completed cell requires structured content.",
        );
      }
      const legacyValue = legacyValueForContent(content, cell.outputType);
      const job = completeJob();
      if (job.id !== cell.jobId) {
        throw new WorkspaceApiError(
          500,
          "INTERNAL_ERROR",
          "Tabular job state mismatch.",
        );
      }
      this.database
        .prepare(
          `UPDATE tabular_cells
           SET status = 'complete', value_json = ?, content = ?, citations_json = ?,
               error_json = NULL, error_code = NULL, completed_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          serialize(legacyValue),
          serialize(content),
          serialize(sourceRefs),
          now,
          now,
          cellId,
        );
      this.refreshStatus(cell.reviewId, now);
      return this.requireCell(cellId);
    });
  }

  completeClaimedCell(
    cellId: string,
    value: TabularCellContent,
    sourceRefs: TabularSourceRef[],
    jobResult: unknown,
    now: string,
    assertJob: () => { id: string },
    finishJob: (result: unknown) => { id: string },
  ) {
    return this.transaction(() => {
      const cell = this.requireCell(cellId);
      if (cell.status !== "running" || !cell.jobId) {
        throw new WorkspaceApiError(
          409,
          "CONFLICT",
          "Tabular cell is not running.",
        );
      }
      const asserted = assertJob();
      if (asserted.id !== cell.jobId) {
        throw new WorkspaceApiError(
          500,
          "INTERNAL_ERROR",
          "Tabular job state mismatch.",
        );
      }
      this.assertSourceRefs(cell.documentId, sourceRefs);
      const content = normalizeTabularCellContent(value);
      if (!content) {
        throw new WorkspaceApiError(
          400,
          "VALIDATION_ERROR",
          "A completed cell requires structured content.",
        );
      }
      const legacyValue = legacyValueForContent(content, cell.outputType);
      this.database
        .prepare(
          `UPDATE tabular_cells
           SET status = 'complete', value_json = ?, content = ?, citations_json = ?,
               error_json = NULL, error_code = NULL, completed_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          serialize(legacyValue),
          serialize(content),
          serialize(sourceRefs),
          now,
          now,
          cellId,
        );
      this.refreshStatus(cell.reviewId, now);
      const finished = finishJob(jobResult);
      if (finished.id !== cell.jobId) {
        throw new WorkspaceApiError(
          500,
          "INTERNAL_ERROR",
          "Tabular job state mismatch.",
        );
      }
      return this.requireCell(cellId);
    });
  }

  failCell(
    cellId: string,
    error: StructuredError,
    now: string,
    failJob: () => { id: string },
  ) {
    return this.transaction(() => {
      const cell = this.requireCell(cellId);
      if (cell.status !== "running" || !cell.jobId) {
        throw new WorkspaceApiError(
          409,
          "CONFLICT",
          "Tabular cell is not running.",
        );
      }
      const job = failJob();
      if (job.id !== cell.jobId) {
        throw new WorkspaceApiError(
          500,
          "INTERNAL_ERROR",
          "Tabular job state mismatch.",
        );
      }
      this.database
        .prepare(
          `UPDATE tabular_cells
           SET status = 'failed', value_json = NULL, content = NULL,
               citations_json = '[]', error_json = ?, error_code = ?,
               completed_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(serialize(error), error.code, now, now, cellId);
      this.refreshStatus(cell.reviewId, now);
      return this.requireCell(cellId);
    });
  }

  failClaimedCell(
    cellId: string,
    error: StructuredError,
    now: string,
    assertJob: () => { id: string },
    finishJob: (error: StructuredError) => { id: string },
  ) {
    return this.transaction(() => {
      const cell = this.requireCell(cellId);
      if (cell.status !== "running" || !cell.jobId) {
        throw new WorkspaceApiError(
          409,
          "CONFLICT",
          "Tabular cell is not running.",
        );
      }
      const asserted = assertJob();
      if (asserted.id !== cell.jobId) {
        throw new WorkspaceApiError(
          500,
          "INTERNAL_ERROR",
          "Tabular job state mismatch.",
        );
      }
      this.database
        .prepare(
          `UPDATE tabular_cells
           SET status = 'failed', value_json = NULL, content = NULL,
               citations_json = '[]', error_json = ?, error_code = ?,
               completed_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(serialize(error), error.code, now, now, cellId);
      this.refreshStatus(cell.reviewId, now);
      const finished = finishJob(error);
      if (finished.id !== cell.jobId) {
        throw new WorkspaceApiError(
          500,
          "INTERNAL_ERROR",
          "Tabular job state mismatch.",
        );
      }
      return this.requireCell(cellId);
    });
  }

  cancelReview(
    reviewId: string,
    now: string,
    cancelJobs: (jobIds: string[]) => void,
  ) {
    return this.transaction(() => {
      const detail = this.requireDetail(reviewId);
      if (
        ["complete", "cancelled", "archived"].includes(detail.review.status)
      ) {
        throw new WorkspaceApiError(
          409,
          "CONFLICT",
          "Tabular review cannot be cancelled.",
        );
      }
      const jobIds = detail.cells
        .filter(
          (cell) => ["queued", "running"].includes(cell.status) && cell.jobId,
        )
        .map((cell) => cell.jobId!);
      cancelJobs(jobIds);
      this.database
        .prepare(
          `UPDATE tabular_cells
           SET status = 'cancelled', completed_at = ?, updated_at = ?
           WHERE review_id = ? AND status IN ('empty', 'queued', 'running')`,
        )
        .run(now, now, reviewId);
      this.database
        .prepare(
          "UPDATE tabular_reviews SET status = 'cancelled', updated_at = ? WHERE id = ?",
        )
        .run(now, reviewId);
      return this.requireDetail(reviewId);
    });
  }

  cancelCell(
    input: {
      reviewId: string;
      cellId: string;
      now: string;
      reason: string;
    },
    cancelJob: (jobId: string) => void,
  ) {
    return this.transaction(() => {
      const review = this.require(input.reviewId);
      if (review.status === "archived") {
        throw new WorkspaceApiError(
          409,
          "CONFLICT",
          "Archived tabular cells cannot be cancelled.",
        );
      }
      const cell = this.requireCell(input.cellId);
      if (cell.reviewId !== input.reviewId) {
        throw new WorkspaceApiError(
          404,
          "NOT_FOUND",
          "Tabular cell not found.",
        );
      }
      if (cell.status !== "queued" && cell.status !== "running") {
        throw new WorkspaceApiError(
          409,
          "CONFLICT",
          "Tabular cell is not running.",
        );
      }
      if (!cell.jobId) {
        throw new WorkspaceApiError(
          500,
          "INTERNAL_ERROR",
          "Tabular cell job is unavailable.",
        );
      }
      cancelJob(cell.jobId);
      this.database
        .prepare(
          `UPDATE tabular_cells
              SET status = 'cancelled', value_json = NULL, content = NULL,
                  citations_json = '[]', error_json = NULL, error_code = NULL,
                  completed_at = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(input.now, input.now, input.cellId);
      this.refreshStatus(input.reviewId, input.now);
      return this.requireCell(input.cellId);
    });
  }

  clearCells(
    reviewId: string,
    documentIds: readonly string[],
    now: string,
    cancelJobs: (jobIds: string[]) => void,
  ) {
    return this.transaction(() => {
      const detail = this.requireDetail(reviewId);
      if (detail.review.status === "archived") {
        throw new WorkspaceApiError(
          409,
          "CONFLICT",
          "Archived tabular cells cannot be cleared.",
        );
      }
      const requested = new Set(documentIds);
      if (
        requested.size === 0 ||
        requested.size !== documentIds.length ||
        [...requested].some(
          (documentId) => !detail.review.documentIds.includes(documentId),
        )
      ) {
        throw new WorkspaceApiError(
          400,
          "VALIDATION_ERROR",
          "Clear-cell document ids are invalid.",
        );
      }
      const selected = detail.cells.filter((cell) =>
        requested.has(cell.documentId),
      );
      const activeJobIds = selected
        .filter(
          (cell) =>
            (cell.status === "queued" || cell.status === "running") &&
            cell.jobId,
        )
        .map((cell) => cell.jobId!);
      cancelJobs(activeJobIds);
      const placeholders = documentIds.map(() => "?").join(",");
      this.database
        .prepare(
          `UPDATE tabular_cells
              SET status = 'empty', value_json = NULL, content = NULL,
                  citations_json = '[]', error_json = NULL, error_code = NULL,
                  job_id = NULL, attempt = 0, completed_at = NULL,
                  updated_at = ?
            WHERE review_id = ?
              AND document_id IN (${placeholders})`,
        )
        .run(now, reviewId, ...documentIds);
      const active = this.database
        .prepare(
          `SELECT 1 AS present
             FROM tabular_cells
            WHERE review_id = ? AND status IN ('queued','running')
            LIMIT 1`,
        )
        .get(reviewId);
      this.database
        .prepare(
          "UPDATE tabular_reviews SET status = ?, updated_at = ? WHERE id = ?",
        )
        .run(active ? "running" : "ready", now, reviewId);
      return this.requireDetail(reviewId);
    });
  }

  /**
   * Repairs only cell projections after the shared job pump has durably
   * recovered stale claims. The job row remains the source of truth.
   */
  reconcileGenerationJobs(now: string) {
    return this.transaction(() => {
      const rows = this.database
        .prepare(
          `SELECT cell.id AS cell_id, cell.review_id, cell.status AS cell_status,
                  job.status AS job_status, job.error_code, job.retryable
             FROM tabular_cells cell
             LEFT JOIN jobs job ON job.id = cell.job_id
            WHERE cell.status IN ('queued','running')`,
        )
        .all();
      const reviewIds = new Set<string>();
      let repaired = 0;
      for (const row of rows) {
        const cellId = String(row.cell_id);
        const reviewId = String(row.review_id);
        const jobStatus =
          row.job_status == null ? null : String(row.job_status);
        if (jobStatus === "queued" || jobStatus === "running") {
          if (row.cell_status !== jobStatus) {
            this.database
              .prepare(
                "UPDATE tabular_cells SET status = ?, updated_at = ? WHERE id = ?",
              )
              .run(jobStatus, now, cellId);
            reviewIds.add(reviewId);
            repaired += 1;
          }
          continue;
        }
        if (jobStatus === "cancelled") {
          this.database
            .prepare(
              `UPDATE tabular_cells
                  SET status = 'cancelled', value_json = NULL, content = NULL,
                      citations_json = '[]', error_json = NULL,
                      error_code = NULL, completed_at = ?, updated_at = ?
                WHERE id = ?`,
            )
            .run(now, now, cellId);
        } else {
          const retryable =
            (jobStatus === "failed" || jobStatus === "interrupted") &&
            Number(row.retryable) === 1;
          const code =
            jobStatus === "interrupted"
              ? "tabular_generation_interrupted"
              : jobStatus === "failed" &&
                  typeof row.error_code === "string" &&
                  /^(?:tabular|workspace_job)_[a-z0-9_]{1,106}$/.test(
                    row.error_code,
                  )
                ? row.error_code
                : "tabular_job_state_inconsistent";
          const error: StructuredError = {
            code,
            message: retryable
              ? "Tabular generation was interrupted and can be retried."
              : "Tabular generation job ended inconsistently.",
            retryable,
            details: null,
          };
          this.database
            .prepare(
              `UPDATE tabular_cells
                  SET status = 'failed', value_json = NULL, content = NULL,
                      citations_json = '[]', error_json = ?, error_code = ?,
                      completed_at = ?, updated_at = ?
                WHERE id = ?`,
            )
            .run(serialize(error), error.code, now, now, cellId);
        }
        reviewIds.add(reviewId);
        repaired += 1;
      }
      for (const reviewId of reviewIds) this.refreshStatus(reviewId, now);
      return { inspected: rows.length, repaired };
    });
  }

  assertReviewScope(reviewId: string, projectId?: string | null) {
    const review = this.require(reviewId);
    if (projectId !== undefined && review.projectId !== projectId) {
      throw new WorkspaceApiError(
        404,
        "NOT_FOUND",
        "Tabular review not found.",
      );
    }
    return review;
  }

  listChats(reviewId: string): TabularChatRecord[] {
    this.require(reviewId);
    return this.database
      .prepare(
        `SELECT * FROM tabular_review_chats
          WHERE review_id = ?
          ORDER BY updated_at DESC, id DESC`,
      )
      .all(reviewId)
      .map(mapTabularChatV7);
  }

  getChat(reviewId: string, chatId: string): TabularChatRecord | null {
    this.require(reviewId);
    const row = this.database
      .prepare(
        `SELECT * FROM tabular_review_chats
          WHERE id = ? AND review_id = ?`,
      )
      .get(chatId, reviewId);
    return row ? mapTabularChatV7(row) : null;
  }

  createChat(input: {
    id: string;
    reviewId: string;
    userId: string | null;
    title?: string | null;
    jobId?: string | null;
    modelProfileId?: string | null;
    now: string;
  }): TabularChatRecord {
    this.require(input.reviewId);
    const hasMikeSemantics = this.hasColumn("tabular_review_chats", "user_id");
    const statement = this.database.prepare(
      hasMikeSemantics
        ? `INSERT INTO tabular_review_chats
            (id, review_id, title, user_id, job_id, model_profile_id,
             created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        : `INSERT INTO tabular_review_chats
            (id, review_id, title, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
    );
    statement.run(
      ...(hasMikeSemantics
        ? [
            input.id,
            input.reviewId,
            input.title ?? "",
            input.userId,
            input.jobId ?? null,
            input.modelProfileId ?? null,
            input.now,
            input.now,
          ]
        : [input.id, input.reviewId, input.title ?? "", input.now, input.now]),
    );
    const chat = this.getChat(input.reviewId, input.id);
    if (!chat)
      throw new WorkspaceApiError(
        500,
        "INTERNAL_ERROR",
        "Tabular chat was not persisted.",
      );
    return chat;
  }

  deleteChat(reviewId: string, chatId: string, userId?: string | null) {
    const chat = this.getChat(reviewId, chatId);
    if (!chat)
      throw new WorkspaceApiError(404, "NOT_FOUND", "Tabular chat not found.");
    if (userId && chat.userId && chat.userId !== userId) {
      throw new WorkspaceApiError(404, "NOT_FOUND", "Tabular chat not found.");
    }
    this.database
      .prepare(
        "DELETE FROM tabular_review_chats WHERE id = ? AND review_id = ?",
      )
      .run(chatId, reviewId);
  }

  listChatMessages(
    reviewId: string,
    chatId: string,
  ): TabularChatMessageRecord[] {
    if (!this.getChat(reviewId, chatId)) {
      throw new WorkspaceApiError(404, "NOT_FOUND", "Tabular chat not found.");
    }
    return this.database
      .prepare(
        `SELECT * FROM tabular_review_chat_messages
          WHERE review_chat_id = ?
          ORDER BY sequence ASC, created_at ASC, id ASC`,
      )
      .all(chatId)
      .map(mapTabularChatMessageV7);
  }

  appendChatMessage(input: {
    id: string;
    reviewId: string;
    chatId: string;
    role: "user" | "assistant" | "tool";
    content: unknown;
    annotations?: unknown[];
    sources?: TabularSourceRef[];
    status?: TabularChatMessageRecord["status"];
    jobId?: string | null;
    modelProfileId?: string | null;
    now: string;
  }): TabularChatMessageRecord {
    return this.transaction(() => {
      const detail = this.requireDetail(input.reviewId);
      if (!this.getChat(input.reviewId, input.chatId)) {
        throw new WorkspaceApiError(
          404,
          "NOT_FOUND",
          "Tabular chat not found.",
        );
      }
      const reviewDocuments = new Set(detail.review.documentIds);
      const sourceRefs = input.sources ?? [];
      for (const source of sourceRefs) {
        if (!reviewDocuments.has(source.documentId)) {
          throw new WorkspaceApiError(
            409,
            "CONFLICT",
            "Tabular chat sources must belong to the review.",
          );
        }
        this.assertSourceRefs(source.documentId, [source]);
      }
      const sequenceRow = this.database
        .prepare(
          `SELECT coalesce(max(sequence), -1) + 1 AS sequence
             FROM tabular_review_chat_messages
            WHERE review_chat_id = ?`,
        )
        .get(input.chatId);
      const sequence = Number(sequenceRow?.sequence ?? 0);
      const hasMikeSemantics = this.hasColumn(
        "tabular_review_chat_messages",
        "sources_json",
      );
      const statement = this.database.prepare(
        hasMikeSemantics
          ? `INSERT INTO tabular_review_chat_messages
              (id, review_chat_id, sequence, role, content, annotations_json,
               sources_json, status, job_id, model_profile_id, created_at,
               updated_at, completed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          : `INSERT INTO tabular_review_chat_messages
              (id, review_chat_id, sequence, role, content, annotations_json,
               status, created_at, updated_at, completed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const content =
        typeof input.content === "string"
          ? input.content
          : serialize(input.content);
      const annotations = serialize(input.annotations ?? []);
      const completedAt =
        input.status === undefined ||
        input.status === "complete" ||
        input.status === "failed" ||
        input.status === "cancelled" ||
        input.status === "interrupted"
          ? input.now
          : null;
      statement.run(
        ...(hasMikeSemantics
          ? [
              input.id,
              input.chatId,
              sequence,
              input.role,
              content,
              annotations,
              serialize(sourceRefs),
              input.status ?? "complete",
              input.jobId ?? null,
              input.modelProfileId ?? null,
              input.now,
              input.now,
              completedAt,
            ]
          : [
              input.id,
              input.chatId,
              sequence,
              input.role,
              content,
              annotations,
              input.status ?? "complete",
              input.now,
              input.now,
              completedAt,
            ]),
      );
      this.database
        .prepare("UPDATE tabular_review_chats SET updated_at = ? WHERE id = ?")
        .run(input.now, input.chatId);
      const row = this.database
        .prepare("SELECT * FROM tabular_review_chat_messages WHERE id = ?")
        .get(input.id);
      if (!row)
        throw new WorkspaceApiError(
          500,
          "INTERNAL_ERROR",
          "Tabular chat message was not persisted.",
        );
      return mapTabularChatMessageV7(row);
    });
  }

  getExportData(reviewId: string): TabularExportData {
    this.assertExportBudget(reviewId);
    const detail = this.requireDetail(reviewId);
    if (detail.review.documentIds.length === 0 || detail.columns.length === 0) {
      throw new WorkspaceApiError(
        412,
        "PRECONDITION_FAILED",
        "A tabular export requires persisted documents and columns.",
      );
    }
    const placeholders = detail.review.documentIds.map(() => "?").join(", ");
    const documents = this.database
      .prepare(`SELECT id, title FROM documents WHERE id IN (${placeholders})`)
      .all(...detail.review.documentIds);
    const titles = new Map(
      documents.map((document) => [
        String(document.id),
        String(document.title),
      ]),
    );
    const rows = detail.review.documentIds.map((documentId) => {
      const documentTitle = titles.get(documentId);
      if (documentTitle == null) {
        throw new WorkspaceApiError(
          500,
          "INTERNAL_ERROR",
          "Review document is unavailable.",
        );
      }
      return {
        documentId,
        documentTitle,
        cells: detail.cells.filter((cell) => cell.documentId === documentId),
      };
    });
    return { review: detail.review, columns: detail.columns, rows };
  }

  private assertExportBudget(reviewId: string) {
    const row = this.database
      .prepare(
        `SELECT
           coalesce((
             SELECT sum(length(document.title))
               FROM tabular_review_documents review_document
               JOIN documents document ON document.id = review_document.document_id
              WHERE review_document.review_id = ?
           ), 0) AS document_title_chars,
           coalesce((
             SELECT sum(length(title))
               FROM tabular_review_columns
              WHERE review_id = ?
           ), 0) AS column_title_chars,
           coalesce((
             SELECT sum(length(json_extract(content, '$.summary')))
               FROM tabular_cells
              WHERE review_id = ?
                AND status = 'complete'
                AND content IS NOT NULL
           ), 0) AS cell_summary_chars,
           (SELECT count(*) FROM tabular_cells WHERE review_id = ?) AS cell_count,
           (SELECT count(*) FROM tabular_review_columns WHERE review_id = ?) AS column_count`,
      )
      .get(reviewId, reviewId, reviewId, reviewId, reviewId) as
      | Record<string, unknown>
      | undefined;
    const textChars =
      Number(row?.document_title_chars ?? 0) +
      Number(row?.column_title_chars ?? 0) +
      Number(row?.cell_summary_chars ?? 0);
    const structuralBytes =
      (Number(row?.cell_count ?? 0) + Number(row?.column_count ?? 0) + 1) * 96;
    const estimatedBytes = textChars * 4 + structuralBytes;
    if (estimatedBytes > MAX_TABULAR_EXPORT_SOURCE_BYTES) {
      throw new WorkspaceApiError(
        413,
        "VALIDATION_ERROR",
        "Tabular export exceeds the local memory budget.",
      );
    }
  }

  private refreshStatus(reviewId: string, now: string) {
    const rows = this.database
      .prepare(
        "SELECT status, count(*) AS count FROM tabular_cells WHERE review_id = ? GROUP BY status",
      )
      .all(reviewId);
    const counts = new Map<TabularCellStatus, number>(
      rows.map((row) => [row.status as TabularCellStatus, Number(row.count)]),
    );
    const active = (counts.get("queued") ?? 0) + (counts.get("running") ?? 0);
    const status =
      active > 0
        ? "running"
        : (counts.get("failed") ?? 0) > 0
          ? "failed"
          : (counts.get("empty") ?? 0) > 0
            ? "ready"
            : (counts.get("cancelled") ?? 0) > 0
              ? "cancelled"
              : "complete";
    this.database
      .prepare(
        "UPDATE tabular_reviews SET status = ?, updated_at = ? WHERE id = ?",
      )
      .run(status, now, reviewId);
  }
}
