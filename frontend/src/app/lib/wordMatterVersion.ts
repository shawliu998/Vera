import type {
    Document as MatterDocument,
    Project,
} from "@/app/components/shared/types";
import type { DocumentVersion } from "@/app/lib/mikeApi";
import { readCurrentWordDocumentFile } from "@/app/lib/wordOfficeBridge";

export type MatterDocumentVersionBase = {
    documentId: string;
    versionId: string;
    versionNumber: number | null;
};

type VersionSnapshot = {
    current_version_id: string | null;
    versions: DocumentVersion[];
};

type LoadVersions = (documentId: string) => Promise<VersionSnapshot>;
type UploadVersion = (
    documentId: string,
    file: File,
    filename?: string,
) => Promise<DocumentVersion>;

async function loadVersionsFromMike(documentId: string) {
    const { listDocumentVersions } = await import("@/app/lib/mikeApi");
    return listDocumentVersions(documentId);
}

async function uploadVersionToMike(
    documentId: string,
    file: File,
    filename?: string,
) {
    const { uploadDocumentVersion } = await import("@/app/lib/mikeApi");
    return uploadDocumentVersion(documentId, file, filename);
}

export class MatterDocumentVersionDriftError extends Error {
    constructor() {
        super(
            "This Matter document has a newer version. Refresh the target before saving the Word document.",
        );
        this.name = "MatterDocumentVersionDriftError";
    }
}

export function listMatterWordDocuments(project: Project): MatterDocument[] {
    return (project.documents ?? []).filter((document) => {
        const fileType = document.file_type?.toLowerCase();
        return (
            fileType === "docx" ||
            fileType === "doc" ||
            /\.docx?$/i.test(document.filename)
        );
    });
}

export function currentMatterDocumentVersionBase(
    documentId: string,
    snapshot: VersionSnapshot,
): MatterDocumentVersionBase {
    const current = snapshot.versions.find(
        (version) => version.id === snapshot.current_version_id,
    );
    if (!snapshot.current_version_id || !current) {
        throw new Error(
            "This Matter document does not have a current version to update.",
        );
    }
    return {
        documentId,
        versionId: current.id,
        versionNumber: current.version_number,
    };
}

export async function loadMatterDocumentVersionBase(
    documentId: string,
    loadVersions: LoadVersions = loadVersionsFromMike,
): Promise<MatterDocumentVersionBase> {
    return currentMatterDocumentVersionBase(
        documentId,
        await loadVersions(documentId),
    );
}

function assertVersionBaseMatches(
    expected: MatterDocumentVersionBase,
    snapshot: VersionSnapshot,
): void {
    const current = currentMatterDocumentVersionBase(
        expected.documentId,
        snapshot,
    );
    if (
        current.versionId !== expected.versionId ||
        current.versionNumber !== expected.versionNumber
    ) {
        throw new MatterDocumentVersionDriftError();
    }
}

export function wordVersionFilename(filename: string): string {
    const trimmed = filename.trim() || "Word document.docx";
    if (/\.docx$/i.test(trimmed)) return trimmed;
    if (/\.doc$/i.test(trimmed)) return trimmed.replace(/\.doc$/i, ".docx");
    return `${trimmed}.docx`;
}

export async function saveCurrentWordDocumentAsMatterVersion(args: {
    document: MatterDocument;
    base: MatterDocumentVersionBase;
    loadVersions?: LoadVersions;
    readWordFile?: typeof readCurrentWordDocumentFile;
    uploadVersion?: UploadVersion;
}): Promise<DocumentVersion> {
    if (args.document.id !== args.base.documentId) {
        throw new Error("The selected Matter document changed before saving.");
    }

    const loadVersions = args.loadVersions ?? loadVersionsFromMike;
    const readWordFile = args.readWordFile ?? readCurrentWordDocumentFile;
    const uploadVersion = args.uploadVersion ?? uploadVersionToMike;

    assertVersionBaseMatches(
        args.base,
        await loadVersions(args.document.id),
    );
    const filename = wordVersionFilename(args.document.filename);
    const file = await readWordFile({ filename });
    // Exporting a long Word file can take time. Recheck immediately before
    // POSTing so a Matter version created during export fails closed.
    assertVersionBaseMatches(
        args.base,
        await loadVersions(args.document.id),
    );
    return uploadVersion(args.document.id, file, filename);
}
