import type { WorkspaceBlobLocator } from "../blobStore";
import { z } from "zod";
import type { WorkspaceDatabaseAdapter } from "../database";
import {
  assertNoActiveProjectWorkflowForFolder,
  assertNoDurableDocumentHistory,
  listActiveFolderAssistantJobs,
} from "../documentDeletionPolicy";
import { WorkspaceApiError } from "../errors";
import { workspaceBlobStorageKey } from "./blobRecords";
import {
  normalizePageRequest,
  type Page,
  type PageRequest,
} from "../pagination";
import type { Project, ProjectFolder } from "../types";
import type { WorkspaceInferenceActivityScope } from "../jobs/types";
import { WorkspaceIdSchema } from "../workspacePersistencePrimitivesV1";

type Row = Record<string, unknown>;

export type ProjectCounts = {
  documentCount: number;
  chatCount: number;
  reviewCount: number;
  workflowCount: number;
};

export type ProjectSummary = Project & ProjectCounts;
export type ProjectOverview = ProjectSummary & { folders: ProjectFolder[] };

export type AuthoritativeProjectBlob = {
  recordId: string;
  locator: Exclude<WorkspaceBlobLocator, { kind: "export" }>;
  state: "stored";
};

export type ActiveProjectResourceJob = {
  id: string;
  status: "queued" | "running";
};

/** Narrow read boundary used by the Matter conversion coordinator. */
export interface ProjectInferenceActivityReadPort {
  hasBlockingInferenceJobs(
    projectId: string,
    activeScopes: readonly WorkspaceInferenceActivityScope[],
  ): boolean;
}

export type StagedProjectBlob = {
  recordId: string;
  quarantineId: string;
};

export type ProjectDeletionPlan = {
  blobs: AuthoritativeProjectBlob[];
  activeJobs: ActiveProjectResourceJob[];
};

export type FolderDeletionPlan = ProjectDeletionPlan & {
  folder: ProjectFolder;
  folders: ProjectFolder[];
  documentIds: string[];
};

const PROJECT_WITH_COUNTS = `
  SELECT p.*,
    (SELECT count(*) FROM documents d
      WHERE d.project_id = p.id AND d.deleted_at IS NULL) AS document_count,
    (SELECT count(*) FROM chats c
      WHERE c.project_id = p.id) AS chat_count,
    (SELECT count(*) FROM tabular_reviews r
      WHERE r.project_id = p.id) AS review_count,
    (SELECT count(*) FROM workflows w
      WHERE w.project_id = p.id) AS workflow_count
  FROM projects p`;

const PROJECT_JOB_SCOPE_CTE = `
  WITH target(project_id) AS (VALUES (?)),
  project_documents AS (
    SELECT id FROM documents WHERE project_id = (SELECT project_id FROM target)
  ),
  project_chats AS (
    SELECT id FROM chats WHERE project_id = (SELECT project_id FROM target)
  ),
  project_reviews AS (
    SELECT id FROM tabular_reviews WHERE project_id = (SELECT project_id FROM target)
  ),
  project_cells AS (
    SELECT cell.id
      FROM tabular_cells cell
      LEFT JOIN tabular_reviews review ON review.id = cell.review_id
     WHERE review.project_id = (SELECT project_id FROM target)
        OR cell.document_id IN (SELECT id FROM project_documents)
  ),
  project_workflows AS (
    SELECT id FROM workflows WHERE project_id = (SELECT project_id FROM target)
  ),
  project_runs AS (
    SELECT id
      FROM workflow_runs
     WHERE project_id = (SELECT project_id FROM target)
        OR workflow_id IN (SELECT id FROM project_workflows)
  )`;

const PROJECT_JOB_SCOPE_PREDICATE = `
  (j.resource_type = 'project' AND j.resource_id = (SELECT project_id FROM target))
  OR (j.resource_type = 'document' AND j.resource_id IN (SELECT id FROM project_documents))
  OR (j.resource_type = 'chat' AND j.resource_id IN (SELECT id FROM project_chats))
  OR (j.resource_type = 'tabular_review' AND j.resource_id IN (SELECT id FROM project_reviews))
  OR (j.resource_type = 'tabular_cell' AND j.resource_id IN (SELECT id FROM project_cells))
  OR (j.resource_type = 'workflow_run' AND j.resource_id IN (SELECT id FROM project_runs))`;

