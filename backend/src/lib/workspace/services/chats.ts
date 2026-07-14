import { randomUUID } from "node:crypto";

import {
  AssistantGenerationInputSchema,
  type AssistantHydratedCapability,
} from "../assistantCompatibility";
import {
  CreateChatMessageRequestSchema,
  CreateChatRequestSchema,
  UpdateChatRequestSchema,
} from "../contracts";
import { WorkspaceApiError } from "../errors";
import { assertMikeSafePayload } from "../mikeCompatibility";
import {
  ChatsRepository,
  type AssistantJobEnqueuerPort,
  type AssistantSourceLocator,
  type AssistantCitationMetadata,
} from "../repositories/chats";
import { ModelProfilesRepository } from "../repositories/modelProfiles";
import { ProjectsRepository } from "../repositories/projects";

export interface AssistantCapabilityHydratorPort {
  hydrate(input: {
    documentId: string;
    versionId: string;
  }): AssistantHydratedCapability;
}
export interface ChatResourceLifecyclePort {
  cancelQueued(jobIds: readonly string[]): void;
  requestAbortRunning(jobIds: readonly string[]): void;
}

export type ChatsServiceOptions = Readonly<{
  jobs?: AssistantJobEnqueuerPort;
  capabilities?: AssistantCapabilityHydratorPort;
  lifecycle?: ChatResourceLifecyclePort;
  createId?: () => string;
}>;

export class ChatsService {
  constructor(
    private readonly chats: ChatsRepository,
    private readonly projects: ProjectsRepository,
    private readonly profiles: ModelProfilesRepository,
    private readonly clock: () => Date = () => new Date(),
    private readonly options: ChatsServiceOptions = {},
  ) {}

  private now() {
    return this.clock().toISOString();
  }

  private createId() {
    return (this.options.createId ?? randomUUID)();
  }

  list(input?: {
    projectId?: string | null;
    status?: "active" | "archived";
    cursor?: string | null;
    limit?: number;
  }) {
    return this.chats.list(input);
  }

  listProjectChats(projectId: string) {
    this.projects.requireActive(projectId);
    return this.chats.listProjectChats(projectId);
  }

  get(id: string) {
    return this.chats.require(id);
  }

  detail(id: string) {
    const detail = this.chats.detail(id);
    return {
      chat: detail.chat,
      messages: detail.messages.map((message) => ({
        ...message,
        attachments: message.attachments.map((attachment) => {
          if (!this.options.capabilities) {
            throw new WorkspaceApiError(
              503,
              "PRECONDITION_FAILED",
              "Document capability hydration is not configured.",
            );
          }
          let capability: AssistantHydratedCapability;
          try {
            capability = this.options.capabilities.hydrate({
              documentId: attachment.documentId,
              versionId: attachment.versionId,
            });
          } catch {
            throw new WorkspaceApiError(
              503,
              "PRECONDITION_FAILED",
              "Document capability hydration failed.",
            );
          }
          return { ...attachment, capability };
        }),
      })),
    };
  }

  create(value: unknown) {
    const input = CreateChatRequestSchema.parse(value);
    const projectId = input.projectId ?? null;
    if (projectId) this.projects.requireActive(projectId);
    if (input.modelProfileId) {
      this.profiles.requireEnabled(input.modelProfileId);
    }
    return this.chats.create({
      id: this.createId(),
      projectId,
      title: input.title ?? "新对话",
      modelProfileId: input.modelProfileId ?? null,
      now: this.now(),
    });
  }

  update(id: string, value: unknown) {
    const input = UpdateChatRequestSchema.parse(value);
    if (input.modelProfileId) {
      this.profiles.requireEnabled(input.modelProfileId);
    }
    return this.chats.update(id, { ...input, now: this.now() });
  }

  archive(id: string) {
    return this.chats.update(id, { status: "archived", now: this.now() });
  }

  delete(id: string) {
    const jobs = this.chats.activeJobsForChat(id);
    if (jobs.length > 0 && !this.options.lifecycle) {
      throw new WorkspaceApiError(
        409,
        "PRECONDITION_FAILED",
        "Chat generation jobs must be cancelled before deletion.",
      );
    }
    if (jobs.length > 0) {
      try {
        this.options.lifecycle!.cancelQueued(
          jobs.filter((job) => job.status === "queued").map((job) => job.id),
        );
        this.options.lifecycle!.requestAbortRunning(
          jobs.filter((job) => job.status === "running").map((job) => job.id),
        );
      } catch {
        throw new WorkspaceApiError(
          409,
          "CONFLICT",
          "Chat generation job cancellation failed.",
        );
      }
    }
    this.chats.delete(id);
  }

