import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  appendCurrentDocxVersion,
  CurrentDocumentVersionMutationError,
  durableCurrentVersionMutationId,
  type CurrentDocumentVersionRepository,
} from "./currentDocumentVersionMutation";

const userId = "a0d75d08-c1a0-4a3f-afb3-4c16d5141615";
const projectId = "0ebafd84-1f05-4a5a-b90c-fe992434e6ee";
const documentId = "0ff133ee-4208-40f8-8df9-3bf5a94331da";
const baseVersionId = "8d3f5df3-c172-44c6-a857-ad1847aa57e0";
const mutationKey = `task:task-1:document:${documentId}:base:${baseVersionId}`;

function digest(buffer: Buffer) {
  return Promise.resolve(createHash("sha256").update(buffer).digest("hex"));
}

function fakeState() {
  const document = {
    id: documentId,
    user_id: userId,
    project_id: projectId,
    current_version_id: baseVersionId as string | null,
  };
  const versions = new Map([
    [
      baseVersionId,
      {
        id: baseVersionId,
        document_id: documentId,
        storage_path: "base.docx",
        filename: "Memo.docx",
        version_number: 1,
        file_type: "docx",
        deleted_at: null,
      },
    ],
  ]);
  let activationWinner: string | null = null;
  let inserts = 0;
  const repository: CurrentDocumentVersionRepository = {
    async loadDocument(id) {
      return id === documentId ? structuredClone(document) : null;
    },
    async loadVersion(id, versionId) {
      return id === documentId
        ? structuredClone(versions.get(versionId) ?? null)
        : null;
    },
    async latestVersionNumber() {
      return Math.max(
        0,
        ...[...versions.values()].map((version) => version.version_number ?? 0),
      );
    },
    async insertVersion(version) {
      if (
        versions.has(version.id) ||
        [...versions.values()].some(
          (candidate) => candidate.version_number === version.version_number,
        )
      ) {
        return "conflict";
      }
      inserts += 1;
      versions.set(version.id, {
        id: version.id,
        document_id: version.document_id,
        storage_path: version.storage_path,
        filename: version.filename,
        version_number: version.version_number,
        file_type: version.file_type,
        deleted_at: null,
      });
      return "inserted";
    },
    async activateVersion(input) {
      if (activationWinner) {
        document.current_version_id = activationWinner;
        return false;
      }
      if (document.current_version_id !== input.expectedVersionId) return false;
      document.current_version_id = input.targetVersionId;
      return true;
    },
  };
  return {
    document,
    versions,
    repository,
    inserts: () => inserts,
    setActivationWinner(value: string) {
      activationWinner = value;
    },
  };
}

function dependencies(
  state: ReturnType<typeof fakeState>,
  uploads: Map<string, Buffer>,
) {
  return {
    repository: state.repository,
    semanticDigest: digest,
    upload: async (path: string, bytes: ArrayBuffer) => {
      uploads.set(path, Buffer.from(bytes));
    },
    download: async (path: string) => {
      if (path === "base.docx") return Buffer.from("base").buffer;
      const bytes = uploads.get(path);
      return bytes
        ? bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          )
        : null;
    },
    convertDocxToPdf: async () => Buffer.from("pdf"),
    now: () => "2026-08-07T00:00:00.000Z",
  };
}

function append(
  state: ReturnType<typeof fakeState>,
  uploads: Map<string, Buffer>,
  buffer = Buffer.from("edited-docx"),
) {
  return appendCurrentDocxVersion({
    db: {} as never,
    userId,
    projectId,
    documentId,
    baseVersionId,
    mutationKey,
    filename: "Memo.docx",
    buffer,
    dependencies: dependencies(state, uploads),
  });
}

test("appends one deterministic Version and CAS-activates it", async () => {
  const state = fakeState();
  const uploads = new Map<string, Buffer>();
  const result = await append(state, uploads);
  const targetId = durableCurrentVersionMutationId(mutationKey);
  assert.equal(result.version_id, targetId);
  assert.equal(result.version_number, 2);
  assert.equal(result.created, true);
  assert.equal(state.document.current_version_id, targetId);
  assert.equal(state.inserts(), 1);
  assert.equal(state.versions.get(baseVersionId)?.storage_path, "base.docx");
  assert.equal(
    [...uploads.values()].some((bytes) =>
      bytes.equals(Buffer.from("edited-docx")),
    ),
    true,
  );
});

