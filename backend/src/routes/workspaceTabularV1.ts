import {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import { z, ZodError } from "zod";

import {
  assertMikeSafePayload,
  MIKE_LOCAL_USER_ID,
  mikeSseDone,
  mikeSseFrame,
  parseMikeTabularCreate,
  type MikeSseEvent,
} from "../lib/workspace/mikeCompatibility";
import { WorkspaceApiError } from "../lib/workspace/errors";
import {
  MikeColumnConfigSchema,
  TabularReviewTitleSchemaV7,
} from "../lib/workspace/services/tabularCompatibility";

const Id = z.string().uuid();
const MAX_TABULAR_ROUTE_DOWNLOAD_BYTES = 8 * 1024 * 1024;
const ProjectFilter = z.object({ project_id: Id.optional() }).strict();
const EmptyBody = z.object({}).strict();
const TabularUpdate = z
  .object({
    title: TabularReviewTitleSchemaV7.transform((value) =>
      value.trim(),
    ).optional(),
    columns_config: z.array(MikeColumnConfigSchema).max(100).optional(),
    document_ids: z.array(Id).max(1_000).optional(),
    project_id: Id.nullable().optional(),
    model_profile_id: Id.nullable().optional(),
    shared_with: z.array(z.string().email()).max(0).optional(),
  })
  .strict();
const ClearCells = z
  .object({ document_ids: z.array(Id).min(1).max(1_000) })
  .strict();
const RegenerateCell = z
  .object({
    document_id: Id,
    column_index: z.number().int().nonnegative(),
  })
  .strict();
const CellMutation = z
  .object({
    cell_id: Id.optional(),
    document_id: Id.optional(),
    column_index: z.number().int().nonnegative().optional(),
    reason: z.string().max(1_000).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const byCell = value.cell_id !== undefined;
    const byCoordinates =
      value.document_id !== undefined && value.column_index !== undefined;
    if (byCell === byCoordinates) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Provide either cell_id or document_id with column_index, but not both.",
      });
    }
  });
const ChatRequest = z
  .object({
    messages: z
      .array(
        z
          .object({
            role: z.enum(["user", "assistant", "tool"]),
            content: z.string().max(200_000),
          })
          .strict(),
      )
      .min(1)
      .max(1_000),
    chat_id: Id.optional(),
    review_title: TabularReviewTitleSchemaV7.optional(),
    project_name: TabularReviewTitleSchemaV7.optional(),
  })
  .strict();

export type WorkspaceTabularContext = { principalId: string };
export type WorkspaceTabularStreamSink = {
  write(event: MikeSseEvent): void;
  done(): void;
  closed?(): boolean;
};
export type WorkspaceTabularDownload = {
  filename: string;
  contentType: string;
  body: Uint8Array | string;
};

export interface WorkspaceTabularV1RuntimePort {
  listTabularReviews(
    context: WorkspaceTabularContext,
    query: { projectId?: string },
  ): Promise<unknown>;
  createTabularReview(
    context: WorkspaceTabularContext,
    input: unknown,
  ): Promise<unknown>;
  getTabularReview(
    context: WorkspaceTabularContext,
    reviewId: string,
  ): Promise<unknown>;
  updateTabularReview(
    context: WorkspaceTabularContext,
    reviewId: string,
    input: unknown,
  ): Promise<unknown>;
  deleteTabularReview(
    context: WorkspaceTabularContext,
    reviewId: string,
  ): Promise<void>;
  clearTabularCells(
    context: WorkspaceTabularContext,
    reviewId: string,
    input: { document_ids: string[] },
  ): Promise<void>;
  generateTabularReview?(
    context: WorkspaceTabularContext,
    reviewId: string,
    sink: WorkspaceTabularStreamSink,
  ): Promise<void>;
  retryTabularCell?(
    context: WorkspaceTabularContext,
    reviewId: string,
    input: { document_id: string; column_index: number },
  ): Promise<unknown>;
  cancelTabularCell(
    context: WorkspaceTabularContext,
    reviewId: string,
    input: {
      cell_id?: string;
      document_id?: string;
      column_index?: number;
      reason?: string;
    },
  ): Promise<unknown>;
  listTabularChats?(
    context: WorkspaceTabularContext,
    reviewId: string,
  ): Promise<unknown>;
  deleteTabularChat?(
    context: WorkspaceTabularContext,
    reviewId: string,
    chatId: string,
  ): Promise<void>;
  listTabularChatMessages?(
    context: WorkspaceTabularContext,
    reviewId: string,
    chatId: string,
  ): Promise<unknown>;
  streamTabularChat?(
    context: WorkspaceTabularContext,
    reviewId: string,
    input: z.infer<typeof ChatRequest>,
    sink: WorkspaceTabularStreamSink,
    signal: AbortSignal,
  ): Promise<void>;
  exportTabularReview(
    context: WorkspaceTabularContext,
    reviewId: string,
    format: "csv" | "xlsx",
  ): Promise<WorkspaceTabularDownload>;
}

