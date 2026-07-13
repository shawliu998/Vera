import path from "node:path";
import {
  auditAnchorConfigFromEnvironment,
  exportAuditAnchorVerificationBundle,
} from "../lib/aletheia/auditAnchorJournal";

const output = process.env.ALETHEIA_AUDIT_ANCHOR_BUNDLE_OUT?.trim();
if (!output) throw new Error("ALETHEIA_AUDIT_ANCHOR_BUNDLE_OUT is required.");
const result = exportAuditAnchorVerificationBundle({
  config: auditAnchorConfigFromEnvironment(),
  outputPath: path.resolve(output),
});
console.log(JSON.stringify(result, null, 2));
