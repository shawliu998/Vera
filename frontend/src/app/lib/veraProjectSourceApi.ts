import { veraApiRequest, VeraApiError } from "./veraApi";
import { VeraRuntimeConfigurationError } from "./veraRuntime";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_SOURCE_CHUNKS = 20;
const MAX_SOURCE_CHUNK_UTF8_BYTES = 64 * 1024;
const MAX_SOURCE_RESPONSE_UTF8_BYTES = 256 * 1024;

export interface VeraProjectSourceDocumentWire {
  document_id: string;
  version_id: string;
  title: string;
  filename: string;
  mime_type: string;
  content_sha256: string;
  page_count: number | null;
}

export interface VeraProjectSourceChunkWire {
  id: string;
  ordinal: number;
  text: string;
  content_sha256: string;
  start_offset: number;
  end_offset: number;
  page_start: number | null;
  page_end: number | null;
}

export interface VeraProjectSourceContentWire {
  snapshot_id: string;
  document: VeraProjectSourceDocumentWire;
  chunks: VeraProjectSourceChunkWire[];
  next_cursor: string | null;
}

export interface VeraProjectCitationReference {
  snapshot_id: string;
  exact_quote: string;
  quote_sha256: string;
  locator: Readonly<Record<string, unknown>>;
}

export interface VeraResolvedProjectCitation {
  snapshot_id: string;
  document: VeraProjectSourceDocumentWire;
  chunk: VeraProjectSourceChunkWire;
  exact_quote: string;
  quote_start: number;
  quote_end: number;
  page: number | null;
}

function invalidWire(label: string): never {
  throw new VeraApiError({
    status: 200,
    code: "INVALID_RESPONSE",
    message: `The Vera API returned invalid ${label}.`,
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
  const expected = new Set(allowed);
  if (Object.keys(value).some((key) => !expected.has(key))) invalidWire(label);
}

function boundedString(
  value: unknown,
  label: string,
  maxLength: number,
): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maxLength ||
    value.includes("\0")
  ) {
    return invalidWire(label);
  }
  return value;
}

function uuid(value: unknown, label: string): string {
  const parsed = boundedString(value, label, 36);
  if (!UUID_PATTERN.test(parsed)) invalidWire(label);
  return parsed;
}

function sha256(value: unknown, label: string): string {
  const parsed = boundedString(value, label, 64);
  if (!SHA256_PATTERN.test(parsed)) invalidWire(label);
  return parsed;
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) invalidWire(label);
  return Number(value);
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = nonnegativeInteger(value, label);
  if (parsed < 1) invalidWire(label);
  return parsed;
}

function nullablePositiveInteger(value: unknown, label: string): number | null {
  return value === null ? null : positiveInteger(value, label);
}

function parseDocument(value: unknown): VeraProjectSourceDocumentWire {
  const wire = record(value, "Project source document");
  exactKeys(
    wire,
    [
      "document_id",
      "version_id",
      "title",
      "filename",
      "mime_type",
      "content_sha256",
      "page_count",
    ],
    "Project source document",
  );
  const filename = boundedString(wire.filename, "Project source filename", 240);
  if (/[\u0000-\u001f\u007f\\/]/u.test(filename)) {
    invalidWire("Project source filename");
  }
  const mimeType = boundedString(
    wire.mime_type,
    "Project source MIME type",
    255,
  );
  if (/[\u0000-\u001f\u007f]/u.test(mimeType)) {
    invalidWire("Project source MIME type");
  }
  return {
    document_id: uuid(wire.document_id, "Project source document id"),
    version_id: uuid(wire.version_id, "Project source version id"),
    title: boundedString(wire.title, "Project source title", 500),
    filename,
    mime_type: mimeType,
    content_sha256: sha256(wire.content_sha256, "Project source document hash"),
    page_count:
      wire.page_count === null
        ? null
        : nonnegativeInteger(wire.page_count, "Project source page count"),
  };
}

