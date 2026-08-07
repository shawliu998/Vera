import assert from "node:assert/strict";
import test from "node:test";
import type {
    Document as MatterDocument,
    Project,
} from "@/app/components/shared/types";
import type { DocumentVersion } from "./mikeApi";
import type { WordTaskArtifactBinding } from "./wordTaskArtifactBinding";
import {
    currentMatterDocumentVersionBase,
    listMatterWordDocuments,
    MatterDocumentVersionDriftError,
    saveCurrentWordDocumentAsMatterVersion,
    saveCurrentWordDocumentAsTaskArtifactVersion,
    wordVersionFilename,
} from "./wordMatterVersion";

function matterDocument(
    overrides: Partial<MatterDocument> = {},
): MatterDocument {
    return {
        id: "document-1",
        project_id: "matter-1",
        filename: "Contract.docx",
        file_type: "docx",
        storage_path: "matter/contract.docx",
        pdf_storage_path: null,
        size_bytes: 128,
        page_count: 2,
        structure_tree: null,
        status: "ready",
        created_at: "2026-07-22T00:00:00.000Z",
        ...overrides,
    };
}

function version(
    id: string,
    versionNumber: number,
): DocumentVersion {
    return {
        id,
        version_number: versionNumber,
        source: "upload",
        created_at: "2026-07-22T00:00:00.000Z",
        filename: "Contract.docx",
    };
}

const BASE_SNAPSHOT = {
    current_version_id: "version-2",
    versions: [version("version-1", 1), version("version-2", 2)],
};

const taskArtifactBinding: WordTaskArtifactBinding = {
    schemaVersion: 1,
    kind: "agent-task-word-artifact-v1",
    taskId: "task-1",
    projectId: "matter-1",
    deliverableKey: "claim-comparison-memo",
    documentId: "document-1",
    versionId: "version-2",
};

test("lists only explicit Word targets from the selected Matter", () => {
    const project: Project = {
        id: "matter-1",
        user_id: "user-1",
        name: "Matter Cedar",
        cm_number: null,
        practice: null,
        shared_with: [],
        created_at: "2026-07-22T00:00:00.000Z",
        updated_at: "2026-07-22T00:00:00.000Z",
        documents: [
            matterDocument(),
            matterDocument({
                id: "legacy-word",
                filename: "Legacy terms.DOC",
                file_type: null,
            }),
            matterDocument({
                id: "pdf-1",
                filename: "Evidence.pdf",
                file_type: "pdf",
            }),
        ],
    };

    assert.deepEqual(
        listMatterWordDocuments(project).map((document) => document.id),
        ["document-1", "legacy-word"],
    );
    assert.equal(wordVersionFilename("Legacy terms.DOC"), "Legacy terms.docx");
});

test("saves the current Word file with POST version semantics after two base checks", async () => {
    const document = matterDocument();
    const base = currentMatterDocumentVersionBase(
        document.id,
        BASE_SNAPSHOT,
    );
    let loadCount = 0;
    let readCount = 0;
    const uploads: Array<{
        documentId: string;
        filename: string;
        file: File;
    }> = [];

    const saved = await saveCurrentWordDocumentAsMatterVersion({
        document,
        base,
        loadVersions: async () => {
            loadCount += 1;
            return BASE_SNAPSHOT;
        },
        readWordFile: async ({ filename }) => {
            readCount += 1;
            return new File([Uint8Array.from([80, 75])], filename);
        },
        uploadVersion: async (documentId, file, filename) => {
            uploads.push({
                documentId,
                file,
                filename: filename ?? file.name,
            });
            return version("version-3", 3);
        },
    });

    assert.equal(loadCount, 2);
    assert.equal(readCount, 1);
    assert.equal(uploads[0]?.documentId, "document-1");
    assert.equal(uploads[0]?.filename, "Contract.docx");
    assert.equal(uploads[0]?.file.name, "Contract.docx");
    assert.equal(saved.version_number, 3);
});

test("fails closed before export when the selected Matter version drifted", async () => {
    const document = matterDocument();
    let readCount = 0;
    let uploadCount = 0;

    await assert.rejects(
        () =>
            saveCurrentWordDocumentAsMatterVersion({
                document,
                base: {
                    documentId: document.id,
                    versionId: "version-1",
                    versionNumber: 1,
                },
                loadVersions: async () => BASE_SNAPSHOT,
                readWordFile: async ({ filename }) => {
                    readCount += 1;
                    return new File([], filename);
                },
                uploadVersion: async () => {
                    uploadCount += 1;
                    return version("version-3", 3);
                },
            }),
        MatterDocumentVersionDriftError,
    );
    assert.equal(readCount, 0);
    assert.equal(uploadCount, 0);
});

