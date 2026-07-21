import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  DOCX_RESOLUTION_CONTENT_TYPE,
  commitResolvedDocumentEditVersion,
  docxResolutionFilename,
  type DocumentEditResolutionStatus,
  type ResolvedDocumentEditVersionInsert,
} from "../src/lib/documentEditResolutionVersions";
import {
  buildAgentReviewVersionState,
  deriveAgentReviewStatus,
} from "../src/lib/agentTaskReviewVersions";
import { approvedArtifactBytesMatch } from "../src/lib/agentTaskReviews";

type Version = {
  id: string;
  document_id: string;
  version_number: number | null;
  storage_path: string;
  filename: string | null;
  file_type: string | null;
  source: string | null;
  deleted_at: string | null;
};

const document = {
  id: "doc_1",
  current_version_id: "version_2",
};
const versions: Version[] = [
  {
    id: "version_1",
    document_id: "doc_1",
    version_number: 1,
    storage_path: "documents/user_1/doc_1/source.docx",
    filename: "Memo.docx",
    file_type: "docx",
    source: "upload",
    deleted_at: null,
  },
  {
    id: "version_2",
    document_id: "doc_1",
    version_number: 2,
    storage_path: "documents/user_1/doc_1/versions/proposed.docx",
    filename: "Memo.docx",
    file_type: "docx",
    source: "assistant_edit",
    deleted_at: null,
  },
];
const editStatuses = new Map<string, "pending" | "accepted" | "rejected">([
  ["edit_accept", "pending"],
  ["edit_reject", "pending"],
]);
const storedBytes = new Map<string, Buffer>([
  [versions[0]!.storage_path, Buffer.from("upload-bytes")],
  [versions[1]!.storage_path, Buffer.from("approved-version-two")],
]);

function digest(bytes: Uint8Array) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function approvalFor(version: Version, bytes: Buffer) {
  return {
    id: "approval_1",
    created_at: "2026-07-21T08:00:00.000Z",
    artifact_snapshot: [
      {
        artifact_type: "draft",
        artifact_id: document.id,
        document_id: document.id,
        purpose: "Memo",
        version_id: version.id,
        version_number: version.version_number,
        filename: version.filename ?? "Memo.docx",
        file_type: version.file_type,
        size_bytes: bytes.byteLength,
        sha256: digest(bytes),
      },
    ],
  };
}

function makeDeps() {
  return {
    claimPendingEditResolution: async (input: {
      editId: string;
      status: DocumentEditResolutionStatus;
    }) => {
      if (editStatuses.get(input.editId) !== "pending") return false;
      editStatuses.set(input.editId, input.status);
      return true;
    },
    getNextVersionNumber: async (documentId: string) =>
      Math.max(
        ...versions
          .filter((version) => version.document_id === documentId)
          .map((version) => version.version_number ?? 0),
      ) + 1,
    uploadVersionBytes: async (input: {
      storagePath: string;
      bytes: Buffer;
      contentType: string;
    }) => {
      assert.equal(input.contentType, DOCX_RESOLUTION_CONTENT_TYPE);
      storedBytes.set(input.storagePath, Buffer.from(input.bytes));
    },
    insertDocumentVersion: async (input: ResolvedDocumentEditVersionInsert) => {
      assert.equal(input.source, "assistant_edit");
      assert.equal(input.file_type, "docx");
      assert.equal(input.pdf_storage_path, null);
      const version: Version = {
        id: `version_${input.version_number}`,
        document_id: input.document_id,
        version_number: input.version_number,
        storage_path: input.storage_path,
        filename: input.filename,
        file_type: input.file_type,
        source: input.source,
        deleted_at: null,
      };
      versions.push(version);
      return version;
    },
    updateDocumentCurrentVersion: async (input: {
      documentId: string;
      versionId: string;
    }) => {
      assert.equal(input.documentId, document.id);
      document.current_version_id = input.versionId;
    },
    countRemainingPendingEdits: async () =>
      [...editStatuses.values()].filter((status) => status === "pending")
        .length,
    rollbackEditResolution: async (input: {
      editId: string;
      status: DocumentEditResolutionStatus;
    }) => {
      if (editStatuses.get(input.editId) === input.status) {
        editStatuses.set(input.editId, "pending");
      }
    },
    cleanupVersion: async (input: {
      versionId: string | null;
      storagePath: string;
    }) => {
      storedBytes.delete(input.storagePath);
      if (input.versionId) {
        const index = versions.findIndex(
          (version) => version.id === input.versionId,
        );
        if (index >= 0) versions.splice(index, 1);
      }
    },
  };
}

