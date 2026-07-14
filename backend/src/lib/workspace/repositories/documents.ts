import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import {
  assertNoActiveProjectWorkflowForDocument,
  assertNoDurableDocumentHistory,
  hasExactAssistantDocumentBindings,
} from "../documentDeletionPolicy";
import {
  workspaceBlobStorageKey,
} from "./blobRecords";
import type {
  Document,
  DocumentChunk,
  DocumentStatus,
  DocumentVersion,
  DocumentVersionSource,
  JobStatus,
} from "../types";
import type { WorkspaceDatabaseAdapter } from "../migrations/types";
import type {
  RegisterWorkspaceBlobRecordInput,
  WorkspaceBlobRecord,
  WorkspaceBlobRecordsRepository,
  QuarantineWorkspaceBlobRecord,
} from "./blobRecords";

export type DocumentRepositoryClock = () => string;
export type DocumentRepositoryId = () => string;
export const MAX_WORKSPACE_FILENAME_LENGTH = 240;

export type CreatePendingDocumentInput = {
  documentId?: string;
  versionId?: string;
  jobId?: string;
  projectId: string | null;
  folderId: string | null;
  title: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  contentSha256: string;
  storageKey: string;
  createdAt?: string;
  enqueueParseJob?: boolean;
  blobRecord?: RegisterWorkspaceBlobRecordInput;
};

export type CreatePendingVersionInput = {
  documentId: string;
  versionId?: string;
  jobId?: string;
  source?: DocumentVersionSource;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  contentSha256: string;
  storageKey: string;
  createdAt?: string;
  enqueueParseJob?: boolean;
  blobRecord?: RegisterWorkspaceBlobRecordInput;
};

export type DocumentVersionRow = DocumentVersion & {
  storageKey: string;
  previewStorageKey: string | null;
  deletedAt: string | null;
};

export type DocumentParseJob = {
  id: string;
  type: "document_parse";
  status: JobStatus;
  resourceType: "document";
  resourceId: string;
  attempt: number;
  maxAttempts: number;
  retryable: boolean;
  createdAt: string;
  scheduledAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

export type StoredDocumentBundle = {
  document: Document;
  version: DocumentVersionRow;
  job: DocumentParseJob | null;
};

export type ActiveDocumentDependentJob = {
  id: string;
  status: "queued" | "running";
  resourceType: "document" | "tabular_cell";
};

export type DocumentDeletionPlan = {
  activeJobs: ActiveDocumentDependentJob[];
};

export type ChunkWrite = {
  id?: string;
  ordinal: number;
  text: string;
  startOffset: number;
  endOffset: number;
  pageStart: number | null;
  pageEnd: number | null;
  contentSha256?: string;
};

export type ParseFailure = {
  code: string;
  message: string;
  retryable: boolean;
  metadata?: Record<string, unknown>;
};

export type ParseCommitInput = {
  documentId: string;
  versionId: string;
  jobId: string;
  chunks: readonly ChunkWrite[];
  pageCount: number | null;
  result?: Record<string, unknown>;
  extractedBlob?: {
    recordId?: string;
    storageKey: string;
    sha256: string;
    size: number;
    storedSize: number;
    locator: WorkspaceBlobRecord["locator"];
  };
  reuseExistingExtractedRecord?: boolean;
};

export type TerminalParseInput = {
  documentId: string;
  versionId: string;
  jobId: string;
  status: "unsupported" | "ocr_required";
  result?: Record<string, unknown>;
};

export type DocumentParseCommitOptions = {
  transitionJob?: boolean;
  claim?: DocumentParseClaim;
};

export type DocumentParseClaim = Readonly<{
  leaseOwner: string;
  attempt: number;
}>;

export class DocumentParseClaimLostError extends Error {
  readonly code = "DOCUMENT_PARSE_CLAIM_LOST";

  constructor() {
    super("DOCUMENT_PARSE_CLAIM_LOST");
    this.name = "DocumentParseClaimLostError";
  }
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const DOCUMENT_STATUSES = new Set<DocumentStatus>([
  "pending",
  "processing",
  "ready",
  "failed",
  "unsupported",
  "ocr_required",
]);
const JOB_STATUSES = new Set<JobStatus>([
  "queued",
  "running",
  "complete",
  "failed",
  "cancelled",
  "interrupted",
]);

function assertUuid(value: string, name: string) {
  if (!UUID.test(value)) throw new Error(`${name} must be a UUID.`);
}

function assertSha256(value: string) {
  if (!SHA256.test(value)) throw new Error("contentSha256 must be lowercase SHA-256.");
}

function asString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`Workspace ${name} is invalid.`);
  return value;
}

function asNullableString(value: unknown): string | null {
  return value == null ? null : String(value);
}

function asNumber(value: unknown, name: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error(`Workspace ${name} is invalid.`);
  return result;
}

function asDocumentStatus(value: unknown): DocumentStatus {
  const status = String(value);
  if (!DOCUMENT_STATUSES.has(status as DocumentStatus)) {
    throw new Error(`Workspace document status is invalid: ${status}.`);
  }
  return status as DocumentStatus;
}

function asJobStatus(value: unknown): JobStatus {
  const status = String(value);
  if (!JOB_STATUSES.has(status as JobStatus)) {
    throw new Error(`Workspace job status is invalid: ${status}.`);
  }
  return status as JobStatus;
}

function asSource(value: unknown): DocumentVersionSource {
  const source = String(value);
  if (!["upload", "user_upload", "assistant_edit", "user_accept", "user_reject", "generated"].includes(source)) {
    throw new Error(`Workspace document version source is invalid: ${source}.`);
  }
  return source as DocumentVersionSource;
}