export type WorkspaceTabularV1Capabilities = {
  generation: boolean;
  chat: boolean;
};

export type WorkspaceTabularV1RouterOptions = {
  /** Defaults to true; production composition must pass an authenticated principal. */
  requireAuthentication?: boolean;
  principal?: (request: Request) => string | undefined;
  capabilities?: Partial<WorkspaceTabularV1Capabilities>;
};

type AsyncHandler = (request: Request, response: Response) => Promise<void>;
const asyncRoute =
  (handler: AsyncHandler): RequestHandler =>
  (request, response, next) => {
    void handler(request, response).catch(next);
  };

function contextFor(
  request: Request,
  options: WorkspaceTabularV1RouterOptions,
): WorkspaceTabularContext {
  const requireAuthentication = options.requireAuthentication !== false;
  const candidate =
    options.principal?.(request) ??
    request.res?.locals.userId ??
    (request as Request & { userId?: unknown }).userId;
  if (
    requireAuthentication &&
    (typeof candidate !== "string" || !Id.safeParse(candidate).success)
  ) {
    throw new WorkspaceApiError(
      401,
      "UNAUTHORIZED",
      "Authentication is required.",
    );
  }
  return typeof candidate === "string" && Id.safeParse(candidate).success
    ? { principalId: candidate }
    : { principalId: MIKE_LOCAL_USER_ID };
}

function idParam(request: Request, name: string) {
  return Id.parse(request.params[name]);
}

function safeJson(response: Response, payload: unknown, status = 200) {
  assertMikeSafePayload(payload);
  response.status(status).json(payload);
}

function emptyBody(value: unknown) {
  return EmptyBody.parse(value === undefined ? {} : value);
}

function safeFilename(filename: string) {
  if (!filename || filename.length > 240 || /[\r\n\\/\0]/.test(filename)) {
    throw new WorkspaceApiError(
      500,
      "INTERNAL_ERROR",
      "Unsafe export metadata.",
    );
  }
  return filename;
}