function parseChunk(value: unknown): VeraProjectSourceChunkWire {
  const wire = record(value, "Project source chunk");
  exactKeys(
    wire,
    [
      "id",
      "ordinal",
      "text",
      "content_sha256",
      "start_offset",
      "end_offset",
      "page_start",
      "page_end",
    ],
    "Project source chunk",
  );
  const text = boundedString(wire.text, "Project source chunk text", 65_536);
  if (new TextEncoder().encode(text).byteLength > MAX_SOURCE_CHUNK_UTF8_BYTES) {
    invalidWire("Project source chunk text");
  }
  const startOffset = nonnegativeInteger(
    wire.start_offset,
    "Project source chunk start offset",
  );
  const endOffset = nonnegativeInteger(
    wire.end_offset,
    "Project source chunk end offset",
  );
  if (endOffset < startOffset || endOffset - startOffset < text.length) {
    invalidWire("Project source chunk offsets");
  }
  const pageStart = nullablePositiveInteger(
    wire.page_start,
    "Project source chunk page start",
  );
  const pageEnd = nullablePositiveInteger(
    wire.page_end,
    "Project source chunk page end",
  );
  if (
    (pageStart === null) !== (pageEnd === null) ||
    (pageStart !== null && pageEnd !== null && pageEnd < pageStart)
  ) {
    invalidWire("Project source chunk page bounds");
  }
  return {
    id: uuid(wire.id, "Project source chunk id"),
    ordinal: nonnegativeInteger(wire.ordinal, "Project source chunk ordinal"),
    text,
    content_sha256: sha256(wire.content_sha256, "Project source chunk hash"),
    start_offset: startOffset,
    end_offset: endOffset,
    page_start: pageStart,
    page_end: pageEnd,
  };
}

export function parseVeraProjectSourceContent(
  value: unknown,
): VeraProjectSourceContentWire {
  const wire = record(value, "Project source content");
  exactKeys(
    wire,
    ["snapshot_id", "document", "chunks", "next_cursor"],
    "Project source content",
  );
  if (!Array.isArray(wire.chunks) || wire.chunks.length > MAX_SOURCE_CHUNKS) {
    invalidWire("Project source chunks");
  }
  const document = parseDocument(wire.document);
  const chunks = wire.chunks.map(parseChunk);
  const pageCount = document.page_count;
  if (
    pageCount !== null &&
    chunks.some(
      (chunk) => chunk.page_end !== null && chunk.page_end > pageCount,
    )
  ) {
    invalidWire("Project source chunk page bounds");
  }
  if (
    chunks.reduce(
      (total, chunk) => total + new TextEncoder().encode(chunk.text).byteLength,
      0,
    ) > MAX_SOURCE_RESPONSE_UTF8_BYTES
  ) {
    invalidWire("Project source content size");
  }
  const nextCursor =
    wire.next_cursor === null
      ? null
      : boundedString(wire.next_cursor, "Project source cursor", 512);
  if (nextCursor !== null && !/^[A-Za-z0-9_-]+$/.test(nextCursor)) {
    invalidWire("Project source cursor");
  }
  return {
    snapshot_id: uuid(wire.snapshot_id, "Project source snapshot id"),
    document,
    chunks,
    next_cursor: nextCursor,
  };
}

function safeId(value: string, label: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw new VeraRuntimeConfigurationError(`The Vera ${label} is invalid.`);
  }
  return value;
}

export async function getVeraProjectSourceContent(
  projectId: string,
  snapshotId: string,
  options: { chunkId?: string; cursor?: string; limit?: number } = {},
  signal?: AbortSignal,
): Promise<VeraProjectSourceContentWire> {
  if (
    options.chunkId !== undefined &&
    (options.cursor !== undefined || options.limit !== undefined)
  ) {
    throw new VeraRuntimeConfigurationError(
      "A direct Vera source chunk request cannot be paginated.",
    );
  }
  if (
    options.limit !== undefined &&
    (!Number.isSafeInteger(options.limit) ||
      options.limit < 1 ||
      options.limit > MAX_SOURCE_CHUNKS)
  ) {
    throw new VeraRuntimeConfigurationError(
      "The Vera source content page size is invalid.",
    );
  }
  if (
    options.cursor !== undefined &&
    (!options.cursor ||
      options.cursor.length > 512 ||
      !/^[A-Za-z0-9_-]+$/.test(options.cursor))
  ) {
    throw new VeraRuntimeConfigurationError(
      "The Vera source content cursor is invalid.",
    );
  }
  const parsedSnapshotId = safeId(snapshotId, "source snapshot id");
  const result = parseVeraProjectSourceContent(
    await veraApiRequest<unknown>(
      `/projects/${safeId(projectId, "project id")}/sources/${parsedSnapshotId}/content`,
      {
        query: {
          ...(options.chunkId
            ? { chunk_id: safeId(options.chunkId, "source chunk id") }
            : {}),
          ...(options.cursor ? { cursor: options.cursor } : {}),
          ...(options.limit === undefined ? {} : { limit: options.limit }),
        },
        signal,
      },
    ),
  );
  if (result.snapshot_id !== parsedSnapshotId) {
    invalidWire("Project source snapshot binding");
  }
  return result;
}

