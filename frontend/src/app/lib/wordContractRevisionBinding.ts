/**
 * A compact, versioned identity receipt carried by a prepared contract
 * revision while it is open in Word. This is deliberately an exact
 * DocumentVersion identity, not a filename nor the server's mutable current
 * version. The server-current check remains a separate concurrency guard.
 */
export const WORD_CONTRACT_REVISION_BINDING_COUNT =
  "VeraContractRevisionBindingCount";
export const WORD_CONTRACT_REVISION_BINDING_PREFIX =
  "VeraContractRevisionBinding";
export const WORD_CONTRACT_REVISION_BINDING_KIND =
  "contract-playbook-word-handoff-v1";

// Desktop Word can truncate custom-property strings at 255 UTF-16 code units.
// Keep each payload comfortably below that boundary.
const CUSTOM_PROPERTY_CHUNK_LENGTH = 200;
const RAW_UUID_HEX = /^[0-9a-f]{32}$/i;
const CANONICAL_UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export type WordContractRevisionBinding = {
  schemaVersion: 1;
  kind: typeof WORD_CONTRACT_REVISION_BINDING_KIND;
  taskId: string;
  projectId: string;
  documentId: string;
  versionId: string;
};

export type WordContractRevisionBindingCustomProperty = {
  name: string;
  value: string;
};

export type WordContractRevisionBindingClassification =
  | { kind: "absent" }
  | { kind: "invalid" }
  | { kind: "bound"; binding: WordContractRevisionBinding };

export class WordContractRevisionOpenIdentityError extends Error {
  constructor() {
    super(
      "The current document is not this task's prepared revision. Reopen it from Vera.",
    );
    this.name = "WordContractRevisionOpenIdentityError";
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function canonicalUuidIdentity(value: string): string | null {
  const raw = RAW_UUID_HEX.test(value)
    ? value.toLowerCase()
    : CANONICAL_UUID.test(value)
      ? value.replaceAll("-", "").toLowerCase()
      : null;
  if (!raw) return null;
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
}

function samePersistedIdentity(left: string, right: string): boolean {
  if (left === right) return true;
  const canonicalLeft = canonicalUuidIdentity(left);
  const canonicalRight = canonicalUuidIdentity(right);
  return (
    canonicalLeft !== null &&
    canonicalRight !== null &&
    canonicalLeft === canonicalRight
  );
}

function canonicalizeBinding(
  binding: WordContractRevisionBinding,
): WordContractRevisionBinding {
  return {
    ...binding,
    taskId: canonicalUuidIdentity(binding.taskId) ?? binding.taskId,
    projectId: canonicalUuidIdentity(binding.projectId) ?? binding.projectId,
    documentId: canonicalUuidIdentity(binding.documentId) ?? binding.documentId,
    versionId: canonicalUuidIdentity(binding.versionId) ?? binding.versionId,
  };
}

function isWordContractRevisionBinding(
  value: unknown,
): value is WordContractRevisionBinding {
  if (!value || typeof value !== "object") return false;
  const binding = value as Partial<WordContractRevisionBinding>;
  return (
    binding.schemaVersion === 1 &&
    binding.kind === WORD_CONTRACT_REVISION_BINDING_KIND &&
    isNonEmptyString(binding.taskId) &&
    isNonEmptyString(binding.projectId) &&
    isNonEmptyString(binding.documentId) &&
    isNonEmptyString(binding.versionId)
  );
}

export function encodeWordContractRevisionBinding(
  binding: WordContractRevisionBinding,
): WordContractRevisionBindingCustomProperty[] {
  const serialized = JSON.stringify(binding).replace(
    /\s/g,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  const characters = Array.from(serialized);
  const chunks: string[] = [];
  for (
    let offset = 0;
    offset < characters.length;
    offset += CUSTOM_PROPERTY_CHUNK_LENGTH
  ) {
    chunks.push(
      characters.slice(offset, offset + CUSTOM_PROPERTY_CHUNK_LENGTH).join(""),
    );
  }
  return [
    {
      name: WORD_CONTRACT_REVISION_BINDING_COUNT,
      value: String(chunks.length),
    },
    ...chunks.map((value, index) => ({
      name: `${WORD_CONTRACT_REVISION_BINDING_PREFIX}${String(index + 1).padStart(3, "0")}`,
      value,
    })),
  ];
}

export function decodeWordContractRevisionBinding(
  properties: Readonly<Record<string, string>>,
): WordContractRevisionBinding | null {
  const count = Number(properties[WORD_CONTRACT_REVISION_BINDING_COUNT]);
  if (!Number.isInteger(count) || count < 1 || count > 20) return null;

  const chunks: string[] = [];
  for (let index = 1; index <= count; index += 1) {
    const chunk =
      properties[
        `${WORD_CONTRACT_REVISION_BINDING_PREFIX}${String(index).padStart(3, "0")}`
      ];
    if (typeof chunk !== "string") return null;
    chunks.push(chunk);
  }

  try {
    const value: unknown = JSON.parse(chunks.join(""));
    return isWordContractRevisionBinding(value)
      ? canonicalizeBinding(value)
      : null;
  } catch {
    return null;
  }
}

export function classifyWordContractRevisionBinding(
  properties: Readonly<Record<string, string>>,
): WordContractRevisionBindingClassification {
  const hasBindingProperty = Object.keys(properties).some((name) =>
    name.startsWith(WORD_CONTRACT_REVISION_BINDING_PREFIX),
  );
  if (!hasBindingProperty) return { kind: "absent" };

  const binding = decodeWordContractRevisionBinding(properties);
  return binding ? { kind: "bound", binding } : { kind: "invalid" };
}

/**
 * Ensures that the actual Word document identity matches the exact selected
 * prepared revision/base. It intentionally does not inspect a server-current
 * version: callers perform that independent drift check before and after
 * exporting Word bytes.
 */
export function assertWordContractRevisionOpenBinding(
  binding: WordContractRevisionBinding | null | undefined,
  expected: { documentId: string; versionId: string },
): WordContractRevisionBinding {
  if (
    !isWordContractRevisionBinding(binding) ||
    !samePersistedIdentity(binding.documentId, expected.documentId) ||
    !samePersistedIdentity(binding.versionId, expected.versionId)
  ) {
    throw new WordContractRevisionOpenIdentityError();
  }
  return binding;
}

/**
 * The upload receipt is authoritative for the successor open identity. The
 * caller must persist this value to Word before it permits another save.
 */
export function successorWordContractRevisionBinding(
  binding: WordContractRevisionBinding,
  versionId: string,
): WordContractRevisionBinding {
  if (!isNonEmptyString(versionId)) {
    throw new Error("The server did not return a Version identity.");
  }
  return { ...binding, versionId };
}
