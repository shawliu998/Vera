import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  BACKUP_FORMAT,
  BackupFormatError,
  decodeBackupKey,
  decryptBackupToTar,
  encryptTarStreamAtomic,
} from "./lib/aletheia/desktopBackupFormat";

const TAR_PATH = "/usr/bin/tar";
const MANIFEST_NAME = "backup-manifest.json";
const MANIFEST_SCHEMA = "aletheia-desktop-backup-manifest-v1";
const TAR_BLOCK_BYTES = 512;
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
const MAX_PAX_BYTES = 1024 * 1024;
const PENDING_RESTORE_SCHEMA = "aletheia-pending-restore-v1";

type FileRecord = { path: string; bytes: number; sha256: string };
type DirectoryRecord = {
  path: string;
  files: number;
  bytes: number;
  sha256: string;
};
type BackupManifest = {
  schema_version: typeof MANIFEST_SCHEMA;
  created_at: string;
  hash_algorithm: "sha256";
  files: FileRecord[];
  directories: DirectoryRecord[];
  totals: { files: number; directories: number; bytes: number };
  database: FileRecord;
};
type SnapshotEntry = {
  path: string;
  kind: "file" | "directory";
  bytes: number;
  device: bigint;
  inode: bigint;
  modifiedNs: bigint;
};

export class DesktopBackupError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DesktopBackupError";
  }
}

function fail(code: string, message: string): never {
  throw new DesktopBackupError(code, message);
}

async function syncDirectory(directory: string) {
  const descriptor = await open(directory, "r");
  try {
    await descriptor.sync();
  } finally {
    await descriptor.close();
  }
}