function parseJson(value: unknown, fallback: unknown = null): unknown {
  if (value == null) return fallback;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function safeTitle(filename: string) {
  const withoutExtension = filename.replace(/\.[^.]+$/, "").trim();
  return withoutExtension.slice(0, 500) || filename.slice(0, 500);
}

function hashChunk(text: string) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export class WorkspaceDocumentsRepository {
  private readonly now: DocumentRepositoryClock;
  private readonly nextId: DocumentRepositoryId;

  constructor(
    private readonly database: WorkspaceDatabaseAdapter,
    options: {
      now?: DocumentRepositoryClock;
      nextId?: DocumentRepositoryId;
      blobRecords?: WorkspaceBlobRecordsRepository;
    } = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.nextId = options.nextId ?? randomUUID;
    this.blobRecords = options.blobRecords;
  }

  private readonly blobRecords?: WorkspaceBlobRecordsRepository;

  getBlobRecordsRepository() {
    return this.blobRecords;
  }

  listDocumentBlobRecords(documentId: string): WorkspaceBlobRecord[] {
    if (!this.blobRecords) throw new Error("Workspace blob records repository is required.");
    return this.blobRecords.listForDocument(documentId);
  }

  deleteBlobRecord(recordId: string, quarantineId: string) {
    if (!this.blobRecords) throw new Error("Workspace blob records repository is required.");
    this.blobRecords.deleteQuarantined(recordId, quarantineId);
  }

  getDocument(documentId: string): Document | null {
    assertUuid(documentId, "documentId");
    const row = this.database
      .prepare("SELECT * FROM documents WHERE id = ? AND deleted_at IS NULL")
      .get(documentId);
    return row ? this.mapDocument(row) : null;
  }

  listDocuments(options: {
    projectId?: string | null;
    folderId?: string | null;
    status?: DocumentStatus;
    limit?: number;
  } = {}): Document[] {
    if (options.projectId) assertUuid(options.projectId, "projectId");
    if (options.folderId) assertUuid(options.folderId, "folderId");
    if (options.status && !DOCUMENT_STATUSES.has(options.status)) {
      throw new Error("status is invalid.");
    }
    const limit = Math.min(Math.max(Math.floor(options.limit ?? 100), 1), 100);
    const predicates = ["deleted_at IS NULL"];
    const parameters: unknown[] = [];
    if (options.projectId !== undefined) {
      predicates.push("project_id IS ?");
      parameters.push(options.projectId);
    }
    if (options.folderId !== undefined) {
      predicates.push("folder_id IS ?");
      parameters.push(options.folderId);
    }
    if (options.status) {
      predicates.push("parse_status = ?");
      parameters.push(options.status);
    }
    parameters.push(limit);
    return this.database
      .prepare(
        `SELECT * FROM documents WHERE ${predicates.join(" AND ")}
         ORDER BY updated_at DESC, id ASC LIMIT ?`,
      )
      .all(...parameters)
      .map((row) => this.mapDocument(row));
  }

  getVersion(documentId: string, versionId: string): DocumentVersionRow | null {
    assertUuid(documentId, "documentId");
    assertUuid(versionId, "versionId");
    const row = this.database
      .prepare(
        `SELECT * FROM document_versions
          WHERE document_id = ? AND id = ? AND deleted_at IS NULL`,
      )
      .get(documentId, versionId);
    return row ? this.mapVersion(row) : null;
  }

  listVersions(documentId: string): DocumentVersionRow[] {
    assertUuid(documentId, "documentId");
    return this.database
      .prepare(
        `SELECT * FROM document_versions
          WHERE document_id = ? AND deleted_at IS NULL
          ORDER BY version_number ASC`,
      )
      .all(documentId)
      .map((row) => this.mapVersion(row));
  }

  getJob(jobId: string): DocumentParseJob | null {
    assertUuid(jobId, "jobId");
    const row = this.database.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId);
    return row ? this.mapJob(row) : null;
  }

  createPendingDocument(input: CreatePendingDocumentInput): StoredDocumentBundle {
    const documentId = input.documentId ?? this.nextId();
    const versionId = input.versionId ?? this.nextId();
    const jobId = input.enqueueParseJob === false ? null : input.jobId ?? this.nextId();
    const createdAt = input.createdAt ?? this.now();
    this.assertCreateInput(input, documentId, versionId, jobId);
    return this.transaction(() => {
      if (input.projectId) {
        const project = this.database.prepare("SELECT id FROM projects WHERE id = ? AND status <> 'deleted'").get(input.projectId);
        if (!project) throw new Error("Project was not found.");
      }
      if (input.folderId) {
        const folder = this.database.prepare("SELECT project_id FROM project_subfolders WHERE id = ?").get(input.folderId);
        if (!folder || folder.project_id !== input.projectId) {
          throw new Error("Folder does not belong to the requested project.");
        }
      }
      this.database
        .prepare(
          `INSERT INTO documents (
             id, project_id, folder_id, title, filename, mime_type, size_bytes,
             parse_status, current_version_id, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?)`,
        )
        .run(
          documentId,
          input.projectId,
          input.folderId,
          input.title || safeTitle(input.filename),
          input.filename,
          input.mimeType,
          input.sizeBytes,
          createdAt,
          createdAt,
        );
      this.database
        .prepare(
          `INSERT INTO document_versions (
             id, document_id, version_number, source, filename, mime_type,
             size_bytes, content_sha256, storage_key, created_at
           ) VALUES (?, ?, 1, 'upload', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          versionId,
          documentId,
          input.filename,
          input.mimeType,
          input.sizeBytes,
          input.contentSha256,
          input.storageKey,
          createdAt,
        );
      this.database
        .prepare("UPDATE documents SET current_version_id = ?, updated_at = ? WHERE id = ?")
        .run(versionId, createdAt, documentId);
      if (jobId) this.insertParseJob(jobId, documentId, versionId, createdAt);
      if (input.blobRecord) {
        if (!this.blobRecords) throw new Error("Workspace blob records repository is required for blob-backed document writes.");
        if (
          input.blobRecord.locator.kind !== "original" ||
          input.blobRecord.locator.documentId !== documentId ||
          input.blobRecord.locator.versionId !== versionId
        ) {
          throw new Error("Original blob record locator is not bound to the document/version.");
        }
        this.blobRecords.registerStoredInTransaction(input.blobRecord);
      }
      return {
        document: this.mustGetDocument(documentId),
        version: this.mustGetVersion(documentId, versionId),
        job: jobId ? this.mustGetJob(jobId) : null,
      };
    });
  }

  createPendingVersion(input: CreatePendingVersionInput): StoredDocumentBundle {
    const versionId = input.versionId ?? this.nextId();
    const jobId = input.enqueueParseJob === false ? null : input.jobId ?? this.nextId();
    const createdAt = input.createdAt ?? this.now();
    assertUuid(input.documentId, "documentId");
    assertUuid(versionId, "versionId");
    if (jobId) assertUuid(jobId, "jobId");
    if (!input.filename.trim() || input.filename.length > MAX_WORKSPACE_FILENAME_LENGTH || input.filename.includes("/") || input.filename.includes("\\")) throw new Error("filename must be a safe single file name.");
    if (!input.mimeType.trim() || !Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0) throw new Error("document metadata is invalid.");
    assertSha256(input.contentSha256);
    if (input.storageKey !== documentStorageKey(input.documentId, versionId)) {
      throw new Error("storageKey must match the deterministic document locator.");
    }
    return this.transaction(() => {
      const document = this.getDocument(input.documentId);
      if (!document) throw new Error("Document was not found.");
      const row = this.database
        .prepare("SELECT coalesce(max(version_number), 0) AS version_number FROM document_versions WHERE document_id = ?")
        .get(input.documentId);
      const versionNumber = Number(row?.version_number ?? 0) + 1;
      this.database
        .prepare(
          `INSERT INTO document_versions (
             id, document_id, version_number, source, filename, mime_type,
             size_bytes, content_sha256, storage_key, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          versionId,
          input.documentId,
          versionNumber,
          input.source ?? "upload",
          input.filename,
          input.mimeType,
          input.sizeBytes,
          input.contentSha256,
          input.storageKey,
          createdAt,
        );
      this.database
        .prepare(
          `UPDATE documents SET current_version_id = ?, filename = ?, mime_type = ?,
             size_bytes = ?, parse_status = 'pending', updated_at = ?
           WHERE id = ? AND deleted_at IS NULL`,
        )
        .run(versionId, input.filename, input.mimeType, input.sizeBytes, createdAt, input.documentId);
      if (jobId) this.insertParseJob(jobId, input.documentId, versionId, createdAt);
      if (input.blobRecord) {
        if (!this.blobRecords) throw new Error("Workspace blob records repository is required for blob-backed document writes.");
        if (
          input.blobRecord.locator.kind !== "original" ||
          input.blobRecord.locator.documentId !== input.documentId ||
          input.blobRecord.locator.versionId !== versionId
        ) {
          throw new Error("Original blob record locator is not bound to the document/version.");
        }
        this.blobRecords.registerStoredInTransaction(input.blobRecord);
      }
      return {
        document: this.mustGetDocument(input.documentId),
        version: this.mustGetVersion(input.documentId, versionId),
        job: jobId ? this.mustGetJob(jobId) : null,
      };
    });
  }

  renameDocument(documentId: string, filename: string) {
    assertUuid(documentId, "documentId");
    const nextFilename = filename.trim();
    if (!nextFilename || nextFilename.length > MAX_WORKSPACE_FILENAME_LENGTH || path.isAbsolute(nextFilename) || nextFilename.includes("/") || nextFilename.includes("\\")) {
      throw new Error("filename must be a safe single file name.");
    }
    return this.transaction(() => {
      const document = this.getDocument(documentId);
      if (!document) throw new Error("Document was not found.");
      const current = this.database
        .prepare("SELECT filename FROM document_versions WHERE document_id = ? AND id = ? AND deleted_at IS NULL")
        .get(documentId, document.currentVersionId);
      const currentFilename = String(current?.filename ?? document.filename);
      const extension = path.extname(currentFilename);
      const candidate = path.extname(nextFilename) ? nextFilename : `${nextFilename}${extension}`;
      if (path.extname(candidate).toLowerCase() !== extension.toLowerCase()) {
        throw new Error("filename extension cannot be changed.");
      }
      const nextTitle = candidate.replace(/\.[^.]+$/, "").trim();
      if (!nextTitle || nextTitle.length > 500) throw new Error("Document title is invalid.");
      const at = this.now();
      this.database.prepare("UPDATE documents SET filename = ?, title = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL").run(candidate, nextTitle, at, documentId);
      this.database.prepare("UPDATE document_versions SET filename = ? WHERE document_id = ? AND id = ? AND deleted_at IS NULL").run(candidate, documentId, document.currentVersionId);
      return this.mustGetDocument(documentId);
    });
  }

  renameDocumentTitle(documentId: string, title: string) {
    assertUuid(documentId, "documentId");
    const nextTitle = title.trim();
    if (!nextTitle || nextTitle.length > 500) throw new Error("Document title is invalid.");
    return this.transaction(() => {
      if (!this.getDocument(documentId)) throw new Error("Document was not found.");
      this.database.prepare("UPDATE documents SET title = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL").run(nextTitle, this.now(), documentId);
      return this.mustGetDocument(documentId);
    });
  }

  moveDocument(documentId: string, projectId: string | null, folderId: string | null) {
    assertUuid(documentId, "documentId");
    if (projectId) assertUuid(projectId, "projectId");
    if (folderId) assertUuid(folderId, "folderId");
    return this.transaction(() => {
      if (!this.getDocument(documentId)) throw new Error("Document was not found.");
      this.assertActivePlacement(projectId, folderId);
      this.database.prepare("UPDATE documents SET project_id = ?, folder_id = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL").run(projectId, folderId, this.now(), documentId);
      return this.mustGetDocument(documentId);
    });
  }

  setCurrentVersion(documentId: string, versionId: string) {
    assertUuid(documentId, "documentId");
    assertUuid(versionId, "versionId");
    return this.transaction(() => {
      const version = this.getVersion(documentId, versionId);
      if (!version) throw new Error("Document version was not found.");
      this.database
        .prepare(
          "UPDATE documents SET current_version_id = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
        )
        .run(versionId, this.now(), documentId);
      return this.mustGetDocument(documentId);
    });
  }

  setParseStatusForClaim(
    documentId: string,
    versionId: string,
    jobId: string,
    status: DocumentStatus,
    claim: DocumentParseClaim,
  ) {
    assertUuid(documentId, "documentId");
    assertUuid(versionId, "versionId");
    assertUuid(jobId, "jobId");
    if (!DOCUMENT_STATUSES.has(status)) throw new Error("status is invalid.");
    return this.transaction(() => {
      this.boundDocumentJob(jobId, documentId, versionId, "running", claim);
      this.database
        .prepare("UPDATE documents SET parse_status = ?, updated_at = ? WHERE id = ? AND current_version_id = ?")
        .run(status, this.now(), documentId, versionId);
      return this.mustGetVersion(documentId, versionId);
    });
  }

  assertParseClaim(
    documentId: string,
    versionId: string,
    jobId: string,
    claim: DocumentParseClaim,
  ) {
    assertUuid(documentId, "documentId");
    assertUuid(versionId, "versionId");
    assertUuid(jobId, "jobId");
    return this.transaction(() => {
      this.boundDocumentJob(jobId, documentId, versionId, "running", claim);
    });
  }

  markParseStarted(documentId: string, versionId: string, jobId: string) {
    assertUuid(documentId, "documentId");
    assertUuid(versionId, "versionId");
    assertUuid(jobId, "jobId");
    return this.transaction(() => {
      const job = this.boundDocumentJob(jobId, documentId, versionId, "queued");
      const at = this.now();
      this.database
        .prepare(
          `UPDATE jobs SET status = 'running', attempt = attempt + 1,
             started_at = ?, locked_at = ?, updated_at = ? WHERE id = ?`,
        )
        .run(at, at, at, jobId);
      this.database
        .prepare("UPDATE documents SET parse_status = 'processing', updated_at = ? WHERE id = ? AND current_version_id = ?")
        .run(at, documentId, versionId);
      return this.mustGetVersion(documentId, versionId);
    });
  }

  commitParseReady(input: ParseCommitInput, options: DocumentParseCommitOptions = {}) {
    const transitionJob = options.transitionJob !== false;
    this.assertParseInput(input);
    return this.transaction(() => {
      this.assertCommitClaim(transitionJob, options.claim);
      this.boundDocumentJob(input.jobId, input.documentId, input.versionId, "running", options.claim);
      if (!input.extractedBlob || !this.blobRecords) {
        throw new Error("Extracted blob record metadata and repository are required before ready status.");
      }
      if (
        input.extractedBlob.locator.kind !== "extracted_text" ||
        input.extractedBlob.locator.documentId !== input.documentId ||
        input.extractedBlob.locator.versionId !== input.versionId
      ) {
        throw new Error("Extracted blob record locator is not bound to the document/version.");
      }
      if (input.extractedBlob.storageKey !== workspaceBlobStorageKey(input.extractedBlob.locator)) {
        throw new Error("Extracted blob record storage key is not deterministic.");
      }
      const existingExtracted = this.blobRecords.getByLocator(input.extractedBlob.locator);
      if (input.reuseExistingExtractedRecord) {
        if (
          !existingExtracted ||
          existingExtracted.state !== "stored" ||
          (input.extractedBlob.recordId !== undefined && existingExtracted.id !== input.extractedBlob.recordId) ||
          existingExtracted.storageKey !== input.extractedBlob.storageKey ||
          existingExtracted.contentSha256 !== input.extractedBlob.sha256 ||
          existingExtracted.sizeBytes !== input.extractedBlob.size ||
          existingExtracted.storedSizeBytes !== input.extractedBlob.storedSize
        ) {
          throw new Error("Existing extracted blob authority does not match the parse commit.");
        }
      } else {
        if (existingExtracted) {
          throw new Error("Extracted blob locator already has authoritative storage.");
        }
        this.blobRecords.registerStoredInTransaction({
          id: input.extractedBlob.recordId,
          locator: input.extractedBlob.locator,
          contentSha256: input.extractedBlob.sha256,
          sizeBytes: input.extractedBlob.size,
          storedSizeBytes: input.extractedBlob.storedSize,
        });
      }
      this.replaceChunksInTransaction(input.documentId, input.versionId, input.chunks);
      const at = this.now();
      this.database
        .prepare(
          `UPDATE document_versions SET page_count = ?
            WHERE document_id = ? AND id = ?`,
        )
        .run(input.pageCount, input.documentId, input.versionId);
      this.database
        .prepare("UPDATE documents SET parse_status = 'ready', parse_error_code = NULL, parse_error_json = NULL, updated_at = ? WHERE id = ? AND current_version_id = ?")
        .run(at, input.documentId, input.versionId);
      if (transitionJob) {
        this.database
          .prepare(
            `UPDATE jobs SET status = 'complete', result_json = ?, error_json = NULL,
               error_code = NULL, completed_at = ?, updated_at = ? WHERE id = ?`,
          )
          .run(JSON.stringify({ ...(input.result ?? { status: "ready" }), extractedBlob: input.extractedBlob ?? null }), at, at, input.jobId);
      }
      return this.mustGetDocument(input.documentId);
    });
  }

  commitTerminalParse(input: TerminalParseInput, options: DocumentParseCommitOptions = {}) {
    const transitionJob = options.transitionJob !== false;
    this.assertTerminalInput(input);
    return this.transaction(() => {
      this.assertCommitClaim(transitionJob, options.claim);
      this.boundDocumentJob(input.jobId, input.documentId, input.versionId, "running", options.claim);
      const at = this.now();
      this.database
        .prepare("UPDATE documents SET parse_status = ?, parse_error_code = NULL, parse_error_json = NULL, updated_at = ? WHERE id = ? AND current_version_id = ?")
        .run(input.status, at, input.documentId, input.versionId);
      if (transitionJob) {
        this.database
          .prepare(
            `UPDATE jobs SET status = 'complete', result_json = ?, error_json = NULL,
               error_code = NULL, completed_at = ?, updated_at = ? WHERE id = ?`,
          )
          .run(JSON.stringify(input.result ?? { status: input.status }), at, at, input.jobId);
      }
      return this.mustGetDocument(input.documentId);
    });
  }

  commitParseFailure(documentId: string, versionId: string, jobId: string, failure: ParseFailure, options: DocumentParseCommitOptions = {}) {
    const transitionJob = options.transitionJob !== false;
    assertUuid(documentId, "documentId");
    assertUuid(versionId, "versionId");
    assertUuid(jobId, "jobId");
    const code = failure.code.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120) || "document_parse_failed";
    const message = failure.message.replace(/[\r\n]+/g, " ").slice(0, 500) || "Document parsing failed.";
    return this.transaction(() => {
      this.assertCommitClaim(transitionJob, options.claim);
      this.boundDocumentJob(jobId, documentId, versionId, "running", options.claim);
      const at = this.now();
      this.database
        .prepare("UPDATE documents SET parse_status = 'failed', parse_error_code = ?, parse_error_json = ?, updated_at = ? WHERE id = ? AND current_version_id = ?")
        .run(code, JSON.stringify({ code, message, retryable: failure.retryable, metadata: failure.metadata ?? null }), at, documentId, versionId);
      if (transitionJob) {
        this.database
          .prepare(
            `UPDATE jobs SET status = 'failed', error_json = ?, error_code = ?,
               completed_at = ?, updated_at = ?, retryable = ? WHERE id = ?`,
          )
          .run(JSON.stringify({ code, message, retryable: failure.retryable, metadata: failure.metadata ?? null }), code, at, at, failure.retryable ? 1 : 0, jobId);
      }
      return this.mustGetDocument(documentId);
    });
  }

  replaceChunks(documentId: string, versionId: string, chunks: readonly ChunkWrite[]) {
    assertUuid(documentId, "documentId");
    assertUuid(versionId, "versionId");
    return this.transaction(() => this.replaceChunksInTransaction(documentId, versionId, chunks));
  }

  searchChunks(query: string, options: { documentId?: string; limit?: number } = {}): DocumentChunk[] {
    const text = query.trim();
    if (!text) return [];
    if (options.documentId) assertUuid(options.documentId, "documentId");
    const limit = Math.min(Math.max(Math.floor(options.limit ?? 50), 1), 100);
    try {
      this.lastSearchMode = "fts";
      const predicates = ["document_chunks_fts MATCH ?"];
      const parameters: unknown[] = [text];
      if (options.documentId) {
        predicates.push("c.document_id = ?");
        parameters.push(options.documentId);
      }
      parameters.push(limit);
      return this.database
        .prepare(
          `SELECT c.* FROM document_chunks_fts f
             JOIN document_chunks c ON c.rowid = f.rowid
            WHERE ${predicates.join(" AND ")}
            ORDER BY c.document_id, c.version_id, c.ordinal LIMIT ?`,
        )
        .all(...parameters)
        .map((row) => this.mapChunk(row));
    } catch (error) {
      if (!this.isFtsUnavailable(error)) throw error;
      this.lastSearchMode = "like";
      const predicates = ["c.text LIKE ?"];
      const parameters: unknown[] = [`%${text}%`];
      if (options.documentId) {
        predicates.push("c.document_id = ?");
        parameters.push(options.documentId);
      }
      parameters.push(limit);
      return this.database
        .prepare(
          `SELECT c.* FROM document_chunks c WHERE ${predicates.join(" AND ")}
           ORDER BY c.document_id, c.version_id, c.ordinal LIMIT ?`,
        )
        .all(...parameters)
        .map((row) => this.mapChunk(row));
    }
  }

  retryParse(documentId: string, versionId?: string): DocumentParseJob | null {
    assertUuid(documentId, "documentId");
    if (versionId) assertUuid(versionId, "versionId");
    return this.transaction(() => {
      const document = this.getDocument(documentId);
      if (!document) throw new Error("DOCUMENT_RETRY_DOCUMENT_NOT_FOUND");
      const targetVersion = versionId ?? document.currentVersionId;
      if (!targetVersion) throw new Error("DOCUMENT_RETRY_NOT_ALLOWED");
      const version = this.getVersion(documentId, targetVersion);
      if (!version) throw new Error("DOCUMENT_RETRY_VERSION_NOT_FOUND");
      if (document.currentVersionId !== targetVersion) throw new Error("DOCUMENT_RETRY_NOT_ALLOWED");
      const active = this.database
        .prepare(
          `SELECT id FROM jobs
             WHERE type = 'document_parse' AND resource_type = 'document'
               AND resource_id = ? AND status IN ('queued', 'running')
               AND json_extract(payload_json, '$.versionId') = ? LIMIT 1`,
        )
        .get(documentId, targetVersion);
      if (active) throw new Error("DOCUMENT_RETRY_ACTIVE");
      if (!["failed", "ocr_required", "unsupported"].includes(document.status)) throw new Error("DOCUMENT_RETRY_NOT_ALLOWED");
      const latest = this.database
        .prepare(
          `SELECT retryable FROM jobs
            WHERE type = 'document_parse' AND resource_type = 'document'
              AND resource_id = ? AND json_extract(payload_json, '$.versionId') = ?
            ORDER BY created_at DESC, id DESC LIMIT 1`,
        )
        .get(documentId, targetVersion);
      if (latest && Number(latest.retryable) !== 1) throw new Error("DOCUMENT_RETRY_NOT_ALLOWED");
      const prior = this.database
        .prepare(
          `SELECT count(*) AS attempt_count, max(max_attempts) AS max_attempts
             FROM jobs
            WHERE type = 'document_parse' AND resource_type = 'document'
              AND resource_id = ? AND json_extract(payload_json, '$.versionId') = ?`,
        )
        .get(documentId, targetVersion) as { attempt_count?: number | null; max_attempts?: number | null };
      if (Number(prior?.attempt_count ?? 0) >= Number(prior?.max_attempts ?? 3)) throw new Error("DOCUMENT_RETRY_EXHAUSTED");
      const jobId = this.nextId();
      const at = this.now();
      this.insertParseJob(jobId, documentId, targetVersion, at);
      this.database
        .prepare("UPDATE documents SET parse_status = 'pending', updated_at = ? WHERE id = ?")
        .run(at, documentId);
      return this.mustGetJob(jobId);
    });
  }

  documentDeletionPlan(documentId: string): DocumentDeletionPlan {
    assertUuid(documentId, "documentId");
    const document = this.getDocument(documentId);
    if (!document) throw new Error("Document was not found.");
    assertNoDurableDocumentHistory(this.database, {
      kind: "document",
      documentId,
    });
    assertNoActiveProjectWorkflowForDocument(this.database, documentId);
    this.assertNoUnsafeAssistantDependencies(documentId, document.projectId);
    this.assertTabularCellJobBindings(documentId);
    return { activeJobs: this.listActiveDocumentDependentJobs(documentId) };
  }

  deleteDocumentRows(documentId: string, stagedRecords: readonly QuarantineWorkspaceBlobRecord[] = []): DocumentVersionRow[] {
    assertUuid(documentId, "documentId");
    return this.transaction(() => {
      const versions = this.listVersions(documentId);
      const document = this.getDocument(documentId);
      if (!document) throw new Error("Document was not found.");
      assertNoDurableDocumentHistory(this.database, {
        kind: "document",
        documentId,
      });
      assertNoActiveProjectWorkflowForDocument(this.database, documentId);
      this.assertNoUnsafeAssistantDependencies(documentId, document.projectId);
      this.assertTabularCellJobBindings(documentId);
      if (this.listActiveDocumentDependentJobs(documentId).length > 0) {
        throw new Error("DOCUMENT_DELETE_BUSY");
      }
      if (this.blobRecords) {
        const known = this.blobRecords.listForDocument(documentId);
        if (known.length !== stagedRecords.length) {
          throw new Error("Document delete requires every authoritative blob record to be staged.");
        }
        for (const staged of stagedRecords) {
          const record = known.find((candidate) => candidate.id === staged.recordId);
          if (!record || record.locator.kind === "export" || record.locator.documentId !== documentId) {
            throw new Error("Document delete blob record set is not authoritative.");
          }
          this.blobRecords.quarantineInTransaction(staged.recordId, staged.quarantineId);
        }
        const at = this.now();
        const reviewIds = this.database
          .prepare(
            `SELECT review_id FROM tabular_review_documents
              WHERE document_id = ? ORDER BY review_id`,
          )
          .all(documentId)
          .map((row) => String(row.review_id));
        this.database
          .prepare(
            `DELETE FROM jobs
              WHERE (resource_type = 'document' AND resource_id = ?)
                 OR (resource_type = 'tabular_cell' AND resource_id IN (
                      SELECT id FROM tabular_cells WHERE document_id = ?
                    ))`,
          )
          .run(documentId, documentId);
        this.database
          .prepare("DELETE FROM tabular_cells WHERE document_id = ?")
          .run(documentId);
        this.database
          .prepare("DELETE FROM tabular_review_documents WHERE document_id = ?")
          .run(documentId);
        for (const reviewId of reviewIds) {
          const remainingDocumentIds = this.database
            .prepare(
              `SELECT document_id FROM tabular_review_documents
                WHERE review_id = ? ORDER BY ordinal, document_id`,
            )
            .all(reviewId)
            .map((row) => String(row.document_id));
          this.database
            .prepare(
              "UPDATE tabular_reviews SET document_ids_json = ?, updated_at = ? WHERE id = ?",
            )
            .run(JSON.stringify(remainingDocumentIds), at, reviewId);
        }
        this.database
          .prepare("DELETE FROM message_sources WHERE document_id = ?")
          .run(documentId);
        this.database
          .prepare("DELETE FROM document_edits WHERE document_id = ?")
          .run(documentId);
        this.database
          .prepare("DELETE FROM document_chunks WHERE document_id = ?")
          .run(documentId);
        this.database
          .prepare("UPDATE document_versions SET deleted_at = ? WHERE document_id = ? AND deleted_at IS NULL")
          .run(at, documentId);
        this.database
          .prepare("UPDATE documents SET deleted_at = ?, current_version_id = NULL, parse_status = 'failed', updated_at = ? WHERE id = ? AND deleted_at IS NULL")
          .run(at, at, documentId);
        return versions;
      }
      this.database
        .prepare(
          `DELETE FROM jobs
            WHERE (resource_type = 'document' AND resource_id = ?)
               OR (resource_type = 'tabular_cell' AND resource_id IN (
                    SELECT id FROM tabular_cells WHERE document_id = ?
                  ))`,
        )
        .run(documentId, documentId);
      this.database.prepare("DELETE FROM documents WHERE id = ?").run(documentId);
      return versions;
    });
  }

  private listActiveDocumentDependentJobs(
    documentId: string,
  ): ActiveDocumentDependentJob[] {
    const rows = this.database
      .prepare(
        `SELECT DISTINCT job.id, job.type, job.status, job.resource_type
           FROM jobs job
          WHERE job.status IN ('queued', 'running')
            AND (
              (job.resource_type = 'document' AND job.resource_id = ?)
              OR
              (job.resource_type = 'tabular_cell' AND job.resource_id IN (
                SELECT cell.id FROM tabular_cells cell
                 WHERE cell.document_id = ?
              ))
            )
          ORDER BY job.status, job.id`,
      )
      .all(documentId, documentId);
    return rows.map((row) => {
      const resourceType = String(row.resource_type);
      const type = String(row.type);
      if (
        (resourceType === "document" && type !== "document_parse") ||
        (resourceType === "tabular_cell" && type !== "tabular_cell") ||
        (resourceType !== "document" && resourceType !== "tabular_cell")
      ) {
        throw new Error("DOCUMENT_DELETE_DEPENDENCY_CONFLICT");
      }
      return {
        id: String(row.id),
        status: String(row.status) as "queued" | "running",
        resourceType,
      };
    });
  }

  private assertTabularCellJobBindings(documentId: string) {
    const malformed = this.database
      .prepare(
        `SELECT cell.id
           FROM tabular_cells cell
           LEFT JOIN jobs job ON job.id = cell.job_id
          WHERE cell.document_id = ?
            AND cell.status IN ('queued', 'running')
            AND (
              cell.job_id IS NULL OR job.id IS NULL OR
              job.type <> 'tabular_cell' OR
              job.resource_type <> 'tabular_cell' OR
              job.resource_id <> cell.id
            )
          LIMIT 1`,
      )
      .get(documentId);
    if (malformed) throw new Error("DOCUMENT_DELETE_DEPENDENCY_CONFLICT");
  }

  private assertNoUnsafeAssistantDependencies(
    documentId: string,
    projectId: string | null,
  ) {
    // v5+ snapshots bind the exact document/version set. The shared durable
    // history policy has already checked those rows, so retaining the legacy
    // project-wide heuristic here would block unrelated document deletion.
    if (hasExactAssistantDocumentBindings(this.database)) return;

    const activeAssistantJobs = this.database
      .prepare(
        `SELECT job.resource_type, chat.id AS chat_id,
                chat.scope AS chat_scope, chat.project_id AS chat_project_id
           FROM jobs job
           LEFT JOIN chats chat
             ON job.resource_type = 'chat' AND chat.id = job.resource_id
          WHERE job.type = 'assistant_generate'
            AND job.status IN ('queued', 'running')`,
      )
      .all();
    for (const row of activeAssistantJobs) {
      if (row.resource_type !== "chat" || row.chat_id == null) {
        throw new Error("DOCUMENT_DELETE_ASSISTANT_BUSY");
      }
      const chatProjectId = row.chat_project_id == null ? null : String(row.chat_project_id);
      const canAccessDocument = projectId === null
        ? row.chat_scope === "global" && chatProjectId === null
        : row.chat_scope === "project" && chatProjectId === projectId;
      if (canAccessDocument) throw new Error("DOCUMENT_DELETE_ASSISTANT_BUSY");
    }

    const activeSourcedMessage = this.database
      .prepare(
        `SELECT source.id
           FROM message_sources source
           JOIN chat_messages message ON message.id = source.message_id
          WHERE source.document_id = ?
            AND message.role IN ('assistant', 'tool')
            AND message.status IN ('pending', 'streaming')
          LIMIT 1`,
      )
      .get(documentId);
    if (activeSourcedMessage) throw new Error("DOCUMENT_DELETE_ASSISTANT_BUSY");

    const activeAccessibleMessage = this.database
      .prepare(
        `SELECT message.id, chat.scope, chat.project_id
           FROM chat_messages message
           JOIN chats chat ON chat.id = message.chat_id
          WHERE message.role IN ('assistant', 'tool')
            AND message.status IN ('pending', 'streaming')`,
      )
      .all();
    for (const row of activeAccessibleMessage) {
      const chatProjectId = row.project_id == null ? null : String(row.project_id);
      if (
        (projectId === null && row.scope === "global" && chatProjectId === null) ||
        (projectId !== null && row.scope === "project" && chatProjectId === projectId)
      ) {
        throw new Error("DOCUMENT_DELETE_ASSISTANT_BUSY");
      }
    }

    const activeReviewChat = this.database
      .prepare(
        `SELECT message.id
           FROM tabular_review_chat_messages message
           JOIN tabular_review_chats review_chat
             ON review_chat.id = message.review_chat_id
           JOIN tabular_review_documents membership
             ON membership.review_id = review_chat.review_id
          WHERE membership.document_id = ?
            AND message.role IN ('assistant', 'tool')
            AND message.status IN ('pending', 'streaming')
          LIMIT 1`,
      )
      .get(documentId);
    if (activeReviewChat) throw new Error("DOCUMENT_DELETE_ASSISTANT_BUSY");
  }

  private insertParseJob(jobId: string, documentId: string, versionId: string, at: string) {
    this.database
      .prepare(
        `INSERT INTO jobs (
           id, type, status, resource_type, resource_id, attempt, max_attempts,
           retryable, payload_json, scheduled_at, created_at, updated_at
         ) VALUES (?, 'document_parse', 'queued', 'document', ?, 0, 3, 1, ?, ?, ?, ?)`,
      )
      .run(jobId, documentId, JSON.stringify({ documentId, versionId }), at, at, at);
  }

  private assertActivePlacement(projectId: string | null, folderId: string | null) {
    if (!projectId && folderId) throw new Error("A folder requires an active project.");
    if (projectId) {
      const project = this.database.prepare("SELECT id FROM projects WHERE id = ? AND status = 'active'").get(projectId);
      if (!project) throw new Error("Project was not found or is not active.");
    }
    if (folderId) {
      const folder = this.database.prepare("SELECT project_id FROM project_subfolders WHERE id = ?").get(folderId);
      if (!folder || folder.project_id !== projectId) throw new Error("Folder does not belong to the requested project.");
    }
  }

  private replaceChunksInTransaction(documentId: string, versionId: string, chunks: readonly ChunkWrite[]) {
    this.database
      .prepare("DELETE FROM document_chunks WHERE document_id = ? AND version_id = ?")
      .run(documentId, versionId);
    const statement = this.database.prepare(
      `INSERT INTO document_chunks (
         id, document_id, version_id, ordinal, text, start_offset, end_offset,
         page_start, page_end, content_sha256, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const at = this.now();
    for (const chunk of chunks) {
      if (!Number.isSafeInteger(chunk.ordinal) || chunk.ordinal < 0) throw new Error("chunk ordinal is invalid.");
      if (chunk.endOffset < chunk.startOffset || chunk.startOffset < 0) throw new Error("chunk offsets are invalid.");
      if (!chunk.text.trim()) throw new Error("chunk text must not be empty.");
      const id = chunk.id ?? this.nextId();
      assertUuid(id, "chunkId");
      const contentSha256 = chunk.contentSha256 ?? hashChunk(chunk.text);
      assertSha256(contentSha256);
      statement.run(
        id,
        documentId,
        versionId,
        chunk.ordinal,
        chunk.text,
        chunk.startOffset,
        chunk.endOffset,
        chunk.pageStart,
        chunk.pageEnd,
        contentSha256,
        at,
      );
    }
    return this.database
      .prepare(
        `SELECT * FROM document_chunks WHERE document_id = ? AND version_id = ? ORDER BY ordinal`,
      )
      .all(documentId, versionId)
      .map((row) => this.mapChunk(row));
  }

  private assertCreateInput(input: CreatePendingDocumentInput, documentId: string, versionId: string, jobId: string | null) {
    assertUuid(documentId, "documentId");
    assertUuid(versionId, "versionId");
    if (jobId) assertUuid(jobId, "jobId");
    if (input.projectId) assertUuid(input.projectId, "projectId");
    if (input.folderId) assertUuid(input.folderId, "folderId");
    if (!input.filename.trim() || input.filename.length > MAX_WORKSPACE_FILENAME_LENGTH || input.filename.includes("/") || input.filename.includes("\\")) throw new Error("filename must be a safe single file name.");
    if (!input.mimeType.trim() || !Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0) throw new Error("document metadata is invalid.");
    assertSha256(input.contentSha256);
    if (input.storageKey !== documentStorageKey(documentId, versionId)) {
      throw new Error("storageKey must match the deterministic document locator.");
    }
  }

  private assertParseInput(input: ParseCommitInput) {
    assertUuid(input.documentId, "documentId");
    assertUuid(input.versionId, "versionId");
    assertUuid(input.jobId, "jobId");
    if (input.pageCount !== null && (!Number.isSafeInteger(input.pageCount) || input.pageCount < 0)) throw new Error("pageCount is invalid.");
  }

  private assertTerminalInput(input: TerminalParseInput) {
    assertUuid(input.documentId, "documentId");
    assertUuid(input.versionId, "versionId");
    assertUuid(input.jobId, "jobId");
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
        // Preserve the primary database failure.
      }
      throw error;
    }
  }

  private boundDocumentJob(
    jobId: string,
    documentId: string,
    versionId: string,
    expectedStatus: JobStatus,
    claim?: DocumentParseClaim,
  ) {
    const row = this.database.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId);
    if (!row || row.type !== "document_parse" || row.resource_type !== "document" || row.resource_id !== documentId || row.status !== expectedStatus) {
      if (claim) throw new DocumentParseClaimLostError();
      throw new Error("Document parse job is not bound to the requested document/version or status.");
    }
    const payload = parseJson(row.payload_json, null);
    if (
      !payload ||
      typeof payload !== "object" ||
      (payload as Record<string, unknown>).documentId !== documentId ||
      (payload as Record<string, unknown>).versionId !== versionId
    ) {
      if (claim) throw new DocumentParseClaimLostError();
      throw new Error("Document parse job payload is not bound to the requested document/version.");
    }
    if (claim) this.assertClaimRow(row, claim);
    return row;
  }

  private assertCommitClaim(
    transitionJob: boolean,
    claim: DocumentParseClaim | undefined,
  ) {
    if (!transitionJob && !claim) throw new DocumentParseClaimLostError();
  }

  private assertClaimRow(
    row: Record<string, unknown>,
    claim: DocumentParseClaim,
  ) {
    if (
      !claim.leaseOwner.trim() ||
      !Number.isSafeInteger(claim.attempt) ||
      claim.attempt < 1
    ) {
      throw new DocumentParseClaimLostError();
    }
    const now = Date.parse(this.now());
    const expiresAt = Date.parse(String(row.lease_expires_at ?? ""));
    if (
      row.status !== "running" ||
      row.lease_owner !== claim.leaseOwner ||
      Number(row.attempt) !== claim.attempt ||
      !Number.isFinite(now) ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= now ||
      row.cancel_requested_at != null
    ) {
      throw new DocumentParseClaimLostError();
    }
  }

  private isFtsUnavailable(error: unknown) {
    if (!(error instanceof Error)) return false;
    return /no such table:\s*document_chunks_fts|no such module:\s*fts5|fts5.*(?:not available|unsupported)|unable to use function MATCH/i.test(error.message);
  }

  private mustGetDocument(documentId: string) {
    const value = this.getDocument(documentId);
    if (!value) throw new Error("Document could not be reloaded after write.");
    return value;
  }

  private mustGetVersion(documentId: string, versionId: string) {
    const value = this.getVersion(documentId, versionId);
    if (!value) throw new Error("Document version could not be reloaded after write.");
    return value;
  }

  private mustGetJob(jobId: string) {
    const value = this.getJob(jobId);
    if (!value) throw new Error("Document parse job could not be reloaded after write.");
    return value;
  }

  private mapDocument(row: Record<string, unknown>): Document {
    return {
      id: asString(row.id, "document id"),
      projectId: asNullableString(row.project_id),
      folderId: asNullableString(row.folder_id),
      title: asString(row.title, "document title"),
      filename: asString(row.filename, "document filename"),
      mimeType: asString(row.mime_type, "document mime type"),
      sizeBytes: asNumber(row.size_bytes, "document size"),
      status: asDocumentStatus(row.parse_status),
      currentVersionId: asNullableString(row.current_version_id),
      createdAt: asString(row.created_at, "document createdAt"),
      updatedAt: asString(row.updated_at, "document updatedAt"),
    };
  }

  private mapVersion(row: Record<string, unknown>): DocumentVersionRow {
    return {
      id: asString(row.id, "version id"),
      documentId: asString(row.document_id, "version document id"),
      versionNumber: asNumber(row.version_number, "version number"),
      source: asSource(row.source),
      filename: asString(row.filename, "version filename"),
      mimeType: asString(row.mime_type, "version mime type"),
      sizeBytes: asNumber(row.size_bytes, "version size"),
      contentSha256: asString(row.content_sha256, "version content hash"),
      pageCount: row.page_count == null ? null : asNumber(row.page_count, "version page count"),
      createdAt: asString(row.created_at, "version createdAt"),
      storageKey: asString(row.storage_key, "version storage key"),
      previewStorageKey: asNullableString(row.preview_storage_key),
      deletedAt: asNullableString(row.deleted_at),
    };
  }

  private mapChunk(row: Record<string, unknown>): DocumentChunk {
    return {
      id: asString(row.id, "chunk id"),
      documentId: asString(row.document_id, "chunk document id"),
      versionId: asString(row.version_id, "chunk version id"),
      ordinal: asNumber(row.ordinal, "chunk ordinal"),
      text: asString(row.text, "chunk text"),
      startOffset: asNumber(row.start_offset, "chunk start offset"),
      endOffset: asNumber(row.end_offset, "chunk end offset"),
      pageStart: row.page_start == null ? null : asNumber(row.page_start, "chunk page start"),
      pageEnd: row.page_end == null ? null : asNumber(row.page_end, "chunk page end"),
      createdAt: asString(row.created_at, "chunk createdAt"),
    };
  }

  private mapJob(row: Record<string, unknown>): DocumentParseJob {
    if (row.type !== "document_parse" || row.resource_type !== "document") {
      throw new Error("Workspace job is not a document parse job.");
    }
    const payload = parseJson(row.payload_json, null);
    if (!payload || typeof payload !== "object") {
      throw new Error("Document parse job payload is invalid.");
    }
    assertUuid(String((payload as Record<string, unknown>).documentId), "job documentId");
    assertUuid(String((payload as Record<string, unknown>).versionId), "job versionId");
    if ((payload as Record<string, unknown>).documentId !== row.resource_id) {
      throw new Error("Document parse job resource and payload do not match.");
    }
    return {
      id: asString(row.id, "job id"),
      type: "document_parse",
      status: asJobStatus(row.status),
      resourceType: "document",
      resourceId: asString(row.resource_id, "job resource id"),
      attempt: asNumber(row.attempt, "job attempt"),
      maxAttempts: asNumber(row.max_attempts, "job max attempts"),
      retryable: Number(row.retryable) === 1,
      createdAt: asString(row.created_at, "job createdAt"),
      scheduledAt: asString(row.scheduled_at, "job scheduledAt"),
      startedAt: asNullableString(row.started_at),
      completedAt: asNullableString(row.completed_at),
    };
  }

  /** Focused audit diagnostic; it is never part of a transport projection. */
  lastSearchMode: "fts" | "like" | null = null;
}

export function documentStorageKey(documentId: string, versionId: string) {
  assertUuid(documentId, "documentId");
  assertUuid(versionId, "versionId");
  return `documents/${documentId}/versions/${versionId}/original`;
}
