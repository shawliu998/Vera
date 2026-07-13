import path from "node:path";
import { migratePlaintextDatabaseToSqlcipher } from "../lib/aletheia/sqlcipherMigration";

const dataDir = path.resolve(
  process.env.ALETHEIA_DATA_DIR ??
    process.env.ALET_HEIA_DATA_DIR ??
    path.resolve(process.cwd(), ".data", "aletheia"),
);
const result = migratePlaintextDatabaseToSqlcipher({
  dataDir,
  databasePath: process.env.ALETHEIA_SQLCIPHER_MIGRATION_DATABASE,
  backupDir: process.env.ALETHEIA_SQLCIPHER_MIGRATION_BACKUP_DIR,
  apply: process.env.ALETHEIA_SQLCIPHER_MIGRATION_APPLY === "true",
});
console.log(JSON.stringify(result, null, 2));
if (result.status === "would_migrate") {
  console.error(
    "Dry run only. Stop all Aletheia processes, prepare separately protected backup storage, then set ALETHEIA_SQLCIPHER_MIGRATION_APPLY=true.",
  );
}
