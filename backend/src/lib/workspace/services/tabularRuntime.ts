import {
  WorkspaceJobLeaseLostError,
  type WorkspaceJobsRepository,
} from "../repositories/jobs";
import type {
  TabularCellRecord,
  TabularColumnRecord,
  TabularRepository,
  TabularSourceRef,
} from "../repositories/tabular";
import type { WorkspaceDatabaseAdapter } from "../database";
import { WorkspaceApiError } from "../errors";
import {
  TabularCellJobPayloadSchema,
  tabularColumnRevisionSha256,
  tabularGenerationSha256,
  tabularReviewRevisionSha256,
} from "../tabularGenerationContract";
import type { WorkspaceJobHandler } from "./jobs";
import {
  MAX_TABULAR_DOCUMENT_TEXT_BYTES,
  TABULAR_GENERATION_DISABLED_MESSAGE,
} from "./tabular";
import type { TabularCellContent } from "./tabularCompatibility";
import type { AuthoritativeExtractedTextReader } from "./authoritativeExtractedText";
import type {
  TabularCellModelPort,
  TabularModelError,
} from "./tabularModelAdapter";

/** Legacy fail-closed surface retained only for pre-runtime compatibility audits. */
export type TabularDocumentModelInput = {
  reviewId: string;
  document: {
    id: string;
    title: string;
    filename: string;
    versionId: string | null;
    contentSha256: string;
    textSha256: string;
    text: string;
  };
  columns: TabularColumnRecord[];
  cells: TabularCellRecord[];
  modelProfileId: string;
  signal: AbortSignal;
};

export type TabularDocumentModelOutput = {
  cells: Array<{
    columnId: string;
    content: TabularCellContent;
    sources?: TabularSourceRef[];
  }>;
};

export interface TabularDocumentModelPort {
  generateDocument(
    input: TabularDocumentModelInput,
  ): Promise<TabularDocumentModelOutput>;
}

export type TabularCellRuntimeOptions = {
  now?: () => Date;
  maxTextBytes?: number;
};

function disabledGenerationError() {
  return {
    code: "tabular_document_generation_unavailable",
    message: TABULAR_GENERATION_DISABLED_MESSAGE,
    retryable: false,
    details: null,
  };
}

function safeRuntimeError(error: unknown, interrupted: boolean) {
  if (interrupted) {
    return {
      code: "tabular_generation_interrupted",
      message: "Tabular generation was interrupted and can be retried.",
      retryable: true,
      details: null,
    };
  }
  if (
    error &&
    typeof error === "object" &&
    (error as { name?: unknown }).name === "TabularModelError"
  ) {
    const model = error as TabularModelError;
    return {
      code: model.code,
      message: "Tabular model generation failed.",
      retryable: model.retryable,
      details: null,
    };
  }
  if (error instanceof WorkspaceApiError) {
    return {
      code:
        error.status >= 500
          ? "tabular_runtime_unavailable"
          : "tabular_generation_precondition_changed",
      message:
        error.status >= 500
          ? "Tabular generation runtime is unavailable."
          : "Tabular generation inputs changed before completion.",
      retryable: error.status >= 500,
      details: null,
    };
  }
  if (error && typeof error === "object") {
    const structured = error as {
      code?: unknown;
      retryable?: unknown;
    };
    if (
      typeof structured.code === "string" &&
      /^tabular_[a-z0-9_]{1,111}$/.test(structured.code)
    ) {
      return {
        code: structured.code,
        message: "Tabular generation inputs are invalid or unavailable.",
        retryable: structured.retryable === true,
        details: null,
      };
    }
  }
  return {
    code: "tabular_generation_failed",
    message: "Tabular generation failed.",
    retryable: false,
    details: null,
  };
}

function abortLike(error: unknown, signal: AbortSignal) {
  return (
    signal.aborted ||
    (error instanceof Error &&
      (error.name === "AbortError" || /aborted|abort/i.test(error.message)))
  );
}

function sameDocumentPayload(
  current: ReturnType<AuthoritativeExtractedTextReader["currentSnapshot"]>,
  payload: ReturnType<typeof TabularCellJobPayloadSchema.parse>["document"],
) {
  return (
    current.documentId === payload.documentId &&
    current.versionId === payload.versionId &&
    current.blobRecordId === payload.blobRecordId &&
    current.sourceContentSha256 === payload.sourceContentSha256 &&
    current.textSha256 === payload.textSha256 &&
    current.textBytes === payload.textBytes
  );
}

