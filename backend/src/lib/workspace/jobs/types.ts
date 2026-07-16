export {
  WORKSPACE_JOB_STATUSES,
  WORKSPACE_JOB_TYPES,
  type CreateWorkspaceJobInput,
  type WorkspaceJobCancellation,
  type WorkspaceJobError,
  type WorkspaceJobErrorInput,
  type WorkspaceJobEvent,
  type WorkspaceJobLogProjection,
  type WorkspaceJobRecord,
  type WorkspaceJobStatus,
  type WorkspaceJobType,
  type WorkspaceJobValueProjection,
} from "../jobContractV7";

import type { WorkspaceJobStoredRecord } from "../jobPersistenceV7";

export const PROJECT_INFERENCE_JOB_TYPES = [
  "assistant_generate",
  "workflow_run",
  "tabular_cell",
] as const;

export type ProjectInferenceJobType =
  (typeof PROJECT_INFERENCE_JOB_TYPES)[number];

/** Immutable scope captured before an inference handler can lose its owner. */
export type WorkspaceInferenceActivityScope = Readonly<
  | {
      jobId: string;
      type: ProjectInferenceJobType;
      scope: "project";
      projectId: string;
    }
  | {
      jobId: string;
      type: ProjectInferenceJobType;
      scope: "global" | "unresolved";
      projectId: null;
    }
>;

export type ProjectInferenceScopeResolver = (
  job: WorkspaceJobStoredRecord,
) => WorkspaceInferenceActivityScope | null;
