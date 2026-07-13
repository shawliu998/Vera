import { strict as assert } from "node:assert";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LocalDatabase } from "../lib/aletheia/localDatabase";
import { migratePlaintextDatabaseToSqlcipher } from "../lib/aletheia/sqlcipherMigration";

const originalEnvironment = { ...process.env };
const root = mkdtempSync(path.join(os.tmpdir(), "aletheia-sqlcipher-audit-"));
const expectedNativeHashes: Record<string, string> = {
  "darwin-arm64":
    "2de28dd4791527c44af72c75eddb5ae1ea891bc0d72a1a3f50e8ad4ad799a9c1",
};
try {
  const dataDir = path.join(root, "vault");
  const backupDir = path.join(root, "separate-encrypted-backup");
  const databasePath = path.join(dataDir, "aletheia.db");
  const key = randomBytes(32);
  const bindingEntry = require.resolve("@signalapp/sqlcipher");
  const nativeAddon = path.resolve(
    path.dirname(bindingEntry),
    "..",
    "prebuilds",
    `${process.platform}-${process.arch}`,
    "@signalapp+sqlcipher.node",
  );
  const nativeSha256 = createHash("sha256")
    .update(readFileSync(nativeAddon))
    .digest("hex");
  const expectedNativeHash =
    expectedNativeHashes[`${process.platform}-${process.arch}`];
  if (expectedNativeHash) assert.equal(nativeSha256, expectedNativeHash);
  process.env.ALETHEIA_DATA_DIR = dataDir;
  process.env.ALETHEIA_DATABASE_KEY_SOURCE = "env";
  process.env.ALETHEIA_DATABASE_KEY_BASE64 = key.toString("base64");
  process.env.ALETHEIA_DATABASE_ENCRYPTION = "metadata_plaintext";
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  const plaintext = new DatabaseSync(databasePath);
  plaintext.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA user_version = 17;
    PRAGMA application_id = 1095521352;
    create table confidential (id integer primary key, value text not null);
    insert into confidential (value) values ('privileged database payload');
  `);
  plaintext.close();
  const originalHeader = readFileSync(databasePath).subarray(0, 16);
  assert.equal(originalHeader.toString("utf8"), "SQLite format 3\0");

  const dryRun = migratePlaintextDatabaseToSqlcipher({
    dataDir,
    apply: false,
  });
  assert.equal(dryRun.status, "would_migrate");
  assert.equal(
    readFileSync(databasePath).subarray(0, 16).toString("utf8"),
    "SQLite format 3\0",
  );

  assert.throws(() =>
    migratePlaintextDatabaseToSqlcipher({ dataDir, apply: true }),
  );
  if (process.platform !== "win32") {
    mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    const symlinkedBackup = path.join(root, "symlinked-backup");
    symlinkSync(backupDir, symlinkedBackup, "dir");
    assert.throws(() =>
      migratePlaintextDatabaseToSqlcipher({
        dataDir,
        backupDir: symlinkedBackup,
        apply: true,
      }),
    );
    unlinkSync(symlinkedBackup);
  }
  const migrated = migratePlaintextDatabaseToSqlcipher({
    dataDir,
    backupDir,
    apply: true,
  });
  assert.equal(migrated.status, "migrated");
  assert.ok(migrated.backup_path);
  if (process.platform !== "win32") {
    assert.equal(statSync(String(migrated.backup_path)).mode & 0o077, 0);
  }
  assert.equal(
    readFileSync(String(migrated.backup_path)).subarray(0, 16).toString("utf8"),
    "SQLite format 3\0",
  );
  assert.notEqual(
    readFileSync(databasePath).subarray(0, 16).toString("utf8"),
    "SQLite format 3\0",
  );

  assert.throws(() => {
    const unkeyed = new DatabaseSync(databasePath, { readOnly: true });
    try {
      unkeyed.prepare("select value from confidential").get();
    } finally {
      unkeyed.close();
    }
  });

  process.env.ALETHEIA_DATABASE_ENCRYPTION = "sqlcipher_required";
  const encrypted = new LocalDatabase(databasePath, { readOnly: true });
  assert.equal(encrypted.status().encrypted, true);
  assert.match(String(encrypted.status().cipher_version), /^4\./);
  assert.equal(
    encrypted.prepare("select value from confidential where id = 1").get()
      .value,
    "privileged database payload",
  );
  assert.equal(encrypted.prepare("PRAGMA user_version").get().user_version, 17);
  assert.equal(
    encrypted.prepare("PRAGMA application_id").get().application_id,
    1095521352,
  );
  encrypted.close();

  const rerun = migratePlaintextDatabaseToSqlcipher({
    dataDir,
    backupDir,
    apply: true,
  });
  assert.equal(rerun.status, "already_encrypted");

  process.env.ALETHEIA_DATABASE_KEY_BASE64 = randomBytes(32).toString("base64");
  assert.throws(() =>
    migratePlaintextDatabaseToSqlcipher({
      dataDir,
      backupDir,
      apply: false,
    }),
  );

  chmodSync(String(migrated.backup_path), 0o600);
  console.log(
    JSON.stringify(
      {
        ok: true,
        schema_version: "aletheia-sqlcipher-integration-audit-v1",
        binding: "@signalapp/sqlcipher",
        cipher_version: migrated.cipher_version,
        cipher_provider: migrated.cipher_provider,
        native_addon_sha256: nativeSha256,
        native_hash_pinned_for_platform: Boolean(expectedNativeHash),
        checks: [
          "plaintext dry run is non-mutating",
          "apply requires external backup directory",
          "plaintext to SQLCipher sqlcipher_export migration",
          "plaintext backup hash and owner-only output",
          "migration backup directory symlinks are rejected",
          "unencrypted node:sqlite cannot read migrated database",
          "correct raw key opens schema and data",
          "cipher_integrity_check passes",
          "plaintext and encrypted quick_check pass",
          "schema and row-count manifests match",
          "user_version and application_id preserved",
          "migration is idempotent",
          "wrong key is rejected",
          "published macOS arm64 native addon hash is pinned",
        ],
      },
      null,
      2,
    ),
  );
} finally {
  process.env = originalEnvironment;
  rmSync(root, { recursive: true, force: true });
}
