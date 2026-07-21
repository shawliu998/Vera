export type DocumentEditResolutionStatus = "accepted" | "rejected";

export type ResolvedDocumentEditVersionRecord = {
  id: string;
  version_number: number | null;
  storage_path: string;
  filename: string | null;
  source: string | null;
};

export type ResolvedDocumentEditVersionInsert = {
  document_id: string;
  storage_path: string;
  pdf_storage_path: null;
  source: "assistant_edit";
  version_number: number;
  filename: string;
  file_type: "docx";
  size_bytes: number;
  page_count: null;
};

export type CommitResolvedDocumentEditVersionDeps = {
  claimPendingEditResolution(input: {
    editId: string;
    status: DocumentEditResolutionStatus;
    resolvedAt: string;
  }): Promise<boolean>;
  getNextVersionNumber(documentId: string): Promise<number>;
  uploadVersionBytes(input: {
    storagePath: string;
    bytes: Buffer;
    contentType: string;
  }): Promise<void>;
  insertDocumentVersion(
    input: ResolvedDocumentEditVersionInsert,
  ): Promise<ResolvedDocumentEditVersionRecord>;
  updateDocumentCurrentVersion(input: {
    documentId: string;
    versionId: string;
  }): Promise<void>;
  countRemainingPendingEdits(documentId: string): Promise<number>;
  rollbackEditResolution?(input: {
    editId: string;
    status: DocumentEditResolutionStatus;
  }): Promise<void>;
  cleanupVersion?(input: {
    versionId: string | null;
    storagePath: string;
  }): Promise<void>;
};

export type CommitResolvedDocumentEditVersionResult =
  | {
      committed: true;
      version: ResolvedDocumentEditVersionRecord;
      remainingPending: number;
    }
  | { committed: false; alreadyResolved: true };

export const DOCX_RESOLUTION_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export function statusForEditResolutionMode(mode: "accept" | "reject") {
  return mode === "accept" ? "accepted" : "rejected";
}

export function docxResolutionFilename(filename: string | null | undefined) {
  const trimmed = filename?.trim() || "Untitled document.docx";
  if (/\.docx$/i.test(trimmed)) return trimmed;
  const withoutExtension = trimmed.replace(/\.[^./\\]+$/, "").trim();
  return `${withoutExtension || "Untitled document"}.docx`;
}

export async function commitResolvedDocumentEditVersion(
  params: {
    documentId: string;
    editId: string;
    status: DocumentEditResolutionStatus;
    resolvedAt: string;
    filename: string | null | undefined;
    storagePath: string;
    bytes: Buffer;
  },
  deps: CommitResolvedDocumentEditVersionDeps,
): Promise<CommitResolvedDocumentEditVersionResult> {
  const claimed = await deps.claimPendingEditResolution({
    editId: params.editId,
    status: params.status,
    resolvedAt: params.resolvedAt,
  });
  if (!claimed) return { committed: false, alreadyResolved: true };

  let insertedVersion: ResolvedDocumentEditVersionRecord | null = null;
  try {
    const versionNumber = await deps.getNextVersionNumber(params.documentId);
    const filename = docxResolutionFilename(params.filename);
    await deps.uploadVersionBytes({
      storagePath: params.storagePath,
      bytes: params.bytes,
      contentType: DOCX_RESOLUTION_CONTENT_TYPE,
    });
    insertedVersion = await deps.insertDocumentVersion({
      document_id: params.documentId,
      storage_path: params.storagePath,
      pdf_storage_path: null,
      source: "assistant_edit",
      version_number: versionNumber,
      filename,
      file_type: "docx",
      size_bytes: params.bytes.byteLength,
      page_count: null,
    });
    await deps.updateDocumentCurrentVersion({
      documentId: params.documentId,
      versionId: insertedVersion.id,
    });
    const remainingPending = await deps.countRemainingPendingEdits(
      params.documentId,
    );
    return {
      committed: true,
      version: insertedVersion,
      remainingPending,
    };
  } catch (error) {
    await deps
      .cleanupVersion?.({
        versionId: insertedVersion?.id ?? null,
        storagePath: params.storagePath,
      })
      .catch(() => {});
    await deps
      .rollbackEditResolution?.({
        editId: params.editId,
        status: params.status,
      })
      .catch(() => {});
    throw error;
  }
}
