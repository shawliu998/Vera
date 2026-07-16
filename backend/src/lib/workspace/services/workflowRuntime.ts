import type { HandlerSignalContext } from "./jobs";
import {
  WorkspaceJobLeaseLostError,
  type WorkspaceJobsRepository,
} from "../repositories/jobs";
import { WorkspaceApiError } from "../errors";
import type { StructuredError, WorkflowStep, WorkspaceJson } from "../types";
import type {
  WorkflowExecutionSnapshot,
  WorkflowRunStep,
} from "../repositories/workflows";
import { type WorkflowClaimCallbacks, WorkflowsService } from "./workflows";

export const WORKSPACE_WORKFLOW_EXECUTION_CAPABILITY = Object.freeze({
  enabled: true as const,
  assistantRuns: true as const,
  tabularRuns: false as const,
  requiresRuntimeComposition: true as const,
});

export function workflowExecutionUnsupportedError(): WorkspaceApiError {
  return new WorkspaceApiError(
    503,
    "PRECONDITION_FAILED",
    "Workflow execution is unavailable because its model runtime is not fully composed.",
    [{ path: "execution_enabled", message: "false" }],
  );
}

/**
 * The Jobs repository owns lease predicates and final state transitions.  This
 * port is the shared repository's public same-transaction claim API.  There
 * is deliberately no cancellation extension: Jobs control-plane/recovery owns
 * cancellation and ordinary fenced finish correctly rejects cancelled claims.
 */
export type FencedWorkflowJobsPort = Pick<
  WorkspaceJobsRepository,
  "assertClaimInCurrentTransaction" | "finishClaimInCurrentTransaction"
>;

export type WorkflowStepExecutionResult =
  | { status: "complete"; output: WorkspaceJson }
  | { status: "unsupported"; message: string };

export type WorkflowPreparedStepInput =
  | { status: "ready"; input: WorkspaceJson }
  | { status: "unsupported"; message: string };

export interface WorkflowStepExecutor {
  prepareStep?(input: {
    snapshot: WorkflowExecutionSnapshot;
    step: WorkflowStep;
    ordinal: number;
    history: readonly WorkflowRunStep[];
  }): Promise<WorkflowPreparedStepInput> | WorkflowPreparedStepInput;
  executeStep(input: {
    snapshot: WorkflowExecutionSnapshot;
    step: WorkflowStep;
    ordinal: number;
    stepInput: WorkspaceJson;
    history: readonly WorkflowRunStep[];
    signal: AbortSignal;
  }): Promise<WorkflowStepExecutionResult> | WorkflowStepExecutionResult;
}

export class UnsupportedWorkflowStepError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedWorkflowStepError";
  }
}

function toStructuredError(error: unknown): StructuredError {
  if (error instanceof UnsupportedWorkflowStepError) {
    return {
      code: "workflow_step_unsupported",
      message: error.message,
      retryable: false,
      details: null,
    };
  }
  if (error instanceof WorkspaceApiError) {
    return {
      code: error.code.toLowerCase(),
      message: error.message,
      retryable: error.status >= 500,
      details: null,
    };
  }
  if (
    error !== null &&
    typeof error === "object" &&
    typeof (error as { code?: unknown }).code === "string" &&
    /^[a-z0-9_]{1,120}$/.test((error as { code: string }).code) &&
    typeof (error as { retryable?: unknown }).retryable === "boolean"
  ) {
    return {
      code: (error as { code: string }).code,
      message: "Workflow model execution failed.",
      retryable: (error as { retryable: boolean }).retryable,
      details: null,
    };
  }
  return {
    code: "workflow_execution_failed",
    message: "Workflow execution failed.",
    retryable: true,
    details: null,
  };
}

type WorkflowRunJobPayload = {
  runId: string;
  workflowId: string;
  snapshotId: string;
  snapshotSha256: string;
  retryOfRunId: string | null;
};