async function writePendingRestoreRecord(args: {
  recordPath: string;
  target: string;
  rollback: string;
}) {
  const recordPath = path.resolve(args.recordPath);
  const parent = path.dirname(recordPath);
  const parentInfo = await lstat(parent).catch(() => null);
  if (!parentInfo?.isDirectory() || parentInfo.isSymbolicLink()) {
    fail("INVALID_PENDING_RECORD", "The pending restore record parent is invalid.");
  }
  const existing = await lstat(recordPath).catch(() => null);
  if (existing) {
    fail(
      "PENDING_RESTORE_EXISTS",
      "A previous restore transaction still requires recovery.",
    );
  }
  const temporary = path.join(
    parent,
    `.${path.basename(recordPath)}.tmp-${process.pid}-${randomUUID()}`,
  );
  const payload = `${JSON.stringify({
    schema: PENDING_RESTORE_SCHEMA,
    target: args.target,
    rollback: args.rollback,
    createdAt: new Date().toISOString(),
  })}\n`;
  try {
    await writeFile(temporary, payload, { encoding: "utf8", mode: 0o600 });
    await chmod(temporary, 0o600);
    const descriptor = await open(temporary, "r");
    try {
      await descriptor.sync();
    } finally {
      await descriptor.close();
    }
    await rename(temporary, recordPath);
    await syncDirectory(parent);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function clearPendingRestoreRecord(recordPath: string) {
  const resolved = path.resolve(recordPath);
  await rm(resolved, { force: true });
  await syncDirectory(path.dirname(resolved));
}

function isInside(parent: string, candidate: string) {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

async function canonicalCreationPath(target: string) {
  const missing: string[] = [];
  let cursor = path.resolve(target);
  while (true) {
    try {
      const existing = await realpath(cursor);
      return path.join(existing, ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      missing.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

async function hashFile(filePath: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath))
    hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function safeNumber(value: bigint, code = "SOURCE_TOO_LARGE") {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail(code, "A file size exceeds the supported range.");
  }
  return Number(value);
}

async function scanSource(source: string) {
  const files: FileRecord[] = [];
  const directories: string[] = [];
  const snapshot: SnapshotEntry[] = [];

  async function visit(relativeDirectory: string): Promise<void> {
    const absoluteDirectory = relativeDirectory
      ? path.join(source, ...relativeDirectory.split("/"))
      : source;
    const entries = await readdir(absoluteDirectory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      if (relativePath === MANIFEST_NAME) {
        fail("RESERVED_PATH", "The source contains a reserved backup path.");
      }
      const absolutePath = path.join(absoluteDirectory, entry.name);
      const before = await lstat(absolutePath, { bigint: true });
      if (before.isSymbolicLink()) {
        fail("SYMLINK_REJECTED", "The source contains a symbolic link.");
      }
      if (before.isDirectory()) {
        directories.push(relativePath);
        snapshot.push({
          path: relativePath,
          kind: "directory",
          bytes: 0,
          device: before.dev,
          inode: before.ino,
          modifiedNs: before.mtimeNs,
        });
        await visit(relativePath);
        continue;
      }
      if (!before.isFile()) {
        fail(
          "SPECIAL_FILE_REJECTED",
          "The source contains a non-regular file.",
        );
      }
      if (before.nlink !== 1n) {
        fail("HARDLINK_REJECTED", "The source contains a hard-linked file.");
      }
      const bytes = safeNumber(before.size);
      const sha256 = await hashFile(absolutePath);
      const after = await lstat(absolutePath, { bigint: true });
      if (
        !after.isFile() ||
        after.isSymbolicLink() ||
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        after.size !== before.size ||
        after.mtimeNs !== before.mtimeNs
      ) {
        fail("SOURCE_CHANGED", "The source changed while it was being read.");
      }
      files.push({ path: relativePath, bytes, sha256 });
      snapshot.push({
        path: relativePath,
        kind: "file",
        bytes,
        device: before.dev,
        inode: before.ino,
        modifiedNs: before.mtimeNs,
      });
    }
  }

  await visit("");
  files.sort((left, right) => left.path.localeCompare(right.path, "en"));
  directories.sort((left, right) => left.localeCompare(right, "en"));
  snapshot.sort((left, right) => left.path.localeCompare(right.path, "en"));
  if (files.length === 0) fail("EMPTY_SOURCE", "The source contains no files.");
  return { files, directories, snapshot };
}

function addBytes(total: number, value: number, code: string) {
  if (total > Number.MAX_SAFE_INTEGER - value) {
    fail(code, "The aggregate backup size exceeds the supported range.");
  }
  return total + value;
}

function directoryRecords(
  directories: string[],
  files: FileRecord[],
  errorCode: string,
) {
  const states = new Map(
    directories.map((directory) => [
      directory,
      { hash: createHash("sha256"), files: 0, bytes: 0 },
    ]),
  );
  for (const file of files) {
    const parts = file.path.split("/");
    for (let depth = 1; depth < parts.length; depth += 1) {
      const directory = parts.slice(0, depth).join("/");
      const state = states.get(directory);
      if (!state) fail(errorCode, "The backup directory tree is inconsistent.");
      const relative = parts.slice(depth).join("/");
      state.hash.update(relative, "utf8");
      state.hash.update("\0");
      state.hash.update(String(file.bytes), "ascii");
      state.hash.update("\0");
      state.hash.update(file.sha256, "ascii");
      state.hash.update("\n");
      state.files += 1;
      state.bytes = addBytes(state.bytes, file.bytes, errorCode);
    }
  }
  return directories.map((directory) => {
    const state = states.get(directory);
    if (!state) fail(errorCode, "The backup directory tree is inconsistent.");
    return {
      path: directory,
      files: state.files,
      bytes: state.bytes,
      sha256: state.hash.digest("hex"),
    };
  });
}

function buildManifest(
  files: FileRecord[],
  directories: string[],
): BackupManifest {
  const database = files.find((file) => file.path === "aletheia.db");
  if (!database) fail("MISSING_DATABASE", "The source database is missing.");
  for (const required of ["documents", "exports", "index"]) {
    if (!directories.includes(required)) {
      fail("MISSING_DIRECTORY", "A required source directory is missing.");
    }
  }
  const directorySummaries = directoryRecords(
    directories,
    files,
    "SOURCE_TOO_LARGE",
  );
  const totalBytes = files.reduce(
    (total, file) => addBytes(total, file.bytes, "SOURCE_TOO_LARGE"),
    0,
  );
  return {
    schema_version: MANIFEST_SCHEMA,
    created_at: new Date().toISOString(),
    hash_algorithm: "sha256",
    files,
    directories: directorySummaries,
    totals: {
      files: files.length,
      directories: directories.length,
      bytes: totalBytes,
    },
    database: { ...database },
  };
}

async function assertSnapshotUnchanged(
  source: string,
  expected: SnapshotEntry[],
) {
  const current = await scanMetadata(source);
  if (current.length !== expected.length) {
    fail("SOURCE_CHANGED", "The source changed while the backup was created.");
  }
  for (let index = 0; index < expected.length; index += 1) {
    const left = expected[index];
    const right = current[index];
    if (
      left.path !== right.path ||
      left.kind !== right.kind ||
      left.bytes !== right.bytes ||
      left.device !== right.device ||
      left.inode !== right.inode ||
      left.modifiedNs !== right.modifiedNs
    ) {
      fail(
        "SOURCE_CHANGED",
        "The source changed while the backup was created.",
      );
    }
  }
}

async function scanMetadata(source: string) {
  const snapshot: SnapshotEntry[] = [];
  async function visit(relativeDirectory: string): Promise<void> {
    const absolute = relativeDirectory
      ? path.join(source, ...relativeDirectory.split("/"))
      : source;
    const entries = await readdir(absolute, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      const info = await lstat(path.join(absolute, entry.name), {
        bigint: true,
      });
      if (info.isSymbolicLink()) {
        fail("SYMLINK_REJECTED", "The source contains a symbolic link.");
      }
      if (info.isDirectory()) {
        snapshot.push({
          path: relativePath,
          kind: "directory",
          bytes: 0,
          device: info.dev,
          inode: info.ino,
          modifiedNs: info.mtimeNs,
        });
        await visit(relativePath);
      } else if (info.isFile()) {
        snapshot.push({
          path: relativePath,
          kind: "file",
          bytes: safeNumber(info.size),
          device: info.dev,
          inode: info.ino,
          modifiedNs: info.mtimeNs,
        });
      } else {
        fail(
          "SPECIAL_FILE_REJECTED",
          "The source contains a non-regular file.",
        );
      }
    }
  }
  await visit("");
  return snapshot.sort((left, right) =>
    left.path.localeCompare(right.path, "en"),
  );
}

function childExit(child: ReturnType<typeof spawn>, code: string) {
  return new Promise<void>((resolve, reject) => {
    child.once("error", () =>
      reject(
        new DesktopBackupError(code, "The tar utility could not be started."),
      ),
    );
    child.once("close", (status, signal) => {
      if (status === 0 && signal === null) resolve();
      else reject(new DesktopBackupError(code, "The tar utility failed."));
    });
  });
}

export async function createBackup(args: {
  source: string;
  output: string;
  key: Buffer;
}) {
  const sourceInput = path.resolve(args.source);
  const sourceInputInfo = await lstat(sourceInput).catch(() => null);
  if (
    !sourceInputInfo ||
    sourceInputInfo.isSymbolicLink() ||
    !sourceInputInfo.isDirectory()
  ) {
    fail(
      "INVALID_SOURCE",
      "The source must be an existing non-symlink directory.",
    );
  }
  const source = await realpath(sourceInput);
  const outputInput = path.resolve(args.output);
  const outputInputInfo = await lstat(outputInput).catch(() => null);
  if (outputInputInfo?.isSymbolicLink()) {
    fail("INVALID_OUTPUT", "The output must not be a symbolic link.");
  }
  const output = path.join(
    await canonicalCreationPath(path.dirname(outputInput)),
    path.basename(outputInput),
  );
  if (isInside(source, output)) {
    fail("OUTPUT_BOUNDARY", "The output must be outside the source directory.");
  }

  const scanned = await scanSource(source);
  const manifest = buildManifest(scanned.files, scanned.directories);
  const workDirectory = await mkdtemp(
    path.join(os.tmpdir(), "aletheia-backup-create-"),
  );
  await chmod(workDirectory, 0o700);
  try {
    await writeFile(
      path.join(workDirectory, MANIFEST_NAME),
      `${JSON.stringify(manifest)}\n`,
      { mode: 0o600, flag: "wx" },
    );
    const tar = spawn(
      TAR_PATH,
      [
        "--no-xattrs",
        "--no-mac-metadata",
        "--format",
        "pax",
        "-cf",
        "-",
        "-C",
        workDirectory,
        MANIFEST_NAME,
        "-C",
        source,
        ".",
      ],
      {
        stdio: ["ignore", "pipe", "ignore"],
        env: { ...process.env, COPYFILE_DISABLE: "1" },
      },
    );
    if (!tar.stdout)
      fail("TAR_CREATE_FAILED", "The tar utility did not provide output.");
    const exit = childExit(tar, "TAR_CREATE_FAILED");
    let encryptedBytes: number;
    try {
      encryptedBytes = await encryptTarStreamAtomic({
        input: tar.stdout,
        outputPath: output,
        key: args.key,
        beforeCommit: async () => {
          await exit;
          await assertSnapshotUnchanged(source, scanned.snapshot);
        },
      });
    } catch (error) {
      if (tar.exitCode === null) tar.kill("SIGKILL");
      await exit.catch(() => undefined);
      throw error;
    }
    return {
      ok: true as const,
      action: "create" as const,
      format: BACKUP_FORMAT,
      created_at: manifest.created_at,
      files: manifest.totals.files,
      directories: manifest.totals.directories,
      plaintext_bytes: manifest.totals.bytes,
      encrypted_bytes: encryptedBytes,
    };
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
}

function decodeTarString(buffer: Buffer) {
  const end = buffer.indexOf(0);
  const bytes = end < 0 ? buffer : buffer.subarray(0, end);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("INVALID_TAR", "The tar archive contains an invalid path encoding.");
  }
}

function parseTarNumber(field: Buffer) {
  if ((field[0] & 0x80) !== 0) {
    let value = BigInt(field[0] & 0x7f);
    for (let index = 1; index < field.length; index += 1) {
      value = (value << 8n) | BigInt(field[index]);
    }
    return safeNumber(value, "INVALID_TAR");
  }
  const value = field.toString("ascii").replace(/\0.*$/, "").trim();
  if (!value) return 0;
  if (!/^[0-7]+$/.test(value))
    fail("INVALID_TAR", "The tar archive has an invalid numeric field.");
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed))
    fail("INVALID_TAR", "The tar archive has an unsupported size.");
  return parsed;
}

function validateTarChecksum(header: Buffer) {
  const expected = parseTarNumber(header.subarray(148, 156));
  let actual = 0;
  for (let index = 0; index < header.length; index += 1) {
    actual += index >= 148 && index < 156 ? 32 : header[index];
  }
  if (actual !== expected)
    fail("INVALID_TAR", "The tar archive checksum is invalid.");
}

function safeArchivePath(raw: string, directory: boolean) {
  if (!raw || raw.includes("\0") || path.posix.isAbsolute(raw)) {
    fail("UNSAFE_ARCHIVE_PATH", "The tar archive contains an unsafe path.");
  }
  let value = raw;
  while (value.startsWith("./")) value = value.slice(2);
  if (directory && value.endsWith("/")) value = value.slice(0, -1);
  if (directory && (value === "" || value === ".")) return null;
  const parts = value.split("/");
  if (
    !value ||
    (!directory && value.endsWith("/")) ||
    parts.some((part) => part === "" || part === "." || part === "..") ||
    path.posix.normalize(value) !== value
  ) {
    fail("UNSAFE_ARCHIVE_PATH", "The tar archive contains an unsafe path.");
  }
  return value;
}

async function readExact(
  handle: Awaited<ReturnType<typeof open>>,
  length: number,
  position: number,
) {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const result = await handle.read(
      buffer,
      offset,
      length - offset,
      position + offset,
    );
    if (result.bytesRead === 0)
      fail("INVALID_TAR", "The tar archive is truncated.");
    offset += result.bytesRead;
  }
  return buffer;
}

async function hashTarPayload(
  handle: Awaited<ReturnType<typeof open>>,
  position: number,
  length: number,
  collect: boolean,
) {
  const hash = createHash("sha256");
  const chunks: Buffer[] = [];
  let remaining = length;
  let offset = position;
  while (remaining > 0) {
    const chunk = await readExact(
      handle,
      Math.min(1024 * 1024, remaining),
      offset,
    );
    hash.update(chunk);
    if (collect) chunks.push(chunk);
    remaining -= chunk.length;
    offset += chunk.length;
  }
  return {
    sha256: hash.digest("hex"),
    data: collect ? Buffer.concat(chunks) : null,
  };
}

function parsePax(data: Buffer) {
  const values = new Map<string, string>();
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0)
      fail("INVALID_TAR", "The tar archive has invalid PAX metadata.");
    const lengthText = data.subarray(offset, space).toString("ascii");
    if (!/^[1-9][0-9]*$/.test(lengthText))
      fail("INVALID_TAR", "The tar archive has invalid PAX metadata.");
    const length = Number(lengthText);
    if (
      !Number.isSafeInteger(length) ||
      length <= space - offset + 2 ||
      offset + length > data.length
    ) {
      fail("INVALID_TAR", "The tar archive has invalid PAX metadata.");
    }
    const record = data.subarray(space + 1, offset + length - 1);
    if (data[offset + length - 1] !== 0x0a)
      fail("INVALID_TAR", "The tar archive has invalid PAX metadata.");
    const equals = record.indexOf(0x3d);
    if (equals <= 0)
      fail("INVALID_TAR", "The tar archive has invalid PAX metadata.");
    const key = record.subarray(0, equals).toString("ascii");
    const valueBytes = record.subarray(equals + 1);
    if (values.has(key))
      fail("INVALID_TAR", "The tar archive has duplicate PAX metadata.");
    if (/sparse/i.test(key))
      fail("UNSAFE_ENTRY_TYPE", "The tar archive contains a sparse entry.");
    if (key === "path" || key === "linkpath" || key === "size") {
      let value: string;
      try {
        value = new TextDecoder("utf-8", { fatal: true }).decode(valueBytes);
      } catch {
        fail("INVALID_TAR", "The tar archive has invalid PAX metadata.");
      }
      values.set(key, value);
    } else {
      values.set(key, "");
    }
    offset += length;
  }
  if (values.has("linkpath"))
    fail("UNSAFE_ENTRY_TYPE", "The tar archive contains a link.");
  const sizeText = values.get("size");
  let size: number | undefined;
  if (sizeText !== undefined) {
    if (!/^(0|[1-9][0-9]*)$/.test(sizeText))
      fail("INVALID_TAR", "The tar archive has invalid PAX metadata.");
    size = Number(sizeText);
    if (!Number.isSafeInteger(size))
      fail("INVALID_TAR", "The tar archive has an unsupported size.");
  }
  return { path: values.get("path"), size };
}

