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

const LEGACY_CREDENTIAL_REFERENCE =
  /^keychain:\/\/vera\/model-profile\/([0-9a-f-]{36})$/i;
const OPAQUE_CREDENTIAL_REFERENCE =
  /^keychain:\/\/vera\/model-profile\/([0-9a-f-]{36})\/([a-z0-9]{16,128})$/i;

export interface CredentialResolverPort {
  resolve(input: CredentialResolutionInput): string;
}

export interface CredentialStorePort extends CredentialResolverPort {
  store(input: { binding: CredentialBindingKey; secret: string }): {
    reference: StoredCredentialReference;
  };
  delete(reference: StoredCredentialReference): void;
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
  return `keychain://vera/model-profile/${profileId}/${locatorId.toLowerCase()}`;
}

export function isStoredCredentialReference(
  value: unknown,
  expectedProfileId?: string,
) {
  if (typeof value !== "string") return false;
  const modern = value.match(OPAQUE_CREDENTIAL_REFERENCE);
  if (modern) {
    return expectedProfileId ? modern[1] === expectedProfileId : true;
  }
  const legacy = value.match(LEGACY_CREDENTIAL_REFERENCE);
  if (legacy) {
    return expectedProfileId ? legacy[1] === expectedProfileId : true;
  }
  return false;
}

export function parseStoredCredentialReference(
  value: unknown,
  expectedProfileId?: string,
) {
  if (typeof value !== "string") return null;
  const modern = value.match(OPAQUE_CREDENTIAL_REFERENCE);
  if (modern) {
    if (expectedProfileId && modern[1] !== expectedProfileId) return null;
    return {
      profileId: modern[1],
      locatorId: modern[2],
    };
  }
  const legacy = value.match(LEGACY_CREDENTIAL_REFERENCE);
  if (legacy) {
    if (expectedProfileId && legacy[1] !== expectedProfileId) return null;
    return {
      profileId: legacy[1],
      locatorId: null,
    };
  }
  return null;
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
  const modern = value.match(OPAQUE_CREDENTIAL_REFERENCE);
  if (modern) {
    return `keychain://vera/model-profile/${modern[1]}/[redacted]`;
  }
  const legacy = value.match(LEGACY_CREDENTIAL_REFERENCE);
  if (legacy) {
    return `keychain://vera/model-profile/${legacy[1]}/[redacted]`;
  }
  return "[redacted]";
}
