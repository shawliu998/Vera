import { veraApiBlobRequest, veraApiRequest, VeraApiError } from "./veraApi";
import { VeraRuntimeConfigurationError } from "./veraRuntime";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_STUDIO_CONTENT_LENGTH = 2_000_000;
const MAX_STUDIO_CONTENT_BYTES = 4_000_000;
const MAX_CITATION_ANCHORS = 200;
const MAX_STUDIO_DOCX_BYTES = 10 * 1024 * 1024;
const MAX_STUDIO_DRAFTS_PER_PAGE = 100;
const MAX_STUDIO_TEMPLATES = 100;
const MAX_STUDIO_TEMPLATE_SECTIONS = 24;
export const VERA_STUDIO_DOCX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const VERA_STUDIO_DOCX_WARNING_CODES = [
  "DOCX_IMAGES_IGNORED",
  "DOCX_FORMATTING_SIMPLIFIED",
  "DOCX_CONVERTER_WARNING",
  "MARKDOWN_IMAGES_OMITTED",
  "MARKDOWN_HTML_AS_TEXT",
  "MARKDOWN_BLOCKQUOTE_SIMPLIFIED",
] as const;
export type VeraStudioDocxWarningCode =
  (typeof VERA_STUDIO_DOCX_WARNING_CODES)[number];
const STUDIO_DOCX_WARNING_CODE_SET = new Set<string>(
  VERA_STUDIO_DOCX_WARNING_CODES,
);
const STUDIO_VERSION_SOURCES = new Set([
  "user_upload",
  "assistant_edit",
  "user_accept",
] as const);

export const VERA_STUDIO_DOCUMENT_TYPES = [
  "legal_research_memo",
  "legal_opinion",
  "contract_review_memo",
  "due_diligence_report",
  "litigation_strategy_memo",
  "lawyer_letter",
  "contract_clause",
  "general_legal_document",
] as const;
export type VeraStudioDocumentType =
  (typeof VERA_STUDIO_DOCUMENT_TYPES)[number];
const STUDIO_DOCUMENT_TYPE_SET = new Set<string>(VERA_STUDIO_DOCUMENT_TYPES);

export const VERA_STUDIO_DRAFT_ORIGIN_TYPES = [
  "manual",
  "assistant",
  "workflow",
  "unknown",
] as const;
export type VeraStudioDraftOriginType =
  (typeof VERA_STUDIO_DRAFT_ORIGIN_TYPES)[number];
const STUDIO_DRAFT_ORIGIN_TYPE_SET = new Set<string>(
  VERA_STUDIO_DRAFT_ORIGIN_TYPES,
);

export type VeraStudioVersionSourceWire =
  "user_upload" | "assistant_edit" | "user_accept";

export interface VeraStudioVersionWire {
  id: string;
  version_number: number;
  source: VeraStudioVersionSourceWire;
  filename: string;
  mime_type: "text/markdown";
  size_bytes: number;
  content_sha256: string;
  created_at: string;
  citation_anchor_ids: string[];
}

export interface VeraStudioCitationAnchorWire {
  id: string;
  snapshot_id: string;
  ordinal: number;
  exact_quote: string;
  quote_sha256: string;
  locator: Readonly<Record<string, unknown>>;
}

export interface VeraStudioCapabilitiesWire {
  docx_import: true;
  docx_export: true;
}

export interface VeraStudioDocumentWire {
  document_id: string;
  project_id: string;
  title: string;
  filename: string;
  format: "markdown";
  current_version_id: string;
  version: VeraStudioVersionWire;
  content: string;
  citation_anchors: VeraStudioCitationAnchorWire[];
  capabilities: VeraStudioCapabilitiesWire;
}

export interface VeraStudioVersionListItemWire {
  id: string;
  version_number: number;
  source: VeraStudioVersionSourceWire;
  filename: string;
  mime_type: string;
  size_bytes: number;
  content_sha256: string;
  created_at: string;
  citation_anchor_ids: string[];
}

export interface VeraStudioVersionsWire {
  current_version_id: string;
  versions: VeraStudioVersionListItemWire[];
}

export interface CreateVeraStudioDocumentInput {
  title: string;
  folder_id?: string | null;
  document_type?: VeraStudioDocumentType;
}

export interface VeraStudioDraftListItemWire {
  draft_id: string;
  project_id: string;
  title: string;
  document_type: VeraStudioDocumentType;
  current_version_id: string;
  current_version_number: number;
  updated_at: string;
  source_count: number;
  pending_suggestion_count: number;
  origin_type: VeraStudioDraftOriginType;
}

export interface VeraStudioDraftPageWire {
  items: VeraStudioDraftListItemWire[];
  has_more: boolean;
  next_cursor: string | null;
}

export interface VeraStudioDraftListQuery {
  cursor?: string;
  limit?: number;
}

export type VeraStudioTemplateScope = "builtin" | "project";

export interface VeraStudioTemplateSummaryWire {
  template_id: string;
  scope: VeraStudioTemplateScope;
  title: string;
  description: string;
  document_type: VeraStudioDocumentType;
  section_count: number;
  updated_at: string;
}

export interface VeraStudioDraftPlanSectionWire {
  id: string;
  heading: string;
  purpose: string;
  required_sources: string[];
}

export interface VeraStudioDraftPlanWire {
  title: string;
  document_type: VeraStudioDocumentType;
  sections: VeraStudioDraftPlanSectionWire[];
}

export interface VeraStudioTemplateWire extends VeraStudioTemplateSummaryWire {
  content: string;
  plan: VeraStudioDraftPlanWire;
}

export interface VeraStudioTemplateListWire {
  items: VeraStudioTemplateSummaryWire[];
}

export interface CreateVeraStudioDraftFromTemplateInput {
  title?: string;
  folder_id?: string | null;
}

export interface VeraStudioTemplateDraftWire {
  document: VeraStudioDocumentWire;
  plan: VeraStudioDraftPlanWire;
}

export interface CreateVeraStudioDraftFromAssistantInput {
  chat_id: string;
  assistant_message_id: string;
}

export interface CreateVeraStudioDraftFromWorkflowInput {
  workflow_run_id: string;
}

export interface SaveVeraStudioDocumentInput {
  expected_version_id: string;
  content: string;
  source: "user_upload" | "assistant_edit";
  citation_anchor_ids?: string[];
  summary?: string | null;
}

export interface RestoreVeraStudioVersionInput {
  expected_current_version_id: string;
}

export interface VeraStudioDocxImportWire {
  document: VeraStudioDocumentWire;
  warnings: VeraStudioDocxWarningCode[];
}

export interface VeraStudioDocxDownload {
  blob: Blob;
  filename: string;
  warningCodes: VeraStudioDocxWarningCode[];
}

