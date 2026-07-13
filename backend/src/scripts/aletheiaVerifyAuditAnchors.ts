import {
  auditAnchorConfigFromEnvironment,
  verifyAuditAnchorJournal,
  verifyAuditAnchorVerificationBundle,
} from "../lib/aletheia/auditAnchorJournal";

const bundle = process.env.ALETHEIA_AUDIT_ANCHOR_BUNDLE_FILE?.trim();
const result = bundle
  ? verifyAuditAnchorVerificationBundle(bundle)
  : (() => {
      const config = auditAnchorConfigFromEnvironment();
      return verifyAuditAnchorJournal({
        dataDir: config.dataDir,
        anchorDir: config.anchorDir,
        publicKeyPath: config.publicKeyPath,
        compareCurrentSnapshot:
          process.env.ALETHEIA_AUDIT_ANCHOR_COMPARE_CURRENT !== "false",
        expectedHeadHash:
          process.env.ALETHEIA_AUDIT_ANCHOR_EXPECTED_HEAD_HASH?.trim() || null,
      });
    })();
console.log(JSON.stringify(result, null, 2));
