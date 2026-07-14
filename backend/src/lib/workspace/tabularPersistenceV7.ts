import { z } from "zod";

import {
  LegacyCellValueSchema,
  IsoDateTimeSchema,
  StructuredErrorSchema,
  TABULAR_CONTRACT_V7_MANIFEST,
  TabularCellRecordSchemaV7,
  TabularChatMessageRoleSchema,
  TabularChatMessageStatusSchema,
  TabularChatStatusSchema,
  TabularColumnFormatSchema,
  TabularColumnRecordSchemaV7,
  TabularReviewSchemaV7,
  TabularSourceRefSchema,
  TabularTagSchemaV7,
  WorkspaceIdSchema,
  formatForLegacyOutputType,
  normalizeTabularCellContent,
  parseTags,
  type LegacyTabularOutputType,
  type TabularCellContentOrNull,
  type TabularColumnFormat,
  type TabularCellV7,
  type TabularReviewV7,
} from "./tabularContractV7";
import type { WorkspaceDatabaseAdapter } from "./database";
import { WorkspaceApiError } from "./errors";
import {
  WORKSPACE_JOB_SELECT_COLUMNS,
  parseWorkspaceJobRowV7,
} from "./jobPersistenceV7";
import { JOB_CONTRACT_V7_MANIFEST } from "./jobContractV7";
import { WORKSPACE_PERSISTENCE_PRIMITIVES_V1_MANIFEST } from "./workspacePersistencePrimitivesV1";

type Row = Record<string, unknown>;

