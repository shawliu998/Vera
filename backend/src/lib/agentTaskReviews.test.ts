import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  captureApprovedArtifacts,
  loadApprovedExport,
} from "./agentTaskReviews";
import { compileLitigationEvidenceInventoryReceipt } from "./agent-packs/litigation/litigationEvidenceInventoryPack";

type EqCall = { column: string; value: unknown };

function chain(result: unknown, eqCalls: EqCall[]) {
  const query = {
    select: () => query,
    in: () => query,
    is: () => query,
    eq: (column: string, value: unknown) => {
      eqCalls.push({ column, value });
      return query;
    },
    order: () => query,
    limit: () => query,
    maybeSingle: async () => ({ data: result, error: null }),
  };
  return query;
}

function collectionChain(
  result: unknown[],
  filters: Array<{ method: string; column: string; value: unknown }>,
) {
  const query = {
    select: () => query,
    in: (column: string, value: unknown) => {
      filters.push({ method: "in", column, value });
      return query;
    },
    eq: (column: string, value: unknown) => {
      filters.push({ method: "eq", column, value });
      return query;
    },
    is: (column: string, value: unknown) => {
      filters.push({ method: "is", column, value });
      return query;
    },
    then: <TResult1 = { data: unknown[]; error: null }, TResult2 = never>(
      onfulfilled?:
        | ((value: {
            data: unknown[];
            error: null;
          }) => TResult1 | PromiseLike<TResult1>)
        | null,
      onrejected?:
        | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
        | null,
    ) =>
      Promise.resolve({ data: result, error: null }).then(
        onfulfilled,
        onrejected,
      ),
  };
  return query;
}

test("final export fails closed when the latest review requests changes", async () => {
  const taskFilters: EqCall[] = [];
  const decisionFilters: EqCall[] = [];
  const touchedTables: string[] = [];
  const db = {
    from(table: string) {
      touchedTables.push(table);
      if (table === "agent_tasks") {
        return chain({ id: "task-1" }, taskFilters);
      }
      if (table === "agent_task_review_decisions") {
        return chain(
          {
            id: "decision-2",
            status: "changes_requested",
            artifact_snapshot: [],
            created_at: "2026-07-22T12:00:00.000Z",
          },
          decisionFilters,
        );
      }
      throw new Error(`Unexpected table access: ${table}`);
    },
  };

  await assert.rejects(
    loadApprovedExport(db as never, "task-1", "user-1", "artifact-1"),
    /most recent review decision requests changes/,
  );
  assert.deepEqual(taskFilters, [
    { column: "id", value: "task-1" },
    { column: "user_id", value: "user-1" },
  ]);
  assert.deepEqual(decisionFilters, [{ column: "task_id", value: "task-1" }]);
  assert.deepEqual(touchedTables, [
    "agent_tasks",
    "agent_task_review_decisions",
  ]);
});

test("generic Tabular approvals fail closed without a registered server materializer", async () => {
  let materializerCalled = false;
  const snapshot = {
    task: {
      id: "10000000-0000-4000-8000-000000000001",
      user_id: "user-1",
      matter_id: "10000000-0000-4000-8000-000000000002",
      status: "completed",
      deliverables: [
        {
          key: "generic-table",
          title: "Generic table",
          purpose: "Generic table",
          required: true,
          artifact_type: "tabular_review",
        },
      ],
      current_plan: [],
      latest_checkpoint: {},
    },
    artifacts: [
      {
        artifact_type: "tabular_review" as const,
        artifact_id: "10000000-0000-4000-8000-000000000003",
        purpose: "Generic table",
      },
    ],
  };
  await assert.rejects(
    captureApprovedArtifacts({} as never, snapshot, {
      async materializeApprovedTabular() {
        materializerCalled = true;
        throw new Error("must not be called");
      },
    }),
    /No server approval materializer is registered/,
  );
  assert.equal(materializerCalled, false);
});