export interface VeraStudioSuggestionWire {
  id: string;
  project_id: string;
  document_id: string;
  base_version_id: string;
  message_id: string | null;
  change_id: string;
  start_offset: number;
  end_offset: number;
  offset_scope: "raw_markdown_v1";
  offset_unit: "utf16_code_unit";
  deleted_text: string;
  inserted_text: string;
  context_before: string;
  context_after: string;
  summary: string;
  status: "pending" | "accepted" | "rejected";
  created_at: string;
  resolved_at: string | null;
  result_version_id: string | null;
}

export interface VeraStudioSuggestionPreviewWire {
  id: string;
  project_id: string;
  document_id: string;
  base_version_id: string;
  message_id: string | null;
  start_offset: number;
  end_offset: number;
  offset_scope: "raw_markdown_v1";
  offset_unit: "utf16_code_unit";
  deleted_preview: string;
  inserted_preview: string;
  deleted_truncated: boolean;
  inserted_truncated: boolean;
  context_before: string;
  context_after: string;
  summary: string;
  status: "pending";
  created_at: string;
}

export interface VeraStudioSuggestionPreviewPageWire {
  suggestions: VeraStudioSuggestionPreviewWire[];
  has_more: boolean;
}

export interface VeraStudioSuggestionAcceptanceWire {
  suggestion: VeraStudioSuggestionWire;
  document: VeraStudioDocumentWire;
}

export interface VeraStudioSuggestionAcceptanceExpectation {
  reviewedSuggestion: VeraStudioSuggestionWire;
  baseDocument: VeraStudioDocumentWire;
}

function invalidWire(label: string): never {
  throw new VeraApiError({
    status: 200,
    code: "INVALID_RESPONSE",
    message: `The Vera API returned an invalid ${label}.`,
  });
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalidWire(label);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
) {
  const keys = new Set(allowed);
  if (Object.keys(value).some((key) => !keys.has(key))) invalidWire(label);
}

function boundedString(
  value: unknown,
  label: string,
  maxLength: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string" ||
    value.length > maxLength ||
    (!allowEmpty && value.length === 0) ||
    value.includes("\0") ||
    hasUnpairedSurrogate(value)
  ) {
    return invalidWire(label);
  }
  return value;
}

function hasUnpairedSurrogate(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function boundedCodePointString(
  value: unknown,
  label: string,
  maxCodePoints: number,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxCodePoints * 2 ||
    [...value].length > maxCodePoints ||
    value.includes("\0") ||
    hasUnpairedSurrogate(value)
  ) {
    return invalidWire(label);
  }
  return value;
}

function uuid(value: unknown, label: string): string {
  const id = boundedString(value, label, 36);
  if (!UUID_PATTERN.test(id)) invalidWire(label);
  return id;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) invalidWire(label);
  return Number(value);
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) invalidWire(label);
  return Number(value);
}

function trueCapability(value: unknown, label: string): true {
  if (value !== true) invalidWire(label);
  return true;
}

function docxWarningCodes(
  value: unknown,
  label: string,
): VeraStudioDocxWarningCode[] {
  if (
    !Array.isArray(value) ||
    value.length > VERA_STUDIO_DOCX_WARNING_CODES.length
  ) {
    invalidWire(label);
  }
  const codes = value.map((code) => {
    if (typeof code !== "string" || !STUDIO_DOCX_WARNING_CODE_SET.has(code)) {
      invalidWire(label);
    }
    return code as VeraStudioDocxWarningCode;
  });
  if (new Set(codes).size !== codes.length) invalidWire(label);
  return codes;
}

function sha256(value: unknown, label: string): string {
  const hash = boundedString(value, label, 64);
  if (!SHA256_PATTERN.test(hash)) invalidWire(label);
  return hash;
}

function versionSource(value: unknown): VeraStudioVersionSourceWire {
  const source = boundedString(value, "Studio version source", 80);
  if (!STUDIO_VERSION_SOURCES.has(source as VeraStudioVersionSourceWire)) {
    invalidWire("Studio version source");
  }
  return source as VeraStudioVersionSourceWire;
}

function studioDocumentType(value: unknown): VeraStudioDocumentType {
  const documentType = boundedString(value, "Studio document type", 80);
  if (!STUDIO_DOCUMENT_TYPE_SET.has(documentType)) {
    invalidWire("Studio document type");
  }
  return documentType as VeraStudioDocumentType;
}

function studioDraftOriginType(value: unknown): VeraStudioDraftOriginType {
  const originType = boundedString(value, "Studio draft origin type", 80);
  if (!STUDIO_DRAFT_ORIGIN_TYPE_SET.has(originType)) {
    invalidWire("Studio draft origin type");
  }
  return originType as VeraStudioDraftOriginType;
}

function studioTemplateScope(value: unknown): VeraStudioTemplateScope {
  if (value !== "builtin" && value !== "project") {
    invalidWire("Studio template scope");
  }
  return value;
}

function studioMimeType(value: unknown): "text/markdown" {
  if (value !== "text/markdown") {
    invalidWire("Studio version MIME type");
  }
  return value;
}

function boundedStudioSize(value: unknown): number {
  const size = nonNegativeInteger(value, "Studio version size");
  if (size > MAX_STUDIO_CONTENT_BYTES) invalidWire("Studio version size");
  return size;
}

function isoTimestamp(value: unknown, label: string): string {
  const timestamp = boundedString(value, label, 80);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      timestamp,
    ) ||
    !Number.isFinite(Date.parse(timestamp))
  ) {
    invalidWire(label);
  }
  return timestamp;
}

function studioContent(value: unknown): string {
  const content = boundedString(
    value,
    "Studio content",
    MAX_STUDIO_CONTENT_LENGTH,
    true,
  );
  if (
    new TextEncoder().encode(content).byteLength > MAX_STUDIO_CONTENT_BYTES ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(content)
  ) {
    invalidWire("Studio content");
  }
  return content;
}

function studioTitle(value: unknown): string {
  const title = boundedString(value, "Studio title", 480).trim();
  if (
    [...title].length < 1 ||
    [...title].length > 240 ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(title)
  ) {
    invalidWire("Studio title");
  }
  return title;
}

function studioQuote(value: unknown): string {
  const quote = boundedString(value, "Studio citation quote", 8_000);
  if (
    !quote.trim() ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(quote)
  ) {
    invalidWire("Studio citation quote");
  }
  return quote;
}

function uuidArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_CITATION_ANCHORS) {
    return invalidWire(label);
  }
  const ids = value.map((item) => uuid(item, label));
  if (new Set(ids).size !== ids.length) invalidWire(label);
  return ids;
}

