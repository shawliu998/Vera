import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAgentStepEffectReservation,
  canonicalEffectInput,
  commitAgentStepEffect,
  readAgentStepEffectReceipts,
  reserveAgentStepEffect,
} from "./stepEffect";

type Step = {
  id: string;
  task_id: string;
  status: string;
  result_data: Record<string, unknown> | null;
  updated_at: string;
};

function fakeDb(step: Step) {
  return {
    from(table: string) {
      assert.equal(table, "agent_steps");
      const filters: Record<string, unknown> = {};
      let update: Record<string, unknown> | null = null;
      const query = {
        select() {
          return query;
        },
        update(value: Record<string, unknown>) {
          update = structuredClone(value);
          return query;
        },
        eq(column: string, value: unknown) {
          filters[column] = value;
          return query;
        },
        async maybeSingle() {
          const matches = Object.entries(filters).every(
            ([column, value]) => step[column as keyof Step] === value,
          );
          if (!matches) return { data: null, error: null };
          if (update) Object.assign(step, structuredClone(update));
          return { data: structuredClone(step), error: null };
        },
      };
      return query;
    },
  };
}

test("canonical effect input ignores object key order", () => {
  assert.equal(
    canonicalEffectInput({ b: 2, a: [{ y: false, x: true }] }),
    canonicalEffectInput({ a: [{ x: true, y: false }], b: 2 }),
  );
});

test("effect reservation and commit reuse one deterministic target", async () => {
  const step: Step = {
    id: "5ff7fb82-3aa5-49ba-89af-b7086a0f7031",
    task_id: "f997716e-5311-4404-80bb-498767b56425",
    status: "running",
    result_data: null,
    updated_at: "2026-08-07T00:00:00.000Z",
  };
  const db = fakeDb(step);
  const receipt = buildAgentStepEffectReservation({
    stepId: step.id,
    attempt: 1,
    toolName: "generate_docx",
    toolInput: { title: "Memo", sections: [] },
    createdAt: "2026-08-07T00:00:00.000Z",
  });
  assert.deepEqual(
    await reserveAgentStepEffect(db as never, {
      taskId: step.task_id,
      receipt,
    }),
    receipt,
  );
  assert.deepEqual(
    await reserveAgentStepEffect(db as never, {
      taskId: step.task_id,
      receipt,
    }),
    receipt,
  );
  await assert.rejects(
    reserveAgentStepEffect(db as never, {
      taskId: step.task_id,
      receipt: buildAgentStepEffectReservation({
        stepId: step.id,
        attempt: 1,
        toolName: "generate_docx",
        toolInput: { title: "Different memo", sections: [] },
      }),
    }),
    /different input/,
  );
  const committed = await commitAgentStepEffect(db as never, {
    taskId: step.task_id,
    receipt,
    artifactType: "draft",
    documentId: receipt.target.document_id,
    versionId: receipt.target.version_id,
    committedAt: "2026-08-07T00:01:00.000Z",
  });
  assert.equal(committed.status, "committed");
  assert.deepEqual(readAgentStepEffectReceipts(step.result_data), [committed]);
  assert.deepEqual(
    await commitAgentStepEffect(db as never, {
      taskId: step.task_id,
      receipt,
      artifactType: "draft",
      documentId: receipt.target.document_id,
      versionId: receipt.target.version_id,
    }),
    committed,
  );
});

test("commit rejects an Artifact outside the reserved identity", async () => {
  const step: Step = {
    id: "5ff7fb82-3aa5-49ba-89af-b7086a0f7031",
    task_id: "f997716e-5311-4404-80bb-498767b56425",
    status: "running",
    result_data: null,
    updated_at: "2026-08-07T00:00:00.000Z",
  };
  const db = fakeDb(step);
  const receipt = buildAgentStepEffectReservation({
    stepId: step.id,
    attempt: 1,
    toolName: "generate_excel",
    toolInput: { title: "Matrix", sheets: [] },
  });
  await reserveAgentStepEffect(db as never, {
    taskId: step.task_id,
    receipt,
  });
  await assert.rejects(
    commitAgentStepEffect(db as never, {
      taskId: step.task_id,
      receipt,
      artifactType: "tabular_review",
      documentId: "ff148cbc-396f-4f5d-aab1-fc19c4efe686",
      versionId: receipt.target.version_id,
    }),
    /reserved target/,
  );
});
