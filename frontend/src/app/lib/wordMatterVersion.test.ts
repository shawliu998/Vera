import assert from "node:assert/strict";
import test from "node:test";
import type {
    Document as MatterDocument,
    Project,
} from "@/app/components/shared/types";
import type { DocumentVersion } from "./mikeApi";
import {
    AgentTaskWordArtifactSaveError,
    type AgentTaskWordArtifactVersion,
} from "./agentTaskWordArtifactSave";
import {
    WordContractRevisionOpenIdentityError,
    type WordContractRevisionBinding,
} from "./wordContractRevisionBinding";
import type { BoundWordMemoSourceManifest } from "./wordMemoSourceManifest";
import type { WordMemoTaskBinding } from "./wordMemoTaskBinding";
import type { WordTaskArtifactBinding } from "./wordTaskArtifactBinding";
import {
    currentMatterDocumentVersionBase,
    listMatterWordDocuments,
    MatterDocumentVersionDriftError,
    saveCurrentWordDocumentAsBoundMemoVersion,
    saveCurrentWordDocumentAsContractRevisionVersion,
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

function taskVersion(
    id: string,
    versionNumber: number,
): AgentTaskWordArtifactVersion {
    return {
        ...version(id, versionNumber),
        artifact_reverification: {
            outcome: "started",
            task_status: "verifying",
            current_step: "verify-deliverables",
        },
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

const contractRevisionBinding: WordContractRevisionBinding = {
    schemaVersion: 1,
    kind: "contract-playbook-word-handoff-v1",
    taskId: "task-1",
    projectId: "matter-1",
    documentId: "document-1",
    versionId: "version-2",
};

const memoManifest: BoundWordMemoSourceManifest = {
    schemaVersion: 1,
    generatorVersion: "tabular-review-word-memo-v1",
    projectId: "matter-1",
    reviewId: "review-1",
    taskId: "task-1",
    memoDocumentId: "memo-1",
    memoVersionId: "memo-version-1",
    inputDigest: "digest-1",
    citations: [],
};

const memoBinding: WordMemoTaskBinding = {
    taskId: "task-1",
    taskStatus: "completed",
    projectId: "matter-1",
    reviewId: "review-1",
    memoDocumentId: "memo-1",
    memoVersionId: "memo-version-1",
    memoVersionNumber: 1,
    memoFilename: "Review Memo.docx",
    executionChatId: "chat-1",
    inputDigest: "digest-1",
    reviewTitle: "Review",
    matterName: "Matter",
    verifierStatus: "passed",
    citations: [],
    sources: [
        {
            documentId: "source-1",
            versionId: "source-version-1",
            filename: "Source.docx",
            fileType: "docx",
            role: "source",
        },
    ],
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
            return taskVersion("version-3", 3);
        },
        writeWordCustomProperties: async (properties) => {
            writtenProperties.push(...properties);
        },
    });
    assert.equal(result.version.id, "version-3");
    assert.equal(result.successorBinding.versionId, "version-3");
    assert.equal(result.receiptSynchronized, true);
    assert.equal(result.reopenRequired, false);
    assert.equal(result.reverificationStarted, true);
    assert.equal(result.reverificationIssueCode, null);
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
        saveTaskArtifactVersion: async () => taskVersion("version-3", 3),
        writeWordCustomProperties: async () => {
            throw new Error("Office host disconnected");
        },
    });
    assert.equal(result.version.id, "version-3");
    assert.equal(result.receiptSynchronized, false);
    assert.equal(result.reopenRequired, true);
    assert.equal(result.receiptSyncError, "Office host disconnected");
    assert.equal(result.reverificationStarted, true);
});

