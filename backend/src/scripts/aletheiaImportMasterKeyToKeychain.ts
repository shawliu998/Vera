import {
  loadApplicationMasterKey,
  storeApplicationMasterKeyInMacOsKeychain,
} from "../lib/aletheia/localEnvelopeCrypto";

if (process.env.ALETHEIA_KEYCHAIN_IMPORT_CONFIRM !== "replace-keychain-key") {
  throw new Error(
    "Set ALETHEIA_KEYCHAIN_IMPORT_CONFIRM=replace-keychain-key after verifying this is the correct key for the restored vault.",
  );
}
if (process.env.ALETHEIA_MASTER_KEY_SOURCE !== "file") {
  throw new Error(
    "Import requires ALETHEIA_MASTER_KEY_SOURCE=file and ALETHEIA_MASTER_KEY_FILE pointing to owner-only escrow material.",
  );
}
const key = loadApplicationMasterKey();
storeApplicationMasterKeyInMacOsKeychain(key);
console.log(
  JSON.stringify({
    schema_version: "aletheia-master-key-keychain-import-v1",
    imported: true,
    service: "com.aletheia.desktop.application-encryption",
    account: "aletheia-local-master-key",
  }),
);
