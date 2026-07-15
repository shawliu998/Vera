import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

import {
  assertDocumentChunkMetadataPageBinding,
  parseDocumentChunkMetadataJson,
  type DocumentChunkMetadata,
} from "../documentChunkMetadata";
import { WorkspaceApiError } from "../errors";
import type { WorkspaceDatabaseAdapter } from "../migrations";
import {
  ProjectSourceKindV11Schema,
  SourceDataUsePolicyV11Schema,
  TransportSafeSourceMetadataV11Schema,
  type ProjectSourceKindV11,
  type ProjectSourceSnapshotV11,
  type SourceCitationAnchorV11,
} from "../sourceFoundationContractsV11";
import type { WorkspaceSourceFoundationRepository } from "../repositories/sourceFoundation";
import { LEGAL_SOURCE_RETENTION_ACTIVATION_V13 } from "../sourceRetentionPolicyV13";
import {
  WorkspaceSourceRetentionServiceError,
  type WorkspaceSourceRetentionService,
} from "./sourceRetention";

const Id = z.string().uuid();
const IsoDateTime = z.string().datetime({ offset: true });
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const MAX_PAGE_SIZE = 100;
const MAX_ANCHORS_PER_SOURCE = 200;
const MAX_OCR_BLOCKS_IN_LOCATOR = 32;
const MAX_SOURCE_CONTENT_PAGE_SIZE = 20;
const MAX_SOURCE_CHUNK_UTF8_BYTES = 64 * 1024;
const MAX_SOURCE_CONTENT_RESPONSE_UTF8_BYTES = 256 * 1024;

const CursorPayload = z
  .object({
    retrievedAt: IsoDateTime,
    id: Id,
  })
  .strict();

const ContentCursorPayload = z
  .object({
    ordinal: z.number().int().nonnegative(),
    id: Id,
  })
  .strict();

export type ProjectSourcePage = {
  sources: ProjectSourceSnapshotV11[];
  nextCursor: string | null;
};

export type CaptureProjectDocumentSourceResult = {
  snapshot: ProjectSourceSnapshotV11;
  reused: boolean;
};

export type ProjectSourceDetail = {
  snapshot: ProjectSourceSnapshotV11;
  anchors: ProjectSourceCitationAnchor[];
};

export type ProjectSourceCitationAnchor = Omit<
  SourceCitationAnchorV11,
  "exactQuote"
> & {
  exactQuote: string | null;
  quoteAvailable: boolean;
  accessState: "available" | "tombstoned" | "lifecycle_missing";
  retentionDenialCode: string | null;
};

export type ProjectDocumentSourceContentChunk = {
  id: string;
  ordinal: number;
  text: string;
  contentSha256: string;
  startOffset: number;
  endOffset: number;
  pageStart: number | null;
  pageEnd: number | null;
};

export type ProjectDocumentSourceContent = {
  snapshotId: string;
  document: {
    documentId: string;
    versionId: string;
    title: string;
    filename: string;
    mimeType: string;
    contentSha256: string;
    pageCount: number | null;
  };
  chunks: ProjectDocumentSourceContentChunk[];
  nextCursor: string | null;
};

export type ReadProjectDocumentSourceContentInput = {
  projectId: string;
  snapshotId: string;
  chunkId?: string;
  limit?: number;
  cursor?: string;
};

export type CreateProjectDocumentAnchorInput = {
  projectId: string;
  snapshotId: string;
  chunkId: string;
  exactQuote: string;
  startOffset: number | null;
  endOffset: number | null;
};

/**
 * Trusted integration seam for a future authorized legal provider. It is not
 * exposed by the Project sources HTTP router: callers must provide the full,
 * explicit data-use policy and already-redacted provider metadata.
 */
export type CaptureLegalAuthoritySnapshotInput = {
  projectId: string;
  sourceRecordId: string;
  sourceVersionId: string | null;
  titleSnapshot: string;
  contentSha256: string;
  locator: Record<string, unknown>;
  retrievedAt: string;
  policy: z.input<typeof SourceDataUsePolicyV11Schema>;
  retentionExpiresAt: string | null;
  retrievalMetadata: Record<string, unknown>;
};

function notFound(message = "Source not found."): never {
  throw new WorkspaceApiError(404, "NOT_FOUND", message);
}

function invalid(message: string): never {
  throw new WorkspaceApiError(422, "VALIDATION_ERROR", message);
}

