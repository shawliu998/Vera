import { WorkspaceApiError } from "../errors";
import type { ModelProvider } from "../modelCompatibility";

export type CredentialBindingKey = {
  profileId: string;
  provider: ModelProvider;
  canonicalOrigin: string;
};

export type StoredCredentialReference = string;
export type CredentialResolutionInput = {
  reference: StoredCredentialReference;
  binding: CredentialBindingKey;
};
export type CredentialDeletionInput = CredentialResolutionInput;
export type CredentialStorageInput = CredentialResolutionInput & {
  secret: string;
};

/**
 * Credential stores cross a process boundary in the desktop build.  The
 * explicit mode prevents a caller from discovering an asynchronous store only
 * after it has already started a write.
 */
export const CREDENTIAL_STORE_OPERATION_MODE = Symbol(
  "vera.workspace.credential-store.operation-mode",
);

export class CredentialStoreCollisionError extends Error {
  readonly code = "CREDENTIAL_STORE_COLLISION";

  constructor() {
    super("Credential locator already exists.");
    this.name = "CredentialStoreCollisionError";
  }
}

const LEGACY_CREDENTIAL_REFERENCE =
  /^keychain:\/\/vera\/model-profile\/([0-9a-f-]{36})$/i;
const OPAQUE_CREDENTIAL_REFERENCE =
  /^keychain:\/\/vera\/model-profile\/([0-9a-f-]{36})\/([a-z0-9]{16,128})$/i;

export interface CredentialResolverPort {
  resolve(input: CredentialResolutionInput): string | Promise<string>;
}

export interface CredentialStorePort extends CredentialResolverPort {
  readonly [CREDENTIAL_STORE_OPERATION_MODE]: "synchronous" | "asynchronous";
  /** A synchronous snapshot. Async stores must report true only after a successful probe. */
  isAvailable(): boolean;
  /**
   * Creates the exact preallocated locator without replacement. Implementations
   * must throw CredentialStoreCollisionError only when collision-before-write
   * is certain. Other failures are treated as indeterminate and may have written
   * the item. A successful return attests that the exact reference and binding
   * were stored.
   */
  store(input: CredentialStorageInput): void | Promise<void>;
  /** The binding is required to reconstruct an origin-bound account after restart. */
  delete(input: CredentialDeletionInput): void | Promise<void>;
}

export interface SynchronousCredentialStorePort extends CredentialStorePort {
  readonly [CREDENTIAL_STORE_OPERATION_MODE]: "synchronous";
  resolve(input: CredentialResolutionInput): string;
  store(input: CredentialStorageInput): void;
  delete(input: CredentialDeletionInput): void;
}

export interface AsynchronousCredentialStorePort extends CredentialStorePort {
  readonly [CREDENTIAL_STORE_OPERATION_MODE]: "asynchronous";
  resolve(input: CredentialResolutionInput): Promise<string>;
  store(input: CredentialStorageInput): Promise<void>;
  delete(input: CredentialDeletionInput): Promise<void>;
}

export function buildStoredCredentialReference(
  profileId: string,
  locatorId: string,
) {
  if (!/^[0-9a-f-]{36}$/i.test(profileId)) {
    throw new WorkspaceApiError(
      400,
      "VALIDATION_ERROR",
      "Credential reference is invalid.",
    );
  }
  if (!/^[a-z0-9]{16,128}$/i.test(locatorId)) {
    throw new WorkspaceApiError(
      400,
      "VALIDATION_ERROR",
      "Credential reference is invalid.",
    );
  }
  return `keychain://vera/model-profile/${profileId.toLowerCase()}/${locatorId.toLowerCase()}`;
}

export function parseStoredCredentialReference(
  value: unknown,
  expectedProfileId?: string,
) {
  if (typeof value !== "string") return null;
  const expected = expectedProfileId?.toLowerCase();
  const modern = value.match(OPAQUE_CREDENTIAL_REFERENCE);
  if (modern) {
    const profileId = modern[1].toLowerCase();
    if (expected && profileId !== expected) return null;
    return {
      profileId,
      locatorId: modern[2].toLowerCase(),
    };
  }
  const legacy = value.match(LEGACY_CREDENTIAL_REFERENCE);
  if (legacy) {
    const profileId = legacy[1].toLowerCase();
    if (expected && profileId !== expected) return null;
    return {
      profileId,
      locatorId: null,
    };
  }
  return null;
}

export function canonicalizeStoredCredentialReference(
  value: unknown,
  expectedProfileId?: string,
) {
  const parsed = parseStoredCredentialReference(value, expectedProfileId);
  if (!parsed) return null;
  const prefix = `keychain://vera/model-profile/${parsed.profileId}`;
  return parsed.locatorId ? `${prefix}/${parsed.locatorId}` : prefix;
}

export function isStoredCredentialReference(
  value: unknown,
  expectedProfileId?: string,
) {
  return (
    canonicalizeStoredCredentialReference(value, expectedProfileId) !== null
  );
}

export function assertStoredCredentialReference(
  value: unknown,
  expectedProfileId?: string,
): asserts value is StoredCredentialReference {
  if (!isStoredCredentialReference(value, expectedProfileId)) {
    throw new WorkspaceApiError(
      400,
      "VALIDATION_ERROR",
      "Credential reference is invalid.",
    );
  }
}

export function redactStoredCredentialReference(
  value: StoredCredentialReference | null,
) {
  if (!value) return null;
  const parsed = parseStoredCredentialReference(value);
  if (parsed)
    return `keychain://vera/model-profile/${parsed.profileId}/[redacted]`;
  return "[redacted]";
}
