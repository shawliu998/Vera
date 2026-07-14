export const WORKSPACE_JOB_TYPES = [
  "document_parse",
  "assistant_generate",
  "workflow_run",
  "tabular_cell",
] as const;

export type WorkspaceJobType = (typeof WORKSPACE_JOB_TYPES)[number];

export const WORKSPACE_JOB_STATUSES = [
  "queued",
  "running",
  "complete",
  "failed",
  "cancelled",
  "interrupted",
] as const;

export type WorkspaceJobStatus = (typeof WORKSPACE_JOB_STATUSES)[number];

export interface WorkspaceJobErrorInput {
  code: string;
  message: string;
  retryable: boolean;
  details?: unknown;
}

export interface WorkspaceJobError {
  code: string;
  message: string;
  retryable: boolean;
  details: WorkspaceJobValueProjection | null;
}

export interface WorkspaceJobCancellation {
  requestedAt: string;
  reason: string | null;
}

export type WorkspaceJobValueProjection =
  | { kind: "null" }
  | { kind: "string"; length: number; redacted: true }
  | { kind: "number" }
  | { kind: "boolean" }
  | { kind: "array"; length: number; itemKinds: string[] }
  | {
      kind: "object";
      totalKeys: number;
      keys: string[];
      sensitiveKeyCount: number;
    };

export interface WorkspaceJobRecord {
  id: string;
  type: WorkspaceJobType;
  status: WorkspaceJobStatus;
  payload: unknown;
  result: unknown | null;
  error: WorkspaceJobError | null;
  attempt: number;
  maxAttempts: number;
  idempotencyKey: string | null;
  createdAt: string;
  queuedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  cancellation: WorkspaceJobCancellation | null;
  updatedAt: string;
}

export interface CreateWorkspaceJobInput {
  id: string;
  type: WorkspaceJobType;
  payload: unknown;
  maxAttempts: number;
  createdAt: string;
  idempotencyKey?: string | null;
}

export type WorkspaceJobEvent =
  | { type: "start"; at: string }
  | { type: "complete"; at: string; result: unknown }
  | { type: "fail"; at: string; error: WorkspaceJobErrorInput }
  | { type: "cancel"; at: string; reason?: string | null }
  | { type: "interrupt"; at: string; error?: Partial<WorkspaceJobErrorInput> }
  | { type: "retry"; at: string };

export interface WorkspaceJobLogProjection {
  id: string;
  type: WorkspaceJobType;
  status: WorkspaceJobStatus;
  attempt: number;
  maxAttempts: number;
  idempotencyKey: string | null;
  createdAt: string;
  queuedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  cancellation: WorkspaceJobCancellation | null;
  error: WorkspaceJobError | null;
  payload: WorkspaceJobValueProjection;
  result: WorkspaceJobValueProjection | null;
}