test("fails closed when the Matter version changes during Word export", async () => {
    const document = matterDocument();
    let loadCount = 0;
    let uploadCount = 0;

    await assert.rejects(
        () =>
            saveCurrentWordDocumentAsMatterVersion({
                document,
                base: currentMatterDocumentVersionBase(
                    document.id,
                    BASE_SNAPSHOT,
                ),
                loadVersions: async () => {
                    loadCount += 1;
                    return loadCount === 1
                        ? BASE_SNAPSHOT
                        : {
                              current_version_id: "version-3",
                              versions: [version("version-3", 3)],
                          };
                },
                readWordFile: async ({ filename }) => new File([], filename),
                uploadVersion: async () => {
                    uploadCount += 1;
                    return version("version-4", 4);
                },
            }),
        MatterDocumentVersionDriftError,
    );
    assert.equal(loadCount, 2);
    assert.equal(uploadCount, 0);
});

test("Task artifact save uses the bound server route and advances the local receipt", async () => {
    const document = matterDocument();
    const writtenProperties: Array<{ name: string; value: string }> = [];
    const result = await saveCurrentWordDocumentAsTaskArtifactVersion({
        taskId: taskArtifactBinding.taskId,
        projectId: taskArtifactBinding.projectId,
        deliverableKey: taskArtifactBinding.deliverableKey,
        document,
        base: currentMatterDocumentVersionBase(document.id, BASE_SNAPSHOT),
        openBinding: taskArtifactBinding,
        loadVersions: async () => BASE_SNAPSHOT,
        readWordFile: async ({ filename }) =>
            new File(["edited"], filename),
        saveTaskArtifactVersion: async (
            taskId,
            documentId,
            baseVersionId,
            file,
        ) => {
            assert.equal(taskId, "task-1");
            assert.equal(documentId, "document-1");
            assert.equal(baseVersionId, "version-2");
            assert.equal(file.name, "Contract.docx");
            return version("version-3", 3);
        },
        writeWordCustomProperties: async (properties) => {
            writtenProperties.push(...properties);
        },
    });
    assert.equal(result.version.id, "version-3");
    assert.equal(result.successorBinding.versionId, "version-3");
    assert.equal(result.receiptSynchronized, true);
    assert.equal(result.reopenRequired, false);
    assert.ok(
        writtenProperties.some((property) =>
            property.value.includes('"versionId":"version-3"'),
        ),
    );
});

test("a server-saved Task artifact is preserved when the open Word receipt cannot synchronize", async () => {
    const document = matterDocument();
    const result = await saveCurrentWordDocumentAsTaskArtifactVersion({
        taskId: taskArtifactBinding.taskId,
        projectId: taskArtifactBinding.projectId,
        deliverableKey: taskArtifactBinding.deliverableKey,
        document,
        base: currentMatterDocumentVersionBase(document.id, BASE_SNAPSHOT),
        openBinding: taskArtifactBinding,
        loadVersions: async () => BASE_SNAPSHOT,
        readWordFile: async ({ filename }) => new File([], filename),
        saveTaskArtifactVersion: async () => version("version-3", 3),
        writeWordCustomProperties: async () => {
            throw new Error("Office host disconnected");
        },
    });
    assert.equal(result.version.id, "version-3");
    assert.equal(result.receiptSynchronized, false);
    assert.equal(result.reopenRequired, true);
    assert.equal(result.receiptSyncError, "Office host disconnected");
});

test("Task artifact save rejects the wrong open Version before Word export", async () => {
    let reads = 0;
    await assert.rejects(
        saveCurrentWordDocumentAsTaskArtifactVersion({
            taskId: taskArtifactBinding.taskId,
            projectId: taskArtifactBinding.projectId,
            deliverableKey: taskArtifactBinding.deliverableKey,
            document: matterDocument(),
            base: currentMatterDocumentVersionBase(
                "document-1",
                BASE_SNAPSHOT,
            ),
            openBinding: {
                ...taskArtifactBinding,
                versionId: "version-1",
            },
            readWordFile: async ({ filename }) => {
                reads += 1;
                return new File([], filename);
            },
        }),
        /not this Task's current Word artifact/,
    );
    assert.equal(reads, 0);
});
