import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildAgentStepTabularEffectReservation,
  commitAgentStepTabularEffect,
  readAgentStepTabularEffectReceipts,
  reserveAgentStepTabularEffect,
} from "./tabularEffect";

const ids = {
  task: "11111111-1111-4111-8111-111111111111",
  step: "22222222-2222-4222-8222-222222222222",
  lease: "33333333-3333-4333-8333-333333333333",
  review: "44444444-4444-4444-8444-444444444444",
};

test("reserves and commits one fixed Matter-owned Tabular Review effect", async () => {
  const resultData: Record<string, unknown> = {};
  const receipt = buildAgentStepTabularEffectReservation({
    stepId: ids.step,
    attempt: 1,
    layout: { fields: ["evidence_item"] },
    reviewId: ids.review,
    createdAt: "2026-08-08T00:00:00.000Z",
  });
  const db = {
    async rpc(name: string, args: Record<string, unknown>) {
      const key = args.p_effect_key as string;
      const receipts =
        (resultData.tabular_effect_receipts as Record<string, unknown>) ?? {};
      if (name === "reserve_agent_step_tabular_effect_v1") {
        receipts[key] = args.p_receipt;
        resultData.tabular_effect_receipts = receipts;
        return {
          data: [{ outcome: "reserved", effect_receipt: args.p_receipt }],
          error: null,
        };
      }
      const committed = {
        ...(args.p_reserved_receipt as Record<string, unknown>),
        status: "committed",
        effect: {
          review_id: args.p_review_id,
          artifact_type: "tabular_review",
        },
        committed_at: args.p_committed_at,
      };
      receipts[key] = committed;
      resultData.tabular_effect_receipts = receipts;
      return {
        data: [{ outcome: "committed", effect_receipt: committed }],
        error: null,
      };
    },
  };
  const reserved = await reserveAgentStepTabularEffect(db as never, {
    taskId: ids.task,
    userId: "user-1",
    leaseOwner: ids.lease,
    receipt,
  });
  const committed = await commitAgentStepTabularEffect(db as never, {
    taskId: ids.task,
    userId: "user-1",
    leaseOwner: ids.lease,
    receipt: reserved,
    reviewId: ids.review,
    layout: { document_ids: [], columns_config: [], cells: [] },
    committedAt: "2026-08-08T00:01:00.000Z",
  });
  assert.equal(committed.effect?.review_id, ids.review);
  assert.deepEqual(readAgentStepTabularEffectReceipts(resultData), [committed]);
});

test("recovers the exact committed Tabular effect when only replay metadata changed", async () => {
  const layout = { fields: ["evidence_item"] };
  const persisted = {
    ...buildAgentStepTabularEffectReservation({
      stepId: ids.step,
      attempt: 1,
      layout,
      reviewId: ids.review,
      createdAt: "2026-08-08T00:00:00.000Z",
    }),
    status: "committed" as const,
    effect: {
      review_id: ids.review,
      artifact_type: "tabular_review" as const,
    },
    committed_at: "2026-08-08T00:01:00.000Z",
  };
  const replay = buildAgentStepTabularEffectReservation({
    stepId: ids.step,
    attempt: 1,
    layout,
    reviewId: ids.review,
    createdAt: "2026-08-08T00:05:00.000Z",
  });
  const db = {
    async rpc(name: string) {
      assert.equal(name, "reserve_agent_step_tabular_effect_v1");
      return {
        data: [{ outcome: "recovered", effect_receipt: persisted }],
        error: null,
      };
    },
  };

  const recovered = await reserveAgentStepTabularEffect(db as never, {
    taskId: ids.task,
    userId: "user-1",
    leaseOwner: "55555555-5555-4555-8555-555555555555",
    receipt: replay,
  });
  assert.equal(recovered.status, "committed");
  assert.equal(recovered.created_at, "2026-08-08T00:00:00.000Z");
  assert.equal(recovered.committed_at, "2026-08-08T00:01:00.000Z");
  assert.equal(recovered.input_fingerprint, replay.input_fingerprint);
  assert.equal(recovered.target.review_id, replay.target.review_id);
});

test("keeps mirrored Tabular-effect migrations lease-fenced and service-only", async () => {
  const backend = await readFile(
    new URL(
      "../../../../migrations/20260808_09_agent_step_tabular_effect.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const supabase = await readFile(
    new URL(
      "../../../../../supabase/migrations/20260808000009_agent_step_tabular_effect.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.equal(backend, supabase);
  assert.match(
    backend,
    /execution_lease_owner is distinct from p_lease_owner/i,
  );
  assert.match(backend, /row_protocol = 'document_rows'/i);
  assert.match(
    backend,
    /review\.document_ids is not distinct from \(p_layout -> 'document_ids'\)/i,
  );
  assert.match(backend, /from public\.tabular_cells cell/i);
  assert.match(backend, /cell\.status = 'pending'/i);
  assert.match(backend, /tabular_effect_receipts/i);
  assert.match(backend, /from public, anon, authenticated/i);
  assert.match(backend, /to service_role/i);
});

test("keeps the latest Tabular effect fence compatible with fixed completed cells", async () => {
  const backend = await readFile(
    new URL(
      "../../../../migrations/20260808_11_agent_step_tabular_effect_resume.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const supabase = await readFile(
    new URL(
      "../../../../../supabase/migrations/20260808000011_agent_step_tabular_effect_resume.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.equal(backend, supabase);
  assert.match(backend, /cell\.status in \('pending', 'done'\)/i);
  assert.match(
    backend,
    /execution_lease_owner is distinct from p_lease_owner/i,
  );
  assert.match(backend, /to service_role/i);
});

test("latest Tabular effect recovery treats timestamps as metadata, not identity", async () => {
  const backend = await readFile(
    new URL(
      "../../../../migrations/20260808_15_agent_step_tabular_effect_metadata_recovery.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const supabase = await readFile(
    new URL(
      "../../../../../supabase/migrations/20260808000015_agent_step_tabular_effect_metadata_recovery.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.equal(backend, supabase);
  assert.match(
    backend,
    /'status', 'effect', 'created_at', 'committed_at'/i,
  );
  assert.match(
    backend,
    /execution_lease_owner is distinct from p_lease_owner/i,
  );
  assert.match(backend, /v_existing ->> 'status' = 'reserved'/i);
  assert.match(backend, /v_existing ->> 'status' = 'committed'/i);
  assert.match(backend, /to service_role/i);
});
