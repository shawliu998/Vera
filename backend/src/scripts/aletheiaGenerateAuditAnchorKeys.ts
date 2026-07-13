import path from "node:path";
import { generateAuditAnchorKeyPair } from "../lib/aletheia/auditAnchorJournal";

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return path.resolve(value);
}

const result = generateAuditAnchorKeyPair({
  dataDir: path.resolve(
    process.env.ALETHEIA_DATA_DIR ??
      process.env.ALET_HEIA_DATA_DIR ??
      path.resolve(process.cwd(), ".data", "aletheia"),
  ),
  privateKeyPath: required("ALETHEIA_AUDIT_ANCHOR_PRIVATE_KEY_FILE"),
  publicKeyPath: required("ALETHEIA_AUDIT_ANCHOR_PUBLIC_KEY_FILE"),
});
console.log(JSON.stringify(result, null, 2));
