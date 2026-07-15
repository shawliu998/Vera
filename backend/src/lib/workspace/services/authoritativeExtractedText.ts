import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

import type { BlobStore } from "../blobStore";
import type { WorkspaceDatabaseAdapter } from "../database";
import { WorkspaceApiError } from "../errors";
import type { TabularSourceRef } from "../repositories/tabular";
import { WorkspaceBlobRecordsRepository } from "../repositories/blobRecords";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_EXACT_QUOTE_CHARS = 8_000;

export type AuthoritativeExtractedTextSnapshot = Readonly<{
  documentId: string;
  projectId: string;
  versionId: string;
  blobRecordId: string;
  title: string;
  filename: string;
  sourceContentSha256: string;
  textSha256: string;
  textBytes: number;
}>;

export type AuthoritativeExtractedText = AuthoritativeExtractedTextSnapshot &
  Readonly<{ text: string }>;

type SnapshotRow = Record<string, unknown>;

function sha256(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex");
}
function invalidSnapshot(message: string): never {
  throw new WorkspaceApiError(409, "CONFLICT", message);
}

function corruptSnapshot(message: string): never {
  throw new WorkspaceApiError(500, "INTERNAL_ERROR", message);
}

function assertUuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new WorkspaceApiError(
      400,
      "VALIDATION_ERROR",
      `${label} is invalid.`,
    );
  }
  return value;
}

function assertHash(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    corruptSnapshot(`Persisted ${label} is invalid.`);
  }
  return value;
}

function assertBound(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new WorkspaceApiError(
      400,
      "VALIDATION_ERROR",
      `${label} must be a positive safe integer.`,
    );
  }
  return value;
}

function persistedString(value: unknown, label: string) {
  if (typeof value !== "string" || !value) {
    corruptSnapshot(`Persisted ${label} is invalid.`);
  }
  return value;
}

function persistedBytes(value: unknown, label: string) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    corruptSnapshot(`Persisted ${label} is invalid.`);
  }
  return number;
}

function decodeStrictUtf8(bytes: Uint8Array) {
  try {
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: false,
    }).decode(bytes);
    if (text.includes("\0")) {
      corruptSnapshot("Extracted document text contains an invalid NUL byte.");
    }
    return text;
  } catch (error) {
    if (error instanceof WorkspaceApiError) throw error;
    corruptSnapshot("Extracted document text is not valid UTF-8.");
  }
}

function mapSnapshot(row: SnapshotRow): AuthoritativeExtractedTextSnapshot {
  const snapshot = {
    documentId: persistedString(row.document_id, "document id"),
    projectId: persistedString(row.project_id, "document project id"),
    versionId: persistedString(row.version_id, "document version id"),
    blobRecordId: persistedString(row.blob_record_id, "blob record id"),
    title: persistedString(row.title, "document title"),
    filename: persistedString(row.filename, "document filename"),
    sourceContentSha256: assertHash(
      row.source_content_sha256,
      "document source hash",
    ),
    textSha256: assertHash(row.text_sha256, "extracted text hash"),
    textBytes: persistedBytes(row.text_bytes, "extracted text size"),
  };
  for (const [label, value] of [
    ["document id", snapshot.documentId],
    ["document project id", snapshot.projectId],
    ["document version id", snapshot.versionId],
    ["blob record id", snapshot.blobRecordId],
  ] as const) {
    if (!UUID.test(value)) corruptSnapshot(`Persisted ${label} is invalid.`);
  }
  return snapshot;
}

function sameSnapshot(
  left: AuthoritativeExtractedTextSnapshot,
  right: AuthoritativeExtractedTextSnapshot,
) {
  return (
    left.documentId === right.documentId &&
    left.projectId === right.projectId &&
    left.versionId === right.versionId &&
    left.blobRecordId === right.blobRecordId &&
    left.sourceContentSha256 === right.sourceContentSha256 &&
    left.textSha256 === right.textSha256 &&
    left.textBytes === right.textBytes
  );
}

/**
 * Reads immutable, document-level extracted text from the existing encrypted
 * blob store. Document chunks are never concatenated into model input.
 */
