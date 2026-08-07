import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildAgentStepEffectReservation,
  canonicalEffectInput,
  commitAgentStepEffect,
  isAgentStepEffectTransitionError,
  readAgentStepEffectReceipts,
  reserveAgentStepEffect,
} from "./stepEffect";

type Step = {
  id: string;
  task_id: string;
  status: string;
  attempt: number;
  result_data: Record<string, unknown> | null;
  updated_at: string;
};

function fakeDb(step: Step) {
  return {
    async rpc(name: string, args: Record<string, unknown>) {
      assert.equal(args.p_task_id, step.task_id);
      assert.equal(args.p_step_id, step.id);
      assert.equal(args.p_step_attempt, step.attempt);
      assert.equal(args.p_user_id, "user-1");
      assert.equal(args.p_lease_owner, "00000000-0000-4000-8000-000000000099");
      const receipt = structuredClone(
        (args.p_receipt ?? args.p_reserved_receipt) as Record<string, unknown>,
      );
      const resultData = step.result_data ?? {};
      const receipts =
        (resultData.effect_receipts as Record<string, unknown> | undefined) ??
        {};
      const key = args.p_effect_key as string;
      const existing = receipts[key] as Record<string, unknown> | undefined;
      if (name === "reserve_agent_step_effect_v1") {
        if (existing) {
          const sameIdentity = {
            ...existing,
            status: "reserved",
            effect: null,
            committed_at: null,
          };
          if (!isDeepEqual(sameIdentity, receipt)) {
            return {
              data: [{ outcome: "conflict", effect_receipt: null }],
              error: null,
            };
          }
          return {
            data: [{ outcome: "recovered", effect_receipt: existing }],
            error: null,
          };
        }
        receipts[key] = receipt;
        step.result_data = { ...resultData, effect_receipts: receipts };
        return {
          data: [{ outcome: "reserved", effect_receipt: receipt }],
          error: null,
        };
      }
      assert.equal(name, "commit_agent_step_effect_v1");
      assert.equal(receipt.status, "reserved");
      assert.equal(receipt.effect, null);
      assert.equal(receipt.committed_at, null);
      if (!existing) {
        return {
          data: [{ outcome: "conflict", effect_receipt: null }],
          error: null,
        };
      }
      if (existing.status === "committed") {
        return {
          data: [{ outcome: "committed", effect_receipt: existing }],
          error: null,
        };
      }
      const committed = {
        ...existing,
        status: "committed",
        effect: {
          document_id: args.p_document_id,
          version_id: args.p_version_id,
          artifact_type: args.p_artifact_type,
        },
        committed_at: args.p_committed_at,
      };
      receipts[key] = committed;
      step.result_data = { ...resultData, effect_receipts: receipts };
      return {
        data: [{ outcome: "committed", effect_receipt: committed }],
        error: null,
      };
    },
  };
}

function isDeepEqual(left: unknown, right: unknown) {
  try {
    assert.deepEqual(left, right);
    return true;
  } catch {
    return false;
  }
}

const fence = {
  userId: "user-1",
  leaseOwner: "00000000-0000-4000-8000-000000000099",
};

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
    attempt: 1,
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
      ...fence,
      receipt,
    }),
    receipt,
  );
  assert.deepEqual(
    await reserveAgentStepEffect(db as never, {
      taskId: step.task_id,
      ...fence,
      receipt,
    }),
    receipt,
  );
  await assert.rejects(
    reserveAgentStepEffect(db as never, {
      taskId: step.task_id,
      ...fence,
      receipt: buildAgentStepEffectReservation({
        stepId: step.id,
        attempt: 1,
        toolName: "generate_docx",
        toolInput: { title: "Different memo", sections: [] },
      }),
    }),
    /current Task state/,
  );
  const committed = await commitAgentStepEffect(db as never, {
    taskId: step.task_id,
    ...fence,
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
      ...fence,
      receipt,
      artifactType: "draft",
      documentId: receipt.target.document_id,
      versionId: receipt.target.version_id,
    }),
    committed,
  );
  const recoveredCommitted = await reserveAgentStepEffect(db as never, {
    taskId: step.task_id,
    ...fence,
    receipt,
  });
  assert.equal(recoveredCommitted.status, "committed");
  assert.deepEqual(
    await commitAgentStepEffect(db as never, {
      taskId: step.task_id,
      ...fence,
      receipt: recoveredCommitted,
      artifactType: "draft",
      documentId: receipt.target.document_id,
      versionId: receipt.target.version_id,
      committedAt: "2026-08-07T00:02:00.000Z",
    }),
    committed,
  );
});

test("commit rejects an Artifact outside the reserved identity", async () => {
  const step: Step = {
    id: "5ff7fb82-3aa5-49ba-89af-b7086a0f7031",
    task_id: "f997716e-5311-4404-80bb-498767b56425",
    status: "running",
    attempt: 1,
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
    ...fence,
    receipt,
  });
  await assert.rejects(
    commitAgentStepEffect(db as never, {
      taskId: step.task_id,
      ...fence,
      receipt,
      artifactType: "tabular_review",
      documentId: "ff148cbc-396f-4f5d-aab1-fc19c4efe686",
      versionId: receipt.target.version_id,
    }),
    /reserved target/,
  );
});

test("lease loss rejects a stale effect without calling it a work-product failure", async () => {
  const receipt = buildAgentStepEffectReservation({
    stepId: "5ff7fb82-3aa5-49ba-89af-b7086a0f7031",
    attempt: 1,
    toolName: "generate_docx",
    toolInput: { title: "Memo", sections: [] },
  });
  const db = {
    async rpc() {
      return {
        data: [{ outcome: "lease_lost", effect_receipt: null }],
        error: null,
      };
    },
  };
  await assert.rejects(
    reserveAgentStepEffect(db as never, {
      taskId: "f997716e-5311-4404-80bb-498767b56425",
      ...fence,
      receipt,
    }),
    (error: unknown) =>
      isAgentStepEffectTransitionError(error) && error.outcome === "lease_lost",
  );
});

test("keeps effect-fence migrations mirrored, attempt-bound and service-only", async () => {
  const backend = await readFile(
    new URL(
      "../../../../migrations/20260807_06_agent_step_effect_fence.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const supabase = await readFile(
    new URL(
      "../../../../../supabase/migrations/20260807000006_agent_step_effect_fence.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.equal(backend, supabase);
  assert.match(
    backend,
    /execution_lease_owner is distinct from p_lease_owner/i,
  );
  assert.match(backend, /v_step\.attempt <> p_step_attempt/i);
  assert.match(backend, /d\.current_version_id = p_version_id/i);
  assert.match(backend, /from public, anon, authenticated/i);
  assert.match(backend, /to service_role/i);
});
