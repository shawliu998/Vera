import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentTaskArtifactReverificationError,
  startAgentTaskArtifactReverification,
} from "./artifactReverification";

const input = {
  taskId: "00000000-0000-4000-8000-000000000001",
  userId: "user-fixture",
  documentId: "00000000-0000-4000-8000-000000000002",
  baseVersionId: "00000000-0000-4000-8000-000000000003",
  versionId: "00000000-0000-4000-8000-000000000004",
  mutationId: "artifact-edit:00000000-0000-4000-8000-000000000004",
};

test("accepts a newly started or already committed re-verification", async () => {
  for (const outcome of ["started", "already_started"] as const) {
    const db = {
      async rpc() {
        return {
          data: [
            {
              outcome,
              task_status: "verifying",
              current_step: "verifier-step",
            },
          ],
          error: null,
        };
      },
    };
    const result = await startAgentTaskArtifactReverification(
      db as never,
      input,
    );
    assert.equal(result.outcome, outcome);
    assert.equal(result.currentStep, "verifier-step");
  }
});

test("preserves the structured reason when the verifier cannot restart", async () => {
  const db = {
    async rpc() {
      return {
        data: [
          {
            outcome: "verifier_invalid",
            task_status: "completed",
            current_step: null,
          },
        ],
        error: null,
      };
    },
  };
  await assert.rejects(
    startAgentTaskArtifactReverification(db as never, input),
    (error: unknown) =>
      error instanceof AgentTaskArtifactReverificationError &&
      error.outcome === "verifier_invalid" &&
      /Version was preserved/.test(error.message),
  );
});
