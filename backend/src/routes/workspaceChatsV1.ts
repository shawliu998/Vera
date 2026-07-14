import {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { z, ZodError } from "zod";

import {
  MikeChatListQuerySchema,
  MikeCreateChatRequestSchema,
  MikeUpdateChatRequestSchema,
  toMikeChat,
  toMikeChatDetail,
} from "../lib/workspace/assistantCompatibility";
import { WorkspaceApiError } from "../lib/workspace/errors";
import { assertMikeSafePayload } from "../lib/workspace/mikeCompatibility";
import { WORKSPACE_LOCAL_PRINCIPAL_ID } from "../lib/workspace/principal";
import type { Chat } from "../lib/workspace/types";
import type { ChatsService } from "../lib/workspace/services/chats";

const Id = z.string().uuid();

type HydratedDetail = ReturnType<ChatsService["detail"]>;

export type WorkspaceChatsV1Context = Readonly<{ principalId: string }>;

export interface WorkspaceChatsV1Port {
  listChats(
    context: WorkspaceChatsV1Context,
    input: {
      projectId?: string | null;
      cursor?: string;
      limit?: number;
    },
  ): Promise<{ items: readonly Chat[]; nextCursor?: string | null }>;
  listProjectChats(
    context: WorkspaceChatsV1Context,
    projectId: string,
  ): Promise<readonly Chat[]>;
  createChat(
    context: WorkspaceChatsV1Context,
    input: {
      projectId: string | null;
      title?: string;
      modelProfileId?: string | null;
    },
  ): Promise<Chat>;
  getChatDetail(
    context: WorkspaceChatsV1Context,
    chatId: string,
  ): Promise<HydratedDetail>;
  updateChat(
    context: WorkspaceChatsV1Context,
    chatId: string,
    input: { title: string },
  ): Promise<Chat>;
  deleteChat(context: WorkspaceChatsV1Context, chatId: string): Promise<void>;
}

export type WorkspaceChatsV1Options = Readonly<{
  context?: (
    request: Request,
    response: Response,
  ) => WorkspaceChatsV1Context | null;
}>;

function localContext(
  request: Request,
  response: Response,
  options: WorkspaceChatsV1Options,
): WorkspaceChatsV1Context {
  const context = options.context
    ? options.context(request, response)
    : typeof response.locals.userId === "string"
      ? { principalId: response.locals.userId }
      : null;
  if (!context || typeof context.principalId !== "string") {
    throw new WorkspaceApiError(
      401,
      "UNAUTHORIZED",
      "Workspace authentication context is required.",
    );
  }
  if (context.principalId !== WORKSPACE_LOCAL_PRINCIPAL_ID) {
    throw new WorkspaceApiError(
      403,
      "FORBIDDEN",
      "Workspace Chats are local-only.",
    );
  }
  return { principalId: WORKSPACE_LOCAL_PRINCIPAL_ID };
}

function safeJson(response: Response, value: unknown, status = 200) {
  assertMikeSafePayload(value);
  response.status(status).json(value);
}

function idParam(request: Request, name: string) {
  return Id.parse(request.params[name]);
}

function asyncRoute(
  handler: (request: Request, response: Response) => Promise<void>,
) {
  return (request: Request, response: Response, next: NextFunction) => {
    void handler(request, response).catch(next);
  };
}

export function createWorkspaceChatsV1Router(
  port: WorkspaceChatsV1Port,
  options: WorkspaceChatsV1Options = {},
) {
  const router = Router();

  router.get(
    "/chat",
    asyncRoute(async (request, response) => {
      const context = localContext(request, response, options);
      const query = MikeChatListQuerySchema.parse(request.query);
      const page = await port.listChats(context, {
        projectId: query.project_id,
        cursor: query.cursor,
        limit: query.limit,
      });
      safeJson(response, page.items.map(toMikeChat));
    }),
  );

  router.get(
    "/projects/:projectId/chats",
    asyncRoute(async (request, response) => {
      const context = localContext(request, response, options);
      const projectId = idParam(request, "projectId");
      const chats = await port.listProjectChats(context, projectId);
      safeJson(response, chats.map(toMikeChat));
    }),
  );

  router.post(
    "/chat/create",
    asyncRoute(async (request, response) => {
      const context = localContext(request, response, options);
      const input = MikeCreateChatRequestSchema.parse(request.body);
      const created = await port.createChat(context, {
        projectId: input.project_id ?? null,
        title: input.title,
        modelProfileId: input.model_profile_id,
      });
      safeJson(response, { id: created.id }, 201);
    }),
  );

  router.get(
    "/chat/:chatId",
    asyncRoute(async (request, response) => {
      const context = localContext(request, response, options);
      const detail = await port.getChatDetail(
        context,
        idParam(request, "chatId"),
      );
      safeJson(response, toMikeChatDetail(detail));
    }),
  );

  router.patch(
    "/chat/:chatId",
    asyncRoute(async (request, response) => {
      const context = localContext(request, response, options);
      const input = MikeUpdateChatRequestSchema.parse(request.body);
      await port.updateChat(context, idParam(request, "chatId"), input);
      response.status(204).end();
    }),
  );

  router.delete(
    "/chat/:chatId",
    asyncRoute(async (request, response) => {
      const context = localContext(request, response, options);
      await port.deleteChat(context, idParam(request, "chatId"));
      response.status(204).end();
    }),
  );

  // Generation, title generation, reasoning, tool events, and SSE are
  // intentionally absent. They may only return behind one audited typed bundle
  // providing durable replay/outbox, terminal events, and final citations.

  router.use(
    (
      error: unknown,
      _request: Request,
      response: Response,
      next: NextFunction,
    ) => {
      if (response.headersSent) return next(error);
      if (error instanceof ZodError) {
        response.status(422).json({
          detail: "Request validation failed.",
          code: "VALIDATION_ERROR",
          error: {
            code: "VALIDATION_ERROR",
            message: "Request validation failed.",
            retryable: false,
          },
        });
        return;
      }
      if (error instanceof WorkspaceApiError) {
        response.status(error.status).json({
          detail: error.message,
          code: error.code,
          error: {
            code: error.code,
            message: error.message,
            retryable: false,
          },
        });
        return;
      }
      response.status(500).json({
        detail: "Assistant request failed.",
        code: "INTERNAL_ERROR",
        error: {
          code: "INTERNAL_ERROR",
          message: "Assistant request failed.",
          retryable: false,
        },
      });
    },
  );

  return router;
}
