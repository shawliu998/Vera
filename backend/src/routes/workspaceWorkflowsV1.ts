import {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { z, ZodError } from "zod";

import { WorkspaceApiError } from "../lib/workspace/errors";
import { WORKSPACE_LOCAL_PRINCIPAL_ID } from "../lib/workspace/principal";
import {
  MikeCreateWorkflowRequestSchema,
  MikeUpdateWorkflowRequestSchema,
  MikeWorkflowWireSchema,
  parseMikeWorkflowCreate,
  parseMikeWorkflowUpdate,
  type MikeWorkflowWire,
} from "../lib/workspace/workflowCompatibility";
import { WORKSPACE_WORKFLOW_EXECUTION_CAPABILITY } from "../lib/workspace/services/workflowRuntime";

const WorkflowId = z.string().trim().min(1).max(240);
const ListQuery = z
  .object({ type: z.enum(["assistant", "tabular"]).optional() })
  .strict();
const HideBody = z.object({ workflow_id: WorkflowId }).strict();
export type WorkspaceWorkflowsV1Context = { principalId: string };

/**
 * Composition owns this port.  This Express adapter never opens a database or
 * reaches into a repository, making it safe to mount alongside workspaceV1.
 */
export interface WorkspaceWorkflowsV1Port {
  list(
    context: WorkspaceWorkflowsV1Context,
    input: { type?: "assistant" | "tabular" },
  ): Promise<readonly MikeWorkflowWire[]>;
  get(
    context: WorkspaceWorkflowsV1Context,
    workflowId: string,
  ): Promise<MikeWorkflowWire>;
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
