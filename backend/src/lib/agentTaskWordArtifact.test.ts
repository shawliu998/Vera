import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  AgentTaskWordArtifactError,
  agentTaskWordArtifactErrorBody,
  putAgentTaskWordArtifactEdit,
} from "./agentTaskWordArtifact";
import { AgentTaskArtifactReverificationError } from "./agent-kernel/verification/artifactReverification";
import { durableCurrentVersionMutationId } from "./currentDocumentVersionMutation";
import type { TaskWordArtifactReceiptV1 } from "./taskWordArtifactReceipt";

const taskId = "a0d75d08-c1a0-4a3f-afb3-4c16d5141615";
const userId = "11111111-1111-4111-8111-111111111111";
const projectId = "0ebafd84-1f05-4a5a-b90c-fe992434e6ee";
const documentId = "0ff133ee-4208-40f8-8df9-3bf5a94331da";
const baseVersionId = "8d3f5df3-c172-44c6-a857-ad1847aa57e0";

const predecessor: TaskWordArtifactReceiptV1 = {
  schemaVersion: 1,
  kind: "agent-task-word-artifact-v1",
  taskId,
  projectId,
  deliverableKey: "claim-comparison-memo",
  documentId,
  versionId: baseVersionId,
};

function snapshot(artifactId = documentId) {
  return {
    task: {
      id: taskId,
      matter_id: projectId,
      deliverables: [
        {
          key: predecessor.deliverableKey,
          title: "Claim comparison memorandum",
          purpose: "Claim comparison memorandum",
          required: true,
          artifact_type: "draft",
        },
      ],
      current_plan: [],
    },
    artifacts: [
      {
        task_id: taskId,
        artifact_type: "draft",
        artifact_id: artifactId,
        purpose: "Claim comparison memorandum",
      },
    ],
    review: { decisions: [] },
  };
}

function digest(buffer: Buffer) {
  return Promise.resolve(createHash("sha256").update(buffer).digest("hex"));
}

test("saves one exact Task draft with a successor receipt before activation", async () => {
  const clientBytes = Buffer.from("edited-docx");
  const baseBytes = Buffer.from("base-docx");
  const advancedBytes = Buffer.from("advanced-docx");
  const snapshots: unknown[] = [];
  let appendInput: Record<string, unknown> | null = null;
  let successor: TaskWordArtifactReceiptV1 | null = null;

  const version = await putAgentTaskWordArtifactEdit({} as never, {
    taskId,
    userId,
    documentId,
    baseVersionId,
    filename: "Memo.docx",
    buffer: clientBytes,
    dependencies: {
      loadSnapshot: async () => {
        const value = snapshot();
        snapshots.push(value);
        return value as never;
      },
      loadBaseBytes: async () => baseBytes,
      readReceipt: async (buffer) =>
        buffer === clientBytes || buffer === baseBytes ? predecessor : null,
      semanticDigest: digest,
      advanceReceipt: async (_buffer, input) => {
        successor = input.successor;
        return advancedBytes;
      },
      appendVersion: async (input) => {
        appendInput = input as unknown as Record<string, unknown>;
        await input.beforeActivate?.();
        return {
          document_id: documentId,
          version_id:
            input.buffer === advancedBytes
              ? durableCurrentVersionMutationId(input.mutationKey)
              : "wrong-version",
          version_number: 2,
          current_version_id: durableCurrentVersionMutationId(
            input.mutationKey,
          ),
          filename: "Memo.docx",
          storage_path: "memo-v2.docx",
          created: true,
        };
      },
      loadPersistedVersion: async (_db, id, versionId) => ({
        id: versionId,
        version_number: 2,
        source: "user_upload",
        created_at: "2026-08-07T00:00:00.000Z",
        filename: id === documentId ? "Memo.docx" : null,
      }),
      startReverification: async (_db, input) => ({
        outcome: "started" as const,
        taskStatus: "verifying",
        currentStep: "verifier-step",
        input,
      }),
    },
  });

  assert.equal(snapshots.length, 2);
  assert.equal(appendInput?.documentId, documentId);
  assert.equal(appendInput?.baseVersionId, baseVersionId);
  assert.equal(appendInput?.buffer, advancedBytes);
  assert.ok(successor);
  assert.equal(version.id, successor!.versionId);
  assert.equal(version.source, "user_upload");
  assert.deepEqual(version.artifact_reverification, {
    outcome: "started",
    task_status: "verifying",
    current_step: "verifier-step",
  });
});