async function assertZeroRemainder(
  handle: Awaited<ReturnType<typeof open>>,
  position: number,
  size: number,
) {
  let offset = position;
  while (offset < size) {
    const chunk = await readExact(
      handle,
      Math.min(1024 * 1024, size - offset),
      offset,
    );
    if (chunk.some((byte) => byte !== 0))
      fail("INVALID_TAR", "The tar archive has trailing data.");
    offset += chunk.length;
  }
}

async function inspectTar(tarPath: string) {
  const handle = await open(tarPath, "r");
  try {
    const tarSize = (await handle.stat()).size;
    const files: FileRecord[] = [];
    const directories: string[] = [];
    const seen = new Set<string>();
    let manifestData: Buffer | null = null;
    let position = 0;
    let zeroBlocks = 0;
    let pendingPax: { path?: string; size?: number } | null = null;

    while (position + TAR_BLOCK_BYTES <= tarSize) {
      const header = await readExact(handle, TAR_BLOCK_BYTES, position);
      position += TAR_BLOCK_BYTES;
      if (header.every((byte) => byte === 0)) {
        zeroBlocks += 1;
        if (zeroBlocks === 2) {
          await assertZeroRemainder(handle, position, tarSize);
          break;
        }
        continue;
      }
      if (zeroBlocks > 0)
        fail("INVALID_TAR", "The tar archive has an invalid end marker.");
      validateTarChecksum(header);
      const typeByte = header[156];
      const type = typeByte === 0 ? "0" : String.fromCharCode(typeByte);
      const headerSize = parseTarNumber(header.subarray(124, 136));
      const name = decodeTarString(header.subarray(0, 100));
      const prefix = decodeTarString(header.subarray(345, 500));
      const headerPath = prefix ? `${prefix}/${name}` : name;
      let contentSize = headerSize;

      if (type === "x") {
        if (pendingPax || headerSize > MAX_PAX_BYTES)
          fail("INVALID_TAR", "The tar archive has invalid PAX metadata.");
        const payload = await hashTarPayload(
          handle,
          position,
          headerSize,
          true,
        );
        pendingPax = parsePax(payload.data ?? Buffer.alloc(0));
      } else {
        if (type !== "0" && type !== "5") {
          fail(
            "UNSAFE_ENTRY_TYPE",
            "The tar archive contains a non-regular entry.",
          );
        }
        const effectiveSize = pendingPax?.size ?? headerSize;
        contentSize = effectiveSize;
        const archivePath = safeArchivePath(
          pendingPax?.path ?? headerPath,
          type === "5",
        );
        pendingPax = null;
        if (type === "5") {
          if (effectiveSize !== 0)
            fail("INVALID_TAR", "A tar directory has content.");
          if (archivePath) {
            if (seen.has(archivePath))
              fail(
                "DUPLICATE_ENTRY",
                "The tar archive contains duplicate entries.",
              );
            seen.add(archivePath);
            directories.push(archivePath);
          }
        } else {
          if (!archivePath)
            fail(
              "UNSAFE_ARCHIVE_PATH",
              "The tar archive contains an unsafe path.",
            );
          if (seen.has(archivePath))
            fail(
              "DUPLICATE_ENTRY",
              "The tar archive contains duplicate entries.",
            );
          seen.add(archivePath);
          const collect = archivePath === MANIFEST_NAME;
          if (collect && effectiveSize > MAX_MANIFEST_BYTES)
            fail("INVALID_MANIFEST", "The backup manifest is too large.");
          const payload = await hashTarPayload(
            handle,
            position,
            effectiveSize,
            collect,
          );
          if (collect) manifestData = payload.data;
          else
            files.push({
              path: archivePath,
              bytes: effectiveSize,
              sha256: payload.sha256,
            });
        }
      }
      position += Math.ceil(contentSize / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
      if (position > tarSize)
        fail("INVALID_TAR", "The tar archive is truncated.");
    }
    if (zeroBlocks < 2 || pendingPax)
      fail("INVALID_TAR", "The tar archive is incomplete.");
    if (!manifestData)
      fail("MISSING_MANIFEST", "The backup manifest is missing.");
    files.sort((left, right) => left.path.localeCompare(right.path, "en"));
    directories.sort((left, right) => left.localeCompare(right, "en"));
    return { files, directories, manifestData };
  } finally {
    await handle.close();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function parseFileRecord(value: unknown): FileRecord {
  if (!isRecord(value) || !exactKeys(value, ["path", "bytes", "sha256"])) {
    fail("INVALID_MANIFEST", "The backup manifest has an invalid file record.");
  }
  if (
    typeof value.path !== "string" ||
    safeArchivePath(value.path, false) !== value.path ||
    !Number.isSafeInteger(value.bytes) ||
    (value.bytes as number) < 0 ||
    typeof value.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.sha256)
  ) {
    fail("INVALID_MANIFEST", "The backup manifest has an invalid file record.");
  }
  return {
    path: value.path,
    bytes: value.bytes as number,
    sha256: value.sha256,
  };
}

function parseDirectoryRecord(value: unknown): DirectoryRecord {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["path", "files", "bytes", "sha256"])
  ) {
    fail(
      "INVALID_MANIFEST",
      "The backup manifest has an invalid directory record.",
    );
  }
  const directoryPath =
    typeof value.path === "string" ? safeArchivePath(value.path, true) : null;
  if (
    !directoryPath ||
    directoryPath !== value.path ||
    !Number.isSafeInteger(value.files) ||
    (value.files as number) < 0 ||
    !Number.isSafeInteger(value.bytes) ||
    (value.bytes as number) < 0 ||
    typeof value.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.sha256)
  ) {
    fail(
      "INVALID_MANIFEST",
      "The backup manifest has an invalid directory record.",
    );
  }
  return {
    path: directoryPath,
    files: value.files as number,
    bytes: value.bytes as number,
    sha256: value.sha256,
  };
}

