import path from "node:path";
import { migrateLegacyLocalFiles } from "../lib/aletheia/localEncryptionMigration";

const dataDir = path.resolve(
  process.env.ALETHEIA_DATA_DIR ??
    process.env.ALET_HEIA_DATA_DIR ??
    path.resolve(process.cwd(), ".data", "aletheia"),
);
const result = migrateLegacyLocalFiles({
  dataDir,
  apply: process.env.ALETHEIA_ENCRYPTION_MIGRATION_APPLY === "true",
});
console.log(JSON.stringify(result, null, 2));
if (!result.applied && result.counts.would_encrypt > 0) {
  console.error(
    "Dry run only. Re-run with ALETHEIA_ENCRYPTION_MIGRATION_APPLY=true after backing up the data directory and securing the independent master key.",
  );
}
