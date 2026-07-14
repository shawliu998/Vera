import {
  Buffer,
} from "node:buffer";
import {
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import {
  applicationEncryptionMode,
  decryptLocalBuffer,
  encryptLocalBuffer,
  type LocalFilePurpose,
} from "../aletheia/localEnvelopeCrypto";
import type {
  BlobIntegrity,
  BlobStore,
  StoredWorkspaceBlob,
  WorkspaceBlobCodec,
  WorkspaceBlobCodecPurpose,
  WorkspaceBlobDeleteReceipt,
  WorkspaceBlobLocator,
} from "./blobStore";

const OWNER_DIRECTORY_MODE = 0o700;
const OWNER_FILE_MODE = 0o600;
const RFC4122_UUID_V1_TO_V8 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class WorkspaceBlobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceBlobError";
  }
}

export class WorkspaceBlobConfigurationError extends WorkspaceBlobError {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceBlobConfigurationError";
  }
}

export class WorkspaceBlobUnsafePathError extends WorkspaceBlobError {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceBlobUnsafePathError";
  }
}

export class WorkspaceBlobAlreadyExistsError extends WorkspaceBlobError {
  constructor(locator: WorkspaceBlobLocator) {
    super(`Workspace blob already exists for kind ${locator.kind}.`);
    this.name = "WorkspaceBlobAlreadyExistsError";
  }
}

export class WorkspaceBlobNotFoundError extends WorkspaceBlobError {
  constructor(locator: WorkspaceBlobLocator) {
    super(`Workspace blob was not found for kind ${locator.kind}.`);
    this.name = "WorkspaceBlobNotFoundError";
  }
}

export class WorkspaceBlobIntegrityError extends WorkspaceBlobError {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceBlobIntegrityError";
  }
}

export class LocalEnvelopeWorkspaceBlobCodec implements WorkspaceBlobCodec {
  readonly encrypted = true;

  private purpose(purpose: WorkspaceBlobCodecPurpose): LocalFilePurpose {
    return purpose === "local_export" ? "local_export" : "source_document";
  }

  private requireEncryption() {
    if (applicationEncryptionMode() !== "required") {
      throw new WorkspaceBlobConfigurationError(
        "Workspace blobs require application encryption; configure the existing local envelope master key before using the production codec.",
      );
    }
  }

  encode(args: {
    filePath: string;
    plaintext: Buffer;
    purpose: WorkspaceBlobCodecPurpose;
  }) {
    this.requireEncryption();
    return encryptLocalBuffer({
      filePath: args.filePath,
      plaintext: args.plaintext,
      purpose: this.purpose(args.purpose),
    });
  }

  decode(args: {
    filePath: string;
    envelope: Buffer;
    purpose: WorkspaceBlobCodecPurpose;
  }) {
    this.requireEncryption();
    return decryptLocalBuffer({
      filePath: args.filePath,
      envelope: args.envelope,
      purpose: this.purpose(args.purpose),
    });
  }
}

export type LocalWorkspaceBlobStoreOptions = {
  root: string;
  codec?: WorkspaceBlobCodec;
  /** Only focused tests may opt into an explicitly injected plaintext codec. */
  allowUnencryptedCodec?: boolean;
};

function isUuid(value: unknown): value is string {
  return typeof value === "string" && RFC4122_UUID_V1_TO_V8.test(value);
}

function assertUuid(value: unknown, label: string): asserts value is string {
  if (!isUuid(value)) {
    throw new WorkspaceBlobUnsafePathError(
      `${label} must be an RFC 4122 UUID (version 1-8).`,
    );
  }
}

function hash(plaintext: Buffer) {
  return createHash("sha256").update(plaintext).digest("hex");
}

export class LocalWorkspaceBlobStore implements BlobStore {
  readonly root: string;
  private readonly codec: WorkspaceBlobCodec;