test("mixed capture validates all owned Draft bytes before Tabular materialization and preserves deliverable order", async () => {
  const taskId = "10000000-0000-4000-8000-000000000001";
  const matterId = "10000000-0000-4000-8000-000000000002";
  const draftId = "10000000-0000-4000-8000-000000000003";
  const draftVersionId = "10000000-0000-4000-8000-000000000004";
  const sourceDocumentId = "10000000-0000-4000-8000-000000000005";
  const sourceVersionId = "10000000-0000-4000-8000-000000000006";
  const stepId = "10000000-0000-4000-8000-000000000007";
  const receipt = compileLitigationEvidenceInventoryReceipt({
    taskId,
    matterId,
    stepId,
    attempt: 1,
    proceduralStage: "first_instance",
    representedSide: "claimant_plaintiff",
    sourcePins: [
      { document_id: sourceDocumentId, version_id: sourceVersionId },
    ],
  });
  const draftBytes = Buffer.from("draft bytes");
  const documentFilters: Array<{
    method: string;
    column: string;
    value: unknown;
  }> = [];
  const events: string[] = [];
  const db = {
    from(table: string) {
      if (table === "documents") {
        return collectionChain(
          [{ id: draftId, current_version_id: draftVersionId }],
          documentFilters,
        );
      }
      if (table === "document_versions") {
        return collectionChain(
          [
            {
              id: draftVersionId,
              document_id: draftId,
              storage_path: "documents/user-1/draft.docx",
              version_number: 2,
              filename: "Draft.docx",
              file_type: "docx",
              size_bytes: draftBytes.byteLength,
            },
          ],
          [],
        );
      }
      throw new Error(`Unexpected table access: ${table}`);
    },
  };
  const snapshot = {
    task: {
      id: taskId,
      user_id: "user-1",
      matter_id: matterId,
      status: "completed",
      deliverables: [
        {
          key: "evidence",
          purpose: "Evidence inventory",
          required: true,
          artifact_type: "tabular_review",
        },
        {
          key: "memo",
          purpose: "Memo",
          required: true,
          artifact_type: "draft",
        },
      ],
      current_plan: [],
      latest_checkpoint: {
        litigation_evidence_inventory_receipt: receipt,
      },
    },
    artifacts: [
      {
        artifact_type: "tabular_review" as const,
        artifact_id: receipt.review_id,
        purpose: "Evidence inventory",
      },
      {
        artifact_type: "draft" as const,
        artifact_id: draftId,
        purpose: "Memo",
      },
    ],
  };
  const captured = await captureApprovedArtifacts(db as never, snapshot, {
    async download() {
      events.push("draft-download");
      return draftBytes.buffer.slice(
        draftBytes.byteOffset,
        draftBytes.byteOffset + draftBytes.byteLength,
      );
    },
    async materializeApprovedTabular(input) {
      events.push("tabular-materialize");
      assert.equal(input.reviewId, receipt.review_id);
      return {
        storage_path: "invisible/export.xlsx",
        artifact: {
          kind: "agent_approved_tabular_artifact_v1",
          artifact_type: "tabular_review",
          artifact_id: receipt.review_id,
          purpose: "Evidence inventory",
          review_id: receipt.review_id,
          row_protocol: "document_rows",
          input_digest: "a".repeat(64),
          revision_fingerprint: "b".repeat(64),
          accepted_view_sha256: `sha256:${"c".repeat(64)}`,
          source_receipt_fingerprint: "d".repeat(64),
          decision_fingerprint: "e".repeat(64),
          completion_sha256: `sha256:${"f".repeat(64)}`,
          export_document_id: "20000000-0000-4000-8000-000000000001",
          export_version_id: "20000000-0000-4000-8000-000000000002",
          version_number: 1,
          filename: "Evidence inventory - Approved.xlsx",
          file_type: "xlsx",
          size_bytes: 100,
          sha256: `sha256:${"1".repeat(64)}`,
        },
      };
    },
  });
  assert.deepEqual(events, ["draft-download", "tabular-materialize"]);
  assert.deepEqual(
    captured.map((artifact) => artifact.artifact_type),
    ["tabular_review", "draft"],
  );
  assert.ok(
    documentFilters.some(
      (filter) =>
        filter.method === "eq" &&
        filter.column === "user_id" &&
        filter.value === "user-1",
    ),
  );
  assert.ok(
    documentFilters.some(
      (filter) =>
        filter.method === "eq" &&
        filter.column === "project_id" &&
        filter.value === matterId,
    ),
  );
});

