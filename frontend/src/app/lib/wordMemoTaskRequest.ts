import type { WordMemoTaskBinding } from "./wordMemoTaskBinding";

type WordMemoTaskRequestBinding = Pick<
  WordMemoTaskBinding,
  | "taskId"
  | "projectId"
  | "executionChatId"
  | "memoDocumentId"
  | "memoVersionId"
>;

export type WordMemoTaskBoundStreamRequest = {
  projectId: string;
  messages: [{ role: "user"; content: string }];
  agent_task_id: string;
  chat_id: string;
  memo_document_id: string;
  memo_version_id: string;
  signal: AbortSignal;
};

/**
 * Builds the only request shape allowed for Task-bound Word generation.
 *
 * The exact return type deliberately has no model, files, attachments,
 * displayed document, or workflow fields. Every segment and retry rebuilds
 * this same server-owned identity envelope around its persisted prompt.
 */
export function buildWordMemoTaskBoundStreamRequest(input: {
  binding: WordMemoTaskRequestBinding;
  prompt: string;
  signal: AbortSignal;
}): WordMemoTaskBoundStreamRequest {
  return {
    projectId: input.binding.projectId,
    messages: [{ role: "user", content: input.prompt }],
    agent_task_id: input.binding.taskId,
    chat_id: input.binding.executionChatId,
    memo_document_id: input.binding.memoDocumentId,
    memo_version_id: input.binding.memoVersionId,
    signal: input.signal,
  };
}
