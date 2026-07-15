/**
 * Vera's local Tabular Review transport.
 *
 * Direct/adapt provenance: Open-Legal-Products/mike
 * e32daad5a4c64a5561e04c53ee12411e3c5e7238
 * frontend/src/app/lib/mikeApi.ts (Tabular Review section).
 *
 * AGPL-3.0-only. The Mike wire shape is retained, while every response is
 * validated before it can enter React state. No credential, provider payload,
 * or local filesystem path is part of this boundary.
 */

import {
  veraApiBlobRequest,
  VeraApiError,
  veraApiRequest,
  type VeraBlobResponse,
} from "./veraApi";
import { VeraRuntimeConfigurationError } from "./veraRuntime";
import { streamVeraSse, VeraSseProtocolError } from "./veraSse";
import type { VeraDocumentWire, VeraFileTypeWire } from "./veraWireTypes";

export const VERA_TABULAR_FORMATS = [
  "text",
  "bulleted_list",
  "number",
  "percentage",
  "monetary_amount",
  "currency",
  "yes_no",
  "date",
  "tag",
] as const;

export const VERA_TABULAR_REVIEW_STATUSES = [
  "draft",
  "ready",
  "running",
  "complete",
  "failed",
  "cancelled",
  "archived",
] as const;

export const VERA_TABULAR_CELL_STATUSES = [
  "pending",
  "generating",
  "done",
  "error",
] as const;

export type VeraTabularFormat = (typeof VERA_TABULAR_FORMATS)[number];
export type VeraTabularReviewStatus =
  (typeof VERA_TABULAR_REVIEW_STATUSES)[number];
export type VeraTabularCellStatus =
  (typeof VERA_TABULAR_CELL_STATUSES)[number];

export interface VeraTabularColumn {
  index: number;
  name: string;
  prompt: string;
  format: VeraTabularFormat;
  tags: string[];
}

export interface VeraTabularReview {
  id: string;
  project_id: string | null;
  user_id: string;
  title: string;
  columns_config: VeraTabularColumn[];
  document_ids: string[];
  workflow_id: string | null;
  model_profile_id: string | null;
  status: VeraTabularReviewStatus;
  practice: string | null;
  shared_with: string[];
  is_owner: boolean;
  created_at: string;
  updated_at: string;
  document_count: number;
}

export type VeraTabularErrorDetail = string | number | boolean | null;

export interface VeraTabularStructuredError {
  code: string;
  message: string;
  retryable: boolean;
  details: Record<string, VeraTabularErrorDetail> | null;
}

export interface VeraTabularSource {
  document_id: string;
  version_id: string | null;
  chunk_id: string | null;
  quote: string | null;
  start_offset: number | null;
  end_offset: number | null;
  page_start: number | null;
  page_end: number | null;
}

export interface VeraTabularCellContent {
  summary: string;
  flag?: "green" | "grey" | "yellow" | "red";
  reasoning?: string;
}