export function workflowPayloadFromJob(
  payload: unknown,
): WorkflowRunJobPayload | null {
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    return null;
  }
  const value = payload as Record<string, unknown>;
  const runId = value.runId;
  const workflowId = value.workflowId;
  const snapshotId = value.snapshotId;
  const snapshotSha256 = value.snapshotSha256;
  const retryOfRunId = value.retryOfRunId;
  if (
    typeof runId !== "string" ||
    !runId.trim() ||
    typeof workflowId !== "string" ||
    !workflowId.trim() ||
    typeof snapshotId !== "string" ||
    !snapshotId.trim() ||
    typeof snapshotSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(snapshotSha256) ||
    (retryOfRunId !== null &&
      (typeof retryOfRunId !== "string" || !retryOfRunId.trim()))
  ) {
    return null;
  }
  return { runId, workflowId, snapshotId, snapshotSha256, retryOfRunId };
}

function throwAbortError(): never {
  const error = new Error("Workflow execution aborted.");
  error.name = "AbortError";
  throw error;
}

export class WorkspaceWorkflowRuntime {
  constructor(
    private readonly workflows: WorkflowsService,
    private readonly jobs: FencedWorkflowJobsPort,
    private readonly executor: WorkflowStepExecutor,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private claimCallbacks(
    context: HandlerSignalContext,
    runId: string,
  ): WorkflowClaimCallbacks {
    if (!context.claim) {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Workflow execution requires a fenced job claim.",
      );
    }
    const base = {
      id: context.job.id,
      type: "workflow_run" as const,
      resourceType: "workflow_run" as const,
      resourceId: runId,
      leaseOwner: context.claim.leaseOwner,
      attempt: context.claim.attempt,
      payload: context.job.payload,
    };
    const at = () => this.now().toISOString();
    return {
      assert: () =>
        this.jobs.assertClaimInCurrentTransaction({ ...base, at: at() }),
      finishComplete: (result) =>
        this.jobs.finishClaimInCurrentTransaction({
          ...base,
          event: { type: "complete", at: at(), result },
        }),
      finishFailure: (error) =>
        this.jobs.finishClaimInCurrentTransaction({
          ...base,
          event: { type: "fail", at: at(), error },
        }),
    };
  }