function locator(value: unknown): Readonly<Record<string, unknown>> {
  const root = record(value, "Studio citation locator");
  let nodes = 0;
  const visit = (child: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > 512 || depth > 8) invalidWire("Studio citation locator");
    if (
      child === null ||
      typeof child === "boolean" ||
      (typeof child === "number" && Number.isFinite(child))
    ) {
      return;
    }
    if (typeof child === "string") {
      if (child.length > 4_000 || child.includes("\0")) {
        invalidWire("Studio citation locator");
      }
      return;
    }
    if (Array.isArray(child)) {
      if (child.length > 100) invalidWire("Studio citation locator");
      child.forEach((item) => visit(item, depth + 1));
      return;
    }
    if (!child || typeof child !== "object") {
      invalidWire("Studio citation locator");
    }
    const entries = Object.entries(child as Record<string, unknown>);
    if (entries.length > 128) invalidWire("Studio citation locator");
    for (const [key, item] of entries) {
      if (!key || key.length > 120 || key.includes("\0")) {
        invalidWire("Studio citation locator");
      }
      visit(item, depth + 1);
    }
  };
  visit(root, 0);
  return root;
}

function parseVersion(value: unknown): VeraStudioVersionWire {
  const wire = record(value, "Studio document version");
  exactKeys(
    wire,
    [
      "id",
      "version_number",
      "source",
      "filename",
      "mime_type",
      "size_bytes",
      "content_sha256",
      "created_at",
      "citation_anchor_ids",
    ],
    "Studio document version",
  );
  return {
    id: uuid(wire.id, "Studio version id"),
    version_number: positiveInteger(
      wire.version_number,
      "Studio version number",
    ),
    source: versionSource(wire.source),
    filename: boundedString(wire.filename, "Studio version filename", 240),
    mime_type: studioMimeType(wire.mime_type),
    size_bytes: boundedStudioSize(wire.size_bytes),
    content_sha256: sha256(wire.content_sha256, "Studio content digest"),
    created_at: isoTimestamp(wire.created_at, "Studio version timestamp"),
    citation_anchor_ids: uuidArray(
      wire.citation_anchor_ids,
      "Studio version citation ids",
    ),
  };
}

function parseCitationAnchor(value: unknown): VeraStudioCitationAnchorWire {
  const wire = record(value, "Studio citation anchor");
  exactKeys(
    wire,
    ["id", "snapshot_id", "ordinal", "exact_quote", "quote_sha256", "locator"],
    "Studio citation anchor",
  );
  return {
    id: uuid(wire.id, "Studio citation anchor id"),
    snapshot_id: uuid(wire.snapshot_id, "Studio citation snapshot id"),
    ordinal: nonNegativeInteger(wire.ordinal, "Studio citation ordinal"),
    exact_quote: studioQuote(wire.exact_quote),
    quote_sha256: sha256(wire.quote_sha256, "Studio citation quote digest"),
    locator: locator(wire.locator),
  };
}

export function parseVeraStudioDocument(
  value: unknown,
): VeraStudioDocumentWire {
  const wire = record(value, "Studio document");
  exactKeys(
    wire,
    [
      "document_id",
      "project_id",
      "title",
      "filename",
      "format",
      "current_version_id",
      "version",
      "content",
      "citation_anchors",
      "capabilities",
    ],
    "Studio document",
  );
  if (wire.format !== "markdown") invalidWire("Studio document format");
  if (
    !Array.isArray(wire.citation_anchors) ||
    wire.citation_anchors.length > MAX_CITATION_ANCHORS
  ) {
    invalidWire("Studio citation list");
  }
  const capabilities = record(wire.capabilities, "Studio capabilities");
  exactKeys(
    capabilities,
    ["docx_import", "docx_export"],
    "Studio capabilities",
  );
  const version = parseVersion(wire.version);
  const currentVersionId = uuid(
    wire.current_version_id,
    "Studio current version id",
  );
  return {
    document_id: uuid(wire.document_id, "Studio document id"),
    project_id: uuid(wire.project_id, "Studio project id"),
    title: studioTitle(wire.title),
    filename: boundedString(wire.filename, "Studio filename", 240),
    format: "markdown",
    current_version_id: currentVersionId,
    version,
    content: studioContent(wire.content),
    citation_anchors: wire.citation_anchors.map(parseCitationAnchor),
    capabilities: {
      docx_import: trueCapability(
        capabilities.docx_import,
        "Studio DOCX import capability",
      ),
      docx_export: trueCapability(
        capabilities.docx_export,
        "Studio DOCX export capability",
      ),
    },
  };
}

function parseVersionListItem(value: unknown): VeraStudioVersionListItemWire {
  const wire = record(value, "Studio version list item");
  exactKeys(
    wire,
    [
      "id",
      "version_number",
      "source",
      "filename",
      "mime_type",
      "size_bytes",
      "content_sha256",
      "created_at",
      "citation_anchor_ids",
    ],
    "Studio version list item",
  );
  return {
    id: uuid(wire.id, "Studio version id"),
    version_number: positiveInteger(
      wire.version_number,
      "Studio version number",
    ),
    source: versionSource(wire.source),
    filename: boundedString(wire.filename, "Studio version filename", 240),
    mime_type: studioMimeType(wire.mime_type),
    size_bytes: boundedStudioSize(wire.size_bytes),
    content_sha256: sha256(wire.content_sha256, "Studio content digest"),
    created_at: isoTimestamp(wire.created_at, "Studio version timestamp"),
    citation_anchor_ids: uuidArray(
      wire.citation_anchor_ids,
      "Studio version citation ids",
    ),
  };
}

function parseCurrentVeraStudioDocument(
  value: unknown,
): VeraStudioDocumentWire {
  const document = parseVeraStudioDocument(value);
  if (document.version.id !== document.current_version_id) {
    invalidWire("Studio current version");
  }
  return document;
}

export function parseVeraStudioVersions(
  value: unknown,
): VeraStudioVersionsWire {
  const wire = record(value, "Studio version list");
  exactKeys(wire, ["current_version_id", "versions"], "Studio version list");
  if (!Array.isArray(wire.versions) || wire.versions.length > 10_000) {
    invalidWire("Studio version list");
  }
  const currentVersionId = uuid(
    wire.current_version_id,
    "Studio current version id",
  );
  const versions = wire.versions.map(parseVersionListItem);
  if (!versions.some((version) => version.id === currentVersionId)) {
    invalidWire("Studio current version list entry");
  }
  return { current_version_id: currentVersionId, versions };
}

function parseVeraStudioDraftListItem(
  value: unknown,
): VeraStudioDraftListItemWire {
  const wire = record(value, "Studio draft list item");
  exactKeys(
    wire,
    [
      "draft_id",
      "project_id",
      "title",
      "document_type",
      "current_version_id",
      "current_version_number",
      "updated_at",
      "source_count",
      "pending_suggestion_count",
      "origin_type",
    ],
    "Studio draft list item",
  );
  return {
    draft_id: uuid(wire.draft_id, "Studio draft id"),
    project_id: uuid(wire.project_id, "Studio draft project id"),
    title: studioTitle(wire.title),
    document_type: studioDocumentType(wire.document_type),
    current_version_id: uuid(
      wire.current_version_id,
      "Studio draft current version id",
    ),
    current_version_number: positiveInteger(
      wire.current_version_number,
      "Studio draft current version number",
    ),
    updated_at: isoTimestamp(wire.updated_at, "Studio draft updated timestamp"),
    source_count: nonNegativeInteger(
      wire.source_count,
      "Studio draft source count",
    ),
    pending_suggestion_count: nonNegativeInteger(
      wire.pending_suggestion_count,
      "Studio draft pending suggestion count",
    ),
    origin_type: studioDraftOriginType(wire.origin_type),
  };
}

