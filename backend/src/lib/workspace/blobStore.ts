import type { Buffer } from "node:buffer";

/**
 * The workspace blob port deliberately deals in IDs and controlled kinds only.
 * A caller never supplies a filesystem path or an original filename.
 */
export type WorkspaceBlobKind =
  | "original"
  | "extracted_text"
  | "preview"
  | "export";

export type WorkspaceBlobLocator =
  | {
      kind: "original" | "extracted_text";
      documentId: string;
      versionId: string;
    }
  | {
      kind: "preview";
      documentId: string;
      versionId: string;
      previewId?: string;
    }
  | {
      kind: "export";
      exportId: string;
    };

export type BlobIntegrity = {
  sha256: string;
  size: number;
};

export type StoredWorkspaceBlob = BlobIntegrity & {
  locator: WorkspaceBlobLocator;
  storedSize: number;
};

export type WorkspaceBlobCodecPurpose = "source_document" | "local_export";

export type WorkspaceBlobCodec = {
  /** `false` is permitted only when explicitly injected by a test. */
  readonly encrypted: boolean;
  encode(args: {
    filePath: string;
    plaintext: Buffer;
    purpose: WorkspaceBlobCodecPurpose;
  }): Buffer;
  decode(args: {
    filePath: string;
    envelope: Buffer;
    purpose: WorkspaceBlobCodecPurpose;
  }): Buffer;
};

export type WorkspaceBlobDeleteReceipt = {
  status: "staged";
  locator: WorkspaceBlobLocator;
  quarantineId: string;
};

export interface BlobStore {
  putSync(
    locator: WorkspaceBlobLocator,
    plaintext: Buffer | string,
  ): StoredWorkspaceBlob;
  readSync(locator: WorkspaceBlobLocator, expected: BlobIntegrity): Buffer;
  stageDeleteSync(locator: WorkspaceBlobLocator): WorkspaceBlobDeleteReceipt;
  finalizeDeleteSync(receipt: WorkspaceBlobDeleteReceipt): void;
  restoreDeleteSync(receipt: WorkspaceBlobDeleteReceipt): void;
}
