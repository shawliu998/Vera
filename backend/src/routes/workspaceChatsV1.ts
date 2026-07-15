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
  MikeGenerationAcceptedSchema,
  MikeGenerationControlSchema,
  MikeGenerationReplaySchema,
  MikeGenerationStatusSchema,
  MikeUpdateChatRequestSchema,
  parseMikeChatGeneration,
  parseMikeProjectChatGeneration,
  toMikeChat,
  toMikeChatDetail,
} from "../lib/workspace/assistantCompatibility";
import { WorkspaceApiError } from "../lib/workspace/errors";
import { assertMikeSafePayload } from "../lib/workspace/mikeCompatibility";
import { WORKSPACE_LOCAL_PRINCIPAL_ID } from "../lib/workspace/principal";
import type { Chat } from "../lib/workspace/types";
import type { ChatsService } from "../lib/workspace/services/chats";
import type {
  AssistantGenerationEventPage,
  AssistantGenerationStatus,
} from "../lib/workspace/repositories/chats";

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
  requestGeneration?(
    context: WorkspaceChatsV1Context,
    input: {
      chatId: string;
      prompt: string;
      modelProfileId?: string;
      modelSelector?: string;
      allowedDocumentIds: readonly string[];
      attachmentDocumentIds: readonly string[];
    },
  ): Promise<{
    chatId: string;
    jobId: string;
    promptMessageId: string;
    outputMessageId: string;
    status: "queued";
  }>;
  generationStatus?(
    context: WorkspaceChatsV1Context,
    jobId: string,
  ): Promise<AssistantGenerationStatus>;
  listGenerationStatuses?(
    context: WorkspaceChatsV1Context,
    chatId: string,
    limit?: number,
  ): Promise<readonly AssistantGenerationStatus[]>;
  generationEvents?(
    context: WorkspaceChatsV1Context,
    jobId: string,
    input: { cursor?: number; limit?: number },
  ): Promise<AssistantGenerationEventPage>;
  cancelGeneration?(
    context: WorkspaceChatsV1Context,
    jobId: string,
    reason?: string | null,
  ): Promise<AssistantGenerationStatus>;
  retryGeneration?(
    context: WorkspaceChatsV1Context,
    jobId: string,
  ): Promise<{
    chatId: string;
    jobId: string;
    promptMessageId: string;
    outputMessageId: string;
    status: "queued";
  }>;
  regenerateGeneration?(
    context: WorkspaceChatsV1Context,
    jobId: string,
  ): Promise<{
    chatId: string;
    jobId: string;
    promptMessageId: string;
    outputMessageId: string;
    status: "queued";
  }>;
}

export type WorkspaceChatsV1Options = Readonly<{
  context?: (
    request: Request,
    response: Response,
  ) => WorkspaceChatsV1Context | null;
  capabilities?: Readonly<{ generation?: boolean }>;
}>;

const Cursor = z.coerce.number().int().min(0).max(2_147_483_647);
const EventLimit = z.coerce.number().int().min(1).max(100);
const GenerationListQuery = z
  .object({
    chat_id: Id,
    limit: z.coerce.number().int().min(1).max(20).optional(),
  })
  .strict();
const GenerationEventQuery = z
  .object({ cursor: Cursor.optional(), limit: EventLimit.optional() })
  .strict();
const CancelGenerationBody = z
  .object({ reason: z.string().trim().min(1).max(500).optional() })
  .strict();
const EmptyBody = z.object({}).strict();

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

type GenerationPort = WorkspaceChatsV1Port &
  Required<
    Pick<
      WorkspaceChatsV1Port,
      | "requestGeneration"
      | "generationStatus"
      | "listGenerationStatuses"
      | "generationEvents"
      | "cancelGeneration"
      | "retryGeneration"
      | "regenerateGeneration"
    >
  >;

function requireGenerationPort(
  port: WorkspaceChatsV1Port,
): asserts port is GenerationPort {
  for (const method of [
    "requestGeneration",
    "generationStatus",
    "listGenerationStatuses",
    "generationEvents",
    "cancelGeneration",
    "retryGeneration",
    "regenerateGeneration",
  ] as const) {
    if (typeof port[method] !== "function") {
      throw new Error(
        "Assistant generation capability requires the complete durable generation port.",
      );
    }
  }
}

function toGenerationStatus(status: AssistantGenerationStatus) {
  return MikeGenerationStatusSchema.parse({
    job_id: status.jobId,
    chat_id: status.chatId,
    prompt_message_id: status.promptMessageId,
    output_message_id: status.outputMessageId,
    status: status.status,
    attempt: status.attempt,
    active_attempt: status.activeAttempt,
    max_attempts: status.maxAttempts,
    retryable: status.retryable,
    cancel_requested: status.cancelRequested,
    terminal: status.terminal,
  });
}