function parseManifest(data: Buffer): BackupManifest {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
  } catch {
    fail("INVALID_MANIFEST", "The backup manifest is not valid JSON.");
  }
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "schema_version",
      "created_at",
      "hash_algorithm",
      "files",
      "directories",
      "totals",
      "database",
    ]) ||
    value.schema_version !== MANIFEST_SCHEMA ||
    typeof value.created_at !== "string" ||
    !Number.isFinite(Date.parse(value.created_at)) ||
    value.hash_algorithm !== "sha256" ||
    !Array.isArray(value.files) ||
    !Array.isArray(value.directories) ||
    !isRecord(value.totals) ||
    !exactKeys(value.totals, ["files", "directories", "bytes"])
  ) {
    fail("INVALID_MANIFEST", "The backup manifest schema is invalid.");
  }
  const files = value.files.map(parseFileRecord);
  const directories = value.directories.map(parseDirectoryRecord);
  const database = parseFileRecord(value.database);
  const totals = value.totals;
  if (
    !Number.isSafeInteger(totals.files) ||
    !Number.isSafeInteger(totals.directories) ||
    !Number.isSafeInteger(totals.bytes)
  ) {
    fail("INVALID_MANIFEST", "The backup manifest totals are invalid.");
  }
  return {
    schema_version: MANIFEST_SCHEMA,
    created_at: value.created_at,
    hash_algorithm: "sha256",
    files,
    directories,
    totals: {
      files: totals.files as number,
      directories: totals.directories as number,
      bytes: totals.bytes as number,
    },
    database,
  };
}