export interface VeraTabularCell {
  id: string;
  review_id: string;
  document_id: string;
  column_index: number;
  content: VeraTabularCellContent | null;
  status: VeraTabularCellStatus;
  error: VeraTabularStructuredError | null;
  sources: VeraTabularSource[];
  attempt: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface VeraTabularReviewDetail {
  review: VeraTabularReview;
  cells: VeraTabularCell[];
  documents: VeraDocumentWire[];
}

export interface VeraTabularCapabilities {
  generation: boolean;
  chat: boolean;
}

export interface VeraTabularReviewCreateInput {
  title: string;
  project_id: string;
  document_ids: string[];
  columns_config: VeraTabularColumn[];
  model_profile_id: string;
  workflow_id?: string | null;
}

export interface VeraTabularReviewUpdateInput {
  title?: string;
  project_id?: string | null;
  document_ids?: string[];
  columns_config?: VeraTabularColumn[];
  model_profile_id?: string | null;
}

type WireRecord = Record<string, unknown>;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const LOCAL_PATH_PATTERN =
  /(?:^|[\s"'(])(?:\/[Uu]sers\/|\/home\/|\/private\/|[A-Za-z]:\\|file:\/\/)/;
const SECRET_TEXT_PATTERN =
  /(?:bearer\s+)[a-z0-9._~+/=-]{8,}|\b(?:sk|key)-[a-z0-9_-]{8,}\b|\beyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+\b/i;
const MAX_SAFE_DEPTH = 32;
const MAX_SAFE_NODES = 150_000;
const MAX_REVIEWS = 10_000;
const MAX_DOCUMENTS = 1_000;
const MAX_COLUMNS = 100;
const MAX_CELLS = 10_000;

function invalid(label: string): never {
  throw new VeraApiError({
    status: 200,
    code: "INVALID_RESPONSE",
    message: `The Vera API returned invalid ${label}.`,
  });
}

function normalizedKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toLowerCase();
}

function isSensitiveKey(key: string): boolean {
  const normalized = normalizedKey(key);
  return (
    normalized === "secret" ||
    normalized.endsWith("_secret") ||
    normalized === "api_key" ||
    normalized.endsWith("_api_key") ||
    normalized === "access_token" ||
    normalized === "authorization" ||
    normalized.includes("credential_ref") ||
    normalized === "credential" ||
    normalized === "local_path" ||
    normalized === "absolute_path" ||
    normalized === "file_path" ||
    normalized === "raw_provider" ||
    normalized.startsWith("raw_provider_") ||
    normalized === "provider_response" ||
    normalized === "provider_payload" ||
    normalized === "provider_event"
  );
}

/** Reject unsafe fields and values before retaining any Tabular response. */
export function assertNoVeraTabularSensitiveFields(value: unknown): void {
  const ancestors = new Set<object>();
  let nodes = 0;
  const visit = (candidate: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > MAX_SAFE_NODES || depth > MAX_SAFE_DEPTH) {
      invalid("Tabular response");
    }
    if (typeof candidate === "string") {
      if (
        candidate.length > 1_000_000 ||
        LOCAL_PATH_PATTERN.test(candidate) ||
        SECRET_TEXT_PATTERN.test(candidate)
      ) {
        invalid("Tabular response");
      }
      return;
    }
    if (typeof candidate !== "object" || candidate === null) return;
    if (ancestors.has(candidate)) invalid("Tabular response");
    ancestors.add(candidate);
    if (Array.isArray(candidate)) {
      candidate.forEach((item) => visit(item, depth + 1));
      ancestors.delete(candidate);
      return;
    }
    for (const [key, nested] of Object.entries(candidate)) {
      if (isSensitiveKey(key)) invalid("Tabular response");
      if (key === "storage_path" && nested !== null) {
        invalid("Tabular document response");
      }
      if (
        key === "pdf_storage_path" &&
        nested !== null &&
        nested !== "local-preview"
      ) {
        invalid("Tabular document response");
      }
      visit(nested, depth + 1);
    }
    ancestors.delete(candidate);
  };
  visit(value, 0);
}

function record(value: unknown, label: string): WireRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid(label);
  }
  return value as WireRecord;
}

function exactKeys(
  value: WireRecord,
  required: readonly string[],
  optional: readonly string[] = [],
  label = "Tabular response",
): void {
  const actual = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    actual.some((key) => !allowed.has(key))
  ) {
    invalid(label);
  }
}

function stringValue(
  value: unknown,
  label: string,
  options: { min?: number; max?: number; trim?: boolean } = {},
): string {
  if (typeof value !== "string") return invalid(label);
  const candidate = options.trim ? value.trim() : value;
  if (
    candidate.length < (options.min ?? 0) ||
    candidate.length > (options.max ?? 100_000)
  ) {
    return invalid(label);
  }
  return candidate;
}

function nullableString(
  value: unknown,
  label: string,
  max = 100_000,
): string | null {
  return value === null ? null : stringValue(value, label, { max });
}

function uuid(value: unknown, label: string): string {
  const parsed = stringValue(value, label, { min: 1, max: 64 });
  if (!UUID_PATTERN.test(parsed)) return invalid(label);
  return parsed;
}

function nullableUuid(value: unknown, label: string): string | null {
  return value === null ? null : uuid(value, label);
}

function timestamp(value: unknown, label: string): string {
  const parsed = stringValue(value, label, { min: 1, max: 32 });
  if (!ISO_PATTERN.test(parsed) || !Number.isFinite(Date.parse(parsed))) {
    return invalid(label);
  }
  return parsed;
}

function nullableTimestamp(value: unknown, label: string): string | null {
  return value === null ? null : timestamp(value, label);
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
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    return invalid(label);
  }
  return value;
}

