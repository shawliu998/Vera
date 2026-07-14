import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";

import type {
  WorkspaceV1Context,
  WorkspaceV1DocumentCapability,
  WorkspaceV1DocumentList,
  WorkspaceV1DocumentMutationScope,
  WorkspaceV1DocumentUploadInput,
  WorkspaceV1DocumentVersionUploadInput,
  WorkspaceV1Download,
  WorkspaceV1Page,
  WorkspaceV1RuntimePort,
} from "../../routes/workspaceV1";
import { LocalWorkspaceBlobStore } from "./localWorkspaceBlobStore";
import { WorkspaceDatabase } from "./database";
import { InMemoryDownloadCapabilityStore } from "./downloadCapabilities";
import { WorkspaceApiError } from "./errors";
import { WorkspaceJobPump } from "./jobs/pump";
import {
  MIKE_LOCAL_USER_ID,
  serializeMikeDocument,
  serializeMikeDocumentVersion,
  serializeMikeProject,
  type MikeDocumentVersionWire,
  type MikeDocumentWire,
  type MikeProjectWire,
} from "./mikeCompatibility";
import { WORKSPACE_LOCAL_PRINCIPAL_ID } from "./principal";
import { WorkspaceBlobCleanupRepository } from "./repositories/blobCleanup";
import { WorkspaceBlobRecordsRepository } from "./repositories/blobRecords";
import {
  type DocumentParseJob,
  WorkspaceDocumentsRepository,
} from "./repositories/documents";
import { WorkspaceJobsRepository } from "./repositories/jobs";
import {
  type ProjectOverview,
  type ProjectSummary,
  ProjectsRepository,
} from "./repositories/projects";
import {
  WorkspaceBlobReconciliation,
  WorkspaceBlobStartupRecovery,
} from "./services/blobReconciliation";
import { WorkspaceBlobCleanupReplay } from "./services/blobCleanup";
import { WorkspaceDocumentCatalogService } from "./services/documentCatalog";
import {
  type DocumentUploadResult,
  type PublicDocumentVersion,
  WorkspaceDocumentsService,
} from "./services/documents";
import { WorkspaceDocumentParser } from "./documentParsing";
import {
  WorkspaceJobAbortRegistry,
  WorkspaceJobsService,
} from "./services/jobs";
import { WorkspaceJobEnqueuerAdapter } from "./services/jobEnqueuer";
import { ProjectsService } from "./services/projects";
import { WorkflowsService } from "./services/workflows";
import type { ProjectLifecycleCleanupRecord } from "./services/projects";
import type { Document, ProjectFolder } from "./types";
import { WorkflowsRepository } from "./repositories/workflows";
import {
  MikeWorkflowCrudPortAdapter,
  seedPinnedMikeSystemWorkflows,
} from "./workflowCompatibility";

type CleanupRecorder = ConstructorParameters<
  typeof WorkspaceDocumentsService
>[3];

type WorkspaceProjectWire = MikeProjectWire & {
  description: string | null;
  workflow_count: number;
  status: "active" | "archived" | "deleted";
  archived_at: string | null;
  default_model_profile_id: string | null;
};
type WorkspaceDocumentJobWire = {
  id: string;
  type: "document_parse";
  status: DocumentParseJob["status"];
  attempt: number;
  max_attempts: number;
  retryable: boolean;
  created_at: string;
  scheduled_at: string;
  started_at: string | null;
  completed_at: string | null;
};
type WorkspaceDocumentMutationWire = {
  document: MikeDocumentWire;
  version: MikeDocumentVersionWire;
  job: WorkspaceDocumentJobWire;
};

type ProjectRequest = {
  name?: unknown;
  description?: unknown;
  cm_number?: unknown;
  practice?: unknown;
};
type FolderRequest = { name?: unknown; parent_folder_id?: unknown };

export type WorkspaceRuntimeHealth = {
  started: boolean;
  draining: boolean;
  worker: { documentParse: boolean };
};

