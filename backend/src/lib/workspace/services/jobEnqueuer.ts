import type { WorkspaceDatabaseAdapter } from "../migrations";
import type { WorkspaceJobStatus } from "../jobs/types";
import { WorkspaceJobsRepository } from "../repositories/jobs";
import {
  WorkspaceJobsService,
  type TransactionlessWorkspaceJobEnqueueInput,
  type WorkspaceJobsServiceOptions,
} from "./jobs";

export type JobEnqueuerResourceType =
  | "document"
  | "chat"
  | "workflow_run"
  | "tabular_cell"
  | "tabular_review"
  | "project";

export type EnqueueWorkspaceJobInput = {
  id: string;
  type: "workflow_run" | "tabular_cell";
  resourceType: JobEnqueuerResourceType;
  resourceId: string;
  idempotencyKey: string;
  payload: unknown;
  maxAttempts: number;
  now: string;
};

export type WorkspaceJobSnapshot = {
  id: string;
  status: WorkspaceJobStatus;
  attempt: number;
  maxAttempts: number;
};

export type WorkspaceJobPortEvent =
  | { type: "start"; at: string }
  | { type: "complete"; at: string; result: unknown }
  | {
      type: "fail";
      at: string;
      error: {
        code: string;
        message: string;
        retryable: boolean;
        details: unknown;
      };
    }
  | { type: "cancel"; at: string; reason: string };

export interface JobEnqueuer {
  enqueueInCurrentTransaction(
    input: EnqueueWorkspaceJobInput,
  ): WorkspaceJobSnapshot;
  get(id: string): WorkspaceJobSnapshot | null;
  transitionInCurrentTransaction(
    id: string,
    event: WorkspaceJobPortEvent,
  ): WorkspaceJobSnapshot;
  /** Abort a currently executing handler after its durable state transition commits. */
  abortActive?(id: string): boolean;
}

function toSnapshot(job: {
  id: string;
  status: WorkspaceJobSnapshot["status"];
  attempt: number;
  maxAttempts: number;
}): WorkspaceJobSnapshot {
  return {
    id: job.id,
    status: job.status,
    attempt: job.attempt,
    maxAttempts: job.maxAttempts,
  };
}

function toTransactionlessInput(
  input: EnqueueWorkspaceJobInput,
): TransactionlessWorkspaceJobEnqueueInput {
  return {
    ...input,
    queuedAt: input.now,
  };
}

export class WorkspaceJobEnqueuerAdapter implements JobEnqueuer {
  constructor(private readonly jobs: WorkspaceJobsService) {}

  enqueueInCurrentTransaction(
    input: EnqueueWorkspaceJobInput,
  ): WorkspaceJobSnapshot {
    const job = this.jobs.enqueueJobInCurrentTransaction(
      toTransactionlessInput(input),
    );
    return toSnapshot(job);
  }

  get(id: string): WorkspaceJobSnapshot | null {
    const job = this.jobs.getJob(id);
    return job ? toSnapshot(job) : null;
  }

  transitionInCurrentTransaction(
    id: string,
    event: WorkspaceJobPortEvent,
  ): WorkspaceJobSnapshot {
    const job = this.jobs.transitionJobInCurrentTransaction(id, event);
    return toSnapshot(job);
  }

  abortActive(id: string): boolean {
    return this.jobs.abortActiveJob(id);
  }
}

export function createWorkspaceJobEnqueuer(
  database: WorkspaceDatabaseAdapter,
  options: WorkspaceJobsServiceOptions = {},
): JobEnqueuer {
  const repository = new WorkspaceJobsRepository(database);
  const jobs = new WorkspaceJobsService(repository, options);
  return new WorkspaceJobEnqueuerAdapter(jobs);
}
