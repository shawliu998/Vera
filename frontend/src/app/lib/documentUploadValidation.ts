export const SUPPORTED_DOCUMENT_ACCEPT = ".pdf,.docx,.doc,.xlsx";
export const UNSUPPORTED_DOCUMENT_WARNING_MESSAGE =
    "Unsupported file type. Only PDF, DOCX, DOC, and XLSX files can be uploaded.";

const SUPPORTED_DOCUMENT_EXTENSIONS = new Set(["pdf", "docx", "doc", "xlsx"]);

export function isSupportedDocumentFile(file: File): boolean {
    const extension = file.name.split(".").pop()?.toLowerCase();
    return !!extension && SUPPORTED_DOCUMENT_EXTENSIONS.has(extension);
}

export function partitionSupportedDocumentFiles(files: File[]) {
    const supported: File[] = [];
    const unsupported: File[] = [];

    for (const file of files) {
        if (isSupportedDocumentFile(file)) supported.push(file);
        else unsupported.push(file);
    }

    return { supported, unsupported };
}

export function formatUnsupportedDocumentWarning(files: File[]): string | null {
    if (files.length === 0) return null;
    return UNSUPPORTED_DOCUMENT_WARNING_MESSAGE;
}
