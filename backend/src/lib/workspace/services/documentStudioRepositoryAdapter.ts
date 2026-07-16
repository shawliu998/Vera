import type {
  StudioDocumentV12,
  StudioDocumentVersionV12,
  StudioVersionCommitV12,
} from "../documentStudioContractsV12";
import { workspaceBlobStorageKey } from "../repositories/blobRecords";
import {
  WorkspaceDocumentStudioRepositoryError,
  type WorkspaceDocumentStudioRepository,
} from "../repositories/documentStudio";
import type { WorkspaceSourceFoundationRepository } from "../repositories/sourceFoundation";
import { WorkspaceSourceRetentionServiceError } from "./sourceRetention";
import type { WorkspaceSourceRetentionService } from "./sourceRetention";
import type { Document, DocumentVersion } from "../types";
import type {
  DocumentStudioAcceptSuggestionPersistenceInput,
  DocumentStudioCitationAnchor,
  DocumentStudioCommitPersistenceInput,
  DocumentStudioCreateSuggestionPersistenceInput,
  DocumentStudioCreatePersistenceInput,
  DocumentStudioPersistenceResult,
  DocumentStudioRestorePersistenceInput,
  DocumentStudioSuggestionAcceptancePersistenceResult,
  WorkspaceDocumentStudioRepositoryPort,
} from "./documentStudio";
import type {
  DocumentStudioSuggestionPreviewPageV14,
  DocumentStudioSuggestionV14,
} from "../documentStudioSuggestionContractsV14";

function invalid(message: string): never {
  throw new WorkspaceDocumentStudioRepositoryError(
    "DOCUMENT_STUDIO_INVALID_INPUT",
    message,
  );
}

function persistenceFailed(message: string): never {
  throw new WorkspaceDocumentStudioRepositoryError(
    "DOCUMENT_STUDIO_PERSISTENCE_FAILED",
    message,
  );
}

function retentionBlocked(error: unknown): never {
  if (
    error instanceof WorkspaceSourceRetentionServiceError &&
    error.code === "SOURCE_RETENTION_NOT_FOUND"
  ) {
    throw new WorkspaceDocumentStudioRepositoryError(
      "DOCUMENT_STUDIO_NOT_FOUND",
      "A cited Studio source was not found in this Project.",
      { cause: error },
    );
  }
  throw new WorkspaceDocumentStudioRepositoryError(
    "DOCUMENT_STUDIO_RETENTION_BLOCKED",
    "A cited source is unavailable under its retention policy.",
    error instanceof Error ? { cause: error } : undefined,
  );
}