function sameFile(left: FileRecord, right: FileRecord) {
  return (
    left.path === right.path &&
    left.bytes === right.bytes &&
    left.sha256 === right.sha256
  );
}

function validateManifest(
  manifest: BackupManifest,
  actualFiles: FileRecord[],
  actualDirectories: string[],
) {
  const manifestFiles = [...manifest.files].sort((left, right) =>
    left.path.localeCompare(right.path, "en"),
  );
  const manifestDirectories = [...manifest.directories].sort((left, right) =>
    left.path.localeCompare(right.path, "en"),
  );
  if (
    manifestFiles.length !== actualFiles.length ||
    manifestFiles.some((file, index) => !sameFile(file, actualFiles[index]))
  ) {
    fail(
      "MANIFEST_MISMATCH",
      "The archived file list or hash does not match the manifest.",
    );
  }
  if (
    manifestDirectories.length !== actualDirectories.length ||
    manifestDirectories.some(
      (directory, index) => directory.path !== actualDirectories[index],
    )
  ) {
    fail(
      "MANIFEST_MISMATCH",
      "The archived directory list does not match the manifest.",
    );
  }
  const actualTotalBytes = actualFiles.reduce(
    (total, file) => addBytes(total, file.bytes, "INVALID_TAR"),
    0,
  );
  if (
    manifest.totals.files !== actualFiles.length ||
    manifest.totals.directories !== actualDirectories.length ||
    manifest.totals.bytes !== actualTotalBytes
  ) {
    fail("MANIFEST_MISMATCH", "The archived totals do not match the manifest.");
  }
  const database = actualFiles.find((file) => file.path === "aletheia.db");
  if (
    !database ||
    manifest.database.path !== "aletheia.db" ||
    !sameFile(manifest.database, database)
  ) {
    fail("MISSING_DATABASE", "The required database is missing or invalid.");
  }
  for (const required of ["documents", "exports", "index"]) {
    if (!actualDirectories.includes(required)) {
      fail("MISSING_DIRECTORY", "A required backup directory is missing.");
    }
  }
  const actualDirectoryRecords = directoryRecords(
    actualDirectories,
    actualFiles,
    "INVALID_TAR",
  );
  for (let index = 0; index < manifestDirectories.length; index += 1) {
    const directory = manifestDirectories[index];
    const digest = actualDirectoryRecords[index];
    if (
      directory.files !== digest.files ||
      directory.bytes !== digest.bytes ||
      directory.sha256 !== digest.sha256
    ) {
      fail(
        "MANIFEST_MISMATCH",
        "A directory digest does not match the manifest.",
      );
    }
  }
}