export { TabularSourceRefSchema } from "./tabularContractV7";
export type TabularSourceRef = z.infer<typeof TabularSourceRefSchema>;
export type TabularLegacyCellValue = string | boolean | number | null;
export type TabularColumnRecord = {
  id: string;
  reviewId: string;
  key: string;
  title: string;
  outputType: LegacyTabularOutputType;
  format: TabularColumnFormat;
  prompt: string;
  enumValues: string[] | null;
  tags: string[];
  ordinal: number;
  legacyMetadata: Record<string, unknown>;
};
export type TabularCellRecord = Omit<TabularCellV7, "outputType" | "value"> & {
  outputType: LegacyTabularOutputType;
  value: TabularLegacyCellValue;
  content: TabularCellContentOrNull;
  attempt: number;
  sourceRefs: TabularSourceRef[];
  completedAt: string | null;
};
export type TabularReviewDetail = {
  review: TabularReviewV7;
  columns: TabularColumnRecord[];
  cells: TabularCellRecord[];
};
export type TabularChatRecord = {
  id: string;
  reviewId: string;
  title: string | null;
  status: "active" | "archived";
  userId: string | null;
  jobId: string | null;
  modelProfileId: string | null;
  createdAt: string;
  updatedAt: string;
};
export type TabularChatMessageRecord = {
  id: string;
  chatId: string;
  role: "user" | "assistant" | "tool";
  content: unknown;
  annotations: unknown[];
  sources: TabularSourceRef[];
  status:
    | "pending"
    | "streaming"
    | "complete"
    | "failed"
    | "cancelled"
    | "interrupted";
  jobId: string | null;
  modelProfileId: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export function parseTabularJson<T>(
  value: unknown,
  schema: { parse(input: unknown): T },
  label: string,
): T {
  if (typeof value !== "string") {
    throw new WorkspaceApiError(
      500,
      "INTERNAL_ERROR",
      `Invalid persisted ${label}.`,
    );
  }
  try {
    return schema.parse(JSON.parse(value));
  } catch {
    throw new WorkspaceApiError(
      500,
      "INTERNAL_ERROR",
      `Invalid persisted ${label}.`,
    );
  }
}

export function optionalTabularJson<T>(
  value: unknown,
  schema: { parse(input: unknown): T },
  label: string,
) {
  return value == null ? null : parseTabularJson(value, schema, label);
}

function optionalRecordJson(value: unknown): Record<string, unknown> {
  if (value == null) return {};
  return parseTabularJson(
    value,
    z.record(z.string(), z.unknown()),
    "tabular legacy metadata",
  );
}

export function mapTabularReviewV7(
  row: Row,
  authoritativeDocumentIds: string[],
): TabularReviewV7 {
  const candidate = {
    id: String(row.id),
    projectId: row.project_id == null ? null : String(row.project_id),
    workflowId: row.workflow_id == null ? null : String(row.workflow_id),
    title: String(row.title),
    status: row.status,
    documentIds: WorkspaceIdSchema.array()
      .max(TABULAR_CONTRACT_V7_MANIFEST.limits.reviewDocuments)
      .parse(authoritativeDocumentIds),
    modelProfileId:
      row.model_profile_id == null ? null : String(row.model_profile_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
  try {
    return TabularReviewSchemaV7.parse(candidate);
  } catch {
    throw new WorkspaceApiError(
      500,
      "INTERNAL_ERROR",
      "Invalid persisted tabular review.",
    );
  }
}

export function mapTabularColumnV7(row: Row): TabularColumnRecord {
  const outputType = z
    .enum(TABULAR_CONTRACT_V7_MANIFEST.enums.outputTypes)
    .parse(row.output_type);
  const format = TabularColumnFormatSchema.parse(
    row.format == null ? formatForLegacyOutputType(outputType) : row.format,
  );
  const enumValues = optionalTabularJson(
    row.enum_values_json,
    z
      .array(TabularTagSchemaV7)
      .min(1)
      .max(TABULAR_CONTRACT_V7_MANIFEST.limits.tags),
    "tabular enum values",
  );
  const candidate = {
    id: String(row.id),
    reviewId: String(row.review_id),
    key: String(row.key),
    title: String(row.title),
    outputType,
    format,
    prompt: String(row.prompt),
    enumValues,
    tags:
      row.tags_json == null
        ? format === "tag"
          ? (enumValues ?? [])
          : []
        : parseTags(row.tags_json),
    ordinal: Number(row.ordinal),
    legacyMetadata: optionalRecordJson(row.legacy_metadata_json),
  };
  try {
    return TabularColumnRecordSchemaV7.parse(candidate);
  } catch {
    throw new WorkspaceApiError(
      500,
      "INTERNAL_ERROR",
      "Invalid persisted tabular column.",
    );
  }
}

function persistedCellContent(
  row: Row,
  value: TabularLegacyCellValue,
): TabularCellContentOrNull {
  if (row.content != null) {
    try {
      return normalizeTabularCellContent(row.content);
    } catch {
      throw new WorkspaceApiError(
        500,
        "INTERNAL_ERROR",
        "Invalid persisted tabular cell content.",
      );
    }
  }
  return normalizeTabularCellContent(value);
}

export function mapTabularCellV7(row: Row): TabularCellRecord {
  const outputType = z
    .enum(TABULAR_CONTRACT_V7_MANIFEST.enums.outputTypes)
    .parse(row.output_type);
  const value = optionalTabularJson(
    row.value_json,
    LegacyCellValueSchema,
    "tabular cell value",
  );
  const content = persistedCellContent(row, value);
  const candidate = {
    id: String(row.id),
    reviewId: String(row.review_id),
    documentId: String(row.document_id),
    columnId: String(row.column_id),
    outputType,
    value,
    content,
    status: row.status,
    error: optionalTabularJson(
      row.error_json,
      StructuredErrorSchema,
      "tabular cell error",
    ),
    jobId: row.job_id == null ? null : String(row.job_id),
    updatedAt: String(row.updated_at),
  };
  try {
    return {
      ...TabularCellRecordSchemaV7.parse(candidate),
      attempt: Number(row.attempt),
      sourceRefs: parseTabularJson(
        row.citations_json,
        TabularSourceRefSchema.array().max(
          TABULAR_CONTRACT_V7_MANIFEST.limits.sourceRefs,
        ),
        "tabular cell source references",
      ),
      completedAt: row.completed_at == null ? null : String(row.completed_at),
    };
  } catch (error) {
    if (error instanceof WorkspaceApiError) throw error;
    throw new WorkspaceApiError(
      500,
      "INTERNAL_ERROR",
      "Invalid persisted tabular cell.",
    );
  }
}

export function mapTabularChatV7(row: Row): TabularChatRecord {
  const status =
    row.status === "archived" || row.status === "active"
      ? TabularChatStatusSchema.parse(row.status)
      : "active";
  return {
    id: WorkspaceIdSchema.parse(String(row.id)),
    reviewId: WorkspaceIdSchema.parse(String(row.review_id)),
    title: row.title == null || row.title === "" ? null : String(row.title),
    status,
    userId: row.user_id == null ? null : String(row.user_id),
    jobId: row.job_id == null ? null : String(row.job_id),
    modelProfileId:
      row.model_profile_id == null ? null : String(row.model_profile_id),
    createdAt: IsoDateTimeSchema.parse(String(row.created_at)),
    updatedAt: IsoDateTimeSchema.parse(String(row.updated_at)),
  };
}

function parseMessageContent(value: unknown): unknown {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

export function mapTabularChatMessageV7(row: Row): TabularChatMessageRecord {
  const sources =
    row.sources_json == null
      ? []
      : parseTabularJson(
          row.sources_json,
          TabularSourceRefSchema.array().max(
            TABULAR_CONTRACT_V7_MANIFEST.limits.sourceRefs,
          ),
          "tabular chat message sources",
        );
  return {
    id: WorkspaceIdSchema.parse(String(row.id)),
    chatId: WorkspaceIdSchema.parse(String(row.review_chat_id)),
    role: TabularChatMessageRoleSchema.parse(row.role),
    content: parseMessageContent(row.content),
    annotations: parseTabularJson(
      row.annotations_json,
      z
        .array(z.unknown())
        .max(TABULAR_CONTRACT_V7_MANIFEST.limits.chatAnnotations),
      "tabular chat message annotations",
    ),
    sources,
    status: TabularChatMessageStatusSchema.parse(row.status),
    jobId: row.job_id == null ? null : String(row.job_id),
    modelProfileId:
      row.model_profile_id == null ? null : String(row.model_profile_id),
    createdAt: IsoDateTimeSchema.parse(String(row.created_at)),
    updatedAt: IsoDateTimeSchema.parse(String(row.updated_at)),
    completedAt: row.completed_at == null ? null : String(row.completed_at),
  };
}

export function assertTabularSourceRefsV7(
  database: WorkspaceDatabaseAdapter,
  documentId: string,
  sourceRefs: TabularSourceRef[],
  persisted = false,
) {
  const invalid = (): never => {
    throw new WorkspaceApiError(
      persisted ? 500 : 409,
      persisted ? "INTERNAL_ERROR" : "CONFLICT",
      persisted
        ? "Persisted tabular cell source references are invalid."
        : "Tabular cell source references are invalid.",
    );
  };
  const document = database
    .prepare("SELECT id FROM documents WHERE id = ? AND deleted_at IS NULL")
    .get(documentId);
  if (!document) invalid();
  for (const source of sourceRefs) {
    if (source.documentId !== documentId) invalid();
    if (source.versionId == null) continue;
    const version = database
      .prepare(
        `SELECT id FROM document_versions
          WHERE id = ? AND document_id = ? AND deleted_at IS NULL`,
      )
      .get(source.versionId, documentId);
    if (!version) invalid();
    if (source.chunkId == null) {
      if (source.startOffset != null) {
        const bounds = database
          .prepare(
            `SELECT min(start_offset) AS start_offset,
                    max(end_offset) AS end_offset
               FROM document_chunks
              WHERE document_id = ? AND version_id = ?`,
          )
          .get(documentId, source.versionId);
        if (
          bounds?.start_offset == null ||
          bounds?.end_offset == null ||
          source.startOffset < Number(bounds.start_offset) ||
          source.endOffset! > Number(bounds.end_offset)
        ) {
          invalid();
        }
      }
      continue;
    }
    const chunk = database
      .prepare(
        `SELECT start_offset, end_offset FROM document_chunks
          WHERE id = ? AND document_id = ? AND version_id = ?`,
      )
      .get(source.chunkId, documentId, source.versionId) as
      | { start_offset: unknown; end_offset: unknown }
      | undefined;
    if (!chunk) {
      invalid();
    } else if (
      source.startOffset != null &&
      (source.startOffset < Number(chunk.start_offset) ||
        source.endOffset! > Number(chunk.end_offset))
    ) {
      invalid();
    }
  }
}

export const TABULAR_PERSISTED_V7_CONTRACT = {
  version: "tabular-persisted-v7-frozen-parser-2",
  primitives: WORKSPACE_PERSISTENCE_PRIMITIVES_V1_MANIFEST,
  tabular: TABULAR_CONTRACT_V7_MANIFEST,
  jobs: JOB_CONTRACT_V7_MANIFEST,
  persistedPolicies: {
    parserModules: [
      "workspace/tabularPersistenceV7",
      "workspace/jobPersistenceV7",
    ],
    legacyCellValues: {
      finiteNumbersOnly: true,
      sqliteInfinityRepair:
        "preserve_legacy_content_clear_value_mark_failed_manual_review",
    },
    sourceRefs: {
      activeDocument: true,
      activeVersion: true,
      chunkBounds: true,
      duplicateJsonKeysRejectedByMigration: true,
    },
    tabularJobs: {
      legacyPayloadProjection: {},
      completeResultProjection: {},
      nonCompleteResultProjection: null,
      terminalErrorCode: "workspace_migration_tabular_regeneration_required",
    },
  },
} as const;

export const TABULAR_PERSISTENCE_VALIDATOR_FINGERPRINT = JSON.stringify(
  TABULAR_PERSISTED_V7_CONTRACT,
);

function persistedRows(
  database: WorkspaceDatabaseAdapter,
  sql: string,
  ...parameters: unknown[]
): Row[] {
  return database.prepare(sql).all(...parameters) as Row[];
}

function persistedDocumentIds(
  database: WorkspaceDatabaseAdapter,
  reviewId: string,
) {
  return database
    .prepare(
      `SELECT document_id FROM tabular_review_documents
        WHERE review_id = ?
        ORDER BY ordinal ASC, document_id ASC`,
    )
    .all(reviewId)
    .map((row) => String(row.document_id));
}

function validatePersistedDetailV7(
  database: WorkspaceDatabaseAdapter,
  columns: TabularColumnRecord[],
  cells: TabularCellRecord[],
  reviewDocumentIds: readonly string[],
): void {
  if (cells.length !== columns.length * reviewDocumentIds.length) {
    throw new Error("Persisted tabular matrix is incomplete.");
  }
  const columnsById = new Map(columns.map((column) => [column.id, column]));
  const reviewDocuments = new Set(reviewDocumentIds);
  for (const cell of cells) {
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
    assertTabularSourceRefsV7(database, cell.documentId, cell.sourceRefs, true);
    if (
      !column ||
      column.outputType !== cell.outputType ||
      !reviewDocuments.has(cell.documentId) ||
      !validEnum ||
      !validCompletion ||
      !validFailure
    ) {
      throw new Error(
        "Persisted tabular cell violates its review configuration.",
      );
    }
  }
}

function validatePersistedReviewsV7(database: WorkspaceDatabaseAdapter): void {
  for (const row of persistedRows(
    database,
    "SELECT * FROM tabular_reviews ORDER BY id ASC",
  )) {
    const documentIds = persistedDocumentIds(database, String(row.id));
    const review = mapTabularReviewV7(row, documentIds);
    const columns = persistedRows(
      database,
      `SELECT * FROM tabular_review_columns
        WHERE review_id = ?
        ORDER BY ordinal ASC, id ASC`,
      String(row.id),
    ).map(mapTabularColumnV7);
    const cells = persistedRows(
      database,
      `SELECT * FROM tabular_cells
        WHERE review_id = ?`,
      String(row.id),
    ).map(mapTabularCellV7);
    validatePersistedDetailV7(database, columns, cells, review.documentIds);
  }
}

function validatePersistedChatsV7(database: WorkspaceDatabaseAdapter): void {
  for (const chatRow of persistedRows(
    database,
    `SELECT * FROM tabular_review_chats
      ORDER BY review_id ASC, id ASC`,
  )) {
    const chat = mapTabularChatV7(chatRow);
    const messages = persistedRows(
      database,
      `SELECT * FROM tabular_review_chat_messages
        WHERE review_chat_id = ?
        ORDER BY created_at ASC, id ASC`,
      chat.id,
    ).map(mapTabularChatMessageV7);
    for (const message of messages) {
      for (const source of message.sources) {
        assertTabularSourceRefsV7(database, source.documentId, [source], true);
      }
    }
  }
}

function validatePersistedTabularJobsV7(
  database: WorkspaceDatabaseAdapter,
): void {
  for (const row of persistedRows(
    database,
    `SELECT ${WORKSPACE_JOB_SELECT_COLUMNS}
       FROM jobs
      WHERE type = 'tabular_cell'
      ORDER BY id ASC`,
  )) {
    parseWorkspaceJobRowV7(row);
  }
}

export function validateTabularPersistenceV7(
  database: WorkspaceDatabaseAdapter,
): void {
  validatePersistedReviewsV7(database);
  validatePersistedChatsV7(database);
  validatePersistedTabularJobsV7(database);
}
