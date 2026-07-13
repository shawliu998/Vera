import path from "node:path";
import { importAuditAnchorKeyPair } from "../lib/aletheia/auditAnchorJournal";

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return path.resolve(value);
}

if (
  process.env.ALETHEIA_AUDIT_ANCHOR_KEY_IMPORT_CONFIRM !==
  "import-ed25519-keypair"
) {
  throw new Error(
    "Set ALETHEIA_AUDIT_ANCHOR_KEY_IMPORT_CONFIRM=import-ed25519-keypair after verifying the operator keypair and destinations.",
  );
}
const result = importAuditAnchorKeyPair({
  dataDir: path.resolve(
    process.env.ALETHEIA_DATA_DIR ??
      process.env.ALET_HEIA_DATA_DIR ??
      path.resolve(process.cwd(), ".data", "aletheia"),
  ),
  sourcePrivateKeyPath: required(
    "ALETHEIA_AUDIT_ANCHOR_IMPORT_PRIVATE_KEY_FILE",
  ),
  sourcePublicKeyPath: required("ALETHEIA_AUDIT_ANCHOR_IMPORT_PUBLIC_KEY_FILE"),
  destinationPrivateKeyPath: required("ALETHEIA_AUDIT_ANCHOR_PRIVATE_KEY_FILE"),
  destinationPublicKeyPath: required("ALETHEIA_AUDIT_ANCHOR_PUBLIC_KEY_FILE"),
});
console.log(JSON.stringify(result, null, 2));
