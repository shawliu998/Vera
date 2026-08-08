import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  commitAgentLitigationEvidenceCell,
  MAX_LITIGATION_EVIDENCE_CELL_CONTENT_CHARS,
  reviewLitigationEvidenceCell,
} from "./agentLitigationEvidenceCellRepository";

const ids = {
  task: "11111111-1111-4111-8111-111111111111",
  step: "22222222-2222-4222-8222-222222222222",
  lease: "33333333-3333-4333-8333-333333333333",
  review: "44444444-4444-4444-8444-444444444444",
  cell: "55555555-5555-4555-8555-555555555555",
  document: "66666666-6666-4666-8666-666666666666",
  version: "77777777-7777-4777-8777-777777777777",
};

test("commits a fixed litigation cell and preserves an explicit lawyer review", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const content = {
    kind: "litigation_evidence_inventory_cell_content_v1" as const,
    candidate: { cell_id: ids.cell, value: "bound" },
    summary: "Evidence item: Bluewater agreement",
    reasoning: "The source heading identifies the agreement.",
    flag: "grey" as const,
    model_review_status: "unverified" as const,
  };
  const db = {
    async rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      if (name === "commit_agent_litigation_evidence_cell_v1") {
        return {
          data: [
            {
              outcome: "committed",
              cell_id: ids.cell,
              cell_status: "done",
              review_status: null,
              review_revision: 0,
              reviewed_at: null,
            },
          ],
          error: null,
        };
      }
      return {
        data: [
          {
            outcome: "reviewed",
            cell_id: ids.cell,
            cell_status: "done",
            review_status: "verified",
            review_revision: 1,
            reviewed_at: "2026-08-08T00:02:00.123456+00:00",
          },
        ],
        error: null,
      };
    },
  };
  const committed = await commitAgentLitigationEvidenceCell(db as never, {
    taskId: ids.task,
    userId: "user-1",
    stepId: ids.step,
    attempt: 1,
    leaseOwner: ids.lease,
    reviewId: ids.review,
    cellId: ids.cell,
    documentId: ids.document,
    versionId: ids.version,
    columnIndex: 0,
    content,
    citations: [{ citation_id: "citation-1" }],
  });
  assert.equal(committed.outcome, "committed");
  assert.deepEqual(JSON.parse(calls[0]!.args.p_content as string), content);
  assert.deepEqual(calls[0]!.args.p_citations, [{ citation_id: "citation-1" }]);

  const reviewed = await reviewLitigationEvidenceCell(db as never, {
    userId: "user-1",
    reviewId: ids.review,
    cellId: ids.cell,
    expectedRevision: 0,
    reviewStatus: "verified",
  });
  assert.equal(reviewed.outcome, "reviewed");
  assert.equal(reviewed.reviewed_at, "2026-08-08T00:02:00.123456+00:00");
  assert.equal(calls[1]!.name, "review_litigation_evidence_cell_v1");
  assert.equal(calls[1]!.args.p_expected_review_revision, 0);
});

test("rejects oversized litigation content before calling the database", async () => {
  const db = {
    async rpc() {
      throw new Error("must not call database");
    },
  };
  await assert.rejects(
    () =>
      commitAgentLitigationEvidenceCell(db as never, {
        taskId: ids.task,
        userId: "user-1",
        stepId: ids.step,
        attempt: 1,
        leaseOwner: ids.lease,
        reviewId: ids.review,
        cellId: ids.cell,
        documentId: ids.document,
        versionId: ids.version,
        columnIndex: 0,
        content: {
          kind: "litigation_evidence_inventory_cell_content_v1",
          candidate: {
            padding: "x".repeat(MAX_LITIGATION_EVIDENCE_CELL_CONTENT_CHARS),
          },
          summary: "Evidence item: Bluewater agreement",
          reasoning: "The source heading identifies the agreement.",
          flag: "grey",
          model_review_status: "unverified",
        },
        citations: [{ citation_id: "citation-1" }],
      }),
    /Litigation cell content exceeds/i,
  );
});

test("keeps mirrored litigation-cell migrations lease-fenced and review-safe", async () => {
  const backend = await readFile(
    new URL(
      "../../migrations/20260808_10_litigation_evidence_cell_commit.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const supabase = await readFile(
    new URL(
      "../../../supabase/migrations/20260808000010_litigation_evidence_cell_commit.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.equal(backend, supabase);
  assert.match(
    backend,
    /execution_lease_owner is distinct from p_lease_owner/i,
  );
  assert.match(backend, /tabular_effect_receipts/i);
  assert.match(
    backend,
    /create table if not exists public\.tabular_review_rows/i,
  );
  assert.match(backend, /litigation_evidence_inventory_receipt/i);
  assert.match(backend, /document_row\.current_version_id = p_version_id/i);
  assert.match(backend, /v_cell\.review_status is not null/i);
  assert.match(backend, /p_review_status = 'verified'/i);
  assert.match(backend, /v_cell\.status not in \('pending', 'done'\)/i);
  assert.match(backend, /review_revision = v_cell\.review_revision \+ 1/i);
  assert.match(backend, /from public, anon, authenticated/i);
  assert.match(backend, /to service_role/i);
});