export function parseVeraStudioDraftPage(
  value: unknown,
): VeraStudioDraftPageWire {
  const wire = record(value, "Studio draft page");
  exactKeys(wire, ["items", "has_more", "next_cursor"], "Studio draft page");
  if (
    !Array.isArray(wire.items) ||
    wire.items.length > MAX_STUDIO_DRAFTS_PER_PAGE ||
    typeof wire.has_more !== "boolean"
  ) {
    invalidWire("Studio draft page");
  }
  const items = wire.items.map(parseVeraStudioDraftListItem);
  if (new Set(items.map((item) => item.draft_id)).size !== items.length) {
    invalidWire("Studio draft page");
  }
  const nextCursor =
    wire.next_cursor === null
      ? null
      : boundedString(wire.next_cursor, "Studio draft cursor", 512);
  if (wire.has_more !== (nextCursor !== null)) {
    invalidWire("Studio draft pagination");
  }
  return { items, has_more: wire.has_more, next_cursor: nextCursor };
}

function studioTemplateText(
  value: unknown,
  label: string,
  maxCodePoints: number,
  allowEmpty = false,
): string {
  if (allowEmpty && value === "") return "";
  const text = boundedCodePointString(value, label, maxCodePoints).trim();
  if (
    (!allowEmpty && text.length === 0) ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(text)
  ) {
    invalidWire(label);
  }
  return text;
}

function parseVeraStudioTemplateSummary(
  value: unknown,
): VeraStudioTemplateSummaryWire {
  const wire = record(value, "Studio template summary");
  exactKeys(
    wire,
    [
      "template_id",
      "scope",
      "title",
      "description",
      "document_type",
      "section_count",
      "updated_at",
    ],
    "Studio template summary",
  );
  const sectionCount = positiveInteger(
    wire.section_count,
    "Studio template section count",
  );
  if (sectionCount > MAX_STUDIO_TEMPLATE_SECTIONS) {
    invalidWire("Studio template section count");
  }
  return {
    template_id: uuid(wire.template_id, "Studio template id"),
    scope: studioTemplateScope(wire.scope),
    title: studioTemplateText(wire.title, "Studio template title", 240),
    description: studioTemplateText(
      wire.description,
      "Studio template description",
      500,
    ),
    document_type: studioDocumentType(wire.document_type),
    section_count: sectionCount,
    updated_at: isoTimestamp(
      wire.updated_at,
      "Studio template updated timestamp",
    ),
  };
}

function parseVeraStudioDraftPlanSection(
  value: unknown,
): VeraStudioDraftPlanSectionWire {
  const wire = record(value, "Studio DraftPlan section");
  exactKeys(
    wire,
    ["id", "heading", "purpose", "required_sources"],
    "Studio DraftPlan section",
  );
  if (
    !Array.isArray(wire.required_sources) ||
    wire.required_sources.length > 8
  ) {
    invalidWire("Studio DraftPlan required sources");
  }
  const requiredSources = wire.required_sources.map((source) =>
    studioTemplateText(source, "Studio DraftPlan required source", 120),
  );
  const sectionId = studioTemplateText(
    wire.id,
    "Studio DraftPlan section id",
    40,
  );
  if (!/^[a-z][a-z0-9_]{0,39}$/.test(sectionId)) {
    invalidWire("Studio DraftPlan section id");
  }
  return {
    id: sectionId,
    heading: studioTemplateText(
      wire.heading,
      "Studio DraftPlan section heading",
      120,
    ),
    purpose: studioTemplateText(
      wire.purpose,
      "Studio DraftPlan section purpose",
      500,
    ),
    required_sources: requiredSources,
  };
}

export function parseVeraStudioDraftPlan(
  value: unknown,
): VeraStudioDraftPlanWire {
  const wire = record(value, "Studio DraftPlan");
  exactKeys(wire, ["title", "document_type", "sections"], "Studio DraftPlan");
  if (
    !Array.isArray(wire.sections) ||
    wire.sections.length < 1 ||
    wire.sections.length > MAX_STUDIO_TEMPLATE_SECTIONS
  ) {
    invalidWire("Studio DraftPlan sections");
  }
  const sections = wire.sections.map(parseVeraStudioDraftPlanSection);
  if (new Set(sections.map((section) => section.id)).size !== sections.length) {
    invalidWire("Studio DraftPlan section ids");
  }
  return {
    title: studioTemplateText(wire.title, "Studio DraftPlan title", 240),
    document_type: studioDocumentType(wire.document_type),
    sections,
  };
}

export function parseVeraStudioTemplateList(
  value: unknown,
): VeraStudioTemplateListWire {
  const wire = record(value, "Studio template list");
  exactKeys(wire, ["items"], "Studio template list");
  if (!Array.isArray(wire.items) || wire.items.length > MAX_STUDIO_TEMPLATES) {
    invalidWire("Studio template list");
  }
  const items = wire.items.map(parseVeraStudioTemplateSummary);
  if (new Set(items.map((item) => item.template_id)).size !== items.length) {
    invalidWire("Studio template ids");
  }
  return { items };
}

export function parseVeraStudioTemplate(
  value: unknown,
): VeraStudioTemplateWire {
  const outer = record(value, "Studio template response");
  exactKeys(outer, ["template"], "Studio template response");
  const wire = record(outer.template, "Studio template");
  exactKeys(
    wire,
    [
      "template_id",
      "scope",
      "title",
      "description",
      "document_type",
      "section_count",
      "updated_at",
      "content",
      "plan",
    ],
    "Studio template",
  );
  const summary = parseVeraStudioTemplateSummary({
    template_id: wire.template_id,
    scope: wire.scope,
    title: wire.title,
    description: wire.description,
    document_type: wire.document_type,
    section_count: wire.section_count,
    updated_at: wire.updated_at,
  });
  const plan = parseVeraStudioDraftPlan(wire.plan);
  if (
    plan.document_type !== summary.document_type ||
    plan.sections.length !== summary.section_count
  ) {
    invalidWire("Studio template DraftPlan binding");
  }
  const content = studioContent(wire.content);
  if (content.length === 0) invalidWire("Studio template content");
  return {
    ...summary,
    content,
    plan,
  };
}

export function parseVeraStudioTemplateDraft(
  value: unknown,
): VeraStudioTemplateDraftWire {
  const wire = record(value, "Studio template draft");
  exactKeys(wire, ["document", "plan"], "Studio template draft");
  const document = parseCurrentVeraStudioDocument(wire.document);
  const plan = parseVeraStudioDraftPlan(wire.plan);
  return { document, plan };
}