function conflict(message: string): never {
  throw new WorkspaceApiError(409, "CONFLICT", message);
}

function asString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new WorkspaceApiError(
      500,
      "INTERNAL_ERROR",
      `Persisted ${label} is invalid.`,
    );
  }
  return value;
}

function asNonnegativeInteger(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new WorkspaceApiError(
      500,
      "INTERNAL_ERROR",
      `Persisted ${label} is invalid.`,
    );
  }
  return parsed;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function encodeCursor(snapshot: ProjectSourceSnapshotV11): string {
  return Buffer.from(
    JSON.stringify({ retrievedAt: snapshot.retrievedAt, id: snapshot.id }),
    "utf8",
  ).toString("base64url");
}

function decodeCursor(value: string | undefined) {
  if (value === undefined) return null;
  if (
    value.length < 1 ||
    value.length > 512 ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    invalid("Source cursor is invalid.");
  }
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    if (Buffer.byteLength(decoded, "utf8") > 1_024) {
      invalid("Source cursor is invalid.");
    }
    return CursorPayload.parse(JSON.parse(decoded) as unknown);
  } catch (error) {
    if (error instanceof WorkspaceApiError) throw error;
    invalid("Source cursor is invalid.");
  }
}

function encodeContentCursor(chunk: ProjectDocumentSourceContentChunk): string {
  return Buffer.from(
    JSON.stringify({ ordinal: chunk.ordinal, id: chunk.id }),
    "utf8",
  ).toString("base64url");
}

function decodeContentCursor(value: string | undefined) {
  if (value === undefined) return null;
  if (
    value.length < 1 ||
    value.length > 512 ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    invalid("Source content cursor is invalid.");
  }
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    if (Buffer.byteLength(decoded, "utf8") > 1_024) {
      invalid("Source content cursor is invalid.");
    }
    return ContentCursorPayload.parse(JSON.parse(decoded) as unknown);
  } catch (error) {
    if (error instanceof WorkspaceApiError) throw error;
    invalid("Source content cursor is invalid.");
  }
}

function boundedSourceText(value: unknown, label: string): string {
  const text = asString(value, label);
  if (
    text.length < 1 ||
    text.includes("\0") ||
    Buffer.byteLength(text, "utf8") > MAX_SOURCE_CHUNK_UTF8_BYTES
  ) {
    conflict(`Persisted ${label} exceeds the safe source-view boundary.`);
  }
  return text;
}

function safeOcrProjection(
  metadataJson: unknown,
  pageStart: number | null,
  pageEnd: number | null,
  chunkText: string,
  quoteStart: number,
  quoteEnd: number,
): Record<string, unknown> | null {
  let metadata: DocumentChunkMetadata;
  try {
    metadata = parseDocumentChunkMetadataJson(metadataJson);
    assertDocumentChunkMetadataPageBinding(
      metadata,
      pageStart,
      pageEnd,
      chunkText,
    );
  } catch {
    conflict("Document chunk OCR metadata failed integrity validation.");
  }
  if (!("schemaVersion" in metadata)) return null;
  const quotePageStart = metadata.chunkPageTextStart + quoteStart;
  const quotePageEnd = metadata.chunkPageTextStart + quoteEnd;
  // The synthetic `[Page n]` marker precedes page text in the first OCR
  // chunk. Never label marker offsets as page-text coordinates.
  if (quotePageStart < 0 || quotePageEnd <= quotePageStart) return null;
  const matchingBlocks = metadata.blocks.filter(
    (block) => block.textEnd > quotePageStart && block.textStart < quotePageEnd,
  );
  const blocks = matchingBlocks.slice(0, MAX_OCR_BLOCKS_IN_LOCATOR);
  return {
    schemaVersion: metadata.schemaVersion,
    engine: metadata.engine,
    coordinateSpace: metadata.coordinateSpace,
    page: metadata.page,
    chunkPageTextStart: metadata.chunkPageTextStart,
    quotePageStart,
    quotePageEnd,
    pageConfidence: metadata.pageConfidence,
    lowConfidence: metadata.lowConfidence,
    offsetScope: "page_text",
    offsetUnit: "utf16_code_unit",
    blocks,
    blocksTruncated: blocks.length !== matchingBlocks.length,
  };
}

