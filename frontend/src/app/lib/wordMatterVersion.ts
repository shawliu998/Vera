import type {
    Document as MatterDocument,
    Project,
} from "@/app/components/shared/types";
import type { DocumentVersion } from "@/app/lib/mikeApi";
import {
    readCurrentWordDocumentFile,
    writeCurrentWordCustomProperties,
} from "@/app/lib/wordOfficeBridge";
import {
    assertWordTaskArtifactOpenBinding,
    encodeWordTaskArtifactBinding,
    successorWordTaskArtifactBinding,
    type WordTaskArtifactBinding,
} from "@/app/lib/wordTaskArtifactBinding";

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
type SaveTaskArtifactVersion = (
    taskId: string,
    documentId: string,
    baseVersionId: string,
    file: File,
    filename?: string,
) => Promise<DocumentVersion>;

export type TaskArtifactVersionSaveResult = {
    version: DocumentVersion;
    successorBinding: WordTaskArtifactBinding;
    receiptSynchronized: boolean;
    receiptSyncError: string | null;
    reopenRequired: boolean;
};

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

async function saveTaskArtifactVersionToMike(
    taskId: string,
    documentId: string,
    baseVersionId: string,
    file: File,
    filename?: string,
) {
    const { saveAgentTaskWordArtifactVersion } =
        await import("@/app/lib/mikeApi");
    return saveAgentTaskWordArtifactVersion(
        taskId,
        documentId,
        baseVersionId,
        file,
        filename,
    );
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

export async function saveCurrentWordDocumentAsTaskArtifactVersion(args: {
    taskId: string;
    projectId: string;
    deliverableKey: string;
    document: MatterDocument;
    base: MatterDocumentVersionBase;
    openBinding: WordTaskArtifactBinding | null | undefined;
    loadVersions?: LoadVersions;
    readWordFile?: typeof readCurrentWordDocumentFile;
    saveTaskArtifactVersion?: SaveTaskArtifactVersion;
    writeWordCustomProperties?: typeof writeCurrentWordCustomProperties;
}): Promise<TaskArtifactVersionSaveResult> {
    if (args.document.id !== args.base.documentId) {
        throw new Error("The selected Matter document changed before saving.");
    }
    const openBinding = assertWordTaskArtifactOpenBinding(args.openBinding, {
        taskId: args.taskId,
        projectId: args.projectId,
        deliverableKey: args.deliverableKey,
        documentId: args.document.id,
        versionId: args.base.versionId,
    });
    const loadVersions = args.loadVersions ?? loadVersionsFromMike;
    const readWordFile = args.readWordFile ?? readCurrentWordDocumentFile;
    const saveTaskArtifactVersion =
        args.saveTaskArtifactVersion ?? saveTaskArtifactVersionToMike;
    assertVersionBaseMatches(args.base, await loadVersions(args.document.id));
    const filename = wordVersionFilename(args.document.filename);
    const file = await readWordFile({ filename });
    assertVersionBaseMatches(args.base, await loadVersions(args.document.id));
    const version = await saveTaskArtifactVersion(
        openBinding.taskId,
        args.document.id,
        args.base.versionId,
        file,
        filename,
    );
    const successorBinding = successorWordTaskArtifactBinding(
        openBinding,
        version.id,
    );
    try {
        await (
            args.writeWordCustomProperties ?? writeCurrentWordCustomProperties
        )(encodeWordTaskArtifactBinding(successorBinding));
        return {
            version,
            successorBinding,
            receiptSynchronized: true,
            receiptSyncError: null,
            reopenRequired: false,
        };
    } catch (error) {
        return {
            version,
            successorBinding,
            receiptSynchronized: false,
            receiptSyncError:
                error instanceof Error
                    ? error.message
                    : "The open Word receipt could not be updated.",
            reopenRequired: true,
        };
    }
}
