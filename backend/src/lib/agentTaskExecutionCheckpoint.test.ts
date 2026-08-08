import assert from "node:assert/strict";
import test from "node:test";

import { recordAgentTaskExecutionCheckpoint } from "./agentTaskExecutionCheckpoint";

const input = {
  taskId: "11111111-1111-4111-8111-111111111111",
  userId: "user-1",
  leaseOwner: "lease-1",
  expectedTaskStatus: "running" as const,
  step: {
    id: "22222222-2222-4222-8222-222222222222",
    attempt: 2,
  },
  previousCheckpoint: {
    schema_version: "agent_task_checkpoint_v1",
    contract: { kind: "fixed-contract" },
    fixed_matter_context: { kind: "matter_context_v1" },
    execution_pause: { stale: true },
    runner_retry: { attempt: 1 },
    source_acquisition: { phase: "search_pending" },
  },
  summary: "Imported one selected source.",
  checkpointValues: {
    source_acquisition: { phase: "read_pending", imported: 1 },
  },
};

test("records progress under the exact Task lease while preserving immutable assignment state", async () => {
  let args: Record<string, unknown> | null = null;
  const db = {
    async rpc(_name: string, value: Record<string, unknown>) {
      args = value;
      return {
        data: [
          {
            outcome: "recorded",
            task_status: "running",
            current_step: input.step.id,
          },
        ],
        error: null,
      };
    },
  };
  const sourceDocumentIds = ["33333333-3333-4333-8333-333333333333"];
  assert.equal(
    await recordAgentTaskExecutionCheckpoint(db as never, {
      ...input,
      sourceDocumentIds,
    }),
    true,
  );
  assert.equal(args?.p_lease_owner, input.leaseOwner);
  assert.equal(args?.p_expected_step_attempt, input.step.attempt);
  assert.deepEqual(args?.p_source_document_ids, sourceDocumentIds);
  const checkpoint = args?.p_latest_checkpoint as Record<string, unknown>;
  assert.deepEqual(checkpoint.contract, input.previousCheckpoint.contract);
  assert.deepEqual(
    checkpoint.fixed_matter_context,
    input.previousCheckpoint.fixed_matter_context,
  );
  assert.deepEqual(
    checkpoint.source_acquisition,
    input.checkpointValues.source_acquisition,
  );
  assert.equal(Object.hasOwn(checkpoint, "execution_pause"), false);
  assert.equal(Object.hasOwn(checkpoint, "runner_retry"), false);
});

test("lease loss stops the caller without converting source work into a failed result", async () => {
  const db = {
    async rpc() {
      return {
        data: [
          {
            outcome: "lease_lost",
            task_status: "paused",
            current_step: input.step.id,
          },
        ],
        error: null,
      };
    },
  };
  assert.equal(
    await recordAgentTaskExecutionCheckpoint(db as never, input),
    false,
  );
});