function nullableInteger(
  value: unknown,
  label: string,
  minimum = 0,
): number | null {
  return value === null ? null : integer(value, label, minimum);
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  options: T,
  label: string,
): T[number] {
  if (typeof value !== "string" || !options.includes(value)) {
    return invalid(label);
  }
  return value as T[number];
}

function uuidArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_DOCUMENTS) {
    return invalid(label);
  }
  const ids = value.map((item) => uuid(item, label));
  if (new Set(ids).size !== ids.length) invalid(label);
  return ids;
}

export function parseVeraTabularColumn(
  value: unknown,
): VeraTabularColumn {
  const wire = record(value, "Tabular column");
  exactKeys(
    wire,
    ["index", "name", "prompt", "format", "tags"],
    [],
    "Tabular column",
  );
  const format = enumValue(wire.format, VERA_TABULAR_FORMATS, "Tabular format");
  if (!Array.isArray(wire.tags) || wire.tags.length > 100) {
    return invalid("Tabular column tags");
  }
  const tags = wire.tags.map((tag) =>
    stringValue(tag, "Tabular column tag", {
      min: 1,
      max: 160,
      trim: true,
    }),
  );
  if (new Set(tags).size !== tags.length) invalid("Tabular column tags");
  if (format === "tag" && tags.length === 0) {
    invalid("Tabular tag column");
  }
  if (format !== "tag" && tags.length !== 0) {
    invalid("Tabular column tags");
  }
  return {
    index: integer(wire.index, "Tabular column index", 0, 99),
    name: stringValue(wire.name, "Tabular column name", {
      min: 1,
      max: 240,
      trim: true,
    }),
    prompt: stringValue(wire.prompt, "Tabular column prompt", {
      max: 20_000,
    }),
    format,
    tags,
  };
}

export function parseVeraTabularReview(
  value: unknown,
): VeraTabularReview {
  assertNoVeraTabularSensitiveFields(value);
  const wire = record(value, "Tabular review");
  exactKeys(
    wire,
    [
      "id",
      "project_id",
      "user_id",
      "title",
      "columns_config",
      "document_ids",
      "workflow_id",
      "model_profile_id",
      "status",
      "practice",
      "shared_with",
      "is_owner",
      "created_at",
      "updated_at",
      "document_count",
    ],
    [],
    "Tabular review",
  );
  if (!Array.isArray(wire.columns_config) || wire.columns_config.length > MAX_COLUMNS) {
    return invalid("Tabular review columns");
  }
  const columns = wire.columns_config.map(parseVeraTabularColumn);
  const indexes = columns.map((column) => column.index);
  if (
    new Set(indexes).size !== indexes.length ||
    indexes.some((index, position) => index !== position)
  ) {
    invalid("Tabular review columns");
  }
  const documentIds = uuidArray(wire.document_ids, "Tabular document ids");
  if (documentIds.length * columns.length > MAX_CELLS) {
    invalid("Tabular review matrix");
  }
  const documentCount = integer(
    wire.document_count,
    "Tabular document count",
    0,
    MAX_DOCUMENTS,
  );
  if (documentCount !== documentIds.length) {
    invalid("Tabular document count");
  }
  if (!Array.isArray(wire.shared_with) || wire.shared_with.length !== 0) {
    invalid("Tabular local sharing projection");
  }
  return {
    id: uuid(wire.id, "Tabular review id"),
    project_id: nullableUuid(wire.project_id, "Tabular project id"),
    user_id: uuid(wire.user_id, "Tabular user id"),
    title: stringValue(wire.title, "Tabular review title", {
      min: 1,
      max: 240,
      trim: true,
    }),
    columns_config: columns,
    document_ids: documentIds,
    workflow_id: nullableUuid(wire.workflow_id, "Tabular workflow id"),
    model_profile_id: nullableUuid(
      wire.model_profile_id,
      "Tabular model profile id",
    ),
    status: enumValue(
      wire.status,
      VERA_TABULAR_REVIEW_STATUSES,
      "Tabular review status",
    ),
    practice: nullableString(wire.practice, "Tabular practice", 160),
    shared_with: [],
    is_owner: booleanValue(wire.is_owner, "Tabular ownership"),
    created_at: timestamp(wire.created_at, "Tabular created timestamp"),
    updated_at: timestamp(wire.updated_at, "Tabular updated timestamp"),
    document_count: documentCount,
  };
}

