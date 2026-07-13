import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createBackup, inspectBackup, restoreBackup } from "../desktopBackup";
import {
  BACKUP_HEADER_BYTES,
  BackupFormatError,
  encryptTarStreamAtomic,
} from "../lib/aletheia/desktopBackupFormat";

type TarEntry = {
  path: string;
  type?: "file" | "directory" | "symlink";
  data?: Buffer;
  link?: string;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function expectCode(operation: () => Promise<unknown>, codes: string[]) {
  try {
    await operation();
  } catch (error) {
    let code: string | null = null;
    if (error instanceof BackupFormatError) code = error.code;
    else if (
      error instanceof Error &&
      "code" in error &&
      typeof error.code === "string"
    ) {
      code = error.code;
    }
    assert(
      code !== null && codes.includes(code),
      `Expected ${codes.join("/")}, received ${String(code)}`,
    );
    return code;
  }
  throw new Error(`Expected ${codes.join("/")} rejection`);
}

function writeTarText(
  target: Buffer,
  offset: number,
  length: number,
  value: string,
) {
  const encoded = Buffer.from(value, "utf8");
  assert(encoded.length <= length, "Audit tar field is too long");
  encoded.copy(target, offset);
}

function writeTarOctal(
  target: Buffer,
  offset: number,
  length: number,
  value: number,
) {
  const encoded = `${value.toString(8).padStart(length - 1, "0")}\0`;
  writeTarText(target, offset, length, encoded);
}

function tarHeader(entry: TarEntry) {
  const header = Buffer.alloc(512);
  writeTarText(header, 0, 100, entry.path);
  writeTarOctal(header, 100, 8, entry.type === "directory" ? 0o700 : 0o600);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, entry.data?.length ?? 0);
  writeTarOctal(header, 136, 12, Math.floor(Date.now() / 1000));
  header.fill(0x20, 148, 156);
  header[156] =
    entry.type === "directory" ? 0x35 : entry.type === "symlink" ? 0x32 : 0x30;
  if (entry.link) writeTarText(header, 157, 100, entry.link);
  writeTarText(header, 257, 6, "ustar\0");
  writeTarText(header, 263, 2, "00");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  writeTarText(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return header;
}

function buildTar(entries: TarEntry[]) {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const data = entry.data ?? Buffer.alloc(0);
    chunks.push(tarHeader(entry), data);
    const padding = (512 - (data.length % 512)) % 512;
    if (padding > 0) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  const archive = Buffer.concat(chunks);
  const recordPadding = (10240 - (archive.length % 10240)) % 10240;
  return recordPadding > 0
    ? Buffer.concat([archive, Buffer.alloc(recordPadding)])
    : archive;
}

async function encryptAuditTar(
  tarPath: string,
  backupPath: string,
  key: Buffer,
) {
  await encryptTarStreamAtomic({
    input: createReadStream(tarPath),
    outputPath: backupPath,
    key,
  });
}

function runCli(args: string[], key: Buffer) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", path.resolve("src/desktopBackup.ts"), ...args],
        {
          cwd: path.resolve("."),
          env: {
            ...process.env,
            ALETHEIA_BACKUP_KEY_BASE64: key.toString("base64"),
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.setEncoding("utf8").on("data", (chunk) => {
        stderr += chunk;
      });
      child.once("error", reject);
      child.once("close", (status) => resolve({ status, stdout, stderr }));
    },
  );
}

function parseSingleJsonLine(output: string) {
  const lines = output.trimEnd().split("\n");
  assert(
    lines.length === 1 && lines[0].length > 0,
    "CLI must emit one JSON line",
  );
  return JSON.parse(lines[0]) as Record<string, unknown>;
}