export class AuthoritativeExtractedTextReader {
  private readonly records: WorkspaceBlobRecordsRepository;

  constructor(
    private readonly database: WorkspaceDatabaseAdapter,
    private readonly blobs: BlobStore,
    private readonly options: {
      assertModelUse?: (input: {
        projectId: string;
        documentId: string;
        versionId: string;
      }) => void;
    } = {},
  ) {
    this.records = new WorkspaceBlobRecordsRepository(database);
  }

  private currentRow(projectId: string, documentId: string) {
    return this.database
      .prepare(
        `SELECT document.id AS document_id,
                document.project_id,
                document.title,
                version.id AS version_id,
                version.filename,
                version.content_sha256 AS source_content_sha256,
                blob.id AS blob_record_id,
                blob.content_sha256 AS text_sha256,
                blob.size_bytes AS text_bytes
           FROM documents document
           JOIN document_versions version
             ON version.id = document.current_version_id
            AND version.document_id = document.id
            AND version.deleted_at IS NULL
           JOIN workspace_blob_records blob
             ON blob.kind = 'extracted_text'
            AND blob.document_id = document.id
            AND blob.version_id = version.id
            AND blob.state = 'stored'
          WHERE document.id = ?
            AND document.project_id = ?
            AND document.deleted_at IS NULL
            AND document.parse_status = 'ready'`,
      )
      .get(documentId, projectId) as SnapshotRow | undefined;
  }

  currentSnapshot(input: {
    projectId: string;
    documentId: string;
    maxTextBytes: number;
  }): AuthoritativeExtractedTextSnapshot {
    const projectId = assertUuid(input.projectId, "projectId");
    const documentId = assertUuid(input.documentId, "documentId");
    const maxTextBytes = assertBound(input.maxTextBytes, "maxTextBytes");
    const row = this.currentRow(projectId, documentId);
    if (!row) {
      invalidSnapshot(
        "A ready current-version extracted-text snapshot is unavailable.",
      );
    }
    const snapshot = mapSnapshot(row);
    this.options.assertModelUse?.({
      projectId: snapshot.projectId,
      documentId: snapshot.documentId,
      versionId: snapshot.versionId,
    });
    if (snapshot.textBytes > maxTextBytes) {
      throw new WorkspaceApiError(
        413,
        "VALIDATION_ERROR",
        "Extracted document text exceeds the tabular input budget.",
      );
    }
    return snapshot;
  }

  currentSnapshots(input: {
    projectId: string;
    documentIds: readonly string[];
    maxTextBytes: number;
  }): AuthoritativeExtractedTextSnapshot[] {
    if (new Set(input.documentIds).size !== input.documentIds.length) {
      throw new WorkspaceApiError(
        400,
        "VALIDATION_ERROR",
        "Document ids must be unique.",
      );
    }
    return input.documentIds.map((documentId) =>
      this.currentSnapshot({
        projectId: input.projectId,
        documentId,
        maxTextBytes: input.maxTextBytes,
      }),
    );
  }

  /**
   * Final synchronous model-boundary preflight. Re-load the current immutable
   * snapshot and re-run the retention callback so a source tombstoned after
   * its text was read cannot cross into a provider request.
   */
  assertCurrentModelUse(expected: AuthoritativeExtractedTextSnapshot): void {
    const current = this.currentSnapshot({
      projectId: expected.projectId,
      documentId: expected.documentId,
      maxTextBytes: Number.MAX_SAFE_INTEGER,
    });
    if (!sameSnapshot(expected, current)) {
      invalidSnapshot("The document snapshot changed before model execution.");
    }
  }