function parseStructuredError(value: unknown): VeraTabularStructuredError {
  const wire = record(value, "Tabular cell error");
  exactKeys(
    wire,
    ["code", "message", "retryable", "details"],
    [],
    "Tabular cell error",
  );
  let details: Record<string, VeraTabularErrorDetail> | null = null;
  if (wire.details !== null) {
    const source = record(wire.details, "Tabular error details");
    if (Object.keys(source).length > 100) invalid("Tabular error details");
    details = Object.fromEntries(
      Object.entries(source).map(([key, item]) => {
        if (
          item !== null &&
          typeof item !== "string" &&
          typeof item !== "number" &&
          typeof item !== "boolean"
        ) {
          invalid("Tabular error details");
        }
        if (typeof item === "number" && !Number.isFinite(item)) {
          invalid("Tabular error details");
        }
        return [
          stringValue(key, "Tabular error detail key", { min: 1, max: 120 }),
          item as VeraTabularErrorDetail,
        ];
      }),
    );
  }
  return {
    code: stringValue(wire.code, "Tabular error code", {
      min: 1,
      max: 120,
    }),
    message: stringValue(wire.message, "Tabular error message", {
      min: 1,
      max: 20_000,
    }),
    retryable: booleanValue(wire.retryable, "Tabular retryability"),
    details,
  };
}

function parseCellContent(value: unknown): VeraTabularCellContent {
  const wire = record(value, "Tabular cell content");
  exactKeys(
    wire,
    ["summary"],
    ["flag", "reasoning"],
    "Tabular cell content",
  );
  const content: VeraTabularCellContent = {
    summary: stringValue(wire.summary, "Tabular cell summary", {
      max: 100_000,
    }),
  };
  if (Object.hasOwn(wire, "flag")) {
    content.flag = enumValue(
      wire.flag,
      ["green", "grey", "yellow", "red"] as const,
      "Tabular cell flag",
    );
  }
  if (Object.hasOwn(wire, "reasoning")) {
    content.reasoning = stringValue(
      wire.reasoning,
      "Tabular cell reasoning",
      { max: 100_000 },
    );
  }
  return content;
}

function parseSource(value: unknown): VeraTabularSource {
  const wire = record(value, "Tabular source");
  exactKeys(
    wire,
    [
      "document_id",
      "version_id",
      "chunk_id",
      "quote",
      "start_offset",
      "end_offset",
      "page_start",
      "page_end",
    ],
    [],
    "Tabular source",
  );
  const startOffset = nullableInteger(
    wire.start_offset,
    "Tabular source start offset",
  );
  const endOffset = nullableInteger(
    wire.end_offset,
    "Tabular source end offset",
  );
  const pageStart = nullableInteger(wire.page_start, "Tabular source page", 1);
  const pageEnd = nullableInteger(wire.page_end, "Tabular source page", 1);
  if (
    (startOffset === null) !== (endOffset === null) ||
    (startOffset !== null && endOffset !== null && endOffset < startOffset) ||
    (pageStart === null) !== (pageEnd === null) ||
    (pageStart !== null && pageEnd !== null && pageEnd < pageStart) ||
    ((wire.chunk_id !== null || startOffset !== null) &&
      wire.version_id === null) ||
    ((pageStart !== null || pageEnd !== null) && wire.chunk_id === null)
  ) {
    invalid("Tabular source range");
  }
  return {
    document_id: uuid(wire.document_id, "Tabular source document id"),
    version_id: nullableUuid(wire.version_id, "Tabular source version id"),
    chunk_id: nullableUuid(wire.chunk_id, "Tabular source chunk id"),
    quote: nullableString(wire.quote, "Tabular source quote", 8_000),
    start_offset: startOffset,
    end_offset: endOffset,
    page_start: pageStart,
    page_end: pageEnd,
  };
}