async function main() {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "aletheia-desktop-backup-audit-"),
  );
  await chmod(root, 0o700);
  const key = randomBytes(32);
  const wrongKey = randomBytes(32);
  const source = path.join(root, "data");
  const backup = path.join(root, "vault.backup");
  const checks: string[] = [];

  try {
    await mkdir(path.join(source, "documents", "nested"), {
      recursive: true,
      mode: 0o700,
    });
    await mkdir(path.join(source, "exports"), { recursive: true, mode: 0o700 });
    await mkdir(path.join(source, "index"), { recursive: true, mode: 0o700 });
    await writeFile(
      path.join(source, "aletheia.db"),
      randomBytes(1024 * 1024),
      { mode: 0o600 },
    );
    await writeFile(
      path.join(source, "aletheia.db-wal"),
      randomBytes(256 * 1024),
      { mode: 0o600 },
    );
    await writeFile(path.join(source, ".audit-hmac-key"), randomBytes(32), {
      mode: 0o600,
    });
    await writeFile(
      path.join(source, "documents", "nested", "large.bin"),
      randomBytes(2 * 1024 * 1024),
      { mode: 0o600 },
    );
    await writeFile(
      path.join(source, "exports", "result.json"),
      '{"ok":true}\n',
      { mode: 0o600 },
    );

    const created = await runCli(
      [
        "create",
        "--source",
        source,
        "--output",
        backup,
        "--key-base64-env",
        "ALETHEIA_BACKUP_KEY_BASE64",
      ],
      key,
    );
    assert(
      created.status === 0 && created.stderr === "",
      "create CLI must succeed without stderr",
    );
    const createResult = parseSingleJsonLine(created.stdout);
    assert(
      createResult.ok === true && createResult.action === "create",
      "create CLI result is invalid",
    );
    assert(
      typeof createResult.created_at === "string" &&
        !Number.isNaN(Date.parse(createResult.created_at)),
      "create CLI must report the manifest snapshot time",
    );
    assert(
      !created.stdout.includes(source) && !created.stdout.includes(backup),
      "create output leaked a path",
    );
    checks.push("create CLI and streaming archive");

    const outputMode = (await stat(backup)).mode & 0o777;
    assert(outputMode === 0o600, "backup output must be mode 0600");
    checks.push("owner-only output permission");

    const inspected = await runCli(
      [
        "inspect",
        "--input",
        backup,
        "--key-base64-env",
        "ALETHEIA_BACKUP_KEY_BASE64",
      ],
      key,
    );
    assert(
      inspected.status === 0 && inspected.stderr === "",
      "inspect CLI must succeed without stderr",
    );
    const inspectResult = parseSingleJsonLine(inspected.stdout);
    assert(
      inspectResult.ok === true && inspectResult.action === "inspect",
      "inspect CLI result is invalid",
    );
    assert(
      !inspected.stdout.includes(source) && !inspected.stdout.includes(backup),
      "inspect output leaked a path",
    );
    checks.push("authenticated inspect and manifest hashes");

    const databaseBefore = createHash("sha256")
      .update(await readFile(path.join(source, "aletheia.db")))
      .digest("hex");
    await writeFile(
      path.join(source, "aletheia.db"),
      Buffer.from("new-state"),
      {
        mode: 0o600,
      },
    );
    const pendingRestore = path.join(root, "pending-restore.json");
    const restored = await restoreBackup({
      input: backup,
      target: source,
      key,
      pendingRecord: pendingRestore,
    });
    const databaseAfter = createHash("sha256")
      .update(await readFile(path.join(source, "aletheia.db")))
      .digest("hex");
    assert(
      databaseAfter === databaseBefore,
      "restore must recover backed-up data",
    );
    assert(
      typeof restored.rollback_path === "string" &&
        (await lstat(restored.rollback_path)).isDirectory(),
      "restore must retain the prior workspace for service-start rollback",
    );
    const pendingInfo = await lstat(pendingRestore);
    assert(
      pendingInfo.isFile() && (pendingInfo.mode & 0o077) === 0,
      "restore must retain an owner-only pending transaction record",
    );
    await rm(restored.rollback_path, { recursive: true, force: true });
    await rm(pendingRestore, { force: true });
    checks.push("verified atomic restore with durable rollback transaction");

    const tampered = path.join(root, "tampered.backup");
    await copyFile(backup, tampered);
    const tamperedHandle = await open(tampered, "r+");
    try {
      const byte = Buffer.alloc(1);
      await tamperedHandle.read(byte, 0, 1, BACKUP_HEADER_BYTES + 31);
      byte[0] ^= 0x80;
      await tamperedHandle.write(byte, 0, 1, BACKUP_HEADER_BYTES + 31);
      await tamperedHandle.sync();
    } finally {
      await tamperedHandle.close();
    }
    await expectCode(
      () => inspectBackup({ input: tampered, key }),
      ["AUTHENTICATION_FAILED"],
    );
    checks.push("ciphertext tamper rejection");

    await expectCode(
      () => inspectBackup({ input: backup, key: wrongKey }),
      ["AUTHENTICATION_FAILED"],
    );
    checks.push("wrong-key rejection");

    const outside = path.join(root, "outside.txt");
    await writeFile(outside, "outside", { mode: 0o600 });
    const sourceLink = path.join(source, "documents", "source-link");
    await symlink(outside, sourceLink);
    await expectCode(
      () =>
        createBackup({
          source,
          output: path.join(root, "symlink.backup"),
          key,
        }),
      ["SYMLINK_REJECTED"],
    );
    await rm(sourceLink);
    checks.push("source symlink rejection");

    await expectCode(
      () =>
        createBackup({
          source,
          output: path.join(source, "inside.backup"),
          key,
        }),
      ["OUTPUT_BOUNDARY"],
    );
    const emptySource = path.join(root, "empty");
    await mkdir(emptySource, { mode: 0o700 });
    await expectCode(
      () =>
        createBackup({
          source: emptySource,
          output: path.join(root, "empty.backup"),
          key,
        }),
      ["EMPTY_SOURCE"],
    );
    checks.push("empty-source and output-boundary rejection");

    const traversalTar = path.join(root, "traversal.tar");
    const traversalBackup = path.join(root, "traversal.backup");
    await writeFile(
      traversalTar,
      buildTar([{ path: "../escape", data: Buffer.from("escape") }]),
      { mode: 0o600 },
    );
    await encryptAuditTar(traversalTar, traversalBackup, key);
    await expectCode(
      () => inspectBackup({ input: traversalBackup, key }),
      ["UNSAFE_ARCHIVE_PATH", "TAR_LIST_FAILED"],
    );
    checks.push("archive path-traversal rejection");

    const symlinkTar = path.join(root, "symlink.tar");
    const symlinkBackup = path.join(root, "symlink-entry.backup");
    await writeFile(
      symlinkTar,
      buildTar([
        { path: "documents/link", type: "symlink", link: "../aletheia.db" },
      ]),
      { mode: 0o600 },
    );
    await encryptAuditTar(symlinkTar, symlinkBackup, key);
    await expectCode(
      () => inspectBackup({ input: symlinkBackup, key }),
      ["UNSAFE_ENTRY_TYPE"],
    );
    checks.push("archive symlink rejection");

    const database = Buffer.from("database");
    const wrongHash = "0".repeat(64);
    const emptyHash = createHash("sha256").digest("hex");
    const invalidManifest = {
      schema_version: "aletheia-desktop-backup-manifest-v1",
      created_at: new Date().toISOString(),
      hash_algorithm: "sha256",
      files: [
        { path: "aletheia.db", bytes: database.length, sha256: wrongHash },
      ],
      directories: ["documents", "exports", "index"].map((directory) => ({
        path: directory,
        files: 0,
        bytes: 0,
        sha256: emptyHash,
      })),
      totals: { files: 1, directories: 3, bytes: database.length },
      database: {
        path: "aletheia.db",
        bytes: database.length,
        sha256: wrongHash,
      },
    };
    const manifestTar = path.join(root, "manifest.tar");
    const manifestBackup = path.join(root, "manifest.backup");
    await writeFile(
      manifestTar,
      buildTar([
        {
          path: "backup-manifest.json",
          data: Buffer.from(`${JSON.stringify(invalidManifest)}\n`),
        },
        { path: "documents/", type: "directory" },
        { path: "exports/", type: "directory" },
        { path: "index/", type: "directory" },
        { path: "aletheia.db", data: database },
      ]),
      { mode: 0o600 },
    );
    await encryptAuditTar(manifestTar, manifestBackup, key);
    await expectCode(
      () => inspectBackup({ input: manifestBackup, key }),
      ["MANIFEST_MISMATCH"],
    );
    checks.push("manifest file-list and SHA-256 rejection");

    const inputLink = path.join(root, "input-link.backup");
    await symlink(backup, inputLink);
    await expectCode(
      () => inspectBackup({ input: inputLink, key }),
      ["INVALID_INPUT"],
    );
    assert(
      (await lstat(inputLink)).isSymbolicLink(),
      "input symlink fixture is invalid",
    );
    checks.push("backup input symlink rejection");

    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        schema_version: "aletheia-desktop-backup-audit-v1",
        checks,
      })}\n`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