async function listTar(tarPath: string) {
  const tar = spawn(TAR_PATH, ["-tf", tarPath], {
    stdio: ["ignore", "ignore", "ignore"],
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  await childExit(tar, "TAR_LIST_FAILED");
}

async function extractTar(tarPath: string, destination: string) {
  const tar = spawn(
    TAR_PATH,
    ["-xf", tarPath, "-C", destination, "--no-same-owner"],
    {
      stdio: ["ignore", "ignore", "ignore"],
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    },
  );
  await childExit(tar, "TAR_EXTRACT_FAILED");
}

export async function inspectBackup(args: { input: string; key: Buffer }) {
  const input = path.resolve(args.input);
  const inputInfo = await lstat(input).catch(() => null);
  if (!inputInfo || inputInfo.isSymbolicLink() || !inputInfo.isFile()) {
    fail("INVALID_INPUT", "The input must be an existing non-symlink file.");
  }
  const workDirectory = await mkdtemp(
    path.join(os.tmpdir(), "aletheia-backup-inspect-"),
  );
  await chmod(workDirectory, 0o700);
  const tarPath = path.join(workDirectory, "authenticated.tar");
  try {
    await decryptBackupToTar({
      inputPath: input,
      outputPath: tarPath,
      key: args.key,
    });
    const tarMode = (await stat(tarPath)).mode & 0o777;
    if (tarMode !== 0o600)
      fail(
        "TEMP_PERMISSION",
        "The authenticated temporary file is not owner-only.",
      );
    await listTar(tarPath);
    const inspected = await inspectTar(tarPath);
    const manifest = parseManifest(inspected.manifestData);
    validateManifest(manifest, inspected.files, inspected.directories);
    return {
      ok: true as const,
      action: "inspect" as const,
      format: BACKUP_FORMAT,
      manifest_schema: manifest.schema_version,
      created_at: manifest.created_at,
      files: manifest.totals.files,
      directories: manifest.totals.directories,
      plaintext_bytes: manifest.totals.bytes,
    };
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
}

export async function restoreBackup(args: {
  input: string;
  target: string;
  key: Buffer;
  pendingRecord: string;
}) {
  const input = path.resolve(args.input);
  const requestedTarget = path.resolve(args.target);
  const inputInfo = await lstat(input).catch(() => null);
  const targetInfo = await lstat(requestedTarget).catch(() => null);
  if (!inputInfo || inputInfo.isSymbolicLink() || !inputInfo.isFile()) {
    fail("INVALID_INPUT", "The input must be an existing non-symlink file.");
  }
  if (!targetInfo || targetInfo.isSymbolicLink() || !targetInfo.isDirectory()) {
    fail("INVALID_TARGET", "The restore target must be an existing directory.");
  }
  const target = await realpath(requestedTarget);
  const parent = path.dirname(target);
  const workDirectory = await mkdtemp(
    path.join(parent, ".aletheia-restore-stage-"),
  );
  await chmod(workDirectory, 0o700);
  const tarPath = path.join(workDirectory, "authenticated.tar");
  const workspace = path.join(workDirectory, "workspace");
  const rollbackPath = path.join(
    parent,
    `.aletheia-restore-rollback-${randomUUID()}`,
  );
  let targetMoved = false;
  let restored = false;
  let pendingRecordWritten = false;
  try {
    await decryptBackupToTar({
      inputPath: input,
      outputPath: tarPath,
      key: args.key,
    });
    await listTar(tarPath);
    const inspected = await inspectTar(tarPath);
    const manifest = parseManifest(inspected.manifestData);
    validateManifest(manifest, inspected.files, inspected.directories);
    await mkdir(workspace, { mode: 0o700 });
    await extractTar(tarPath, workspace);
    const extractedManifest = path.join(workspace, MANIFEST_NAME);
    const manifestInfo = await lstat(extractedManifest).catch(() => null);
    if (!manifestInfo?.isFile() || manifestInfo.isSymbolicLink()) {
      fail("MISSING_MANIFEST", "The extracted manifest is invalid.");
    }
    await unlink(extractedManifest);
    const extracted = await scanSource(workspace);
    validateManifest(manifest, extracted.files, extracted.directories);
    await writePendingRestoreRecord({
      recordPath: args.pendingRecord,
      target,
      rollback: rollbackPath,
    });
    pendingRecordWritten = true;
    await rename(target, rollbackPath);
    targetMoved = true;
    try {
      await rename(workspace, target);
      restored = true;
      await chmod(target, 0o700);
    } catch (error) {
      await rename(rollbackPath, target);
      targetMoved = false;
      await clearPendingRestoreRecord(args.pendingRecord);
      pendingRecordWritten = false;
      throw error;
    }
    return {
      ok: true as const,
      action: "restore" as const,
      format: BACKUP_FORMAT,
      created_at: manifest.created_at,
      files: manifest.totals.files,
      directories: manifest.totals.directories,
      plaintext_bytes: manifest.totals.bytes,
      rollback_path: rollbackPath,
    };
  } finally {
    if (!restored && targetMoved) {
      const reverted = await rename(rollbackPath, target)
        .then(() => true)
        .catch(() => false);
      if (reverted) {
        targetMoved = false;
        await clearPendingRestoreRecord(args.pendingRecord).catch(() => undefined);
        pendingRecordWritten = false;
      }
    } else if (!restored && pendingRecordWritten && !targetMoved) {
      await clearPendingRestoreRecord(args.pendingRecord).catch(() => undefined);
    }
    await rm(workDirectory, { recursive: true, force: true });
  }
}

function parseArguments(argv: string[]) {
  const [action, ...rest] = argv;
  if (action !== "create" && action !== "inspect" && action !== "restore") {
    fail(
      "INVALID_ARGUMENTS",
      "The action must be create, inspect, or restore.",
    );
  }
  const flags = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (
      !flag?.startsWith("--") ||
      !value ||
      value.startsWith("--") ||
      flags.has(flag)
    ) {
      fail("INVALID_ARGUMENTS", "The command arguments are invalid.");
    }
    flags.set(flag, value);
  }
  const expected =
    action === "create"
      ? ["--source", "--output", "--key-base64-env"]
      : action === "restore"
        ? ["--input", "--target", "--pending-record", "--key-base64-env"]
        : ["--input", "--key-base64-env"];
  if (
    flags.size !== expected.length ||
    expected.some((flag) => !flags.has(flag))
  ) {
    fail(
      "INVALID_ARGUMENTS",
      "The command arguments are incomplete or unsupported.",
    );
  }
  const environmentName = flags.get("--key-base64-env") as string;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(environmentName)) {
    fail("INVALID_ARGUMENTS", "The key environment variable name is invalid.");
  }
  return { action, flags, key: decodeBackupKey(process.env[environmentName]) };
}

function writeProcessLine(
  stream: NodeJS.WriteStream,
  value: Record<string, unknown>,
) {
  return new Promise<void>((resolve, reject) => {
    stream.write(`${JSON.stringify(value)}\n`, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function main() {
  try {
    const parsed = parseArguments(process.argv.slice(2));
    const result =
      parsed.action === "create"
        ? await createBackup({
            source: parsed.flags.get("--source") as string,
            output: parsed.flags.get("--output") as string,
            key: parsed.key,
          })
        : parsed.action === "restore"
          ? await restoreBackup({
              input: parsed.flags.get("--input") as string,
              target: parsed.flags.get("--target") as string,
              pendingRecord: parsed.flags.get("--pending-record") as string,
              key: parsed.key,
            })
          : await inspectBackup({
              input: parsed.flags.get("--input") as string,
              key: parsed.key,
            });
    await writeProcessLine(process.stdout, result);
    return 0;
  } catch (error) {
    const known =
      error instanceof DesktopBackupError || error instanceof BackupFormatError;
    const code = known ? error.code : "BACKUP_FAILED";
    const message = known ? error.message : "The backup operation failed.";
    await writeProcessLine(process.stderr, {
      ok: false,
      error: { code, message },
    });
    return 1;
  }
}

if (require.main === module) {
  void main().then(
    (code) => process.exit(code),
    () => process.exit(1),
  );
}