export function parseVeraStudioSuggestion(
  value: unknown,
): VeraStudioSuggestionWire {
  const wire = record(value, "Studio suggestion");
  exactKeys(
    wire,
    [
      "id",
      "project_id",
      "document_id",
      "base_version_id",
      "message_id",
      "change_id",
      "start_offset",
      "end_offset",
      "offset_scope",
      "offset_unit",
      "deleted_text",
      "inserted_text",
      "context_before",
      "context_after",
      "summary",
      "status",
      "created_at",
      "resolved_at",
      "result_version_id",
    ],
    "Studio suggestion",
  );
  const startOffset = nonNegativeInteger(
    wire.start_offset,
    "Studio suggestion start offset",
  );
  const endOffset = nonNegativeInteger(
    wire.end_offset,
    "Studio suggestion end offset",
  );
  const deletedText = boundedString(
    wire.deleted_text,
    "Studio suggestion deleted text",
    200_000,
    true,
  );
  const insertedText = boundedString(
    wire.inserted_text,
    "Studio suggestion inserted text",
    200_000,
    true,
  );
  if (
    endOffset - startOffset !== deletedText.length ||
    (deletedText.length === 0 && insertedText.length === 0)
  ) {
    invalidWire("Studio suggestion range");
  }
  if (
    wire.offset_scope !== "raw_markdown_v1" ||
    wire.offset_unit !== "utf16_code_unit"
  ) {
    invalidWire("Studio suggestion offset contract");
  }
  if (
    wire.status !== "pending" &&
    wire.status !== "accepted" &&
    wire.status !== "rejected"
  ) {
    invalidWire("Studio suggestion status");
  }
  const resolvedAt =
    wire.resolved_at === null
      ? null
      : isoTimestamp(wire.resolved_at, "Studio suggestion resolution time");
  const resultVersionId =
    wire.result_version_id === null
      ? null
      : uuid(wire.result_version_id, "Studio suggestion result version id");
  if (
    (wire.status === "pending") !== (resolvedAt === null) ||
    (wire.status === "accepted") !== (resultVersionId !== null)
  ) {
    invalidWire("Studio suggestion resolution");
  }
  return {
    id: uuid(wire.id, "Studio suggestion id"),
    project_id: uuid(wire.project_id, "Studio suggestion project id"),
    document_id: uuid(wire.document_id, "Studio suggestion document id"),
    base_version_id: uuid(
      wire.base_version_id,
      "Studio suggestion base version id",
    ),
    message_id:
      wire.message_id === null
        ? null
        : uuid(wire.message_id, "Studio suggestion message id"),
    change_id: boundedString(
      wire.change_id,
      "Studio suggestion change id",
      160,
    ),
    start_offset: startOffset,
    end_offset: endOffset,
    offset_scope: "raw_markdown_v1",
    offset_unit: "utf16_code_unit",
    deleted_text: deletedText,
    inserted_text: insertedText,
    context_before: boundedString(
      wire.context_before,
      "Studio suggestion context before",
      241,
      true,
    ),
    context_after: boundedString(
      wire.context_after,
      "Studio suggestion context after",
      241,
      true,
    ),
    summary: boundedCodePointString(
      wire.summary,
      "Studio suggestion summary",
      500,
    ),
    status: wire.status,
    created_at: isoTimestamp(
      wire.created_at,
      "Studio suggestion creation time",
    ),
    resolved_at: resolvedAt,
    result_version_id: resultVersionId,
  };
}

export function parseVeraStudioSuggestionPreview(
  value: unknown,
): VeraStudioSuggestionPreviewWire {
  const wire = record(value, "Studio suggestion preview");
  exactKeys(
    wire,
    [
      "id",
      "project_id",
      "document_id",
      "base_version_id",
      "message_id",
      "start_offset",
      "end_offset",
      "offset_scope",
      "offset_unit",
      "deleted_preview",
      "inserted_preview",
      "deleted_truncated",
      "inserted_truncated",
      "context_before",
      "context_after",
      "summary",
      "status",
      "created_at",
    ],
    "Studio suggestion preview",
  );
  const startOffset = nonNegativeInteger(
    wire.start_offset,
    "Studio suggestion preview start offset",
  );
  const endOffset = nonNegativeInteger(
    wire.end_offset,
    "Studio suggestion preview end offset",
  );
  if (
    endOffset < startOffset ||
    wire.offset_scope !== "raw_markdown_v1" ||
    wire.offset_unit !== "utf16_code_unit" ||
    wire.status !== "pending" ||
    typeof wire.deleted_truncated !== "boolean" ||
    typeof wire.inserted_truncated !== "boolean"
  ) {
    invalidWire("Studio suggestion preview contract");
  }
  return {
    id: uuid(wire.id, "Studio suggestion preview id"),
    project_id: uuid(wire.project_id, "Studio suggestion preview project id"),
    document_id: uuid(
      wire.document_id,
      "Studio suggestion preview document id",
    ),
    base_version_id: uuid(
      wire.base_version_id,
      "Studio suggestion preview base version id",
    ),
    message_id:
      wire.message_id === null
        ? null
        : uuid(wire.message_id, "Studio suggestion preview message id"),
    start_offset: startOffset,
    end_offset: endOffset,
    offset_scope: "raw_markdown_v1",
    offset_unit: "utf16_code_unit",
    deleted_preview: boundedString(
      wire.deleted_preview,
      "Studio suggestion deleted preview",
      320,
      true,
    ),
    inserted_preview: boundedString(
      wire.inserted_preview,
      "Studio suggestion inserted preview",
      320,
      true,
    ),
    deleted_truncated: wire.deleted_truncated as boolean,
    inserted_truncated: wire.inserted_truncated as boolean,
    context_before: boundedString(
      wire.context_before,
      "Studio suggestion preview context before",
      241,
      true,
    ),
    context_after: boundedString(
      wire.context_after,
      "Studio suggestion preview context after",
      241,
      true,
    ),
    summary: boundedCodePointString(
      wire.summary,
      "Studio suggestion preview summary",
      500,
    ),
    status: "pending",
    created_at: isoTimestamp(
      wire.created_at,
      "Studio suggestion preview creation time",
    ),
  };
}