export type WorkspaceRuntimeDependencies = {
  dataDir?: string;
  database?: WorkspaceDatabase;
  blobs?: LocalWorkspaceBlobStore;
  capabilities?: InMemoryDownloadCapabilityStore;
  abortRegistry?: WorkspaceJobAbortRegistry;
  jobs?: WorkspaceJobsService;
  pump?: Pick<WorkspaceJobPump, "start" | "stop" | "snapshot">;
  projects?: ProjectsService;
  projectRepository?: ProjectsRepository;
  documents?: WorkspaceDocumentCatalogService;
  documentService?: WorkspaceDocumentsService;
  documentRepository?: WorkspaceDocumentsRepository;
  workflows?: WorkflowsService;
  workflowCrud?: MikeWorkflowCrudPortAdapter;
  seedWorkflows?: (workflows: WorkflowsService) => readonly unknown[];
  /** Read-only authority for derived blob metadata.  This is injectable solely
   * for runtime integration tests; production shares the repository instance. */
  blobRecords?: WorkspaceBlobRecordsRepository;
  runMigrations?: (database: WorkspaceDatabase) => void;
  /** Test seams for the existing startup-recovery coordinator. Production
   * always uses the durable cleanup replay followed by reconciliation. */
  cleanupReplay?: Pick<WorkspaceBlobCleanupReplay, "replayPending">;
  blobReconciliation?: Pick<WorkspaceBlobReconciliation, "reconcile">;
  startupRecovery?: Pick<WorkspaceBlobStartupRecovery, "recover">;
};

function defaultDataDir() {
  return process.env.ALETHEIA_DATA_DIR ?? path.join(process.cwd(), ".aletheia");
}

function requireLocal(context: WorkspaceV1Context) {
  if (context.principalId !== WORKSPACE_LOCAL_PRINCIPAL_ID) {
    throw new WorkspaceApiError(403, "FORBIDDEN", "Workspace is local-only.");
  }
}

function requestRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkspaceApiError(
      400,
      "VALIDATION_ERROR",
      `${label} is invalid.`,
    );
  }
  return value as Record<string, unknown>;
}

function projectRequest(value: unknown): ProjectRequest {
  const input = requestRecord(value, "Project request");
  return {
    name: input.name,
    description: input.description,
    cm_number: input.cm_number,
    practice: input.practice,
  };
}

function folderRequest(value: unknown): FolderRequest {
  const input = requestRecord(value, "Folder request");
  return { name: input.name, parent_folder_id: input.parent_folder_id };
}

/**
 * The one workspace composition root. It owns exactly one WorkspaceDatabase
 * handle and is the only place that wires durable cleanup, blobs, jobs, and
 * the HTTP facade together.
 */
export class WorkspaceRuntime implements WorkspaceV1RuntimePort {
  readonly database: WorkspaceDatabase;
  readonly blobs: LocalWorkspaceBlobStore;
  readonly capabilities: InMemoryDownloadCapabilityStore;
  readonly abortRegistry: WorkspaceJobAbortRegistry;
  readonly jobs: WorkspaceJobsService;
  readonly pump: Pick<WorkspaceJobPump, "start" | "stop" | "snapshot">;
  readonly projects: ProjectsService;
  readonly documents: WorkspaceDocumentCatalogService;
  readonly workflows: WorkflowsService;
  readonly workflowCrud: MikeWorkflowCrudPortAdapter;
  private readonly documentService: WorkspaceDocumentsService;
  private readonly documentRepository: WorkspaceDocumentsRepository;
  private readonly blobRecords: WorkspaceBlobRecordsRepository;
  private readonly startMigrations: () => void;
  private readonly startupRecovery: Pick<
    WorkspaceBlobStartupRecovery,
    "recover"
  >;
  private readonly seedWorkflows: () => void;
  private started = false;
  private draining = false;
  private closed = false;

