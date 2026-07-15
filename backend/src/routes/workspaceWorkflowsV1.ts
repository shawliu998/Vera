import {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { z, ZodError } from "zod";

import { WorkspaceApiError } from "../lib/workspace/errors";
import {
  RunStatusSchema,
  SafeStructuredValueSchema,
  StepRunStatusSchema,
  StructuredErrorSchema,
  WorkspaceIdSchema,
} from "../lib/workspace/contracts";
import { WORKSPACE_LOCAL_PRINCIPAL_ID } from "../lib/workspace/principal";
import type {
  PreparedWorkflowRun,
  WorkflowRunDetail,
  WorkflowRunRecord,
  WorkflowRunStep,
} from "../lib/workspace/repositories/workflows";
import type { Page, PageRequest } from "../lib/workspace/pagination";
import {
  MikeCreateWorkflowRequestSchema,
  MikeUpdateWorkflowRequestSchema,
  MikeWorkflowWireSchema,
  VeraWorkflowDefinitionUpdateRequestSchema,
  VeraWorkflowDefinitionWireSchema,
  parseMikeWorkflowCreate,
  parseMikeWorkflowUpdate,
  parseVeraWorkflowDefinitionUpdate,
  type MikeWorkflowWire,
  type VeraWorkflowDefinitionWire,
} from "../lib/workspace/workflowCompatibility";
import { WORKSPACE_WORKFLOW_EXECUTION_CAPABILITY } from "../lib/workspace/services/workflowRuntime";

const WorkflowId = z.string().trim().min(1).max(240);
const ListQuery = z
  .object({ type: z.enum(["assistant", "tabular"]).optional() })
  .strict();
const HideBody = z.object({ workflow_id: WorkflowId }).strict();
const RunId = WorkspaceIdSchema;
const RunPageQuery = z
  .object({
    cursor: z.string().min(1).max(512).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();
const StartRunBody = z
  .object({
    idempotency_key: z.string().trim().min(1).max(240),
    project_id: WorkspaceIdSchema.optional(),
    model_profile_id: WorkspaceIdSchema.optional(),
    input_binding: SafeStructuredValueSchema.optional(),
  })
  .strict();
const RetryRunBody = z
  .object({ idempotency_key: z.string().trim().min(1).max(240) })
  .strict();
const EmptyBody = z.object({}).strict();

const WorkflowStepWireSchema = z.discriminatedUnion("kind", [
  z
    .object({
      id: WorkspaceIdSchema,
      kind: z.literal("prompt"),
      title: z.string().min(1).max(160),
      prompt: z.string().min(1).max(20_000),
      model_profile_id: WorkspaceIdSchema.optional(),
    })
    .strict(),
  z
    .object({
      id: WorkspaceIdSchema,
      kind: z.literal("document_context"),
      title: z.string().min(1).max(160),
      max_documents: z.number().int().min(1).max(100),
      max_chunks_per_document: z.number().int().min(1).max(100),
      query_template: z.string().min(1).max(2_000).optional(),
      result_limit: z.number().int().min(1).max(100).optional(),
    })
    .strict(),
  z
    .object({
      id: WorkspaceIdSchema,
      kind: z.literal("tabular_column"),
      title: z.string().min(1).max(160),
      output_type: z.enum(["text", "boolean", "enum", "number"]),
      prompt: z.string().min(1).max(20_000),
      enum_values: z.array(z.string().min(1).max(160)).max(100).optional(),
    })
    .strict(),
  z
    .object({
      id: WorkspaceIdSchema,
      kind: z.literal("output"),
      title: z.string().min(1).max(160),
      format: z.enum(["text", "json"]),
    })
    .strict(),
]);

export const WorkspaceWorkflowRunWireSchema = z
  .object({
    id: WorkspaceIdSchema,
    workflow_id: WorkspaceIdSchema,
    project_id: WorkspaceIdSchema.nullable(),
    status: RunStatusSchema,
    model_profile_id: WorkspaceIdSchema.nullable(),
    job_id: WorkspaceIdSchema.nullable(),
    retry_of_run_id: WorkspaceIdSchema.nullable(),
    input: SafeStructuredValueSchema,
    output: SafeStructuredValueSchema.nullable(),
    started_at: z.string().datetime().nullable(),
    completed_at: z.string().datetime().nullable(),
    error: StructuredErrorSchema.nullable(),
    created_at: z.string().datetime(),
  })
  .strict();

export const WorkspaceWorkflowStepRunWireSchema = z
  .object({
    id: WorkspaceIdSchema,
    workflow_run_id: WorkspaceIdSchema,
    ordinal: z.number().int().nonnegative(),
    attempt: z.number().int().positive(),
    step: WorkflowStepWireSchema,
    status: StepRunStatusSchema,
    input: SafeStructuredValueSchema,
    output: SafeStructuredValueSchema.nullable(),
    error: StructuredErrorSchema.nullable(),
    started_at: z.string().datetime().nullable(),
    completed_at: z.string().datetime().nullable(),
  })
  .strict();

export const WorkspaceWorkflowRunDetailWireSchema = z
  .object({
    run: WorkspaceWorkflowRunWireSchema,
    steps: z.array(WorkspaceWorkflowStepRunWireSchema).max(300),
  })
  .strict();

export const WorkspacePreparedWorkflowRunWireSchema =
  WorkspaceWorkflowRunDetailWireSchema.extend({ reused: z.boolean() }).strict();
export type WorkspaceWorkflowsV1Context = { principalId: string };

/**
 * Composition owns this port.  This Express adapter never opens a database or
 * reaches into a repository, making it safe to mount alongside workspaceV1.
 */
export interface WorkspaceWorkflowsV1Port {
  executionAvailable?(context: WorkspaceWorkflowsV1Context): boolean;
  list(
    context: WorkspaceWorkflowsV1Context,
    input: { type?: "assistant" | "tabular" },
  ): Promise<readonly MikeWorkflowWire[]>;
  get(
    context: WorkspaceWorkflowsV1Context,
    workflowId: string,
  ): Promise<MikeWorkflowWire>;
  getDefinition?(
    context: WorkspaceWorkflowsV1Context,
    workflowId: string,
  ): Promise<VeraWorkflowDefinitionWire>;
  updateDefinition?(
    context: WorkspaceWorkflowsV1Context,
    workflowId: string,
    input: ReturnType<typeof parseVeraWorkflowDefinitionUpdate>,
  ): Promise<VeraWorkflowDefinitionWire>;
  create(
    context: WorkspaceWorkflowsV1Context,
    input: ReturnType<typeof parseMikeWorkflowCreate>,
  ): Promise<MikeWorkflowWire>;
  update(
    context: WorkspaceWorkflowsV1Context,
    workflowId: string,
    input: ReturnType<typeof parseMikeWorkflowUpdate>,
  ): Promise<MikeWorkflowWire>;
  delete(
    context: WorkspaceWorkflowsV1Context,
    workflowId: string,
  ): Promise<void>;
  listHidden(context: WorkspaceWorkflowsV1Context): Promise<readonly string[]>;
  hide(context: WorkspaceWorkflowsV1Context, workflowId: string): Promise<void>;
  unhide(
    context: WorkspaceWorkflowsV1Context,
    workflowId: string,
  ): Promise<void>;
  startRun?(
    context: WorkspaceWorkflowsV1Context,
    workflowId: string,
    input: {
      idempotencyKey: string;
      projectId?: string;
      modelProfileId?: string;
      inputBinding?: z.infer<typeof SafeStructuredValueSchema>;
    },
  ): Promise<PreparedWorkflowRun>;
  listRuns?(
    context: WorkspaceWorkflowsV1Context,
    workflowId: string,
    page: PageRequest,
  ): Promise<Page<WorkflowRunRecord>>;
  getRun?(
    context: WorkspaceWorkflowsV1Context,
    runId: string,
  ): Promise<WorkflowRunDetail>;
  cancelRun?(
    context: WorkspaceWorkflowsV1Context,
    runId: string,
  ): Promise<WorkflowRunDetail>;
  retryRun?(
    context: WorkspaceWorkflowsV1Context,
    runId: string,
    idempotencyKey: string,
  ): Promise<PreparedWorkflowRun>;
}

export type WorkspaceWorkflowsV1RouterOptions = {
  context?: (
    request: Request,
    response: Response,
  ) => WorkspaceWorkflowsV1Context;
};

function contextFor(
  request: Request,
  response: Response,
  options: WorkspaceWorkflowsV1RouterOptions,
) {
  const principalId = options.context
    ? options.context(request, response).principalId
    : response.locals.userId;
  if (typeof principalId !== "string" || !principalId.trim()) {
    throw new WorkspaceApiError(
      401,
      "UNAUTHORIZED",
      "Authentication is required.",
    );
  }
  if (principalId !== WORKSPACE_LOCAL_PRINCIPAL_ID) {
    throw new WorkspaceApiError(403, "FORBIDDEN", "Workspace is local-only.");
  }
  return { principalId: WORKSPACE_LOCAL_PRINCIPAL_ID };
}

function errorPayload(error: unknown) {
  if (error instanceof WorkspaceApiError) {
    return {
      status: error.status,
      body: {
        detail: error.message,
        code: error.code,
        error: { code: error.code, message: error.message, retryable: false },
      },
    };
  }
  if (error instanceof ZodError) {
    const detail = error.issues[0]?.message ?? "Invalid request.";
    return {
      status: 422,
      body: {
        detail,
        code: "VALIDATION_ERROR",
        error: {
          code: "VALIDATION_ERROR",
          message: detail,
          retryable: false,
        },
      },
    };
  }
  return {
    status: 500,
    body: {
      detail: "Workspace workflow request failed.",
      code: "INTERNAL_ERROR",
      error: {
        code: "INTERNAL_ERROR",
        message: "Workspace workflow request failed.",
        retryable: false,
      },
    },
  };
}

function asyncRoute(
  handler: (request: Request, response: Response) => Promise<void>,
) {
  return (request: Request, response: Response, next: NextFunction) => {
    void handler(request, response).catch(next);
  };
}

function sendWorkflow(response: Response, workflow: unknown, status = 200) {
  response.status(status).json(MikeWorkflowWireSchema.parse(workflow));
}

function requirePortMethod<T>(method: T | undefined, message: string): T {
  if (method === undefined) {
    throw new WorkspaceApiError(503, "PRECONDITION_FAILED", message);
  }
  return method;
}

function stepWire(step: WorkflowRunStep["step"], fallbackId: string) {
  const id = step.id ?? WorkspaceIdSchema.parse(fallbackId);
  if (step.kind === "document_context") {
    return WorkflowStepWireSchema.parse({
      id,
      kind: step.kind,
      title: step.title,
      max_documents: step.maxDocuments,
      max_chunks_per_document: step.maxChunksPerDocument,
      ...(step.queryTemplate === undefined
        ? {}
        : { query_template: step.queryTemplate }),
      ...(step.resultLimit === undefined
        ? {}
        : { result_limit: step.resultLimit }),
    });
  }
  if (step.kind === "tabular_column") {
    return WorkflowStepWireSchema.parse({
      id,
      kind: step.kind,
      title: step.title,
      output_type: step.outputType,
      prompt: step.prompt,
      ...(step.enumValues ? { enum_values: step.enumValues } : {}),
    });
  }
  if (step.kind === "output") {
    return WorkflowStepWireSchema.parse({
      id,
      kind: step.kind,
      title: step.title,
      format: step.format,
    });
  }
  return WorkflowStepWireSchema.parse({
    id,
    kind: step.kind,
    title: step.title,
    prompt: step.prompt,
    ...(step.modelProfileId === undefined
      ? {}
      : { model_profile_id: step.modelProfileId }),
  });
}

function runWire(run: WorkflowRunRecord) {
  return WorkspaceWorkflowRunWireSchema.parse({
    id: run.id,
    workflow_id: run.workflowId,
    project_id: run.projectId,
    status: run.status,
    model_profile_id: run.modelProfileId,
    job_id: run.jobId,
    retry_of_run_id: run.retryOfRunId,
    input: run.input,
    output: run.output,
    started_at: run.startedAt,
    completed_at: run.completedAt,
    error: run.error,
    created_at: run.createdAt,
  });
}

function stepRunWire(step: WorkflowRunStep) {
  return WorkspaceWorkflowStepRunWireSchema.parse({
    id: step.id,
    workflow_run_id: step.workflowRunId,
    ordinal: step.ordinal,
    attempt: step.attempt,
    step: stepWire(step.step, step.id),
    status: step.status,
    input: step.input,
    output: step.output,
    error: step.error,
    started_at: step.startedAt,
    completed_at: step.completedAt,
  });
}

function runDetailWire(detail: WorkflowRunDetail) {
  return WorkspaceWorkflowRunDetailWireSchema.parse({
    run: runWire(detail.run),
    steps: detail.steps.map(stepRunWire),
  });
}

function preparedRunWire(prepared: PreparedWorkflowRun) {
  return WorkspacePreparedWorkflowRunWireSchema.parse({
    ...runDetailWire(prepared.detail),
    reused: prepared.reused,
  });
}

export { WORKSPACE_WORKFLOW_EXECUTION_CAPABILITY };

export function createWorkspaceWorkflowsV1Router(
  port: WorkspaceWorkflowsV1Port,
  options: WorkspaceWorkflowsV1RouterOptions = {},
) {
  const router = Router();
  router.get(
    "/",
    asyncRoute(async (request, response) => {
      const query = ListQuery.parse(request.query);
      const values = await port.list(
        contextFor(request, response, options),
        query,
      );
      response.json(values.map((value) => MikeWorkflowWireSchema.parse(value)));
    }),
  );
  router.post(
    "/",
    asyncRoute(async (request, response) => {
      const input = parseMikeWorkflowCreate(request.body ?? {});
      const workflow = await port.create(
        contextFor(request, response, options),
        input,
      );
      sendWorkflow(response, workflow, 201);
    }),
  );
  router.get(
    "/capabilities",
    asyncRoute(async (request, response) => {
      const context = contextFor(request, response, options);
      response.json({
        execution_enabled: port.executionAvailable?.(context) === true,
        assistant_runs: true,
        tabular_runs: false,
      });
    }),
  );
  router.get(
    "/hidden",
    asyncRoute(async (request, response) => {
      const ids = await port.listHidden(contextFor(request, response, options));
      response.json(ids.map((id) => WorkflowId.parse(id)));
    }),
  );
  router.post(
    "/hidden",
    asyncRoute(async (request, response) => {
      const input = HideBody.parse(request.body ?? {});
      await port.hide(
        contextFor(request, response, options),
        input.workflow_id,
      );
      response.status(204).send();
    }),
  );
  router.delete(
    "/hidden/:workflowId",
    asyncRoute(async (request, response) => {
      await port.unhide(
        contextFor(request, response, options),
        WorkflowId.parse(request.params.workflowId),
      );
      response.status(204).send();
    }),
  );
  router.get(
    "/:workflowId/definition",
    asyncRoute(async (request, response) => {
      const definition = await requirePortMethod(
        port.getDefinition,
        "Workflow definition runtime is unavailable.",
      ).call(
        port,
        contextFor(request, response, options),
        WorkflowId.parse(request.params.workflowId),
      );
      response.json(VeraWorkflowDefinitionWireSchema.parse(definition));
    }),
  );
  router.put(
    "/:workflowId/definition",
    asyncRoute(async (request, response) => {
      VeraWorkflowDefinitionUpdateRequestSchema.parse(request.body ?? {});
      const definition = await requirePortMethod(
        port.updateDefinition,
        "Workflow definition runtime is unavailable.",
      ).call(
        port,
        contextFor(request, response, options),
        WorkflowId.parse(request.params.workflowId),
        parseVeraWorkflowDefinitionUpdate(request.body ?? {}),
      );
      response.json(VeraWorkflowDefinitionWireSchema.parse(definition));
    }),
  );
  router.post(
    "/:workflowId/runs",
    asyncRoute(async (request, response) => {
      const body = StartRunBody.parse(request.body ?? {});
      const prepared = await requirePortMethod(
        port.startRun,
        "Workflow execution runtime is unavailable.",
      ).call(
        port,
        contextFor(request, response, options),
        WorkflowId.parse(request.params.workflowId),
        {
          idempotencyKey: body.idempotency_key,
          ...(body.project_id === undefined
            ? {}
            : { projectId: body.project_id }),
          ...(body.model_profile_id === undefined
            ? {}
            : { modelProfileId: body.model_profile_id }),
          ...(body.input_binding === undefined
            ? {}
            : { inputBinding: body.input_binding }),
        },
      );
      response.status(202).json(preparedRunWire(prepared));
    }),
  );
  router.get(
    "/:workflowId/runs",
    asyncRoute(async (request, response) => {
      const query = RunPageQuery.parse(request.query);
      const page = await requirePortMethod(
        port.listRuns,
        "Workflow execution runtime is unavailable.",
      ).call(
        port,
        contextFor(request, response, options),
        WorkflowId.parse(request.params.workflowId),
        {
          ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
          ...(query.limit === undefined ? {} : { limit: query.limit }),
        },
      );
      response.json({
        items: page.items.map(runWire),
        next_cursor: page.nextCursor,
      });
    }),
  );
  router.get(
    "/:workflowId",
    asyncRoute(async (request, response) => {
      const workflow = await port.get(
        contextFor(request, response, options),
        WorkflowId.parse(request.params.workflowId),
      );
      sendWorkflow(response, workflow);
    }),
  );
  const update = asyncRoute(async (request, response) => {
    const workflow = await port.update(
      contextFor(request, response, options),
      WorkflowId.parse(request.params.workflowId),
      parseMikeWorkflowUpdate(request.body ?? {}),
    );
    sendWorkflow(response, workflow);
  });
  router.put("/:workflowId", update);
  router.patch("/:workflowId", update);
  router.delete(
    "/:workflowId",
    asyncRoute(async (request, response) => {
      await port.delete(
        contextFor(request, response, options),
        WorkflowId.parse(request.params.workflowId),
      );
      response.status(204).send();
    }),
  );
  router.use(
    (
      error: unknown,
      _request: Request,
      response: Response,
      next: NextFunction,
    ) => {
      if (response.headersSent) return next(error);
      const payload = errorPayload(error);
      response.status(payload.status).json(payload.body);
    },
  );
  return router;
}

/** Sibling `/api/v1/workflow-runs` control plane for one durable run. */
export function createWorkspaceWorkflowRunsV1Router(
  port: WorkspaceWorkflowsV1Port,
  options: WorkspaceWorkflowsV1RouterOptions = {},
) {
  const router = Router();
  router.get(
    "/workflow-runs/:runId",
    asyncRoute(async (request, response) => {
      const detail = await requirePortMethod(
        port.getRun,
        "Workflow execution runtime is unavailable.",
      ).call(
        port,
        contextFor(request, response, options),
        RunId.parse(request.params.runId),
      );
      response.json(runDetailWire(detail));
    }),
  );
  router.post(
    "/workflow-runs/:runId/cancel",
    asyncRoute(async (request, response) => {
      EmptyBody.parse(request.body ?? {});
      const detail = await requirePortMethod(
        port.cancelRun,
        "Workflow execution runtime is unavailable.",
      ).call(
        port,
        contextFor(request, response, options),
        RunId.parse(request.params.runId),
      );
      response.json(runDetailWire(detail));
    }),
  );
  router.post(
    "/workflow-runs/:runId/retry",
    asyncRoute(async (request, response) => {
      const body = RetryRunBody.parse(request.body ?? {});
      const prepared = await requirePortMethod(
        port.retryRun,
        "Workflow execution runtime is unavailable.",
      ).call(
        port,
        contextFor(request, response, options),
        RunId.parse(request.params.runId),
        body.idempotency_key,
      );
      response.status(202).json(preparedRunWire(prepared));
    }),
  );
  router.use(
    (
      error: unknown,
      _request: Request,
      response: Response,
      next: NextFunction,
    ) => {
      if (response.headersSent) return next(error);
      const payload = errorPayload(error);
      response.status(payload.status).json(payload.body);
    },
  );
  return router;
}