  async handle(context: HandlerSignalContext): Promise<void> {
    if (
      context.job.type !== "workflow_run" ||
      context.job.resourceType !== "workflow_run"
    ) {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Workflow runtime received a non-workflow job.",
      );
    }
    const payload = workflowPayloadFromJob(context.job.payload);
    if (!payload || payload.runId !== context.job.resourceId) {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Workflow job payload does not match its resource identity.",
      );
    }
    const callbacks = this.claimCallbacks(context, payload.runId);
    const snapshot = this.workflows.getExecutionSnapshot(payload.runId);
    const detail = this.workflows.getRun(payload.runId);
    if (
      snapshot.workflowRunId !== payload.runId ||
      snapshot.id !== payload.snapshotId ||
      snapshot.snapshotSha256 !== payload.snapshotSha256 ||
      snapshot.workflowId !== payload.workflowId ||
      snapshot.workflowId !== detail.run.workflowId ||
      detail.run.retryOfRunId !== payload.retryOfRunId
    ) {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Workflow job payload does not match its immutable execution snapshot.",
      );
    }
    try {
      this.workflows.requireExecutionSnapshotReady(payload.runId);
      if (snapshot.steps.length === 0) {
        throw new UnsupportedWorkflowStepError(
          "Workflow execution snapshot has no materialized Assistant steps.",
        );
      }
      for (const [ordinal, step] of snapshot.steps.entries()) {
        if (context.signal.aborted) {
          throwAbortError();
        }
        const current = this.workflows.getRun(payload.runId);
        const attempts = current.steps.filter(
          (candidate) => candidate.ordinal === ordinal,
        );
        const latest = attempts.at(-1);
        if (!latest) {
          throw new WorkspaceApiError(
            500,
            "INTERNAL_ERROR",
            "Workflow snapshot and step-run records do not match.",
          );
        }
        if (latest.status === "complete" || latest.status === "skipped")
          continue;
        if (
          latest.status !== "queued" &&
          latest.status !== "waiting" &&
          latest.status !== "running"
        ) {
          throw new WorkspaceApiError(
            409,
            "CONFLICT",
            "Workflow step is not executable.",
          );
        }
        const history = current.steps.filter(
          (candidate) => candidate.ordinal < ordinal,
        );
        let stepInput = latest.input;
        if (latest.status !== "running") {
          const prepared = this.executor.prepareStep
            ? await this.executor.prepareStep({
                snapshot,
                step,
                ordinal,
                history,
              })
            : ({ status: "ready", input: {} } as const);
          if (prepared.status === "unsupported") {
            throw new UnsupportedWorkflowStepError(prepared.message);
          }
          stepInput = prepared.input;
          this.workflows.startClaimedStep(
            payload.runId,
            ordinal,
            stepInput,
            callbacks,
          );
        }
        const result = await this.executor.executeStep({
          snapshot,
          step,
          ordinal,
          stepInput,
          history,
          signal: context.signal,
        });
        if (result.status === "unsupported") {
          throw new UnsupportedWorkflowStepError(result.message);
        }
        if (context.signal.aborted) throwAbortError();
        this.workflows.completeClaimedStep(
          payload.runId,
          ordinal,
          result.output,
          callbacks,
        );
      }
      const finished = this.workflows.getRun(payload.runId);
      const promptSteps = finished.steps
        .filter((step) => step.step.kind === "prompt" && step.output !== null)
        .map((step) => ({ status: step.status, output: step.output }))
        .filter(
          (
            step,
          ): step is {
            status: typeof step.status;
            output: Record<string, WorkspaceJson>;
          } =>
            step.output !== null &&
            typeof step.output === "object" &&
            !Array.isArray(step.output),
        );
      const finalPrompt = promptSteps.at(-1)?.output;
      const explicitOutput = [...finished.steps]
        .reverse()
        .find(
          (step) =>
            step.step.kind === "output" &&
            step.status === "complete" &&
            step.output !== null &&
            typeof step.output === "object" &&
            !Array.isArray(step.output) &&
            step.output.schema === "vera-workflow-output-result-v1" &&
            step.output.kind === "output",
        )?.output;
      const explicitOutputRecord =
        explicitOutput !== null &&
        typeof explicitOutput === "object" &&
        !Array.isArray(explicitOutput)
          ? explicitOutput
          : null;
      this.workflows.completeClaimedRun(
        payload.runId,
        {
          schema: "vera-workflow-run-result-v1",
          executedStepCount: snapshot.steps.length,
          modelCallCount: promptSteps.filter(
            (step) => step.status === "complete",
          ).length,
          ...(explicitOutputRecord?.format === "text" ||
          explicitOutputRecord?.format === "json"
            ? { format: explicitOutputRecord.format }
            : {}),
          content:
            explicitOutputRecord?.format === "text" &&
            typeof explicitOutputRecord.content === "string"
              ? explicitOutputRecord.content
              : explicitOutputRecord?.format === "json"
                ? null
                : typeof finalPrompt?.content === "string"
                  ? finalPrompt.content
                  : null,
          ...(explicitOutputRecord?.format === "json"
            ? { value: explicitOutputRecord.value ?? null }
            : {}),
          sources: Array.isArray(explicitOutputRecord?.sources)
            ? explicitOutputRecord.sources
            : Array.isArray(finalPrompt?.sources)
              ? finalPrompt.sources
              : [],
        },
        callbacks,
      );
    } catch (error) {
      if (error instanceof WorkspaceJobLeaseLostError) throw error;
      if (context.signal.aborted) throwAbortError();
      this.workflows.failClaimedRun(
        payload.runId,
        toStructuredError(error),
        callbacks,
      );
    }
  }
}
