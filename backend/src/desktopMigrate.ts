import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { migrateLegacyLocalFiles } from "./lib/aletheia/localEncryptionMigration";
import { migratePlaintextDatabaseToSqlcipher } from "./lib/aletheia/sqlcipherMigration";

const dataDir = path.resolve(process.env.ALETHEIA_DATA_DIR ?? "");
const backupDir = path.resolve(
  process.env.ALETHEIA_DESKTOP_MIGRATION_BACKUP_DIR ?? "",
);

if (
  !process.env.ALETHEIA_DATA_DIR ||
  !process.env.ALETHEIA_DESKTOP_MIGRATION_BACKUP_DIR
) {
  throw new Error(
    "Desktop migration requires explicit data and backup directories.",
  );
}

mkdirSync(dataDir, { recursive: true, mode: 0o700 });
mkdirSync(backupDir, { recursive: true, mode: 0o700 });
const databasePath = path.join(dataDir, "aletheia.db");
const database = existsSync(databasePath)
  ? migratePlaintextDatabaseToSqlcipher({
      dataDir,
      databasePath,
      backupDir,
      apply: true,
    })
  : null;
const files = migrateLegacyLocalFiles({ dataDir, apply: true });

if (database?.status === "migrated" && database.backup_path) {
  unlinkSync(database.backup_path);
}
if (existsSync(backupDir) && readdirSync(backupDir).length === 0) {
  rmdirSync(backupDir);
}

console.log(
  JSON.stringify({
    schema_version: "aletheia-desktop-migration-v1",
    database:
      database === null
        ? { status: "not_present" }
        : {
            status: database.status,
            applied: database.applied,
            encrypted_bytes: statSync(databasePath).size,
          },
    files: files.counts,
  }),
);
process.exit(0);