function findOccurrences(text: string, quote: string): number[] {
  const offsets: number[] = [];
  let from = 0;
  while (from <= text.length - quote.length) {
    const match = text.indexOf(quote, from);
    if (match < 0) break;
    offsets.push(match);
    if (offsets.length > 1) break;
    // Advance by one UTF-16 code unit so overlapping matches are also
    // detected (for example, `aa` occurs twice in `aaa`). Automatic anchor
    // resolution must fail closed whenever a quote is not unique; callers can
    // still disambiguate with explicit, slice-verified offsets.
    from = match + 1;
  }
  return offsets;
}

/**
 * Application service for the v11 immutable provenance foundation. It derives
 * every public-write policy, hash, locator, and ordinal on the server.
 */
export class WorkspaceProjectSourcesService {
  constructor(
    private readonly database: WorkspaceDatabaseAdapter,
    private readonly sources: WorkspaceSourceFoundationRepository,
    private readonly options: {
      now?: () => string;
      nextId?: () => string;
      retention?: Pick<
        WorkspaceSourceRetentionService,
        | "assertSnapshotAction"
        | "evaluateSnapshotAction"
        | "readAnchorMetadata"
        | "readAnchorQuote"
      >;
    } = {},
  ) {}

  private assertRetentionAction(
    projectId: string,
    snapshotId: string,
    action: "quote_read" | "anchor_create",
  ) {
    if (!this.options.retention) return;
    try {
      this.options.retention.assertSnapshotAction({
        projectId,
        snapshotId,
        action,
      });
    } catch (error) {
      if (error instanceof WorkspaceSourceRetentionServiceError) {
        throw new WorkspaceApiError(409, "PRECONDITION_FAILED", error.message);
      }
      throw error;
    }
  }

  captureProjectDocumentSnapshot(input: {
    projectId: string;
    documentId: string;
    versionId?: string;
  }): CaptureProjectDocumentSourceResult {
    const parsed = z
      .object({ projectId: Id, documentId: Id, versionId: Id.optional() })
      .strict()
      .safeParse(input);
    if (!parsed.success) invalid("Project document source request is invalid.");

    return this.transaction(() => {
      const row = this.database
        .prepare(
          `SELECT document.id AS document_id,
                document.title AS title,
                version.id AS version_id,
                version.content_sha256 AS content_sha256
           FROM documents document
           JOIN projects project
             ON project.id = document.project_id
            AND project.status <> 'deleted'
           JOIN document_versions version
             ON version.document_id = document.id
            AND version.id = COALESCE(?, document.current_version_id)
            AND version.deleted_at IS NULL
          WHERE document.id = ?
            AND document.project_id = ?
            AND document.deleted_at IS NULL`,
        )
        .get(input.versionId ?? null, input.documentId, input.projectId);
      if (!row) notFound("Project document version not found.");

      const documentId = asString(row.document_id, "document id");
      const versionId = asString(row.version_id, "document version id");
      const title = asString(row.title, "document title");
      const contentSha256 = Sha256.parse(
        asString(row.content_sha256, "document content hash"),
      );
      const now = this.now();

      const existing = this.database
        .prepare(
          `SELECT id
             FROM project_source_snapshots
            WHERE project_id = ?
              AND source_kind = 'project_document'
              AND source_record_id = ?
              AND source_version_id = ?
              AND content_sha256 = ?
            ORDER BY created_at ASC, id ASC
            LIMIT 1`,
        )
        .get(input.projectId, documentId, versionId, contentSha256);
      if (existing) {
        const snapshot = this.sources.getSnapshot(
          input.projectId,
          asString(existing.id, "source snapshot id"),
        );
        if (!snapshot) {
          throw new WorkspaceApiError(
            500,
            "INTERNAL_ERROR",
            "Source snapshot could not be reloaded.",
          );
        }
        return { snapshot, reused: true };
      }
      const snapshot = this.sources.createSnapshot({
        id: this.nextId(),
        projectId: input.projectId,
        sourceKind: "project_document",
        sourceRecordId: documentId,
        sourceVersionId: versionId,
        titleSnapshot: title,
        contentSha256,
        locator: {
          documentVersionId: versionId,
        },
        retrievedAt: now,
        license: {
          basis: "user_provided",
          retention: "full_text_permitted",
          export: "permitted",
          modelUse: "permitted",
        },
        retentionPolicy: "full_text_permitted",
        retentionExpiresAt: null,
        retrievalMetadata: {
          integration: "project_document_version",
          snapshotSchemaVersion: "vera-project-document-source-v1",
        },
        createdAt: now,
      });
      return { snapshot, reused: false };
    });
  }