  constructor(options: LocalWorkspaceBlobStoreOptions) {
    if (!path.isAbsolute(options.root)) {
      throw new WorkspaceBlobConfigurationError(
        "Workspace blob root must be an absolute path.",
      );
    }
    this.root = path.resolve(options.root);
    if (!options.codec && applicationEncryptionMode() !== "required") {
      throw new WorkspaceBlobConfigurationError(
        "The production workspace blob store requires application encryption at construction time.",
      );
    }
    this.codec = options.codec ?? new LocalEnvelopeWorkspaceBlobCodec();
    if (!this.codec.encrypted && !options.allowUnencryptedCodec) {
      throw new WorkspaceBlobConfigurationError(
        "An unencrypted workspace blob codec must be explicitly marked as a test injection.",
      );
    }
    this.ensureRoot();
  }

  putSync(
    locator: WorkspaceBlobLocator,
    plaintext: Buffer | string,
  ): StoredWorkspaceBlob {
    this.validateLocator(locator);
    const bytes = Buffer.isBuffer(plaintext)
      ? Buffer.from(plaintext)
      : Buffer.from(plaintext, "utf8");
    const target = this.authoritativePath(locator);
    const parent = path.dirname(target);
    this.ensureDirectory(parent);
    if (this.entryExists(target)) {
      this.assertRegularUnlinkedFile(target);
      throw new WorkspaceBlobAlreadyExistsError(locator);
    }

    const purpose = this.codecPurpose(locator);
    const encoded = this.codec.encode({
      filePath: target,
      plaintext: bytes,
      purpose,
    });
    const temporaryPath = path.join(
      parent,
      `.${path.basename(target)}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`,
    );
    let temporaryFd: number | undefined;
    let published = false;
    try {
      temporaryFd = openSync(
        temporaryPath,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
        OWNER_FILE_MODE,
      );
      let offset = 0;
      while (offset < encoded.length) {
        offset += writeSync(temporaryFd, encoded, offset, encoded.length - offset);
      }
      fsyncSync(temporaryFd);
      closeSync(temporaryFd);
      temporaryFd = undefined;
      chmodSync(temporaryPath, OWNER_FILE_MODE);

      // linkSync is the no-clobber publication primitive: renameSync would
      // replace a concurrently-created authoritative blob.
      linkSync(temporaryPath, target);
      published = true;
      this.fsyncFile(target);
      unlinkSync(temporaryPath);
      this.fsyncDirectory(parent);
      published = false;
    } catch (error) {
      if (temporaryFd !== undefined) {
        try {
          closeSync(temporaryFd);
        } catch {
          // Preserve the original write error.
        }
      }
      if (published) {
        try {
          unlinkSync(target);
          this.fsyncDirectory(parent);
        } catch {
          // A failed cleanup remains fail-closed; read rejects hardlinks and
          // callers can recover the staged file explicitly.
        }
      }
      try {
        unlinkSync(temporaryPath);
      } catch {
        // The temp file may already have been unlinked after publication.
      }
      if (this.isAlreadyExistsError(error)) {
        throw new WorkspaceBlobAlreadyExistsError(locator);
      }
      throw error;
    }

    return {
      locator,
      sha256: hash(bytes),
      size: bytes.length,
      storedSize: encoded.length,
    };
  }

  readSync(locator: WorkspaceBlobLocator, expected: BlobIntegrity): Buffer {
    this.validateLocator(locator);
    this.validateIntegrity(expected);
    const target = this.authoritativePath(locator);
    this.ensureDirectory(path.dirname(target));
    const encoded = this.readAuthoritativeFile(target, locator);
    const plaintext = this.codec.decode({
      filePath: target,
      envelope: encoded,
      purpose: this.codecPurpose(locator),
    });
    const actual = { sha256: hash(plaintext), size: plaintext.length };
    if (actual.sha256 !== expected.sha256 || actual.size !== expected.size) {
      throw new WorkspaceBlobIntegrityError(
        "Workspace blob plaintext hash or size does not match authoritative metadata.",
      );
    }
    return plaintext;
  }

