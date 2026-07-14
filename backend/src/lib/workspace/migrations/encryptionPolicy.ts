import { LocalDatabase } from "../../aletheia/localDatabase";
import type { WorkspaceDatabaseAdapter } from "./types";

const TRUSTED_LOCAL_DATABASE_PROTOTYPE = LocalDatabase.prototype;
const TRUSTED_EXEC = TRUSTED_LOCAL_DATABASE_PROTOTYPE.exec;
const TRUSTED_PREPARE = TRUSTED_LOCAL_DATABASE_PROTOTYPE.prepare;
const TRUSTED_STATUS = TRUSTED_LOCAL_DATABASE_PROTOTYPE.status;
const TRUSTED_ATTESTATION =
  TRUSTED_LOCAL_DATABASE_PROTOTYPE.workspaceEncryptionAttestation;

export const WORKSPACE_SQLCIPHER_CONNECTION_POLICY = {
  version: 1,
  trustedAdapterClass: "LocalDatabase",
  attestationKind: "aletheia-local-database-sqlcipher-connection-v1",
  requiredAttestation: {
    driver: "signal-sqlcipher",
    encrypted: true,
    keyApplied: true,
    schemaReadVerified: true,
    persistence: "persistent",
    cipherIntegrityStatus: "verified_clean",
    cipherIntegrityVerified: true,
  },
  requiredLocalDatabaseStatus: {
    driver: "signal-sqlcipher",
    encrypted: true,
    cipherVersion: "non-empty and equal to attestation",
  },
  probeSql: "PRAGMA cipher_version",
  crossCheck: "exactly one non-empty value equal to attested cipherVersion",
  rawPragmaResultAloneTrusted: false,
  nonLocalDatabaseAdapterTrusted: false,
  exactLocalDatabasePrototypeRequired: true,
  subclassTrusted: false,
  ownMethodShadowsRejected: [
    "exec",
    "prepare",
    "status",
    "workspaceEncryptionAttestation",
  ],
  capturedPrototypeMethodsRequiredUnchanged: [
    "exec",
    "prepare",
    "status",
    "workspaceEncryptionAttestation",
  ],
  probeUsesCapturedOriginalPrepare: true,
  memoryRuntimeProbeEligibleForPersistentMigration: false,
  memoryIntegrityUnsupportedSentinel:
    "cipher_integrity_check=database file is undefined",
  emptyUnsupportedOrMismatchedResult: "plaintext_or_unverified",
  environmentConfigurationTrusted: false,
  requiresSameAlreadyOpenedKeyAndIntegrityVerifiedConnection: true,
} as const;

export const WORKSPACE_SQLCIPHER_CONNECTION_POLICY_MATERIAL = JSON.stringify(
  WORKSPACE_SQLCIPHER_CONNECTION_POLICY,
);

/**
 * This is a connection capability, not a configuration hint. Callers must pass
 * an already-opened trusted adapter; LocalDatabase verifies the SQLCipher key
 * before the migration runner reaches this probe.
 */
export function isWorkspaceConnectionSqlcipherEncrypted(
  database: WorkspaceDatabaseAdapter,
) {
  if (Object.getPrototypeOf(database) !== TRUSTED_LOCAL_DATABASE_PROTOTYPE) {
    return false;
  }
  if (
    LocalDatabase.prototype !== TRUSTED_LOCAL_DATABASE_PROTOTYPE ||
    LocalDatabase.prototype.exec !== TRUSTED_EXEC ||
    LocalDatabase.prototype.prepare !== TRUSTED_PREPARE ||
    LocalDatabase.prototype.status !== TRUSTED_STATUS ||
    LocalDatabase.prototype.workspaceEncryptionAttestation !==
      TRUSTED_ATTESTATION
  ) {
    return false;
  }
  for (const method of WORKSPACE_SQLCIPHER_CONNECTION_POLICY.ownMethodShadowsRejected) {
    if (Object.prototype.hasOwnProperty.call(database, method)) return false;
  }
  let attestation: ReturnType<LocalDatabase["workspaceEncryptionAttestation"]>;
  try {
    attestation = TRUSTED_ATTESTATION.call(database as LocalDatabase);
  } catch {
    return false;
  }
  if (
    !attestation ||
    attestation.kind !==
      WORKSPACE_SQLCIPHER_CONNECTION_POLICY.attestationKind ||
    attestation.driver !== "signal-sqlcipher" ||
    attestation.encrypted !== true ||
    attestation.keyApplied !== true ||
    attestation.schemaReadVerified !== true ||
    attestation.persistence !== "persistent" ||
    attestation.cipherIntegrityStatus !== "verified_clean" ||
    attestation.cipherIntegrityVerified !== true ||
    !Object.isFrozen(attestation) ||
    !attestation.cipherVersion.trim()
  ) {
    return false;
  }
  let status: ReturnType<LocalDatabase["status"]>;
  try {
    status = TRUSTED_STATUS.call(database as LocalDatabase);
  } catch {
    return false;
  }
  if (
    (database as LocalDatabase).databasePath === ":memory:" ||
    (database as LocalDatabase).driver !== "signal-sqlcipher" ||
    (database as LocalDatabase).cipherVersion?.trim() !==
      attestation.cipherVersion.trim() ||
    status.encrypted !== true ||
    status.cipher_version?.trim() !== attestation.cipherVersion.trim()
  ) {
    return false;
  }
  try {
    const rows = TRUSTED_PREPARE.call(
      database as LocalDatabase,
      WORKSPACE_SQLCIPHER_CONNECTION_POLICY.probeSql,
    ).all();
    if (rows.length !== 1) return false;
    const values = Object.values(rows[0]);
    return (
      values.length === 1 &&
      typeof values[0] === "string" &&
      values[0].trim() === attestation.cipherVersion.trim()
    );
  } catch {
    return false;
  }
}
