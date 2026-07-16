import {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { ZodError } from "zod";

import { WorkspaceApiError } from "../../lib/workspace/errors";
import { WorkspaceIdSchema } from "../../lib/workspace/workspacePersistencePrimitivesV1";
import {
  MatterListWireQuerySchema,
  parseCreateMatterProfileWire,
  parseCreateMatterWire,
  parseUpdateMatterProfileWire,
  safeMatterValidationDetails,
  toMatterViewPageWire,
  toMatterViewWire,
} from "./contracts";
import type { MatterProfileServiceContext } from "./service";

type Awaitable<T> = T | Promise<T>;

/** Narrow HTTP seam. MatterProfileService satisfies this interface directly. */
export interface MatterProfileV1Port {
  listMatters(
    context: MatterProfileServiceContext,
    input: unknown,
  ): Awaitable<unknown>;
  createMatter(
    context: MatterProfileServiceContext,
    input: unknown,
  ): Awaitable<unknown>;
  getMatter(
    context: MatterProfileServiceContext,
    projectId: string,
  ): Awaitable<unknown>;
  getProjectMatterProfile(
    context: MatterProfileServiceContext,
    projectId: string,
  ): Awaitable<unknown>;
  createProjectMatterProfile(
    context: MatterProfileServiceContext,
    projectId: string,
    input: unknown,
  ): Awaitable<unknown>;
  updateProjectMatterProfile(
    context: MatterProfileServiceContext,
    projectId: string,
    input: unknown,
  ): Awaitable<unknown>;
}

export type MatterProfileV1RouterOptions = {
  principal?: (request: Request) => string | undefined;
};

type AsyncHandler = (request: Request, response: Response) => Promise<void>;

function asyncRoute(handler: AsyncHandler) {
  return (request: Request, response: Response, next: NextFunction) => {
    void handler(request, response).catch(next);
  };
}

function contextFor(
  request: Request,
  options: MatterProfileV1RouterOptions,
): MatterProfileServiceContext {
  const response = request.res as Response | undefined;
  const candidate =
    options.principal?.(request) ??
    response?.locals.userId ??
    (request as Request & { userId?: unknown }).userId;
  if (
    typeof candidate !== "string" ||
    !WorkspaceIdSchema.safeParse(candidate).success
  ) {
    throw new WorkspaceApiError(
      401,
      "UNAUTHORIZED",
      "Authentication is required.",
    );
  }
  return { principalId: candidate };
}

function projectId(request: Request): string {
  return WorkspaceIdSchema.parse(request.params.projectId);
}

function safeView(payload: unknown) {
  try {
    return toMatterViewWire(payload as Parameters<typeof toMatterViewWire>[0]);
  } catch {
    throw new WorkspaceApiError(
      500,
      "INTERNAL_ERROR",
      "Matter response could not be serialized safely.",
    );
  }
}

function safePage(payload: unknown) {
  try {
    return toMatterViewPageWire(
      payload as Parameters<typeof toMatterViewPageWire>[0],
    );
  } catch {
    throw new WorkspaceApiError(
      500,
      "INTERNAL_ERROR",
      "Matter list response could not be serialized safely.",
    );
  }
}

function errorPayload(error: unknown) {
  if (error instanceof ZodError) {
    return {
      status: 400,
      body: {
        detail: "Invalid request.",
        code: "VALIDATION_ERROR",
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid request.",
          retryable: false,
          details: safeMatterValidationDetails(error),
        },
      },
    };
  }
  if (error instanceof WorkspaceApiError) {
    return {
      status: error.status,
      body: {
        detail: error.message,
        code: error.code,
        error: { ...error.toResponse().error, retryable: false },
      },
    };
  }
  return {
    status: 500,
    body: {
      detail: "Internal server error.",
      code: "INTERNAL_ERROR",
      error: {
        code: "INTERNAL_ERROR",
        message: "Internal server error.",
        retryable: false,
      },
    },
  };
}

/**
 * Mount at `/api/v1`. The legacy `/api/v1/projects` router remains unchanged;
 * this additive router owns only Matters and the explicit Profile subresource.
 */
export function createMatterProfileV1Router(
  port: MatterProfileV1Port,
  options: MatterProfileV1RouterOptions = {},
): Router {
  const router = Router();

  router.get(
    "/matters",
    asyncRoute(async (request, response) => {
      const query = MatterListWireQuerySchema.parse(request.query);
      response.json(
        safePage(
          await port.listMatters(contextFor(request, options), {
            status: query.status,
            cursor: query.cursor,
            limit: query.limit,
          }),
        ),
      );
    }),
  );

  router.post(
    "/matters",
    asyncRoute(async (request, response) => {
      response
        .status(201)
        .json(
          safeView(
            await port.createMatter(
              contextFor(request, options),
              parseCreateMatterWire(request.body),
            ),
          ),
        );
    }),
  );

  router.get(
    "/matters/:projectId",
    asyncRoute(async (request, response) => {
      response.json(
        safeView(
          await port.getMatter(
            contextFor(request, options),
            projectId(request),
          ),
        ),
      );
    }),
  );

  router.get(
    "/projects/:projectId/matter-profile",
    asyncRoute(async (request, response) => {
      response.json(
        safeView(
          await port.getProjectMatterProfile(
            contextFor(request, options),
            projectId(request),
          ),
        ),
      );
    }),
  );

  router.post(
    "/projects/:projectId/matter-profile",
    asyncRoute(async (request, response) => {
      response
        .status(201)
        .json(
          safeView(
            await port.createProjectMatterProfile(
              contextFor(request, options),
              projectId(request),
              parseCreateMatterProfileWire(request.body),
            ),
          ),
        );
    }),
  );

  router.patch(
    "/projects/:projectId/matter-profile",
    asyncRoute(async (request, response) => {
      response.json(
        safeView(
          await port.updateProjectMatterProfile(
            contextFor(request, options),
            projectId(request),
            parseUpdateMatterProfileWire(request.body),
          ),
        ),
      );
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
      const mapped = errorPayload(error);
      response.status(mapped.status).json(mapped.body);
    },
  );

  return router;
}