  read(
    expected: AuthoritativeExtractedTextSnapshot,
    maxTextBytes: number,
  ): AuthoritativeExtractedText {
    assertBound(maxTextBytes, "maxTextBytes");
    const current = this.currentSnapshot({
      projectId: expected.projectId,
      documentId: expected.documentId,
      maxTextBytes,
    });
    if (!sameSnapshot(expected, current)) {
      invalidSnapshot("The document snapshot changed before generation.");
    }
    const record = this.records.getById(expected.blobRecordId);
    if (
      !record ||
      record.state !== "stored" ||
      record.locator.kind !== "extracted_text" ||
      record.locator.documentId !== expected.documentId ||
      record.locator.versionId !== expected.versionId ||
      record.contentSha256 !== expected.textSha256 ||
      record.sizeBytes !== expected.textBytes
    ) {
      corruptSnapshot("Extracted document blob metadata is inconsistent.");
    }
    const bytes = this.blobs.readSync(record.locator, {
      sha256: expected.textSha256,
      size: expected.textBytes,
    });
    // BlobStore already checks integrity at the encrypted storage boundary;
    // re-check here so alternate BlobStore implementations cannot weaken the
    // authoritative reader contract.
    if (
      bytes.byteLength !== expected.textBytes ||
      sha256(bytes) !== expected.textSha256
    ) {
      corruptSnapshot("Extracted document blob failed integrity verification.");
    }
    this.options.assertModelUse?.({
      projectId: expected.projectId,
      documentId: expected.documentId,
      versionId: expected.versionId,
    });
    return { ...expected, text: decodeStrictUtf8(bytes) };
  }

  exactQuoteSource(input: {
    snapshot: AuthoritativeExtractedText;
    quote: string;
  }): TabularSourceRef {
    const quote = input.quote;
    if (
      typeof quote !== "string" ||
      quote.trim().length === 0 ||
      quote.length > MAX_EXACT_QUOTE_CHARS ||
      quote.includes("\0")
    ) {
      throw new WorkspaceApiError(
        502,
        "JOB_FAILED",
        "Tabular model returned an invalid source quote.",
      );
    }
    const offsets: number[] = [];
    for (let from = 0; from <= input.snapshot.text.length - quote.length; ) {
      const offset = input.snapshot.text.indexOf(quote, from);
      if (offset < 0) break;
      offsets.push(offset);
      if (offsets.length > 1) break;
      from = offset + Math.max(quote.length, 1);
    }
    if (offsets.length !== 1) {
      throw new WorkspaceApiError(
        502,
        "JOB_FAILED",
        "Tabular source quote is not unique in the authoritative document text.",
      );
    }
    const startOffset = offsets[0]!;
    const endOffset = startOffset + quote.length;
    const rows = this.database
      .prepare(
        `SELECT id, text, start_offset, end_offset, page_start, page_end,
                content_sha256
           FROM document_chunks
          WHERE document_id = ?
            AND version_id = ?
            AND start_offset <= ?
            AND end_offset >= ?
          ORDER BY ordinal, id`,
      )
      .all(
        input.snapshot.documentId,
        input.snapshot.versionId,
        startOffset,
        endOffset,
      );
    const valid = rows.filter((row) => {
      if (
        typeof row.id !== "string" ||
        !UUID.test(row.id) ||
        typeof row.text !== "string" ||
        typeof row.content_sha256 !== "string"
      ) {
        return false;
      }
      const chunkStart = Number(row.start_offset);
      const chunkEnd = Number(row.end_offset);
      return (
        Number.isSafeInteger(chunkStart) &&
        Number.isSafeInteger(chunkEnd) &&
        chunkStart >= 0 &&
        chunkEnd >= chunkStart &&
        chunkEnd - chunkStart === row.text.length &&
        sha256(row.text) === row.content_sha256 &&
        input.snapshot.text.slice(chunkStart, chunkEnd) === row.text &&
        row.text.slice(startOffset - chunkStart, endOffset - chunkStart) ===
          quote
      );
    });
    if (valid.length !== 1) {
      throw new WorkspaceApiError(
        502,
        "JOB_FAILED",
        "Tabular source quote cannot be resolved to one local document chunk.",
      );
    }
    const chunk = valid[0]!;
    return {
      documentId: input.snapshot.documentId,
      versionId: input.snapshot.versionId,
      chunkId: String(chunk.id),
      quote,
      startOffset,
      endOffset,
    };
  }
}