test("a preserved Version remains explicit when re-verification cannot start", async () => {
    let receiptWrites = 0;
    const preservedVersion = version("version-3", 3);
    const result = await saveCurrentWordDocumentAsTaskArtifactVersion({
        taskId: taskArtifactBinding.taskId,
        projectId: taskArtifactBinding.projectId,
        deliverableKey: taskArtifactBinding.deliverableKey,
        document: matterDocument(),
        base: currentMatterDocumentVersionBase(
            "document-1",
            BASE_SNAPSHOT,
        ),
        openBinding: taskArtifactBinding,
        loadVersions: async () => BASE_SNAPSHOT,
        readWordFile: async ({ filename }) => new File([], filename),
        saveTaskArtifactVersion: async () => {
            throw new AgentTaskWordArtifactSaveError(
                "The edited Version was preserved, but re-verification cannot start.",
                409,
                "reverification_conflict",
                preservedVersion,
            );
        },
        writeWordCustomProperties: async () => {
            receiptWrites += 1;
        },
    });
    assert.equal(result.version.id, "version-3");
    assert.equal(result.successorBinding.versionId, "version-3");
    assert.equal(result.reverificationStarted, false);
    assert.equal(result.reverificationIssueCode, "reverification_conflict");
    assert.equal(result.receiptSynchronized, false);
    assert.equal(result.reopenRequired, true);
    assert.equal(receiptWrites, 0);
});

test("a transient re-verification failure retries the same preserved Version once", async () => {
    let saveCalls = 0;
    let receiptWrites = 0;
    const preservedVersion = version("version-3", 3);
    const result = await saveCurrentWordDocumentAsTaskArtifactVersion({
        taskId: taskArtifactBinding.taskId,
        projectId: taskArtifactBinding.projectId,
        deliverableKey: taskArtifactBinding.deliverableKey,
        document: matterDocument(),
        base: currentMatterDocumentVersionBase(
            "document-1",
            BASE_SNAPSHOT,
        ),
        openBinding: taskArtifactBinding,
        loadVersions: async () => BASE_SNAPSHOT,
        readWordFile: async ({ filename }) => new File([], filename),
        saveTaskArtifactVersion: async () => {
            saveCalls += 1;
            if (saveCalls === 1) {
                throw new AgentTaskWordArtifactSaveError(
                    "Re-verification is temporarily unavailable.",
                    503,
                    "reverification_unavailable",
                    preservedVersion,
                );
            }
            return taskVersion("version-3", 3);
        },
        writeWordCustomProperties: async () => {
            receiptWrites += 1;
        },
    });
    assert.equal(saveCalls, 2);
    assert.equal(result.version.id, "version-3");
    assert.equal(result.reverificationStarted, true);
    assert.equal(result.reverificationIssueCode, null);
    assert.equal(result.receiptSynchronized, true);
    assert.equal(receiptWrites, 1);
});

test("a re-verification retry cannot switch to another Version", async () => {
    let saveCalls = 0;
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
            openBinding: taskArtifactBinding,
            loadVersions: async () => BASE_SNAPSHOT,
            readWordFile: async ({ filename }) => new File([], filename),
            saveTaskArtifactVersion: async () => {
                saveCalls += 1;
                if (saveCalls === 1) {
                    throw new AgentTaskWordArtifactSaveError(
                        "Re-verification is temporarily unavailable.",
                        503,
                        "reverification_unavailable",
                        version("version-3", 3),
                    );
                }
                return taskVersion("version-4", 4);
            },
        }),
        /returned a different Word Version/,
    );
    assert.equal(saveCalls, 2);
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