function toGenerationAccepted(input: {
  chatId: string;
  jobId: string;
  promptMessageId: string;
  outputMessageId: string;
  status: "queued";
}) {
  return MikeGenerationAcceptedSchema.parse({
    chat_id: input.chatId,
    job_id: input.jobId,
    prompt_message_id: input.promptMessageId,
    output_message_id: input.outputMessageId,
    status: input.status,
  });
}

function toGenerationReplay(page: AssistantGenerationEventPage) {
  return MikeGenerationReplaySchema.parse({
    job_id: page.jobId,
    status: page.status,
    attempt: page.attempt,
    terminal: page.terminal,
    events: page.events.map((record) => ({
      cursor: record.cursor,
      attempt: record.attempt,
      event: record.event,
      terminal: record.terminal,
      created_at: record.createdAt,
    })),
    next_cursor: page.nextCursor,
  });
}

function generationControl(status: AssistantGenerationStatus) {
  return MikeGenerationControlSchema.parse({
    job_id: status.jobId,
    status: status.status,
    cancel_requested: status.cancelRequested,
    terminal: status.terminal,
  });
}

function parseLastEventId(request: Request, queryCursor?: number) {
  const raw = request.get("Last-Event-ID");
  if (raw === undefined) return queryCursor ?? 0;
  if (!/^(0|[1-9]\d{0,9})$/.test(raw)) {
    throw new WorkspaceApiError(
      400,
      "VALIDATION_ERROR",
      "Last-Event-ID must be a decimal Assistant event cursor.",
    );
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed > 2_147_483_647) {
    throw new WorkspaceApiError(
      400,
      "VALIDATION_ERROR",
      "Last-Event-ID is outside the Assistant event cursor range.",
    );
  }
  if (queryCursor !== undefined && queryCursor !== parsed) {
    throw new WorkspaceApiError(
      400,
      "VALIDATION_ERROR",
      "Assistant event cursor sources disagree.",
    );
  }
  return parsed;
}

function wantsEventStream(request: Request) {
  return (request.get("Accept") ?? "")
    .split(",")
    .some((value) => value.trim().split(";", 1)[0] === "text/event-stream");
}

function waitForReplayPoll(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function waitForResponseDrainOrClose(response: Response) {
  if (response.destroyed || response.writableEnded) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const finish = () => {
      response.off("drain", finish);
      response.off("close", finish);
      response.off("error", finish);
      resolve();
    };
    response.once("drain", finish);
    response.once("close", finish);
    response.once("error", finish);
  });
}