  constructor(dependencies: WorkspaceRuntimeDependencies = {}) {
    const dataDir = dependencies.dataDir ?? defaultDataDir();
    // Fully injected test seams do not need (and must not create) a default
    // application directory. Production, or any partially injected runtime,
    // still creates its locally controlled directory before opening storage.
    if (!dependencies.database || !dependencies.blobs) {
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      chmodSync(dataDir, 0o700);
    }
    this.database =
      dependencies.database ??
      new WorkspaceDatabase(path.join(dataDir, "aletheia.db"), {
        migrate: false,
      });
    this.blobs =
      dependencies.blobs ??
      new LocalWorkspaceBlobStore({
        root: path.join(dataDir, "workspace-blobs"),
      });
    this.capabilities =
      dependencies.capabilities ?? new InMemoryDownloadCapabilityStore();
    this.abortRegistry =
      dependencies.abortRegistry ?? new WorkspaceJobAbortRegistry();

    const blobRecords =
      dependencies.blobRecords ??
      new WorkspaceBlobRecordsRepository(this.database);
    this.blobRecords = blobRecords;
    const cleanupLedger = new WorkspaceBlobCleanupRepository(this.database);
    this.documentRepository =
      dependencies.documentRepository ??
      new WorkspaceDocumentsRepository(this.database, { blobRecords });
    const jobsRepository = new WorkspaceJobsRepository(this.database);
    this.jobs =
      dependencies.jobs ??
      new WorkspaceJobsService(jobsRepository, {
        abortRegistry: this.abortRegistry,
      });
    this.workflows =
      dependencies.workflows ??
      new WorkflowsService(
        new WorkflowsRepository(this.database),
        new WorkspaceJobEnqueuerAdapter(this.jobs),
      );
    this.workflowCrud =
      dependencies.workflowCrud ??
      new MikeWorkflowCrudPortAdapter(this.workflows);
    const cleanupRecorder: CleanupRecorder = {
      record: (input) => cleanupLedger.record(input),
    };
    const lifecycle = {
      cancelQueued: (ids: readonly string[], reason: string) => {
        for (const id of ids) this.requestJobCancellation(id, reason);
      },
      requestAbortRunning: (ids: readonly string[], reason: string) => {
        for (const id of ids) {
          this.requestJobCancellation(id, reason);
        }
      },
    };
    const projectCleanupRecorder = {
      record: (input: ProjectLifecycleCleanupRecord) => {
        if (input.locator.kind === "export") {
          throw new Error("Project cleanup cannot record an export blob.");
        }
        cleanupLedger.record({
          operation: input.operation,
          code:
            input.operation === "restore"
              ? "DOCUMENT_BLOB_RESTORE_FAILED"
              : "DOCUMENT_BLOB_FINALIZE_FAILED",
          documentId: input.locator.documentId,
          versionId: input.locator.versionId,
          locator: input.locator,
          receipt: input.receipt,
        });
      },
    };
    const projectsRepository =
      dependencies.projectRepository ?? new ProjectsRepository(this.database);
    this.projects =
      dependencies.projects ??
      new ProjectsService(projectsRepository, this.blobs, {
        resources: lifecycle,
        cleanupRecorder: projectCleanupRecorder,
      });
    this.documentService =
      dependencies.documentService ??
      new WorkspaceDocumentsService(
        this.documentRepository,
        this.blobs,
        undefined,
        cleanupRecorder,
        lifecycle,
      );
    this.documents =
      dependencies.documents ??
      new WorkspaceDocumentCatalogService(
        this.documentRepository,
        this.documentService,
        this.blobs,
        this.capabilities,
      );
    const parser = new WorkspaceDocumentParser(
      this.documentRepository,
      this.blobs,
      undefined,
      undefined,
      cleanupRecorder,
    );
    this.pump =
      dependencies.pump ??
      new WorkspaceJobPump({
        jobs: this.jobs,
        abortRegistry: this.abortRegistry,
        handlers: { document_parse: (context) => parser.handleJob(context) },
      });
    const cleanupReplay =
      dependencies.cleanupReplay ??
      new WorkspaceBlobCleanupReplay(cleanupLedger, blobRecords, this.blobs);
    const blobReconciliation =
      dependencies.blobReconciliation ??
      new WorkspaceBlobReconciliation(
        blobRecords,
        this.blobs,
        this.documentRepository,
      );
    this.startMigrations = () => {
      if (dependencies.runMigrations) dependencies.runMigrations(this.database);
      else this.database.runMigrations();
    };
    this.startupRecovery =
      dependencies.startupRecovery ??
      new WorkspaceBlobStartupRecovery(cleanupReplay, blobReconciliation);
    this.seedWorkflows = () => {
      const seeded = dependencies.seedWorkflows
        ? dependencies.seedWorkflows(this.workflows)
        : seedPinnedMikeSystemWorkflows(this.workflows);
      if (seeded.length !== 21) {
        throw new Error(
          "Pinned Mike workflow seeding did not produce 21 templates.",
        );
      }
    };
  }

