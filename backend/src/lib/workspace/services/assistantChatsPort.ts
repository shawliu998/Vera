import { WorkspaceApiError } from "../errors";
import { WORKSPACE_LOCAL_PRINCIPAL_ID } from "../principal";
import type {
  WorkspaceChatsV1Context,
  WorkspaceChatsV1Port,
} from "../../../routes/workspaceChatsV1";
import type { ChatsService } from "./chats";

function requireLocal(context: WorkspaceChatsV1Context) {
  if (context.principalId !== WORKSPACE_LOCAL_PRINCIPAL_ID) {
    throw new WorkspaceApiError(
      403,
      "FORBIDDEN",
      "Workspace Chats are local-only.",
    );
  }
}

/**
 * The transport adapter for the existing ChatsService. It contains no chat,
 * generation, queue, or retrieval behavior of its own.
 */
export class WorkspaceChatsRuntimePort implements WorkspaceChatsV1Port {
  constructor(private readonly chats: ChatsService) {}

  async listChats(
    context: WorkspaceChatsV1Context,
    input: {
      projectId?: string | null;
      cursor?: string;
      limit?: number;
    },
  ) {
    requireLocal(context);
    return this.chats.list({
      projectId: input.projectId,
      cursor: input.cursor ?? null,
      limit: input.limit,
    });
  }

  async listProjectChats(context: WorkspaceChatsV1Context, projectId: string) {
    requireLocal(context);
    return this.chats.listProjectChats(projectId);
  }

  async createChat(
    context: WorkspaceChatsV1Context,
    input: {
      projectId: string | null;
      title?: string;
      modelProfileId?: string | null;
    },
  ) {
    requireLocal(context);
    return this.chats.create(input);
  }

  async getChatDetail(context: WorkspaceChatsV1Context, chatId: string) {
    requireLocal(context);
    return this.chats.detail(chatId);
  }

  async updateChat(
    context: WorkspaceChatsV1Context,
    chatId: string,
    input: { title: string },
  ) {
    requireLocal(context);
    return this.chats.update(chatId, input);
  }

  async deleteChat(context: WorkspaceChatsV1Context, chatId: string) {
    requireLocal(context);
    this.chats.delete(chatId);
  }

  async requestGeneration(
    context: WorkspaceChatsV1Context,
    input: {
      chatId: string;
      prompt: string;
      modelProfileId?: string;
      modelSelector?: string;
      allowedDocumentIds: readonly string[];
      attachmentDocumentIds: readonly string[];
    },
  ) {
    requireLocal(context);
    return this.chats.requestGeneration({
      ...input,
      allowedDocumentIds: [...input.allowedDocumentIds],
      attachmentDocumentIds: [...input.attachmentDocumentIds],
    });
  }

  async generationStatus(context: WorkspaceChatsV1Context, jobId: string) {
    requireLocal(context);
    return this.chats.generationStatus(jobId);
  }

  async listGenerationStatuses(
    context: WorkspaceChatsV1Context,
    chatId: string,
    limit?: number,
  ) {
    requireLocal(context);
    return this.chats.listGenerationStatuses(chatId, limit);
  }

  async generationEvents(
    context: WorkspaceChatsV1Context,
    jobId: string,
    input: { cursor?: number; limit?: number },
  ) {
    requireLocal(context);
    return this.chats.generationEvents(jobId, input);
  }

  async cancelGeneration(
    context: WorkspaceChatsV1Context,
    jobId: string,
    reason?: string | null,
  ) {
    requireLocal(context);
    return this.chats.cancelGeneration(jobId, reason);
  }

  async retryGeneration(context: WorkspaceChatsV1Context, jobId: string) {
    requireLocal(context);
    return this.chats.retryGeneration(jobId);
  }

  async regenerateGeneration(context: WorkspaceChatsV1Context, jobId: string) {
    requireLocal(context);
    return this.chats.regenerateGeneration(jobId);
  }
}