export function createWorkspaceChatsV1Router(
  port: WorkspaceChatsV1Port,
  options: WorkspaceChatsV1Options = {},
) {
  const router = Router();
  const generationEnabled = options.capabilities?.generation === true;
  if (generationEnabled) requireGenerationPort(port);

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

  if (generationEnabled) {
    const generationPort = port as GenerationPort;

    const submit = async (
      context: WorkspaceChatsV1Context,
      normalized: ReturnType<typeof parseMikeChatGeneration>,
      requiredProjectId?: string,
    ) => {
      let chatId = normalized.chatId;
      if (chatId) {
        const detail = await generationPort.getChatDetail(context, chatId);
        if (
          (requiredProjectId !== undefined &&
            detail.chat.projectId !== requiredProjectId) ||
          (normalized.projectId !== null &&
            detail.chat.projectId !== normalized.projectId)
        ) {
          throw new WorkspaceApiError(
            409,
            "CONFLICT",
            "Assistant chat does not belong to the requested project.",
          );
        }
      } else {
        const projectId = requiredProjectId ?? normalized.projectId;
        const created = await generationPort.createChat(context, {
          projectId,
          modelProfileId: normalized.modelProfileId,
        });
        chatId = created.id;
      }
      return generationPort.requestGeneration(context, {
        chatId,
        prompt: normalized.prompt,
        ...(normalized.modelProfileId
          ? { modelProfileId: normalized.modelProfileId }
          : {}),
        ...(normalized.modelSelector
          ? { modelSelector: normalized.modelSelector }
          : {}),
        allowedDocumentIds: normalized.allowedDocumentIds,
        attachmentDocumentIds: normalized.attachmentDocumentIds,
      });
    };

    router.post(
      "/chat",
      asyncRoute(async (request, response) => {
        const context = localContext(request, response, options);
        const accepted = await submit(
          context,
          parseMikeChatGeneration(request.body),
        );
        response.set(
          "Location",
          `/api/v1/assistant/jobs/${accepted.jobId}/events`,
        );
        safeJson(response, toGenerationAccepted(accepted), 202);
      }),
    );

    router.post(
      "/projects/:projectId/chat",
      asyncRoute(async (request, response) => {
        const context = localContext(request, response, options);
        const projectId = idParam(request, "projectId");
        const accepted = await submit(
          context,
          parseMikeProjectChatGeneration(projectId, request.body),
          projectId,
        );
        response.set(
          "Location",
          `/api/v1/assistant/jobs/${accepted.jobId}/events`,
        );
        safeJson(response, toGenerationAccepted(accepted), 202);
      }),
    );

    router.get(
      "/assistant/jobs",
      asyncRoute(async (request, response) => {
        const context = localContext(request, response, options);
        const query = GenerationListQuery.parse(request.query);
        const statuses = await generationPort.listGenerationStatuses(
          context,
          query.chat_id,
          query.limit,
        );
        safeJson(response, {
          items: statuses.map(toGenerationStatus),
        });
      }),
    );

    router.get(
      "/assistant/jobs/:jobId",
      asyncRoute(async (request, response) => {
        const context = localContext(request, response, options);
        const status = await generationPort.generationStatus(
          context,
          idParam(request, "jobId"),
        );
        safeJson(response, toGenerationStatus(status));
      }),
    );

    router.get(
      "/assistant/jobs/:jobId/events",
      asyncRoute(async (request, response) => {
        const context = localContext(request, response, options);
        const jobId = idParam(request, "jobId");
        const query = GenerationEventQuery.parse(request.query);
        let cursor = parseLastEventId(request, query.cursor);
        if (!wantsEventStream(request)) {
          const page = await generationPort.generationEvents(context, jobId, {
            cursor,
            limit: query.limit,
          });
          safeJson(response, toGenerationReplay(page));
          return;
        }

        response.set({
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-store",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
          "X-Content-Type-Options": "nosniff",
        });
        response.flushHeaders?.();
        let disconnected = false;
        response.once("close", () => {
          disconnected = true;
        });
        const deadline = Date.now() + 30_000;
        let lastHeartbeat = Date.now();
        while (!disconnected && Date.now() < deadline) {
          const page = await generationPort.generationEvents(context, jobId, {
            cursor,
            limit: query.limit,
          });
          let terminalDelivered = false;
          for (const record of page.events) {
            if (disconnected) break;
            const frame = `id: ${record.cursor}\ndata: ${JSON.stringify(record.event)}\n\n`;
            if (!response.write(frame)) {
              await waitForResponseDrainOrClose(response);
            }
            cursor = record.cursor;
            terminalDelivered ||= record.terminal;
          }
          if (
            !disconnected &&
            (terminalDelivered || (page.terminal && page.events.length === 0))
          ) {
            response.write("data: [DONE]\n\n");
            response.end();
            return;
          }
          if (page.events.length > 0) continue;
          if (Date.now() - lastHeartbeat >= 15_000) {
            if (!response.write(": keep-alive\n\n")) {
              await waitForResponseDrainOrClose(response);
            }
            lastHeartbeat = Date.now();
          }
          await waitForReplayPoll(150);
        }
        if (!response.writableEnded) response.end();
      }),
    );

    router.post(
      "/assistant/jobs/:jobId/cancel",
      asyncRoute(async (request, response) => {
        const context = localContext(request, response, options);
        const body = CancelGenerationBody.parse(request.body ?? {});
        const status = await generationPort.cancelGeneration(
          context,
          idParam(request, "jobId"),
          body.reason,
        );
        safeJson(response, generationControl(status), status.terminal ? 200 : 202);
      }),
    );

    router.post(
      "/assistant/jobs/:jobId/retry",
      asyncRoute(async (request, response) => {
        const context = localContext(request, response, options);
        EmptyBody.parse(request.body ?? {});
        const accepted = await generationPort.retryGeneration(
          context,
          idParam(request, "jobId"),
        );
        response.set(
          "Location",
          `/api/v1/assistant/jobs/${accepted.jobId}/events`,
        );
        safeJson(response, toGenerationAccepted(accepted), 202);
      }),
    );

    router.post(
      "/assistant/jobs/:jobId/regenerate",
      asyncRoute(async (request, response) => {
        const context = localContext(request, response, options);
        EmptyBody.parse(request.body ?? {});
        const accepted = await generationPort.regenerateGeneration(
          context,
          idParam(request, "jobId"),
        );
        response.set(
          "Location",
          `/api/v1/assistant/jobs/${accepted.jobId}/events`,
        );
        safeJson(response, toGenerationAccepted(accepted), 202);
      }),
    );
  }

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
