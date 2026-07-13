import {
  auditAnchorConfigFromEnvironment,
  createAuditAnchor,
} from "../lib/aletheia/auditAnchorJournal";

const result = createAuditAnchor(
  auditAnchorConfigFromEnvironment(),
  process.env.ALETHEIA_AUDIT_ANCHOR_REASON?.trim() || "operator_manual",
);
console.log(JSON.stringify(result, null, 2));