export function parseVeraTabularCell(value: unknown): VeraTabularCell {
  assertNoVeraTabularSensitiveFields(value);
  const wire = record(value, "Tabular cell");
  exactKeys(
    wire,
    [
      "id",
      "review_id",
      "document_id",
      "column_index",
      "content",
      "status",
      "error",
      "sources",
      "attempt",
      "created_at",
      "updated_at",
      "completed_at",
    ],
    [],
    "Tabular cell",
  );
  if (!Array.isArray(wire.sources) || wire.sources.length > 1_000) {
    return invalid("Tabular cell sources");
  }
  const documentId = uuid(wire.document_id, "Tabular cell document id");
  const sources = wire.sources.map(parseSource);
  if (sources.some((source) => source.document_id !== documentId)) {
    invalid("Tabular cell sources");
  }
  const status = enumValue(
    wire.status,
    VERA_TABULAR_CELL_STATUSES,
    "Tabular cell status",
  );
  const content = wire.content === null ? null : parseCellContent(wire.content);
  const error = wire.error === null ? null : parseStructuredError(wire.error);
  const completedAt = nullableTimestamp(
    wire.completed_at,
    "Tabular completed timestamp",
  );
  if (
    (status === "done" && (content === null || completedAt === null || error)) ||
    (status === "error" && error === null) ||
    ((status === "pending" || status === "generating") && error !== null)
  ) {
    invalid("Tabular cell state");
  }
  return {
    id: uuid(wire.id, "Tabular cell id"),
    review_id: uuid(wire.review_id, "Tabular cell review id"),
    document_id: documentId,
    column_index: integer(wire.column_index, "Tabular column index", 0, 99),
    content,
    status,
    error,
    sources,
    attempt: integer(wire.attempt, "Tabular cell attempt", 0, 100),
    created_at: timestamp(wire.created_at, "Tabular cell created timestamp"),
    updated_at: timestamp(wire.updated_at, "Tabular cell updated timestamp"),
    completed_at: completedAt,
  };
}

const FILE_TYPES = new Set<VeraFileTypeWire>([
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
]);

function parseDocument(value: unknown): VeraDocumentWire {
  const wire = record(value, "Tabular document");
  exactKeys(
    wire,
    [
      "id",
      "user_id",
      "project_id",
      "folder_id",
      "filename",
      "owner_email",
      "owner_display_name",
      "file_type",
      "storage_path",
      "pdf_storage_path",
      "size_bytes",
      "page_count",
      "structure_tree",
      "status",
      "created_at",
      "updated_at",
      "active_version_number",
      "latest_version_number",
    ],
    [],
    "Tabular document",
  );
  const fileType =
    wire.file_type === null
      ? null
      : enumValue(
          wire.file_type,
          [...FILE_TYPES] as VeraFileTypeWire[],
          "Tabular document file type",
        );
  if (
    wire.owner_email !== null ||
    wire.storage_path !== null ||
    wire.structure_tree !== null ||
    (wire.pdf_storage_path !== null && wire.pdf_storage_path !== "local-preview")
  ) {
    invalid("Tabular document projection");
  }
  return {
    id: uuid(wire.id, "Tabular document id"),
    user_id: uuid(wire.user_id, "Tabular document user id"),
    project_id: nullableUuid(wire.project_id, "Tabular document project id"),
    folder_id: nullableUuid(wire.folder_id, "Tabular document folder id"),
    filename: stringValue(wire.filename, "Tabular document filename", {
      min: 1,
      max: 500,
    }),
    owner_email: null,
    owner_display_name: nullableString(
      wire.owner_display_name,
      "Tabular document owner name",
      240,
    ),
    file_type: fileType,
    storage_path: null,
    pdf_storage_path: wire.pdf_storage_path as "local-preview" | null,
    size_bytes: nullableInteger(wire.size_bytes, "Tabular document size"),
    page_count: nullableInteger(wire.page_count, "Tabular document pages"),
    structure_tree: null,
    status: enumValue(
      wire.status,
      ["pending", "processing", "ready", "error"] as const,
      "Tabular document status",
    ),
    created_at: nullableTimestamp(
      wire.created_at,
      "Tabular document created timestamp",
    ),
    updated_at: nullableTimestamp(
      wire.updated_at,
      "Tabular document updated timestamp",
    ),
    active_version_number: nullableInteger(
      wire.active_version_number,
      "Tabular document active version",
    ),
    latest_version_number: nullableInteger(
      wire.latest_version_number,
      "Tabular document latest version",
    ),
  };
}

