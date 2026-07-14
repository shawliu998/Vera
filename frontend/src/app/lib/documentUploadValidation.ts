export const SUPPORTED_DOCUMENT_EXTENSIONS = [
  ".pdf",
  ".docx",
  ".xlsx",
  ".txt",
  ".md",
] as const;

export const SUPPORTED_DOCUMENT_ACCEPT =
  SUPPORTED_DOCUMENT_EXTENSIONS.join(",");

export const MAX_DOCUMENT_FILENAME_LENGTH = 240;

export const DOCUMENT_UPLOAD_ERROR_CODES = {
  invalidFile: "INVALID_DOCUMENT_UPLOAD",
  unsupportedType: "UNSUPPORTED_DOCUMENT_TYPE",
} as const;

export type DocumentUploadErrorCode =
  (typeof DOCUMENT_UPLOAD_ERROR_CODES)[keyof typeof DOCUMENT_UPLOAD_ERROR_CODES];

const SUPPORTED_EXTENSION_SET = new Set<string>(SUPPORTED_DOCUMENT_EXTENSIONS);

function pathExtension(filename: string): string {
  const normalized = filename.trim();
  const lastDot = normalized.lastIndexOf(".");
  // Mirrors path.extname for the safe, separator-free filenames accepted by
  // the workspace API. A single leading dot denotes a dotfile, not a suffix.
  return lastDot <= 0 ? "" : normalized.slice(lastDot).toLowerCase();
}

export function isSupportedDocumentFile(file: Pick<File, "name">): boolean {
  const name = (file as { name?: unknown } | null)?.name;
  return (
    typeof name === "string" && SUPPORTED_EXTENSION_SET.has(pathExtension(name))
  );
}