export function veraStudioSuggestionMatchesPreview(
  suggestion: VeraStudioSuggestionWire,
  preview: VeraStudioSuggestionPreviewWire,
): boolean {
  return (
    suggestion.id === preview.id &&
    suggestion.project_id === preview.project_id &&
    suggestion.document_id === preview.document_id &&
    suggestion.base_version_id === preview.base_version_id &&
    suggestion.message_id === preview.message_id &&
    suggestion.start_offset === preview.start_offset &&
    suggestion.end_offset === preview.end_offset &&
    suggestion.offset_scope === preview.offset_scope &&
    suggestion.offset_unit === preview.offset_unit &&
    suggestion.context_before === preview.context_before &&
    suggestion.context_after === preview.context_after &&
    suggestion.summary === preview.summary &&
    suggestion.created_at === preview.created_at &&
    suggestion.status === "pending" &&
    suggestion.deleted_text.startsWith(preview.deleted_preview) &&
    suggestion.inserted_text.startsWith(preview.inserted_preview) &&
    preview.deleted_truncated ===
      suggestion.deleted_text.length > preview.deleted_preview.length &&
    preview.inserted_truncated ===
      suggestion.inserted_text.length > preview.inserted_preview.length
  );
}

function sameSuggestionImmutableFields(
  left: VeraStudioSuggestionWire,
  right: VeraStudioSuggestionWire,
): boolean {
  return (
    left.id === right.id &&
    left.project_id === right.project_id &&
    left.document_id === right.document_id &&
    left.base_version_id === right.base_version_id &&
    left.message_id === right.message_id &&
    left.change_id === right.change_id &&
    left.start_offset === right.start_offset &&
    left.end_offset === right.end_offset &&
    left.offset_scope === right.offset_scope &&
    left.offset_unit === right.offset_unit &&
    left.deleted_text === right.deleted_text &&
    left.inserted_text === right.inserted_text &&
    left.context_before === right.context_before &&
    left.context_after === right.context_after &&
    left.summary === right.summary &&
    left.created_at === right.created_at
  );
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => sameJsonValue(item, right[index]))
    );
  }
  if (
    !left ||
    !right ||
    typeof left !== "object" ||
    typeof right !== "object"
  ) {
    return false;
  }
  const leftRecord = left as Readonly<Record<string, unknown>>;
  const rightRecord = right as Readonly<Record<string, unknown>>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] &&
        sameJsonValue(leftRecord[key], rightRecord[key]),
    )
  );
}

function sameCitationProvenance(
  left: VeraStudioDocumentWire,
  right: VeraStudioDocumentWire,
): boolean {
  return (
    left.version.citation_anchor_ids.length ===
      right.version.citation_anchor_ids.length &&
    left.version.citation_anchor_ids.every(
      (id, index) => id === right.version.citation_anchor_ids[index],
    ) &&
    left.citation_anchors.length === right.citation_anchors.length &&
    left.citation_anchors.every((anchor, index) => {
      const expected = right.citation_anchors[index];
      return (
        expected !== undefined &&
        anchor.id === expected.id &&
        anchor.snapshot_id === expected.snapshot_id &&
        anchor.ordinal === expected.ordinal &&
        anchor.exact_quote === expected.exact_quote &&
        anchor.quote_sha256 === expected.quote_sha256 &&
        sameJsonValue(anchor.locator, expected.locator)
      );
    })
  );
}

function parseVeraStudioSuggestionList(
  value: unknown,
): VeraStudioSuggestionPreviewPageWire {
  const wire = record(value, "Studio suggestion list");
  exactKeys(wire, ["suggestions", "has_more"], "Studio suggestion list");
  if (
    !Array.isArray(wire.suggestions) ||
    wire.suggestions.length > 50 ||
    typeof wire.has_more !== "boolean"
  ) {
    invalidWire("Studio suggestion list");
  }
  return {
    suggestions: wire.suggestions.map(parseVeraStudioSuggestionPreview),
    has_more: wire.has_more,
  };
}

function safeId(value: string, label: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw new VeraRuntimeConfigurationError(`The Vera ${label} is invalid.`);
  }
  return value;
}

function studioDocumentPath(projectId: string, documentId?: string): string {
  const root = `/projects/${safeId(projectId, "project id")}/studio/documents`;
  return documentId
    ? `${root}/${safeId(documentId, "Studio document id")}`
    : root;
}

function safeTitle(value: string): string {
  const title = value.trim();
  if (
    !title ||
    [...title].length > 240 ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(title)
  ) {
    throw new VeraRuntimeConfigurationError(
      "The Vera Studio document title is invalid.",
    );
  }
  return title;
}

function safeDocumentType(value: string): VeraStudioDocumentType {
  if (!STUDIO_DOCUMENT_TYPE_SET.has(value)) {
    throw new VeraRuntimeConfigurationError(
      "The Vera Studio document type is invalid.",
    );
  }
  return value as VeraStudioDocumentType;
}

function safeDraftCursor(value: string): string {
  if (
    !value ||
    value.length > 512 ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    throw new VeraRuntimeConfigurationError(
      "The Vera Studio draft cursor is invalid.",
    );
  }
  return value;
}

function safeSummary(value: string | null): string | null {
  if (value === null) return null;
  const summary = value.trim();
  if (
    !summary ||
    [...summary].length > 500 ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(summary)
  ) {
    throw new VeraRuntimeConfigurationError(
      "The Vera Studio version summary is invalid.",
    );
  }
  return summary;
}

function safeDocxFile(file: File): File {
  const filename = file.name.trim();
  const mimeType = file.type.trim().toLowerCase();
  if (
    !filename ||
    filename.length > 240 ||
    filename === "." ||
    filename === ".." ||
    /[\u0000-\u001f\u007f-\u009f\\/]/u.test(filename) ||
    !filename.toLowerCase().endsWith(".docx") ||
    !Number.isSafeInteger(file.size) ||
    file.size < 1 ||
    file.size > MAX_STUDIO_DOCX_BYTES ||
    (mimeType !== "" &&
      mimeType !== "application/octet-stream" &&
      mimeType !== VERA_STUDIO_DOCX_MIME_TYPE)
  ) {
    throw new VeraRuntimeConfigurationError(
      "The Vera Studio DOCX file is invalid.",
    );
  }
  return file;
}

function safeDocxFilename(value: string | null): string {
  if (
    value === null ||
    !value ||
    value.length > 240 ||
    /[\u0000-\u001f\u007f-\u009f\\/]/u.test(value) ||
    !value.toLowerCase().endsWith(".docx")
  ) {
    return invalidWire("Studio DOCX filename");
  }
  return value;
}

export function parseVeraStudioDocxImport(
  value: unknown,
): VeraStudioDocxImportWire {
  const wire = record(value, "Studio DOCX import");
  exactKeys(wire, ["document", "warnings"], "Studio DOCX import");
  return {
    document: parseCurrentVeraStudioDocument(wire.document),
    warnings: docxWarningCodes(wire.warnings, "Studio DOCX import warnings"),
  };
}

export async function createVeraStudioDocument(
  projectId: string,
  input: CreateVeraStudioDocumentInput,
  signal?: AbortSignal,
): Promise<VeraStudioDocumentWire> {
  return parseCurrentVeraStudioDocument(
    await veraApiRequest<unknown>(studioDocumentPath(projectId), {
      method: "POST",
      json: {
        title: safeTitle(input.title),
        ...(input.folder_id === undefined
          ? {}
          : {
              folder_id:
                input.folder_id === null
                  ? null
                  : safeId(input.folder_id, "folder id"),
            }),
        ...(input.document_type === undefined
          ? {}
          : { document_type: safeDocumentType(input.document_type) }),
      },
      signal,
    }),
  );
}