const ProjectInferenceActivityScopeSchema = z.discriminatedUnion("scope", [
  z
    .object({
      jobId: WorkspaceIdSchema,
      type: z.enum(["assistant_generate", "workflow_run", "tabular_cell"]),
      scope: z.literal("project"),
      projectId: WorkspaceIdSchema,
    })
    .strict(),
  z
    .object({
      jobId: WorkspaceIdSchema,
      type: z.enum(["assistant_generate", "workflow_run", "tabular_cell"]),
      scope: z.literal("global"),
      projectId: z.null(),
    })
    .strict(),
  z
    .object({
      jobId: WorkspaceIdSchema,
      type: z.enum(["assistant_generate", "workflow_run", "tabular_cell"]),
      scope: z.literal("unresolved"),
      projectId: z.null(),
    })
    .strict(),
]);

const FOLDER_SCOPE_CTE = `
  WITH RECURSIVE folder_subtree(id) AS (
    SELECT id FROM project_subfolders WHERE id = ?
    UNION ALL
    SELECT child.id
      FROM project_subfolders child
      JOIN folder_subtree parent ON child.parent_folder_id = parent.id
  ),
  folder_documents AS (
    SELECT id FROM documents WHERE folder_id IN (SELECT id FROM folder_subtree)
  ),
  folder_cells AS (
    SELECT id FROM tabular_cells WHERE document_id IN (SELECT id FROM folder_documents)
  )`;

const FOLDER_JOB_SCOPE_PREDICATE = `
  (j.resource_type = 'document' AND j.resource_id IN (SELECT id FROM folder_documents))
  OR (j.resource_type = 'tabular_cell' AND j.resource_id IN (SELECT id FROM folder_cells))`;

const encodeCursor = (value: { updatedAt: string; id: string }) =>
  Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

function decodeCursor(cursor?: string | null) {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as { updatedAt?: unknown; id?: unknown };
    if (
      typeof parsed.updatedAt !== "string" ||
      typeof parsed.id !== "string" ||
      !parsed.updatedAt ||
      !parsed.id
    ) {
      throw new Error("invalid cursor");
    }
    return { updatedAt: parsed.updatedAt, id: parsed.id };
  } catch {
    throw new WorkspaceApiError(
      400,
      "VALIDATION_ERROR",
      "Invalid pagination cursor.",
    );
  }
}

function asNonNegativeCount(value: unknown, label: string) {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new WorkspaceApiError(
      500,
      "INTERNAL_ERROR",
      `Invalid persisted ${label}.`,
    );
  }
  return count;
}

