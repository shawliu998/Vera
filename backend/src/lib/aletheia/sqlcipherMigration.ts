import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import SignalDatabase from "@signalapp/sqlcipher";
import { loadLocalDatabaseKey, localDatabaseKeyId } from "./localDatabaseKey";

const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "utf8");

function sha256File(filePath: string) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function isPathInside(parent: string, child: string) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function isPlaintextSqlite(filePath: string) {
  if (!existsSync(filePath) || statSync(filePath).size < SQLITE_HEADER.length) {
    return false;
  }
  return readFileSync(filePath)
    .subarray(0, SQLITE_HEADER.length)
    .equals(SQLITE_HEADER);
}

function rawKey(key: Buffer) {
  return `key = "x'${key.toString("hex")}'"`;
}

function attachSql(filePath: string, key: Buffer) {
  return `ATTACH DATABASE '${filePath.replaceAll("'", "''")}' AS encrypted KEY "x'${key.toString("hex")}'"`;
}

function quotedIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

function databaseManifest(database: {
  prepare(sql: string): {
    all(...parameters: any[]): any[];
    get(...parameters: any[]): any;
  };
}) {
  const schema = database
    .prepare(
      `select type, name, tbl_name, sql from sqlite_schema
        where name not like 'sqlite_%'
        order by type, name`,
    )
    .all()
    .map((row) => ({
      type: String(row.type),
      name: String(row.name),
      table: String(row.tbl_name),
      sql: row.sql === null || row.sql === undefined ? null : String(row.sql),
    }));
  const tables = database
    .prepare(
      `select name from sqlite_schema
        where type = 'table' and name not like 'sqlite_%'
        order by name`,
    )
    .all()
    .map((row) => String(row.name));
  return {
    schema,
    tables: tables.map((name) => ({
      name,
      rows: Number(
        database
          .prepare(`select count(*) as count from ${quotedIdentifier(name)}`)
          .get()?.count ?? 0,
      ),
    })),
  };
}

function assertQuickCheck(database: {
  prepare(sql: string): { get(...parameters: any[]): any };
}) {
  const row = database.prepare("PRAGMA quick_check").get();
  const value = row?.quick_check ?? Object.values(row ?? {})[0];
  if (value !== "ok") {
    throw new Error(`SQLite quick_check failed: ${JSON.stringify(row)}`);
  }
}

function verifyEncryptedDatabase(filePath: string, key: Buffer) {
  const database = new SignalDatabase(filePath);
  try {
    database.pragma(rawKey(key));
    const cipherVersion = database.pragma("cipher_version", { simple: true });
    const cipherProvider = database.pragma("cipher_provider", { simple: true });
    if (typeof cipherVersion !== "string" || !cipherVersion.trim()) {
      throw new Error("SQLCipher cipher_version is empty.");
    }
    database.prepare("select count(*) as count from sqlite_master").get();
    const integrity = database.pragma("cipher_integrity_check");
    if (!Array.isArray(integrity) || integrity.length !== 0) {
      throw new Error(
        `SQLCipher integrity check failed: ${JSON.stringify(integrity)}`,
      );
    }
    assertQuickCheck(database);
    return {
      cipher_version: cipherVersion,
      cipher_provider:
        typeof cipherProvider === "string" ? cipherProvider : null,
      manifest: databaseManifest(database),
    };
  } finally {
    database.close();
  }
}

