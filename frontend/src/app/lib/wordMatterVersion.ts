import type {
    Document as MatterDocument,
    Project,
} from "@/app/components/shared/types";
import type { DocumentVersion } from "@/app/lib/mikeApi";
import {
    AgentTaskWordArtifactSaveError,
    type AgentTaskWordArtifactRecoveryIssueCode,
    type AgentTaskWordArtifactVersion,
    type AgentTaskWordArtifactSaveIssueCode,
} from "@/app/lib/agentTaskWordArtifactSave";
import {
    readCurrentWordDocumentFile,
    writeCurrentWordCustomProperties,
} from "@/app/lib/wordOfficeBridge";
import {
    assertWordContractRevisionOpenBinding,
    encodeWordContractRevisionBinding,
    successorWordContractRevisionBinding,
    type WordContractRevisionBinding,
} from "@/app/lib/wordContractRevisionBinding";
import {
    encodeWordMemoSourceManifest,
    type BoundWordMemoSourceManifest,
} from "@/app/lib/wordMemoSourceManifest";
import type { WordMemoTaskBinding } from "@/app/lib/wordMemoTaskBinding";
import {
    assertWordTaskArtifactOpenBinding,
    encodeWordTaskArtifactBinding,
    sameWordTaskArtifactIdentity,
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
type SaveContractRevisionVersion = (
    taskId: string,
    documentId: string,
    baseVersionId: string,
    file: File,
    filename?: string,
) => Promise<DocumentVersion>;
type SaveTaskArtifactVersion = (
    taskId: string,
    documentId: string,
    baseVersionId: string,
    file: File,
    filename?: string,
) => Promise<AgentTaskWordArtifactVersion>;
type SaveBoundMemo = (input: {
    manifest: BoundWordMemoSourceManifest;
    baseVersionId: string;
    file: File;
    filename?: string;
}) => Promise<WordMemoTaskBinding>;

export type BoundMemoVersionSaveResult = {
    binding: WordMemoTaskBinding;
    manifest: BoundWordMemoSourceManifest;
    receiptSynchronized: boolean;
    receiptSyncError: string | null;
};

export type ContractRevisionVersionSaveResult = {
    version: DocumentVersion;
    successorBinding: WordContractRevisionBinding;
    receiptSynchronized: boolean;
    receiptSyncError: string | null;
    reopenRequired: boolean;
};

export type TaskArtifactVersionSaveResult = {
    version: DocumentVersion;
    successorBinding: WordTaskArtifactBinding;
    receiptSynchronized: boolean;
    receiptSyncError: string | null;
    reopenRequired: boolean;
    reverificationStarted: boolean;
    reverificationIssueCode: AgentTaskWordArtifactSaveIssueCode | null;
    reverificationRecoveryIssueCode: AgentTaskWordArtifactRecoveryIssueCode | null;
    reverificationRecoveryAction: "start_new_task" | null;
    reverificationMessage: string | null;
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

async function saveContractRevisionVersionToMike(
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

async function saveBoundMemoToTask(input: Parameters<SaveBoundMemo>[0]) {
    const { saveBoundWordMemoTaskFile } =
        await import("@/app/lib/wordMemoTaskBinding");
    return saveBoundWordMemoTaskFile(input);
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

/**
 * Saves only the prepared contract revision bound to the exact open Word
 * Document + Version. The immutable open-file identity and the mutable
 * server-current check are intentionally independent.
 */
export async function saveCurrentWordDocumentAsContractRevisionVersion(args: {
    document: MatterDocument;
    base: MatterDocumentVersionBase;
    openBinding: WordContractRevisionBinding | null | undefined;
    loadVersions?: LoadVersions;
    readWordFile?: typeof readCurrentWordDocumentFile;
    saveContractRevisionVersion?: SaveContractRevisionVersion;
    writeWordCustomProperties?: typeof writeCurrentWordCustomProperties;
}): Promise<ContractRevisionVersionSaveResult> {
    if (args.document.id !== args.base.documentId) {
        throw new Error("The selected Matter document changed before saving.");
    }

    const openBinding = assertWordContractRevisionOpenBinding(
        args.openBinding,
        args.base,
    );
    const loadVersions = args.loadVersions ?? loadVersionsFromMike;
    const readWordFile = args.readWordFile ?? readCurrentWordDocumentFile;
    const saveContractRevisionVersion =
        args.saveContractRevisionVersion ?? saveContractRevisionVersionToMike;

    assertVersionBaseMatches(args.base, await loadVersions(args.document.id));
    const filename = wordVersionFilename(args.document.filename);
    const file = await readWordFile({ filename });
    assertVersionBaseMatches(args.base, await loadVersions(args.document.id));
    const version = await saveContractRevisionVersion(
        openBinding.taskId,
        args.document.id,
        args.base.versionId,
        file,
        filename,
    );
    const successorBinding = successorWordContractRevisionBinding(
        openBinding,
        version.id,
    );

    try {
        await (
            args.writeWordCustomProperties ?? writeCurrentWordCustomProperties
        )(encodeWordContractRevisionBinding(successorBinding));
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
                error instanceof Error && error.message.trim()
                    ? error.message
                    : "Word could not update the saved revision receipt.",
            reopenRequired: true,
        };
    }
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
    const saveVersion = () =>
        saveTaskArtifactVersion(
            openBinding.taskId,
            args.document.id,
            args.base.versionId,
            file,
            filename,
        );
    let version: DocumentVersion;
    let reverificationIssueCode: AgentTaskWordArtifactSaveIssueCode | null =
        null;
    let reverificationRecoveryIssueCode: AgentTaskWordArtifactRecoveryIssueCode | null =
        null;
    let reverificationRecoveryAction: "start_new_task" | null = null;
    let reverificationMessage: string | null = null;
    try {
        version = await saveVersion();
    } catch (error) {
        if (
            !(error instanceof AgentTaskWordArtifactSaveError) ||
            !error.preservedVersion
        ) {
            throw error;
        }
        version = error.preservedVersion;
        reverificationIssueCode = error.issueCode;
        reverificationRecoveryIssueCode =
            error.reverificationIssue?.issueCode ?? null;
        reverificationRecoveryAction =
            error.reverificationIssue?.recoveryAction ?? null;
        reverificationMessage = error.message;
        if (error.issueCode === "reverification_unavailable") {
            try {
                const retried = await saveVersion();
                if (!sameWordTaskArtifactIdentity(retried.id, version.id)) {
                    throw new Error(
                        "The re-verification retry returned a different Word Version.",
                    );
                }
                version = retried;
                reverificationIssueCode = null;
                reverificationRecoveryIssueCode = null;
                reverificationRecoveryAction = null;
                reverificationMessage = null;
            } catch (retryError) {
                if (
                    retryError instanceof Error &&
                    retryError.message ===
                        "The re-verification retry returned a different Word Version."
                ) {
                    throw retryError;
                }
                if (
                    retryError instanceof AgentTaskWordArtifactSaveError &&
                    retryError.preservedVersion &&
                    sameWordTaskArtifactIdentity(
                        retryError.preservedVersion.id,
                        version.id,
                    )
                ) {
                    reverificationIssueCode = retryError.issueCode;
                    reverificationRecoveryIssueCode =
                        retryError.reverificationIssue?.issueCode ?? null;
                    reverificationRecoveryAction =
                        retryError.reverificationIssue?.recoveryAction ?? null;
                    reverificationMessage = retryError.message;
                }
            }
        }
    }
    const successorBinding = successorWordTaskArtifactBinding(
        openBinding,
        version.id,
    );
    if (reverificationIssueCode) {
        return {
            version,
            successorBinding,
            receiptSynchronized: false,
            receiptSyncError: null,
            reopenRequired: true,
            reverificationStarted: false,
            reverificationIssueCode,
            reverificationRecoveryIssueCode,
            reverificationRecoveryAction,
            reverificationMessage,
        };
    }
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
            reverificationStarted: true,
            reverificationIssueCode: null,
            reverificationRecoveryIssueCode: null,
            reverificationRecoveryAction: null,
            reverificationMessage: null,
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
            reverificationStarted: true,
            reverificationIssueCode: null,
            reverificationRecoveryIssueCode: null,
            reverificationRecoveryAction: null,
            reverificationMessage: null,
        };
    }
}

export async function saveCurrentWordDocumentAsBoundMemoVersion(args: {
    manifest: BoundWordMemoSourceManifest;
    binding: WordMemoTaskBinding;
    readWordFile?: typeof readCurrentWordDocumentFile;
    saveBoundMemo?: SaveBoundMemo;
    writeWordCustomProperties?: typeof writeCurrentWordCustomProperties;
}): Promise<BoundMemoVersionSaveResult> {
    if (
        args.binding.taskId !== args.manifest.taskId ||
        args.binding.projectId !== args.manifest.projectId ||
        args.binding.reviewId !== args.manifest.reviewId ||
        args.binding.memoDocumentId !== args.manifest.memoDocumentId ||
        args.binding.memoVersionId !== args.manifest.memoVersionId ||
        args.binding.inputDigest !== args.manifest.inputDigest
    ) {
        throw new Error(
            "The current Word Memo binding no longer matches its manifest.",
        );
    }
    const filename = wordVersionFilename(args.binding.memoFilename);
    const file = await (args.readWordFile ?? readCurrentWordDocumentFile)({
        filename,
    });
    const binding = await (args.saveBoundMemo ?? saveBoundMemoToTask)({
        manifest: args.manifest,
        baseVersionId: args.manifest.memoVersionId,
        file,
        filename,
    });
    const manifest: BoundWordMemoSourceManifest = {
        ...args.manifest,
        memoVersionId: binding.memoVersionId,
    };
    try {
        await (
            args.writeWordCustomProperties ?? writeCurrentWordCustomProperties
        )(encodeWordMemoSourceManifest(manifest));
        return {
            binding,
            manifest,
            receiptSynchronized: true,
            receiptSyncError: null,
        };
    } catch (error) {
        return {
            binding,
            manifest,
            receiptSynchronized: false,
            receiptSyncError:
                error instanceof Error && error.message.trim()
                    ? error.message
                    : "Word could not update the saved Memo Version receipt.",
        };
    }
}