export async function listVeraStudioDrafts(
  projectId: string,
  query: VeraStudioDraftListQuery = {},
  signal?: AbortSignal,
): Promise<VeraStudioDraftPageWire> {
  const limit = query.limit ?? MAX_STUDIO_DRAFTS_PER_PAGE;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_STUDIO_DRAFTS_PER_PAGE
  ) {
    throw new VeraRuntimeConfigurationError(
      "The Vera Studio draft page limit is invalid.",
    );
  }
  const projectIdValue = safeId(projectId, "project id");
  const page = parseVeraStudioDraftPage(
    await veraApiRequest<unknown>(`/projects/${projectIdValue}/studio/drafts`, {
      query: {
        limit,
        ...(query.cursor === undefined
          ? {}
          : { cursor: safeDraftCursor(query.cursor) }),
      },
      signal,
    }),
  );
  if (page.items.some((item) => item.project_id !== projectIdValue)) {
    invalidWire("Studio draft project scope");
  }
  return page;
}

export async function listVeraStudioTemplates(
  projectId: string,
  signal?: AbortSignal,
): Promise<VeraStudioTemplateListWire> {
  return parseVeraStudioTemplateList(
    await veraApiRequest<unknown>(
      `/projects/${safeId(projectId, "project id")}/studio/templates`,
      { signal },
    ),
  );
}

export async function getVeraStudioTemplate(
  projectId: string,
  templateId: string,
  signal?: AbortSignal,
): Promise<VeraStudioTemplateWire> {
  const parsedTemplateId = safeId(templateId, "Studio template id");
  const template = parseVeraStudioTemplate(
    await veraApiRequest<unknown>(
      `/projects/${safeId(projectId, "project id")}/studio/templates/${parsedTemplateId}`,
      { signal },
    ),
  );
  if (template.template_id !== parsedTemplateId) {
    invalidWire("Studio template identity");
  }
  return template;
}

export async function createVeraStudioDraftFromTemplate(
  projectId: string,
  templateId: string,
  input: CreateVeraStudioDraftFromTemplateInput,
  signal?: AbortSignal,
): Promise<VeraStudioTemplateDraftWire> {
  const projectIdValue = safeId(projectId, "project id");
  const result = parseVeraStudioTemplateDraft(
    await veraApiRequest<unknown>(
      `/projects/${projectIdValue}/studio/templates/${safeId(templateId, "Studio template id")}/drafts`,
      {
        method: "POST",
        json: {
          ...(input.title === undefined
            ? {}
            : { title: safeTitle(input.title) }),
          ...(input.folder_id === undefined
            ? {}
            : {
                folder_id:
                  input.folder_id === null
                    ? null
                    : safeId(input.folder_id, "folder id"),
              }),
        },
        signal,
      },
    ),
  );
  if (result.document.project_id !== projectIdValue) {
    invalidWire("Studio template draft Project binding");
  }
  return result;
}

export async function createVeraStudioDraftFromAssistant(
  projectId: string,
  input: CreateVeraStudioDraftFromAssistantInput,
  signal?: AbortSignal,
): Promise<VeraStudioDocumentWire> {
  return parseCurrentVeraStudioDocument(
    await veraApiRequest<unknown>(
      `/projects/${safeId(projectId, "project id")}/studio/drafts/from-assistant`,
      {
        method: "POST",
        json: {
          chat_id: safeId(input.chat_id, "Assistant chat id"),
          assistant_message_id: safeId(
            input.assistant_message_id,
            "Assistant message id",
          ),
        },
        signal,
      },
    ),
  );
}

export async function createVeraStudioDraftFromWorkflow(
  projectId: string,
  input: CreateVeraStudioDraftFromWorkflowInput,
  signal?: AbortSignal,
): Promise<VeraStudioDocumentWire> {
  return parseCurrentVeraStudioDocument(
    await veraApiRequest<unknown>(
      `/projects/${safeId(projectId, "project id")}/studio/drafts/from-workflow`,
      {
        method: "POST",
        json: {
          workflow_run_id: safeId(input.workflow_run_id, "Workflow run id"),
        },
        signal,
      },
    ),
  );
}

export async function getVeraStudioDocument(
  projectId: string,
  documentId: string,
  versionId?: string,
  signal?: AbortSignal,
): Promise<VeraStudioDocumentWire> {
  const response = await veraApiRequest<unknown>(
    studioDocumentPath(projectId, documentId),
    {
      query: versionId
        ? { version_id: safeId(versionId, "Studio version id") }
        : {},
      signal,
    },
  );
  return versionId
    ? parseVeraStudioDocument(response)
    : parseCurrentVeraStudioDocument(response);
}

export async function saveVeraStudioDocument(
  projectId: string,
  documentId: string,
  input: SaveVeraStudioDocumentInput,
  signal?: AbortSignal,
): Promise<VeraStudioDocumentWire> {
  let content: string;
  try {
    content = studioContent(input.content);
  } catch {
    throw new VeraRuntimeConfigurationError(
      "The Vera Studio document content is invalid.",
    );
  }
  return parseCurrentVeraStudioDocument(
    await veraApiRequest<unknown>(studioDocumentPath(projectId, documentId), {
      method: "PUT",
      json: {
        expected_version_id: safeId(
          input.expected_version_id,
          "expected Studio version id",
        ),
        content,
        source: input.source,
        ...(input.citation_anchor_ids === undefined
          ? {}
          : {
              citation_anchor_ids: uuidArray(
                input.citation_anchor_ids,
                "Studio citation ids",
              ),
            }),
        ...(input.summary === undefined
          ? {}
          : { summary: safeSummary(input.summary) }),
      },
      signal,
    }),
  );
}

export async function listVeraStudioVersions(
  projectId: string,
  documentId: string,
  signal?: AbortSignal,
): Promise<VeraStudioVersionsWire> {
  return parseVeraStudioVersions(
    await veraApiRequest<unknown>(
      `${studioDocumentPath(projectId, documentId)}/versions`,
      { signal },
    ),
  );
}

export async function listVeraStudioSuggestions(
  projectId: string,
  documentId: string,
  signal?: AbortSignal,
): Promise<VeraStudioSuggestionPreviewPageWire> {
  const page = parseVeraStudioSuggestionList(
    await veraApiRequest<unknown>(
      `${studioDocumentPath(projectId, documentId)}/suggestions`,
      { signal },
    ),
  );
  if (
    new Set(page.suggestions.map((suggestion) => suggestion.id)).size !==
      page.suggestions.length ||
    page.suggestions.some(
      (suggestion) =>
        suggestion.project_id !== projectId ||
        suggestion.document_id !== documentId,
    )
  ) {
    invalidWire("Studio suggestion list binding");
  }
  return page;
}