function requiredLocatorId(
  locator: Readonly<Record<string, unknown>>,
  key: string,
  label: string,
): string {
  return uuid(locator[key], label);
}

function requiredLocatorOffset(
  locator: Readonly<Record<string, unknown>>,
  key: string,
): number {
  return nonnegativeInteger(locator[key], `citation ${key}`);
}

function optionalLocatorPage(value: unknown): number | null {
  return value === null || value === undefined
    ? null
    : positiveInteger(value, "citation page");
}

async function digestUtf8(value: string): Promise<string> {
  if (!globalThis.crypto?.subtle) invalidWire("citation hash runtime");
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** Resolve and independently re-check a persisted Studio citation. */
export async function resolveVeraProjectCitation(
  projectId: string,
  citation: VeraProjectCitationReference,
  signal?: AbortSignal,
): Promise<VeraResolvedProjectCitation> {
  const snapshotId = uuid(citation.snapshot_id, "citation snapshot id");
  const quote = boundedString(citation.exact_quote, "citation quote", 8_000);
  const quoteHash = sha256(citation.quote_sha256, "citation quote hash");
  const locator = record(citation.locator, "citation locator");
  const chunkId = requiredLocatorId(locator, "chunkId", "citation chunk id");
  const versionId = requiredLocatorId(
    locator,
    "documentVersionId",
    "citation document version id",
  );
  const start = requiredLocatorOffset(locator, "startOffset");
  const end = requiredLocatorOffset(locator, "endOffset");
  if (end <= start) invalidWire("citation offsets");

  const content = await getVeraProjectSourceContent(
    projectId,
    snapshotId,
    { chunkId },
    signal,
  );
  if (
    content.document.version_id !== versionId ||
    content.chunks.length !== 1 ||
    content.chunks[0]?.id !== chunkId
  ) {
    invalidWire("citation source binding");
  }
  const chunk = content.chunks[0];
  if (
    end > chunk.text.length ||
    chunk.text.slice(start, end) !== quote ||
    (typeof locator.chunkContentSha256 === "string" &&
      locator.chunkContentSha256 !== chunk.content_sha256)
  ) {
    invalidWire("citation quote binding");
  }
  const [calculatedQuoteHash, calculatedChunkHash] = await Promise.all([
    digestUtf8(quote),
    digestUtf8(chunk.text),
  ]);
  if (
    calculatedQuoteHash !== quoteHash ||
    calculatedChunkHash !== chunk.content_sha256
  ) {
    invalidWire("citation content integrity");
  }

  const locatorPageStart = optionalLocatorPage(locator.pageStart);
  const locatorPageEnd = optionalLocatorPage(locator.pageEnd);
  if (
    locatorPageStart !== chunk.page_start ||
    locatorPageEnd !== chunk.page_end
  ) {
    invalidWire("citation page binding");
  }
  let ocrPage: number | null = null;
  if (locator.ocr !== undefined) {
    const ocr = record(locator.ocr, "citation OCR locator");
    ocrPage = optionalLocatorPage(ocr.page);
    if (
      ocrPage !== null &&
      (chunk.page_start === null ||
        chunk.page_end === null ||
        ocrPage < chunk.page_start ||
        ocrPage > chunk.page_end)
    ) {
      invalidWire("citation OCR page binding");
    }
  }
  return {
    snapshot_id: snapshotId,
    document: content.document,
    chunk,
    exact_quote: quote,
    quote_start: start,
    quote_end: end,
    page: ocrPage ?? locatorPageStart ?? chunk.page_start,
  };
}