  addMessage(
    chatId: string,
    role: "system" | "user" | "assistant" | "tool",
    value: unknown,
  ) {
    const input = CreateChatMessageRequestSchema.parse(value);
    if (input.modelProfileId) {
      this.profiles.requireEnabled(input.modelProfileId);
    }
    return this.chats.createMessage({
      id: this.createId(),
      chatId,
      role,
      content: input.content,
      modelProfileId: input.modelProfileId ?? null,
      now: this.now(),
    });
  }

  updateMessage(
    id: string,
    status:
      | "pending"
      | "streaming"
      | "complete"
      | "failed"
      | "cancelled"
      | "interrupted",
    content?: string,
  ) {
    return this.chats.updateMessage(id, { status, content, now: this.now() });
  }

  messages(chatId: string) {
    return this.chats.messages(chatId);
  }

  sources(messageId: string) {
    return this.chats.sources(messageId);
  }

  addSource(
    messageId: string,
    input: {
      documentId: string;
      versionId: string;
      chunkId?: string | null;
      quote?: string | null;
      startOffset?: number | null;
      endOffset?: number | null;
      locator?: AssistantSourceLocator;
      rank?: number | null;
      score?: number | null;
      citationOrdinal?: number;
      citationMetadata?: AssistantCitationMetadata;
    },
  ) {
    return this.chats.addSource({
      id: this.createId(),
      messageId,
      documentId: input.documentId,
      versionId: input.versionId,
      chunkId: input.chunkId ?? null,
      quote: input.quote ?? null,
      startOffset: input.startOffset ?? null,
      endOffset: input.endOffset ?? null,
      locator: input.locator ?? {},
      rank: input.rank ?? null,
      score: input.score ?? null,
      citationOrdinal: input.citationOrdinal ?? 0,
      citationMetadata: input.citationMetadata ?? {},
      now: this.now(),
    });
  }

  private resolveModelProfile(input: {
    chatId: string;
    modelProfileId?: string;
    modelSelector?: string;
  }) {
    if (input.modelProfileId) {
      return this.profiles.requireEnabled(input.modelProfileId).id;
    }
    if (input.modelSelector) {
      const matches = this.profiles
        .list()
        .filter(
          (profile) =>
            profile.enabled &&
            (profile.id === input.modelSelector ||
              profile.name === input.modelSelector ||
              profile.model === input.modelSelector),
        );
      if (matches.length !== 1) {
        throw new WorkspaceApiError(
          409,
          "PRECONDITION_FAILED",
          "The requested model does not resolve to one enabled profile.",
        );
      }
      return matches[0].id;
    }
    const resolved = this.chats.resolveModelProfileId(input.chatId);
    if (!resolved) {
      throw new WorkspaceApiError(
        409,
        "PRECONDITION_FAILED",
        "An enabled model profile is required before generation.",
      );
    }
    return this.profiles.requireEnabled(resolved).id;
  }

  requestGeneration(value: unknown) {
    const input = AssistantGenerationInputSchema.parse(value);
    try {
      assertMikeSafePayload(input.prompt);
    } catch {
      throw new WorkspaceApiError(
        400,
        "VALIDATION_ERROR",
        "Assistant prompt contains unsafe credential or path material.",
      );
    }
    if (!this.options.jobs) {
      throw new WorkspaceApiError(
        503,
        "PRECONDITION_FAILED",
        "Assistant job enqueueing is not configured.",
      );
    }
    const chat = this.chats.require(input.chatId);
    if (chat.projectId) this.projects.requireActive(chat.projectId);
    this.chats.assertNoActiveGeneration(input.chatId);
    const modelProfileId = this.resolveModelProfile({
      chatId: input.chatId,
      modelProfileId: input.modelProfileId,
      modelSelector: input.modelSelector,
    });
    const now = this.now();
    const created = this.chats.createGeneration({
      chatId: input.chatId,
      promptMessageId: this.createId(),
      outputMessageId: this.createId(),
      jobId: this.createId(),
      modelProfileId,
      prompt: input.prompt,
      allowedDocumentIds: input.allowedDocumentIds,
      attachments: input.attachmentDocumentIds.map((documentId) => ({
        documentId,
        attachmentId: this.createId(),
      })),
      retrievalLimit: input.retrievalLimit,
      maxAttempts: 3,
      now,
      jobs: this.options.jobs,
    });
    return {
      chatId: input.chatId,
      jobId: created.jobId,
      promptMessageId: created.promptMessage.id,
      outputMessageId: created.outputMessage.id,
      status: "queued" as const,
    };
  }
}