function asciiDispositionFilename(filename: string) {
  const fallback = filename
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "_")
    .replace(/["\\]/g, "_")
    .trim()
    .slice(0, 240);
  return fallback && !/^[._ -]+$/.test(fallback) ? fallback : "tabular-review";
}

function encodeDispositionFilename(filename: string) {
  return encodeURIComponent(filename).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function sendDownload(response: Response, download: WorkspaceTabularDownload) {
  const filename = safeFilename(download.filename);
  if (
    download.contentType !== "text/csv; charset=utf-8" &&
    download.contentType !==
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  ) {
    throw new WorkspaceApiError(
      500,
      "INTERNAL_ERROR",
      "Unsafe export metadata.",
    );
  }
  const body =
    typeof download.body === "string"
      ? Buffer.from(download.body, "utf8")
      : Buffer.from(download.body);
  if (body.byteLength > MAX_TABULAR_ROUTE_DOWNLOAD_BYTES) {
    throw new WorkspaceApiError(
      413,
      "VALIDATION_ERROR",
      "Tabular export exceeds the local memory budget.",
    );
  }
  response.set({
    "Content-Type": download.contentType,
    "Content-Disposition":
      'attachment; filename="' +
      asciiDispositionFilename(filename) +
      "\"; filename*=UTF-8''" +
      encodeDispositionFilename(filename),
    "Content-Length": String(body.byteLength),
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store",
  });
  response.status(200).send(body);
}

function streamSink(response: Response): WorkspaceTabularStreamSink {
  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    response.set({
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "private, no-cache, no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    response.flushHeaders?.();
  };
  return {
    write(event) {
      start();
      response.write(mikeSseFrame(event));
    },
    done() {
      start();
      response.write(mikeSseDone());
    },
    closed() {
      return response.destroyed || response.writableEnded;
    },
  };
}

function errorPayload(error: unknown) {
  if (error instanceof ZodError) {
    return {
      status: 422,
      body: { detail: "Invalid request.", code: "VALIDATION_ERROR" },
    };
  }
  if (error instanceof WorkspaceApiError) {
    return {
      status: error.status,
      body: { detail: error.message, code: error.code },
    };
  }
  return {
    status: 500,
    body: { detail: "Internal server error.", code: "INTERNAL_ERROR" },
  };
}

function routerCapabilities(
  options: WorkspaceTabularV1RouterOptions,
): WorkspaceTabularV1Capabilities {
  return {
    generation: options.capabilities?.generation === true,
    chat: options.capabilities?.chat === true,
  };
}

function requireGenerationRuntime(
  runtime: WorkspaceTabularV1RuntimePort,
): asserts runtime is WorkspaceTabularV1RuntimePort &
  Required<
    Pick<
      WorkspaceTabularV1RuntimePort,
      "generateTabularReview" | "retryTabularCell"
    >
  > {
  if (
    typeof runtime.generateTabularReview !== "function" ||
    typeof runtime.retryTabularCell !== "function"
  ) {
    throw new Error(
      "Tabular generation capability requires a generation adapter.",
    );
  }
}

function requireChatRuntime(
  runtime: WorkspaceTabularV1RuntimePort,
): asserts runtime is WorkspaceTabularV1RuntimePort &
  Required<
    Pick<
      WorkspaceTabularV1RuntimePort,
      | "listTabularChats"
      | "deleteTabularChat"
      | "listTabularChatMessages"
      | "streamTabularChat"
    >
  > {
  if (
    typeof runtime.listTabularChats !== "function" ||
    typeof runtime.deleteTabularChat !== "function" ||
    typeof runtime.listTabularChatMessages !== "function" ||
    typeof runtime.streamTabularChat !== "function"
  ) {
    throw new Error("Tabular chat capability requires a chat adapter.");
  }
}

export function createWorkspaceTabularV1Router(
  runtime: WorkspaceTabularV1RuntimePort,
  options: WorkspaceTabularV1RouterOptions = {},
): Router {
  // Dormant foundation only: request schemas follow Mike's wire shape, but exact
  // serializers and generation/chat capabilities remain explicit integration gates.
  const router = Router();
  const capabilities = routerCapabilities(options);

  router.get(
    "/tabular-review",
    asyncRoute(async (request, response) => {
      const query = ProjectFilter.parse(request.query);
      safeJson(
        response,
        await runtime.listTabularReviews(contextFor(request, options), {
          projectId: query.project_id,
        }),
      );
    }),
  );

  router.post(
    "/tabular-review",
    asyncRoute(async (request, response) => {
      const parsed = parseMikeTabularCreate(request.body);
      const trimmedTitle = parsed.title?.trim();
      const title =
        trimmedTitle && trimmedTitle.length > 0
          ? TabularReviewTitleSchemaV7.parse(trimmedTitle).trim()
          : undefined;
      const columnsConfig = z
        .array(MikeColumnConfigSchema)
        .max(100)
        .parse(parsed.columns_config);
      safeJson(
        response,
        await runtime.createTabularReview(contextFor(request, options), {
          ...parsed,
          title: title || "Untitled Review",
          columns_config: columnsConfig,
        }),
        201,
      );
    }),
  );

  router.get(
    "/tabular-review/capabilities",
    asyncRoute(async (request, response) => {
      contextFor(request, options);
      safeJson(response, capabilities);
    }),
  );

  router.get(
    "/tabular-review/:reviewId",
    asyncRoute(async (request, response) => {
      safeJson(
        response,
        await runtime.getTabularReview(
          contextFor(request, options),
          idParam(request, "reviewId"),
        ),
      );
    }),
  );

  router.patch(
    "/tabular-review/:reviewId",
    asyncRoute(async (request, response) => {
      safeJson(
        response,
        await runtime.updateTabularReview(
          contextFor(request, options),
          idParam(request, "reviewId"),
          TabularUpdate.parse(request.body),
        ),
      );
    }),
  );

  router.delete(
    "/tabular-review/:reviewId",
    asyncRoute(async (request, response) => {
      emptyBody(request.body);
      await runtime.deleteTabularReview(
        contextFor(request, options),
        idParam(request, "reviewId"),
      );
      response.status(204).send();
    }),
  );

  router.post(
    "/tabular-review/:reviewId/clear-cells",
    asyncRoute(async (request, response) => {
      await runtime.clearTabularCells(
        contextFor(request, options),
        idParam(request, "reviewId"),
        ClearCells.parse(request.body),
      );
      response.status(204).send();
    }),
  );

  if (capabilities.generation) {
    requireGenerationRuntime(runtime);
    router.post(
      "/tabular-review/:reviewId/generate",
      asyncRoute(async (request, response) => {
        emptyBody(request.body);
        const sink = streamSink(response);
        await runtime.generateTabularReview(
          contextFor(request, options),
          idParam(request, "reviewId"),
          sink,
        );
        if (!sink.closed?.()) {
          sink.done();
          response.end();
        }
      }),
    );

    router.post(
      "/tabular-review/:reviewId/regenerate-cell",
      asyncRoute(async (request, response) => {
        safeJson(
          response,
          await runtime.retryTabularCell(
            contextFor(request, options),
            idParam(request, "reviewId"),
            RegenerateCell.parse(request.body),
          ),
          202,
        );
      }),
    );
  }

  router.post(
    "/tabular-review/:reviewId/cancel-cell",
    asyncRoute(async (request, response) => {
      safeJson(
        response,
        await runtime.cancelTabularCell(
          contextFor(request, options),
          idParam(request, "reviewId"),
          CellMutation.parse(request.body),
        ),
      );
    }),
  );

  if (capabilities.chat) {
    requireChatRuntime(runtime);
    router.get(
      "/tabular-review/:reviewId/chats",
      asyncRoute(async (request, response) => {
        safeJson(
          response,
          await runtime.listTabularChats(
            contextFor(request, options),
            idParam(request, "reviewId"),
          ),
        );
      }),
    );

    router.delete(
      "/tabular-review/:reviewId/chats/:chatId",
      asyncRoute(async (request, response) => {
        emptyBody(request.body);
        await runtime.deleteTabularChat(
          contextFor(request, options),
          idParam(request, "reviewId"),
          idParam(request, "chatId"),
        );
        response.status(204).send();
      }),
    );

    router.get(
      "/tabular-review/:reviewId/chats/:chatId/messages",
      asyncRoute(async (request, response) => {
        safeJson(
          response,
          await runtime.listTabularChatMessages(
            contextFor(request, options),
            idParam(request, "reviewId"),
            idParam(request, "chatId"),
          ),
        );
      }),
    );

    router.post(
      "/tabular-review/:reviewId/chat",
      asyncRoute(async (request, response) => {
        const controller = new AbortController();
        request.once("aborted", () => controller.abort());
        const sink = streamSink(response);
        await runtime.streamTabularChat(
          contextFor(request, options),
          idParam(request, "reviewId"),
          ChatRequest.parse(request.body),
          sink,
          controller.signal,
        );
        sink.done();
        response.end();
      }),
    );
  }

  router.get(
    "/tabular-review/:reviewId/export.:format",
    asyncRoute(async (request, response) => {
      const format = z.enum(["csv", "xlsx"]).parse(request.params.format);
      const download = await runtime.exportTabularReview(
        contextFor(request, options),
        idParam(request, "reviewId"),
        format,
      );
      sendDownload(response, download);
    }),
  );

  router.use(
    (
      error: unknown,
      _request: Request,
      response: Response,
      _next: NextFunction,
    ) => {
      if (response.headersSent) {
        response.end();
        return;
      }
      const payload = errorPayload(error);
      response.status(payload.status).json(payload.body);
    },
  );

  return router;
}