  async start() {
    if (this.started) return;
    if (this.closed) throw new Error("Workspace runtime is closed.");
    try {
      this.startMigrations();
      this.seedWorkflows();
      this.startupRecovery.recover();
      await this.pump.start();
      this.started = true;
    } catch (error) {
      try {
        await this.pump.stop();
      } catch {
        /* startup failure wins */
      } finally {
        this.abortRegistry.abortAll();
        this.capabilities.clear();
      }
      this.database.close();
      this.closed = true;
      throw error;
    }
  }

  async stop() {
    if (this.closed) return;
    this.draining = true;
    let drainTimedOut = false;
    try {
      const result = await this.pump.stop();
      drainTimedOut = result.drained === false;
    } finally {
      this.abortRegistry.abortAll();
      this.capabilities.clear();
      this.database.close();
      this.started = false;
      this.closed = true;
      this.draining = false;
    }
    if (drainTimedOut) {
      throw new Error("Workspace jobs did not drain before shutdown.");
    }
  }

  health(): WorkspaceRuntimeHealth {
    const pump = this.pump.snapshot();
    return {
      started: this.started,
      draining: this.draining,
      worker: { documentParse: pump.started && !pump.stopping },
    };
  }

  async listProjects(context: WorkspaceV1Context, page: WorkspaceV1Page) {
    this.requireAccess(context);
    const explicitlyPaged =
      page.cursor !== undefined || page.limit !== undefined;
    if (explicitlyPaged) {
      const result = this.projects.list({
        cursor: page.cursor ?? null,
        limit: page.limit,
      });
      if (Array.isArray(result)) {
        return {
          items: result.map((project) => this.projectSummaryWire(project)),
          next_cursor: null,
        };
      }
      return {
        items: result.items.map((project) => this.projectSummaryWire(project)),
        next_cursor: result.nextCursor,
      };
    }

    // Locked Mike e32daad clients expect GET /projects to return Project[],
    // not a pagination envelope. Walk the bounded repository pages internally
    // so the direct UI port remains byte-shape compatible while local callers
    // can opt into cursor pagination explicitly.
    const items: WorkspaceProjectWire[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const result = this.projects.list({ cursor, limit: 100 });
      if (Array.isArray(result)) {
        items.push(
          ...result.map((project) => this.projectSummaryWire(project)),
        );
        cursor = null;
        continue;
      }
      items.push(
        ...result.items.map((project) => this.projectSummaryWire(project)),
      );
      cursor = result.nextCursor;
      if (cursor && seenCursors.has(cursor)) {
        throw new WorkspaceApiError(
          500,
          "INTERNAL_ERROR",
          "Project pagination did not advance.",
        );
      }
      if (cursor) seenCursors.add(cursor);
    } while (cursor);
    return items;
  }
  async createProject(context: WorkspaceV1Context, input: unknown) {
    this.requireAccess(context);
    const request = projectRequest(input);
    const p = this.projects.create({
      name: request.name,
      description: request.description,
      cmNumber: request.cm_number,
      practice: request.practice,
    });
    return this.projectWire(this.projects.overview(p.id));
  }
  async getProject(context: WorkspaceV1Context, id: string) {
    this.requireAccess(context);
    return this.projectWire(this.projects.overview(id));
  }
  async updateProject(context: WorkspaceV1Context, id: string, input: unknown) {
    this.requireAccess(context);
    const request = projectRequest(input);
    this.projects.update(id, {
      name: request.name,
      description: request.description,
      cmNumber: request.cm_number,
      practice: request.practice,
    });
    return this.projectWire(this.projects.overview(id));
  }
  async archiveProject(context: WorkspaceV1Context, id: string) {
    this.requireAccess(context);
    this.projects.archive(id);
    return this.projectWire(this.projects.overview(id));
  }
  async unarchiveProject(context: WorkspaceV1Context, id: string) {
    this.requireAccess(context);
    this.projects.unarchive(id);
    return this.projectWire(this.projects.overview(id));
  }
  async deleteProject(
    context: WorkspaceV1Context,
    id: string,
    confirmName: string,
  ) {
    this.requireAccess(context);
    this.projects.permanentlyDelete(id, confirmName);
  }
  async listFolders(context: WorkspaceV1Context, projectId: string) {
    this.requireAccess(context);
    this.projects.get(projectId);
    return this.projects
      .listFolders(projectId)
      .map((folder) => this.folderWire(folder));
  }
  async createFolder(
    context: WorkspaceV1Context,
    projectId: string,
    input: unknown,
  ) {
    this.requireAccess(context);
    this.projects.get(projectId);
    const request = folderRequest(input);
    return this.folderWire(
      this.projects.createFolder(projectId, {
        name: request.name,
        parentFolderId: request.parent_folder_id,
      }),
    );
  }
  async updateFolder(
    context: WorkspaceV1Context,
    projectId: string,
    folderId: string,
    input: unknown,
  ) {
    this.requireAccess(context);
    const request = folderRequest(input);
    const folder = this.projects.getFolder(folderId);
    if (folder.projectId !== projectId)
      throw new WorkspaceApiError(404, "NOT_FOUND", "Folder not found.");
    return this.folderWire(
      this.projects.updateFolder(folderId, {
        name: request.name,
        parentFolderId: request.parent_folder_id,
      }),
    );
  }
  async deleteFolder(
    context: WorkspaceV1Context,
    projectId: string,
    folderId: string,
  ) {
    this.requireAccess(context);
    const folder = this.projects.getFolder(folderId);
    if (folder.projectId !== projectId)
      throw new WorkspaceApiError(404, "NOT_FOUND", "Folder not found.");
    this.projects.deleteFolder(folderId);
  }
  async listDocuments(
    context: WorkspaceV1Context,
    query: WorkspaceV1DocumentList,
  ) {
    this.requireAccess(context);
    this.assertDocumentCursorUnsupported(query.cursor);
    return this.documents
      .list({
        projectId: query.standalone ? null : query.projectId,
        folderId: query.folderId,
        status: query.status === "error" ? "failed" : query.status,
        limit: query.limit,
      })
      .map((document) => this.documentWire(document));
  }
  async listProjectDocuments(
    context: WorkspaceV1Context,
    projectId: string,
    page: WorkspaceV1Page,
  ) {
    this.requireAccess(context);
    this.assertDocumentCursorUnsupported(page.cursor);
    this.projects.get(projectId);
    return this.documents
      .list({ projectId, limit: page.limit })
      .map((document) => this.documentWire(document));
  }
  async attachProjectDocument(
    context: WorkspaceV1Context,
    projectId: string,
    documentId: string,
  ) {
    this.requireAccess(context);
    this.projects.get(projectId);
    const document = this.documents.get(documentId).document;
    if (document.projectId !== null && document.projectId !== projectId) {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "A document in another project cannot be attached here.",
      );
    }
    return this.documentWire(this.documents.attach(documentId, projectId));
  }
  async uploadDocument(
    context: WorkspaceV1Context,
    input: WorkspaceV1DocumentUploadInput,
  ) {
    this.requireAccess(context);
    this.assertUploadPlacement(input.projectId, input.folderId);
    const result = await this.documentService.upload(input);
    return this.documentMutationWire(result);
  }
  async uploadDocumentVersion(
    context: WorkspaceV1Context,
    documentId: string,
    input: WorkspaceV1DocumentVersionUploadInput,
    scope?: WorkspaceV1DocumentMutationScope,
  ) {
    this.requireAccess(context);
    this.assertDocumentScope(documentId, scope?.projectId);
    const result = await this.documents.uploadVersion(documentId, input);
    return this.documentMutationWire(result);
  }
  async deleteDocument(
    context: WorkspaceV1Context,
    documentId: string,
    scope?: WorkspaceV1DocumentMutationScope,
  ) {
    this.requireAccess(context);
    this.assertDocumentScope(documentId, scope?.projectId);
    this.documents.delete(documentId);
  }
  async retryDocumentParse(
    context: WorkspaceV1Context,
    documentId: string,
    scope?: WorkspaceV1DocumentMutationScope,
  ) {
    this.requireAccess(context);
    this.assertDocumentScope(documentId, scope?.projectId);
    const job = this.documents.retryParse(documentId);
    return job ? { job: this.documentJobWire(job) } : null;
  }
  async renameProjectDocument(
    context: WorkspaceV1Context,
    projectId: string,
    documentId: string,
    filename: string,
  ) {
    this.requireAccess(context);
    this.assertDocumentProject(documentId, projectId);
    return this.documentWire(this.documents.rename(documentId, filename));
  }
  async moveProjectDocument(
    context: WorkspaceV1Context,
    projectId: string,
    documentId: string,
    folderId: string | null,
  ) {
    this.requireAccess(context);
    this.assertDocumentProject(documentId, projectId);
    if (folderId) {
      const folder = this.projects.getFolder(folderId);
      if (folder.projectId !== projectId)
        throw new WorkspaceApiError(404, "NOT_FOUND", "Folder not found.");
    }
    return this.documentWire(
      this.documents.move(documentId, projectId, folderId),
    );
  }
  async getDocument(context: WorkspaceV1Context, documentId: string) {
    this.requireAccess(context);
    return this.documentWire(this.documents.get(documentId).document);
  }
  async listDocumentVersions(context: WorkspaceV1Context, documentId: string) {
    this.requireAccess(context);
    const detail = this.documents.get(documentId);
    return {
      current_version_id: detail.document.currentVersionId,
      versions: this.documents
        .listVersions(documentId)
        .map((version) => this.documentVersionWire(version)),
    };
  }
  async readDocument(
    context: WorkspaceV1Context,
    documentId: string,
    versionId?: string,
  ) {
    this.requireAccess(context);
    const detail = this.documents.get(documentId);
    const id = versionId ?? detail.document.currentVersionId;
    if (!id)
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Document has no active version.",
      );
    const version = this.documentRepository.getVersion(documentId, id);
    const locator = {
      kind: "extracted_text" as const,
      documentId,
      versionId: id,
    };
    const record = this.blobRecords.getByLocator(locator);
    if (!version || !record || record.state !== "stored") {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Extracted text is not available for this document.",
      );
    }
    const buffer = this.blobs.readSync(locator, {
      sha256: record.contentSha256,
      size: record.sizeBytes,
    });
    const sha256 = createHash("sha256").update(buffer).digest("hex");
    if (
      buffer.byteLength !== record.sizeBytes ||
      sha256 !== record.contentSha256
    ) {
      throw new WorkspaceApiError(
        500,
        "INTERNAL_ERROR",
        "Extracted text integrity check failed.",
      );
    }
    return {
      document_id: documentId,
      version_id: id,
      content: buffer.toString("utf8"),
    };
  }
  async displayDocument(
    context: WorkspaceV1Context,
    documentId: string,
    versionId?: string,
  ): Promise<WorkspaceV1Download> {
    this.requireAccess(context);
    const id =
      versionId ?? this.documents.get(documentId).document.currentVersionId;
    if (!id)
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Document has no active version.",
      );
    const result = this.documents.readOriginal(documentId, id);
    return {
      filename: result.filename,
      contentType: result.mimeType,
      body: result.buffer,
      contentLength: result.contentLength,
      disposition: "inline",
    };
  }
  async getDocumentDownload(
    context: WorkspaceV1Context,
    documentId: string,
    versionId?: string,
  ): Promise<WorkspaceV1DocumentCapability> {
    return this.capability(context, documentId, versionId, "download");
  }
  async getDocumentVersionFile(
    context: WorkspaceV1Context,
    documentId: string,
    versionId: string,
  ): Promise<WorkspaceV1DocumentCapability> {
    return this.capability(context, documentId, versionId, "display");
  }
  async resolveDownload(
    context: WorkspaceV1Context,
    token: string,
  ): Promise<WorkspaceV1Download> {
    this.requireAccess(context);
    const result = this.documents.readCapability(token);
    return {
      filename: result.filename,
      contentType: result.mimeType,
      body: result.buffer,
      contentLength: result.contentLength,
      disposition: "attachment",
    };
  }

  private capability(
    context: WorkspaceV1Context,
    documentId: string,
    versionId: string | undefined,
    purpose: "display" | "download",
  ): WorkspaceV1DocumentCapability {
    this.requireAccess(context);
    const detail = this.documents.get(documentId);
    const id = versionId ?? detail.document.currentVersionId;
    if (!id)
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Document has no active version.",
      );
    const issued = this.documents.issueCapability(documentId, id, purpose);
    return {
      url: issued.url,
      download_url: issued.url,
      document_id: documentId,
      filename: this.documents.getVersion(documentId, id).filename,
      version_id: id,
      has_pdf_rendition: this.hasPreview(documentId, id),
    };
  }
  private assertDocumentProject(documentId: string, projectId: string) {
    const doc = this.documents.get(documentId).document;
    if (doc.projectId !== projectId)
      throw new WorkspaceApiError(404, "NOT_FOUND", "Document not found.");
  }
  private requireAccess(context: WorkspaceV1Context) {
    requireLocal(context);
    if (!this.started || this.draining || this.closed) {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Workspace runtime is not accepting requests.",
      );
    }
  }
  private assertDocumentScope(
    documentId: string,
    projectId: string | null | undefined,
  ) {
    if (projectId === undefined) return;
    const document = this.documents.get(documentId).document;
    if (document.projectId !== projectId) {
      throw new WorkspaceApiError(404, "NOT_FOUND", "Document not found.");
    }
  }
  private assertUploadPlacement(
    projectId: string | null,
    folderId: string | null,
  ) {
    if (projectId === null) {
      if (folderId !== null) {
        throw new WorkspaceApiError(
          422,
          "VALIDATION_ERROR",
          "A folder requires a project.",
        );
      }
      return;
    }
    this.projects.get(projectId);
    if (folderId !== null) {
      const folder = this.projects.getFolder(folderId);
      if (folder.projectId !== projectId) {
        throw new WorkspaceApiError(404, "NOT_FOUND", "Folder not found.");
      }
    }
  }
  private requestJobCancellation(id: string, reason: string) {
    this.jobs.requestCancellation(id, reason);
  }
  private assertDocumentCursorUnsupported(cursor: string | undefined) {
    if (cursor !== undefined) {
      throw new WorkspaceApiError(
        400,
        "VALIDATION_ERROR",
        "Document cursor pagination is not available in this runtime.",
      );
    }
  }
  private hasPreview(documentId: string, versionId: string) {
    return (
      this.blobRecords.getByLocator({
        kind: "preview",
        documentId,
        versionId,
      })?.state === "stored"
    );
  }
  private projectSummaryWire(project: ProjectSummary): WorkspaceProjectWire {
    const wire = serializeMikeProject({
      id: project.id,
      name: project.name,
      cmNumber: project.cmNumber,
      practice: project.practice,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      documentCount: project.documentCount ?? 0,
      chatCount: project.chatCount ?? 0,
      reviewCount: project.reviewCount ?? 0,
    });
    return {
      ...wire,
      description: project.description,
      workflow_count: project.workflowCount ?? 0,
      status: project.status,
      archived_at: project.archivedAt,
      default_model_profile_id: project.defaultModelProfileId,
    };
  }
  private projectWire(project: ProjectOverview): WorkspaceProjectWire {
    return {
      ...this.projectSummaryWire(project),
      documents: this.documents
        .list({ projectId: project.id, limit: 100 })
        .map((document) => this.documentWire(document)),
      folders: project.folders.map((folder) => this.folderWire(folder)),
    };
  }
  private folderWire(folder: ProjectFolder) {
    return {
      id: folder.id,
      project_id: folder.projectId,
      user_id: MIKE_LOCAL_USER_ID,
      name: folder.name,
      parent_folder_id: folder.parentFolderId,
      created_at: folder.createdAt,
      updated_at: folder.updatedAt,
    };
  }
  private documentWire(document: Document): MikeDocumentWire {
    const versions = this.documents.listVersions(document.id);
    const active = document.currentVersionId
      ? (versions.find((version) => version.id === document.currentVersionId) ??
        null)
      : null;
    const latest = versions.reduce(
      (current: PublicDocumentVersion | null, version) =>
        !current || version.versionNumber > current.versionNumber
          ? version
          : current,
      null as PublicDocumentVersion | null,
    );
    const hasPreview = Boolean(
      active && this.hasPreview(document.id, active.id),
    );
    return serializeMikeDocument({
      id: document.id,
      projectId: document.projectId,
      folderId: document.folderId,
      filename: document.filename,
      mimeType: document.mimeType,
      sizeBytes: document.sizeBytes,
      pageCount: active?.pageCount ?? null,
      status: document.status,
      createdAt: document.createdAt,
      updatedAt: document.updatedAt,
      activeVersionNumber: active?.versionNumber ?? null,
      latestVersionNumber: latest?.versionNumber ?? null,
      hasPreview,
    });
  }
  private documentVersionWire(version: PublicDocumentVersion) {
    return serializeMikeDocumentVersion({
      id: version.id,
      versionNumber: version.versionNumber,
      source: version.source,
      filename: version.filename,
      mimeType: version.mimeType,
      sizeBytes: version.sizeBytes,
      pageCount: version.pageCount,
      createdAt: version.createdAt,
      deletedAt: null,
      deletedBy: null,
    });
  }
  private documentJobWire(job: DocumentParseJob): WorkspaceDocumentJobWire {
    return {
      id: job.id,
      type: job.type,
      status: job.status,
      attempt: job.attempt,
      max_attempts: job.maxAttempts,
      retryable: job.retryable,
      created_at: job.createdAt,
      scheduled_at: job.scheduledAt,
      started_at: job.startedAt,
      completed_at: job.completedAt,
    };
  }
  private documentMutationWire(
    result: DocumentUploadResult,
  ): WorkspaceDocumentMutationWire {
    return {
      document: this.documentWire(result.document),
      version: this.documentVersionWire(result.version),
      job: this.documentJobWire(result.job),
    };
  }
}

export function createWorkspaceRuntime(
  dependencies: WorkspaceRuntimeDependencies = {},
) {
  return new WorkspaceRuntime(dependencies);
}