function mapDocument(value: StudioDocumentV12): Document {
  return {
    id: value.id,
    projectId: value.projectId,
    folderId: value.folderId,
    title: value.title,
    filename: value.filename,
    mimeType: value.mimeType,
    sizeBytes: value.sizeBytes,
    status: value.parseStatus,
    currentVersionId: value.currentVersionId,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function mapVersion(value: StudioDocumentVersionV12): DocumentVersion {
  return {
    id: value.id,
    documentId: value.documentId,
    versionNumber: value.versionNumber,
    source: value.source,
    filename: value.filename,
    mimeType: value.mimeType,
    sizeBytes: value.sizeBytes,
    contentSha256: value.contentSha256,
    pageCount: value.pageCount,
    createdAt: value.createdAt,
  };
}

function mapCommit(
  value: StudioVersionCommitV12,
): DocumentStudioPersistenceResult {
  return {
    document: mapDocument(value.document),
    version: mapVersion(value.version),
    job: { id: value.jobId },
  };
}

function assertPreparedBlob(
  input: Pick<
    DocumentStudioCommitPersistenceInput,
    | "documentId"
    | "versionId"
    | "mimeType"
    | "sizeBytes"
    | "contentSha256"
    | "storageKey"
    | "blobRecord"
  >,
) {
  const locator = {
    kind: "original" as const,
    documentId: input.documentId,
    versionId: input.versionId,
  };
  const expectedStorageKey = workspaceBlobStorageKey(locator);
  if (
    input.mimeType !== "text/markdown" ||
    input.storageKey !== expectedStorageKey ||
    input.blobRecord.locator.kind !== "original" ||
    input.blobRecord.locator.documentId !== input.documentId ||
    input.blobRecord.locator.versionId !== input.versionId ||
    input.blobRecord.contentSha256 !== input.contentSha256 ||
    input.blobRecord.sizeBytes !== input.sizeBytes
  ) {
    invalid("Prepared Studio blob metadata is inconsistent.");
  }
}

/**
 * Adapts the v12 repository projection to the service's narrow persistence
 * port. No SQL crosses this boundary; full citation anchors are resolved only
 * through the immutable v11 source repository.
 */
export class WorkspaceDocumentStudioRepositoryAdapter implements WorkspaceDocumentStudioRepositoryPort {
  constructor(
    private readonly studio: WorkspaceDocumentStudioRepository,
    private readonly sources: Pick<
      WorkspaceSourceFoundationRepository,
      "getCitationAnchor"
    >,
    private readonly retention: Pick<
      WorkspaceSourceRetentionService,
      | "assertStudioAnchorBindings"
      | "assertStudioVersionAction"
      | "readAnchorQuote"
    >,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  private assertRetentionBindings(projectId: string, anchorIds: string[]) {
    try {
      this.retention.assertStudioAnchorBindings({ projectId, anchorIds });
    } catch (error) {
      if (error instanceof WorkspaceSourceRetentionServiceError) {
        retentionBlocked(error);
      }
      throw error;
    }
  }

  private assertSuggestionPayloadRead(
    projectId: string,
    documentId: string,
    versionId: string,
  ) {
    try {
      this.retention.assertStudioVersionAction({
        projectId,
        documentId,
        versionId,
        action: "derived_payload_read",
      });
    } catch (error) {
      if (error instanceof WorkspaceSourceRetentionServiceError) {
        retentionBlocked(error);
      }
      throw error;
    }
  }

  getProjectDocument(projectId: string, documentId: string): Document | null {
    const result = this.studio.getProjectDocument(projectId, documentId);
    return result ? mapDocument(result.document) : null;
  }

  getVersion(
    projectId: string,
    documentId: string,
    versionId: string,
  ): DocumentVersion | null {
    const result = this.studio.getVersion(projectId, documentId, versionId);
    return result ? mapVersion(result) : null;
  }

  listVersions(projectId: string, documentId: string): DocumentVersion[] {
    return this.studio
      .listVersions(projectId, documentId)
      .map((version) => mapVersion(version));
  }

  createMarkdownDraft(
    input: DocumentStudioCreatePersistenceInput,
  ): DocumentStudioPersistenceResult {
    assertPreparedBlob(input);
    this.assertRetentionBindings(input.projectId, input.citationAnchorIds);
    return mapCommit(
      this.studio.createMarkdownDraft({
        projectId: input.projectId,
        documentId: input.documentId,
        versionId: input.versionId,
        jobId: input.jobId,
        folderId: input.folderId,
        documentKind: "draft",
        title: input.title,
        filename: input.filename,
        source: input.source,
        summary: null,
        operationId: input.operationId ?? null,
        draftDocumentType: input.documentType,
        draftOriginType: input.originType,
        draftOriginRef: input.originRef,
        citationAnchorIds: input.citationAnchorIds,
        createdAt: this.now(),
        blobRecordId: input.blobRecord.id,
        contentSha256: input.contentSha256,
        sizeBytes: input.sizeBytes,
        storedSizeBytes: input.blobRecord.storedSizeBytes,
      }),
    );
  }

  commitMarkdownVersionCas(
    input: DocumentStudioCommitPersistenceInput,
  ): DocumentStudioPersistenceResult {
    assertPreparedBlob(input);
    this.assertRetentionBindings(input.projectId, input.citationAnchorIds);
    return mapCommit(
      this.studio.commitMarkdownVersionCas({
        projectId: input.projectId,
        documentId: input.documentId,
        expectedCurrentVersionId: input.expectedCurrentVersionId,
        versionId: input.versionId,
        jobId: input.jobId,
        source: input.source,
        filename: input.filename,
        summary: input.summary,
        operationId: null,
        citationAnchorIds: input.citationAnchorIds,
        createdAt: this.now(),
        blobRecordId: input.blobRecord.id,
        contentSha256: input.contentSha256,
        sizeBytes: input.sizeBytes,
        storedSizeBytes: input.blobRecord.storedSizeBytes,
      }),
    );
  }

  restoreVersionCas(
    input: DocumentStudioRestorePersistenceInput,
  ): DocumentStudioPersistenceResult {
    assertPreparedBlob(input);
    const target = this.studio.getVersion(
      input.projectId,
      input.documentId,
      input.targetVersionId,
    );
    if (!target) {
      throw new WorkspaceDocumentStudioRepositoryError(
        "DOCUMENT_STUDIO_NOT_FOUND",
        "The Studio version selected for restore was not found.",
      );
    }
    if (
      target.contentSha256 !== input.contentSha256 ||
      target.sizeBytes !== input.sizeBytes
    ) {
      persistenceFailed(
        "Prepared restore bytes do not match the immutable target version.",
      );
    }
    const inheritedCitationIds = target.citationAnchorIds;
    if (
      inheritedCitationIds.length !== input.citationAnchorIds.length ||
      inheritedCitationIds.some(
        (anchorId, index) => anchorId !== input.citationAnchorIds[index],
      )
    ) {
      persistenceFailed(
        "Prepared restore citations do not match the immutable target version.",
      );
    }
    this.assertRetentionBindings(input.projectId, input.citationAnchorIds);
    return mapCommit(
      this.studio.restoreVersionCas({
        projectId: input.projectId,
        documentId: input.documentId,
        expectedCurrentVersionId: input.expectedCurrentVersionId,
        restoreFromVersionId: input.targetVersionId,
        versionId: input.versionId,
        jobId: input.jobId,
        blobRecordId: input.blobRecord.id,
        contentSha256: input.contentSha256,
        sizeBytes: input.sizeBytes,
        storedSizeBytes: input.blobRecord.storedSizeBytes,
        summary: null,
        operationId: null,
        createdAt: this.now(),
      }),
    );
  }

  listVersionCitationAnchors(
    projectId: string,
    documentId: string,
    versionId: string,
  ): DocumentStudioCitationAnchor[] {
    return this.studio
      .listVersionCitationAnchors(projectId, documentId, versionId)
      .map((binding) => {
        let retained;
        try {
          retained = this.retention.readAnchorQuote(
            projectId,
            binding.anchorId,
          );
        } catch (error) {
          if (error instanceof WorkspaceSourceRetentionServiceError) {
            retentionBlocked(error);
          }
          throw error;
        }
        const anchor = this.sources.getCitationAnchor(
          projectId,
          binding.anchorId,
        );
        if (!anchor) {
          persistenceFailed(
            "A persisted Studio citation binding has no source anchor.",
          );
        }
        if (
          retained.id !== anchor.id ||
          retained.snapshotId !== anchor.snapshotId ||
          retained.quoteSha256 !== anchor.quoteSha256 ||
          retained.exactQuote !== anchor.exactQuote
        ) {
          persistenceFailed(
            "A persisted Studio citation failed retention integrity verification.",
          );
        }
        return {
          id: anchor.id,
          projectId: anchor.projectId,
          snapshotId: anchor.snapshotId,
          ordinal: binding.ordinal,
          exactQuote: anchor.exactQuote,
          quoteSha256: anchor.quoteSha256,
          locator: anchor.locator,
          createdAt: binding.createdAt,
        };
      });
  }

  listSuggestions(
    projectId: string,
    documentId: string,
  ): DocumentStudioSuggestionV14[] {
    const suggestions = this.studio.listSuggestions(projectId, documentId);
    for (const versionId of new Set(
      suggestions.map((suggestion) => suggestion.baseVersionId),
    )) {
      this.assertSuggestionPayloadRead(projectId, documentId, versionId);
    }
    return suggestions;
  }

  listSuggestionPreviews(
    projectId: string,
    documentId: string,
  ): DocumentStudioSuggestionPreviewPageV14 {
    const page = this.studio.listSuggestionPreviews(projectId, documentId);
    for (const versionId of new Set(
      page.suggestions.map((suggestion) => suggestion.baseVersionId),
    )) {
      this.assertSuggestionPayloadRead(projectId, documentId, versionId);
    }
    return page;
  }

  getSuggestion(
    projectId: string,
    documentId: string,
    suggestionId: string,
  ): DocumentStudioSuggestionV14 | null {
    const suggestion = this.studio.getSuggestion(
      projectId,
      documentId,
      suggestionId,
    );
    if (suggestion) {
      this.assertSuggestionPayloadRead(
        projectId,
        documentId,
        suggestion.baseVersionId,
      );
    }
    return suggestion;
  }

  createSuggestion(
    input: DocumentStudioCreateSuggestionPersistenceInput,
  ): DocumentStudioSuggestionV14 {
    this.assertSuggestionPayloadRead(
      input.projectId,
      input.documentId,
      input.baseVersionId,
    );
    return this.studio.createSuggestion({
      ...input,
      createdAt: this.now(),
    });
  }

  rejectSuggestion(
    projectId: string,
    documentId: string,
    suggestionId: string,
  ): DocumentStudioSuggestionV14 {
    const suggestion = this.studio.getSuggestion(
      projectId,
      documentId,
      suggestionId,
    );
    if (suggestion) {
      this.assertSuggestionPayloadRead(
        projectId,
        documentId,
        suggestion.baseVersionId,
      );
    }
    return this.studio.rejectSuggestion({
      projectId,
      documentId,
      suggestionId,
      resolvedAt: this.now(),
    });
  }

  acceptSuggestionCas(
    input: DocumentStudioAcceptSuggestionPersistenceInput,
  ): DocumentStudioSuggestionAcceptancePersistenceResult {
    assertPreparedBlob(input);
    this.assertSuggestionPayloadRead(
      input.projectId,
      input.documentId,
      input.expectedCurrentVersionId,
    );
    this.assertRetentionBindings(input.projectId, input.citationAnchorIds);
    const accepted = this.studio.acceptSuggestionCas({
      suggestionId: input.suggestionId,
      exactStartOffset: input.exactStartOffset,
      exactEndOffset: input.exactEndOffset,
      exactDeletedText: input.exactDeletedText,
      commit: {
        projectId: input.projectId,
        documentId: input.documentId,
        expectedCurrentVersionId: input.expectedCurrentVersionId,
        versionId: input.versionId,
        jobId: input.jobId,
        source: "user_accept",
        filename: input.filename,
        summary: input.summary,
        operationId: `studio-suggestion:${input.suggestionId}`,
        citationAnchorIds: input.citationAnchorIds,
        createdAt: this.now(),
        blobRecordId: input.blobRecord.id,
        contentSha256: input.contentSha256,
        sizeBytes: input.sizeBytes,
        storedSizeBytes: input.blobRecord.storedSizeBytes,
      },
    });
    const commit = mapCommit(accepted.commit);
    return { suggestion: accepted.suggestion, ...commit };
  }
}
