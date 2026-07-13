import {
  loadLocalDatabaseKey,
  storeLocalDatabaseKeyInMacOsKeychain,
} from "../lib/aletheia/localDatabaseKey";

if (
  process.env.ALETHEIA_DATABASE_KEYCHAIN_IMPORT_CONFIRM !==
  "replace-database-key"
) {
  throw new Error(
    "Set ALETHEIA_DATABASE_KEYCHAIN_IMPORT_CONFIRM=replace-database-key after verifying this is the correct SQLCipher key for the restored database.",
  );
}
if (process.env.ALETHEIA_DATABASE_KEY_SOURCE !== "file") {
  throw new Error(
    "Import requires ALETHEIA_DATABASE_KEY_SOURCE=file and ALETHEIA_DATABASE_KEY_FILE pointing to owner-only escrow material.",
  );
}
storeLocalDatabaseKeyInMacOsKeychain(loadLocalDatabaseKey());
console.log(
  JSON.stringify({
    schema_version: "aletheia-database-key-keychain-import-v1",
    imported: true,
    service: "com.aletheia.desktop.database-encryption",
    account: "aletheia-local-database-key",
  }),
);