async function main() {
  const approvedVersion = versions[1]!;
  const approvedBytes = storedBytes.get(approvedVersion.storage_path)!;
  const latestApproval = approvalFor(approvedVersion, approvedBytes);
  assert.equal(
    approvedArtifactBytesMatch(
      latestApproval.artifact_snapshot[0]!,
      approvedBytes,
    ),
    true,
  );

  const accept = await commitResolvedDocumentEditVersion(
    {
      documentId: document.id,
      editId: "edit_accept",
      status: "accepted",
      resolvedAt: "2026-07-21T09:00:00.000Z",
      filename: "Memo.docx",
      storagePath: "documents/user_1/doc_1/versions/resolved-v3.docx",
      bytes: Buffer.from("accepted-version-three"),
    },
    makeDeps(),
  );
  assert.equal(accept.committed, true);
  assert.equal(accept.version.version_number, 3);
  assert.equal(document.current_version_id, "version_3");
  assert.equal(editStatuses.get("edit_accept"), "accepted");
  assert.equal(storedBytes.get(approvedVersion.storage_path), approvedBytes);
  assert.equal(
    approvedArtifactBytesMatch(
      latestApproval.artifact_snapshot[0]!,
      storedBytes.get("documents/user_1/doc_1/versions/resolved-v3.docx")!,
    ),
    false,
    "new bytes must not match the old approved snapshot",
  );

  const afterAcceptState = buildAgentReviewVersionState(
    [{ artifact_type: "draft", artifact_id: document.id, purpose: "Memo" }],
    [document],
    versions,
    latestApproval,
  );
  assert.equal(afterAcceptState.has_unapproved_changes, true);
  assert.equal(
    afterAcceptState.current_artifacts[0]?.edited_after_approval,
    true,
  );
  assert.equal(
    deriveAgentReviewStatus("completed", "approved", afterAcceptState),
    "review_required",
  );

  const duplicateAccept = await commitResolvedDocumentEditVersion(
    {
      documentId: document.id,
      editId: "edit_accept",
      status: "accepted",
      resolvedAt: "2026-07-21T09:01:00.000Z",
      filename: "Memo.docx",
      storagePath: "documents/user_1/doc_1/versions/duplicate.docx",
      bytes: Buffer.from("duplicate-accept"),
    },
    makeDeps(),
  );
  assert.equal(duplicateAccept.committed, false);
  assert.equal(versions.length, 3);
  assert.equal(document.current_version_id, "version_3");
  assert.equal(
    storedBytes.has("documents/user_1/doc_1/versions/duplicate.docx"),
    false,
  );

  const reject = await commitResolvedDocumentEditVersion(
    {
      documentId: document.id,
      editId: "edit_reject",
      status: "rejected",
      resolvedAt: "2026-07-21T09:02:00.000Z",
      filename: "Memo",
      storagePath: "documents/user_1/doc_1/versions/resolved-v4.docx",
      bytes: Buffer.from("rejected-version-four"),
    },
    makeDeps(),
  );
  assert.equal(reject.committed, true);
  assert.equal(reject.version.version_number, 4);
  assert.equal(reject.version.filename, "Memo.docx");
  assert.equal(docxResolutionFilename("Memo"), "Memo.docx");
  assert.equal(document.current_version_id, "version_4");
  assert.equal(editStatuses.get("edit_reject"), "rejected");
  assert.equal(storedBytes.get(approvedVersion.storage_path), approvedBytes);

  const duplicateRejectAsAccept = await commitResolvedDocumentEditVersion(
    {
      documentId: document.id,
      editId: "edit_reject",
      status: "accepted",
      resolvedAt: "2026-07-21T09:03:00.000Z",
      filename: "Memo.docx",
      storagePath: "documents/user_1/doc_1/versions/duplicate-opposite.docx",
      bytes: Buffer.from("duplicate-opposite"),
    },
    makeDeps(),
  );
  assert.equal(duplicateRejectAsAccept.committed, false);
  assert.equal(editStatuses.get("edit_reject"), "rejected");
  assert.equal(versions.length, 4);
  assert.equal(document.current_version_id, "version_4");

  console.log(
    JSON.stringify(
      { ok: true, suite: "document-edit-resolution-version-smoke-v1" },
      null,
      2,
    ),
  );
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