function mapProject(row: Row): Project {
  const status = String(row.status);
  if (status !== "active" && status !== "archived" && status !== "deleted") {
    throw new WorkspaceApiError(
      500,
      "INTERNAL_ERROR",
      "Invalid persisted project status.",
    );
  }
  return {
    id: String(row.id),
    name: String(row.name),
    description: row.description == null ? null : String(row.description),
    cmNumber: row.cm_number == null ? null : String(row.cm_number),
    practice: row.practice == null ? null : String(row.practice),
    status,
    defaultModelProfileId:
      row.default_model_profile_id == null
        ? null
        : String(row.default_model_profile_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    archivedAt: row.archived_at == null ? null : String(row.archived_at),
  };
}

function mapProjectSummary(row: Row): ProjectSummary {
  return {
    ...mapProject(row),
    documentCount: asNonNegativeCount(row.document_count, "document count"),
    chatCount: asNonNegativeCount(row.chat_count, "chat count"),
    reviewCount: asNonNegativeCount(row.review_count, "review count"),
    workflowCount: asNonNegativeCount(row.workflow_count, "workflow count"),
  };
}

function mapFolder(row: Row): ProjectFolder {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    parentFolderId:
      row.parent_folder_id == null ? null : String(row.parent_folder_id),
    name: String(row.name),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapBlob(row: Row): AuthoritativeProjectBlob {
  const kind = String(row.kind);
  const documentId = row.document_id == null ? null : String(row.document_id);
  const versionId = row.version_id == null ? null : String(row.version_id);
  if (!documentId || !versionId) {
    throw new WorkspaceApiError(
      500,
      "INTERNAL_ERROR",
      "Invalid authoritative project blob record.",
    );
  }
  if (row.state !== "stored" || row.quarantine_id != null) {
    throw new WorkspaceApiError(
      409,
      "CONFLICT",
      "Project blob cleanup is already pending.",
    );
  }
  let locator: AuthoritativeProjectBlob["locator"];
  if (kind === "original" || kind === "extracted_text") {
    locator = { kind, documentId, versionId };
  } else if (kind === "preview") {
    const previewId =
      row.preview_id == null ? undefined : String(row.preview_id);
    locator = {
      kind,
      documentId,
      versionId,
      ...(previewId ? { previewId } : {}),
    };
  } else {
    throw new WorkspaceApiError(
      500,
      "INTERNAL_ERROR",
      "Invalid authoritative project blob kind.",
    );
  }
  if (String(row.storage_key) !== workspaceBlobStorageKey(locator)) {
    throw new WorkspaceApiError(
      500,
      "INTERNAL_ERROR",
      "Invalid authoritative project blob storage key.",
    );
  }
  return { recordId: String(row.id), locator, state: "stored" };
}

function mapActiveJob(row: Row): ActiveProjectResourceJob {
  const status = String(row.status);
  if (status !== "queued" && status !== "running") {
    throw new WorkspaceApiError(
      500,
      "INTERNAL_ERROR",
      "Invalid active project resource job status.",
    );
  }
  return { id: String(row.id), status };
}

export class ProjectsRepository {
  constructor(readonly database: WorkspaceDatabaseAdapter) {}

  private safe<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      if (error instanceof WorkspaceApiError) throw error;
      throw new WorkspaceApiError(
        500,
        "INTERNAL_ERROR",
        "Project data operation failed.",
      );
    }
  }

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
        // Preserve the primary failure.
      }
      throw error;
    }
  }

  list(
    input: PageRequest & { status?: "active" | "archived" } = {},
  ): Page<ProjectSummary> {
    return this.safe(() => {
      const page = normalizePageRequest(input);
      const cursor = decodeCursor(page.cursor);
      const rows = this.database
        .prepare(
          `${PROJECT_WITH_COUNTS}
           WHERE p.status = ?
             ${cursor ? "AND (p.updated_at < ? OR (p.updated_at = ? AND p.id < ?))" : ""}
           ORDER BY p.updated_at DESC, p.id DESC
           LIMIT ?`,
        )
        .all(
          input.status ?? "active",
          ...(cursor ? [cursor.updatedAt, cursor.updatedAt, cursor.id] : []),
          page.limit + 1,
        );
      const items = rows.slice(0, page.limit).map(mapProjectSummary);
      const last = items.at(-1);
      return {
        items,
        nextCursor:
          rows.length > page.limit && last
            ? encodeCursor({ updatedAt: last.updatedAt, id: last.id })
            : null,
      };
    });
  }

  get(id: string): Project | null {
    return this.safe(() => {
      const row = this.database
        .prepare("SELECT * FROM projects WHERE id = ?")
        .get(id);
      return row ? mapProject(row) : null;
    });
  }

  require(id: string): Project {
    return this.safe(() => {
      const value = this.get(id);
      if (!value) {
        throw new WorkspaceApiError(404, "NOT_FOUND", "Project not found.");
      }
      return value;
    });
  }

  requireActive(id: string) {
    return this.safe(() => {
      const value = this.require(id);
      if (value.status !== "active") {
        throw new WorkspaceApiError(409, "CONFLICT", "Project is not active.");
      }
      return value;
    });
  }

  /**
   * Uses the complete Project job-ownership graph. It deliberately returns
   * only presence: Matter conversion must not expose, mutate, or cancel the
   * user's queued/running or still-executing inference work.
   *
   * `activeScopes` is a bounded snapshot frozen before each handler starts.
   * It closes the cancellation/owner-deletion window where durable rows have
   * become terminal or disappeared but a provider call has not unwound yet.
   */
  hasBlockingInferenceJobs(
    projectIdValue: string,
    activeScopeValues: readonly WorkspaceInferenceActivityScope[],
  ): boolean {
    return this.safe(() => {
      const projectId = WorkspaceIdSchema.parse(projectIdValue);
      let frozenScopeBlocks = false;
      for (const value of activeScopeValues) {
        const parsed = ProjectInferenceActivityScopeSchema.safeParse(value);
        if (!parsed.success || parsed.data.scope === "unresolved") {
          frozenScopeBlocks = true;
          continue;
        }
        if (
          parsed.data.scope === "project" &&
          parsed.data.projectId === projectId
        ) {
          frozenScopeBlocks = true;
        }
      }
      const row = this.database
        .prepare(
          `${PROJECT_JOB_SCOPE_CTE}
           SELECT 1 AS present
             FROM jobs j
            WHERE j.type IN ('assistant_generate', 'workflow_run', 'tabular_cell')
              AND j.status IN ('queued', 'running')
              AND (${PROJECT_JOB_SCOPE_PREDICATE})
            LIMIT 1`,
        )
        .get(projectId);
      return frozenScopeBlocks || row?.present === 1 || row?.present === 1n;
    });
  }

  assertPermanentDelete(id: string, confirmName: string) {
    return this.safe(() => {
      const value = this.require(id);
      if (value.name !== confirmName) {
        throw new WorkspaceApiError(
          412,
          "PRECONDITION_FAILED",
          "Project confirmation does not match.",
        );
      }
      return value;
    });
  }

  create(input: {
    id: string;
    name: string;
    description: string | null;
    cmNumber: string | null;
    practice: string | null;
    now: string;
  }): Project {
    return this.safe(() => {
      this.database
        .prepare(
          "INSERT INTO projects (id,name,description,cm_number,practice,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
        )
        .run(
          input.id,
          input.name,
          input.description,
          input.cmNumber,
          input.practice,
          input.now,
          input.now,
        );
      return this.require(input.id);
    });
  }

  update(
    id: string,
    input: {
      name?: string;
      description?: string | null;
      cmNumber?: string | null;
      practice?: string | null;
      status?: "active" | "archived";
      now: string;
    },
  ): Project {
    return this.safe(() => {
      const existing = this.require(id);
      const status = input.status ?? existing.status;
      this.database
        .prepare(
          "UPDATE projects SET name=?, description=?, cm_number=?, practice=?, status=?, archived_at=?, updated_at=? WHERE id=?",
        )
        .run(
          input.name ?? existing.name,
          input.description === undefined
            ? existing.description
            : input.description,
          input.cmNumber === undefined ? existing.cmNumber : input.cmNumber,
          input.practice === undefined ? existing.practice : input.practice,
          status,
          status === "archived" ? input.now : null,
          input.now,
          id,
        );
      return this.require(id);
    });
  }

  archive(id: string, now: string) {
    return this.update(id, { status: "archived", now });
  }

  unarchive(id: string, now: string) {
    return this.update(id, { status: "active", now });
  }

  listFolders(projectId: string): ProjectFolder[] {
    return this.safe(() => {
      this.require(projectId);
      return this.database
        .prepare(
          `SELECT * FROM project_subfolders
           WHERE project_id = ?
           ORDER BY coalesce(parent_folder_id, ''), name COLLATE NOCASE, id`,
        )
        .all(projectId)
        .map(mapFolder);
    });
  }

  getFolder(id: string): ProjectFolder | null {
    return this.safe(() => {
      const row = this.database
        .prepare("SELECT * FROM project_subfolders WHERE id = ?")
        .get(id);
      return row ? mapFolder(row) : null;
    });
  }

  requireFolder(id: string): ProjectFolder {
    return this.safe(() => {
      const value = this.getFolder(id);
      if (!value) {
        throw new WorkspaceApiError(404, "NOT_FOUND", "Folder not found.");
      }
      return value;
    });
  }

  listFolderSubtree(id: string): ProjectFolder[] {
    return this.safe(() => {
      this.requireFolder(id);
      return this.database
        .prepare(
          `WITH RECURSIVE subtree(id, depth) AS (
             SELECT id, 0 FROM project_subfolders WHERE id = ?
             UNION ALL
             SELECT child.id, parent.depth + 1
               FROM project_subfolders child
               JOIN subtree parent ON child.parent_folder_id = parent.id
           )
           SELECT folder.* FROM project_subfolders folder
           JOIN subtree ON subtree.id = folder.id
           ORDER BY subtree.depth, folder.name COLLATE NOCASE, folder.id`,
        )
        .all(id)
        .map(mapFolder);
    });
  }

  createFolder(input: {
    id: string;
    projectId: string;
    parentFolderId: string | null;
    name: string;
    now: string;
  }): ProjectFolder {
    return this.safe(() => {
      this.requireActive(input.projectId);
      this.assertFolderParent(input.projectId, input.parentFolderId);
      this.database
        .prepare(
          "INSERT INTO project_subfolders (id,project_id,parent_folder_id,name,created_at,updated_at) VALUES (?,?,?,?,?,?)",
        )
        .run(
          input.id,
          input.projectId,
          input.parentFolderId,
          input.name,
          input.now,
          input.now,
        );
      return this.requireFolder(input.id);
    });
  }

  updateFolder(
    id: string,
    input: { name?: string; parentFolderId?: string | null; now: string },
  ): ProjectFolder {
    return this.safe(() => {
      const existing = this.requireFolder(id);
      const parent =
        input.parentFolderId === undefined
          ? existing.parentFolderId
          : input.parentFolderId;
      if (parent === id) {
        throw new WorkspaceApiError(
          409,
          "CONFLICT",
          "A folder cannot be its own parent.",
        );
      }
      this.assertFolderParent(existing.projectId, parent, id);
      this.database
        .prepare(
          "UPDATE project_subfolders SET name=?, parent_folder_id=?, updated_at=? WHERE id=?",
        )
        .run(input.name ?? existing.name, parent, input.now, id);
      return this.requireFolder(id);
    });
  }

  /** Unsafe FK SET NULL semantics are deliberately disabled. */
  deleteFolder(_id: string): never {
    throw new WorkspaceApiError(
      412,
      "PRECONDITION_FAILED",
      "Folder deletion requires the lifecycle cascade service.",
    );
  }

  overview(id: string): ProjectOverview {
    return this.safe(() => {
      const row = this.database
        .prepare(`${PROJECT_WITH_COUNTS} WHERE p.id = ?`)
        .get(id);
      if (!row) {
        throw new WorkspaceApiError(404, "NOT_FOUND", "Project not found.");
      }
      return { ...mapProjectSummary(row), folders: this.listFolders(id) };
    });
  }

  projectDeletionPlan(projectId: string): ProjectDeletionPlan {
    return this.safe(() => {
      this.require(projectId);
      this.assertLiveVersionAuthority("project", projectId);
      return {
        blobs: this.listProjectBlobs(projectId),
        activeJobs: this.listProjectActiveJobs(projectId),
      };
    });
  }

  folderDeletionPlan(folderId: string): FolderDeletionPlan {
    return this.safe(() => {
      const target = this.requireFolder(folderId);
      assertNoDurableDocumentHistory(this.database, {
        kind: "folder",
        folderId,
      });
      assertNoActiveProjectWorkflowForFolder(this.database, folderId);
      this.assertLiveVersionAuthority("folder", folderId);
      const folders = this.listFolderSubtree(folderId);
      const documentIds = this.database
        .prepare(
          `${FOLDER_SCOPE_CTE}
           SELECT id FROM folder_documents ORDER BY id`,
        )
        .all(folderId)
        .map((row) => String(row.id));
      return {
        folder: target,
        folders,
        documentIds,
        blobs: this.listFolderBlobs(folderId),
        activeJobs: this.listFolderActiveJobs(folderId),
      };
    });
  }

  deleteProjectCascade(
    projectId: string,
    confirmName: string,
    staged: readonly StagedProjectBlob[],
    now: string,
  ) {
    return this.safe(() =>
      this.transaction(() => {
        this.assertPermanentDelete(projectId, confirmName);
        this.assertLiveVersionAuthority("project", projectId);
        const current = this.listProjectBlobs(projectId);
        this.assertStagedAuthority(current, staged);
        this.assertNoActiveProjectJobs(projectId);
        this.quarantineAuthority(staged, now);
        // Jobs must be removed while the complete project-owned run set is
        // still queryable. Runs include both directly project-scoped rows and
        // anomalous/null-project rows that reference a project-bound workflow.
        this.deleteProjectResourceJobs(projectId);
        this.purgeProjectWorkflowResources(projectId);
        this.database
          .prepare("DELETE FROM projects WHERE id = ?")
          .run(projectId);
        if (this.get(projectId)) {
          throw new WorkspaceApiError(
            500,
            "INTERNAL_ERROR",
            "Project deletion did not complete.",
          );
        }
        return { projectId, stagedCount: staged.length };
      }),
    );
  }

  deleteFolderSubtreeCascade(
    folderId: string,
    staged: readonly StagedProjectBlob[],
    now: string,
  ) {
    return this.safe(() =>
      this.transaction(() => {
        const folder = this.requireFolder(folderId);
        assertNoDurableDocumentHistory(this.database, {
          kind: "folder",
          folderId,
        });
        assertNoActiveProjectWorkflowForFolder(this.database, folderId);
        this.assertLiveVersionAuthority("folder", folderId);
        const current = this.listFolderBlobs(folderId);
        this.assertStagedAuthority(current, staged);
        this.assertNoActiveFolderJobs(folderId);
        this.quarantineAuthority(staged, now);
        this.deleteFolderResourceJobs(folderId);
        this.database
          .prepare(
            `${FOLDER_SCOPE_CTE}
             DELETE FROM documents WHERE id IN (SELECT id FROM folder_documents)`,
          )
          .run(folderId);
        this.database
          .prepare("DELETE FROM project_subfolders WHERE id = ?")
          .run(folderId);
        if (this.getFolder(folderId)) {
          throw new WorkspaceApiError(
            500,
            "INTERNAL_ERROR",
            "Folder deletion did not complete.",
          );
        }
        return {
          folderId,
          projectId: folder.projectId,
          stagedCount: staged.length,
        };
      }),
    );
  }

  private assertLiveVersionAuthority(scope: "project" | "folder", id: string) {
    const row =
      scope === "project"
        ? this.database
            .prepare(
              `SELECT count(*) AS count
                 FROM document_versions version
                 JOIN documents document ON document.id = version.document_id
                 LEFT JOIN workspace_blob_records blob
                   ON blob.document_id = version.document_id
                  AND blob.version_id = version.id
                  AND blob.kind = 'original'
                WHERE document.project_id = ?
                  AND document.deleted_at IS NULL
                  AND version.deleted_at IS NULL
                  AND blob.id IS NULL`,
            )
            .get(id)
        : this.database
            .prepare(
              `${FOLDER_SCOPE_CTE}
               SELECT count(*) AS count
                 FROM document_versions version
                 JOIN documents document ON document.id = version.document_id
                 LEFT JOIN workspace_blob_records blob
                   ON blob.document_id = version.document_id
                  AND blob.version_id = version.id
                  AND blob.kind = 'original'
                WHERE document.id IN (SELECT id FROM folder_documents)
                  AND document.deleted_at IS NULL
                  AND version.deleted_at IS NULL
                  AND blob.id IS NULL`,
            )
            .get(id);
    if (
      asNonNegativeCount(row?.count ?? 0, "missing blob authority count") > 0
    ) {
      throw new WorkspaceApiError(
        412,
        "PRECONDITION_FAILED",
        "Deletion requires authoritative blob records for every live document version.",
      );
    }
  }

  private listProjectBlobs(projectId: string) {
    return this.database
      .prepare(
        `SELECT blob.*
           FROM workspace_blob_records blob
           JOIN documents document ON document.id = blob.document_id
          WHERE document.project_id = ?
          ORDER BY blob.document_id, blob.version_id, blob.kind, blob.preview_id, blob.id`,
      )
      .all(projectId)
      .map(mapBlob);
  }

  private listFolderBlobs(folderId: string) {
    return this.database
      .prepare(
        `${FOLDER_SCOPE_CTE}
         SELECT blob.*
           FROM workspace_blob_records blob
           JOIN documents document ON document.id = blob.document_id
          WHERE document.id IN (SELECT id FROM folder_documents)
          ORDER BY blob.document_id, blob.version_id, blob.kind, blob.preview_id, blob.id`,
      )
      .all(folderId)
      .map(mapBlob);
  }

  private listProjectActiveJobs(projectId: string) {
    return this.database
      .prepare(
        `${PROJECT_JOB_SCOPE_CTE}
         SELECT DISTINCT j.id, j.status FROM jobs j
          WHERE j.status IN ('queued', 'running')
            AND (${PROJECT_JOB_SCOPE_PREDICATE})
          ORDER BY j.status, j.id`,
      )
      .all(projectId)
      .map(mapActiveJob);
  }

  private listFolderActiveJobs(folderId: string) {
    const directJobs = this.database
      .prepare(
        `${FOLDER_SCOPE_CTE}
         SELECT DISTINCT j.id, j.status FROM jobs j
          WHERE j.status IN ('queued', 'running')
            AND (${FOLDER_JOB_SCOPE_PREDICATE})
          ORDER BY j.status, j.id`,
      )
      .all(folderId)
      .map(mapActiveJob);
    const assistantJobs = listActiveFolderAssistantJobs(
      this.database,
      folderId,
    ).map((job) => mapActiveJob(job));
    return [
      ...new Map(
        [...directJobs, ...assistantJobs].map((job) => [job.id, job]),
      ).values(),
    ].sort(
      (left, right) =>
        left.status.localeCompare(right.status) ||
        left.id.localeCompare(right.id),
    );
  }

  private assertNoActiveProjectJobs(projectId: string) {
    if (this.listProjectActiveJobs(projectId).length > 0) {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Project resources still have active jobs.",
      );
    }
  }

  private assertNoActiveFolderJobs(folderId: string) {
    if (this.listFolderActiveJobs(folderId).length > 0) {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Folder resources still have active jobs.",
      );
    }
  }

  private assertStagedAuthority(
    current: readonly AuthoritativeProjectBlob[],
    staged: readonly StagedProjectBlob[],
  ) {
    const currentIds = [...current.map((item) => item.recordId)].sort();
    const stagedIds = [...staged.map((item) => item.recordId)].sort();
    if (
      new Set(stagedIds).size !== stagedIds.length ||
      currentIds.length !== stagedIds.length ||
      currentIds.some((id, index) => id !== stagedIds[index])
    ) {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Authoritative blob records changed during deletion.",
      );
    }
    if (staged.some((item) => !item.quarantineId.trim())) {
      throw new WorkspaceApiError(
        500,
        "INTERNAL_ERROR",
        "Invalid staged blob receipt.",
      );
    }
  }

  private quarantineAuthority(
    staged: readonly StagedProjectBlob[],
    now: string,
  ) {
    for (const item of staged) {
      this.database
        .prepare(
          `UPDATE workspace_blob_records
              SET state = 'quarantined', quarantine_id = ?, updated_at = ?
            WHERE id = ? AND state = 'stored' AND quarantine_id IS NULL`,
        )
        .run(item.quarantineId, now, item.recordId);
      const row = this.database
        .prepare(
          "SELECT state, quarantine_id FROM workspace_blob_records WHERE id = ?",
        )
        .get(item.recordId);
      if (
        row?.state !== "quarantined" ||
        row.quarantine_id !== item.quarantineId
      ) {
        throw new WorkspaceApiError(
          409,
          "CONFLICT",
          "Authoritative blob record could not be quarantined.",
        );
      }
    }
  }

  private purgeProjectWorkflowResources(projectId: string) {
    // Project is the ownership boundary. Purge runs first so step runs cascade
    // and the workflow_runs.workflow_id RESTRICT constraint is respected; only
    // then remove project-bound workflow definitions. Global workflows remain
    // global even when a project-scoped run happened to reference one.
    this.database
      .prepare(
        `DELETE FROM workflow_runs
          WHERE project_id = ?
             OR workflow_id IN (
               SELECT id FROM workflows WHERE project_id = ?
             )`,
      )
      .run(projectId, projectId);
    this.database
      .prepare(`DELETE FROM workflows WHERE project_id = ?`)
      .run(projectId);
  }

  private deleteProjectResourceJobs(projectId: string) {
    this.database
      .prepare(
        `${PROJECT_JOB_SCOPE_CTE}
         DELETE FROM jobs AS j WHERE ${PROJECT_JOB_SCOPE_PREDICATE}`,
      )
      .run(projectId);
  }

  private deleteFolderResourceJobs(folderId: string) {
    this.database
      .prepare(
        `${FOLDER_SCOPE_CTE}
         DELETE FROM jobs AS j WHERE ${FOLDER_JOB_SCOPE_PREDICATE}`,
      )
      .run(folderId);
  }

  private assertFolderParent(
    projectId: string,
    parent: string | null,
    movingId?: string,
  ) {
    let current = parent;
    const visited = new Set<string>();
    while (current) {
      if (current === movingId || visited.has(current)) {
        throw new WorkspaceApiError(
          409,
          "CONFLICT",
          "Folder move would create a cycle.",
        );
      }
      visited.add(current);
      const row = this.database
        .prepare(
          "SELECT project_id,parent_folder_id FROM project_subfolders WHERE id=?",
        )
        .get(current);
      if (!row) {
        throw new WorkspaceApiError(
          404,
          "NOT_FOUND",
          "Parent folder not found.",
        );
      }
      if (String(row.project_id) !== projectId) {
        throw new WorkspaceApiError(
          409,
          "CONFLICT",
          "Folder parent must be in the same project.",
        );
      }
      current =
        row.parent_folder_id == null ? null : String(row.parent_folder_id);
    }
  }
}
