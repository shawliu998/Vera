import assert from "node:assert/strict";
import test from "node:test";

import { buildWordDocumentReviewPrompt } from "./wordSuggestion";
import { buildWordMemoTaskBoundStreamRequest } from "./wordMemoTaskRequest";

const binding = {
  taskId: "task-1",
  projectId: "matter-1",
  executionChatId: "execution-chat-1",
  memoDocumentId: "memo-document-1",
  memoVersionId: "memo-version-7",
};

test("every Task-bound segment and retry uses one exact identity-only payload", () => {
  const controller = new AbortController();
  const prompts = ["Clause in segment zero.", "Clause in segment one."].map(
    (documentText, segmentIndex) =>
      buildWordDocumentReviewPrompt({
        mode: "review",
        instruction: "Apply the fixed Task source.",
        documentText,
        paragraphStart: segmentIndex,
        segmentIndex,
        segmentCount: 2,
        reviewStandard: { filename: "Fixed Source.docx" },
      }),
  );

  const attempts = [
    { segment: 0, retry: 0 },
    { segment: 0, retry: 1 },
    { segment: 1, retry: 0 },
    { segment: 1, retry: 1 },
    { segment: 1, retry: 2 },
  ].map(({ segment, retry }) => ({
    segment,
    retry,
    request: buildWordMemoTaskBoundStreamRequest({
      binding,
      prompt: prompts[segment],
      signal: controller.signal,
    }),
  }));

  for (const { segment, request } of attempts) {
    assert.deepEqual(Object.keys(request).sort(), [
      "agent_task_id",
      "chat_id",
      "memo_document_id",
      "memo_version_id",
      "messages",
      "projectId",
      "signal",
    ]);
    assert.deepEqual(request, {
      projectId: "matter-1",
      messages: [
        {
          role: "user",
          content: prompts[segment],
        },
      ],
      agent_task_id: "task-1",
      chat_id: "execution-chat-1",
      memo_document_id: "memo-document-1",
      memo_version_id: "memo-version-7",
      signal: controller.signal,
    });
    assert.doesNotMatch(request.messages[0].content, /review_run_id=/);
    assert.doesNotMatch(request.messages[0].content, /task-1/);
    assert.doesNotMatch(request.messages[0].content, /execution-chat-1/);
    assert.doesNotMatch(request.messages[0].content, /memo-document-1/);
    assert.doesNotMatch(request.messages[0].content, /memo-version-7/);
    assert.equal("model" in request, false);
    assert.equal("attached_documents" in request, false);
    assert.equal("displayed_doc" in request, false);
    assert.equal("files" in request.messages[0], false);
    assert.equal("workflow" in request.messages[0], false);
  }

  assert.equal(attempts[0].request.messages[0].content, prompts[0]);
  assert.equal(attempts[1].request.messages[0].content, prompts[0]);
  assert.equal(attempts[2].request.messages[0].content, prompts[1]);
  assert.equal(attempts[3].request.messages[0].content, prompts[1]);
  assert.equal(attempts[4].request.messages[0].content, prompts[1]);
});
