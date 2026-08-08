import type { VerifiedTabularArtifactIdentity } from "../../agent-kernel/contracts/verifiedArtifactIdentity";

/** Litigation requires the generic Tabular identity to carry review completion provenance. */
export function assertLitigationVerifiedTabularArtifact(
  value: VerifiedTabularArtifactIdentity,
) {
  if (
    !value.source_receipt_fingerprint ||
    !value.decision_fingerprint ||
    !value.completion_sha256
  ) {
    throw new Error(
      "A Litigation Evidence Inventory identity requires its current completion provenance",
    );
  }
  return value;
}