test("approved Tabular export loads only its fixed Version and final lock", async () => {
  const taskId = "10000000-0000-4000-8000-000000000001";
  const reviewId = "10000000-0000-4000-8000-000000000002";
  const documentId = "10000000-0000-4000-8000-000000000003";
  const versionId = "10000000-0000-4000-8000-000000000004";
  const decisionId = "10000000-0000-4000-8000-000000000005";
  const bytes = Buffer.from("fixed approved xlsx bytes");
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const touchedTables: string[] = [];
  const versionFilters: EqCall[] = [];
  const snapshot = {
    kind: "agent_approved_tabular_artifact_v1",
    artifact_type: "tabular_review",
    artifact_id: reviewId,
    purpose: "Evidence inventory",
    review_id: reviewId,
    row_protocol: "document_rows",
    input_digest: "a".repeat(64),
    revision_fingerprint: "b".repeat(64),
    accepted_view_sha256: `sha256:${"c".repeat(64)}`,
    source_receipt_fingerprint: "d".repeat(64),
    decision_fingerprint: "e".repeat(64),
    completion_sha256: `sha256:${"f".repeat(64)}`,
    export_document_id: documentId,
    export_version_id: versionId,
    version_number: 1,
    filename: "Evidence inventory - Approved.xlsx",
    file_type: "xlsx",
    size_bytes: bytes.byteLength,
    sha256: digest,
  };
  const db = {
    from(table: string) {
      touchedTables.push(table);
      if (table === "agent_tasks") return chain({ id: taskId }, []);
      if (table === "agent_task_review_decisions") {
        return chain(
          {
            id: decisionId,
            status: "approved",
            artifact_snapshot: [snapshot],
            created_at: "2026-08-08T12:00:00.000Z",
          },
          [],
        );
      }
      if (table === "document_versions") {
        return chain(
          {
            id: versionId,
            document_id: documentId,
            storage_path: "documents/user-1/export/version.xlsx",
            version_number: 1,
            filename: snapshot.filename,
            file_type: "xlsx",
            size_bytes: bytes.byteLength,
            deleted_at: null,
          },
          versionFilters,
        );
      }
      throw new Error(`Unexpected table access: ${table}`);
    },
  };
  const lockInputs: unknown[] = [];
  const loaded = await loadApprovedExport(
    db as never,
    taskId,
    "user-1",
    reviewId,
    {
      async download() {
        return bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        );
      },
      async verifyLock(input) {
        lockInputs.push(input);
        return true;
      },
    },
  );
  assert.deepEqual(loaded?.bytes, bytes);
  assert.equal(loaded?.artifact.artifact_type, "tabular_review");
  assert.deepEqual(versionFilters, [
    { column: "id", value: versionId },
    { column: "document_id", value: documentId },
  ]);
  assert.deepEqual(lockInputs, [
    { taskId, userId: "user-1", decisionId, documentId, versionId },
    { taskId, userId: "user-1", decisionId, documentId, versionId },
  ]);
  assert.deepEqual(touchedTables, [
    "agent_tasks",
    "agent_task_review_decisions",
    "document_versions",
  ]);
  let blockedDownloads = 0;
  await assert.rejects(
    loadApprovedExport(db as never, taskId, "user-1", reviewId, {
      async download() {
        blockedDownloads += 1;
        return bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        );
      },
      async verifyLock() {
        return false;
      },
    }),
    /approved version lock changed/,
  );
  assert.equal(blockedDownloads, 0);
});

test("historical Tabular snapshot never authorizes export", async () => {
  const reviewId = "10000000-0000-4000-8000-000000000002";
  const touchedTables: string[] = [];
  const db = {
    from(table: string) {
      touchedTables.push(table);
      if (table === "agent_tasks") return chain({ id: "task" }, []);
      if (table === "agent_task_review_decisions") {
        return chain(
          {
            id: "decision",
            status: "approved",
            artifact_snapshot: [
              {
                artifact_type: "tabular_review",
                artifact_id: reviewId,
                purpose: "Evidence inventory",
                review_id: reviewId,
                row_protocol: "document_rows",
                input_digest: "a".repeat(64),
                revision_fingerprint: "b".repeat(64),
              },
            ],
            created_at: "2026-08-08T12:00:00.000Z",
          },
          [],
        );
      }
      throw new Error(`Unexpected table access: ${table}`);
    },
  };
  await assert.rejects(
    loadApprovedExport(db as never, "task", "user", reviewId),
    /historical approval Decision contains Tabular state/,
  );
  assert.deepEqual(touchedTables, [
    "agent_tasks",
    "agent_task_review_decisions",
  ]);
});