export function parseVeraTabularReviewDetail(
  value: unknown,
): VeraTabularReviewDetail {
  assertNoVeraTabularSensitiveFields(value);
  const wire = record(value, "Tabular review detail");
  exactKeys(
    wire,
    ["review", "cells", "documents"],
    [],
    "Tabular review detail",
  );
  const review = parseVeraTabularReview(wire.review);
  if (
    !Array.isArray(wire.cells) ||
    wire.cells.length > MAX_CELLS ||
    !Array.isArray(wire.documents) ||
    wire.documents.length > MAX_DOCUMENTS
  ) {
    return invalid("Tabular review detail");
  }
  const cells = wire.cells.map(parseVeraTabularCell);
  const documents = wire.documents.map(parseDocument);
  const documentIds = new Set(review.document_ids);
  const columnIndexes = new Set(
    review.columns_config.map((column) => column.index),
  );
  if (
    documents.length !== review.document_ids.length ||
    documents.some(
      (document, index) => document.id !== review.document_ids[index],
    ) ||
    new Set(documents.map((document) => document.id)).size !== documents.length ||
    documents.some(
      (document) =>
        !documentIds.has(document.id) ||
        (review.project_id !== null && document.project_id !== review.project_id),
    ) ||
    cells.length !== review.document_ids.length * review.columns_config.length ||
    new Set(
      cells.map((cell) => `${cell.document_id}:${cell.column_index}`),
    ).size !== cells.length ||
    cells.some(
      (cell) =>
        cell.review_id !== review.id ||
        !documentIds.has(cell.document_id) ||
        !columnIndexes.has(cell.column_index),
    )
  ) {
    invalid("Tabular review matrix");
  }
  return { review, cells, documents };
}

export function parseVeraTabularCapabilities(
  value: unknown,
): VeraTabularCapabilities {
  assertNoVeraTabularSensitiveFields(value);
  const wire = record(value, "Tabular capabilities");
  exactKeys(
    wire,
    ["generation", "chat"],
    [],
    "Tabular capabilities",
  );
  return {
    generation: booleanValue(wire.generation, "Tabular generation capability"),
    chat: booleanValue(wire.chat, "Tabular chat capability"),
  };
}

function safeId(value: string, label: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw new VeraRuntimeConfigurationError(`The Vera ${label} is invalid.`);
  }
  return value;
}

function safeColumns(value: VeraTabularColumn[]): VeraTabularColumn[] {
  if (!Array.isArray(value) || value.length > MAX_COLUMNS) {
    throw new VeraRuntimeConfigurationError(
      "The Vera Tabular columns are invalid.",
    );
  }
  const columns = value.map((column) => parseVeraTabularColumn(column));
  if (columns.some((column, index) => column.index !== index)) {
    throw new VeraRuntimeConfigurationError(
      "The Vera Tabular column indexes are invalid.",
    );
  }
  return columns;
}