test("reports a preserved successor when verifier restart is rejected", async () => {
  const clientBytes = Buffer.from("edited-docx");
  const targetVersionId = durableCurrentVersionMutationId(
    [
      "agent-task-word-artifact-edit-v1",
      taskId,
      documentId,
      baseVersionId,
      predecessor.deliverableKey,
      await digest(clientBytes),
    ].join(":"),
  );

  await assert.rejects(
    putAgentTaskWordArtifactEdit({} as never, {
      taskId,
      userId,
      documentId,
      baseVersionId,
      filename: "Memo.docx",
      buffer: clientBytes,
      dependencies: {
        loadSnapshot: async () => snapshot() as never,
        loadBaseBytes: async () => Buffer.from("base-docx"),
        readReceipt: async () => predecessor,
        semanticDigest: digest,
        advanceReceipt: async () => Buffer.from("advanced-docx"),
        appendVersion: async (input) => {
          await input.beforeActivate?.();
          return {
            document_id: documentId,
            version_id: durableCurrentVersionMutationId(input.mutationKey),
            version_number: 2,
            current_version_id: durableCurrentVersionMutationId(
              input.mutationKey,
            ),
            filename: "Memo.docx",
            storage_path: "memo-v2.docx",
            created: true,
          };
        },
        loadPersistedVersion: async (_db, _documentId, versionId) => ({
          id: versionId,
          version_number: 2,
          source: "user_upload",
          created_at: "2026-08-07T00:00:00.000Z",
          filename: "Memo.docx",
        }),
        startReverification: async () => {
          throw new AgentTaskArtifactReverificationError(
            "verifier_invalid",
            "The edited Version was preserved, but this Task cannot safely restart its Verifier.",
          );
        },
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AgentTaskWordArtifactError);
      assert.equal(error.code, "reverification_conflict");
      assert.equal(error.status, 409);
      assert.equal(error.preservedVersion?.id, targetVersionId);
      return true;
    },
  );
});

test("serializes a preserved successor for the Word client recovery contract", () => {
  const preservedVersion = {
    id: "33333333-3333-4333-8333-333333333333",
    version_number: 3,
    source: "user_upload",
    created_at: "2026-08-07T00:00:00.000Z",
    filename: "Memo.docx",
  };
  assert.deepEqual(
    agentTaskWordArtifactErrorBody(
      new AgentTaskWordArtifactError(
        503,
        "reverification_unavailable",
        "The Version was preserved.",
        preservedVersion,
      ),
    ),
    {
      detail: "The Version was preserved.",
      issue_code: "reverification_unavailable",
      preserved_version: preservedVersion,
    },
  );
});

test("rejects a stale open receipt before loading or mutating bytes", async () => {
  let baseLoads = 0;
  let appends = 0;
  await assert.rejects(
    putAgentTaskWordArtifactEdit({} as never, {
      taskId,
      userId,
      documentId,
      baseVersionId,
      filename: "Memo.docx",
      buffer: Buffer.from("edited"),
      dependencies: {
        loadSnapshot: async () => snapshot() as never,
        readReceipt: async () => ({
          ...predecessor,
          versionId: "99999999-9999-4999-8999-999999999999",
        }),
        loadBaseBytes: async () => {
          baseLoads += 1;
          return Buffer.from("base");
        },
        appendVersion: async () => {
          appends += 1;
          throw new Error("unreachable");
        },
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AgentTaskWordArtifactError);
      assert.equal(error.code, "identity_mismatch");
      return true;
    },
  );
  assert.equal(baseLoads, 0);
  assert.equal(appends, 0);
});

test("rejects an edited file whose receipt differs from the server base", async () => {
  await assert.rejects(
    putAgentTaskWordArtifactEdit({} as never, {
      taskId,
      userId,
      documentId,
      baseVersionId,
      filename: "Memo.docx",
      buffer: Buffer.from("edited"),
      dependencies: {
        loadSnapshot: async () => snapshot() as never,
        readReceipt: async (buffer) =>
          buffer.toString() === "edited"
            ? predecessor
            : { ...predecessor, deliverableKey: "other-output" },
        loadBaseBytes: async () => Buffer.from("server-base"),
      },
    }),
    /does not match the server-stored base Version/,
  );
});

test("revalidates the Task draft immediately before Version activation", async () => {
  let snapshotLoads = 0;
  await assert.rejects(
    putAgentTaskWordArtifactEdit({} as never, {
      taskId,
      userId,
      documentId,
      baseVersionId,
      filename: "Memo.docx",
      buffer: Buffer.from("edited"),
      dependencies: {
        loadSnapshot: async () => {
          snapshotLoads += 1;
          return (
            snapshotLoads === 1
              ? snapshot()
              : snapshot("99999999-9999-4999-8999-999999999999")
          ) as never;
        },
        readReceipt: async () => predecessor,
        loadBaseBytes: async () => Buffer.from("server-base"),
        semanticDigest: digest,
        advanceReceipt: async () => Buffer.from("advanced"),
        appendVersion: async (input) => {
          await input.beforeActivate?.();
          throw new Error("unreachable");
        },
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AgentTaskWordArtifactError);
      assert.equal(error.code, "identity_mismatch");
      return true;
    },
  );
  assert.equal(snapshotLoads, 2);
});
