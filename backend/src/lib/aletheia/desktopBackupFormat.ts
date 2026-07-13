import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmod, mkdir, open, rename, rm, stat } from "node:fs/promises";
import { constants, createWriteStream } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";

export const BACKUP_FORMAT = "aletheia-desktop-backup-v1";
export const BACKUP_MAGIC = Buffer.from("ALETHEIA_BACKUP\0", "ascii");
export const BACKUP_VERSION = 1;
export const BACKUP_NONCE_BYTES = 12;
export const BACKUP_TAG_BYTES = 16;
export const BACKUP_HEADER_BYTES =
  BACKUP_MAGIC.length + 2 + 1 + 1 + BACKUP_NONCE_BYTES;

export class BackupFormatError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BackupFormatError";
  }
}

export function decodeBackupKey(encoded: string | undefined): Buffer {
  const value = encoded?.trim();
  if (!value || !/^[A-Za-z0-9+/]{43}=$/.test(value)) {
    throw new BackupFormatError(
      "INVALID_KEY",
      "The backup key must be a base64-encoded 32-byte value.",
    );
  }
  const key = Buffer.from(value, "base64");
  if (key.length !== 32 || key.toString("base64") !== value) {
    throw new BackupFormatError(
      "INVALID_KEY",
      "The backup key must be a base64-encoded 32-byte value.",
    );
  }
  return key;
}

function buildHeader(nonce: Buffer) {
  const header = Buffer.alloc(BACKUP_HEADER_BYTES);
  BACKUP_MAGIC.copy(header, 0);
  let offset = BACKUP_MAGIC.length;
  header.writeUInt16BE(BACKUP_VERSION, offset);
  offset += 2;
  header[offset] = BACKUP_NONCE_BYTES;
  header[offset + 1] = BACKUP_TAG_BYTES;
  nonce.copy(header, offset + 2);
  return header;
}

async function syncDirectory(directory: string) {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function encryptTarStreamAtomic(args: {
  input: Readable;
  outputPath: string;
  key: Buffer;
  beforeCommit?: () => Promise<void>;
}) {
  const outputDirectory = path.dirname(args.outputPath);
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(
    outputDirectory,
    `.${path.basename(args.outputPath)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  const nonce = randomBytes(BACKUP_NONCE_BYTES);
  const header = buildHeader(nonce);
  const cipher = createCipheriv("aes-256-gcm", args.key, nonce, {
    authTagLength: BACKUP_TAG_BYTES,
  });
  cipher.setAAD(header);

  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.write(header, 0, header.length, 0);
    await handle.close();
    handle = undefined;
    const output = createWriteStream(temporaryPath, {
      flags: "r+",
      start: header.length,
    });
    await pipeline(args.input, cipher, output);
    handle = await open(temporaryPath, "r+");
    const encryptedSize = (await handle.stat()).size;
    const tag = cipher.getAuthTag();
    await handle.write(tag, 0, tag.length, encryptedSize);
    await handle.chmod(0o600);
    await handle.sync();
    if (args.beforeCommit) await args.beforeCommit();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, args.outputPath);
    await chmod(args.outputPath, 0o600);
    await syncDirectory(outputDirectory);
    return (await stat(args.outputPath)).size;
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function validateHeader(header: Buffer) {
  if (header.length !== BACKUP_HEADER_BYTES) {
    throw new BackupFormatError(
      "INVALID_FORMAT",
      "The backup header is incomplete.",
    );
  }
  if (!header.subarray(0, BACKUP_MAGIC.length).equals(BACKUP_MAGIC)) {
    throw new BackupFormatError(
      "INVALID_FORMAT",
      "The backup magic is invalid.",
    );
  }
  let offset = BACKUP_MAGIC.length;
  if (header.readUInt16BE(offset) !== BACKUP_VERSION) {
    throw new BackupFormatError(
      "UNSUPPORTED_VERSION",
      "The backup format version is not supported.",
    );
  }
  offset += 2;
  if (
    header[offset] !== BACKUP_NONCE_BYTES ||
    header[offset + 1] !== BACKUP_TAG_BYTES
  ) {
    throw new BackupFormatError(
      "INVALID_FORMAT",
      "The backup header is invalid.",
    );
  }
}

export async function decryptBackupToTar(args: {
  inputPath: string;
  outputPath: string;
  key: Buffer;
}) {
  const inputHandle = await open(
    args.inputPath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  let outputHandle;
  try {
    const inputInfo = await inputHandle.stat();
    if (
      !inputInfo.isFile() ||
      inputInfo.size <= BACKUP_HEADER_BYTES + BACKUP_TAG_BYTES
    ) {
      throw new BackupFormatError(
        "INVALID_FORMAT",
        "The backup file is invalid.",
      );
    }
    const header = Buffer.alloc(BACKUP_HEADER_BYTES);
    const headerRead = await inputHandle.read(header, 0, header.length, 0);
    if (headerRead.bytesRead !== header.length) {
      throw new BackupFormatError(
        "INVALID_FORMAT",
        "The backup header is incomplete.",
      );
    }
    validateHeader(header);
    const tag = Buffer.alloc(BACKUP_TAG_BYTES);
    const tagRead = await inputHandle.read(
      tag,
      0,
      tag.length,
      inputInfo.size - BACKUP_TAG_BYTES,
    );
    if (tagRead.bytesRead !== tag.length) {
      throw new BackupFormatError(
        "INVALID_FORMAT",
        "The backup tag is incomplete.",
      );
    }
    const nonceOffset = BACKUP_HEADER_BYTES - BACKUP_NONCE_BYTES;
    const nonce = header.subarray(nonceOffset);
    const decipher = createDecipheriv("aes-256-gcm", args.key, nonce, {
      authTagLength: BACKUP_TAG_BYTES,
    });
    decipher.setAAD(header);
    decipher.setAuthTag(tag);

    outputHandle = await open(args.outputPath, "wx", 0o600);
    await outputHandle.close();
    outputHandle = undefined;
    const input = inputHandle.createReadStream({
      start: BACKUP_HEADER_BYTES,
      end: inputInfo.size - BACKUP_TAG_BYTES - 1,
    });
    const output = createWriteStream(args.outputPath, { flags: "r+" });
    try {
      await pipeline(input, decipher, output);
    } catch {
      throw new BackupFormatError(
        "AUTHENTICATION_FAILED",
        "Backup authentication failed.",
      );
    }
    outputHandle = await open(args.outputPath, "r+");
    await outputHandle.chmod(0o600);
    await outputHandle.sync();
    return (await outputHandle.stat()).size;
  } finally {
    await inputHandle.close().catch(() => undefined);
    if (outputHandle) await outputHandle.close().catch(() => undefined);
  }
}