  stageDeleteSync(locator: WorkspaceBlobLocator): WorkspaceBlobDeleteReceipt {
    this.validateLocator(locator);
    const target = this.authoritativePath(locator);
    const parent = path.dirname(target);
    this.ensureDirectory(parent);
    if (!this.entryExists(target)) throw new WorkspaceBlobNotFoundError(locator);
    this.assertRegularUnlinkedFile(target);
    const quarantineDir = path.join(this.root, ".quarantine");
    this.ensureDirectory(quarantineDir);
    const quarantineId = this.newQuarantineId(quarantineDir);
    const quarantinePath = path.join(quarantineDir, quarantineId);
    let linked = false;
    try {
      linkSync(target, quarantinePath);
      linked = true;
      this.fsyncFile(quarantinePath);
      unlinkSync(target);
      this.fsyncDirectory(parent);
      this.fsyncDirectory(quarantineDir);
    } catch (error) {
      if (linked && this.entryExists(target)) {
        try {
          unlinkSync(quarantinePath);
          this.fsyncDirectory(quarantineDir);
        } catch {
          // Keep the original and quarantine copy for explicit recovery.
        }
      }
      throw error;
    }
    return { status: "staged", locator, quarantineId };
  }

  finalizeDeleteSync(receipt: WorkspaceBlobDeleteReceipt) {
    const quarantinePath = this.validateReceipt(receipt);
    if (this.entryExists(this.authoritativePath(receipt.locator))) {
      throw new WorkspaceBlobError(
        "Cannot finalize a staged delete while the authoritative path exists.",
      );
    }
    this.assertRegularUnlinkedFile(quarantinePath);
    unlinkSync(quarantinePath);
    this.fsyncDirectory(path.dirname(quarantinePath));
  }

  restoreDeleteSync(receipt: WorkspaceBlobDeleteReceipt) {
    const quarantinePath = this.validateReceipt(receipt);
    const target = this.authoritativePath(receipt.locator);
    const parent = path.dirname(target);
    this.ensureDirectory(parent);
    if (this.entryExists(target)) {
      throw new WorkspaceBlobAlreadyExistsError(receipt.locator);
    }
    this.assertRegularUnlinkedFile(quarantinePath);
    let published = false;
    try {
      linkSync(quarantinePath, target);
      published = true;
      this.fsyncFile(target);
      unlinkSync(quarantinePath);
      this.fsyncDirectory(parent);
      this.fsyncDirectory(path.dirname(quarantinePath));
      published = false;
    } catch (error) {
      if (published) {
        try {
          unlinkSync(target);
        } catch {
          // Preserve the staged copy if cleanup cannot be completed.
        }
      }
      throw error;
    }
  }

  private validateLocator(locator: WorkspaceBlobLocator) {
    if (!locator || typeof locator !== "object") {
      throw new WorkspaceBlobUnsafePathError("Workspace blob locator is invalid.");
    }
    switch (locator.kind) {
      case "original":
      case "extracted_text":
        assertUuid(locator.documentId, "documentId");
        assertUuid(locator.versionId, "versionId");
        return;
      case "preview":
        assertUuid(locator.documentId, "documentId");
        assertUuid(locator.versionId, "versionId");
        if (locator.previewId !== undefined) {
          assertUuid(locator.previewId, "previewId");
        }
        return;
      case "export":
        assertUuid(locator.exportId, "exportId");
        return;
      default:
        throw new WorkspaceBlobUnsafePathError("Workspace blob kind is invalid.");
    }
  }

  private validateIntegrity(expected: BlobIntegrity) {
    if (
      !expected ||
      typeof expected.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(expected.sha256) ||
      !Number.isSafeInteger(expected.size) ||
      expected.size < 0
    ) {
      throw new WorkspaceBlobIntegrityError("Workspace blob integrity metadata is invalid.");
    }
  }

  private authoritativePath(locator: WorkspaceBlobLocator) {
    let candidate: string;
    if (locator.kind === "export") {
      candidate = path.join(this.root, "exports", locator.exportId);
    } else {
      const versionRoot = path.join(
        this.root,
        "documents",
        locator.documentId,
        "versions",
        locator.versionId,
      );
      if (locator.kind === "original") candidate = path.join(versionRoot, "original");
      else if (locator.kind === "extracted_text") candidate = path.join(versionRoot, "extracted");
      else {
        const previewId = "previewId" in locator ? locator.previewId : undefined;
        candidate = path.join(versionRoot, "preview", previewId ?? "default");
      }
    }
    return this.assertInsideRoot(candidate);
  }

