import { isDeepStrictEqual } from "node:util";

import type { ChatsRepository } from "../repositories/chats";
import type { WorkspaceJobStoredRecord } from "../repositories/jobs";
import type { TabularRepository } from "../repositories/tabular";
import type { WorkflowsService } from "./workflows";
import {
  PROJECT_INFERENCE_JOB_TYPES,
  type ProjectInferenceJobType,
  type ProjectInferenceScopeResolver,
  type WorkspaceInferenceActivityScope,
} from "../jobs/types";
import { TabularCellJobPayloadSchema } from "../tabularGenerationContract";
import { WorkspaceIdSchema } from "../workspacePersistencePrimitivesV1";
import { workflowPayloadFromJob } from "./workflowRuntime";

function inferenceType(
  value: WorkspaceJobStoredRecord["type"],
): ProjectInferenceJobType | null {
  return PROJECT_INFERENCE_JOB_TYPES.find((type) => type === value) ?? null;
}

function unresolved(
  job: WorkspaceJobStoredRecord,
  type: ProjectInferenceJobType,
): WorkspaceInferenceActivityScope {
  return Object.freeze({
    jobId: job.id,
    type,
    scope: "unresolved" as const,
    projectId: null,
  });
}

function verifiedScope(
  job: WorkspaceJobStoredRecord,
  type: ProjectInferenceJobType,
  projectId: string | null,
): WorkspaceInferenceActivityScope | null {
  if (!WorkspaceIdSchema.safeParse(job.id).success) return null;
  if (projectId === null) {
    return Object.freeze({
      jobId: job.id,
      type,
      scope: "global" as const,
      projectId: null,
    });
  }
  const parsedProjectId = WorkspaceIdSchema.safeParse(projectId);
  if (!parsedProjectId.success) return null;
  return Object.freeze({
    jobId: job.id,
    type,
    scope: "project" as const,
    projectId: parsedProjectId.data,
  });
}

/**
 * Resolves and freezes Project ownership synchronously after a durable claim
 * and before handler registration. Every source is an existing immutable or
 * strictly validated execution contract; arbitrary payload JSON is never an
 * authorization source.
 */
export class CanonicalProjectInferenceScopeResolver {
  readonly resolve: ProjectInferenceScopeResolver;

  constructor(
    private readonly assistant: Pick<ChatsRepository, "generationSnapshot">,
    private readonly workflows: Pick<
      WorkflowsService,
      "getExecutionSnapshot" | "getRun"
    >,
    private readonly tabular: Pick<TabularRepository, "database">,
  ) {
    this.resolve = this.resolveClaim.bind(this);
  }

  private resolveClaim(
    job: WorkspaceJobStoredRecord,
  ): WorkspaceInferenceActivityScope | null {
    const type = inferenceType(job.type);
    if (type === null) return null;
    const fallback = () => unresolved(job, type);
    if (job.status !== "running") return fallback();
    try {
      if (type === "assistant_generate") {
        if (job.resourceType !== "chat") return fallback();
        const snapshot = this.assistant.generationSnapshot(job.id);
        if (
          snapshot.jobId !== job.id ||
          snapshot.chatId !== job.resourceId ||
          snapshot.payload.chatId !== job.resourceId ||
          !isDeepStrictEqual(snapshot.payload, job.payload)
        ) {
          return fallback();
        }
        return (
          verifiedScope(job, type, snapshot.payload.projectId) ?? fallback()
        );
      }

      if (type === "workflow_run") {
        if (job.resourceType !== "workflow_run") return fallback();
        const payload = workflowPayloadFromJob(job.payload);
        if (!payload || payload.runId !== job.resourceId) return fallback();
        const snapshot = this.workflows.getExecutionSnapshot(payload.runId);
        const detail = this.workflows.getRun(payload.runId);
        if (
          snapshot.workflowRunId !== payload.runId ||
          snapshot.id !== payload.snapshotId ||
          snapshot.snapshotSha256 !== payload.snapshotSha256 ||
          snapshot.workflowId !== payload.workflowId ||
          snapshot.workflowId !== detail.run.workflowId ||
          snapshot.projectId !== detail.run.projectId ||
          detail.run.jobId !== job.id ||
          detail.run.retryOfRunId !== payload.retryOfRunId
        ) {
          return fallback();
        }
        return verifiedScope(job, type, snapshot.projectId) ?? fallback();
      }

      if (job.resourceType !== "tabular_cell") return fallback();
      const payload = TabularCellJobPayloadSchema.safeParse(job.payload);
      if (
        !payload.success ||
        payload.data.cellId !== job.resourceId ||
        payload.data.generationId !== job.id
      ) {
        return fallback();
      }
      const fixed = payload.data;
      const owner = this.tabular.database
        .prepare(
          `SELECT 1 AS present
             FROM jobs persisted_job
             JOIN tabular_cells cell
               ON cell.id = persisted_job.resource_id
              AND cell.job_id = persisted_job.id
             JOIN tabular_reviews review ON review.id = cell.review_id
             JOIN tabular_review_columns review_column
               ON review_column.id = cell.column_id
              AND review_column.review_id = review.id
             JOIN tabular_review_documents review_document
               ON review_document.review_id = review.id
              AND review_document.document_id = cell.document_id
             JOIN documents document
               ON document.id = cell.document_id
              AND document.deleted_at IS NULL
            WHERE persisted_job.id = ?
              AND persisted_job.type = 'tabular_cell'
              AND persisted_job.status = 'running'
              AND persisted_job.resource_type = 'tabular_cell'
              AND persisted_job.resource_id = ?
              AND cell.id = ?
              AND cell.review_id = ?
              AND cell.document_id = ?
              AND cell.column_id = ?
              AND review.project_id = ?
              AND document.project_id = ?
            LIMIT 1`,
        )
        .get(
          job.id,
          job.resourceId,
          fixed.cellId,
          fixed.reviewId,
          fixed.document.documentId,
          fixed.column.columnId,
          fixed.projectId,
          fixed.projectId,
        );
      if (owner?.present !== 1 && owner?.present !== 1n) return fallback();
      return verifiedScope(job, type, fixed.projectId) ?? fallback();
    } catch {
      return fallback();
    }
  }
}
