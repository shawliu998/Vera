import type {
    getDocumentUrl as MikeGetDocumentUrl,
    getDocumentVersionDocx as MikeGetDocumentVersionDocx,
} from "@/app/lib/mikeApi";

export type WordLaunchDependencies = {
    getDocumentUrl?: typeof MikeGetDocumentUrl;
    getDocumentBytes?: typeof MikeGetDocumentVersionDocx;
    navigate?: (uri: string) => void;
    download?: (blob: Blob, filename: string) => void;
};

export type WordLaunchReceipt = Readonly<{
    status: "launch_requested";
    documentId: string;
    requestedVersionId: string;
    resolvedVersionId: string;
    signedUrl: string;
    launchUri: string;
}>;

export type WordDownloadReceipt = Readonly<{
    status: "download_requested";
    documentId: string;
    requestedVersionId: string;
    resolvedVersionId: string;
    signedUrl: string;
    filename: string;
    byteLength: number;
}>;

export type WordLaunchFailureCode =
    | "document_url_unavailable"
    | "version_mismatch"
    | "invalid_document_url"
    | "word_launch_failed"
    | "document_download_failed";

export class WordLaunchError extends Error {
    readonly code: WordLaunchFailureCode;
    readonly documentId: string;
    readonly versionId: string;

    constructor(
        code: WordLaunchFailureCode,
        documentId: string,
        versionId: string,
        message: string,
    ) {
        super(message);
        this.name = "WordLaunchError";
        this.code = code;
        this.documentId = documentId;
        this.versionId = versionId;
    }
}

function assertHttpDocumentUrl(url: string): void {
    if (url.includes("|")) {
        throw new Error("The Word document URL is invalid.");
    }
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        throw new Error("The Word document URL is invalid.");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("The Word document URL must use HTTP or HTTPS.");
    }
}

export function wordLaunchUri(url: string): string {
    assertHttpDocumentUrl(url);
    return `ms-word:ofe|u|${url}`;
}

function navigateToWord(uri: string): void {
    window.location.assign(uri);
}

function downloadDocument(blob: Blob, filename: string): void {
    const objectUrl = URL.createObjectURL(blob);
    const anchor = window.document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = filename;
    window.document.body.appendChild(anchor);
    try {
        anchor.click();
    } finally {
        anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
    }
}

async function loadDocumentUrlFromMike(documentId: string, versionId: string) {
    const { getDocumentUrl } = await import("@/app/lib/mikeApi");
    return getDocumentUrl(documentId, versionId);
}

async function loadDocumentBytesFromMike(
    documentId: string,
    versionId: string,
) {
    const { getDocumentVersionDocx } = await import("@/app/lib/mikeApi");
    return getDocumentVersionDocx(documentId, versionId);
}

type ExactDocumentVersion = {
    signedUrl: string;
    filename: string;
    resolvedVersionId: string;
};

type ExactDocumentUrlLoader = (
    documentId: string,
    versionId: string,
) => ReturnType<typeof MikeGetDocumentUrl>;

async function resolveExactDocumentVersion(
    documentId: string,
    versionId: string,
    getDocumentUrl: ExactDocumentUrlLoader,
): Promise<ExactDocumentVersion> {
    let document: Awaited<ReturnType<typeof getDocumentUrl>>;
    try {
        document = await getDocumentUrl(documentId, versionId);
    } catch {
        throw new WordLaunchError(
            "document_url_unavailable",
            documentId,
            versionId,
            "Word could not get the requested document version. Refresh the task and try again.",
        );
    }
    if (document.version_id !== versionId) {
        throw new WordLaunchError(
            "version_mismatch",
            documentId,
            versionId,
            "Word could not confirm the requested document version. Refresh the task and try again.",
        );
    }
    try {
        assertHttpDocumentUrl(document.url);
    } catch {
        throw new WordLaunchError(
            "invalid_document_url",
            documentId,
            versionId,
            "Word could not prepare the requested document version. Refresh the task and try again.",
        );
    }
    return {
        signedUrl: document.url,
        filename: document.filename,
        resolvedVersionId: document.version_id,
    };
}

export async function openDocumentVersionInWord(
    documentId: string,
    versionId: string,
    dependencies: WordLaunchDependencies = {},
): Promise<WordLaunchReceipt> {
    const getDocumentUrl =
        dependencies.getDocumentUrl ?? loadDocumentUrlFromMike;
    const navigate = dependencies.navigate ?? navigateToWord;
    const document = await resolveExactDocumentVersion(
        documentId,
        versionId,
        getDocumentUrl,
    );
    const launchUri = wordLaunchUri(document.signedUrl);
    try {
        navigate(launchUri);
    } catch {
        throw new WordLaunchError(
            "word_launch_failed",
            documentId,
            versionId,
            "Word could not open the requested document version. Refresh the task and try again.",
        );
    }
    return {
        status: "launch_requested",
        documentId,
        requestedVersionId: versionId,
        resolvedVersionId: document.resolvedVersionId,
        signedUrl: document.signedUrl,
        launchUri,
    };
}

export async function downloadDocumentVersionForWord(
    documentId: string,
    versionId: string,
    dependencies: WordLaunchDependencies = {},
): Promise<WordDownloadReceipt> {
    const getDocumentUrl =
        dependencies.getDocumentUrl ?? loadDocumentUrlFromMike;
    const getDocumentBytes =
        dependencies.getDocumentBytes ?? loadDocumentBytesFromMike;
    const download = dependencies.download ?? downloadDocument;
    const document = await resolveExactDocumentVersion(
        documentId,
        versionId,
        getDocumentUrl,
    );
    let blob: Blob;
    try {
        blob = await getDocumentBytes(documentId, versionId);
    } catch {
        throw new WordLaunchError(
            "document_download_failed",
            documentId,
            versionId,
            "Vera could not download the requested document version. Refresh the task and try again.",
        );
    }
    if (
        blob.size < 1 ||
        blob.type !==
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ) {
        throw new WordLaunchError(
            "document_download_failed",
            documentId,
            versionId,
            "Vera could not verify the requested DOCX bytes. Refresh the task and try again.",
        );
    }
    try {
        download(blob, document.filename);
    } catch {
        throw new WordLaunchError(
            "document_download_failed",
            documentId,
            versionId,
            "Vera could not download the requested document version. Refresh the task and try again.",
        );
    }
    return {
        status: "download_requested",
        documentId,
        requestedVersionId: versionId,
        resolvedVersionId: document.resolvedVersionId,
        signedUrl: document.signedUrl,
        filename: document.filename,
        byteLength: blob.size,
    };
}