  listSnapshots(input: {
    projectId: string;
    sourceKind?: ProjectSourceKindV11;
    limit?: number;
    cursor?: string;
  }): ProjectSourcePage {
    if (!Id.safeParse(input.projectId).success)
      invalid("Project id is invalid.");
    let sourceKind: ProjectSourceKindV11 | undefined;
    if (input.sourceKind !== undefined) {
      const parsedKind = ProjectSourceKindV11Schema.safeParse(input.sourceKind);
      if (!parsedKind.success) invalid("Source kind is invalid.");
      sourceKind = parsedKind.data;
    }
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
      invalid(`Source page size must be between 1 and ${MAX_PAGE_SIZE}.`);
    }
    this.assertProjectExists(input.projectId);
    const cursor = decodeCursor(input.cursor);
    const predicates = ["project_id = ?"];
    const parameters: unknown[] = [input.projectId];
    if (sourceKind !== undefined) {
      predicates.push("source_kind = ?");
      parameters.push(sourceKind);
    }
    if (cursor) {
      predicates.push("(retrieved_at < ? OR (retrieved_at = ? AND id > ?))");
      parameters.push(cursor.retrievedAt, cursor.retrievedAt, cursor.id);
    }
    parameters.push(limit + 1);
    const rows = this.database
      .prepare(
        `SELECT id
           FROM project_source_snapshots
          WHERE ${predicates.join(" AND ")}
          ORDER BY retrieved_at DESC, id ASC
          LIMIT ?`,
      )
      .all(...parameters);
    const hasMore = rows.length > limit;
    const selected = hasMore ? rows.slice(0, limit) : rows;
    const snapshots = selected.map((row) => {
      const snapshot = this.sources.getSnapshot(
        input.projectId,
        asString(row.id, "source snapshot id"),
      );
      if (!snapshot) {
        throw new WorkspaceApiError(
          500,
          "INTERNAL_ERROR",
          "Source snapshot could not be reloaded.",
        );
      }
      return this.snapshotView(snapshot);
    });
    return {
      sources: snapshots,
      nextCursor:
        hasMore && snapshots.length > 0
          ? encodeCursor(snapshots[snapshots.length - 1])
          : null,
    };
  }

  getSnapshot(projectId: string, snapshotId: string): ProjectSourceDetail {
    if (!Id.safeParse(projectId).success || !Id.safeParse(snapshotId).success) {
      invalid("Source identifiers are invalid.");
    }
    this.assertProjectExists(projectId);
    const snapshot = this.sources.getSnapshot(projectId, snapshotId);
    if (!snapshot) notFound();
    return {
      snapshot: this.snapshotView(snapshot),
      anchors: this.sources
        .listCitationAnchors({
          projectId,
          snapshotId,
          limit: MAX_ANCHORS_PER_SOURCE,
        })
        .map((anchor) => this.anchorView(anchor, snapshot.sourceKind)),
    };
  }

  /**
   * Returns only a bounded, authenticated projection of immutable Project
   * document chunks. Raw storage locators and parser metadata never cross the
   * route boundary; every row is re-bound to the snapshot and hash-checked.
   */
  readProjectDocumentSourceContent(
    input: ReadProjectDocumentSourceContentInput,
  ): ProjectDocumentSourceContent {
    const identifiers = z
      .object({
        projectId: Id,
        snapshotId: Id,
        chunkId: Id.optional(),
      })
      .strict()
      .safeParse({
        projectId: input.projectId,
        snapshotId: input.snapshotId,
        chunkId: input.chunkId,
      });
    if (!identifiers.success)
      invalid("Source content identifiers are invalid.");
    if (
      input.chunkId &&
      (input.cursor !== undefined || input.limit !== undefined)
    ) {
      invalid("A direct source chunk request cannot be paginated.");
    }
    const limit = input.chunkId ? 1 : (input.limit ?? 10);
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > MAX_SOURCE_CONTENT_PAGE_SIZE
    ) {
      invalid(
        `Source content page size must be between 1 and ${MAX_SOURCE_CONTENT_PAGE_SIZE}.`,
      );
    }
    const cursor = decodeContentCursor(input.cursor);
    this.assertProjectExists(input.projectId);
    const snapshot = this.sources.getSnapshot(
      input.projectId,
      input.snapshotId,
    );
    if (!snapshot) notFound();
    if (snapshot.sourceKind !== "project_document") {
      invalid("Public source content is available only for Project documents.");
    }
    this.assertRetentionAction(input.projectId, input.snapshotId, "quote_read");
    if (!snapshot.sourceVersionId) {
      conflict("Project document source version is unavailable.");
    }

    const document = this.database
      .prepare(
        `SELECT document.id AS document_id,
                version.id AS version_id,
                version.filename,
                version.mime_type,
                version.content_sha256,
                version.page_count
           FROM documents document
           JOIN projects project
             ON project.id = document.project_id
            AND project.status <> 'deleted'
           JOIN document_versions version
             ON version.document_id = document.id
            AND version.id = ?
            AND version.deleted_at IS NULL
          WHERE document.id = ?
            AND document.project_id = ?
            AND document.deleted_at IS NULL`,
      )
      .get(snapshot.sourceVersionId, snapshot.sourceRecordId, input.projectId);
    if (!document) notFound("Project document source version not found.");
    const documentContentSha256 = Sha256.parse(
      asString(document.content_sha256, "document version hash"),
    );
    if (documentContentSha256 !== snapshot.contentSha256) {
      conflict("Source snapshot no longer matches the document version.");
    }
    const pageCount =
      document.page_count === null
        ? null
        : asNonnegativeInteger(document.page_count, "document page count");

    const predicates = ["chunk.document_id = ?", "chunk.version_id = ?"];
    const parameters: unknown[] = [
      snapshot.sourceRecordId,
      snapshot.sourceVersionId,
    ];
    if (input.chunkId) {
      predicates.push("chunk.id = ?");
      parameters.push(input.chunkId);
    } else if (cursor) {
      predicates.push(
        "(chunk.ordinal > ? OR (chunk.ordinal = ? AND chunk.id > ?))",
      );
      parameters.push(cursor.ordinal, cursor.ordinal, cursor.id);
    }
    parameters.push(limit + 1);
    const rows = this.database
      .prepare(
        `SELECT chunk.id,
                chunk.ordinal,
                chunk.text,
                chunk.content_sha256,
                chunk.start_offset,
                chunk.end_offset,
                chunk.page_start,
                chunk.page_end
           FROM document_chunks chunk
          WHERE ${predicates.join(" AND ")}
          ORDER BY chunk.ordinal ASC, chunk.id ASC
          LIMIT ?`,
      )
      .all(...parameters);
    if (input.chunkId && rows.length === 0) {
      notFound("Project document source chunk not found.");
    }
    const hasMoreRows = !input.chunkId && rows.length > limit;
    const selected = hasMoreRows ? rows.slice(0, limit) : rows;
    let responseTextBytes = 0;
    let budgetTruncated = false;
    const chunks: ProjectDocumentSourceContentChunk[] = [];
    for (const row of selected) {
      const text = boundedSourceText(row.text, "source chunk text");
      const textBytes = Buffer.byteLength(text, "utf8");
      if (
        !input.chunkId &&
        chunks.length > 0 &&
        responseTextBytes + textBytes > MAX_SOURCE_CONTENT_RESPONSE_UTF8_BYTES
      ) {
        budgetTruncated = true;
        break;
      }
      const contentSha256 = Sha256.parse(
        asString(row.content_sha256, "source chunk hash"),
      );
      if (sha256(text) !== contentSha256) {
        conflict("Document chunk integrity check failed.");
      }
      const startOffset = asNonnegativeInteger(
        row.start_offset,
        "source chunk start offset",
      );
      const endOffset = asNonnegativeInteger(
        row.end_offset,
        "source chunk end offset",
      );
      if (endOffset < startOffset || endOffset - startOffset < text.length) {
        conflict("Document chunk offsets failed integrity validation.");
      }
      const pageStart =
        row.page_start === null
          ? null
          : asNonnegativeInteger(row.page_start, "source chunk page start");
      const pageEnd =
        row.page_end === null
          ? null
          : asNonnegativeInteger(row.page_end, "source chunk page end");
      if (
        (pageStart === null) !== (pageEnd === null) ||
        (pageStart !== null &&
          pageEnd !== null &&
          (pageStart < 1 ||
            pageEnd < pageStart ||
            (pageCount !== null && pageEnd > pageCount)))
      ) {
        conflict("Document chunk page bounds failed integrity validation.");
      }
      chunks.push({
        id: Id.parse(asString(row.id, "source chunk id")),
        ordinal: asNonnegativeInteger(row.ordinal, "source chunk ordinal"),
        text,
        contentSha256,
        startOffset,
        endOffset,
        pageStart,
        pageEnd,
      });
      responseTextBytes += textBytes;
    }
    return {
      snapshotId: snapshot.id,
      document: {
        documentId: asString(document.document_id, "document id"),
        versionId: asString(document.version_id, "document version id"),
        title: snapshot.titleSnapshot,
        filename: asString(document.filename, "document version filename"),
        mimeType: asString(document.mime_type, "document version MIME type"),
        contentSha256: documentContentSha256,
        pageCount,
      },
      chunks,
      nextCursor:
        (hasMoreRows || budgetTruncated) && chunks.length > 0
          ? encodeContentCursor(chunks[chunks.length - 1])
          : null,
    };
  }

  createProjectDocumentAnchor(
    input: CreateProjectDocumentAnchorInput,
  ): ProjectSourceCitationAnchor {
    const identifiers = z
      .object({
        projectId: Id,
        snapshotId: Id,
        chunkId: Id,
      })
      .strict()
      .safeParse({
        projectId: input.projectId,
        snapshotId: input.snapshotId,
        chunkId: input.chunkId,
      });
    if (!identifiers.success)
      invalid("Citation anchor identifiers are invalid.");
    if (
      typeof input.exactQuote !== "string" ||
      input.exactQuote.trim().length < 1 ||
      [...input.exactQuote].length > 8_000 ||
      input.exactQuote.includes("\0")
    ) {
      invalid("Citation quote is invalid.");
    }
    const suppliedOffsets =
      input.startOffset !== null || input.endOffset !== null;
    if (
      suppliedOffsets &&
      (input.startOffset === null || input.endOffset === null)
    ) {
      invalid("Citation start and end offsets must be supplied together.");
    }

    return this.transaction(() => {
      const snapshot = this.sources.getSnapshot(
        input.projectId,
        input.snapshotId,
      );
      if (!snapshot) notFound();
      if (snapshot.sourceKind !== "project_document") {
        invalid("Public anchors can only target Project document sources.");
      }
      this.assertRetentionAction(
        input.projectId,
        input.snapshotId,
        "anchor_create",
      );
      if (!snapshot.sourceVersionId) {
        conflict("Project document source version is unavailable.");
      }

      const chunk = this.database
        .prepare(
          `SELECT chunk.id,
                chunk.document_id,
                chunk.version_id,
                chunk.ordinal,
                chunk.text,
                chunk.start_offset,
                chunk.end_offset,
                chunk.page_start,
                chunk.page_end,
                chunk.content_sha256,
                chunk.metadata_json,
                version.content_sha256 AS version_content_sha256
           FROM document_chunks chunk
           JOIN document_versions version
             ON version.document_id = chunk.document_id
            AND version.id = chunk.version_id
            AND version.deleted_at IS NULL
           JOIN documents document
             ON document.id = chunk.document_id
            AND document.deleted_at IS NULL
           JOIN projects project
             ON project.id = document.project_id
            AND project.status <> 'deleted'
          WHERE chunk.id = ?
            AND document.project_id = ?
            AND chunk.document_id = ?
            AND chunk.version_id = ?`,
        )
        .get(
          input.chunkId,
          input.projectId,
          snapshot.sourceRecordId,
          snapshot.sourceVersionId,
        );
      if (!chunk) notFound("Project document chunk not found.");

      const chunkText = asString(chunk.text, "document chunk text");
      const chunkHash = Sha256.parse(
        asString(chunk.content_sha256, "document chunk hash"),
      );
      const versionHash = Sha256.parse(
        asString(chunk.version_content_sha256, "document version hash"),
      );
      if (versionHash !== snapshot.contentSha256) {
        conflict(
          "Source snapshot no longer matches the live document version.",
        );
      }
      if (sha256(chunkText) !== chunkHash) {
        conflict("Document chunk integrity check failed.");
      }

      let quoteStart: number;
      let quoteEnd: number;
      if (suppliedOffsets) {
        quoteStart = input.startOffset as number;
        quoteEnd = input.endOffset as number;
        if (
          !Number.isSafeInteger(quoteStart) ||
          !Number.isSafeInteger(quoteEnd) ||
          quoteStart < 0 ||
          quoteEnd < quoteStart ||
          quoteEnd > chunkText.length ||
          chunkText.slice(quoteStart, quoteEnd) !== input.exactQuote
        ) {
          invalid(
            "Citation offsets do not identify the exact quote in the chunk.",
          );
        }
      } else {
        const occurrences = findOccurrences(chunkText, input.exactQuote);
        if (occurrences.length === 0) {
          invalid("Citation quote was not found in the selected chunk.");
        }
        if (occurrences.length > 1) {
          conflict("Citation quote is ambiguous; exact offsets are required.");
        }
        quoteStart = occurrences[0];
        quoteEnd = quoteStart + input.exactQuote.length;
      }

      const chunkStart = asNonnegativeInteger(
        chunk.start_offset,
        "document chunk start offset",
      );
      const chunkEnd = asNonnegativeInteger(
        chunk.end_offset,
        "document chunk end offset",
      );
      if (chunkEnd < chunkStart || chunkEnd - chunkStart < chunkText.length) {
        conflict("Document chunk offsets failed integrity validation.");
      }
      const ordinal = asNonnegativeInteger(
        chunk.ordinal,
        "document chunk ordinal",
      );
      const pageStart =
        chunk.page_start === null
          ? null
          : asNonnegativeInteger(chunk.page_start, "chunk page start");
      const pageEnd =
        chunk.page_end === null
          ? null
          : asNonnegativeInteger(chunk.page_end, "chunk page end");
      const locator: Record<string, unknown> = {
        documentVersionId: snapshot.sourceVersionId,
        chunkId: input.chunkId,
        chunkOrdinal: ordinal,
        chunkContentSha256: chunkHash,
        startOffset: quoteStart,
        endOffset: quoteEnd,
        offsetScope: "chunk_text",
        offsetUnit: "utf16_code_unit",
        pageStart,
        pageEnd,
      };
      // Historical chunks may have trimmed text but pre-trim persisted bounds.
      // Their chunk-local and OCR page-local offsets remain authoritative, but
      // the leading/trailing split is unknowable without guessing. Only expose
      // document offsets when the persisted span proves an exact UTF-16 basis.
      if (chunkEnd - chunkStart === chunkText.length) {
        locator.documentStartOffset = chunkStart + quoteStart;
        locator.documentEndOffset = chunkStart + quoteEnd;
        locator.documentOffsetBasis = "normalized_matter_document_text_v1";
        locator.documentOffsetUnit = "utf16_code_unit";
      }
      const ocr = safeOcrProjection(
        chunk.metadata_json,
        pageStart,
        pageEnd,
        chunkText,
        quoteStart,
        quoteEnd,
      );
      if (ocr) locator.ocr = ocr;
      TransportSafeSourceMetadataV11Schema.parse(locator);

      const count = this.database
        .prepare(
          `SELECT count(*) AS count
             FROM source_citation_anchors
            WHERE project_id = ? AND snapshot_id = ?`,
        )
        .get(input.projectId, input.snapshotId);
      const anchorCount = asNonnegativeInteger(
        count?.count ?? 0,
        "citation anchor count",
      );
      if (anchorCount >= MAX_ANCHORS_PER_SOURCE) {
        conflict("Source citation anchor limit has been reached.");
      }
      const next = this.database
        .prepare(
          `SELECT COALESCE(MAX(ordinal), -1) + 1 AS ordinal
             FROM source_citation_anchors
            WHERE project_id = ? AND snapshot_id = ?`,
        )
        .get(input.projectId, input.snapshotId);
      const anchorOrdinal = asNonnegativeInteger(
        next?.ordinal,
        "citation anchor ordinal",
      );
      return this.anchorView(
        this.sources.createCitationAnchor({
          id: this.nextId(),
          projectId: input.projectId,
          snapshotId: input.snapshotId,
          ordinal: anchorOrdinal,
          exactQuote: input.exactQuote,
          locator,
          createdAt: this.now(),
        }),
        "project_document",
      );
    });
  }

  captureLegalAuthoritySnapshot(
    input: CaptureLegalAuthoritySnapshotInput,
  ): ProjectSourceSnapshotV11 {
    if (!LEGAL_SOURCE_RETENTION_ACTIVATION_V13.open) {
      throw new WorkspaceApiError(
        503,
        "PRECONDITION_FAILED",
        "Legal source activation remains closed until retention cleanup and derived-lineage gates are complete.",
      );
    }
    this.assertProjectExists(input.projectId);
    const policy = SourceDataUsePolicyV11Schema.parse(input.policy);
    return this.sources.createSnapshot({
      id: this.nextId(),
      projectId: input.projectId,
      sourceKind: "legal_authority",
      sourceRecordId: input.sourceRecordId,
      sourceVersionId: input.sourceVersionId,
      titleSnapshot: input.titleSnapshot,
      contentSha256: input.contentSha256,
      locator: input.locator,
      retrievedAt: input.retrievedAt,
      license: policy,
      retentionPolicy: policy.retention,
      retentionExpiresAt: input.retentionExpiresAt,
      retrievalMetadata: input.retrievalMetadata,
      createdAt: this.now(),
    });
  }

  private now() {
    return (this.options.now ?? (() => new Date().toISOString()))();
  }

  /**
   * Legal-provider locators are intentionally opaque at persistence time and
   * can therefore contain payload-like fields. They may cross the public
   * boundary only while the snapshot's payload policy is currently allowed.
   * Stable identity, hash, policy, and time fields remain visible for audit
   * after denial; arbitrary provider JSON does not.
   */
  private snapshotView(
    snapshot: ProjectSourceSnapshotV11,
  ): ProjectSourceSnapshotV11 {
    if (snapshot.sourceKind !== "legal_authority") return snapshot;
    if (!this.options.retention) {
      return this.redactedLegalSnapshotView(snapshot);
    }
    try {
      const evaluation = this.options.retention.evaluateSnapshotAction({
        projectId: snapshot.projectId,
        snapshotId: snapshot.id,
        action: "quote_read",
      });
      return evaluation.decision.allowed
        ? snapshot
        : this.redactedLegalSnapshotView(snapshot);
    } catch (error) {
      if (error instanceof WorkspaceSourceRetentionServiceError) {
        return this.redactedLegalSnapshotView(snapshot);
      }
      // Unknown retention failures are safe because no snapshot is returned.
      throw error;
    }
  }

  private redactedLegalSnapshotView(
    snapshot: ProjectSourceSnapshotV11,
  ): ProjectSourceSnapshotV11 {
    return {
      ...snapshot,
      locator: {},
      retrievalMetadata: {},
    };
  }

  private anchorView(
    anchor: SourceCitationAnchorV11,
    sourceKind: ProjectSourceKindV11,
  ): ProjectSourceCitationAnchor {
    if (!this.options.retention) {
      if (sourceKind === "legal_authority") {
        return {
          ...anchor,
          exactQuote: null,
          locator: {},
          quoteAvailable: false,
          accessState: "lifecycle_missing",
          retentionDenialCode: "source_retention_lifecycle_missing",
        };
      }
      return {
        ...anchor,
        quoteAvailable: true,
        accessState: "available",
        retentionDenialCode: null,
      };
    }
    const metadata = this.options.retention.readAnchorMetadata(
      anchor.projectId,
      anchor.id,
    );
    const retained = metadata.quoteAvailable
      ? this.options.retention.readAnchorQuote(anchor.projectId, anchor.id)
      : null;
    return {
      id: anchor.id,
      projectId: anchor.projectId,
      snapshotId: anchor.snapshotId,
      ordinal: anchor.ordinal,
      exactQuote: retained?.exactQuote ?? null,
      quoteSha256: anchor.quoteSha256,
      locator: metadata.quoteAvailable ? anchor.locator : {},
      createdAt: anchor.createdAt,
      quoteAvailable: metadata.quoteAvailable,
      accessState: metadata.accessState,
      retentionDenialCode: metadata.denialCode,
    };
  }

  private nextId() {
    return (this.options.nextId ?? randomUUID)();
  }

  private assertProjectExists(projectId: string) {
    const project = this.database
      .prepare("SELECT id FROM projects WHERE id = ? AND status <> 'deleted'")
      .get(projectId);
    if (!project) notFound("Project not found.");
  }

  private transaction<T>(operation: () => T): T {
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
      throw error;
    }
  }
}
