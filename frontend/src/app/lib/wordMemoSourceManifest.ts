export const WORD_MEMO_SOURCE_MANIFEST_COUNT = "VeraMemoSourceManifestCount";
export const WORD_MEMO_SOURCE_MANIFEST_PREFIX = "VeraMemoSourceManifest";
export const WORD_MEMO_GENERATOR_VERSION = "tabular-review-word-memo-v1";

// Desktop Word truncates custom-property strings at 255 UTF-16 characters.
// Stay comfortably below that boundary and split by Unicode code point so a
// chunk never ends halfway through a surrogate pair.
const CUSTOM_PROPERTY_CHUNK_LENGTH = 200;

export type WordMemoSourceCitation = {
  reference: string;
  documentId: string;
  versionId: string;
  filename: string;
  page: number | null;
  locator: string;
  quote: string;
};

export type WordMemoSourceManifest = {
  schemaVersion: 1;
  generatorVersion?: typeof WORD_MEMO_GENERATOR_VERSION;
  projectId: string;
  reviewId: string;
  taskId?: string;
  memoDocumentId?: string;
  memoVersionId?: string;
  inputDigest?: string;
  citations: WordMemoSourceCitation[];
};

export type BoundWordMemoSourceManifest = WordMemoSourceManifest &
  Required<
    Pick<
      WordMemoSourceManifest,
      | "generatorVersion"
      | "taskId"
      | "memoDocumentId"
      | "memoVersionId"
      | "inputDigest"
    >
  >;

export type WordMemoSourceManifestClassification =
  | { kind: "absent" }
  | { kind: "checking" }
  | { kind: "read-error"; error: string }
  | { kind: "invalid" }
  | { kind: "legacy"; manifest: WordMemoSourceManifest }
  | { kind: "bound"; manifest: BoundWordMemoSourceManifest };

export type WordMemoCustomProperty = {
  name: string;
  value: string;
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isCitation(value: unknown): value is WordMemoSourceCitation {
  if (!value || typeof value !== "object") return false;
  const citation = value as Partial<WordMemoSourceCitation>;
  return (
    isNonEmptyString(citation.reference) &&
    isNonEmptyString(citation.documentId) &&
    isNonEmptyString(citation.versionId) &&
    isNonEmptyString(citation.filename) &&
    (citation.page === null ||
      (typeof citation.page === "number" &&
        Number.isInteger(citation.page) &&
        citation.page > 0)) &&
    isNonEmptyString(citation.locator) &&
    isNonEmptyString(citation.quote)
  );
}

export function encodeWordMemoSourceManifest(
  manifest: WordMemoSourceManifest,
): WordMemoCustomProperty[] {
  const chunks: string[] = [];
  // OOXML/custom-property readers may trim whitespace at the beginning or
  // end of each 255-character property. Escape compact JSON whitespace
  // before chunking so an exact source quote cannot lose a boundary space
  // during a DOCX round trip.
  const serialized = JSON.stringify(manifest).replace(
    /\s/g,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  const characters = Array.from(serialized);
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
      name: WORD_MEMO_SOURCE_MANIFEST_COUNT,
      value: String(chunks.length),
    },
    ...chunks.map((value, index) => ({
      name: `${WORD_MEMO_SOURCE_MANIFEST_PREFIX}${String(index + 1).padStart(3, "0")}`,
      value,
    })),
  ];
}

export function decodeWordMemoSourceManifest(
  properties: Readonly<Record<string, string>>,
): WordMemoSourceManifest | null {
  const count = Number(properties[WORD_MEMO_SOURCE_MANIFEST_COUNT]);
  if (!Number.isInteger(count) || count < 1 || count > 500) return null;

  const chunks: string[] = [];
  for (let index = 1; index <= count; index += 1) {
    const chunk =
      properties[
        `${WORD_MEMO_SOURCE_MANIFEST_PREFIX}${String(index).padStart(3, "0")}`
      ];
    if (typeof chunk !== "string") return null;
    chunks.push(chunk);
  }

  try {
    const value = JSON.parse(
      chunks.join(""),
    ) as Partial<WordMemoSourceManifest>;
    if (
      value.schemaVersion !== 1 ||
      (value.generatorVersion !== undefined &&
        value.generatorVersion !== WORD_MEMO_GENERATOR_VERSION) ||
      !isNonEmptyString(value.projectId) ||
      !isNonEmptyString(value.reviewId) ||
      (value.taskId !== undefined && !isNonEmptyString(value.taskId)) ||
      (value.memoDocumentId !== undefined &&
        !isNonEmptyString(value.memoDocumentId)) ||
      (value.memoVersionId !== undefined &&
        !isNonEmptyString(value.memoVersionId)) ||
      (value.inputDigest !== undefined &&
        !isNonEmptyString(value.inputDigest)) ||
      !Array.isArray(value.citations) ||
      !value.citations.every(isCitation)
    ) {
      return null;
    }
    return value as WordMemoSourceManifest;
  } catch {
    return null;
  }
}

export function classifyWordMemoSourceManifest(
  properties: Readonly<Record<string, string>>,
): WordMemoSourceManifestClassification {
  const hasManifestProperty = Object.keys(properties).some((name) =>
    name.startsWith(WORD_MEMO_SOURCE_MANIFEST_PREFIX),
  );
  if (!hasManifestProperty) return { kind: "absent" };

  const manifest = decodeWordMemoSourceManifest(properties);
  if (!manifest) return { kind: "invalid" };

  const hintPresence = [
    manifest.taskId !== undefined,
    manifest.memoDocumentId !== undefined,
    manifest.memoVersionId !== undefined,
    manifest.inputDigest !== undefined,
  ];
  if (hintPresence.every((present) => !present)) {
    return { kind: "legacy", manifest };
  }
  if (
    hintPresence.every(Boolean) &&
    manifest.generatorVersion === WORD_MEMO_GENERATOR_VERSION
  ) {
    return {
      kind: "bound",
      manifest: manifest as BoundWordMemoSourceManifest,
    };
  }
  return { kind: "invalid" };
}