function fsyncFile(filePath: string) {
  const fd = openSync(filePath, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fsyncDirectory(directory: string) {
  if (process.platform === "win32") return;
  const fd = openSync(directory, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function migratePlaintextDatabaseToSqlcipher(args: {
  dataDir: string;
  databasePath?: string;
  backupDir?: string | null;
  apply: boolean;
}) {
  const requestedDataDir = path.resolve(args.dataDir);
  const requestedDatabasePath = path.resolve(
    args.databasePath ?? path.join(requestedDataDir, "aletheia.db"),
  );
  if (!existsSync(requestedDataDir)) {
    throw new Error(`Data directory does not exist: ${requestedDataDir}`);
  }
  if (!existsSync(requestedDatabasePath)) {
    throw new Error(`Database does not exist: ${requestedDatabasePath}`);
  }
  if (
    lstatSync(requestedDatabasePath).isSymbolicLink() ||
    !lstatSync(requestedDatabasePath).isFile()
  ) {
    throw new Error(
      "The Aletheia database must be a regular file, not a symbolic link.",
    );
  }
  const dataDir = realpathSync(requestedDataDir);
  const databasePath = realpathSync(requestedDatabasePath);
  if (!isPathInside(dataDir, databasePath)) {
    throw new Error(
      "The Aletheia database must remain inside ALETHEIA_DATA_DIR.",
    );
  }
  const key = loadLocalDatabaseKey();
  const keyId = localDatabaseKeyId(key);

  if (!isPlaintextSqlite(databasePath)) {
    const verified = verifyEncryptedDatabase(databasePath, key);
    return {
      schema_version: "aletheia-sqlcipher-migration-v1",
      status: "already_encrypted" as const,
      applied: false,
      database_path: databasePath,
      key_id: keyId,
      ...verified,
    };
  }

  if (!args.apply) {
    return {
      schema_version: "aletheia-sqlcipher-migration-v1",
      status: "would_migrate" as const,
      applied: false,
      database_path: databasePath,
      plaintext_bytes: statSync(databasePath).size,
      plaintext_sha256: sha256File(databasePath),
      key_id: keyId,
    };
  }

  if (!args.backupDir) {
    throw new Error(
      "Applying SQLCipher migration requires ALETHEIA_SQLCIPHER_MIGRATION_BACKUP_DIR on separately protected storage outside ALETHEIA_DATA_DIR.",
    );
  }
  const requestedBackupDir = path.resolve(args.backupDir);
  if (
    existsSync(requestedBackupDir) &&
    lstatSync(requestedBackupDir).isSymbolicLink()
  ) {
    throw new Error(
      "SQLCipher migration backup directory must not be a symbolic link.",
    );
  }
  if (!existsSync(requestedBackupDir))
    mkdirSync(requestedBackupDir, { recursive: true, mode: 0o700 });
  if (!lstatSync(requestedBackupDir).isDirectory()) {
    throw new Error("SQLCipher migration backup path must be a directory.");
  }
  const backupDir = realpathSync(requestedBackupDir);
  if (isPathInside(dataDir, backupDir)) {
    throw new Error(
      "SQLCipher migration backup directory must be outside ALETHEIA_DATA_DIR.",
    );
  }
  if (
    process.platform !== "win32" &&
    (statSync(backupDir).mode & 0o077) !== 0
  ) {
    throw new Error(
      "SQLCipher migration backup directory must be owner-only (0700).",
    );
  }

  const lockPath = path.join(dataDir, ".sqlcipher-migration.lock");
  const lockFd = openSync(
    lockPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600,
  );
  closeSync(lockFd);
  const temporaryPath = path.join(
    dataDir,
    `.aletheia-sqlcipher-${randomUUID()}.db`,
  );
  try {
    const source = new DatabaseSync(databasePath);
    let sourceManifest: ReturnType<typeof databaseManifest>;
    let userVersion = 0;
    let applicationId = 0;
    try {
      const checkpoint = source
        .prepare("PRAGMA wal_checkpoint(TRUNCATE)")
        .get() as {
        busy?: number;
      };
      if (Number(checkpoint?.busy ?? 0) !== 0) {
        throw new Error(
          "SQLite WAL checkpoint is busy. Stop every Aletheia process before migration.",
        );
      }
      assertQuickCheck(source);
      sourceManifest = databaseManifest(source);
      userVersion = Number(
        (
          source.prepare("PRAGMA user_version").get() as {
            user_version?: number;
          }
        )?.user_version ?? 0,
      );
      applicationId = Number(
        (
          source.prepare("PRAGMA application_id").get() as {
            application_id?: number;
          }
        )?.application_id ?? 0,
      );
    } finally {
      source.close();
    }

    const migration = new SignalDatabase(databasePath);
    try {
      migration.exec(attachSql(temporaryPath, key));
      migration.prepare("select sqlcipher_export('encrypted') as result").get();
      migration.exec(
        `PRAGMA encrypted.user_version = ${Math.max(0, userVersion)}`,
      );
      migration.exec(
        `PRAGMA encrypted.application_id = ${Math.max(0, applicationId)}`,
      );
      migration.exec("DETACH DATABASE encrypted");
    } finally {
      migration.close();
    }
    chmodSync(temporaryPath, 0o600);
    fsyncFile(temporaryPath);
    const targetVerification = verifyEncryptedDatabase(temporaryPath, key);
    if (
      JSON.stringify(targetVerification.manifest) !==
      JSON.stringify(sourceManifest)
    ) {
      throw new Error(
        "SQLCipher migration table/row manifest does not match plaintext source.",
      );
    }

    const plaintextSha256 = sha256File(databasePath);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = path.join(
      backupDir,
      `aletheia-${timestamp}-${plaintextSha256.slice(0, 16)}.plaintext.db`,
    );
    copyFileSync(databasePath, backupPath, constants.COPYFILE_EXCL);
    chmodSync(backupPath, 0o600);
    fsyncFile(backupPath);
    fsyncDirectory(backupDir);
    if (sha256File(backupPath) !== plaintextSha256) {
      throw new Error("Plaintext migration backup hash verification failed.");
    }

    if (process.platform === "win32") {
      throw new Error(
        "Atomic in-place SQLCipher replacement is not yet verified on Windows; source was left unchanged.",
      );
    }
    renameSync(temporaryPath, databasePath);
    chmodSync(databasePath, 0o600);
    fsyncDirectory(dataDir);
    for (const suffix of ["-wal", "-shm"]) {
      const sidecar = `${databasePath}${suffix}`;
      if (existsSync(sidecar)) unlinkSync(sidecar);
    }
    const finalVerification = verifyEncryptedDatabase(databasePath, key);
    return {
      schema_version: "aletheia-sqlcipher-migration-v1",
      status: "migrated" as const,
      applied: true,
      database_path: databasePath,
      backup_path: backupPath,
      plaintext_sha256: plaintextSha256,
      encrypted_sha256: sha256File(databasePath),
      key_id: keyId,
      ...finalVerification,
    };
  } finally {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    if (existsSync(lockPath)) unlinkSync(lockPath);
  }
}
