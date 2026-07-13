import {
  applicationEncryptionMode,
  databaseEncryptionMode,
} from "./localEnvelopeCrypto";
import {
  assertRequiredMalwareScannerAvailable,
  malwareScanMode,
} from "./malwareScanner";

export type AletheiaDeploymentPreset = "standard" | "compliance";

export class ComplianceDeploymentConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComplianceDeploymentConfigurationError";
  }
}

export function aletheiaDeploymentPreset(): AletheiaDeploymentPreset {
  const configured =
    process.env.ALETHEIA_DEPLOYMENT_PRESET?.trim().toLowerCase() ?? "standard";
  if (configured === "standard" || configured === "compliance") {
    return configured;
  }
  throw new ComplianceDeploymentConfigurationError(
    "ALETHEIA_DEPLOYMENT_PRESET must be standard or compliance.",
  );
}

/**
 * The compliance preset is intentionally an admission-control policy, not a
 * collection of UI defaults. It rejects a process before it can accept work
 * if a required protection has been disabled. Individual key and anchor
 * material is validated by their owning startup components immediately after
 * this check.
 */
export function assertComplianceDeploymentStartupPolicy() {
  if (aletheiaDeploymentPreset() !== "compliance") return;

  const violations: string[] = [];
  if (applicationEncryptionMode() !== "required") {
    violations.push("ALETHEIA_APPLICATION_ENCRYPTION=required");
  }
  if (databaseEncryptionMode() !== "sqlcipher_required") {
    violations.push("ALETHEIA_DATABASE_ENCRYPTION=sqlcipher_required");
  }
  if (process.env.ALETHEIA_REQUIRE_ENCRYPTED_VOLUME !== "true") {
    violations.push("ALETHEIA_REQUIRE_ENCRYPTED_VOLUME=true");
  }
  if (process.env.ALETHEIA_ENCRYPTED_VOLUME_ATTESTED !== "true") {
    violations.push(
      "ALETHEIA_ENCRYPTED_VOLUME_ATTESTED=true after operator verification",
    );
  }
  if (process.env.ALETHEIA_AUDIT_ANCHOR_ENABLED !== "true") {
    violations.push("ALETHEIA_AUDIT_ANCHOR_ENABLED=true");
  }
  if (process.env.ALETHEIA_AUDIT_ANCHOR_HIGH_ASSURANCE !== "true") {
    violations.push("ALETHEIA_AUDIT_ANCHOR_HIGH_ASSURANCE=true");
  }
  if (malwareScanMode() !== "required") {
    violations.push("ALETHEIA_MALWARE_SCAN_MODE=required");
  }
  if (violations.length > 0) {
    throw new ComplianceDeploymentConfigurationError(
      `The compliance deployment preset refuses startup without: ${violations.join(", ")}.`,
    );
  }
  assertRequiredMalwareScannerAvailable();
}