function sameIds(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function sameColumns(
  left: VeraTabularColumn[],
  right: VeraTabularColumn[],
): boolean {
  return (
    left.length === right.length &&
    left.every((column, index) => {
      const candidate = right[index];
      return (
        candidate !== undefined &&
        column.index === candidate.index &&
        column.name === candidate.name &&
        column.prompt === candidate.prompt &&
        column.format === candidate.format &&
        sameIds(column.tags, candidate.tags)
      );
    })
  );
}

function safeDocumentIds(value: string[]): string[] {
  if (!Array.isArray(value) || value.length > MAX_DOCUMENTS) {
    throw new VeraRuntimeConfigurationError(
      "The Vera Tabular documents are invalid.",
    );
  }
  const ids = value.map((id) => safeId(id, "Tabular document id"));
  if (new Set(ids).size !== ids.length) {
    throw new VeraRuntimeConfigurationError(
      "The Vera Tabular documents are invalid.",
    );
  }
  return ids;
}

function safeTitle(value: string): string {
  const title = value.trim();
  if (!title || title.length > 240) {
    throw new VeraRuntimeConfigurationError(
      "The Vera Tabular title is invalid.",
    );
  }
  return title;
}

export async function listVeraTabularReviews(
  projectId?: string,
  signal?: AbortSignal,
): Promise<VeraTabularReview[]> {
  const value = await veraApiRequest<unknown>("/tabular-review", {
    query: projectId
      ? { project_id: safeId(projectId, "Tabular project id") }
      : undefined,
    signal,
  });
  assertNoVeraTabularSensitiveFields(value);
  if (!Array.isArray(value) || value.length > MAX_REVIEWS) {
    return invalid("Tabular review list");
  }
  const reviews = value.map(parseVeraTabularReview);
  if (
    projectId &&
    reviews.some((review) => review.project_id !== projectId)
  ) {
    return invalid("Tabular project review list");
  }
  return reviews;
}

export async function getVeraTabularCapabilities(
  signal?: AbortSignal,
): Promise<VeraTabularCapabilities> {
  return parseVeraTabularCapabilities(
    await veraApiRequest<unknown>("/tabular-review/capabilities", { signal }),
  );
}

export async function createVeraTabularReview(
  input: VeraTabularReviewCreateInput,
  signal?: AbortSignal,
): Promise<VeraTabularReview> {
  const projectId = safeId(input.project_id, "Tabular project id");
  const modelProfileId = safeId(
    input.model_profile_id,
    "Tabular model profile id",
  );
  const documentIds = safeDocumentIds(input.document_ids);
  const columns = safeColumns(input.columns_config);
  if (documentIds.length * columns.length > MAX_CELLS) {
    throw new VeraRuntimeConfigurationError(
      "The Vera Tabular matrix is too large.",
    );
  }
  const created = parseVeraTabularReview(
    await veraApiRequest<unknown>("/tabular-review", {
      method: "POST",
      json: {
        title: safeTitle(input.title),
        project_id: projectId,
        document_ids: documentIds,
        columns_config: columns,
        model_profile_id: modelProfileId,
        ...(input.workflow_id === undefined
          ? {}
          : {
              workflow_id:
                input.workflow_id === null
                  ? null
                  : safeId(input.workflow_id, "Tabular workflow id"),
            }),
      },
      signal,
    }),
  );
  if (
    created.project_id !== projectId ||
    created.model_profile_id !== modelProfileId ||
    !sameIds(created.document_ids, documentIds) ||
    !sameColumns(created.columns_config, columns)
  ) {
    return invalid("created Tabular review");
  }
  return created;
}

export async function getVeraTabularReview(
  reviewId: string,
  signal?: AbortSignal,
): Promise<VeraTabularReviewDetail> {
  const detail = parseVeraTabularReviewDetail(
    await veraApiRequest<unknown>(
      `/tabular-review/${safeId(reviewId, "Tabular review id")}`,
      { signal },
    ),
  );
  if (detail.review.id !== reviewId) {
    return invalid("Tabular review identity");
  }
  return detail;
}

export async function updateVeraTabularReview(
  reviewId: string,
  input: VeraTabularReviewUpdateInput,
  signal?: AbortSignal,
): Promise<VeraTabularReview> {
  const body: Record<string, unknown> = {};
  if (input.title !== undefined) body.title = safeTitle(input.title);
  if (input.project_id !== undefined) {
    body.project_id =
      input.project_id === null
        ? null
        : safeId(input.project_id, "Tabular project id");
  }
  if (input.document_ids !== undefined) {
    body.document_ids = safeDocumentIds(input.document_ids);
  }
  if (input.columns_config !== undefined) {
    body.columns_config = safeColumns(input.columns_config);
  }
  if (input.model_profile_id !== undefined) {
    body.model_profile_id =
      input.model_profile_id === null
        ? null
        : safeId(input.model_profile_id, "Tabular model profile id");
  }
  if (Object.keys(body).length === 0) {
    throw new VeraRuntimeConfigurationError(
      "The Vera Tabular update is empty.",
    );
  }
  if (
    Array.isArray(body.document_ids) &&
    Array.isArray(body.columns_config) &&
    body.document_ids.length * body.columns_config.length > MAX_CELLS
  ) {
    throw new VeraRuntimeConfigurationError(
      "The Vera Tabular matrix is too large.",
    );
  }
  const updated = parseVeraTabularReview(
    await veraApiRequest<unknown>(
      `/tabular-review/${safeId(reviewId, "Tabular review id")}`,
      { method: "PATCH", json: body, signal },
    ),
  );
  if (
    updated.id !== reviewId ||
    (body.project_id !== undefined && updated.project_id !== body.project_id) ||
    (body.model_profile_id !== undefined &&
      updated.model_profile_id !== body.model_profile_id) ||
    (body.title !== undefined && updated.title !== body.title) ||
    (Array.isArray(body.document_ids) &&
      !sameIds(updated.document_ids, body.document_ids as string[])) ||
    (Array.isArray(body.columns_config) &&
      !sameColumns(
        updated.columns_config,
        body.columns_config as VeraTabularColumn[],
      ))
  ) {
    return invalid("updated Tabular review");
  }
  return updated;
}

export function deleteVeraTabularReview(
  reviewId: string,
  signal?: AbortSignal,
): Promise<void> {
  return veraApiRequest(
    `/tabular-review/${safeId(reviewId, "Tabular review id")}`,
    { method: "DELETE", signal },
  );
}

export function clearVeraTabularCells(
  reviewId: string,
  documentIds: string[],
  signal?: AbortSignal,
): Promise<void> {
  const ids = safeDocumentIds(documentIds);
  if (ids.length === 0) {
    throw new VeraRuntimeConfigurationError(
      "At least one Vera Tabular document is required.",
    );
  }
  return veraApiRequest(
    `/tabular-review/${safeId(reviewId, "Tabular review id")}/clear-cells`,
    { method: "POST", json: { document_ids: ids }, signal },
  );
}

export async function regenerateVeraTabularCell(
  reviewId: string,
  documentId: string,
  columnIndex: number,
  signal?: AbortSignal,
): Promise<VeraTabularCell> {
  const cell = parseVeraTabularCell(
    await veraApiRequest<unknown>(
      `/tabular-review/${safeId(reviewId, "Tabular review id")}/regenerate-cell`,
      {
        method: "POST",
        json: {
          document_id: safeId(documentId, "Tabular document id"),
          column_index: integer(columnIndex, "Tabular column index", 0, 99),
        },
        signal,
      },
    ),
  );
  if (
    cell.review_id !== reviewId ||
    cell.document_id !== documentId ||
    cell.column_index !== columnIndex
  ) {
    return invalid("regenerated Tabular cell");
  }
  return cell;
}

export async function cancelVeraTabularCell(
  reviewId: string,
  input:
    | { cell_id: string; reason?: string }
    | { document_id: string; column_index: number; reason?: string },
  signal?: AbortSignal,
): Promise<VeraTabularCell> {
  const reason = input.reason?.trim();
  if (reason && reason.length > 1_000) {
    throw new VeraRuntimeConfigurationError(
      "The Vera Tabular cancellation reason is invalid.",
    );
  }
  const json =
    "cell_id" in input
      ? {
          cell_id: safeId(input.cell_id, "Tabular cell id"),
          ...(reason ? { reason } : {}),
        }
      : {
          document_id: safeId(input.document_id, "Tabular document id"),
          column_index: integer(
            input.column_index,
            "Tabular column index",
            0,
            99,
          ),
          ...(reason ? { reason } : {}),
        };
  const cell = parseVeraTabularCell(
    await veraApiRequest<unknown>(
      `/tabular-review/${safeId(reviewId, "Tabular review id")}/cancel-cell`,
      { method: "POST", json, signal },
    ),
  );
  if (
    cell.review_id !== reviewId ||
    ("cell_id" in input
      ? cell.id !== input.cell_id
      : cell.document_id !== input.document_id ||
        cell.column_index !== input.column_index)
  ) {
    return invalid("cancelled Tabular cell");
  }
  return cell;
}

export async function* streamVeraTabularGeneration(
  reviewId: string,
  signal?: AbortSignal,
): AsyncGenerator<{
  document_id: string;
  column_index: number;
  content: VeraTabularCellContent | null;
  status: "generating" | "done" | "error";
}> {
  for await (const event of streamVeraSse(
    `/tabular-review/${safeId(reviewId, "Tabular review id")}/generate`,
    { method: "POST", json: {}, signal },
  )) {
    if (event.type !== "cell_update") {
      throw new VeraSseProtocolError(
        "The Vera Tabular event stream returned an unexpected event.",
      );
    }
    if (event.column_index > 99 || (event.status === "done" && !event.content)) {
      throw new VeraSseProtocolError(
        "The Vera Tabular cell update is invalid.",
      );
    }
    assertNoVeraTabularSensitiveFields(event);
    yield {
      document_id: event.document_id,
      column_index: event.column_index,
      content: event.content,
      status: event.status,
    };
  }
}

export function exportVeraTabularReview(
  reviewId: string,
  format: "csv" | "xlsx",
  signal?: AbortSignal,
): Promise<VeraBlobResponse> {
  return veraApiBlobRequest(
    `/tabular-review/${safeId(reviewId, "Tabular review id")}/export.${format}`,
    { signal },
  );
}
