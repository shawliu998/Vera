import {
  WorkspaceJobLeaseLostError,
  type WorkspaceJobsRepository,
} from "../repositories/jobs";
import type {
  TabularCellRecord,
  TabularColumnRecord,
  TabularSourceRef,
} from "../repositories/tabular";
import type { WorkspaceDatabaseAdapter } from "../database";
import type { WorkspaceJobHandler } from "./jobs";
import { TABULAR_GENERATION_DISABLED_MESSAGE } from "./tabular";
import type { TabularCellContent } from "./tabularCompatibility";

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
};

function disabledGenerationError() {
  // Fail closed until Documents exposes an authoritative extracted-text snapshot
  // reader for document-level Mike generation; do not fall back to chunk joins.
  return {
    code: "tabular_document_generation_unavailable",
    message: TABULAR_GENERATION_DISABLED_MESSAGE,
    retryable: false,
    details: null,
  };
}

export function createTabularCellJobHandler(input: {
  database: WorkspaceDatabaseAdapter;
  tabular: unknown;
  jobs: WorkspaceJobsRepository;
  model: TabularDocumentModelPort;
  options?: TabularCellRuntimeOptions;
}): WorkspaceJobHandler {
  void input;
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