  private codecPurpose(locator: WorkspaceBlobLocator): WorkspaceBlobCodecPurpose {
    return locator.kind === "export" ? "local_export" : "source_document";
  }

  private ensureRoot() {
    if (this.entryExists(this.root)) {
      this.assertDirectory(this.root);
    } else {
      mkdirSync(this.root, { recursive: true, mode: OWNER_DIRECTORY_MODE });
    }
    chmodSync(this.root, OWNER_DIRECTORY_MODE);
    this.assertDirectory(this.root);
  }

  private ensureDirectory(directory: string) {
    const resolved = this.assertInsideRoot(directory);
    const relative = path.relative(this.root, resolved);
    let current = this.root;
    for (const segment of relative ? relative.split(path.sep) : []) {
      current = path.join(current, segment);
      if (this.entryExists(current)) {
        this.assertDirectory(current);
      } else {
        mkdirSync(current, { mode: OWNER_DIRECTORY_MODE });
      }
      chmodSync(current, OWNER_DIRECTORY_MODE);
    }
    this.assertDirectory(resolved);
  }

  private assertDirectory(directory: string) {
    const entry = lstatSync(directory);
    if (entry.isSymbolicLink()) {
      throw new WorkspaceBlobUnsafePathError("Workspace blob directory cannot be a symlink.");
    }
    if (!entry.isDirectory()) {
      throw new WorkspaceBlobUnsafePathError("Workspace blob path component is not a directory.");
    }
  }

  private assertRegularUnlinkedFile(filePath: string) {
    const entry = lstatSync(filePath);
    if (entry.isSymbolicLink()) {
      throw new WorkspaceBlobUnsafePathError("Workspace blob file cannot be a symlink.");
    }
    if (!entry.isFile()) {
      throw new WorkspaceBlobUnsafePathError("Workspace blob target is not a regular file.");
    }
    if (entry.nlink !== 1) {
      throw new WorkspaceBlobUnsafePathError("Workspace blob hardlinks are not accepted.");
    }
  }

  private entryExists(filePath: string) {
    try {
      lstatSync(filePath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false;
      throw error;
    }
  }

  private readAuthoritativeFile(filePath: string, locator: WorkspaceBlobLocator) {
    let fd: number | undefined;
    try {
      const noFollow = fsConstants.O_NOFOLLOW ?? 0;
      fd = openSync(filePath, fsConstants.O_RDONLY | noFollow);
      const entry = fstatSync(fd);
      if (!entry.isFile() || entry.nlink !== 1) {
        throw new WorkspaceBlobUnsafePathError(
          "Workspace blob authoritative file must be a single-link regular file.",
        );
      }
      return readFileSync(fd);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        throw new WorkspaceBlobNotFoundError(locator);
      }
      throw error;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  private fsyncFile(filePath: string) {
    const fd = openSync(filePath, fsConstants.O_RDONLY);
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  private fsyncDirectory(directory: string) {
    if (process.platform === "win32") return;
    const fd = openSync(directory, fsConstants.O_RDONLY);
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  private assertInsideRoot(candidate: string) {
    const resolved = path.resolve(candidate);
    const relative = path.relative(this.root, resolved);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new WorkspaceBlobUnsafePathError("Workspace blob path escaped its root.");
    }
    return resolved;
  }

  private newQuarantineId(quarantineDir: string) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const id = randomUUID();
      if (!this.entryExists(path.join(quarantineDir, id))) return id;
    }
    throw new WorkspaceBlobError("Unable to allocate a unique quarantine ID.");
  }

  private validateReceipt(receipt: WorkspaceBlobDeleteReceipt) {
    if (!receipt || receipt.status !== "staged") {
      throw new WorkspaceBlobUnsafePathError("Workspace blob delete receipt is invalid.");
    }
    this.validateLocator(receipt.locator);
    assertUuid(receipt.quarantineId, "quarantineId");
    const quarantinePath = this.assertInsideRoot(
      path.join(this.root, ".quarantine", receipt.quarantineId),
    );
    this.ensureDirectory(path.dirname(quarantinePath));
    return quarantinePath;
  }

  private isAlreadyExistsError(error: unknown) {
    return (error as NodeJS.ErrnoException)?.code === "EEXIST";
  }
}