export async function getVeraStudioSuggestion(
  projectId: string,
  documentId: string,
  suggestionId: string,
  signal?: AbortSignal,
): Promise<VeraStudioSuggestionWire> {
  const response = record(
    await veraApiRequest<unknown>(
      `${studioDocumentPath(projectId, documentId)}/suggestions/${safeId(suggestionId, "Studio suggestion id")}`,
      { signal },
    ),
    "Studio suggestion detail",
  );
  exactKeys(response, ["suggestion"], "Studio suggestion detail");
  const suggestion = parseVeraStudioSuggestion(response.suggestion);
  if (
    suggestion.id !== suggestionId ||
    suggestion.project_id !== projectId ||
    suggestion.document_id !== documentId
  ) {
    invalidWire("Studio suggestion detail binding");
  }
  return suggestion;
}

export async function acceptVeraStudioSuggestion(
  projectId: string,
  documentId: string,
  expectation: VeraStudioSuggestionAcceptanceExpectation,
  signal?: AbortSignal,
): Promise<VeraStudioSuggestionAcceptanceWire> {
  const { reviewedSuggestion, baseDocument } = expectation;
  if (
    reviewedSuggestion.project_id !== projectId ||
    reviewedSuggestion.document_id !== documentId ||
    reviewedSuggestion.status !== "pending" ||
    reviewedSuggestion.resolved_at !== null ||
    reviewedSuggestion.result_version_id !== null ||
    baseDocument.project_id !== projectId ||
    baseDocument.document_id !== documentId ||
    baseDocument.version.id !== baseDocument.current_version_id ||
    reviewedSuggestion.base_version_id !== baseDocument.current_version_id ||
    reviewedSuggestion.end_offset > baseDocument.content.length ||
    baseDocument.content.slice(
      reviewedSuggestion.start_offset,
      reviewedSuggestion.end_offset,
    ) !== reviewedSuggestion.deleted_text
  ) {
    invalidWire("Studio suggestion acceptance expectation");
  }
  const suggestionId = reviewedSuggestion.id;
  const expectedContent =
    baseDocument.content.slice(0, reviewedSuggestion.start_offset) +
    reviewedSuggestion.inserted_text +
    baseDocument.content.slice(reviewedSuggestion.end_offset);
  const response = record(
    await veraApiRequest<unknown>(
      `${studioDocumentPath(projectId, documentId)}/suggestions/${safeId(suggestionId, "Studio suggestion id")}/accept`,
      { method: "POST", json: {}, signal },
    ),
    "Studio suggestion acceptance",
  );
  exactKeys(
    response,
    ["suggestion", "document"],
    "Studio suggestion acceptance",
  );
  const suggestion = parseVeraStudioSuggestion(response.suggestion);
  const document = parseCurrentVeraStudioDocument(response.document);
  if (
    suggestion.id !== suggestionId ||
    suggestion.project_id !== projectId ||
    suggestion.document_id !== documentId ||
    suggestion.status !== "accepted" ||
    suggestion.result_version_id !== document.version.id ||
    suggestion.project_id !== document.project_id ||
    suggestion.document_id !== document.document_id ||
    !sameSuggestionImmutableFields(suggestion, reviewedSuggestion) ||
    document.version.source !== "user_accept" ||
    document.version.version_number !==
      baseDocument.version.version_number + 1 ||
    document.content !== expectedContent ||
    !sameCitationProvenance(document, baseDocument)
  ) {
    invalidWire("Studio suggestion acceptance binding");
  }
  return { suggestion, document };
}

export async function rejectVeraStudioSuggestion(
  projectId: string,
  documentId: string,
  suggestionId: string,
  signal?: AbortSignal,
): Promise<VeraStudioSuggestionWire> {
  const response = record(
    await veraApiRequest<unknown>(
      `${studioDocumentPath(projectId, documentId)}/suggestions/${safeId(suggestionId, "Studio suggestion id")}/reject`,
      { method: "POST", json: {}, signal },
    ),
    "Studio suggestion rejection",
  );
  exactKeys(response, ["suggestion"], "Studio suggestion rejection");
  const suggestion = parseVeraStudioSuggestion(response.suggestion);
  if (
    suggestion.id !== suggestionId ||
    suggestion.project_id !== projectId ||
    suggestion.document_id !== documentId ||
    suggestion.status !== "rejected"
  ) {
    invalidWire("Studio suggestion rejection status");
  }
  return suggestion;
}

export async function restoreVeraStudioVersion(
  projectId: string,
  documentId: string,
  versionId: string,
  input: RestoreVeraStudioVersionInput,
  signal?: AbortSignal,
): Promise<VeraStudioDocumentWire> {
  return parseCurrentVeraStudioDocument(
    await veraApiRequest<unknown>(
      `${studioDocumentPath(projectId, documentId)}/versions/${safeId(versionId, "Studio version id")}/restore`,
      {
        method: "POST",
        json: {
          expected_current_version_id: safeId(
            input.expected_current_version_id,
            "expected Studio version id",
          ),
        },
        signal,
      },
    ),
  );
}

export async function importVeraStudioDocx(
  projectId: string,
  documentId: string,
  expectedVersionId: string,
  file: File,
  signal?: AbortSignal,
): Promise<VeraStudioDocxImportWire> {
  const checkedFile = safeDocxFile(file);
  const form = new FormData();
  form.append(
    "expected_version_id",
    safeId(expectedVersionId, "expected Studio version id"),
  );
  form.append("file", checkedFile, checkedFile.name);
  return parseVeraStudioDocxImport(
    await veraApiRequest<unknown>(
      `${studioDocumentPath(projectId, documentId)}/import-docx`,
      { method: "POST", body: form, signal },
    ),
  );
}

export async function exportVeraStudioDocx(
  projectId: string,
  documentId: string,
  versionId?: string,
  signal?: AbortSignal,
): Promise<VeraStudioDocxDownload> {
  const response = await veraApiBlobRequest(
    `${studioDocumentPath(projectId, documentId)}/export-docx`,
    {
      query: versionId
        ? { version_id: safeId(versionId, "Studio version id") }
        : {},
      signal,
    },
    { warningCodeAllowlist: VERA_STUDIO_DOCX_WARNING_CODES },
  );
  if (
    response.blob.size < 1 ||
    response.blob.size > MAX_STUDIO_DOCX_BYTES ||
    response.blob.type.toLowerCase() !== VERA_STUDIO_DOCX_MIME_TYPE
  ) {
    invalidWire("Studio DOCX download");
  }
  return {
    blob: response.blob,
    filename: safeDocxFilename(response.filename),
    warningCodes: docxWarningCodes(
      response.warningCodes ?? [],
      "Studio DOCX download warnings",
    ),
  };
}