test("an identical retry converges on the same current Version", async () => {
  const state = fakeState();
  const uploads = new Map<string, Buffer>();
  const first = await append(state, uploads);
  const uploadCount = uploads.size;
  const second = await append(state, uploads);
  assert.equal(second.version_id, first.version_id);
  assert.equal(second.created, false);
  assert.equal(state.inserts(), 1);
  assert.equal(uploads.size, uploadCount);
});

test("a newer current Version fails before upload or insert", async () => {
  const state = fakeState();
  const uploads = new Map<string, Buffer>();
  state.document.current_version_id = "99999999-9999-4999-8999-999999999999";
  await assert.rejects(append(state, uploads), (error: unknown) => {
    assert.ok(error instanceof CurrentDocumentVersionMutationError);
    assert.equal(error.code, "version_conflict");
    return true;
  });
  assert.equal(uploads.size, 0);
  assert.equal(state.inserts(), 0);
});

test("a concurrent activation preserves the winning Version and reports conflict", async () => {
  const state = fakeState();
  const uploads = new Map<string, Buffer>();
  const winner = "77777777-7777-4777-8777-777777777777";
  state.setActivationWinner(winner);
  await assert.rejects(append(state, uploads), (error: unknown) => {
    assert.ok(error instanceof CurrentDocumentVersionMutationError);
    assert.equal(error.code, "version_conflict");
    return true;
  });
  assert.equal(state.document.current_version_id, winner);
  assert.equal(state.inserts(), 1);
});

test("the same mutation identity cannot be rebound to different bytes", async () => {
  const state = fakeState();
  const uploads = new Map<string, Buffer>();
  await append(state, uploads);
  await assert.rejects(
    append(state, uploads, Buffer.from("different-edit")),
    (error: unknown) => {
      assert.ok(error instanceof CurrentDocumentVersionMutationError);
      assert.equal(error.code, "mutation_conflict");
      return true;
    },
  );
  assert.equal(state.inserts(), 1);
});

test("wrong Matter ownership and unavailable base Versions fail closed", async () => {
  const ownership = fakeState();
  ownership.document.project_id = "66666666-6666-4666-8666-666666666666";
  await assert.rejects(
    append(ownership, new Map()),
    (error: unknown) =>
      error instanceof CurrentDocumentVersionMutationError &&
      error.code === "document_not_found",
  );

  const missing = fakeState();
  missing.versions.delete(baseVersionId);
  await assert.rejects(
    append(missing, new Map()),
    (error: unknown) =>
      error instanceof CurrentDocumentVersionMutationError &&
      error.code === "version_unavailable",
  );
});

test("revalidates the caller boundary immediately before activation", async () => {
  const state = fakeState();
  const uploads = new Map<string, Buffer>();
  let checks = 0;
  await appendCurrentDocxVersion({
    db: {} as never,
    userId,
    projectId,
    documentId,
    baseVersionId,
    mutationKey,
    filename: "Memo.docx",
    buffer: Buffer.from("edited-docx"),
    dependencies: dependencies(state, uploads),
    beforeActivate: async () => {
      checks += 1;
      assert.equal(state.document.current_version_id, baseVersionId);
    },
  });
  assert.equal(checks, 1);

  const rejected = fakeState();
  await assert.rejects(
    appendCurrentDocxVersion({
      db: {} as never,
      userId,
      projectId,
      documentId,
      baseVersionId,
      mutationKey,
      filename: "Memo.docx",
      buffer: Buffer.from("edited-docx"),
      dependencies: dependencies(rejected, new Map()),
      beforeActivate: async () => {
        throw new Error("Task artifact changed");
      },
    }),
    /Task artifact changed/,
  );
  assert.equal(rejected.document.current_version_id, baseVersionId);
  assert.equal(rejected.inserts(), 1);
});