test("prepared contract revision save uses its Task route and advances the open receipt", async () => {
    const writtenProperties: Array<{ name: string; value: string }> = [];
    const result = await saveCurrentWordDocumentAsContractRevisionVersion({
        document: matterDocument(),
        base: currentMatterDocumentVersionBase("document-1", BASE_SNAPSHOT),
        openBinding: contractRevisionBinding,
        loadVersions: async () => BASE_SNAPSHOT,
        readWordFile: async ({ filename }) => new File(["edited"], filename),
        saveContractRevisionVersion: async (
            taskId,
            documentId,
            baseVersionId,
        ) => {
            assert.equal(taskId, "task-1");
            assert.equal(documentId, "document-1");
            assert.equal(baseVersionId, "version-2");
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

test("prepared contract revision rejects stale Word identity before reading bytes", async () => {
    let reads = 0;
    let saves = 0;
    await assert.rejects(
        saveCurrentWordDocumentAsContractRevisionVersion({
            document: matterDocument(),
            base: currentMatterDocumentVersionBase(
                "document-1",
                BASE_SNAPSHOT,
            ),
            openBinding: {
                ...contractRevisionBinding,
                versionId: "version-1",
            },
            loadVersions: async () => BASE_SNAPSHOT,
            readWordFile: async ({ filename }) => {
                reads += 1;
                return new File([], filename);
            },
            saveContractRevisionVersion: async () => {
                saves += 1;
                return version("version-3", 3);
            },
        }),
        WordContractRevisionOpenIdentityError,
    );
    assert.equal(reads, 0);
    assert.equal(saves, 0);
});

test("prepared contract revision preserves a server save when the local receipt cannot synchronize", async () => {
    const result = await saveCurrentWordDocumentAsContractRevisionVersion({
        document: matterDocument(),
        base: currentMatterDocumentVersionBase("document-1", BASE_SNAPSHOT),
        openBinding: contractRevisionBinding,
        loadVersions: async () => BASE_SNAPSHOT,
        readWordFile: async ({ filename }) => new File(["edited"], filename),
        saveContractRevisionVersion: async () => version("version-3", 3),
        writeWordCustomProperties: async () => {
            throw new Error("Office host disconnected");
        },
    });

    assert.equal(result.version.id, "version-3");
    assert.equal(result.successorBinding.versionId, "version-3");
    assert.equal(result.receiptSynchronized, false);
    assert.equal(result.reopenRequired, true);
    assert.equal(result.receiptSyncError, "Office host disconnected");
});

test("Task-bound Memo save uses its authoritative base and advances only the Memo receipt", async () => {
    const writtenProperties: Array<{ name: string; value: string }> = [];
    const result = await saveCurrentWordDocumentAsBoundMemoVersion({
        manifest: memoManifest,
        binding: memoBinding,
        readWordFile: async ({ filename }) => new File(["edited"], filename),
        saveBoundMemo: async (input) => {
            assert.equal(input.baseVersionId, "memo-version-1");
            assert.equal(input.filename, "Review Memo.docx");
            return {
                ...memoBinding,
                taskStatus: "verifying",
                memoVersionId: "memo-version-2",
                memoVersionNumber: 2,
                verifierStatus: "running",
            };
        },
        writeWordCustomProperties: async (properties) => {
            writtenProperties.push(...properties);
        },
    });

    assert.equal(result.binding.memoVersionId, "memo-version-2");
    assert.equal(result.manifest.memoVersionId, "memo-version-2");
    assert.equal(result.receiptSynchronized, true);
    assert.ok(
        writtenProperties.some((property) =>
            property.value.includes('"memoVersionId":"memo-version-2"'),
        ),
    );
});

test("Task-bound Memo rejects a drifted server binding before exporting Word", async () => {
    let reads = 0;
    await assert.rejects(
        saveCurrentWordDocumentAsBoundMemoVersion({
            manifest: memoManifest,
            binding: {
                ...memoBinding,
                memoVersionId: "memo-version-2",
            },
            readWordFile: async ({ filename }) => {
                reads += 1;
                return new File([], filename);
            },
        }),
        /binding no longer matches its manifest/,
    );
    assert.equal(reads, 0);
});

test("Task-bound Memo preserves the server successor when Word receipt sync fails", async () => {
    const result = await saveCurrentWordDocumentAsBoundMemoVersion({
        manifest: memoManifest,
        binding: memoBinding,
        readWordFile: async ({ filename }) => new File(["edited"], filename),
        saveBoundMemo: async () => ({
            ...memoBinding,
            taskStatus: "verifying",
            memoVersionId: "memo-version-2",
            memoVersionNumber: 2,
            verifierStatus: "running",
        }),
        writeWordCustomProperties: async () => {
            throw new Error("Office host disconnected");
        },
    });

    assert.equal(result.binding.memoVersionId, "memo-version-2");
    assert.equal(result.manifest.memoVersionId, "memo-version-2");
    assert.equal(result.receiptSynchronized, false);
    assert.equal(result.receiptSyncError, "Office host disconnected");
});