export function createTabularCellJobHandler(input: {
  database: WorkspaceDatabaseAdapter;
  tabular: TabularRepository;
  jobs: WorkspaceJobsRepository;
  model: TabularCellModelPort | TabularDocumentModelPort;
  snapshots?: AuthoritativeExtractedTextReader;
  options?: TabularCellRuntimeOptions;
}): WorkspaceJobHandler {
  void input.database;
  if (
    !input.snapshots ||
    !("generateCell" in input.model) ||
    typeof input.model.generateCell !== "function"
  ) {
    return ({ job, claim }) => {
      if (!claim) {
        throw {
          code: "tabular_cell_claim_required",
          message: "Tabular jobs require a fenced claim.",
          retryable: true,
          details: null,
        };
      }
      if (job.type !== "tabular_cell" || job.resourceType !== "tabular_cell") {
        throw new WorkspaceJobLeaseLostError();
      }
      throw disabledGenerationError();
    };
  }

  const snapshots = input.snapshots;
  const model = input.model;
  const now = () => (input.options?.now ?? (() => new Date()))().toISOString();
  const maxTextBytes =
    input.options?.maxTextBytes ?? MAX_TABULAR_DOCUMENT_TEXT_BYTES;

  return async ({ job, claim, signal }) => {
    if (!claim) {
      throw {
        code: "tabular_cell_claim_required",
        message: "Tabular jobs require a fenced claim.",
        retryable: true,
        details: null,
      };
    }
    if (job.type !== "tabular_cell" || job.resourceType !== "tabular_cell") {
      throw new WorkspaceJobLeaseLostError();
    }
    const payload = TabularCellJobPayloadSchema.safeParse(job.payload);
    if (
      !payload.success ||
      payload.data.cellId !== job.resourceId ||
      payload.data.generationId !== job.id
    ) {
      throw {
        code: "tabular_job_payload_invalid",
        message: "Tabular job payload is invalid.",
        retryable: false,
        details: null,
      };
    }
    const fixed = payload.data;
    const claimInput = (at: string) => ({
      id: job.id,
      type: "tabular_cell" as const,
      resourceType: "tabular_cell" as const,
      resourceId: fixed.cellId,
      leaseOwner: claim.leaseOwner,
      attempt: claim.attempt,
      at,
      payload: fixed,
    });
    const startedAt = now();
    input.tabular.startClaimedCell(fixed.cellId, startedAt, () =>
      input.jobs.assertClaimInCurrentTransaction(claimInput(startedAt)),
    );

    try {
      const detail = input.tabular.requireDetail(fixed.reviewId);
      const cell = input.tabular.requireCell(fixed.cellId);
      const column = detail.columns.find(
        (candidate) => candidate.id === fixed.column.columnId,
      );
      if (
        detail.review.projectId !== fixed.projectId ||
        cell.reviewId !== fixed.reviewId ||
        cell.documentId !== fixed.document.documentId ||
        cell.columnId !== fixed.column.columnId ||
        cell.jobId !== job.id ||
        cell.attempt !== fixed.generation ||
        !column ||
        tabularColumnRevisionSha256(column) !== fixed.column.revisionSha256 ||
        tabularReviewRevisionSha256({
          reviewId: detail.review.id,
          projectId: fixed.projectId,
          workflowId: detail.review.workflowId,
          documentIds: detail.review.documentIds,
          columns: detail.columns,
        }) !== fixed.reviewRevisionSha256
      ) {
        throw {
          code: "tabular_generation_revision_changed",
          message: "Tabular generation inputs changed before execution.",
          retryable: false,
          details: null,
        };
      }
      const currentSnapshot = snapshots.currentSnapshot({
        projectId: fixed.projectId,
        documentId: fixed.document.documentId,
        maxTextBytes,
      });
      if (!sameDocumentPayload(currentSnapshot, fixed.document)) {
        throw {
          code: "tabular_document_snapshot_changed",
          message: "Tabular document snapshot changed before execution.",
          retryable: false,
          details: null,
        };
      }
      const document = snapshots.read(currentSnapshot, maxTextBytes);
      const generated = await model.generateCell({
        snapshot: document,
        column,
        modelProfileId: fixed.model.profileId,
        modelExecutionRevision: fixed.model.executionRevision,
        signal,
      });
      if (signal.aborted) {
        const error = new Error("Tabular generation aborted.");
        error.name = "AbortError";
        throw error;
      }
      const result = {
        schema: "vera-tabular-cell-result-v1",
        cellId: fixed.cellId,
        contentSha256: tabularGenerationSha256({
          content: generated.content,
          sources: generated.sources,
        }),
        sourceCount: generated.sources.length,
      };
      // Cell and Job are one durable generation lineage. Reuse the exact
      // timestamp in the same settlement transaction so the v23 handoff can
      // prove that neither side was completed independently.
      const completedAt = now();
      input.tabular.completeClaimedCell(
        fixed.cellId,
        generated.content,
        generated.sources,
        result,
        completedAt,
        () => input.jobs.assertClaimInCurrentTransaction(claimInput(completedAt)),
        () =>
          input.jobs.finishClaimInCurrentTransaction({
            ...claimInput(completedAt),
            event: { type: "complete", at: completedAt, result },
          }),
      );
      return result;
    } catch (error) {
      if (error instanceof WorkspaceJobLeaseLostError) throw error;
      const currentJob = input.jobs.getJob(job.id);
      if (currentJob?.status === "cancelled") {
        return {
          schema: "vera-tabular-cell-result-v1",
          cellId: fixed.cellId,
          cancelled: true,
        };
      }
      const interrupted = abortLike(error, signal);
      const safeError = safeRuntimeError(error, interrupted);
      try {
        const failedAt = now();
        input.tabular.failClaimedCell(
          fixed.cellId,
          safeError,
          failedAt,
          () => input.jobs.assertClaimInCurrentTransaction(claimInput(failedAt)),
          () =>
            input.jobs.finishClaimInCurrentTransaction({
              ...claimInput(failedAt),
              event: interrupted
                ? { type: "interrupt", at: failedAt, error: safeError }
                : { type: "fail", at: failedAt, error: safeError },
            }),
        );
      } catch (settlementError) {
        if (settlementError instanceof WorkspaceJobLeaseLostError) {
          throw settlementError;
        }
        throw settlementError;
      }
      return {
        schema: "vera-tabular-cell-result-v1",
        cellId: fixed.cellId,
        failed: true,
      };
    }
  };
}
